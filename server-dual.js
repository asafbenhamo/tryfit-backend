const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();
const creditsSystem = require("./credits");
const adminRouter = require("./admin");
const db = require("./database");
const featureFlags = require("./feature-flags");
const shopify = require("./shopify-client");
const aiTools = require("./ai-tools");
const aiBrain = require("./ai-brain");
const dailySummary = require("./daily-summary");
const insightsEngine = require("./insights-engine");
const creditsEngine = require("./credits-engine");
const waTemplates = require("./wa-templates");
const whatsappSender = require("./whatsapp-sender");
const mailer = require("./mailer");
const compliance = require("./compliance");
const agentEngine = require("./agent-engine");
const morningBrief = require("./morning-brief");
const smsSender = require("./sms-sender");
const attributionEngine = require("./attribution-engine");
const pushEngine = require("./push-engine");
const flashySync = require("./flashy-sync");

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning", "x-advisor-password"]
}));
app.use((req, res, next) => {
  if (req.path === "/webhooks/checkouts/create" || req.path === "/webhooks/checkouts/update" || req.path === "/webhooks/orders/create") {
    return next();
  }
  return express.json({ limit: '20mb' })(req, res, next);
});

const BACKEND_MODE = process.env.BACKEND_MODE || "fashn";

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "rpa_94NQI07B7J69J3A25963D9RH0R0FSILF9DFEPEAEwc2qnz";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "4nxbizcdhfxobd";
const RUNPOD_BASE_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

const userLimits = new Map();
const DEFAULT_DAILY_LIMIT = 3;

function getRealIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

function parseDailyLimit(val) {
  if (val === "0" || val === 0) return -1;
  var n = parseInt(val);
  return (isNaN(n) || n < 1) ? DEFAULT_DAILY_LIMIT : n;
}

function checkRateLimit(ip, limit) {
  if (limit === -1) return true;
  const today = new Date().toDateString();
  const user = userLimits.get(ip);
  if (!user || user.date !== today) {
    userLimits.set(ip, { count: 1, date: today });
    return true;
  }
  if (user.count >= limit) return false;
  user.count++;
  return true;
}

async function saveTryOnEvent(shop, eventData) {
  if (!shop) return;
  if (!featureFlags.isDataCollectionEnabled(shop)) {
    return;
  }

  try {
    let tryfitCustomerId = null;
    if (eventData.identifier) {
      const linkResult = await db.query(
        `SELECT id FROM tryfit_consenting_customers 
         WHERE shop_domain = $1 AND identifier = $2 AND consent_active = TRUE
         LIMIT 1`,
        [shop, eventData.identifier]
      );
      if (linkResult.rows.length > 0) {
        tryfitCustomerId = linkResult.rows[0].id;
      }
    }

    await db.query(`
      INSERT INTO tryon_events (
        shop_domain, tryfit_customer_id, session_id, product_id, product_title, 
        product_category, product_price, garment_url, result_url,
        backend_mode, category_detected, success, error_message,
        ip_address, user_agent, identifier, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
    `, [
      shop,
      tryfitCustomerId,
      eventData.session_id || null,
      eventData.product_id || null,
      eventData.product_title || null,
      eventData.product_category || null,
      eventData.product_price || null,
      eventData.garment_url || null,
      eventData.result_url || null,
      eventData.backend_mode || BACKEND_MODE,
      eventData.category_detected || null,
      eventData.success !== false,
      eventData.error_message || null,
      eventData.ip_address || null,
      eventData.user_agent || null,
      eventData.identifier || null
    ]);

    if (tryfitCustomerId) {
      await db.query(
        `UPDATE tryfit_consenting_customers 
         SET total_tryons = total_tryons + 1 
         WHERE id = $1`,
        [tryfitCustomerId]
      );
    }

    console.log("📊 [DataPlatform] Try-on event saved for", shop, tryfitCustomerId ? `(linked to TryFit customer ${tryfitCustomerId})` : '(anonymous)');
  } catch (err) {
    console.error("⚠️  [DataPlatform] Failed to save try-on event:", err.message);
  }
}

function handleConsentAndBackfill(shop, params) {
  if (!shop) return;
  if (!featureFlags.isDataCollectionEnabled(shop)) return;
  if (!shopify.hasTokenForShop(shop)) {
    console.log("📊 [DataPlatform] No Shopify token for", shop, "- skipping backfill");
    return;
  }

  setImmediate(async () => {
    try {
      const result = await shopify.backfillCustomerData(shop, params);
      if (result.success) {
        console.log(`✅ [DataPlatform] Backfill complete for ${params.email || params.identifier}: ${result.ordersSaved} orders`);
      } else {
        console.log(`⚠️  [DataPlatform] Backfill skipped: ${result.reason}`);
      }
    } catch (err) {
      console.error("⚠️  [DataPlatform] Backfill error:", err.message);
    }
  });
}

function getShopFromRequest(req) {
  if (req.body.shop) return req.body.shop;
  if (req.headers["x-shop-domain"]) return req.headers["x-shop-domain"];
  try {
    if (req.headers.referer) return new URL(req.headers.referer).hostname;
  } catch (e) {}
  return "";
}

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) {
    return res.status(401).json({ error: "Unauthorized - No HMAC" });
  }
  const secret = process.env.SHOPIFY_API_SECRET || "";
  const rawBody = JSON.stringify(req.body);
  const hash = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  if (hash !== hmacHeader) {
    return res.status(401).json({ error: "Unauthorized - Invalid HMAC" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: BACKEND_MODE });
});

// ===== Flashy opt-out sync =====
// Incoming webhook from Flashy: when a contact unsubscribes there, mirror it into
// our local opt-out list so the advisor never contacts them. Fail-safe by design.
app.post("/webhook/flashy", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-flashy-secret"] || null;
    const result = await flashySync.handleWebhook(req.body, secret);
    // Always 200 so Flashy doesn't retry-storm us; the result carries details.
    res.status(200).json(result);
  } catch (err) {
    console.error("flashy webhook error:", err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

app.get("/webhook/flashy/status", (req, res) => {
  res.json({ ok: true, ...flashySync.status() });
});

app.get("/privacy", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TryFit - Privacy Policy</title>
<style>
body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.6}
h1{color:#E94560}h2{color:#2D3436;margin-top:30px}
</style>
</head>
<body>
<h1>TryFit Privacy Policy</h1>
<p>Last updated: March 2026</p>
<h2>What We Collect</h2>
<p>TryFit processes photos that customers voluntarily upload to use the virtual try-on feature. These photos are sent to our processing servers solely to generate the try-on result.</p>
<h2>How We Use Your Data</h2>
<p>Uploaded photos are used only to generate virtual try-on images. Photos are not stored permanently and are automatically deleted after processing is complete.</p>
<h2>Data Sharing</h2>
<p>We do not sell, rent, or share customer photos or personal data with third parties. Photos are processed by our AI servers and deleted immediately after the result is generated.</p>
<h2>Data Retention</h2>
<p>Customer photos are temporarily processed and not retained after the try-on result is delivered. No personal data is stored on our servers.</p>
<h2>Cookies</h2>
<p>TryFit does not use cookies or tracking technologies.</p>
<h2>Merchant Data</h2>
<p>We access product images and product information from your Shopify store solely to provide the virtual try-on feature. We do not access customer personal information, order data, or payment information.</p>
<h2>Contact</h2>
<p>For privacy questions, contact us at support@tryfit.app</p>
</body>
</html>`);
});

app.use("/admin", adminRouter);

app.get("/api/credits/:shop", (req, res) => {
  res.json(creditsSystem.getStoreCredits(req.params.shop));
});

app.post("/api/consent", express.json(), async (req, res) => {
  try {
    const shop = getShopFromRequest(req);
    const { email, phone, identifier, consent_text_version } = req.body;

    if (!shop) {
      return res.status(400).json({ error: "Shop not identified" });
    }

    if (!featureFlags.isDataCollectionEnabled(shop)) {
      return res.json({ success: true, data_platform: "disabled" });
    }

    const finalIdentifier = identifier || email || phone || getRealIP(req);

    console.log(`📊 [DataPlatform] Consent received for ${shop} | ${email || phone || 'no contact'}`);

    handleConsentAndBackfill(shop, {
      email: email || null,
      phone: phone || null,
      identifier: finalIdentifier,
      ipAddress: getRealIP(req),
      userAgent: req.headers["user-agent"],
      consentTextVersion: consent_text_version || 'v1.0'
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Consent endpoint error:", err);
    res.status(500).json({ error: err.message });
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tryfit2026";
// Master password lets Asaf (super-admin) act on ANY store. With the master
// password, the target store is taken from the request's `shop` field.
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || null;
const DEFAULT_SHOP = "seven770.myshopify.com";

// Display name of a shop for emails/branding (falls back to the domain prefix).
function storeBrand(shop) {
  if (shop === DEFAULT_SHOP) return "770";
  const s = shopify.getStore(shop);
  return (s && s.name) || (shop || "").replace(".myshopify.com", "");
}

// The store owner's email (gets a sample copy of campaign emails). For 770 we use
// MAIL_REPLY_TO env; for other stores, the owner_email set from the master panel.
function ownerEmailFor(shop) {
  if (shop === DEFAULT_SHOP) return process.env.MAIL_REPLY_TO || process.env.MAIL_FROM || null;
  const s = shopify.getStore(shop);
  return (s && s.owner_email) || null;
}

// Send ONE sample copy of a campaign email to the store owner, so they see exactly
// what their customers receive. Best-effort; never blocks the campaign.
async function sendOwnerSample(shop, { subject, html, text }) {
  try {
    const owner = ownerEmailFor(shop);
    if (!owner) return;
    await mailer.sendEmail({
      to: owner,
      subject: "[דוגמה ללקוח] " + (subject || "קמפיין"),
      html: '<div style="background:#fff8e1;padding:10px;text-align:center;font-family:Arial;color:#8a6d00;border-radius:8px;margin-bottom:10px">📋 זו דוגמה למייל שהלקוחות שלך מקבלים בקמפיין הזה</div>' + (html || ""),
      text: "[דוגמה ללקוח]\n\n" + (text || "")
    });
  } catch (e) { console.error("[owner-sample]", e.message); }
}

// Pull the password from wherever it arrived (query, body, or header).
function extractPassword(req) {
  return (req.query && req.query.password)
      || (req.body && req.body.password)
      || (req.headers && req.headers['x-advisor-password'])
      || null;
}

// Resolve which shop a request is authorized for, based on its password.
//  - 770's existing ADMIN_PASSWORD  -> seven770 (unchanged, full backward compat)
//  - a store's own advisor_password -> that store
//  - MASTER_PASSWORD                -> the store named in req.query/body.shop
// Returns the shop_domain string, or null if the password is not recognized.
function resolveShop(req) {
  const pw = extractPassword(req);
  if (!pw) return null;
  // 770 keeps its existing password.
  if (pw === ADMIN_PASSWORD) return DEFAULT_SHOP;
  // Master: act on the requested shop.
  if (MASTER_PASSWORD && pw === MASTER_PASSWORD) {
    const target = (req.query && req.query.shop) || (req.body && req.body.shop) || null;
    return target ? target.toLowerCase().trim() : null;
  }
  // Per-store password: find the store whose advisor_password matches.
  try {
    for (const s of shopify.listStores()) {
      const cfg = shopify.getStore(s.shop_domain);
      if (cfg && cfg.password && cfg.password === pw) return s.shop_domain;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Auth gate: resolves the shop and writes it to res.locals.shop. Returns the
// shop string if authorized, or null after sending a 401 (caller should return).
function checkAuth(req, res) {
  const shop = resolveShop(req);
  if (!shop) {
    res.status(401).json({ error: "גישה נדחתה" });
    return null;
  }
  if (!shopify.hasTokenForShop(shop)) {
    res.status(400).json({ error: "החנות לא מחוברת (אין token)" });
    return null;
  }
  res.locals.shop = shop;
  return shop;
}

// Admin gate: only 770's password or the master password (super-admin actions
// like onboarding stores, backfills, syncs). Regular store passwords are rejected.
function isAdmin(req) {
  const pw = extractPassword(req);
  if (!pw) return false;
  if (pw === ADMIN_PASSWORD) return true;
  if (MASTER_PASSWORD && pw === MASTER_PASSWORD) return true;
  return false;
}

const backfillStatus = {};

// All shop domains the background jobs should process: 770 (env) + DB-backed stores.
function allActiveShops() {
  try {
    return shopify.listStores().map(s => s.shop_domain);
  } catch (e) {
    return [DEFAULT_SHOP];
  }
}

app.get("/admin/backfill", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<title>TryFit Data Platform - Backfill</title>
<style>
body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:20px;background:#f5f5f5;direction:rtl}
.card{background:white;padding:30px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-bottom:20px}
h1{color:#E94560;margin:0 0 10px}
.warn{background:#fff3cd;border:1px solid #ffc107;padding:15px;border-radius:8px;margin:15px 0}
input{padding:10px;font-size:16px;border:1px solid #ddd;border-radius:6px;width:100%;box-sizing:border-box;margin-bottom:10px}
button{background:#E94560;color:white;padding:12px 24px;border:none;border-radius:6px;font-size:16px;cursor:pointer;width:100%}
button:hover{background:#c9354c}
button:disabled{background:#999;cursor:not-allowed}
.status{background:#f0f8ff;padding:15px;border-radius:8px;margin-top:15px;font-family:monospace;font-size:13px;white-space:pre-wrap;max-height:400px;overflow-y:auto}
.shop-tag{display:inline-block;background:#E94560;color:white;padding:4px 10px;border-radius:4px;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h1>🚀 TryFit Data Backfill</h1>
  <p>טוען את כל הלקוחות וההזמנות של החנות לתוך מאגר Tier 1.</p>
  <div class="warn">
    <strong>⚠️ שים לב:</strong><br>
    • זה ימשוך את כל הלקוחות וההזמנות של 60 הימים האחרונים מ-Shopify<br>
    • הנתונים נשמרים ל-<code>store_customers</code> ו-<code>store_orders</code> בלבד (Tier 1)<br>
    • לא לתחילת Tier 2 — זה למאגר פנימי של 770 בלבד<br>
    • התהליך עשוי לקחת מספר דקות
  </div>
  <h3>חנות לעיבוד:</h3>
  <p><span class="shop-tag">seven770.myshopify.com</span></p>
  <h3>סיסמת אדמין:</h3>
  <input type="password" id="password" placeholder="הזן סיסמה" />
  <button onclick="startBackfill()" id="startBtn">🚀 הפעל Backfill</button>
  <div id="status" class="status" style="display:none">ממתין להפעלה...</div>
</div>
<script>
async function startBackfill() {
  const password = document.getElementById('password').value;
  const statusEl = document.getElementById('status');
  const btnEl = document.getElementById('startBtn');
  if (!password) { alert('הזן סיסמה'); return; }
  btnEl.disabled = true;
  btnEl.textContent = '⏳ מבצע backfill...';
  statusEl.style.display = 'block';
  statusEl.textContent = '🚀 שולח בקשה...';
  try {
    const response = await fetch('/admin/backfill/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password, shop: 'seven770.myshopify.com'})
    });
    const data = await response.json();
    if (data.error) {
      statusEl.textContent = '❌ שגיאה: ' + data.error;
      btnEl.disabled = false;
      btnEl.textContent = '🚀 הפעל Backfill';
      return;
    }
    statusEl.textContent = '✅ הופעל! בודק סטטוס...\\n';
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch('/admin/backfill/status?password=' + encodeURIComponent(password));
        const statusData = await statusRes.json();
        if (statusData.status) {
          let text = '📊 סטטוס Backfill:\\n\\n';
          text += '   Phase: ' + (statusData.status.current_phase || 'מתחיל') + '\\n';
          text += '   לקוחות נמשכו: ' + (statusData.status.customers_fetched || 0) + '\\n';
          text += '   לקוחות נשמרו: ' + (statusData.status.customers_saved || 0) + '\\n';
          text += '   הזמנות נמשכו: ' + (statusData.status.orders_fetched || 0) + '\\n';
          text += '   הזמנות נשמרו: ' + (statusData.status.orders_saved || 0) + '\\n';
          text += '   זמן שעבר: ' + (statusData.status.duration_seconds || 0) + 's\\n';
          if (statusData.status.success === true) {
            text += '\\n🎉 הושלם בהצלחה!\\n';
            clearInterval(pollInterval);
            btnEl.disabled = false;
            btnEl.textContent = '✅ הושלם — הפעל שוב';
          } else if (statusData.status.success === false) {
            text += '\\n❌ נכשל: ' + (statusData.status.fatal_error || 'שגיאה לא ידועה');
            clearInterval(pollInterval);
            btnEl.disabled = false;
            btnEl.textContent = '🚀 נסה שוב';
          }
          statusEl.textContent = text;
        }
      } catch (e) { console.error('Poll error:', e); }
    }, 3000);
  } catch (err) {
    statusEl.textContent = '❌ שגיאה: ' + err.message;
    btnEl.disabled = false;
    btnEl.textContent = '🚀 הפעל Backfill';
  }
}
</script>
</body>
</html>`);
});

app.post("/admin/backfill/run", express.json(), async (req, res) => {
  try {
    const { password, shop } = req.body;
    if (!isAdmin(req)) {
      return res.status(401).json({ error: "סיסמה שגויה" });
    }
    if (!shop) {
      return res.status(400).json({ error: "Shop required" });
    }
    if (!featureFlags.isDataCollectionEnabled(shop)) {
      return res.status(403).json({ error: "Data collection not enabled for this shop" });
    }
    if (!shopify.hasTokenForShop(shop)) {
      return res.status(400).json({ error: "No Shopify token configured for this shop" });
    }
    if (backfillStatus[shop] && !backfillStatus[shop].success && !backfillStatus[shop].fatal_error) {
      return res.json({ success: false, error: "Backfill already running for this shop", status: backfillStatus[shop] });
    }
    backfillStatus[shop] = {
      current_phase: 'starting',
      customers_fetched: 0,
      customers_saved: 0,
      orders_fetched: 0,
      orders_saved: 0,
      started_at: new Date().toISOString()
    };
    setImmediate(async () => {
      try {
        const result = await shopify.backfillEntireShop(shop, (progress) => {
          backfillStatus[shop] = { ...backfillStatus[shop], current_phase: progress.phase, ...(progress.stats || {}) };
        });
        backfillStatus[shop] = { ...backfillStatus[shop], ...result };
      } catch (err) {
        backfillStatus[shop] = { ...backfillStatus[shop], success: false, fatal_error: err.message };
      }
    });
    res.json({ success: true, message: "Backfill started" });
  } catch (err) {
    console.error("Backfill run error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/backfill/status", (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = req.query.shop || 'seven770.myshopify.com';
  res.json({ shop, status: backfillStatus[shop] || null });
});

// ======================
// LOGIN: classify a password. Returns:
//  - { ok:true, mode:'master', stores:[...] }  if it's the master password
//  - { ok:true, mode:'store', shop, name }      if it's a known store password
//  - 401                                        if unrecognized
// The frontend uses this to either show the store picker (master) or go straight in.
// ======================
// Simple in-memory rate limiter for login attempts (anti brute-force).
// Per IP: max 10 failed attempts per 15 minutes, then a temporary block.
const loginAttempts = new Map(); // ip -> { count, firstAt, blockedUntil }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
function loginRateCheck(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return { allowed: true };
  if (rec.blockedUntil && now < rec.blockedUntil) {
    return { allowed: false, retryMin: Math.ceil((rec.blockedUntil - now) / 60000) };
  }
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { loginAttempts.delete(ip); return { allowed: true }; }
  return { allowed: true };
}
function loginRecordFail(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(ip, rec);
}
function loginRecordSuccess(ip) { loginAttempts.delete(ip); }
// Periodic cleanup of old entries.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if ((!rec.blockedUntil || now > rec.blockedUntil) && now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

app.post("/api/auth/login", express.json(), (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const gate = loginRateCheck(ip);
  if (!gate.allowed) {
    return res.status(429).json({ ok: false, error: `יותר מדי ניסיונות. נסה שוב בעוד ${gate.retryMin} דקות.` });
  }
  try {
    const pw = (req.body && req.body.password) || "";
    if (!pw) return res.status(401).json({ ok: false, error: "גישה נדחתה" });

    if (MASTER_PASSWORD && pw === MASTER_PASSWORD) {
      loginRecordSuccess(ip);
      let stores = [];
      try {
        stores = shopify.listStores().map(s => {
          const cfg = shopify.getStore(s.shop_domain);
          return {
            shop_domain: s.shop_domain,
            name: (cfg && cfg.name) || (s.shop_domain === DEFAULT_SHOP ? "770" : s.shop_domain.replace(".myshopify.com", ""))
          };
        });
      } catch (e) {
        stores = [{ shop_domain: DEFAULT_SHOP, name: "770" }];
      }
      return res.json({ ok: true, mode: "master", stores });
    }

    // 770's existing password
    if (pw === ADMIN_PASSWORD) {
      loginRecordSuccess(ip);
      return res.json({ ok: true, mode: "store", shop: DEFAULT_SHOP, name: "770", terms_accepted: true });
    }

    // Per-store password
    const shop = resolveShop(req);
    if (shop) {
      loginRecordSuccess(ip);
      const cfg = shopify.getStore(shop);
      return res.json({
        ok: true, mode: "store", shop,
        name: (cfg && cfg.name) || shop.replace(".myshopify.com", ""),
        terms_accepted: shopify.hasAcceptedTerms(shop)
      });
    }

    loginRecordFail(ip);
    return res.status(401).json({ ok: false, error: "סיסמה שגויה" });
  } catch (err) {
    console.error("auth/login error:", err);
    return res.status(500).json({ ok: false, error: "שגיאת שרת בהתחברות" });
  }
});

// Record that the current store accepted the terms of service.
// Current credit balance for the resolved store (any logged-in store).
app.get("/api/wa-credits/balance", async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const balance = await creditsEngine.getBalance(shop);
    res.json({ ok: true, balance, price_per_credit: creditsEngine.PRICE_PER_CREDIT_ILS });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin/master: add credits to a store (manual top-up for now).
//   POST { password, shop, amount }
app.post("/api/wa-credits/add", express.json(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const shop = (req.body.shop || "").toLowerCase().trim();
    const amount = parseInt(req.body.amount);
    if (!shop) return res.status(400).json({ ok: false, error: "חסר shop" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "amount לא תקין" });
    const r = await creditsEngine.addCredits(shop, amount, "topup_manual", { by: "admin" });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin/master: balances for ALL stores (for the master credit-management view).
app.get("/api/wa-credits/all", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const stores = shopify.listStores();
    const out = [];
    for (const s of stores) {
      const cfg = shopify.getStore(s.shop_domain);
      out.push({
        shop_domain: s.shop_domain,
        name: (cfg && cfg.name) || (s.shop_domain === DEFAULT_SHOP ? "770" : s.shop_domain.replace(".myshopify.com", "")),
        balance: await creditsEngine.getBalance(s.shop_domain),
        logo_url: (cfg && cfg.logo_url) || "",
        owner_email: (cfg && cfg.owner_email) || ""
      });
    }
    res.json({ ok: true, stores: out, price_per_credit: creditsEngine.PRICE_PER_CREDIT_ILS });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Automatic WhatsApp campaign: create a personal coupon per customer and send an
// APPROVED template to each via 360dialog. Deducts 1 credit per send; stops if
// credits run out. Only works when the store is WhatsApp-configured.
app.post("/api/campaign/send-auto", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    if (!whatsappSender.isConfigured(shop)) return res.status(400).json({ ok: false, error: "החנות לא מוגדרת לשליחה אוטומטית" });

    const b = req.body || {};
    const templateName = b.template_name;
    const segment = Array.isArray(b.segment) ? b.segment : [];
    if (!templateName) return res.status(400).json({ ok: false, error: "חסרה תבנית" });
    if (segment.length === 0) return res.status(400).json({ ok: false, error: "אין לקוחות" });

    const tpl = await waTemplates.getTemplate(shop, templateName);
    if (!tpl) return res.status(400).json({ ok: false, error: "תבנית לא נמצאה" });

    // Working hours: automatic sends only inside the allowed window.
    if (!compliance.isWithinWorkingHours()) {
      const st = compliance.workingHoursStatus();
      return res.json({ ok: false, error: `מחוץ לשעות השליחה (${st.window}, עכשיו ${st.israel_hour}:00). נסה שוב בתוך החלון.` });
    }

    const percentage = b.percentage ? parseInt(b.percentage) : null;
    const amount_ils = b.amount_ils ? parseFloat(b.amount_ils) : null;
    const combine = (b.combine === 'no' || b.combine === 'false') ? false : true;
    const days_valid = b.days_valid ? parseInt(b.days_valid) : 2;

    // Build recipients: each gets a personal coupon, and template body params
    // filled in the order declared by tpl.body_vars (e.g. ['name','coupon','discount']).
    const recipients = [];
    let skippedOptout = 0;
    for (const c of segment) {
      const phone = c.phone || null;
      if (!phone) continue; // auto-send is WhatsApp only
      // Opt-out: never include a customer who asked to stop.
      if (await compliance.isOptedOut(shop, { email: c.email, phone })) { skippedOptout++; continue; }
      const name = c.name || (c.first_name || '');
      // Personal coupon
      let coupon = null;
      try {
        const namePart = (name || 'VIP').replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8) || "VIP";
        const suffix = Math.floor(Math.random() * 900 + 100);
        const cc = await shopify.createDiscountCode(shop, {
          percentage: percentage || (amount_ils ? null : 10),
          amount_ils: amount_ils || null,
          code: `${namePart}${percentage || Math.round(amount_ils) || ''}${suffix}`,
          days_valid, combine,
          title: `יועץ אוטומטי: ${name}`
        });
        if (cc.ok) coupon = cc.code;
      } catch (e) {}

      const discountLabel = amount_ils ? (`₪${Math.round(amount_ils)}`) : `${percentage || 10}%`;
      const valueMap = { name: name || 'לקוחה', coupon: coupon || '', discount: discountLabel };
      const params = (tpl.body_vars || []).map(v => valueMap[v] != null ? valueMap[v] : '');

      recipients.push({
        to: phone,
        params,
        urlSuffix: coupon || '',
        meta: { campaign_type: b.campaign_type || 'campaign', customer_name: name, coupon }
      });

      // Log the action for attribution (mirror of manual path).
      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, b.campaign_type || 'campaign', c.email || null, phone,
         JSON.stringify({ customer_name: name, auto: true, template: templateName }), coupon]
      ).catch(e => console.error("auto-campaign log:", e.message));
    }

    if (recipients.length === 0) return res.json({ ok: false, error: "אין לקוחות עם טלפון" });

    const result = await whatsappSender.sendTemplateBatch(shop, templateName, recipients, {});
    if (!result.ok && result.reason === 'not_configured') {
      return res.status(400).json({ ok: false, error: "החנות לא מוגדרת" });
    }
    const balance = await creditsEngine.getBalance(shop);
    res.json({
      ok: true,
      sent: result.sent || 0,
      failed: result.failed || 0,
      skipped_optout: skippedOptout,
      stopped_no_credits: !!result.stopped_no_credits,
      balance
    });
  } catch (err) {
    console.error("send-auto error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Campaign result persistence =====
// The prepared WhatsApp squares used to live only in memory, so a refresh lost
// them ("the advisor forgot what it created"). We persist them per campaign-key
// (a stable hash the client derives from the campaign marker), including each
// square's sent/unsent state, and restore on reload.
async function ensureCampaignResultsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS campaign_results (
      shop_domain TEXT NOT NULL,
      campaign_key TEXT NOT NULL,
      whatsapp JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (shop_domain, campaign_key)
    )`).catch(e => console.error('campaign_results table:', e.message));
  // Opt-out list (customers who asked to stop). Referenced by insights + ai-tools
  // opt-out filters; must exist or those queries throw and return empty.
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_optouts (
      shop_domain TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('message_optouts table:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_optouts_shop ON message_optouts(shop_domain)`).catch(()=>{});
}
ensureCampaignResultsTable();

// Save the prepared squares once a campaign finished preparing.
app.post("/api/campaign/save-result", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const { key, whatsapp } = req.body || {};
    if (!key || !Array.isArray(whatsapp)) return res.status(400).json({ ok: false, error: "חסר key/whatsapp" });
    await db.query(
      `INSERT INTO campaign_results (shop_domain, campaign_key, whatsapp)
       VALUES ($1,$2,$3)
       ON CONFLICT (shop_domain, campaign_key) DO UPDATE SET whatsapp = EXCLUDED.whatsapp`,
      [shop, String(key).slice(0, 120), JSON.stringify(whatsapp)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Fetch a saved result (the card asks on render; if found, it restores the squares).
app.get("/api/campaign/get-result", async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const key = (req.query.key || '').slice(0, 120);
    if (!key) return res.json({ ok: true, found: false });
    const r = await db.query(
      `SELECT whatsapp FROM campaign_results WHERE shop_domain=$1 AND campaign_key=$2`, [shop, key]);
    if (!r.rows[0]) return res.json({ ok: true, found: false });
    res.json({ ok: true, found: true, whatsapp: r.rows[0].whatsapp || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Mark one square as sent (clicked) so the state survives refresh.
app.post("/api/campaign/mark-sent", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const { key, phone } = req.body || {};
    if (!key || !phone) return res.status(400).json({ ok: false, error: "חסר key/phone" });
    await db.query(
      `UPDATE campaign_results
       SET whatsapp = (
         SELECT COALESCE(jsonb_agg(
           CASE WHEN elem->>'phone' = $3 THEN jsonb_set(elem, '{sent}', 'true'::jsonb) ELSE elem END
         ), '[]'::jsonb)
         FROM jsonb_array_elements(whatsapp) elem
       )
       WHERE shop_domain=$1 AND campaign_key=$2`,
      [shop, String(key).slice(0, 120), String(phone)]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/terms/accept", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const r = await shopify.acceptTerms(shop);
    res.json(r);
  } catch (err) {
    console.error("terms/accept error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manually remove a customer from the advisor's outreach (opt-out). The merchant
// uses this when a customer replies "remove me" to their email/WhatsApp. Once
// here, the advisor will never contact this email/phone again.
app.post("/api/optout/remove-customer", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const { email, phone } = req.body;
    if (!email && !phone) return res.status(400).json({ ok: false, error: "צריך מייל או טלפון" });
    const r = await compliance.addOptOut(shop, { email: email || null, phone: phone || null, reason: "merchant_manual" });
    flashySync.pushUnsubscribe({ email: email || null, phone: phone || null }).catch(() => {});
    res.json({ ok: true, removed: { email: email || null, phone: phone || null }, result: r });
  } catch (err) {
    console.error("optout/remove-customer error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== WhatsApp credits ======
// (WhatsApp credit endpoints are defined above as /api/credits/* using creditsEngine.)

// ===== WhatsApp config + templates (multi-store) =====

// Admin/master: set a store's 360dialog API key (+ optional template language).
// /admin/set-wa-key?password=...&shop=xxx.myshopify.com&key=...&language=he
// TEMP DEBUG: diagnose why personal opportunities are empty. Runs each query
// independently and reports row counts or the exact error. Remove after fixing.

// Change a store's advisor login password.
// /admin/set-password?password=ADMIN&shop=xxx.myshopify.com&new_password=XXX
// Set a store's logo URL (used as the PWA home-screen icon).
// /admin/set-logo?password=MASTER&shop=xxx.myshopify.com&logo_url=https://...
// Set the store owner's email (receives sample copies of campaign emails).
// /admin/set-owner-email?password=MASTER&shop=xxx.myshopify.com&email=owner@store.com
app.get("/admin/set-owner-email", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = (req.query.shop || "").toLowerCase().trim();
  const email = (req.query.email || "").trim();
  if (!shop || !email) {
    return res.status(400).json({ ok: false, error: "חובה shop ו-email" });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "כתובת מייל לא תקינה" });
  }
  try {
    const r = await shopify.setOwnerEmail(shop, email);
    if (!r.ok) return res.status(404).json({ ok: false, error: "החנות לא נמצאה ב-DB" });
    res.json({ ok: true, shop, owner_email: email, note: "מייל בעל החנות נשמר. הוא יקבל עותק דוגמה מכל קמפיין מייל." });
  } catch (err) {
    console.error("set-owner-email error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/set-logo", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = (req.query.shop || "").toLowerCase().trim();
  const logoUrl = (req.query.logo_url || "").trim();
  if (!shop || !logoUrl) {
    return res.status(400).json({ ok: false, error: "חובה shop ו-logo_url" });
  }
  if (!/^https:\/\//i.test(logoUrl)) {
    return res.status(400).json({ ok: false, error: "ה-logo_url חייב להתחיל ב-https://" });
  }
  try {
    const r = await shopify.setStoreLogo(shop, logoUrl);
    if (!r.ok) return res.status(404).json({ ok: false, error: "החנות לא נמצאה ב-DB" });
    res.json({ ok: true, shop, logo_url: logoUrl, note: "הלוגו עודכן. ישמש כאייקון האפליקציה במסך הבית." });
  } catch (err) {
    console.error("set-logo error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/set-password", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = (req.query.shop || "").toLowerCase().trim();
  const newPassword = (req.query.new_password || "").trim();
  if (!shop || !newPassword) {
    return res.status(400).json({ ok: false, error: "חובה shop ו-new_password" });
  }
  if (shop === DEFAULT_SHOP) {
    return res.status(400).json({ ok: false, error: "770 משתמש בסיסמת האדמין - אי אפשר לשנות כאן." });
  }
  try {
    const r = await shopify.setAdvisorPassword(shop, newPassword);
    if (!r.ok) return res.status(404).json({ ok: false, error: "החנות לא נמצאה ב-DB" });
    res.json({ ok: true, shop, note: "הסיסמה עודכנה. בעל החנות יכול להתחבר עם הסיסמה החדשה." });
  } catch (err) {
    console.error("set-password error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/set-wa-key", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "סיסמה שגויה" });
    const shop = (req.query.shop || "").toLowerCase().trim();
    const key = req.query.key || null;
    const language = req.query.language || null;
    if (!shop || !key) return res.status(400).json({ ok: false, error: "צריך shop ו-key" });
    await shopify.setWhatsAppConfig(shop, { d360_api_key: key, wa_language: language });
    res.json({ ok: true, shop, configured: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin/master: add/update an approved template (the "mirror" of a 360dialog template).
//   POST { password, shop, action_type, template_name, language, sample_text,
//          body_vars:[...], url_button_base, url_button_label, site_url }
app.post("/api/wa-templates/upsert", express.json(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const b = req.body || {};
    const shop = (b.shop || "").toLowerCase().trim();
    if (!shop) return res.status(400).json({ ok: false, error: "חסר shop" });
    const r = await waTemplates.upsertTemplate({
      shop_domain: shop,
      action_type: b.action_type,
      template_name: b.template_name,
      language: b.language || 'he',
      sample_text: b.sample_text || '',
      body_vars: Array.isArray(b.body_vars) ? b.body_vars : [],
      url_button_base: b.url_button_base || null,
      url_button_label: b.url_button_label || null,
      site_url: b.site_url || null
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin/master: remove (soft-delete) a template.
app.post("/api/wa-templates/remove", express.json(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const shop = (req.body.shop || "").toLowerCase().trim();
    const name = req.body.template_name;
    if (!shop || !name) return res.status(400).json({ ok: false, error: "צריך shop ו-template_name" });
    const r = await waTemplates.removeTemplate(shop, name);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Any logged-in store: list its approved templates (optionally by action_type).
// The merchant uses this to PREVIEW what an automatic send looks like.
app.get("/api/wa-templates/list", async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const actionType = req.query.action_type || null;
    const list = await waTemplates.listTemplates(shop, actionType);
    const configured = whatsappSender.isConfigured(shop);
    res.json({ ok: true, configured, templates: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/chat", express.json({ limit: '12mb' }), async (req, res) => {
  try {
    const { message, history, images } = req.body;
    const shop = resolveShop(req);
    if (!shop || !shopify.hasTokenForShop(shop)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const hasImages = Array.isArray(images) && images.length > 0;
    if ((!message || !message.trim()) && !hasImages) {
      return res.status(400).json({ error: "הודעה ריקה" });
    }
    const storeCfg = shopify.getStore(shop);
    const shopName = (storeCfg && storeCfg.name) || (shop === DEFAULT_SHOP ? "770" : shop.replace(".myshopify.com", ""));
    const priorMessages = Array.isArray(history) ? history : [];
    const userText = (message && message.trim()) ? message : "צירפתי תמונה מהחנות. תראה אותה ותעזור לי בהתאם.";
    const result = await aiBrain.askBrain(shop, shopName, userText, priorMessages, hasImages ? images : []);
    const cleanHistory = [
      ...priorMessages,
      { role: "user", content: userText + (hasImages ? " [תמונה צורפה]" : "") },
      { role: "assistant", content: result.answer }
    ];
    res.json({
      ok: result.ok,
      answer: result.answer,
      history: cleanHistory,
      tools_used: result.toolsUsed
    });
  } catch (err) {
    console.error("Chat endpoint error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Voice transcription: the app records audio and posts it here; we transcribe it to
// Hebrew text (via OpenAI Whisper). The multipart body is built MANUALLY with a
// Buffer so it works on any Node version (no dependency on global FormData/Blob).
app.post("/api/transcribe", express.json({ limit: '15mb' }), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const { audio, mime } = req.body; // audio = base64 string
    if (!audio) return res.status(400).json({ ok: false, error: "no_audio" });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: "transcription_not_configured",
        message: "תמלול קולי דורש מפתח OPENAI_API_KEY ב-Railway." });
    }
    const audioBuf = Buffer.from(audio, 'base64');
    if (!audioBuf || audioBuf.length < 1000) {
      return res.status(400).json({ ok: false, error: 'audio_too_short', detail: 'ההקלטה קצרה מדי' });
    }
    const contentType = mime || 'audio/webm';
    const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3'
              : contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'webm';
    const CRLF = '\r\n';
    const hePrompt = 'שיחה בעברית עם יועץ מכירות לחנות אונליין. מילים נפוצות: לקוחות, קמפיין, קופון, הנחה, מכירות, עגלה נטושה, דיוור, וואטסאפ, הזמנה, מוצר, מלאי, הזדמנות, לפנות ללקוחות.';

    // Call OpenAI transcription with a given model. Returns { ok, status, text, raw }.
    async function transcribeWith(model) {
      const boundary = '----SmartAdvisor' + crypto.randomBytes(12).toString('hex');
      const pre = Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}` +
        `Content-Type: ${contentType}${CRLF}${CRLF}`, 'utf8');
      const post = Buffer.from(
        `${CRLF}--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="model"${CRLF}${CRLF}${model}${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="language"${CRLF}${CRLF}he${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="prompt"${CRLF}${CRLF}${hePrompt}${CRLF}` +
        `--${boundary}--${CRLF}`, 'utf8');
      const body = Buffer.concat([pre, audioBuf, post]);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length)
        },
        body
      });
      const raw = await r.text();
      let text = '';
      try { text = (JSON.parse(raw).text) || ''; } catch (e) { text = raw; }
      return { ok: r.ok, status: r.status, text, raw };
    }

    // Try the accurate model first; if it errors (e.g. not enabled on the account),
    // fall back to whisper-1 so transcription still works.
    let out = await transcribeWith('gpt-4o-transcribe');
    if (!out.ok) {
      console.error("gpt-4o-transcribe failed:", out.status, out.raw.substring(0, 200));
      out = await transcribeWith('whisper-1');
    }
    if (!out.ok) {
      console.error("Whisper fallback also failed:", out.status, out.raw);
      return res.status(502).json({ ok: false, error: 'whisper_failed', detail: `(${out.status}) ` + out.raw.substring(0, 300) });
    }
    res.json({ ok: true, text: out.text || '' });
  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ ok: false, error: err.message, detail: err.message });
  }
});

app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/chat.html");
});

app.get("/api/daily-plan", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const shopName = "770";
    const planPrompt = `בנה לי תוכנית פעולה עסקית להיום כדי להכניס כמה שיותר כסף. אתה מנהל השיווק של החנות.
חשוב כמו חברת שיווק מובילה: נתח את המצב (עגלות נטושות, VIP שנעלמו, מוצרים חמים, דפוסי קנייה, cross-sell), ובנה תוכנית עם 2-4 מהלכים מתועדפים לפי פוטנציאל הכנסה.
לכל מהלך: כותרת קצרה, כמה לקוחות/מה הוא מכסה, צפי הכנסה בשקלים, והמלצה איך לבצע.
התחל ב"תוכנית להיום" וצפי ההכנסה הכולל. תהיה אסטרטגי ויצירתי - חשוב על כל דרך להרים מכירות, לא רק עגלות נטושות.
אל תכלול בלוקים של ACTION/CART/CAMPAIGN בתשובה הזו - רק את התוכנית עצמה בצורה ברורה וקריאה.`;
    const result = await aiBrain.askBrain(shop, shopName, planPrompt, []);
    res.json({ ok: true, plan: result.answer, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error("Daily plan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/daily-summary", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await dailySummary.getDailySummary(shop);
    res.json(result);
  } catch (err) {
    console.error("Daily summary error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SMS (TextMe) configuration status — tells the UI whether to enable the SMS channel.
app.get("/api/sms/status", (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  res.json({ ok: true, configured: smsSender.isConfigured() });
});

// Morning brief: "while you slept" + today's RFM-based plan. The autonomous
// experience — open the app, see what closed overnight and what's ready today.
app.get("/api/morning-brief", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await morningBrief.getMorningBrief(shop);
    res.json(result);
  } catch (err) {
    console.error("Morning brief error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/insights", async (req, res) => {
  try {
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await insightsEngine.getInsights(shop);
    res.json(result);
  } catch (err) {
    console.error("Insights endpoint error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/coupon/create", express.json(), async (req, res) => {
  try {
    const { password, percentage, code, days_valid, title, usage_limit } = req.body;
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await shopify.createDiscountCode(shop, {
      percentage, code, days_valid, title, usage_limit
    });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error("Coupon create error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/send-email", express.json(), async (req, res) => {
  try {
    const { password, to, phone, subject, body, cta_url, cta_label, ignore_hours } = req.body;
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    if (!mailer.isConfigured()) {
      return res.status(400).json({ ok: false, error: "שירות המייל לא מוגדר עדיין (חסר RESEND_API_KEY)" });
    }
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: "חסר נמען / נושא / תוכן" });
    }

    const shop = resolveShop(req) || DEFAULT_SHOP;
    const gate = await compliance.canContactCustomer(shop, { email: to, phone }, { ignoreHours: !!ignore_hours });
    if (!gate.allowed) {
      return res.status(200).json({ ok: false, blocked: true, reason: gate.reason, detail: gate.detail });
    }

    const html = mailer.buildHtmlEmail(body, { cta_url, cta_label, brand: storeBrand(shop), to, shop });
    const result = await mailer.sendEmail({ to, subject, html, text: body });
    if (!result.ok) {
      return res.status(400).json(result);
    }

    try {
      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details)
         VALUES ($1, 'email_sent', $2, $3, $4)`,
        [shop, to, phone || null, JSON.stringify({ subject })]
      );
    } catch (e) { console.error("action log failed:", e.message); }

    res.json(result);
  } catch (err) {
    console.error("Send email error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/optout/add", express.json(), async (req, res) => {
  try {
    const { email, phone, reason } = req.body;
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
    const result = await compliance.addOptOut(shop, { email, phone, reason });
    flashySync.pushUnsubscribe({ email: email || null, phone: phone || null }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/unsubscribe", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Missing email");
  // Shop can be carried in the unsubscribe link (?shop=...); fall back to 770.
  const shop = (req.query.shop || DEFAULT_SHOP).toLowerCase().trim();
  await compliance.addOptOut(shop, { email, reason: "email_link" });
  flashySync.pushUnsubscribe({ email: email || null }).catch(() => {});
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
    <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#333}</style></head>
    <body><h2>הוסרת מרשימת התפוצה</h2><p>לא תקבל/י יותר הודעות שיווקיות. תודה.</p></body></html>`);
});

// Swipe away an opportunity: hide it for a couple of days and let a fresh one
// take its place on the next load.
app.post("/api/insights/dismiss", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
    const id = (req.body && req.body.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing id" });
    await insightsEngine.dismissOpportunity(shop, id);
    res.json({ ok: true });
  } catch (err) {
    console.error("dismiss error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// View what the advisor remembers (durable preferences) for the logged-in store.
app.get("/api/memory", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const memory = require("./memory-engine");
    const prefs = await memory.getPreferences(shop);
    res.json({ ok: true, preferences: prefs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete a remembered preference by id.
app.post("/api/memory/delete", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const memory = require("./memory-engine");
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ ok: false, error: "missing id" });
    await memory.deletePreference(shop, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Click-tracking redirect: the link inside outreach messages points here. We record
// the click (proof the customer engaged) and forward them to the store. Attribution
// later credits the advisor only if a purchase follows this click within the window.
app.get("/go/:token", async (req, res) => {
  try {
    const clickTracker = require("./click-tracker");
    const row = await clickTracker.recordClick(req.params.token);
    let base = null;
    if (row && row.shop_domain) {
      base = shopify.getPublicDomain(row.shop_domain);
    }
    if (!base) base = "https://" + (process.env.DEFAULT_PUBLIC_DOMAIN || "sevenseventy.co.il");
    if (!/^https?:\/\//.test(base)) base = "https://" + base;
    base = base.replace(/\/+$/, "");

    // If she has a personal coupon, send her through Shopify's discount link so the
    // code is auto-applied to her cart — frictionless for her, and it makes the sale
    // attributable through the coupon (the strongest, dispute-proof signal).
    let dest;
    if (row && row.coupon_code) {
      dest = `${base}/discount/${encodeURIComponent(row.coupon_code)}?redirect=/`;
    } else {
      dest = base;
    }
    res.redirect(302, dest);
  } catch (err) {
    console.error("click redirect error:", err.message);
    res.redirect(302, "https://sevenseventy.co.il");
  }
});

app.get("/api/working-hours", (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  res.json(compliance.workingHoursStatus());
});

const campaignEngine = require("./campaign-engine");

app.post("/api/campaign/start", express.json(), async (req, res) => {
  try {
    const { password, campaign_type, segment, template, channels } = req.body;
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    if (!Array.isArray(segment) || segment.length === 0) {
      return res.status(400).json({ ok: false, error: "אין לקוחות בקמפיין" });
    }
    if (!template || !template.body) {
      return res.status(400).json({ ok: false, error: "חסר תוכן הודעה" });
    }
    const { id } = campaignEngine.startCampaign(shop, { campaign_type, segment, template, channels });
    res.json({ ok: true, campaign_id: id, total: Math.min(segment.length, campaignEngine.MAX_PER_CAMPAIGN) });
  } catch (err) {
    console.error("Campaign start error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/campaign/status", (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const id = req.query.id;
  if (id) {
    const s = campaignEngine.getCampaignStatus(id);
    if (!s) return res.json({ ok: false, error: "not found" });
    return res.json({ ok: true, campaign: { id, ...{
      status: s.status, total: s.total, done: s.done, sent: s.sent,
      skipped: s.skipped, failed: s.failed, prepared: s.prepared,
      whatsapp: s.whatsapp || [],
      revenue_potential: Math.round(s.revenue_potential || 0),
      finished_at: s.finished_at
    } } });
  }
  res.json({ ok: true, active: campaignEngine.listActiveCampaigns(resolveShop(req) || DEFAULT_SHOP) });
});

app.post("/api/campaign/stop", express.json(), (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const result = campaignEngine.stopCampaign(req.body.id);
  res.json(result);
});

app.post("/api/agent/propose-plan", express.json(), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const today = new Date().toISOString().slice(0, 10);

    const moves = [];

    const carts = await aiTools.getAbandonedCheckouts(shop, { limit: 20, days: 30 });
    const cartList = carts.recoverable_carts || carts.carts || [];
    if (cartList.length > 0) {
      const val = cartList.reduce((s, c) => s + parseFloat(c.total_price || 0), 0);
      moves.push({ priority: 1, move_type: 'abandoned_cart', segment: 'abandoned',
        title: `שחזור ${cartList.length} עגלות נטושות`, percentage: 10,
        est_customers: cartList.length, projected_revenue: Math.round(val * 0.25),
        details: {
          what: `אשלח לכל אחת מ-${cartList.length} הלקוחות שנטשו עגלה הודעה אישית עם קוד הנחה של 10% וקישור ישיר להשלמת הרכישה.`,
          goal: 'להחזיר כסף שכבר כמעט נכנס - הלקוחה רצתה לקנות ועצרה ברגע האחרון.',
          why: `עגלות נטושות הן ההזדמנות הכי חמה שיש: הלקוחה כבר בחרה מוצר והראתה כוונת קנייה. תזכורת קטנה + תמריץ של 10% מספיקים בדרך כלל כדי לסגור. בשווי כולל של ₪${Math.round(val).toLocaleString()} בעגלות, גם המרה של רבע מהן = הכנסה משמעותית. זה המהלך עם ה-ROI הכי גבוה, ולכן הוא ראשון.`
        }});
    }

    const vips = await aiTools.getDormantCustomers(shop, { limit: 20, daysInactive: 30, minSpent: 1000 });
    if ((vips.customers || []).length > 0) {
      const val = vips.customers.reduce((s, c) => s + parseFloat(c.total_spent || 0) * 0.15, 0);
      moves.push({ priority: 2, move_type: 'dormant_vip', segment: 'dormant_vip',
        title: `החזרת ${vips.customers.length} לקוחות VIP שנעלמו`, percentage: 15,
        est_customers: vips.customers.length, projected_revenue: Math.round(val),
        details: {
          what: `אפנה ל-${vips.customers.length} לקוחות VIP (שהוציאו מעל ₪1,000) שלא קנו מעל 30 יום, עם הודעה חמה אישית וקוד הנחה נדיב של 15%.`,
          goal: 'להחזיר לקוחות בעלות ערך גבוה לפני שהן עוברות למתחרים.',
          why: 'לקוחה ש-VIP ששווה אלפי שקלים לאורך זמן שווה הרבה יותר מלקוחה חדשה - כבר השקעת בגיוס שלה, היא מכירה ואוהבת את המותג. כשהיא נעלמת, זו נורת אזהרה. הנחה נדיבה יותר (15%) מוצדקת כי שווי הלקוחה גבוה, והסיכון לאבד אותה לחלוטין גדול יותר מעלות ההנחה.'
        }});
    }

    // One-time buyers get their OWN query (not derived from the VIP list, which
    // has a ₪1,000 minimum that wrongly emptied this move most days).
    const oneTimers = await aiTools.getDormantCustomers(shop, { limit: 20, daysInactive: 20, minSpent: 0 });
    const oneTime = (oneTimers.customers || []).filter(c => (c.orders_count || 0) === 1);
    if (oneTime.length > 0) {
      const val = oneTime.reduce((s, c) => s + parseFloat(c.total_spent || 0), 0);
      moves.push({ priority: 3, move_type: 'one_time', segment: 'one_time',
        title: `דחיפת ${oneTime.length} לקוחות לקנייה שנייה`, percentage: 12,
        est_customers: oneTime.length, projected_revenue: Math.round(val * 0.4),
        details: {
          what: `אפנה ל-${oneTime.length} לקוחות שקנו פעם אחת בלבד, עם הזמנה חמה לחזור וקוד הנחה של 12%.`,
          goal: 'להפוך קונה חד-פעמי ללקוח חוזר - הקפיצה הכי חשובה בנאמנות.',
          why: 'המעבר מקנייה ראשונה לשנייה הוא הרגע הקריטי ביותר במחזור החיים של לקוח. לקוח שקונה פעמיים נוטה להישאר לטווח ארוך והערך שלו קופץ. לקוח שנשאר עם קנייה אחת בדרך כלל אבוד. דחיפה עדינה בזמן הנכון מכפילה את אחוז ההמרה לקנייה שנייה.'
        }});
    }

    const hot = await aiTools.getTopProducts(shop, { limit: 3 });
    const repeat = await aiTools.getRepeatCustomers(shop, { limit: 20 });
    if ((repeat.customers || []).length > 0 && (hot.products || hot.top_products || []).length > 0) {
      const val = repeat.customers.reduce((s, c) => s + parseFloat(c.total_spent || 0) * 0.1, 0);
      const hotName = ((hot.products || hot.top_products || [])[0] || {}).title || 'המוצר החם';
      moves.push({ priority: 4, move_type: 'hot_product', segment: 'repeat',
        title: `קידום מוצר חם ל-${repeat.customers.length} לקוחות נאמנים`, percentage: 10,
        est_customers: repeat.customers.length, projected_revenue: Math.round(val),
        details: {
          what: `אקדם את המוצר שהכי נמכר ("${hotName}") ל-${repeat.customers.length} לקוחות חוזרים, עם הודעה וקוד 10%.`,
          goal: 'למנף מוצר שכבר מוכיח את עצמו, ולמכור אותו ליותר אנשים לפני שאוזל.',
          why: 'מוצר שמוכר חזק הוא הוכחה חיה לביקוש - קל יותר למכור עוד ממנו מאשר לדחוף מוצר חדש לא מוכח. לקוחות חוזרים כבר סומכים על הטעם שלך, אז המלצה על להיט תתקבל בחום. זה גם יוצר תחושת דחיפות (FOMO) אם המלאי מוגבל.'
        }});
    }

    // GUARANTEE at least 3 moves when the store has customers: if strict pools
    // came back thin, add a relaxed win-back move (lower spend bar, 21+ days).
    if (moves.length < 3) {
      const relaxed = await aiTools.getDormantCustomers(shop, { limit: 20, daysInactive: 21, minSpent: 300 });
      const pool = (relaxed.customers || []).filter(c =>
        !moves.some(m => m.move_type === 'dormant_vip') || parseFloat(c.total_spent || 0) < 1000);
      if (pool.length > 0) {
        const val = pool.reduce((s, c) => s + parseFloat(c.total_spent || 0) * 0.2, 0);
        moves.push({ priority: moves.length + 1, move_type: 'dormant_vip', segment: 'dormant_relaxed',
          title: `החזרת ${pool.length} לקוחות ששוות לחזר אחריהן`, percentage: 12,
          est_customers: pool.length, projected_revenue: Math.round(val),
          details: {
            what: `אפנה ל-${pool.length} לקוחות (שהוציאו מעל ₪300) שלא קנו מעל 3 שבועות, עם הודעה אישית וקוד 12%.`,
            goal: 'להחזיר לקוחות ששוות כסף לפני שהן נשכחות.',
            why: 'לקוחה שכבר קנתה והוציאה מאות שקלים שווה הרבה יותר מלקוחה חדשה. פנייה אישית בזמן הנכון מחזירה חלק משמעותי מהן בעלות אפסית.'
          }});
      }
    }

    if (moves.length === 0) {
      return res.json({ ok: true, plan: null, message: "אין מספיק נתונים לתוכנית היום" });
    }

    const totalProjected = moves.reduce((s, m) => s + m.projected_revenue, 0);

    const planRes = await db.query(
      `INSERT INTO agent_plans (shop_domain, plan_date, status, projected_revenue)
       VALUES ($1, $2, 'proposed', $3) RETURNING id`,
      [shop, today, totalProjected]
    );
    const planId = planRes.rows[0].id;

    for (const m of moves) {
      await db.query(
        `INSERT INTO agent_tasks (plan_id, shop_domain, priority, move_type, title, segment, percentage, projected_revenue, est_customers, params)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [planId, shop, m.priority, m.move_type, m.title, m.segment, m.percentage, m.projected_revenue, m.est_customers, JSON.stringify({ details: m.details || {} })]
      );
    }

    const status = await agentEngine.getPlanStatus(planId);
    res.json({ ok: true, plan_id: planId, projected_revenue: totalProjected, ...status });
  } catch (err) {
    console.error("Propose plan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Preview what the agent WILL send before it sends: full recipient list across
// the selected moves + one sample message. Used for the "who & what" confirm step.
app.post("/api/agent/preview-plan", express.json(), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const { plan_id, selected_task_ids } = req.body;
    if (!plan_id || !Array.isArray(selected_task_ids) || selected_task_ids.length === 0) {
      return res.status(400).json({ ok: false, error: "חסר plan_id או מהלכים" });
    }
    const tasksR = await db.query(
      `SELECT * FROM agent_tasks WHERE plan_id=$1 AND id = ANY($2) ORDER BY priority ASC`,
      [plan_id, selected_task_ids]
    );
    let recipients = [];
    let sample = null;
    for (const task of tasksR.rows) {
      const seg = await agentEngine.pullSegment(shop, task);
      const tmpl = agentEngine.templateFor(task);
      for (const c of seg) {
        recipients.push({
          name: c.name || '—',
          phone: c.phone || null,
          email: c.email || null,
          channel: (c.phone && c.phone.length >= 8) ? 'whatsapp' : 'email',
          move: task.move_type
        });
      }
      if (!sample && seg.length > 0) {
        const first = seg[0];
        sample = {
          to: first.name || '—',
          subject: tmpl.subject,
          body: tmpl.body.replace(/\{NAME\}/g, first.name || 'לקוחה').replace(/\{COUPON\}/g, '[קוד אישי]')
        };
      }
    }
    const waCount = recipients.filter(r => r.channel === 'whatsapp').length;
    const emailCount = recipients.filter(r => r.channel === 'email').length;
    res.json({ ok: true, total: recipients.length, wa_count: waCount, email_count: emailCount, recipients, sample });
  } catch (err) {
    console.error("preview-plan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/agent/approve-plan", express.json(), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const { plan_id, selected_task_ids, send_mode, template_name } = req.body;
    if (!plan_id || !Array.isArray(selected_task_ids)) {
      return res.status(400).json({ ok: false, error: "חסר plan_id או רשימת מהלכים" });
    }
    await db.query(`UPDATE agent_tasks SET selected = (id = ANY($2)) WHERE plan_id=$1`,
      [plan_id, selected_task_ids]);
    // Persist the merchant's send choice so the engine knows whether to auto-send.
    await db.query(
      `UPDATE agent_plans SET status='approved', approved_at=NOW(),
         send_mode=$2, template_name=$3 WHERE id=$1`,
      [plan_id, send_mode || 'manual', template_name || null]
    ).catch(async () => {
      // Columns may not exist yet on older tables — add them, then retry.
      await db.query(`ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS send_mode TEXT DEFAULT 'manual'`).catch(()=>{});
      await db.query(`ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS template_name TEXT`).catch(()=>{});
      await db.query(`UPDATE agent_plans SET status='approved', approved_at=NOW(), send_mode=$2, template_name=$3 WHERE id=$1`,
        [plan_id, send_mode || 'manual', template_name || null]).catch(()=>{});
    });

    agentEngine.startPlan(shop, plan_id);
    res.json({ ok: true, started: true, plan_id });
  } catch (err) {
    console.error("Approve plan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/agent/plan-status", async (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const status = await agentEngine.getPlanStatus(req.query.plan_id);
  if (!status) return res.json({ ok: false, error: "not found" });
  res.json({ ok: true, ...status });
});

app.post("/api/agent/stop-plan", express.json(), async (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const result = await agentEngine.stopPlan(req.body.plan_id);
  res.json(result);
});

app.post("/api/agent/revise-plan", express.json(), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const { plan_id, request } = req.body;
    if (!plan_id || !request) return res.status(400).json({ ok: false, error: "חסר plan_id או בקשה" });

    const cur = await db.query(
      `SELECT id, priority, move_type, title, percentage, est_customers, projected_revenue
       FROM agent_tasks WHERE plan_id=$1 ORDER BY priority ASC`, [plan_id]);
    if (cur.rows.length === 0) return res.json({ ok: false, error: "התוכנית לא נמצאה" });

    const tasksJson = JSON.stringify(cur.rows.map(t => ({
      id: t.id, move: t.move_type, title: t.title, percentage: t.percentage,
      customers: t.est_customers
    })));
    const prompt = `זוהי תוכנית עבודה נוכחית (מערך מהלכים) בפורמט JSON:
${tasksJson}

בעל החנות מבקש לשנות: "${request}"

כללים חשובים:
1. אם הבקשה כללית (למשל "תוריד ל-5 לקוחות", "תעלה את ההנחה") - החל אותה על *כל* המהלכים, לא רק על חלק.
2. אם הבקשה מציינת מהלך ספציפי (למשל "במהלך 3" או לפי שם) - החל רק עליו.
3. אם שינית מספר לקוחות או אחוז במהלך - חובה להחזיר גם new_what: תיאור מעודכן קצר של המהלך שמשקף את המספרים החדשים (כי התיאור הישן מציג מספרים ישנים).

החזר JSON בלבד (בלי טקסט נוסף, בלי markdown) במבנה:
{"updates":[{"id":<מזהה המהלך>,"percentage":<אחוז חדש או null>,"max_customers":<מקסימום לקוחות חדש או null>,"new_title":<כותרת חדשה או null>,"new_what":<תיאור מעודכן של "מה אעשה" או null>,"remove":<true אם להסיר את המהלך, אחרת false>}]}
כלול רק מהלכים שצריך לשנות. אם הבקשה לא ברורה או לא רלוונטית, החזר {"updates":[]}.`;

    const result = await aiBrain.askBrain(shop, "770", prompt, []);
    let updates = [];
    try {
      const clean = (result.answer || '').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      updates = parsed.updates || [];
    } catch (e) {
      return res.json({ ok: false, error: "לא הצלחתי להבין את הבקשה, נסה לנסח אחרת" });
    }

    for (const u of updates) {
      if (!u.id) continue;
      if (u.remove) {
        await db.query(`DELETE FROM agent_tasks WHERE id=$1 AND plan_id=$2`, [u.id, plan_id]);
        continue;
      }
      const sets = [], vals = [u.id, plan_id];
      if (u.percentage != null) { vals.push(u.percentage); sets.push(`percentage=$${vals.length}`); }
      if (u.max_customers != null) { vals.push(Math.min(u.max_customers, 50)); sets.push(`est_customers=$${vals.length}`); }
      if (u.new_title) { vals.push(u.new_title); sets.push(`title=$${vals.length}`); }
      if (sets.length > 0) {
        await db.query(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id=$1 AND plan_id=$2`, vals);
      }
      // Keep the explanation in sync: write the updated "what" into params.details.what
      // so the expanded explanation no longer shows stale numbers.
      if (u.new_what) {
        await db.query(
          `UPDATE agent_tasks
           SET params = jsonb_set(COALESCE(params,'{}'::jsonb), '{details,what}', to_jsonb($3::text), true)
           WHERE id=$1 AND plan_id=$2`,
          [u.id, plan_id, String(u.new_what)]
        ).catch(e => console.error('revise new_what:', e.message));
      }
    }

    const refreshed = await agentEngine.getPlanStatus(plan_id);
    const projected = (refreshed.tasks || []).reduce((s, t) => s + parseFloat(t.projected_revenue || 0), 0);
    await db.query(`UPDATE agent_plans SET projected_revenue=$2 WHERE id=$1`, [plan_id, projected]);
    res.json({ ok: true, plan_id, projected_revenue: Math.round(projected), ...refreshed });
  } catch (err) {
    console.error("Revise plan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/advisor-actions-log", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const r = await db.query(
      `SELECT action_type, target_email, target_phone, coupon_code,
              attributed_revenue, outcome, created_at, closed_at
       FROM advisor_actions
       WHERE shop_domain = $1
         AND action_type NOT IN ('daily_report','morning_report')
         AND outcome <> 'duplicate'
       ORDER BY (outcome = 'converted') DESC, created_at DESC
       FETCH FIRST 500 ROWS ONLY`,
      [shop]
    );
    const TYPE_LABELS = {
      abandoned_cart: 'שחזור עגלה נטושה',
      dormant_vip: 'החזרת לקוחה VIP',
      one_time: 'דחיפה לקנייה שנייה',
      hot_product: 'קידום מוצר חם',
      personalized_cart: 'עגלה מותאמת אישית',
      winback: 'win-back',
      campaign: 'קמפיין'
    };
    const actions = r.rows.map(a => ({
      type: a.action_type,
      type_label: TYPE_LABELS[a.action_type] || a.action_type,
      target: a.target_email || a.target_phone || '—',
      coupon: a.coupon_code,
      revenue: Math.round(parseFloat(a.attributed_revenue || 0)),
      outcome: a.outcome,
      created_at: a.created_at,
      closed_at: a.closed_at
    }));
    res.json({ ok: true, actions });
  } catch (err) {
    console.error("Actions log error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/advisor-stats", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const r = await db.query(
      `SELECT
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'), 0)::numeric(12,2) AS total_revenue,
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'
           AND closed_at >= date_trunc('month', NOW())), 0)::numeric(12,2) AS month_revenue,
         COUNT(*) FILTER (WHERE outcome = 'converted')::int AS conversions,
         COUNT(*)::int AS total_actions,
         COUNT(*) FILTER (WHERE outcome = 'pending')::int AS pending
       FROM advisor_actions
       WHERE shop_domain = $1`,
      [shop]
    );
    const row = r.rows[0] || {};
    res.json({
      ok: true,
      total_revenue: Math.round(parseFloat(row.total_revenue || 0)),
      month_revenue: Math.round(parseFloat(row.month_revenue || 0)),
      conversions: row.conversions || 0,
      total_actions: row.total_actions || 0,
      pending: row.pending || 0
    });
  } catch (err) {
    console.error("Advisor stats error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live stats for the "My Team" screen — one call returns numbers per agent.
app.get("/api/team-stats", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;

    // Campaigner: how many opportunities it surfaced right now.
    let opportunities = 0;
    try {
      const ins = await insightsEngine.getInsights(shop);
      opportunities = (ins.insights || []).length + (Array.isArray(ins.pool) ? ins.pool.length : 0);
    } catch (e) {}

    // Sales agent: actions sent + conversions + revenue (today + all-time).
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE outcome <> 'duplicate'
           AND action_type NOT IN ('daily_report','morning_report'))::int AS total_actions,
         COUNT(*) FILTER (WHERE outcome <> 'duplicate'
           AND action_type NOT IN ('daily_report','morning_report')
           AND created_at >= date_trunc('day', NOW()))::int AS actions_today,
         COUNT(*) FILTER (WHERE outcome = 'converted')::int AS conversions,
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'), 0)::numeric(12,2) AS revenue,
         COUNT(*) FILTER (WHERE outcome = 'pending')::int AS pending
       FROM advisor_actions
       WHERE shop_domain = $1`,
      [shop]
    );
    const a = r.rows[0] || {};

    res.json({
      ok: true,
      campaigner: { opportunities },
      sales: {
        total_actions: a.total_actions || 0,
        actions_today: a.actions_today || 0,
        conversions: a.conversions || 0,
        pending: a.pending || 0,
        revenue: Math.round(parseFloat(a.revenue || 0))
      }
    });
  } catch (err) {
    console.error("team-stats error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/action/execute", express.json(), async (req, res) => {
  try {
    const {
      password, action_type,
      email, phone, customer_name,
      create_coupon, coupon_percentage, coupon_ils, coupon_code, coupon_days, coupon_combine,
      message_subject, message_body, cta_url, cta_label
    } = req.body;

    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = { ok: true, steps: {} };

    const isFixed = !!coupon_ils && parseFloat(coupon_ils) > 0;

    let couponCode = null;
    if (create_coupon) {
      const GENERIC = ["SALE","DISCOUNT","COUPON","SAVE","PROMO","CODE"];
      let finalCode = (coupon_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const isGeneric = !finalCode || GENERIC.includes(finalCode);
      if (isGeneric) {
        let namePart = "";
        if (customer_name) {
          namePart = customer_name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8);
        }
        if (!namePart && email) namePart = email.split("@")[0].replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8);
        if (!namePart) namePart = "VIP";
        const amt = isFixed ? Math.round(parseFloat(coupon_ils)) : (coupon_percentage || 10);
        const suffix = Math.floor(Math.random() * 900 + 100);
        finalCode = `${namePart}${amt}${suffix}`;
      }
      let c = await shopify.createDiscountCode(shop, {
        percentage: isFixed ? null : (coupon_percentage || 10),
        amount_ils: isFixed ? parseFloat(coupon_ils) : null,
        combine: coupon_combine === false ? false : true,
        code: finalCode,
        days_valid: coupon_days || 2,
        title: `יועץ: ${action_type || 'campaign'} - ${customer_name || email || ''}`
      });
      // If the code already exists (created recently, still valid), Shopify returns
      // "must be unique". Instead of failing, retry once with a random suffix so the
      // merchant can always send — a fresh unique code is created.
      if (!c.ok && /must be unique|already exists|taken/i.test(c.error || "")) {
        const retryCode = `${finalCode}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        c = await shopify.createDiscountCode(shop, {
          percentage: isFixed ? null : (coupon_percentage || 10),
          amount_ils: isFixed ? parseFloat(coupon_ils) : null,
          combine: coupon_combine === false ? false : true,
          code: retryCode,
          days_valid: coupon_days || 2,
          title: `יועץ: ${action_type || 'campaign'} - ${customer_name || email || ''}`
        });
      }
      if (!c.ok) {
        result.steps.coupon = { ok: false, error: c.error, needs_scope: c.needs_scope };
        return res.status(400).json({ ok: false, error: "יצירת הקופון נכשלה: " + c.error, steps: result.steps });
      }
      couponCode = c.code;
      result.steps.coupon = { ok: true, code: c.code, percentage: c.percentage, ends_at: c.ends_at };
    }

    let finalBody = message_body || "";
    if (couponCode && finalBody.includes("{COUPON}")) {
      finalBody = finalBody.replace(/\{COUPON\}/g, couponCode);
    } else if (couponCode && !finalBody.includes(couponCode)) {
      finalBody += `\n\nקוד הקופון שלך: ${couponCode}`;
    }
    // Always include a link to the store so the customer can act on the offer.
    const storeUrl = shopify.getPublicDomain(shop);
    if (!finalBody.includes(storeUrl.replace(/^https?:\/\//, ""))) {
      finalBody += `\n\nלרכישה: ${storeUrl}`;
    }

    const hasPhone = phone && String(phone).trim().length >= 8;

    if (hasPhone) {
      const optedOut = await compliance.isOptedOut(shop, { email, phone });
      if (optedOut) {
        return res.json({ ok: false, blocked: true, reason: "opted_out",
          detail: "הלקוחה ביקשה לא לקבל הודעות. לא ניתן לפנות אליה." });
      }
      let waPhone = String(phone).replace(/[^0-9]/g, "");
      if (waPhone.startsWith("0")) waPhone = "972" + waPhone.slice(1);
      const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(finalBody)}`;
      result.steps.message = { channel: "whatsapp", ready_link: waUrl, note: "לחץ לשליחה ב-WhatsApp" };

      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, action_type || 'whatsapp_prepared', email || null, phone, JSON.stringify({ channel: 'whatsapp', subject: message_subject, customer_name: customer_name || null }), couponCode]
      ).catch(e => console.error("log:", e.message));

    } else if (email) {
      const gate = await compliance.canContactCustomer(shop, { email, phone });
      if (!gate.allowed) {
        result.steps.message = { channel: "email", ok: false, blocked: true, reason: gate.reason, detail: gate.detail };
        return res.json({ ok: false, blocked: true, reason: gate.reason, detail: gate.detail, steps: result.steps });
      }
      const html = mailer.buildHtmlEmail(finalBody, { cta_url, cta_label, brand: storeBrand(shop), to: email, shop });
      const sent = await mailer.sendEmail({ to: email, subject: message_subject || "הודעה מ-770", html, text: finalBody });
      if (!sent.ok) {
        result.steps.message = { channel: "email", ok: false, error: sent.error };
        return res.status(400).json({ ok: false, error: "שליחת המייל נכשלה: " + sent.error, steps: result.steps });
      }
      result.steps.message = { channel: "email", ok: true, id: sent.id };

      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, action_type || 'email_sent', email, phone || null, JSON.stringify({ channel: 'email', subject: message_subject, customer_name: customer_name || null }), couponCode]
      ).catch(e => console.error("log:", e.message));

    } else {
      return res.status(400).json({ ok: false, error: "אין דרך ליצור קשר (חסר טלפון ומייל)" });
    }

    res.json(result);
  } catch (err) {
    console.error("Action execute error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/action/build-cart", express.json(), async (req, res) => {
  try {
    const {
      password, email, phone, customer_name,
      items, discount_percentage,
      message_subject, message_body
    } = req.body;

    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "אין פריטים לעגלה" });
    }

    if (await compliance.isOptedOut(shop, { email, phone })) {
      return res.json({ ok: false, blocked: true, reason: "opted_out",
        detail: "הלקוחה ביקשה לא לקבל הודעות. לא ניתן לפנות אליה." });
    }

    const draft = await shopify.createDraftOrder(shop, {
      items, email: email || null,
      discount_percentage: discount_percentage || null,
      note: `עגלה מותאמת ל${customer_name || 'לקוחה'} - הוכן על ידי היועץ`
    });
    if (!draft.ok) {
      return res.status(400).json({ ok: false, error: "בניית העגלה נכשלה: " + draft.error, needs_scope: draft.needs_scope });
    }

    let cartCoupon = null;
    if (discount_percentage) {
      const namePart = (customer_name || (email ? email.split("@")[0] : "") || "VIP").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8) || "VIP";
      const suffix = Math.floor(Math.random() * 900 + 100);
      const c = await shopify.createDiscountCode(shop, {
        percentage: discount_percentage,
        code: `${namePart}${discount_percentage}${suffix}`,
        days_valid: 2,
        title: `יועץ: עגלה מותאמת - ${customer_name || email || ''}`
      });
      if (c.ok) cartCoupon = c.code;
    }

    const payUrl = draft.invoice_url;
    let editableCartUrl = null;
    try {
      const cartParts = items.map(it => `${it.variant_id}:${it.quantity || 1}`).join(',');
      editableCartUrl = `${shopify.getPublicDomain(shop)}/cart/${cartParts}`;
      if (cartCoupon) editableCartUrl += `?discount=${encodeURIComponent(cartCoupon)}`;
    } catch (e) {}

    const linkForMessage = editableCartUrl || payUrl;
    // Replace the {COUPON} placeholder with the REAL code we just created, so the
    // customer gets a working code (not the literal text "{COUPON}"). If the body
    // has no placeholder but we created a code, append it explicitly.
    let finalBody = message_body || "";
    if (cartCoupon) {
      if (finalBody.includes("{COUPON}")) {
        finalBody = finalBody.replace(/\{COUPON\}/g, cartCoupon);
      } else if (!finalBody.includes(cartCoupon)) {
        finalBody += `\n\nהקוד האישי שלך: ${cartCoupon}`;
      }
    }
    finalBody += `\n\nהעגלה מחכה לך - אפשר לשנות, להוסיף, ולסיים את ההזמנה כאן:\n${linkForMessage}`;

    const result = { ok: true, steps: { cart: { ok: true, total: draft.total, pay_url: payUrl, editable_url: editableCartUrl, coupon: cartCoupon } } };

    const hasPhone = phone && String(phone).trim().length >= 8;
    if (hasPhone) {
      let waPhone = String(phone).replace(/[^0-9]/g, "");
      if (waPhone.startsWith("0")) waPhone = "972" + waPhone.slice(1);
      const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(finalBody)}`;
      result.steps.message = { channel: "whatsapp", ready_link: waUrl };
    } else if (email) {
      const gate = await compliance.canContactCustomer(shop, { email, phone });
      if (!gate.allowed) {
        return res.json({ ok: false, blocked: true, reason: gate.reason, detail: gate.detail, steps: result.steps });
      }
      const html = mailer.buildHtmlEmail(message_body || "הכנו לך עגלה אישית!", {
        cta_url: linkForMessage, cta_label: "לעגלה שלך", brand: storeBrand(shop), to: email, shop
      });
      const sent = await mailer.sendEmail({ to: email, subject: message_subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody });
      if (!sent.ok) return res.status(400).json({ ok: false, error: "שליחת המייל נכשלה: " + sent.error });
      result.steps.message = { channel: "email", ok: true, id: sent.id };
    } else {
      return res.status(400).json({ ok: false, error: "אין דרך ליצור קשר" });
    }

    await db.query(
      `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
       VALUES ($1, 'personalized_cart', $2, $3, $4, $5)`,
      [shop, email || null, phone || null, JSON.stringify({ draft_order_id: draft.draft_order_id, total: draft.total, customer_name: customer_name || null }), cartCoupon]
    ).catch(e => console.error("log:", e.message));

    res.json(result);
  } catch (err) {
    console.error("Build cart error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// BATCH personalized carts: build many carts at once (like a campaign).
// Each cart: { name, email, phone, items:[{variant_id,quantity}], discount, subject, body }
// Returns { whatsapp:[{name,phone,coupon,link}], emails_sent, failed } so the UI
// can show one WhatsApp square per customer, exactly like a campaign.
// ======================
app.post("/api/cart/build-batch", express.json(), async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const carts = Array.isArray(req.body.carts) ? req.body.carts : [];
    if (carts.length === 0) return res.status(400).json({ ok: false, error: "אין עגלות לבנות" });

    const whatsapp = [];
    let emailsSent = 0, failed = 0, skipped = 0;
    let ownerSampleSent = false;

    for (const cart of carts) {
      try {
        const email = cart.email || null;
        const phone = cart.phone || null;
        const customer_name = cart.name || null;
        const items = Array.isArray(cart.items) ? cart.items : [];
        const discount = cart.discount ? parseInt(cart.discount) : null;
        if (items.length === 0) { failed++; continue; }

        // Opt-out gate
        if (await compliance.isOptedOut(shop, { email, phone })) { skipped++; continue; }

        // Build the draft order (the cart itself)
        const draft = await shopify.createDraftOrder(shop, {
          items, email: email || null,
          discount_percentage: discount || null,
          note: `עגלה מותאמת ל${customer_name || 'לקוחה'} - הוכן על ידי היועץ`
        });
        if (!draft.ok) { failed++; continue; }

        // Personal coupon (real code the customer can use)
        let cartCoupon = null;
        if (discount) {
          const namePart = (customer_name || (email ? email.split("@")[0] : "") || "VIP").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8) || "VIP";
          const suffix = Math.floor(Math.random() * 900 + 100);
          const c = await shopify.createDiscountCode(shop, {
            percentage: discount,
            code: `${namePart}${discount}${suffix}`,
            days_valid: 2,
            combine: true,
            title: `יועץ: עגלה מותאמת - ${customer_name || email || ''}`
          });
          if (c.ok) cartCoupon = c.code;
        }

        // Editable cart link (carries the coupon so it auto-applies)
        let editableCartUrl = null;
        try {
          const cartParts = items.map(it => `${it.variant_id}:${it.quantity || 1}`).join(',');
          editableCartUrl = `${shopify.getPublicDomain(shop)}/cart/${cartParts}`;
          if (cartCoupon) editableCartUrl += `?discount=${encodeURIComponent(cartCoupon)}`;
        } catch (e) {}
        const linkForMessage = editableCartUrl || draft.invoice_url;

        // Build the message body with the REAL coupon code
        let finalBody = cart.body || "";
        if (cartCoupon) {
          if (finalBody.includes("{COUPON}")) finalBody = finalBody.replace(/\{COUPON\}/g, cartCoupon);
          else if (!finalBody.includes(cartCoupon)) finalBody += `\n\nהקוד האישי שלך: ${cartCoupon}`;
        }
        finalBody += `\n\nהעגלה מחכה לך - אפשר לשנות, להוסיף, ולסיים את ההזמנה כאן:\n${linkForMessage}`;

        const hasPhone = phone && String(phone).replace(/[^0-9]/g, "").length >= 8;
        if (hasPhone) {
          let waPhone = String(phone).replace(/[^0-9]/g, "");
          if (waPhone.startsWith("0")) waPhone = "972" + waPhone.slice(1);
          const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(finalBody)}`;
          whatsapp.push({ name: customer_name || "", phone, coupon: cartCoupon, link: waUrl, sent: false });
        } else if (email) {
          const gate = await compliance.canContactCustomer(shop, { email, phone });
          if (!gate.allowed) { skipped++; }
          else {
            const html = mailer.buildHtmlEmail(cart.body || "הכנו לך עגלה אישית!", {
              cta_url: linkForMessage, cta_label: "לעגלה שלך", brand: storeBrand(shop), to: email, shop
            });
            const sent = await mailer.sendEmail({ to: email, subject: cart.subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody });
            if (sent.ok) emailsSent++; else failed++;
            // Send the owner ONE sample copy of what customers receive.
            if (sent.ok && !ownerSampleSent) {
              ownerSampleSent = true;
              await sendOwnerSample(shop, { subject: cart.subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody });
            }
          }
        } else { failed++; }

        // Log the action (for attribution)
        await db.query(
          `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
           VALUES ($1, 'personalized_cart', $2, $3, $4, $5)`,
          [shop, email || null, phone || null,
           JSON.stringify({ draft_order_id: draft.draft_order_id, total: draft.total, customer_name: customer_name || null }), cartCoupon]
        ).catch(e => console.error("log:", e.message));

      } catch (e) {
        console.error("[cart-batch] one cart failed:", e.message);
        failed++;
      }
    }

    res.json({ ok: true, whatsapp, emails_sent: emailsSent, failed, skipped, total: carts.length });
  } catch (err) {
    console.error("Build cart batch error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/icon-192.png", (req, res) => {
  res.sendFile(__dirname + "/icon-192.png");
});
app.get("/icon-512.png", (req, res) => {
  res.sendFile(__dirname + "/icon-512.png");
});
// Dynamic PWA manifest — customizes the home-screen app name per store.
// chat.html requests /manifest.json?shop=xxx (or ?name=xxx); we return a manifest
// with that store's name so the installed icon shows the right brand.
app.get("/manifest.json", (req, res) => {
  let name = "היועץ החכם";
  let logoUrl = null;
  const shop = (req.query.shop || "").toLowerCase().trim();
  const nameParam = (req.query.name || "").trim();
  if (shop) {
    try {
      const cfg = shopify.getStore(shop);
      const storeName = (cfg && cfg.name) || (shop === DEFAULT_SHOP ? "770" : shop.replace(".myshopify.com", ""));
      name = "היועץ של " + storeName;
      if (cfg && cfg.logo_url) logoUrl = cfg.logo_url;
    } catch (e) { /* fall back to default */ }
  } else if (nameParam) {
    name = "היועץ של " + nameParam;
  }
  // Use the store's own logo as the home-screen icon if set; else the default icons.
  const icons = logoUrl
    ? [
        { src: logoUrl, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: logoUrl, sizes: "512x512", type: "image/png", purpose: "any" }
      ]
    : [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
      ];
  res.json({
    name: name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0b8aff",
    icons: icons
  });
});

// iOS home-screen icon per store: redirect to the store's logo, or the default.
app.get("/store-icon", (req, res) => {
  const shop = (req.query.shop || "").toLowerCase().trim();
  try {
    const cfg = shop ? shopify.getStore(shop) : null;
    if (cfg && cfg.logo_url) return res.redirect(cfg.logo_url);
  } catch (e) { /* fall through to default */ }
  res.sendFile(__dirname + "/apple-touch-icon.png");
});

app.get("/apple-touch-icon.png", (req, res) => {
  res.sendFile(__dirname + "/apple-touch-icon.png");
});

// Service worker (must be served from root scope to control the whole app).
app.get("/sw.js", (req, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Service-Worker-Allowed", "/");
  res.sendFile(__dirname + "/sw.js");
});

// Push: expose the VAPID public key so the client can subscribe.
app.get("/api/push/public-key", (req, res) => {
  res.json({ ok: true, key: pushEngine.publicKey(), configured: pushEngine.isConfigured() });
});

// Push: save a browser subscription for the logged-in store.
app.post("/api/push/subscribe", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
  const sub = req.body && req.body.subscription;
  const r = await pushEngine.saveSubscription(shop, sub);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/chat/save", express.json(), async (req, res) => {
  try {
    const { id, title, messages, password } = req.body;
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const msgs = Array.isArray(messages) ? messages : [];
    const safeTitle = (title || "שיחה חדשה").substring(0, 200);
    if (id) {
      const result = await db.query(
        `UPDATE chat_conversations
         SET title = $1, messages = $2, updated_at = NOW()
         WHERE id = $3 AND shop_domain = $4
         RETURNING id`,
        [safeTitle, JSON.stringify(msgs), id, shop]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "שיחה לא נמצאה" });
      }
      return res.json({ ok: true, id: result.rows[0].id });
    } else {
      const result = await db.query(
        `INSERT INTO chat_conversations (shop_domain, title, messages)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [shop, safeTitle, JSON.stringify(msgs)]
      );
      return res.json({ ok: true, id: result.rows[0].id });
    }
  } catch (err) {
    console.error("chat/save error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/chat/list", async (req, res) => {
  try {
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await db.query(
      `SELECT id, title, updated_at
       FROM chat_conversations
       WHERE shop_domain = $1
       ORDER BY updated_at DESC
       LIMIT 10`,
      [shop]
    );
    res.json({ ok: true, conversations: result.rows });
  } catch (err) {
    console.error("chat/list error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/chat/get/:id", async (req, res) => {
  try {
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const result = await db.query(
      `SELECT id, title, messages, updated_at
       FROM chat_conversations
       WHERE id = $1 AND shop_domain = $2`,
      [req.params.id, shop]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "שיחה לא נמצאה" });
    }
    res.json({ ok: true, conversation: result.rows[0] });
  } catch (err) {
    console.error("chat/get error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/chat/delete/:id", async (req, res) => {
  try {
    if (!resolveShop(req)) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = resolveShop(req) || DEFAULT_SHOP;
    await db.query(
      `DELETE FROM chat_conversations WHERE id = $1 AND shop_domain = $2`,
      [req.params.id, shop]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("chat/delete error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/sync-products", async (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה - הוסף ?password=tryfit2026 ל-URL" });
  }
  try {
    const result = await shopify.syncProducts(resolveShop(req) || DEFAULT_SHOP);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/sync-checkouts", async (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  try {
    const result = await shopify.syncAbandonedCheckouts(resolveShop(req) || DEFAULT_SHOP);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function buildFashnBody(dataUri, garmentUrl, category) {
  console.log("Building FASHN body with category:", category);
  return {
    model_name: "tryon-v1.6",
    inputs: {
      model_image: dataUri,
      garment_image: garmentUrl,
      category: category || "auto",
      mode: "balanced",
      garment_photo_type: "auto"
    },
    num_samples: 1
  };
}

async function submitFashn(dataUri, garmentUrl, category) {
  const body = buildFashnBody(dataUri, garmentUrl, category);
  const response = await fetch("https://api.fashn.ai/v1/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.FASHN_API_KEY
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function pollFashn(predictionId) {
  for (let i = 0; i < 60; i++) {
    const response = await fetch("https://api.fashn.ai/v1/status/" + predictionId, {
      headers: { "Authorization": "Bearer " + process.env.FASHN_API_KEY }
    });
    const data = await response.json();
    if (data.status === "completed") return data;
    if (data.status === "failed") throw new Error(data.error?.message || "FASHN failed");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error("Timeout");
}

async function submitAndWaitFashn(modelImage, garmentUrl, category) {
  const maxRetries = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await submitFashn(modelImage, garmentUrl, category);
      if (!data.id) throw new Error(data.message || data.error || "No prediction ID");
      console.log("  FASHN submitted, ID:", data.id, "(attempt " + attempt + "/" + maxRetries + ")");
      const result = await pollFashn(data.id);
      if (result.output && result.output[0]) return result.output[0];
      throw new Error("No output image");
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        console.log("  Attempt " + attempt + " failed:", err.message);
        console.log("  Retrying in 2 seconds...");
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function submitRunPod(dataUri, garmentUrl, category) {
  let rpCategory = category;
  const categoryMap = {
    "tops": "upper_body", "top": "upper_body",
    "shirts": "upper_body", "shirt": "upper_body",
    "blouses": "upper_body", "blouse": "upper_body",
    "sweaters": "upper_body", "sweater": "upper_body",
    "vest": "upper_body", "vests": "upper_body",
    "jackets": "upper_body", "jacket": "upper_body",
    "coats": "upper_body", "coat": "upper_body",
    "hoodies": "upper_body", "hoodie": "upper_body",
    "blazer": "upper_body", "blazers": "upper_body",
    "cardigan": "upper_body", "cardigans": "upper_body",
    "t-shirt": "upper_body", "t-shirts": "upper_body",
    "tshirt": "upper_body", "tshirts": "upper_body",
    "tee": "upper_body", "tees": "upper_body",
    "polo": "upper_body", "polos": "upper_body",
    "tank top": "upper_body", "tank tops": "upper_body",
    "tank": "upper_body", "tanks": "upper_body",
    "camisole": "upper_body", "cami": "upper_body",
    "crop top": "upper_body", "crop tops": "upper_body",
    "tunic": "upper_body", "tunics": "upper_body",
    "henley": "upper_body", "henleys": "upper_body",
    "pullover": "upper_body", "pullovers": "upper_body",
    "sweatshirt": "upper_body", "sweatshirts": "upper_body",
    "fleece": "upper_body",
    "parka": "upper_body", "parkas": "upper_body",
    "windbreaker": "upper_body", "windbreakers": "upper_body",
    "bomber": "upper_body", "bombers": "upper_body",
    "denim jacket": "upper_body",
    "leather jacket": "upper_body",
    "puffer": "upper_body", "puffer jacket": "upper_body",
    "down jacket": "upper_body",
    "trench": "upper_body", "trench coat": "upper_body",
    "poncho": "upper_body",
    "cape": "upper_body",
    "bolero": "upper_body",
    "shrug": "upper_body",
    "kimono": "upper_body",
    "bodysuit": "upper_body", "bodysuits": "upper_body",
    "corset": "upper_body",
    "bustier": "upper_body",
    "bralette": "upper_body",
    "bottoms": "lower_body", "bottom": "lower_body",
    "pants": "lower_body", "pant": "lower_body",
    "jeans": "lower_body", "jean": "lower_body",
    "denim": "lower_body",
    "trousers": "lower_body", "trouser": "lower_body",
    "shorts": "lower_body", "short": "lower_body",
    "skirts": "lower_body", "skirt": "lower_body",
    "leggings": "lower_body", "legging": "lower_body",
    "joggers": "lower_body", "jogger": "lower_body",
    "sweatpants": "lower_body", "sweatpant": "lower_body",
    "chinos": "lower_body", "chino": "lower_body",
    "khakis": "lower_body", "khaki": "lower_body",
    "cargo pants": "lower_body", "cargo": "lower_body",
    "culottes": "lower_body",
    "capris": "lower_body", "capri": "lower_body",
    "palazzo": "lower_body", "palazzo pants": "lower_body",
    "wide leg pants": "lower_body",
    "skinny jeans": "lower_body",
    "straight jeans": "lower_body",
    "flare pants": "lower_body",
    "mini skirt": "lower_body",
    "midi skirt": "lower_body",
    "maxi skirt": "lower_body",
    "pencil skirt": "lower_body",
    "pleated skirt": "lower_body",
    "bike shorts": "lower_body",
    "bermuda": "lower_body", "bermudas": "lower_body",
    "board shorts": "lower_body",
    "swim trunks": "lower_body",
    "dresses": "overall", "dress": "overall",
    "one-piece": "overall", "onepiece": "overall",
    "set": "overall", "sets": "overall",
    "jumpsuit": "overall", "jumpsuits": "overall",
    "romper": "overall", "rompers": "overall",
    "overalls": "overall", "overall": "overall",
    "playsuit": "overall", "playsuits": "overall",
    "gown": "overall", "gowns": "overall",
    "maxi dress": "overall",
    "midi dress": "overall",
    "mini dress": "overall",
    "cocktail dress": "overall",
    "evening dress": "overall",
    "sundress": "overall", "sundresses": "overall",
    "wrap dress": "overall",
    "shirt dress": "overall",
    "bodycon dress": "overall",
    "a-line dress": "overall",
    "suit": "overall", "suits": "overall",
    "two-piece": "overall", "two piece": "overall",
    "matching set": "overall",
    "co-ord": "overall", "coord": "overall",
    "tracksuit": "overall", "tracksuits": "overall",
    "onesie": "overall",
    "catsuit": "overall",
    "unitard": "overall",
    "auto": "upper_body"
  };
  rpCategory = categoryMap[(rpCategory || "").toLowerCase()] || "upper_body";
  const body = {
    input: {
      model_image: dataUri,
      garment_image: garmentUrl,
      category: rpCategory
    }
  };
  const response = await fetch(RUNPOD_BASE_URL + "/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + RUNPOD_API_KEY
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function pollRunPod(jobId) {
  for (let i = 0; i < 120; i++) {
    const response = await fetch(RUNPOD_BASE_URL + "/status/" + jobId, {
      headers: { "Authorization": "Bearer " + RUNPOD_API_KEY }
    });
    const data = await response.json();
    if (data.status === "COMPLETED") return data;
    if (data.status === "FAILED") throw new Error(data.output?.error || "RunPod job failed");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("Timeout waiting for RunPod");
}

async function submitAndWaitRunPod(modelImage, garmentUrl, category) {
  const data = await submitRunPod(modelImage, garmentUrl, category);
  if (!data.id) throw new Error(data.error || "No job ID from RunPod");
  console.log("  RunPod submitted, ID:", data.id);
  const result = await pollRunPod(data.id);
  if (result.output?.image) return result.output.image;
  throw new Error("No output image from RunPod");
}

async function submitJob(dataUri, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitRunPod(dataUri, garmentUrl, category);
  return await submitFashn(dataUri, garmentUrl, category);
}

async function submitAndWait(modelImage, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitAndWaitRunPod(modelImage, garmentUrl, category);
  return await submitAndWaitFashn(modelImage, garmentUrl, category);
}

app.post("/api/tryon/generate", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== NEW TRY-ON REQUEST [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    console.log("User IP:", ip, "| Limit:", dailyLimit);
    const shop = getShopFromRequest(req);
    if (shop) {
      const creditCheck = creditsSystem.checkAndUseCredit(shop, ip);
      if (!creditCheck.allowed) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        if (creditCheck.reason === "not_found") {
          return res.status(403).json({ error: "החנות לא רשומה במערכת. צרו קשר עם TryFit." });
        }
        return res.status(403).json({ error: "נגמרו הקרדיטים! צרו קשר לחידוש המנוי.", credits: 0 });
      }
      console.log("Shop:", shop, "| Credits remaining:", creditCheck.credits);
    }
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    let garmentImageUrl = req.body.garment_image_url;
    if (garmentImageUrl && garmentImageUrl.startsWith("//")) {
      garmentImageUrl = "https:" + garmentImageUrl;
    }
    const category = req.body.garment_category || req.body.category || "auto";
    if (!req.file) return res.status(400).json({ error: "No model image uploaded" });
    if (!garmentImageUrl) return res.status(400).json({ error: "No garment image URL" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    console.log("Category:", category);
    console.log("Garment URL:", garmentImageUrl);
    if (BACKEND_MODE === "runpod") {
      const outputImage = await submitAndWaitRunPod(dataUri, garmentImageUrl, category);
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      res.json({ status: "completed", output: [outputImage], prediction_id: "runpod-direct" });
      saveTryOnEvent(shop, {
        product_id: req.body.product_id,
        product_title: req.body.product_title,
        product_category: category,
        product_price: req.body.product_price ? parseFloat(req.body.product_price) : null,
        garment_url: garmentImageUrl,
        result_url: outputImage,
        ip_address: ip,
        user_agent: req.headers["user-agent"],
        identifier: req.body.identifier || ip,
        session_id: req.body.session_id,
        success: true
      });
    } else {
      const data = await submitFashn(dataUri, garmentImageUrl, category);
      console.log("FASHN response:", JSON.stringify(data));
      if (data.id) {
        res.json({ prediction_id: data.id });
        saveTryOnEvent(shop, {
          product_id: req.body.product_id,
          product_title: req.body.product_title,
          product_category: category,
          product_price: req.body.product_price ? parseFloat(req.body.product_price) : null,
          garment_url: garmentImageUrl,
          ip_address: ip,
          user_agent: req.headers["user-agent"],
          identifier: req.body.identifier || ip,
          session_id: req.body.session_id,
          success: true
        });
      } else if (data.error) {
        res.status(500).json({ error: data.error });
      } else {
        res.status(500).json({ error: "No prediction ID returned", details: data });
      }
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    }
  } catch (err) {
    console.error("Generate error:", err);
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tryon/generate-multi", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== MULTI-IMAGE TRY-ON [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    if (!req.file) return res.status(400).json({ error: "No model image uploaded" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    let garmentUrls = [];
    try { garmentUrls = JSON.parse(req.body.garment_image_urls); } catch(e) {}
    let categories = [];
    try { categories = JSON.parse(req.body.categories); } catch(e) {}
    if (!garmentUrls.length) return res.status(400).json({ error: "No garment images provided" });
    console.log("Garment URLs:", garmentUrls.length);
    var results = [];
    for (var i = 0; i < garmentUrls.length; i++) {
      var gUrl = garmentUrls[i];
      if (gUrl.startsWith("//")) gUrl = "https:" + gUrl;
      var cat = categories[i] || "auto";
      if (BACKEND_MODE === "runpod") {
        try {
          const outputImage = await submitAndWaitRunPod(dataUri, gUrl, cat);
          results.push({ status: "completed", output: [outputImage], garment_url: gUrl, category: cat });
        } catch (err) {
          results.push({ error: err.message, garment_url: gUrl, category: cat });
        }
      } else {
        var data = await submitFashn(dataUri, gUrl, cat);
        if (data.id) {
          results.push({ prediction_id: data.id, garment_url: gUrl, category: cat });
        } else {
          results.push({ error: data.error || "Failed", garment_url: gUrl, category: cat });
        }
      }
    }
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    const multiShop = getShopFromRequest(req);
    if (multiShop) {
      results.forEach((r, idx) => {
        saveTryOnEvent(multiShop, {
          product_category: categories[idx] || "auto",
          garment_url: r.garment_url,
          ip_address: ip,
          user_agent: req.headers["user-agent"],
          identifier: req.body.identifier || ip,
          session_id: req.body.session_id,
          success: !r.error,
          error_message: r.error || null
        });
      });
    }
    res.json({ results: results });
  } catch (err) {
    console.error("Multi generate error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tryon/generate-chain", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== CHAIN TRY-ON [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    console.log("User IP:", ip, "| Limit:", dailyLimit);
    const shop = getShopFromRequest(req);
    console.log("Shop detected:", shop);
    if (shop) {
      const creditCheck = creditsSystem.checkAndUseCredit(shop, ip);
      if (!creditCheck.allowed) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        if (creditCheck.reason === "not_found") {
          return res.status(403).json({ error: "החנות לא רשומה במערכת. צרו קשר עם TryFit." });
        }
        return res.status(403).json({ error: "נגמרו הקרדיטים! צרו קשר לחידוש המנוי.", credits: 0 });
      }
      console.log("Shop:", shop, "| Credits remaining:", creditCheck.credits);
    }
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    if (!req.file) return res.status(400).json({ error: "No model image" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    let garmentUrls = [];
    try { garmentUrls = JSON.parse(req.body.garment_image_urls); } catch(e) {}
    let categories = [];
    try { categories = JSON.parse(req.body.categories); } catch(e) {}
    if (!garmentUrls.length) return res.status(400).json({ error: "No garment images" });
    garmentUrls = garmentUrls.map(u => u.startsWith("//") ? "https:" + u : u);
    console.log("Chain steps:", garmentUrls.length);
    let currentModelImage = dataUri;
    let stepResults = [];
    for (let i = 0; i < garmentUrls.length; i++) {
      const cat = categories[i] || "auto";
      console.log("--- Step", i + 1, "/", garmentUrls.length, "---");
      try {
        const outputUrl = await submitAndWait(currentModelImage, garmentUrls[i], cat);
        stepResults.push({ step: i + 1, output_url: outputUrl, garment_url: garmentUrls[i] });
        currentModelImage = outputUrl;
      } catch (err) {
        console.error("  Step", i + 1, "failed:", err.message);
        stepResults.push({ step: i + 1, error: err.message, garment_url: garmentUrls[i] });
      }
    }
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    const finalOutput = stepResults.filter(r => r.output_url).pop();
    if (shop) {
      let productIds = [];
      let productTitles = [];
      try { if (req.body.product_ids) productIds = JSON.parse(req.body.product_ids); } catch(e) {}
      try { if (req.body.product_titles) productTitles = JSON.parse(req.body.product_titles); } catch(e) {}
      stepResults.forEach((step, idx) => {
        saveTryOnEvent(shop, {
          product_id: productIds[idx] || null,
          product_title: productTitles[idx] || null,
          product_category: categories[idx] || "auto",
          garment_url: step.garment_url,
          result_url: step.output_url || null,
          ip_address: ip,
          user_agent: req.headers["user-agent"],
          identifier: req.body.identifier || ip,
          session_id: req.body.session_id,
          success: !!step.output_url,
          error_message: step.error || null
        });
      });
    }
    res.json({
      steps: stepResults,
      final_output: finalOutput ? finalOutput.output_url : null,
      total_steps: garmentUrls.length,
      successful_steps: stepResults.filter(r => r.output_url).length
    });
  } catch (err) {
    console.error("Chain error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tryon/status/:id", async (req, res) => {
  try {
    const predictionId = req.params.id;
    if (BACKEND_MODE === "runpod") {
      const response = await fetch(RUNPOD_BASE_URL + "/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + RUNPOD_API_KEY }
      });
      const data = await response.json();
      if (data.status === "COMPLETED") {
        res.json({ status: "completed", output: data.output?.image ? [data.output.image] : [] });
      } else if (data.status === "FAILED") {
        res.json({ status: "failed", error: data.output?.error || "Failed" });
      } else {
        res.json({ status: "processing" });
      }
    } else {
      const response = await fetch("https://api.fashn.ai/v1/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + process.env.FASHN_API_KEY }
      });
      const data = await response.json();
      res.json(data);
    }
  } catch (err) {
    console.error("Status error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tryon/generate-video", async (req, res) => {
  try {
    console.log("=== VIDEO GENERATION REQUEST ===");
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ error: "No image URL provided" });
    const shop = getShopFromRequest(req);
    if (shop) {
      const creditCheck = creditsSystem.checkAndUseCredit(shop, getRealIP(req), 3);
      if (!creditCheck.allowed) {
        return res.status(403).json({ error: "אין מספיק קרדיטים לסרטון (3 קרדיטים)" });
      }
    }
    console.log("Sending to FASHN Image-to-Video...");
    const response = await fetch("https://api.fashn.ai/v1/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.FASHN_API_KEY
      },
      body: JSON.stringify({
        model_name: "image-to-video",
        inputs: { image: image_url, duration: 5, resolution: "720p" }
      })
    });
    const data = await response.json();
    if (!data.id) return res.status(500).json({ error: data.error || "No prediction ID" });
    console.log("Video prediction ID:", data.id);
    res.json({ prediction_id: data.id });
  } catch (err) {
    console.error("Video generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tryon/video-status/:id", async (req, res) => {
  try {
    const statusRes = await fetch(`https://api.fashn.ai/v1/status/${req.params.id}`, {
      headers: { Authorization: `Bearer ${process.env.FASHN_API_KEY}` },
    });
    const data = await statusRes.json();
    if (data.status === "completed" && data.output) {
      const videoUrl = Array.isArray(data.output) ? data.output[0] : (typeof data.output === "string" ? data.output : data.output.video);
      res.json({ status: "completed", video_url: videoUrl });
    } else {
      res.json({ status: data.status || "processing", error: data.error });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tryon/video-proxy", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });
    const videoRes = await fetch(url);
    if (!videoRes.ok) return res.status(502).json({ error: "Failed to fetch video" });
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const buffer = await videoRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhooks/compliance", verifyShopifyWebhook, (req, res) => {
  console.log("Compliance webhook received:", JSON.stringify(req.body).substring(0, 200));
  res.status(200).json({ success: true });
});

app.post("/webhooks/app/uninstalled", verifyShopifyWebhook, (req, res) => {
  console.log("App uninstalled:", req.body?.shop_domain || "unknown");
  res.status(200).json({ success: true });
});

app.post("/webhooks/app/scopes_update", verifyShopifyWebhook, (req, res) => {
  console.log("Scopes update:", req.body?.shop_domain || "unknown");
  res.status(200).json({ success: true });
});

function handleCheckoutWebhook(req, res) {
  try {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const secret = process.env.SHOPIFY_API_SECRET || "";
    const rawBody = req.body;

    if (!hmacHeader || !secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (hash !== hmacHeader) {
      console.log("⚠️  [Webhook] Checkout HMAC mismatch - rejected");
      return res.status(401).json({ error: "Invalid HMAC" });
    }

    res.status(200).json({ success: true });

    const shopDomain = req.headers["x-shopify-shop-domain"] || "seven770.myshopify.com";
    let checkout;
    try {
      checkout = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      console.error("⚠️  [Webhook] Could not parse checkout body:", e.message);
      return;
    }

    setImmediate(async () => {
      try {
        const saved = await shopify.saveAbandonedCheckout(shopDomain, checkout);
        if (saved) {
          console.log(`🛒 [Webhook] Abandoned checkout saved: ${checkout.id} (${checkout.email || 'no email'}, ${checkout.total_price || '?'} ${checkout.currency || ''})`);
        }
      } catch (err) {
        console.error("⚠️  [Webhook] Failed to save checkout:", err.message);
      }
    });
  } catch (err) {
    console.error("Checkout webhook error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

app.post("/webhooks/checkouts/create", express.raw({ type: "application/json" }), handleCheckoutWebhook);
app.post("/webhooks/checkouts/update", express.raw({ type: "application/json" }), handleCheckoutWebhook);

function handleOrderWebhook(req, res) {
  try {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const secret = process.env.SHOPIFY_API_SECRET || "";
    const rawBody = req.body;
    if (!hmacHeader || !secret) return res.status(401).json({ error: "Unauthorized" });
    const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (hash !== hmacHeader) {
      console.log("⚠️  [Webhook] Order HMAC mismatch - rejected");
      return res.status(401).json({ error: "Invalid HMAC" });
    }
    res.status(200).json({ success: true });

    const shopDomain = req.headers["x-shopify-shop-domain"] || "seven770.myshopify.com";
    let order;
    try { order = JSON.parse(rawBody.toString("utf8")); } catch (e) { return; }

    setImmediate(async () => {
      try {
        // Use the centralized, guarded attribution path (attribution-engine) so a
        // single order can NEVER credit more than one action — even when the same
        // customer received two different coupons (email + WhatsApp) and used none.
        const r = await attributionEngine.attributeOrder(shopDomain, order);
        if (r && r.closed) {
          console.log(`💰 [Webhook] order credited via ${r.via} +${Math.round(r.amount || 0)}₪`);
          try {
            const push = require('./push-engine');
            if (push.isConfigured()) {
              const amt = Math.round(r.amount || 0).toLocaleString();
              await push.sendToShop(shopDomain, {
                title: '🎉 מכירה חדשה בזכות היועץ!',
                body: `לקוחה השלימה רכישה של ${amt}₪. היועץ סגר עוד עסקה.`,
                tag: 'conversion', url: '/chat'
              });
            }
          } catch (e) { /* never let push break attribution */ }
        }
      } catch (err) {
        console.error("⚠️  [Webhook] Order loop-close failed:", err.message);
      }
    });
  } catch (err) {
    console.error("Order webhook error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
app.post("/webhooks/orders/create", express.raw({ type: "application/json" }), handleOrderWebhook);

// === Register checkout webhooks with Shopify (TEMPORARY - call once) ===

// ======================
// ONE-TIME FIX: clean bad phones + backfill last_order_date
// Call once: /admin/fix-data?password=Ariel770%21
// ======================
app.get("/admin/fix-data", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = resolveShop(req) || DEFAULT_SHOP;
  try {
    const badPhones = await db.query(
      `UPDATE store_customers
       SET phone = NULL
       WHERE shop_domain = $1
         AND phone IS NOT NULL
         AND phone !~ '^0?5[0-9]{8}$'
         AND phone !~ '^972 ?5[0-9]{8}$'`,
      [shop]
    );
    const lod = await db.query(
      `UPDATE store_customers sc
       SET last_order_date = sub.last_order
       FROM (
         SELECT shopify_customer_id, MAX(ordered_at) AS last_order
         FROM store_orders
         WHERE shop_domain = $1 AND shopify_customer_id IS NOT NULL
         GROUP BY shopify_customer_id
       ) sub
       WHERE sc.shop_domain = $1
         AND sc.shopify_customer_id = sub.shopify_customer_id`,
      [shop]
    );
    res.json({
      ok: true,
      phones_cleaned: badPhones.rowCount,
      last_order_dates_filled: lod.rowCount,
      message: "הנתונים תוקנו"
    });
  } catch (err) {
    console.error("fix-data error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// MULTI-STORE onboarding (super-admin). Register a new store's custom-app token
// so the advisor can serve it. 770 stays env-based and is unaffected.
// Add:  /admin/add-store?password=...&shop=xxx.myshopify.com&token=shpat_...&advisor_password=...&name=...&public_domain=...
// List: /admin/list-stores?password=...
// ======================
app.get("/admin/add-store", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const { shop, token, advisor_password, name, public_domain } = req.query;
  if (!shop || !token) {
    return res.status(400).json({ ok: false, error: "חובה shop ו-token" });
  }
  try {
    const r = await shopify.upsertStore({
      shop_domain: shop,
      access_token: token,
      advisor_password: advisor_password || null,
      display_name: name || null,
      public_domain: public_domain || null
    });
    // Verify the token actually works against Shopify before declaring success.
    const verify = await shopify.verifyConnection(shop);
    res.json({
      ok: true,
      store: r.shop_domain,
      connection: verify.connected ? `מחובר: ${verify.shopName}` : `אזהרה: החיבור נכשל - ${verify.reason}`,
      note: "החנות נוספה. הרץ backfill עבורה כדי לטעון לקוחות/הזמנות."
    });
  } catch (err) {
    console.error("add-store error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// OAUTH INSTALL FLOW (one-click store connection)
// The merchant opens /auth?shop=xxx.myshopify.com, approves on Shopify,
// and Shopify redirects back to /auth/callback with a code we exchange for a
// permanent access token. The store is then saved and backfilled automatically.
//
// Uses its OWN app credentials (separate from TryFit's SHOPIFY_API_SECRET):
//   ADVISOR_SHOPIFY_KEY     = the Smart Advisor app's Client ID
//   ADVISOR_SHOPIFY_SECRET  = the Smart Advisor app's Client secret
// ============================================================
const ADVISOR_SHOPIFY_KEY = process.env.ADVISOR_SHOPIFY_KEY || "";
const ADVISOR_SHOPIFY_SECRET = process.env.ADVISOR_SHOPIFY_SECRET || "";
const OAUTH_SCOPES = "read_customers,write_customers,read_orders,read_products,read_inventory,read_checkouts,read_fulfillments,read_locations,read_price_rules,read_discounts,read_marketing_events,write_discounts,write_draft_orders";
const APP_BASE_URL = "https://tryfit-backend-production.up.railway.app";
// Short-lived state store for CSRF protection (state -> timestamp).
const oauthStates = new Map();
function cleanOldStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    const ts = (v && v.ts) ? v.ts : v;
    if (now - ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
}
function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop || "");
}

// Step 1: start install — redirect merchant to Shopify's consent screen.
app.get("/auth", (req, res) => {
  const shop = (req.query.shop || "").toLowerCase().trim();
  if (!isValidShopDomain(shop)) {
    return res.status(400).send("חסר או שגוי פרמטר shop. דוגמה: /auth?shop=your-store.myshopify.com");
  }
  if (!ADVISOR_SHOPIFY_KEY || !ADVISOR_SHOPIFY_SECRET) {
    return res.status(500).send("האפליקציה לא מוגדרת (חסרים ADVISOR_SHOPIFY_KEY/SECRET).");
  }
  cleanOldStates();
  const state = crypto.randomBytes(16).toString("hex");
  // Optionally let the operator preset the advisor login password via the install
  // link (?password=XXX). Stashed with the state and applied in the callback.
  // If omitted, a random one is generated.
  oauthStates.set(state, { ts: Date.now(), pw: (req.query.password || "").trim() || null });
  const redirectUri = `${APP_BASE_URL}/auth/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(ADVISOR_SHOPIFY_KEY)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;
  res.redirect(installUrl);
});

// Verify the HMAC Shopify appends to the callback query (security).
function verifyOAuthHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", ADVISOR_SHOPIFY_SECRET).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(hmac, "hex"));
  } catch (e) { return false; }
}

// Step 2: callback — exchange code for a token, save the store, start backfill.
app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!isValidShopDomain((shop || "").toLowerCase())) {
      return res.status(400).send("shop לא תקין.");
    }
    if (!state || !oauthStates.has(state)) {
      return res.status(403).send("state לא תקין (ייתכן שפג תוקף). נסה להתקין שוב.");
    }
    const stateData = oauthStates.get(state);
    oauthStates.delete(state);
    const presetPassword = (stateData && stateData.pw) ? stateData.pw : null;
    if (!verifyOAuthHmac(req.query)) {
      return res.status(403).send("אימות HMAC נכשל.");
    }
    const shopDomain = shop.toLowerCase().trim();

    // Exchange the temporary code for a permanent access token.
    const tokenRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: ADVISOR_SHOPIFY_KEY,
        client_secret: ADVISOR_SHOPIFY_SECRET,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[OAuth] token exchange failed:", JSON.stringify(tokenData).slice(0, 200));
      return res.status(400).send("קבלת ה-token נכשלה. נסה שוב.");
    }

    // Use the operator-chosen password if provided in the install link, else random.
    const advisorPassword = presetPassword || crypto.randomBytes(5).toString("hex");
    const displayName = shopDomain.replace(".myshopify.com", "");

    await shopify.upsertStore({
      shop_domain: shopDomain,
      access_token: tokenData.access_token,
      advisor_password: advisorPassword,
      display_name: displayName,
      public_domain: null
    });

    // Register webhooks (checkouts + orders) for this shop.
    try {
      const topics = [
        { topic: "checkouts/create", address: `${APP_BASE_URL}/webhooks/checkouts/create` },
        { topic: "checkouts/update", address: `${APP_BASE_URL}/webhooks/checkouts/update` },
        { topic: "orders/create", address: `${APP_BASE_URL}/webhooks/orders/create` }
      ];
      for (const t of topics) {
        await fetch(`https://${shopDomain}/admin/api/2026-01/webhooks.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": tokenData.access_token, "Content-Type": "application/json" },
          body: JSON.stringify({ webhook: { topic: t.topic, address: t.address, format: "json" } })
        }).catch(() => {});
      }
    } catch (e) { console.error("[OAuth] webhook registration:", e.message); }

    // Kick off backfill in the background (OAuth-connected = enabled by definition).
    backfillStatus[shopDomain] = { current_phase: "starting", started_at: new Date().toISOString() };
    setImmediate(async () => {
      try {
        const result = await shopify.backfillEntireShop(shopDomain, (progress) => {
          backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], current_phase: progress.phase, ...(progress.stats || {}) };
        });
        backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], ...result };
      } catch (err) {
        backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], success: false, fatal_error: err.message };
      }
    });

    // Success page for the merchant.
    res.send(`<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>החיבור הצליח</title></head>
      <body style="font-family:Arial,sans-serif;background:#f5f6f8;margin:0;padding:40px 20px;text-align:center;">
        <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 28px;box-shadow:0 4px 20px rgba(0,0,0,.08);">
          <div style="font-size:48px;">✅</div>
          <h1 style="font-size:22px;color:#111;">החנות חוברה בהצלחה!</h1>
          <p style="color:#444;line-height:1.7;">היועץ החכם מתחיל עכשיו לטעון את הנתונים שלך (לקוחות והזמנות). זה ייקח כמה דקות.</p>
          <p style="color:#444;line-height:1.7;">סיסמת הכניסה שלך ליועץ:</p>
          <div style="font-size:20px;font-weight:800;letter-spacing:1px;background:#f0f4ff;color:#0a6fe0;padding:12px;border-radius:10px;">${advisorPassword}</div>
          <p style="color:#888;font-size:13px;margin-top:18px;">שמור את הסיסמה הזו. אפשר לשנות אותה איתנו בכל עת.</p>
        </div>
      </body></html>`);
  } catch (err) {
    console.error("[OAuth] callback error:", err);
    res.status(500).send("שגיאה בחיבור. נסה שוב או פנה אלינו.");
  }
});

app.get("/admin/list-stores", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  res.json({ ok: true, stores: shopify.listStores() });
});

// ======================
// ATTRIBUTION: pull recent orders and close advisor actions (HMAC-independent).
// Run manually now to close existing orders; also runs automatically every 5 min.
// Call: /admin/run-attribution?password=...
// ======================
app.get("/admin/run-attribution", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  try {
    const result = await attributionEngine.runAttribution(resolveShop(req) || DEFAULT_SHOP);
    res.json(result);
  } catch (err) {
    console.error("run-attribution error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// FIX: reverse a specific WRONG attribution (order placed BEFORE the outreach).
// Preview:  /admin/unattribute?password=...&amount=9428.4&name=אנה רזניק
// Execute:  /admin/unattribute?password=...&amount=9428.4&name=אנה רזניק&confirm=yes
// Without confirm=yes it only SHOWS what would be reversed (safe).
// ======================
app.get("/admin/unattribute", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = resolveShop(req) || DEFAULT_SHOP;
  const amount = req.query.amount ? parseFloat(req.query.amount) : null;
  const name = (req.query.name || "").trim();
  const doConfirm = req.query.confirm === "yes";
  if (!amount && !name) {
    return res.status(400).json({ ok: false, error: "ציין amount ו/או name" });
  }
  try {
    // Find matching converted actions. Match on amount (within 1₪) AND/OR the
    // customer name appearing either in details.customer_name or in the title
    // (personalized_cart titles include the customer name).
    const matches = await db.query(
      `SELECT id, action_type, target_email, target_phone, coupon_code,
              attributed_revenue, outcome, created_at, closed_at,
              details->>'customer_name' AS detail_name,
              details->>'title' AS detail_title, details
       FROM advisor_actions
       WHERE shop_domain = $1
         AND outcome = 'converted'
         AND ($2::numeric IS NULL OR ABS(attributed_revenue - $2::numeric) < 1)
         AND ($3::text = '' OR
              lower(coalesce(details->>'customer_name','')) LIKE '%' || lower($3) || '%')
       ORDER BY closed_at DESC NULLS LAST, created_at DESC`,
      [shop, amount, name]
    );

    if (matches.rows.length === 0) {
      return res.json({ ok: true, found: 0,
        message: "לא נמצאה זקיפה תואמת. נסה רק לפי amount (בלי name), כי ייתכן שהשם לא נשמר בזקיפות ישנות." });
    }

    const preview = matches.rows.map(r => ({
      action_id: r.id,
      type: r.action_type,
      amount: Math.round(parseFloat(r.attributed_revenue || 0)),
      coupon: r.coupon_code,
      customer_name: r.detail_name || null,
      target: r.target_email || r.target_phone || null,
      created_at: r.created_at,
      closed_at: r.closed_at
    }));

    if (!doConfirm) {
      return res.json({
        ok: true,
        preview_only: true,
        found: preview.length,
        will_reverse: preview,
        total_to_remove: preview.reduce((s, p) => s + p.amount, 0),
        note: "זו תצוגה מקדימה בלבד. כדי לבצע בפועל, הוסף &confirm=yes ל-URL."
      });
    }

    // Execute: reverse them back to pending and zero the revenue.
    const ids = matches.rows.map(r => r.id);
    const upd = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'pending', attributed_revenue = 0, closed_at = NULL,
           details = details || '{"attribution":"reversed_wrong_date"}'::jsonb
       WHERE id = ANY($1)
       RETURNING id`,
      [ids]
    );
    res.json({
      ok: true,
      reversed: upd.rows.length,
      removed_amount: preview.reduce((s, p) => s + p.amount, 0),
      ids: ids,
      message: "הזקיפה השגויה בוטלה. המונה יתעדכן."
    });
  } catch (err) {
    console.error("unattribute error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/setup-agent-tables", async (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS agent_plans (
      id BIGSERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) NOT NULL,
      plan_date DATE NOT NULL,
      status VARCHAR(40) DEFAULT 'proposed',
      summary TEXT,
      projected_revenue NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      approved_at TIMESTAMP,
      finished_at TIMESTAMP
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS agent_tasks (
      id BIGSERIAL PRIMARY KEY,
      plan_id BIGINT NOT NULL,
      shop_domain VARCHAR(255) NOT NULL,
      priority INTEGER DEFAULT 1,
      move_type VARCHAR(60) NOT NULL,
      title TEXT,
      segment VARCHAR(60),
      percentage INTEGER DEFAULT 10,
      projected_revenue NUMERIC(12,2) DEFAULT 0,
      est_customers INTEGER DEFAULT 0,
      params JSONB DEFAULT '{}'::jsonb,
      selected BOOLEAN DEFAULT TRUE,
      status VARCHAR(40) DEFAULT 'pending',
      result JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      finished_at TIMESTAMP
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_plans_shop ON agent_plans(shop_domain, plan_date DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_plan ON agent_tasks(plan_id, priority)`);

    const check = await db.query(`SELECT
      (SELECT COUNT(*) FROM agent_plans)::int AS plans,
      (SELECT COUNT(*) FROM agent_tasks)::int AS tasks`);
    res.json({ ok: true, message: "טבלאות הסוכן נוצרו בהצלחה", verification: check.rows[0] });
  } catch (err) {
    console.error("Setup agent tables error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/register-webhooks", async (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = resolveShop(req) || DEFAULT_SHOP;
  const token = process.env.SHOPIFY_770_TOKEN;
  if (!token) return res.json({ ok: false, reason: "no token" });

  const baseUrl = "https://tryfit-backend-production.up.railway.app";
  const topics = [
    { topic: "checkouts/create", address: `${baseUrl}/webhooks/checkouts/create` },
    { topic: "checkouts/update", address: `${baseUrl}/webhooks/checkouts/update` },
    { topic: "orders/create", address: `${baseUrl}/webhooks/orders/create` }
  ];

  const results = [];
  for (const t of topics) {
    try {
      const r = await fetch(`https://${shop}/admin/api/2026-01/webhooks.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ webhook: { topic: t.topic, address: t.address, format: "json" } })
      });
      const body = await r.json();
      results.push({
        topic: t.topic,
        status: r.status,
        result: r.status === 201 ? "created" : (body.errors || body)
      });
    } catch (err) {
      results.push({ topic: t.topic, error: err.message });
    }
  }

  let existing = [];
  try {
    const lr = await fetch(`https://${shop}/admin/api/2026-01/webhooks.json`, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }
    });
    const lb = await lr.json();
    existing = (lb.webhooks || []).map(w => ({ id: w.id, topic: w.topic, address: w.address }));
  } catch (e) {}

  res.json({ ok: true, registered: results, all_webhooks: existing });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);
  console.log("Backend mode:", BACKEND_MODE.toUpperCase());
  if (BACKEND_MODE === "fashn") {
    console.log("FASHN API Key loaded:", process.env.FASHN_API_KEY ? "YES" : "NO");
  } else {
    console.log("RunPod Endpoint:", RUNPOD_ENDPOINT_ID);
  }
  console.log("Credits system: ACTIVE");
  console.log("Admin dashboard: /admin");

  console.log("\n--- Data Platform Initialization ---");
  console.log("Data collection enabled for:", featureFlags.getDataCollectionShops().join(", "));
  if (process.env.DATABASE_URL) {
    const connected = await db.testConnection();
    if (connected) {
      await db.initializeSchema();
      console.log("Data platform: READY");
      // Load any DB-backed advisor stores into the in-memory token cache.
      // (770 stays env-based; this just adds support for new shops.)
      await shopify.loadStores();
      // WhatsApp credits tables (balance + ledger per shop).
      await creditsEngine.ensureCreditsTables();
      // WhatsApp approved-template registry.
      await waTemplates.ensureTemplatesTable();
      const enabledShops = featureFlags.getDataCollectionShops();
      for (const shop of enabledShops) {
        if (shopify.hasTokenForShop(shop)) {
          const verify = await shopify.verifyConnection(shop);
          if (verify.connected) {
            console.log(`✅ Shopify API: Connected to ${shop} (${verify.shopName})`);
          } else {
            console.log(`⚠️  Shopify API: Failed for ${shop} - ${verify.reason}`);
          }
        } else {
          console.log(`⚠️  Shopify API: No token configured for ${shop}`);
        }
      }
    } else {
      console.log("⚠️  Data platform: DISABLED (DB connection failed, TryFit continues working normally)");
    }
  } else {
    console.log("⚠️  DATABASE_URL not configured, data platform disabled");
  }

  if (process.env.DATABASE_URL) {
    const runProductSync = async () => {
      for (const shop of allActiveShops()) {
        if (!shopify.hasTokenForShop(shop)) continue;
        try {
          const r = await shopify.syncProducts(shop);
          console.log(`🔄 [Products] Scheduled sync ${shop}:`, JSON.stringify(r));
        } catch (e) {
          console.error(`⚠️  [Products] Scheduled sync failed ${shop}:`, e.message);
        }
      }
    };
    setTimeout(runProductSync, 30000);
    setInterval(runProductSync, 6 * 60 * 60 * 1000);
    console.log("🔄 Product catalog sync scheduled (every 6h, all stores)");
  }

  if (process.env.DATABASE_URL) {
    let dataSyncRunning = false;
    const runDataSync = async () => {
      if (dataSyncRunning) {
        console.log("🔄 [Data] Sync already running, skipping this cycle");
        return;
      }
      dataSyncRunning = true;
      try {
        for (const DATA_SYNC_SHOP of allActiveShops()) {
          if (!shopify.hasTokenForShop(DATA_SYNC_SHOP)) continue;
          if (!featureFlags.isDataCollectionEnabled(DATA_SYNC_SHOP)) continue;
          try {
            const r = await shopify.backfillEntireShop(DATA_SYNC_SHOP);
            console.log(`🔄 [Data] Scheduled sync ${DATA_SYNC_SHOP}:`,
              `customers ${r.customers_saved}/${r.customers_fetched},`,
              `orders ${r.orders_saved}/${r.orders_fetched} (${r.duration_seconds}s)`);

            try {
              const upd = await db.query(`
                UPDATE store_customers sc
                SET last_order_date = sub.last_order
                FROM (
                  SELECT shopify_customer_id, MAX(ordered_at) AS last_order
                  FROM store_orders
                  WHERE shop_domain = $1 AND shopify_customer_id IS NOT NULL
                  GROUP BY shopify_customer_id
                ) sub
                WHERE sc.shop_domain = $1
                  AND sc.shopify_customer_id = sub.shopify_customer_id
              `, [DATA_SYNC_SHOP]);
              console.log("🔄 [Data] last_order_date refreshed for", upd.rowCount, "customers");
            } catch (e) {
              console.error("⚠️  [Data] last_order_date refresh failed:", e.message);
            }

            try {
              const ac = await shopify.syncAbandonedCheckouts(DATA_SYNC_SHOP);
              if (ac.success) {
                console.log("🔄 [Data] Abandoned checkouts:", `${ac.saved}/${ac.fetched} (${ac.duration_seconds}s)`);
              } else {
                console.log("🔄 [Data] Abandoned checkouts sync skipped:", ac.reason || ac.error);
              }
            } catch (e) {
              console.error("⚠️  [Data] Abandoned checkouts sync failed:", e.message);
            }
          } catch (e) {
            console.error(`⚠️  [Data] Scheduled sync failed ${DATA_SYNC_SHOP}:`, e.message);
          }
        }
      } finally {
        dataSyncRunning = false;
      }
    };
    setTimeout(runDataSync, 90000);
    setInterval(runDataSync, 3 * 60 * 60 * 1000);
    console.log("🔄 Orders + customers sync scheduled (every 3h, all stores)");
  }

  let lastReport09 = null, lastReport21 = null;
  setInterval(async () => {
    try {
      const israelNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
      const hour = israelNow.getHours();
      const dateStr = israelNow.toISOString().slice(0, 10);

      if (hour === 9 && lastReport09 !== dateStr) {
        lastReport09 = dateStr;
        for (const shop of allActiveShops()) {
          if (!shopify.hasTokenForShop(shop)) continue;
          const summary = await dailySummary.getDailySummary(shop);
          await db.query(
            `INSERT INTO advisor_actions (shop_domain, action_type, details)
             VALUES ($1, 'morning_report', $2)`,
            [shop, JSON.stringify({ report: summary, date: dateStr, kind: 'overnight' })]
          ).catch(e => console.error("morning report log:", e.message));
        }
        console.log(`🌅 [Morning report] generated for ${dateStr} (09:00 Israel)`);
      }

      if (hour === 21 && lastReport21 !== dateStr) {
        lastReport21 = dateStr;
        for (const shop of allActiveShops()) {
          if (!shopify.hasTokenForShop(shop)) continue;
          const summary = await dailySummary.getDailySummary(shop);
          await db.query(
            `INSERT INTO advisor_actions (shop_domain, action_type, details)
             VALUES ($1, 'daily_report', $2)`,
            [shop, JSON.stringify({ report: summary, date: dateStr, kind: 'end_of_day' })]
          ).catch(e => console.error("daily report log:", e.message));
        }
        console.log(`📋 [Daily report] generated for ${dateStr} (21:00 Israel)`);
      }
    } catch (e) {
      console.error("report scheduler:", e.message);
    }
  }, 60 * 1000);
  console.log("📋 Reports scheduled (09:00 overnight + 21:00 end-of-day, Israel time)");

  // ========== Attribution scan (every 5 minutes) ==========
  // Pulls recent orders from Shopify and closes advisor actions. Independent of
  // the orders/create webhook, so it works even if webhook HMAC verification fails.
  if (process.env.DATABASE_URL) {
    let attrRunning = false;
    const runAttr = async () => {
      if (attrRunning) return;
      attrRunning = true;
      try {
        for (const shop of allActiveShops()) {
          if (!shopify.hasTokenForShop(shop)) continue;
          await attributionEngine.runAttribution(shop);
        }
      } catch (e) {
        console.error("⚠️  [Attribution] scheduled run failed:", e.message);
      } finally {
        attrRunning = false;
      }
    };
    setTimeout(runAttr, 120000); // first run 2 min after startup
    setInterval(runAttr, 5 * 60 * 1000); // then every 5 minutes
    console.log("🔁 Attribution scan scheduled (every 5 min, all stores)");
  }

  agentEngine.resumeInterruptedPlans();

  console.log("---\n");
});