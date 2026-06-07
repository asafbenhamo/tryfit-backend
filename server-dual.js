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

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"]
}));
// Global JSON parser — but SKIP checkout webhook paths, which need the raw
// body for HMAC verification (handled by express.raw on those routes).
app.use((req, res, next) => {
  if (req.path === "/webhooks/checkouts/create" || req.path === "/webhooks/checkouts/update" || req.path === "/webhooks/orders/create") {
    return next();
  }
  return express.json()(req, res, next);
});

// ======================
// BACKEND MODE: "fashn" or "runpod"
// ======================
const BACKEND_MODE = process.env.BACKEND_MODE || "fashn";

// RunPod config
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "rpa_94NQI07B7J69J3A25963D9RH0R0FSILF9DFEPEAEwc2qnz";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "4nxbizcdhfxobd";
const RUNPOD_BASE_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

// === RATE LIMIT ===
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

// === DATA PLATFORM: Save try-on event ===
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

// === DATA PLATFORM: Handle TryFit consent + customer backfill ===
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

// === WEBHOOK HMAC VERIFICATION ===
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

// ======================
// STATIC PAGES
// ======================
app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: BACKEND_MODE });
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

// ======================
// ADMIN + CREDITS
// ======================
app.use("/admin", adminRouter);

app.get("/api/credits/:shop", (req, res) => {
  res.json(creditsSystem.getStoreCredits(req.params.shop));
});

// ======================
// DATA PLATFORM: Consent endpoint
// ======================
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

// ======================
// DATA PLATFORM: Admin backfill endpoint
// ======================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tryfit2026";
const backfillStatus = {};

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
    if (password !== ADMIN_PASSWORD) {
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
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = req.query.shop || 'seven770.myshopify.com';
  res.json({ shop, status: backfillStatus[shop] || null });
});

// ======================
// DATA PLATFORM: Test tools endpoint (TEMPORARY)
// ======================
const aiTools = require("./ai-tools");

app.get("/admin/test-tools", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה - הוסף ?password=tryfit2026 ל-URL" });
  }
  const shop = "seven770.myshopify.com";
  const results = {};
  try {
    results.getTopCustomers      = await aiTools.getTopCustomers(shop, { limit: 3 });
    results.getDormantCustomers  = await aiTools.getDormantCustomers(shop, { limit: 3, daysInactive: 30 });
    results.getNeverPurchased    = await aiTools.getNeverPurchased(shop, { limit: 3 });
    results.getRepeatCustomers   = await aiTools.getRepeatCustomers(shop, { limit: 3 });
    results.searchCustomers      = await aiTools.searchCustomers(shop, { query: "a" });
    results.getTopProducts       = await aiTools.getTopProducts(shop, { limit: 5 });
    results.getRevenueStats      = await aiTools.getRevenueStats(shop, { days: 60 });
    results.getTryFitInsights    = await aiTools.getTryFitInsights(shop, { days: 30 });
    const top = results.getTopCustomers;
    const sampleEmail = top.ok && top.customers && top.customers[0] ? top.customers[0].email : null;
    if (sampleEmail) {
      results._sample_email_used = sampleEmail;
      results.getCustomerProfile       = await aiTools.getCustomerProfile(shop, { email: sampleEmail });
      results.generateWhatsAppMessage  = await aiTools.generateWhatsAppMessage(shop, { email: sampleEmail, intent: "comeback" });
    } else {
      results.getCustomerProfile = { skipped: "no sample email available" };
      results.generateWhatsAppMessage = { skipped: "no sample email available" };
    }
    res.json({ ok: true, shop, tested_at: new Date().toISOString(), results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, partial_results: results });
  }
});

// ======================
// DATA PLATFORM: Test brain endpoint (TEMPORARY)
// ======================
const aiBrain = require("./ai-brain");

app.get("/admin/test-brain", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה - הוסף ?password=tryfit2026 ל-URL" });
  }
  const question = req.query.q;
  if (!question) {
    return res.status(400).json({ error: "חסרה שאלה - הוסף &q=השאלה שלך ל-URL" });
  }
  const shop = "seven770.myshopify.com";
  const shopName = "770";
  try {
    const start = Date.now();
    const result = await aiBrain.askBrain(shop, shopName, question);
    const duration = Date.now() - start;
    res.json({
      ok: result.ok,
      question,
      answer: result.answer,
      tools_used: result.toolsUsed,
      duration_seconds: (duration / 1000).toFixed(1),
      model: aiBrain.MODEL
    });
  } catch (err) {
    console.error("test-brain error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// AI CHAT: Real chat endpoint
// ======================
app.post("/api/chat", express.json(), async (req, res) => {
  try {
    const { message, history, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "הודעה ריקה" });
    }
    const shop = "seven770.myshopify.com";
    const shopName = "770";
    const priorMessages = Array.isArray(history) ? history : [];
    const result = await aiBrain.askBrain(shop, shopName, message, priorMessages);
    const cleanHistory = [
      ...priorMessages,
      { role: "user", content: message },
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

// ======================
// AI CHAT: Serve the chat UI page
// ======================
app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/chat.html");
});

// ======================
// DAILY SUMMARY: the advisor's morning briefing (principle 5)
// ======================
const dailySummary = require("./daily-summary");

app.get("/api/daily-summary", async (req, res) => {
  try {
    if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = "seven770.myshopify.com";
    const result = await dailySummary.getDailySummary(shop);
    res.json(result);
  } catch (err) {
    console.error("Daily summary error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// INSIGHTS: Proactive opportunities (shown on chat open)
// ======================
const insightsEngine = require("./insights-engine");

app.get("/api/insights", async (req, res) => {
  try {
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
    const result = await insightsEngine.getInsights(shop);
    res.json(result);
  } catch (err) {
    console.error("Insights endpoint error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// TEMPORARY: Test email sending
// ======================
app.get("/admin/test-email", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const to = req.query.to;
  if (!to) {
    return res.json({ ok: false, error: "הוסף &to=your@email.com ל-URL" });
  }
  if (!mailer.isConfigured()) {
    return res.json({ ok: false, error: "RESEND_API_KEY not configured in Railway" });
  }
  try {
    const html = mailer.buildHtmlEmail(
      "שלום! 👋\n\nזו הודעת בדיקה מהיועץ החכם של 770.\n\nאם קיבלת את המייל הזה - מערכת השליחה עובדת מצוין!",
      { cta_url: "https://sevenseventy.co.il", cta_label: "לחנות שלנו", brand: "770" }
    );
    const result = await mailer.sendEmail({
      to,
      subject: "בדיקה - היועץ החכם של 770",
      html,
      text: "הודעת בדיקה מהיועץ החכם של 770. המערכת עובדת!"
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// ACTIONS: Create a real discount coupon (merchant-approved)
// ======================
app.post("/api/coupon/create", express.json(), async (req, res) => {
  try {
    const { password, percentage, code, days_valid, title, usage_limit } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
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

// ======================
// ACTIONS: Send an email (merchant-approved)
// ======================
const mailer = require("./mailer");
const compliance = require("./compliance");

app.post("/api/send-email", express.json(), async (req, res) => {
  try {
    const { password, to, phone, subject, body, cta_url, cta_label, ignore_hours } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    if (!mailer.isConfigured()) {
      return res.status(400).json({ ok: false, error: "שירות המייל לא מוגדר עדיין (חסר RESEND_API_KEY)" });
    }
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: "חסר נמען / נושא / תוכן" });
    }

    const shop = "seven770.myshopify.com";
    // SAFETY GATE: working hours + opt-out (legal). Manual sends can pass ignore_hours.
    const gate = await compliance.canContactCustomer(shop, { email: to, phone }, { ignoreHours: !!ignore_hours });
    if (!gate.allowed) {
      return res.status(200).json({ ok: false, blocked: true, reason: gate.reason, detail: gate.detail });
    }

    const html = mailer.buildHtmlEmail(body, { cta_url, cta_label, brand: "770", to });
    const result = await mailer.sendEmail({ to, subject, html, text: body });
    if (!result.ok) {
      return res.status(400).json(result);
    }

    // Log the action (for the daily summary + revenue attribution later)
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

// ======================
// COMPLIANCE: opt-out management + working-hours status
// ======================
app.post("/api/optout/add", express.json(), async (req, res) => {
  try {
    const { password, email, phone, reason } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
    const result = await compliance.addOptOut("seven770.myshopify.com", { email, phone, reason });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public unsubscribe link (no password - reached from email footer)
app.get("/unsubscribe", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Missing email");
  await compliance.addOptOut("seven770.myshopify.com", { email, reason: "email_link" });
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
    <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#333}</style></head>
    <body><h2>הוסרת מרשימת התפוצה</h2><p>לא תקבל/י יותר הודעות שיווקיות. תודה.</p></body></html>`);
});

app.get("/api/working-hours", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
  res.json(compliance.workingHoursStatus());
});

// ======================
// STATS: how much money the advisor has made (live counter)
// Only counts CONVERTED actions - credit only for what the advisor truly closed.
// ======================
app.get("/api/advisor-stats", async (req, res) => {
  try {
    if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = "seven770.myshopify.com";
    const r = await db.query(
      `SELECT
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'), 0)::numeric(12,2) AS total_revenue,
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
      conversions: row.conversions || 0,
      total_actions: row.total_actions || 0,
      pending: row.pending || 0
    });
  } catch (err) {
    console.error("Advisor stats error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// ACTIONS: Execute a full advisor action plan (coupon + message), merchant-approved.
// This is the closed loop: create coupon -> send via email (auto) or return
// WhatsApp link -> log the action. Channel priority: WhatsApp (if phone) else email.
// ======================
app.post("/api/action/execute", express.json(), async (req, res) => {
  try {
    const {
      password, action_type,
      email, phone, customer_name,
      create_coupon, coupon_percentage, coupon_code, coupon_days,
      message_subject, message_body, cta_url, cta_label
    } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = "seven770.myshopify.com";
    const result = { ok: true, steps: {} };

    // --- Step 1: create coupon if requested ---
    let couponCode = null;
    if (create_coupon) {
      // Ensure a personalized, unique, traceable code.
      // If the AI didn't supply one (or supplied a generic one), build it from
      // the customer name + percentage + a short random suffix.
      const GENERIC = ["SALE","DISCOUNT","COUPON","SAVE","PROMO","CODE"];
      let finalCode = (coupon_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const isGeneric = !finalCode || GENERIC.includes(finalCode);
      if (isGeneric) {
        // transliterate-ish: keep ASCII letters from name, else fallback
        let namePart = "";
        if (customer_name) {
          namePart = customer_name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8);
        }
        if (!namePart && email) namePart = email.split("@")[0].replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 8);
        if (!namePart) namePart = "VIP";
        const pct = coupon_percentage || 10;
        const suffix = Math.floor(Math.random() * 900 + 100); // 3 digits, keeps it unique
        finalCode = `${namePart}${pct}${suffix}`;
      }
      const c = await shopify.createDiscountCode(shop, {
        percentage: coupon_percentage || 10,
        code: finalCode,
        days_valid: coupon_days || 30,
        title: `יועץ: ${action_type || 'campaign'} - ${customer_name || email || ''}`
      });
      if (!c.ok) {
        result.steps.coupon = { ok: false, error: c.error, needs_scope: c.needs_scope };
        // Coupon failed - abort before sending (don't send a message promising a broken code)
        return res.status(400).json({ ok: false, error: "יצירת הקופון נכשלה: " + c.error, steps: result.steps });
      }
      couponCode = c.code;
      result.steps.coupon = { ok: true, code: c.code, percentage: c.percentage, ends_at: c.ends_at };
    }

    // Build final message body (inject coupon code if created)
    let finalBody = message_body || "";
    if (couponCode && finalBody.includes("{COUPON}")) {
      finalBody = finalBody.replace(/\{COUPON\}/g, couponCode);
    } else if (couponCode && !finalBody.includes(couponCode)) {
      finalBody += `\n\nקוד הקופון שלך: ${couponCode}`;
    }

    // --- Step 2: choose channel. WhatsApp first (if phone), else email ---
    const hasPhone = phone && String(phone).trim().length >= 8;

    if (hasPhone) {
      // WhatsApp: we can't auto-send without Business API. Return a ready wa.me link.
      // Still check opt-out (legal) before offering to contact.
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
        [shop, action_type || 'whatsapp_prepared', email || null, phone, JSON.stringify({ channel: 'whatsapp', subject: message_subject }), couponCode]
      ).catch(e => console.error("log:", e.message));

    } else if (email) {
      // Email: full auto-send through the safety gate (hours + opt-out)
      const gate = await compliance.canContactCustomer(shop, { email, phone });
      if (!gate.allowed) {
        result.steps.message = { channel: "email", ok: false, blocked: true, reason: gate.reason, detail: gate.detail };
        return res.json({ ok: false, blocked: true, reason: gate.reason, detail: gate.detail, steps: result.steps });
      }
      const html = mailer.buildHtmlEmail(finalBody, { cta_url, cta_label, brand: "770", to: email });
      const sent = await mailer.sendEmail({ to: email, subject: message_subject || "הודעה מ-770", html, text: finalBody });
      if (!sent.ok) {
        result.steps.message = { channel: "email", ok: false, error: sent.error };
        return res.status(400).json({ ok: false, error: "שליחת המייל נכשלה: " + sent.error, steps: result.steps });
      }
      result.steps.message = { channel: "email", ok: true, id: sent.id };

      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, action_type || 'email_sent', email, phone || null, JSON.stringify({ channel: 'email', subject: message_subject }), couponCode]
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

// ======================
// ACTIONS: Build a personalized cart (draft order) + send payment link.
// The aggressive move: advisor pre-builds a cart for a customer and sends a
// direct pay link. Channel priority: WhatsApp (if phone) else email.
// ======================
app.post("/api/action/build-cart", express.json(), async (req, res) => {
  try {
    const {
      password, email, phone, customer_name,
      items, discount_percentage,
      message_subject, message_body
    } = req.body;

    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = "seven770.myshopify.com";

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "אין פריטים לעגלה" });
    }

    // Opt-out check (legal) before building/sending
    if (await compliance.isOptedOut(shop, { email, phone })) {
      return res.json({ ok: false, blocked: true, reason: "opted_out",
        detail: "הלקוחה ביקשה לא לקבל הודעות. לא ניתן לפנות אליה." });
    }

    // 1. Create the draft order
    const draft = await shopify.createDraftOrder(shop, {
      items, email: email || null,
      discount_percentage: discount_percentage || null,
      note: `עגלה מותאמת ל${customer_name || 'לקוחה'} - הוכן על ידי היועץ`
    });
    if (!draft.ok) {
      return res.status(400).json({ ok: false, error: "בניית העגלה נכשלה: " + draft.error, needs_scope: draft.needs_scope });
    }

    const payUrl = draft.invoice_url;
    let finalBody = (message_body || "") + `\n\nלחצי כאן לתשלום מהיר ומאובטח:\n${payUrl}`;

    const result = { ok: true, steps: { cart: { ok: true, total: draft.total, pay_url: payUrl } } };

    // 2. Send via WhatsApp (if phone) else email
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
        cta_url: payUrl, cta_label: "לתשלום מהיר", brand: "770", to: email
      });
      const sent = await mailer.sendEmail({ to: email, subject: message_subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody });
      if (!sent.ok) return res.status(400).json({ ok: false, error: "שליחת המייל נכשלה: " + sent.error });
      result.steps.message = { channel: "email", ok: true, id: sent.id };
    } else {
      return res.status(400).json({ ok: false, error: "אין דרך ליצור קשר" });
    }

    // 3. Log
    await db.query(
      `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details)
       VALUES ($1, 'personalized_cart', $2, $3, $4)`,
      [shop, email || null, phone || null, JSON.stringify({ draft_order_id: draft.draft_order_id, total: draft.total })]
    ).catch(e => console.error("log:", e.message));

    res.json(result);
  } catch (err) {
    console.error("Build cart error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/icon-192.png", (req, res) => {
  res.sendFile(__dirname + "/icon-192.png");
});
app.get("/icon-512.png", (req, res) => {
  res.sendFile(__dirname + "/icon-512.png");
});
app.get("/apple-touch-icon.png", (req, res) => {
  res.sendFile(__dirname + "/apple-touch-icon.png");
});

// ======================
// CHAT HISTORY: Persistent conversations (DB-backed)
// ======================
app.post("/api/chat/save", express.json(), async (req, res) => {
  try {
    const { id, title, messages, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
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
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
    const result = await db.query(
      `SELECT id, title, updated_at
       FROM chat_conversations
       WHERE shop_domain = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
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
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
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
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "גישה נדחתה" });
    }
    const shop = "seven770.myshopify.com";
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

// ======================
// PRODUCTS: Manual sync trigger (TEMPORARY)
// ======================
app.get("/admin/sync-products", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה - הוסף ?password=tryfit2026 ל-URL" });
  }
  try {
    const result = await shopify.syncProducts("seven770.myshopify.com");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// TEMPORARY: Manual abandoned-checkout sync trigger
// ======================
app.get("/admin/sync-checkouts", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  try {
    const result = await shopify.syncAbandonedCheckouts("seven770.myshopify.com");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// ======================
// TEMPORARY: Diagnose checkout fetch limits
// ======================
app.get("/admin/diagnose-checkouts", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = "seven770.myshopify.com";
  const token = process.env.SHOPIFY_770_TOKEN;
  if (!token) return res.json({ ok: false, reason: "no token" });

  const ver = "2026-01";
  const base = `https://${shop}/admin/api/${ver}`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const out = {};

  async function tryUrl(label, endpoint) {
    try {
      const r = await fetch(`${base}/${endpoint}`, { headers });
      const status = r.status;
      let body; try { body = await r.json(); } catch(e){ body = {}; }
      out[label] = {
        status,
        endpoint,
        count: body.count !== undefined ? body.count : (body.checkouts ? body.checkouts.length : null),
        link_header: r.headers.get('Link') || r.headers.get('link') || null
      };
    } catch (e) {
      out[label] = { error: e.message, endpoint };
    }
  }

  await tryUrl("count_default", "checkouts/count.json");
  await tryUrl("count_since_2020", "checkouts/count.json?created_at_min=2020-01-01");
  await tryUrl("page_since_2020", "checkouts.json?limit=250&created_at_min=2020-01-01");

  try {
    const range = await db.query(
      `SELECT COUNT(*)::int AS in_db,
              MIN(shopify_created_at) AS oldest,
              MAX(shopify_created_at) AS newest
       FROM abandoned_checkouts WHERE shop_domain = $1`,
      [shop]
    );
    out.db_state = range.rows[0];
  } catch (e) {
    out.db_state = { error: e.message };
  }

  res.json({ ok: true, diagnostics: out });
});

// ======================
// TEMPORARY: Test discount/coupon API access
// ======================
app.get("/admin/test-discounts", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = "seven770.myshopify.com";
  const token = process.env.SHOPIFY_770_TOKEN;
  if (!token) return res.json({ ok: false, reason: "no token" });

  const base = `https://${shop}/admin/api/2026-01`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const out = {};

  // READ test: list existing price rules (needs read_price_rules)
  try {
    const r = await fetch(`${base}/price_rules.json?limit=1`, { headers });
    out.read_price_rules = {
      status: r.status,
      access: r.status === 200 ? "GRANTED" : "DENIED",
      count: r.status === 200 ? ((await r.json()).price_rules || []).length : null
    };
  } catch (e) { out.read_price_rules = { error: e.message }; }

  // WRITE capability is inferred: if read works, write usually shares the scope,
  // but the true test is creating one. We do NOT create here to avoid junk data.
  // Instead we report what scopes the token reports (if the endpoint allows).
  try {
    const r = await fetch(`${base}/oauth/access_scopes.json`, { headers });
    if (r.status === 200) {
      const body = await r.json();
      out.granted_scopes = (body.access_scopes || []).map(s => s.handle);
    } else {
      out.granted_scopes = `could not read scopes (status ${r.status})`;
    }
  } catch (e) { out.granted_scopes = { error: e.message }; }

  res.json({ ok: true, diagnostics: out });
});

// ======================
// TEMPORARY: Test WRITE access for coupons (creates + deletes a test coupon)
// ======================
app.get("/admin/test-coupon-write", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = "seven770.myshopify.com";
  const token = process.env.SHOPIFY_770_TOKEN;
  if (!token) return res.json({ ok: false, reason: "no token" });

  const base = `https://${shop}/admin/api/2026-01`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const out = {};
  let createdPriceRuleId = null;

  // Step 1: Try to create a price rule (the actual write test)
  try {
    const priceRule = {
      price_rule: {
        title: "TRYFIT_WRITE_TEST_DELETE_ME",
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: "percentage",
        value: "-10.0",
        customer_selection: "all",
        starts_at: new Date().toISOString()
      }
    };
    const r = await fetch(`${base}/price_rules.json`, {
      method: "POST", headers, body: JSON.stringify(priceRule)
    });
    out.create_attempt = { status: r.status };
    if (r.status === 201) {
      const body = await r.json();
      createdPriceRuleId = body.price_rule?.id;
      out.create_attempt.access = "WRITE GRANTED ✅";
      out.create_attempt.created_id = createdPriceRuleId;
    } else {
      const body = await r.text();
      out.create_attempt.access = "WRITE DENIED ❌";
      out.create_attempt.message = body.substring(0, 200);
      out.create_attempt.likely_cause = (r.status === 403)
        ? "Missing write_price_rules scope - need to add it to the app"
        : "Other error";
    }
  } catch (e) {
    out.create_attempt = { error: e.message };
  }

  // Step 2: Clean up - delete the test price rule if we created one
  if (createdPriceRuleId) {
    try {
      const dr = await fetch(`${base}/price_rules/${createdPriceRuleId}.json`, {
        method: "DELETE", headers
      });
      out.cleanup = { status: dr.status, deleted: dr.status === 200 || dr.status === 204 };
    } catch (e) {
      out.cleanup = { error: e.message, note: "test rule may remain - delete TRYFIT_WRITE_TEST_DELETE_ME manually" };
    }
  }

  res.json({ ok: true, result: out });
});
app.get("/admin/test-checkouts", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה - הוסף ?password=tryfit2026 ל-URL" });
  }
  const shop = "seven770.myshopify.com";
  const token = process.env.SHOPIFY_770_TOKEN;
  if (!token) {
    return res.json({ ok: false, reason: "no token configured" });
  }
  try {
    // Try to fetch a single abandoned checkout to test access + scope.
    const url = `https://${shop}/admin/api/2026-01/checkouts.json?limit=1`;
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }
    });
    const status = r.status;
    let body;
    try { body = await r.json(); } catch (e) { body = await r.text(); }

    if (status === 200) {
      const checkouts = body.checkouts || [];
      const sample = checkouts[0] || null;
      return res.json({
        ok: true,
        access: "GRANTED",
        status,
        checkouts_returned: checkouts.length,
        sample_fields: sample ? Object.keys(sample) : [],
        sample_line_items: sample && sample.line_items
          ? sample.line_items.map(li => ({ title: li.title, quantity: li.quantity, price: li.price }))
          : [],
        sample_total: sample ? sample.total_price : null,
        sample_email: sample ? (sample.email ? "present" : "none") : null,
        sample_created: sample ? sample.created_at : null
      });
    } else {
      // 401/403 = scope missing; anything else = other error
      return res.json({
        ok: false,
        access: "DENIED_OR_ERROR",
        status,
        message: typeof body === "string" ? body.substring(0, 300) : JSON.stringify(body).substring(0, 300),
        likely_cause: (status === 401 || status === 403)
          ? "Missing read_checkouts / read_orders scope - need to add scope (permission popup)"
          : "Other API error"
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
// FASHN FUNCTIONS
// ======================
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

// ======================
// RUNPOD FUNCTIONS
// ======================
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

// === UNIFIED ===
async function submitJob(dataUri, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitRunPod(dataUri, garmentUrl, category);
  return await submitFashn(dataUri, garmentUrl, category);
}

async function submitAndWait(modelImage, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitAndWaitRunPod(modelImage, garmentUrl, category);
  return await submitAndWaitFashn(modelImage, garmentUrl, category);
}

// ======================
// TRY-ON ROUTES
// ======================
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

// === COMPLIANCE WEBHOOKS (HMAC VERIFIED) ===
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

// === CHECKOUT WEBHOOKS (abandoned cart capture, real-time, saved forever) ===
// Uses express.raw so we can verify the HMAC against the EXACT bytes Shopify
// signed (JSON.stringify would re-serialize and break verification).
function handleCheckoutWebhook(req, res) {
  try {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const secret = process.env.SHOPIFY_API_SECRET || "";
    const rawBody = req.body; // Buffer (from express.raw)

    if (!hmacHeader || !secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (hash !== hmacHeader) {
      console.log("⚠️  [Webhook] Checkout HMAC mismatch - rejected");
      return res.status(401).json({ error: "Invalid HMAC" });
    }

    // Respond 200 immediately (Shopify requires fast ack), then save in background.
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

// === ORDER WEBHOOK: close the loop on advisor-created coupons ===
// When an order comes in that used a coupon the advisor created, mark that
// action as converted and attribute the revenue. This powers the live counter.
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
        const orderTotal = parseFloat(order.total_price || order.current_total_price || 0);
        const buyerEmail = (order.email || order.customer?.email || "").toLowerCase() || null;
        const buyerPhone = (order.phone || order.customer?.phone || order.shipping_address?.phone || "").replace(/[^0-9]/g, "") || null;

        // --- Attribution 1: by coupon code (certain) ---
        const codes = (order.discount_codes || []).map(d => (d.code || "").toUpperCase()).filter(Boolean);
        let closedByCoupon = false;
        for (const code of codes) {
          const r = await db.query(
            `UPDATE advisor_actions
             SET outcome = 'converted', attributed_revenue = $3, closed_at = NOW()
             WHERE shop_domain = $1 AND coupon_code = $2 AND outcome = 'pending'
             RETURNING id`,
            [shopDomain, code, orderTotal]
          );
          if (r.rows.length > 0) {
            closedByCoupon = true;
            console.log(`💰 [Loop closed - coupon] ${code} converted! +${orderTotal}₪ (action ${r.rows[0].id})`);
          }
        }

        // --- Attribution 2: by time window (customer bought within 3 days of being contacted) ---
        // Only if not already closed by coupon (avoid double-counting the same order).
        if (!closedByCoupon && (buyerEmail || buyerPhone)) {
          const r = await db.query(
            `UPDATE advisor_actions
             SET outcome = 'converted', attributed_revenue = $4, closed_at = NOW(),
                 details = details || '{"attribution":"time_window_3d"}'::jsonb
             WHERE id = (
               SELECT id FROM advisor_actions
               WHERE shop_domain = $1
                 AND outcome = 'pending'
                 AND created_at >= NOW() - INTERVAL '3 days'
                 AND (
                   ($2::text IS NOT NULL AND lower(target_email) = $2)
                   OR ($3::text IS NOT NULL AND regexp_replace(target_phone, '[^0-9]', '', 'g') = $3)
                 )
               ORDER BY created_at DESC
               FETCH FIRST 1 ROWS ONLY
             )
             RETURNING id`,
            [shopDomain, buyerEmail, buyerPhone, orderTotal]
          );
          if (r.rows.length > 0) {
            console.log(`💰 [Loop closed - 3day window] customer ${buyerEmail || buyerPhone} bought! +${orderTotal}₪ (action ${r.rows[0].id})`);
          }
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
app.get("/admin/register-webhooks", async (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  const shop = "seven770.myshopify.com";
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

  // Also list all currently registered webhooks for confirmation.
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

  // ========== Data Platform Initialization ==========
  console.log("\n--- Data Platform Initialization ---");
  console.log("Data collection enabled for:", featureFlags.getDataCollectionShops().join(", "));
  if (process.env.DATABASE_URL) {
    const connected = await db.testConnection();
    if (connected) {
      await db.initializeSchema();
      console.log("Data platform: READY");
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

  // ========== Product Catalog Sync (every 6 hours) ==========
  if (process.env.DATABASE_URL) {
    const PRODUCT_SYNC_SHOP = "seven770.myshopify.com";
    const runProductSync = async () => {
      if (!shopify.hasTokenForShop(PRODUCT_SYNC_SHOP)) return;
      try {
        const r = await shopify.syncProducts(PRODUCT_SYNC_SHOP);
        console.log("🔄 [Products] Scheduled sync:", JSON.stringify(r));
      } catch (e) {
        console.error("⚠️  [Products] Scheduled sync failed:", e.message);
      }
    };
    setTimeout(runProductSync, 30000);
    setInterval(runProductSync, 6 * 60 * 60 * 1000);
    console.log("🔄 Product catalog sync scheduled (every 6h)");
  }

  // ========== Orders + Customers Sync (every 3 hours) ==========
  // Keeps store_orders / store_customers fresh so the advisor's numbers
  // match Shopify. Reuses the existing backfillEntireShop (full upsert).
  if (process.env.DATABASE_URL) {
    const DATA_SYNC_SHOP = "seven770.myshopify.com";
    let dataSyncRunning = false;
    const runDataSync = async () => {
      if (!shopify.hasTokenForShop(DATA_SYNC_SHOP)) return;
      if (dataSyncRunning) {
        console.log("🔄 [Data] Sync already running, skipping this cycle");
        return;
      }
      if (!featureFlags.isDataCollectionEnabled(DATA_SYNC_SHOP)) return;
      dataSyncRunning = true;
      try {
        const r = await shopify.backfillEntireShop(DATA_SYNC_SHOP);
        console.log("🔄 [Data] Scheduled sync:",
          `customers ${r.customers_saved}/${r.customers_fetched},`,
          `orders ${r.orders_saved}/${r.orders_fetched} (${r.duration_seconds}s)`);

        // Recompute last_order_date for each customer from their orders,
        // so "dormant customer" analysis stays accurate after every sync.
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

        // Sync abandoned checkouts (carts not completed) for cart-recovery insights.
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
        console.error("⚠️  [Data] Scheduled sync failed:", e.message);
      } finally {
        dataSyncRunning = false;
      }
    };
    // First run 90s after startup (lets product sync go first), then every 3h.
    setTimeout(runDataSync, 90000);
    setInterval(runDataSync, 3 * 60 * 60 * 1000);
    console.log("🔄 Orders + customers sync scheduled (every 3h)");
  }
  console.log("---\n");
});