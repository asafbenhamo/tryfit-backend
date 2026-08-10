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
const messageQueue = require("./message-queue");
const noaEngine = require("./noa-engine");
const storeSettings = require("./store-settings");
const storeTime = require("./store-time");
const sessionAuth = require("./session-auth");
const billing = require("./billing-engine");
const policyEngine = require("./policy-engine");
const autopilot = require("./autopilot-engine");
const attributionEngine = require("./attribution-engine");
const pushEngine = require("./push-engine");
const flashySync = require("./flashy-sync");

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning", "x-advisor-password", "x-advisor-token"]
}));
app.use((req, res, next) => {
  // Every one of these verifies an HMAC over the RAW request bytes, so they must
  // not be JSON-parsed here — express.raw is mounted on each route instead.
  // Parsing and re-serializing changes the bytes and the signature never matches.
  if (req.path === "/webhooks/checkouts/create" || req.path === "/webhooks/checkouts/update" ||
      req.path === "/webhooks/orders/create" || req.path === "/webhooks/compliance" ||
      req.path === "/webhooks/app/uninstalled" || req.path === "/webhooks/app/scopes_update") {
    return next();
  }
  return express.json({ limit: '20mb' })(req, res, next);
});

// Turn an exception into something safe to hand a client.
//
// ~75 handlers returned `err.message` verbatim. That message is often written
// by Postgres or the Shopify SDK, and it happily describes our schema
// ("column advisor_actions.foo does not exist"), our queries, internal
// hostnames, file paths, or the tail of a credential. Attackers map a system
// out of exactly those replies.
//
// Messages we author ourselves are short, human, and safe to show — those still
// reach the user, because "the store is not connected" is more useful than
// "server error". Anything that smells like machinery is replaced by a
// reference id which is logged in full server-side, so support can still find
// the real error without publishing it.
// The credential patterns require an adjacent VALUE (`token: abc`), so a plain
// human sentence that merely mentions the word — "the store is not connected
// (no token)" — is still shown to the merchant, which is the whole point.
const LEAKY_ERROR = /(relation |column |syntax error|constraint|duplicate key|ECONN|ETIMEDOUT|ENOTFOUND|EAI_|\bat \w+[. ]|node_modules|[A-Za-z]:\\|\/(usr|home|app)\/|SELECT |INSERT |UPDATE |DELETE |shpat_|shpss_|Bearer \S|(password|api[_-]?key|secret|token)\s*[=:]\s*\S)/i;

function safeError(e) {
  const id = crypto.randomBytes(5).toString("hex");
  const raw = (e && (e.stack || e.message)) || String(e);
  console.error(`[err:${id}]`, raw);
  const msg = String((e && e.message) || "").trim();
  if (msg && msg.length <= 140 && !LEAKY_ERROR.test(msg)) return msg;
  return `שגיאת שרת (ref ${id})`;
}

// ===== Rate limiting =====
//
// The login route had a counter, but nothing else did — and every other
// endpoint accepts ?password= and does the same comparison. An attacker never
// needed to touch /api/auth/login: `GET /api/settings?password=<guess>` answers
// 401 on a miss and 200 on a hit, at whatever rate they can manage. Guarding
// only the front door while the windows are open is not a guard.
//
// express-rate-limit was already a declared dependency and was never required.
const rateLimit = (() => {
  try { const m = require("express-rate-limit"); return m.rateLimit || m.default || m; }
  catch (e) { console.warn("[boot] express-rate-limit unavailable — rate limiting disabled"); return null; }
})();

if (rateLimit) {
  const common = {
    standardHeaders: true,
    legacyHeaders: false,
    // Railway sits behind a proxy, so req.ip comes from X-Forwarded-For, which
    // a client can spoof. Keying on the leftmost hop is still the best signal
    // available here; the real backstop is that credentials now expire.
    message: { error: "יותר מדי בקשות. נסה שוב בעוד רגע." }
  };

  // Anything that authenticates: the brute-force surface.
  app.use(["/api", "/admin"], rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 240,                       // generous for a live dashboard, useless for guessing
    skip: (req) => req.method === "OPTIONS"
  }));

  // Credential checks specifically: far tighter, and counted per IP.
  app.use(["/api/auth/login"], rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,     // only failures burn the budget
    message: { ok: false, error: "יותר מדי ניסיונות התחברות. נסה שוב בעוד 15 דקות." }
  }));

  // The AI is the expensive one: each call costs real money and can run a tool
  // loop, so a tighter ceiling protects the bill as much as the service.
  app.use(["/api/chat", "/api/transcribe"], rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 20
  }));

  console.log("🛡️  Rate limiting active (240/min API, 10/15min login, 20/min AI)");
}

// SESSION RESOLUTION — must sit above EVERY route, because resolveShop() is
// called synchronously from dozens of handlers and cannot await a lookup itself.
// Placed after the body parser so a request is fully formed by the time we look.
app.use(async (req, res, next) => {
  try {
    const token = sessionAuth.extractToken(req);
    if (token) {
      const s = await sessionAuth.resolve(token);
      if (s) req._session = s;
    }
  } catch (e) { /* fall through to the legacy password path */ }
  next();
});

const BACKEND_MODE = process.env.BACKEND_MODE || "fashn";

// Was a live key committed to source. Rotate it: anything ever pushed to git
// must be treated as public, even after the line is deleted.
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || null;
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

// Verify a webhook really came from Shopify.
//
// Three things were wrong here and all three matter:
//
//  1. The digest was computed over JSON.stringify(req.body) — a RE-SERIALIZATION
//     of the parsed object. Shopify signs the raw bytes it sent. Re-serializing
//     changes key order, spacing and unicode escaping, so the hash essentially
//     never matched: the mandatory GDPR webhooks rejected every genuine Shopify
//     call. That alone fails App Store review.
//  2. The secret fell back to "" when SHOPIFY_API_SECRET was unset. With an
//     empty key an attacker signs their own payload correctly — including a
//     forged shop/redact, which deletes a merchant's data. Auth must fail
//     CLOSED, never open.
//  3. The comparison used !==, which returns as soon as two bytes differ and
//     leaks the expected digest to anyone who can measure response times.
//
// Routes using this must be mounted with express.raw so req.body is a Buffer.
// Shopify signs webhooks with the APP's client secret. OAuth here reads it from
// ADVISOR_SHOPIFY_SECRET while webhook code read SHOPIFY_API_SECRET — one app,
// two names, and if only the first was configured every webhook silently failed
// verification. (That is the "checkout HMAC mismatch" in the logs.) Resolve once,
// accept either name.
function shopifyAppSecret() {
  return process.env.SHOPIFY_API_SECRET || process.env.ADVISOR_SHOPIFY_SECRET || null;
}

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = shopifyAppSecret();
  if (!secret) {
    console.error("[webhook] SHOPIFY_API_SECRET is not set — rejecting webhook");
    return res.status(500).json({ error: "Webhook verification not configured" });
  }
  if (!hmacHeader) return res.status(401).json({ error: "Unauthorized - No HMAC" });

  // Buffer when mounted with express.raw (correct); string/object otherwise.
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(hmacHeader), "base64"); }
  catch (e) { return res.status(401).json({ error: "Unauthorized - Invalid HMAC" }); }

  if (given.length !== digest.length || !crypto.timingSafeEqual(digest, given)) {
    return res.status(401).json({ error: "Unauthorized - Invalid HMAC" });
  }

  // Hand the handlers a parsed body, since they were written expecting one.
  if (Buffer.isBuffer(req.body)) {
    try { req.body = JSON.parse(rawBody.toString("utf8") || "{}"); }
    catch (e) { return res.status(400).json({ error: "Invalid JSON" }); }
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
    res.status(200).json({ ok: false, error: safeError(err) });
  }
});

app.get("/webhook/flashy/status", (req, res) => {
  res.json({ ok: true, ...flashySync.status() });
});

// ===== Noa: incoming SMS replies =====
// TextMe posts customer replies here. Noa handles opt-out keywords, answers what
// she can from real store data, and hands off to the merchant (with a push) when
// unsure. Configure this URL in TextMe's incoming-message webhook settings:
//   https://tryfit-backend-production.up.railway.app/webhook/sms-incoming?secret=<TEXTME_WEBHOOK_SECRET>
app.post("/webhook/sms-incoming", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    // Fail CLOSED. This used to be `if (secret && ...)`, so with the env var
    // unset there was no check at all — anyone could POST a fabricated inbound
    // SMS, and Noa would reply by SMS to whatever number the payload named. That
    // is free messaging on the merchant's account, and forged "customer" replies
    // steering the agent.
    const secret = process.env.TEXTME_WEBHOOK_SECRET || null;
    if (!secret) {
      console.error("[noa] TEXTME_WEBHOOK_SECRET is not set — refusing inbound SMS");
      return res.status(503).json({ ok: false, reason: "webhook_not_configured" });
    }
    const given = String(req.query.secret || "");
    if (!given || !sessionAuth.safeEqual(given, secret)) {
      return res.status(401).json({ ok: false, reason: "bad_secret" });
    }
    // WHOSE customer is this? The shop used to come from an env var, so every
    // merchant's inbound replies were filed under the pilot store. A customer of
    // shop B texting "STOP" had her opt-out written against shop A, so
    // isOptedOut(B, phone) stayed false and the agent kept texting her — with
    // shop B as the sender of record for a spam-law violation.
    //
    // Resolve by the number instead. If more than one shop knows it, honour the
    // STOP in all of them: over-suppressing costs a merchant one contact,
    // under-suppressing costs them a complaint they cannot defend.
    const inbound = noaEngine.extractInbound ? noaEngine.extractInbound(req.body) : {};
    const digits = String(inbound.phone || "").replace(/[^0-9]/g, "");
    let shops = [];
    if (digits.length >= 7) {
      try {
        const r = await db.query(
          `SELECT DISTINCT shop_domain FROM store_customers
            WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE '%' || $1`,
          [digits.slice(-9)]);
        shops = r.rows.map(x => x.shop_domain).filter(Boolean);
      } catch (e) { console.error("[noa] shop lookup:", e.message); }
    }
    if (shops.length === 0) {
      // Unknown number: nothing to reply about, and guessing a shop would file it
      // against a merchant this person may have no relationship with.
      console.warn(`[noa] inbound from an unrecognised number (…${digits.slice(-4)}) — ignored`);
      return res.status(200).json({ ok: true, ignored: "unknown_number" });
    }
    console.log(`[noa] inbound sms for ${shops.length} shop(s):`, JSON.stringify(req.body).slice(0, 200));
    const results = [];
    for (const shop of shops) {
      results.push(await noaEngine.handleInbound(shop, req.body));
    }
    res.status(200).json(results.length === 1 ? results[0] : { ok: true, shops: shops.length, results });
  } catch (err) {
    console.error("sms-incoming error:", err.message);
    res.status(200).json({ ok: false, error: safeError(err) });
  }
});

// Queue visibility: what's waiting to go out (smart-timing + follow-ups).
app.get("/api/queue/status", async (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const shop = resolveShop(req) || DEFAULT_SHOP;
  res.json(await messageQueue.pendingStats(shop));
});

// ===== Store settings (brand / language / currency / daily cap / autopilot) =====
app.get("/api/settings", async (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const shop = resolveShop(req) || DEFAULT_SHOP;
  const s = await storeSettings.getSettings(shop);
  const cap = await storeSettings.remainingToday(shop);
  res.json({ ok: true, settings: s, today: cap });
});

app.post("/api/settings", express.json(), async (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  const shop = resolveShop(req) || DEFAULT_SHOP;
  const allowed = {};
  for (const k of ["brand", "language", "currency", "sms_sender", "daily_cap", "autopilot", "followup_default", "timezone", "whatsapp_enabled"]) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  if (allowed.language && !["he", "en"].includes(allowed.language)) return res.status(400).json({ ok: false, error: "language must be he/en" });
  if (allowed.daily_cap !== undefined) allowed.daily_cap = Math.max(10, Math.min(parseInt(allowed.daily_cap) || 500, 5000));
  if (allowed.timezone !== undefined && !storeTime.isValidTz(allowed.timezone)) {
    return res.status(400).json({ ok: false, error: "timezone must be a valid IANA zone, e.g. America/New_York" });
  }
  const r = await storeSettings.updateSettings(shop, allowed);
  res.json(r);
});

// Is the AI actually reachable? A GET so it can be opened straight from a
// browser when the chat "just doesn't answer" — it distinguishes a missing key
// from an exhausted balance from a slow model, instead of leaving you guessing.
app.get("/api/health/ai", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({ ok: false, stage: "config", error: "ANTHROPIC_API_KEY is not set in Railway" });
  }
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({
      model: aiBrain.MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }]
    });
    const text = (r.content || []).map(c => c.text || "").join("").trim();

    // ?full=1 runs a real advisor question through the whole tool loop, which is
    // what the chat actually does. A bare model call can be healthy while a tool
    // hangs on Shopify or Postgres — this reports the time each tool took, so a
    // stall points at a specific tool instead of "the chat doesn't answer".
    if (req.query.full) {
      const t0 = Date.now();
      try {
        const shopName = (shopify.getStore(shop) || {}).name || shop;
        const brain = await aiBrain.askBrain(shop, shopName, "כמה לקוחות יש לי בחנות?", [], []);
        return res.json({
          ok: !!brain.ok, mode: "full_chat_path", model: aiBrain.MODEL,
          ping_ms: Date.now() - started - (Date.now() - t0),
          chat_ms: Date.now() - t0,
          tools: (brain.toolsUsed || []).map(x => ({ name: x.name, ms: x.ms, ok: x.ok })),
          answer_preview: String(brain.answer || "").slice(0, 200)
        });
      } catch (e) {
        return res.json({
          ok: false, mode: "full_chat_path", stage: "askBrain",
          chat_ms: Date.now() - t0, error: safeError(e)
        });
      }
    }

    res.json({
      ok: true, model: aiBrain.MODEL, replied: text,
      ms: Date.now() - started,
      usage: r.usage || null,
      hint: "add &full=1 to run a real question through the whole tool loop"
    });
  } catch (e) {
    // Surface what the API actually said — credit exhaustion, a bad model name
    // and a rate limit all look identical from the chat window.
    res.json({
      ok: false, stage: "api", model: aiBrain.MODEL,
      ms: Date.now() - started,
      status: e.status || null,
      type: (e.error && e.error.error && e.error.error.type) || e.name || null,
      error: (e.error && e.error.error && e.error.error.message) || e.message
    });
  }
});

// Exchange a one-time setup link for a real session. This is how a merchant
// gets in straight after installing, without us ever mailing them a password.
app.post("/api/auth/setup", express.json(), async (req, res) => {
  const token = (req.body && req.body.setup) || "";
  if (!token) return res.status(400).json({ ok: false, error: "missing setup token" });
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const sess = await sessionAuth.consumeSetupLink(token, { ip, userAgent: req.headers["user-agent"] });
  if (!sess) {
    // Deliberately vague: expired, already used and never valid are the same
    // answer, so the link cannot be probed.
    return res.status(401).json({ ok: false, error: "קישור ההתקנה כבר נוצל או פג תוקף. התחבר עם הסיסמה." });
  }
  const shop = sess.shop || null;
  const cfg = shop ? shopify.getStore(shop) : null;
  res.json({
    ok: true, mode: "store", shop,
    name: (cfg && cfg.name) || String(shop || "").replace(".myshopify.com", ""),
    terms_accepted: shop ? shopify.hasAcceptedTerms(shop) : false,
    token: sess.token, expires_at: sess.expires_at
  });
});

// End a session. The token is revoked server-side, so a copy someone else holds
// (a shared screenshot, a synced browser history) stops working immediately.
app.post("/api/auth/logout", express.json(), async (req, res) => {
  const token = sessionAuth.extractToken(req);
  await sessionAuth.revoke(token);
  res.json({ ok: true });
});

// ===== Billing (Shopify usage-based) =====
// Charging a Shopify merchant outside Shopify's billing API is grounds for
// removal from the App Store, so every cent goes through these.
app.get("/api/billing", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const [sub, hist] = await Promise.all([
      billing.getSubscription(shop),
      billing.charges(shop, 25)
    ]);
    res.json({
      ok: true,
      commission_rate: billing.COMMISSION_RATE,
      trial_days: billing.TRIAL_DAYS,
      subscription: sub,
      charges: hist.charges,
      totals: hist.totals
    });
  } catch (e) { res.status(500).json({ ok: false, error: safeError(e) }); }
});

// Start the approval flow. Returns the Shopify-hosted confirmation URL the
// merchant must visit — we never take payment details ourselves.
app.post("/api/billing/subscribe", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const settings = await storeSettings.getSettings(shop);
    // `test` is NOT taken from the request. It means "never actually charge me",
    // and a client that can set it can make the app free forever. startSubscription
    // asks Shopify what kind of store this is instead. The cap is clamped there
    // too, so a hand-crafted body cannot approve a ceiling nobody chose.
    const r = await billing.startSubscription(shop, {
      cappedAmount: req.body && req.body.capped_amount,
      currency: (settings.currency === "₪" ? "ILS" : "USD")
    });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: safeError(e) }); }
});

// Where Shopify sends the merchant back after they approve or decline.
app.get("/billing/confirmed", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase().trim();
  let status = "unknown";
  try { status = (await billing.getSubscription(shop)).status; } catch (e) {}
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Advisor</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;text-align:center;color:#1a1d24}
h1{font-size:22px}p{color:#5b6472;line-height:1.6}a{display:inline-block;margin-top:18px;padding:12px 22px;background:#0a6fe0;color:#fff;border-radius:10px;text-decoration:none}</style>
<h1>${status === "ACTIVE" ? "You're all set ✅" : "Billing not active"}</h1>
<p>${status === "ACTIVE"
  ? `Smart Advisor will charge ${Math.round(billing.COMMISSION_RATE * 100)}% of sales it can prove it generated — nothing else. You can see every charge in the app.`
  : "The subscription was not approved. The agent will keep working, but it cannot bill for results until you approve."}</p>
<a href="/chat">Back to the advisor</a>`);
});

// Which channels can this shop actually send on right now, and why not the
// others? Answers "why did she get an email instead of a text?" without having
// to read logs. Also reports the WhatsApp credit balance, since that is what
// gates the expensive channel.
app.get("/api/channels", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const settings = await storeSettings.getSettings(shop);
    const router = require("./channel-router");
    const available = await router.shopChannels(shop, settings);
    res.json({
      ok: true,
      priority: ["whatsapp (funded)", "sms", "email"],
      available,
      whatsapp_enabled: settings.whatsapp_enabled === true,
      credits: available.credits != null ? available.credits : await creditsEngine.getBalance(shop).catch(() => 0),
      sms_sender: settings.sms_sender || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: safeError(e) });
  }
});

// ===== Autopilot: is the agent allowed to act on its own? =====
// GET  -> current mode + what it has been doing + measured lift
// POST -> { on: true|false } flips between 'full' (acts alone) and 'approve'
app.get("/api/autopilot", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    const s = await storeSettings.getSettings(shop);
    const [runs, cap, earned] = await Promise.all([
      autopilot.recentRuns(shop, 7),
      storeSettings.remainingToday(shop),
      // What the agent has brought in, reported the way every marketing
      // platform reports it: attributed revenue on actions that converted.
      db.query(
        `SELECT COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric AS total,
                COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'
                  AND closed_at >= date_trunc('month', NOW())),0)::numeric AS this_month,
                COUNT(*) FILTER (WHERE outcome='converted')::int AS conversions,
                COUNT(*)::int AS outreaches,
                COUNT(*) FILTER (WHERE outcome='pending')::int AS pending
           FROM advisor_actions
          WHERE shop_domain=$1 AND action_type <> 'holdout'`,
        [shop]
      ).catch(() => ({ rows: [{}] }))
    ]);
    const e = (earned.rows && earned.rows[0]) || {};
    res.json({
      ok: true,
      mode: s.autopilot,
      on: s.autopilot === "full",
      timezone: s.timezone,
      local_hour: storeTime.hourIn(s.timezone),
      run_hour: autopilot.RUN_HOUR,
      daily_cap: s.daily_cap,
      today: cap,
      runs: runs.runs || [],
      earned: {
        total: Math.round(parseFloat(e.total || 0)),
        this_month: Math.round(parseFloat(e.this_month || 0)),
        conversions: e.conversions || 0,
        outreaches: e.outreaches || 0,
        pending: e.pending || 0
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: safeError(e) });
  }
});

app.post("/api/autopilot", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const on = req.body && (req.body.on === true || req.body.on === "true");
  const r = await storeSettings.updateSettings(shop, { autopilot: on ? "full" : "approve" });
  if (!r.ok) return res.status(500).json(r);
  console.log(`🤖 [autopilot] ${shop} -> ${on ? "FULL (acts alone)" : "approve (asks first)"}`);
  res.json({ ok: true, on, mode: r.settings.autopilot });
});

// What the agent learned: per-segment / offer / channel performance, so the
// merchant can see WHY it is choosing what it chooses.
app.get("/api/autopilot/policy", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    res.json({ ok: true, ...(await policyEngine.learn(shop)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: safeError(e) });
  }
});

// Manual kick, for testing a store without waiting for its local morning.
app.post("/api/autopilot/run-now", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  try {
    res.json(await autopilot.runForShop(shop, { force: true }));
  } catch (e) {
    res.status(500).json({ ok: false, error: safeError(e) });
  }
});

// PRIVACY POLICY.
//
// The previous text was written for a different product (virtual try-on) and
// stated: "We do not access customer personal information, order data, or
// payment information." This app reads a merchant's entire customer list and
// order history, stores names, emails and phone numbers, and sends some of that
// to a third-party model provider. Publishing the opposite is an automatic
// App Store review failure and a straightforward misrepresentation to consumers
// under GDPR/CCPA. This describes what the code actually does.
//
// Still needs a lawyer's review before launch — the disclosures are accurate,
// but accuracy is not the same as sufficiency in every jurisdiction.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@smartadvisor.app";

app.get("/privacy", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Smart Advisor — Privacy Policy</title>
<style>
body{font-family:system-ui,-apple-system,Arial,sans-serif;max-width:820px;margin:0 auto;padding:40px 22px;color:#23272f;line-height:1.65}
h1{color:#0a6fe0;font-size:26px}h2{color:#2D3436;margin-top:32px;font-size:18px}
code{background:#f3f5f9;padding:1px 5px;border-radius:4px;font-size:13px}
table{border-collapse:collapse;width:100%;margin-top:8px}td,th{border:1px solid #e3e8f3;padding:8px 10px;text-align:left;font-size:14px;vertical-align:top}
</style>
</head>
<body>
<h1>Smart Advisor — Privacy Policy</h1>
<p>Last updated: August 2026</p>

<p>Smart Advisor is a marketing tool installed by a Shopify merchant on their own store.
The merchant is the <strong>data controller</strong> for their customers' personal data;
we act as a <strong>data processor</strong> on their instructions.</p>

<h2>What we access from the merchant's store</h2>
<p>With the merchant's authorization through Shopify OAuth, we read:</p>
<table>
<tr><th>Data</th><th>Why</th></tr>
<tr><td>Customer name, email address, phone number</td><td>To identify who to contact and to deliver the message</td></tr>
<tr><td>Order history: dates, amounts, products purchased</td><td>To segment customers by recency, frequency and value, and to reference what someone actually bought</td></tr>
<tr><td>Abandoned checkouts</td><td>To offer to recover the cart</td></tr>
<tr><td>Product catalogue and inventory</td><td>To recommend products and flag stock issues</td></tr>
<tr><td>Marketing consent status</td><td>To avoid contacting anyone who has not consented or who opted out</td></tr>
</table>
<p>We do <strong>not</strong> receive or store payment card details. Shopify never exposes them to apps.</p>

<h2>Where it goes</h2>
<ul>
<li><strong>Our database</strong> (PostgreSQL, hosted on Railway) — customer records, order summaries, message history and outcomes.</li>
<li><strong>Anthropic</strong> — customer data relevant to a request (for example a name and recent purchases) is sent to Claude to analyse the store and draft messages. Anthropic does not train on this data.</li>
<li><strong>Message delivery providers</strong> — Resend for email, TextMe for SMS, 360dialog for WhatsApp. Each receives only the recipient address and the message.</li>
<li><strong>Flashy</strong> — where a merchant uses it, unsubscribe status is synchronised in both directions.</li>
</ul>
<p>We do not sell personal data, and we do not share it with anyone other than the processors above.</p>

<h2>Retention and deletion</h2>
<ul>
<li>Data is retained while the app is installed and for up to 30 days after uninstall.</li>
<li><code>customers/redact</code> from Shopify deletes that customer's records from our systems.</li>
<li><code>shop/redact</code> (sent 48 hours after uninstall) deletes all of that merchant's data.</li>
<li>Unsubscribe records are kept after deletion of other data, because we must remember not to contact someone who opted out.</li>
</ul>

<h2>Marketing messages and consent</h2>
<p>Messages are sent in the merchant's name, and the merchant is the sender of record.
The merchant is responsible for having obtained consent on the channel used. We enforce
opt-outs, restrict sending to legal hours in the store's own timezone, and cap the number
of messages per store per day.</p>

<h2>Rights of the merchant's customers</h2>
<p>Requests to access, correct or delete personal data should go to the store you purchased
from — they control the data. They can action it through Shopify, which relays the request
to us automatically. You can also contact us at ${SUPPORT_EMAIL} and we will assist the merchant.</p>

<h2>Security</h2>
<p>Data is transmitted over TLS. Access credentials are encrypted at rest. Access to
production data is limited to those who need it to operate the service.</p>

<h2>Contact</h2>
<p>${SUPPORT_EMAIL}</p>
</body>
</html>`);
});

app.use("/admin", adminRouter);

app.get("/api/credits/:shop", (req, res) => {
  // Was unauthenticated: anyone could read any shop's plan and balance just by
  // guessing a myshopify domain. Callers may only read their own.
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const target = String(req.params.shop || "").toLowerCase().trim();
  if (target && target !== shop && !(req._session && req._session.is_master) && !isAdmin(req)) {
    return res.status(403).json({ error: "גישה נדחתה" });
  }
  res.json(creditsSystem.getStoreCredits(target || shop));
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
    res.status(500).json({ error: safeError(err) });
  }
});

// No hardcoded fallback. A default baked into a git-tracked file is not a
// secret: anyone who reads the repo (or a fork, or a leaked archive) holds the
// platform credential. Missing config must break loudly, not silently open.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
// Master password lets Asaf (super-admin) act on ANY store. With the master
// password, the target store is taken from the request's `shop` field.
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || null;

// Fail loudly on missing credentials rather than running wide open.
// Previously every one of these had a hardcoded fallback, so an unconfigured
// deploy looked healthy while accepting a password that is published in the
// repository. A boot that cannot be secured should not boot.
(function assertSecrets() {
  const missing = [];
  if (!ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (!process.env.SHOPIFY_API_SECRET && !process.env.ADVISOR_SHOPIFY_SECRET) missing.push("SHOPIFY_API_SECRET or ADVISOR_SHOPIFY_SECRET (webhook verification)");
  if (missing.length) {
    console.error("FATAL: missing required secrets: " + missing.join(", "));
    console.error("Set them in the environment. There are no defaults by design.");
    process.exit(1);
  }
  if (!MASTER_PASSWORD) {
    console.warn("[boot] MASTER_PASSWORD is not set — platform admin routes are disabled.");
  }
  for (const [name, val] of [["ADMIN_PASSWORD", ADMIN_PASSWORD], ["MASTER_PASSWORD", MASTER_PASSWORD]]) {
    if (val && val.length < 12) console.warn(`[boot] ${name} is shorter than 12 characters.`);
  }
})();
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

// Resolve which shop a request is authorized for.
//  - a valid session token          -> that token's shop (preferred)
//  - 770's existing ADMIN_PASSWORD  -> seven770 (backward compat)
//  - a store's own advisor_password -> that store
//  - MASTER_PASSWORD                -> the store named in req.query/body.shop
// Returns the shop_domain string, or null if nothing authorizes the request.
//
// Password auth is kept as a fallback so existing installs keep working while
// clients migrate to tokens. Comparisons are timing-safe: a plain === leaks the
// secret one character at a time to anyone who can measure response times.
function resolveShop(req) {
  // 1. Session token (what the PWA uses after logging in).
  if (req._session) {
    if (req._session.is_master) {
      const target = (req.query && req.query.shop) || (req.body && req.body.shop) || null;
      return target ? String(target).toLowerCase().trim() : null;
    }
    return req._session.shop || null;
  }

  // 2. Legacy password.
  const pw = extractPassword(req);
  if (!pw) return null;
  if (ADMIN_PASSWORD && sessionAuth.safeEqual(pw, ADMIN_PASSWORD)) return DEFAULT_SHOP;
  if (MASTER_PASSWORD && sessionAuth.safeEqual(pw, MASTER_PASSWORD)) {
    const target = (req.query && req.query.shop) || (req.body && req.body.shop) || null;
    return target ? String(target).toLowerCase().trim() : null;
  }
  try {
    for (const s of shopify.listStores()) {
      const cfg = shopify.getStore(s.shop_domain);
      if (cfg && cfg.password && sessionAuth.safeEqual(pw, cfg.password)) return s.shop_domain;
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
// Platform super-admin. ADMIN_PASSWORD is deliberately NOT accepted here any
// more: it is also the advisor login for the seven770 tenant, so treating it as
// an admin credential handed one ordinary merchant the ability to reset every
// other store's password, read their customer lists, and point their WhatsApp
// sending at an attacker's account. Only MASTER_PASSWORD, which belongs to no
// tenant, grants this.
function isAdmin(req) {
  if (req._session && req._session.is_master) return true;
  const pw = extractPassword(req);
  if (!pw || !MASTER_PASSWORD) return false;
  return sessionAuth.safeEqual(pw, MASTER_PASSWORD);
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
        backfillStatus[shop] = { ...backfillStatus[shop], success: false, fatal_error: safeError(err) };
      }
    });
    res.json({ success: true, message: "Backfill started" });
  } catch (err) {
    console.error("Backfill run error:", err);
    res.status(500).json({ error: safeError(err) });
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

app.post("/api/auth/login", express.json(), async (req, res) => {
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
      const sess = await sessionAuth.create(null, { isMaster: true, ip, userAgent: req.headers["user-agent"] });
      return res.json({ ok: true, mode: "master", stores, token: sess.token, expires_at: sess.expires_at });
    }

    // 770's existing password
    if (ADMIN_PASSWORD && sessionAuth.safeEqual(pw, ADMIN_PASSWORD)) {
      loginRecordSuccess(ip);
      const sess = await sessionAuth.create(DEFAULT_SHOP, { ip, userAgent: req.headers["user-agent"] });
      return res.json({ ok: true, mode: "store", shop: DEFAULT_SHOP, name: "770", terms_accepted: true,
        token: sess.token, expires_at: sess.expires_at });
    }

    // Per-store password
    const shop = resolveShop(req);
    if (shop) {
      loginRecordSuccess(ip);
      const cfg = shopify.getStore(shop);
      const sess = await sessionAuth.create(shop, { ip, userAgent: req.headers["user-agent"] });
      return res.json({
        ok: true, mode: "store", shop,
        name: (cfg && cfg.name) || shop.replace(".myshopify.com", ""),
        terms_accepted: shopify.hasAcceptedTerms(shop),
        token: sess.token, expires_at: sess.expires_at
      });
    }

    loginRecordFail(ip);
    return res.status(401).json({ ok: false, error: "סיסמה שגויה" });
  } catch (err) {
    console.error("auth/login error:", err.message);
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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

    // Send window: automatic sends only inside it, in the store's local time.
    if (!(await compliance.isWithinWorkingHours(shop))) {
      const st = await compliance.workingHoursStatus(shop);
      return res.json({ ok: false, error: `מחוץ לשעות השליחה (${st.window} ${st.timezone}, עכשיו ${st.local_hour}:00). נסה שוב בתוך החלון.` });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
  } catch (err) { res.status(500).json({ ok: false, error: safeError(err) }); }
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
  } catch (err) { res.status(500).json({ ok: false, error: safeError(err) }); }
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
  } catch (err) { res.status(500).json({ ok: false, error: safeError(err) }); }
});

app.post("/api/terms/accept", express.json(), async (req, res) => {
  try {
    const shop = resolveShop(req);
    if (!shop) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    const r = await shopify.acceptTerms(shop);
    res.json(r);
  } catch (err) {
    console.error("terms/accept error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err), detail: err.message });
  }
});

app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/chat.html");
});

app.get("/api/daily-plan", async (req, res) => {
  try {
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const shopName = storeBrand(shop);
    const planPrompt = `בנה לי תוכנית פעולה עסקית להיום כדי להכניס כמה שיותר כסף. אתה מנהל השיווק של החנות.
חשוב כמו חברת שיווק מובילה: נתח את המצב (עגלות נטושות, VIP שנעלמו, מוצרים חמים, דפוסי קנייה, cross-sell), ובנה תוכנית עם 2-4 מהלכים מתועדפים לפי פוטנציאל הכנסה.
לכל מהלך: כותרת קצרה, כמה לקוחות/מה הוא מכסה, צפי הכנסה בשקלים, והמלצה איך לבצע.
התחל ב"תוכנית להיום" וצפי ההכנסה הכולל. תהיה אסטרטגי ויצירתי - חשוב על כל דרך להרים מכירות, לא רק עגלות נטושות.
אל תכלול בלוקים של ACTION/CART/CAMPAIGN בתשובה הזו - רק את התוכנית עצמה בצורה ברורה וקריאה.`;
    const result = await aiBrain.askBrain(shop, shopName, planPrompt, []);
    res.json({ ok: true, plan: result.answer, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error("Daily plan error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// SMS (TextMe) configuration status — tells the UI whether to enable the SMS channel.
app.get("/api/sms/status", (req, res) => {
  if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
  res.json({ ok: true, configured: smsSender.isConfigured() });
});

// SMS test send — lets you verify the TextMe connection with a single message
// before trusting it in campaigns. Admin only.
//   POST { password, phone, message? }
app.post("/api/sms/test", express.json(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "גישה נדחתה" });
    if (!smsSender.isConfigured()) return res.status(400).json({ ok: false, error: "SMS לא מוגדר (חסרים משתני TEXTME ב-Railway)" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    const phone = (req.body.phone || "").trim();
    const message = (req.body.message || "בדיקת מערכת SMS מהיועץ החכם ✅").trim();
    if (!phone) return res.status(400).json({ ok: false, error: "חסר מספר טלפון" });
    const r = await smsSender.sendOne(shop, { phone, message });
    res.json({ ok: r.ok, result: r });
  } catch (err) {
    console.error("sms test error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
  }
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// UNSUBSCRIBE.
//
// Two problems with doing this on GET:
//
//  1. Mail providers and security appliances FOLLOW links to scan them. Gmail,
//     Outlook and corporate filters were silently unsubscribing customers who
//     never clicked anything — the merchant loses subscribers and cannot see why.
//  2. The link was unsigned with the shop in the query string, so anyone could
//     opt any address out of any shop.
//
// So GET only shows a confirmation, and the opt-out happens on POST. Links are
// signed, but UNSIGNED ones are still honoured on POST: links already sitting in
// customers' inboxes must keep working, and refusing a genuine unsubscribe is a
// worse failure than accepting an unverified one.
function unsubToken(email, shop) {
  const secret = process.env.ADMIN_PASSWORD || "unsub";
  return crypto.createHmac("sha256", secret)
    .update(String(email || "").toLowerCase() + "|" + String(shop || ""), "utf8")
    .digest("base64url").slice(0, 24);
}

function unsubPage({ title, body, form }) {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,Arial,sans-serif;text-align:center;padding:14vh 20px;color:#23272f;background:#f5f6f8;margin:0}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:34px 26px;box-shadow:0 4px 20px rgba(0,0,0,.07)}
h2{font-size:20px;margin:0 0 10px}p{color:#5b6472;line-height:1.65;font-size:14.5px}
button{margin-top:18px;padding:13px 30px;border:none;border-radius:10px;background:#d33;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}</style>
</head><body><div class="card"><h2>${title}</h2><p>${body}</p>${form || ""}</div></body></html>`;
}

app.get("/unsubscribe", (req, res) => {
  const email = String(req.query.email || "");
  if (!email) return res.status(400).send(unsubPage({ title: "קישור לא תקין", body: "חסרה כתובת מייל." }));
  const shop = String(req.query.shop || DEFAULT_SHOP).toLowerCase().trim();
  const t = String(req.query.t || "");
  res.set("Content-Type", "text/html; charset=utf-8").send(unsubPage({
    title: "להסיר אותך מרשימת התפוצה?",
    body: `נפסיק לשלוח הודעות שיווקיות אל <b>${esc(email)}</b>.`,
    form: `<form method="POST" action="/unsubscribe">
      <input type="hidden" name="email" value="${esc(email)}">
      <input type="hidden" name="shop" value="${esc(shop)}">
      <input type="hidden" name="t" value="${esc(t)}">
      <button type="submit">כן, הסר אותי</button></form>`
  }));
});

app.post("/unsubscribe", express.urlencoded({ extended: false }), async (req, res) => {
  const email = String((req.body && req.body.email) || req.query.email || "");
  if (!email) return res.status(400).send(unsubPage({ title: "קישור לא תקין", body: "חסרה כתובת מייל." }));
  let shop = String((req.body && req.body.shop) || req.query.shop || DEFAULT_SHOP).toLowerCase().trim();
  const given = String((req.body && req.body.t) || req.query.t || "");

  // A signature proves which shop the link was issued for. Without one we still
  // honour the request, but only against the shop named — never a wildcard.
  if (given && !sessionAuth.safeEqual(given, unsubToken(email, shop))) {
    return res.status(400).send(unsubPage({ title: "קישור לא תקין", body: "הקישור אינו תקף. פנה/י לחנות שממנה קיבלת את ההודעה." }));
  }

  await compliance.addOptOut(shop, { email, reason: "email_link" });
  flashySync.pushUnsubscribe({ email }).catch(() => {});
  console.log(`[unsub] ${email} opted out of ${shop}${given ? " (signed)" : " (unsigned)"}`);
  res.set("Content-Type", "text/html; charset=utf-8").send(unsubPage({
    title: "הוסרת מרשימת התפוצה",
    body: "לא תקבל/י יותר הודעות שיווקיות. תודה."
  }));
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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

app.get("/api/working-hours", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  res.json(await compliance.workingHoursStatus(shop));
});

const campaignEngine = require("./campaign-engine");

app.post("/api/campaign/start", express.json(), async (req, res) => {
  try {
    const { password, campaign_type, segment, template, channels, smart_timing, segment_key, followup } = req.body;
    if (!resolveShop(req)) return res.status(401).json({ error: "גישה נדחתה" });
    const shop = resolveShop(req) || DEFAULT_SHOP;
    if (!Array.isArray(segment) || segment.length === 0) {
      return res.status(400).json({ ok: false, error: "אין לקוחות בקמפיין" });
    }
    if (!template || !template.body) {
      return res.status(400).json({ ok: false, error: "חסר תוכן הודעה" });
    }
    const { id } = campaignEngine.startCampaign(shop, { campaign_type, segment, template, channels, smart_timing, segment_key, followup });
    res.json({ ok: true, campaign_id: id, total: Math.min(segment.length, campaignEngine.MAX_PER_CAMPAIGN) });
  } catch (err) {
    console.error("Campaign start error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.get("/api/campaign/status", (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const id = req.query.id;
  if (id) {
    const s = campaignEngine.getCampaignStatus(id);
    // Having *a* valid password is not authorization to read *this* campaign.
    // The response carries recipient names, phone numbers, coupon codes and the
    // message bodies, so it must belong to the caller's shop.
    if (s && s.shop !== shop) return res.json({ ok: false, error: "not found" });
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
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const result = campaignEngine.stopCampaign(req.body.id, shop);
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    // Scoped by shop: plan and task ids are sequential, so without this any
    // merchant could preview another merchant's plan and see its recipients.
    const tasksR = await db.query(
      `SELECT * FROM agent_tasks WHERE plan_id=$1 AND id = ANY($2) AND shop_domain=$3 ORDER BY priority ASC`,
      [plan_id, selected_task_ids, shop]
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
    res.status(500).json({ ok: false, error: safeError(err) });
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

    // OWNERSHIP. The sibling endpoints were scoped by shop and this one was
    // missed — and it is the dangerous one. agent_plans.id is a global BIGSERIAL,
    // so without this any merchant could count to another merchant's plan id,
    // flip it to send_mode='auto' (the setting that makes the agent message real
    // customers with no human review) and launch it against THEIR customer list.
    const owns = await db.query(
      `SELECT 1 FROM agent_plans WHERE id=$1 AND shop_domain=$2`, [plan_id, shop]);
    if (!owns.rows.length) return res.status(404).json({ ok: false, error: "not found" });

    // send_mode decides whether a human reviews anything. Never take it on trust.
    const mode = (send_mode === "auto") ? "auto" : "manual";

    await db.query(`UPDATE agent_tasks SET selected = (id = ANY($2)) WHERE plan_id=$1 AND shop_domain=$3`,
      [plan_id, selected_task_ids, shop]);
    // Persist the merchant's send choice so the engine knows whether to auto-send.
    await db.query(
      `UPDATE agent_plans SET status='approved', approved_at=NOW(),
         send_mode=$2, template_name=$3 WHERE id=$1 AND shop_domain=$4`,
      [plan_id, mode, template_name || null, shop]
    ).catch(async () => {
      // Columns may not exist yet on older tables — add them, then retry.
      await db.query(`ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS send_mode TEXT DEFAULT 'manual'`).catch(()=>{});
      await db.query(`ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS template_name TEXT`).catch(()=>{});
      await db.query(`UPDATE agent_plans SET status='approved', approved_at=NOW(), send_mode=$2, template_name=$3 WHERE id=$1 AND shop_domain=$4`,
        [plan_id, mode, template_name || null, shop]).catch(()=>{});
    });

    agentEngine.startPlan(shop, plan_id);
    res.json({ ok: true, started: true, plan_id });
  } catch (err) {
    console.error("Approve plan error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.get("/api/agent/plan-status", async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const status = await agentEngine.getPlanStatus(req.query.plan_id, shop);
  if (!status) return res.json({ ok: false, error: "not found" });
  res.json({ ok: true, ...status });
});

app.post("/api/agent/stop-plan", express.json(), async (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(401).json({ error: "גישה נדחתה" });
  const result = await agentEngine.stopPlan(req.body.plan_id, shop);
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
       FROM agent_tasks WHERE plan_id=$1 AND shop_domain=$2 ORDER BY priority ASC`, [plan_id, shop]);
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

    const result = await aiBrain.askBrain(shop, storeBrand(shop), prompt, []);
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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

    // Which channels did the merchant pick? Default: WhatsApp if phone, else email.
    const chans = Array.isArray(req.body.channels) && req.body.channels.length
      ? req.body.channels
      : (hasPhone ? ['whatsapp'] : ['email']);

    // Opt-out gate once (covers Flashy-imported + local opt-outs).
    if (await compliance.isOptedOut(shop, { email, phone })) {
      return res.json({ ok: false, blocked: true, reason: "opted_out",
        detail: "הלקוחה ביקשה לא לקבל הודעות. לא ניתן לפנות אליה." });
    }

    result.steps.channels = {};
    let didSomething = false;

    // ---- WhatsApp: prepare a ready link for manual send ----
    if (chans.includes('whatsapp') && hasPhone) {
      let waPhone = String(phone).replace(/[^0-9]/g, "");
      if (waPhone.startsWith("0")) waPhone = "972" + waPhone.slice(1);
      const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(finalBody)}`;
      result.steps.channels.whatsapp = { channel: "whatsapp", ready_link: waUrl, note: "לחץ לשליחה ב-WhatsApp" };
      result.steps.message = result.steps.channels.whatsapp; // backward-compat
      didSomething = true;
      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, action_type || 'whatsapp_prepared', email || null, phone, JSON.stringify({ channel: 'whatsapp', subject: message_subject, customer_name: customer_name || null }), couponCode]
      ).catch(e => console.error("log:", e.message));
    }

    // ---- SMS: send automatically via TextMe ----
    if (chans.includes('sms') && hasPhone && smsSender.isConfigured()) {
      const smsRes = await smsSender.sendOne(shop, { phone, message: finalBody });
      result.steps.channels.sms = { channel: "sms", ok: smsRes.ok, error: smsRes.error || null };
      if (smsRes.ok) {
        didSomething = true;
        await db.query(
          `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [shop, action_type || 'sms_sent', email || null, phone, JSON.stringify({ channel: 'sms', customer_name: customer_name || null }), couponCode]
        ).catch(e => console.error("log:", e.message));
      }
    }

    // ---- Email: send automatically ----
    if (chans.includes('email') && email) {
      const gate = await compliance.canContactCustomer(shop, { email, phone });
      if (gate.allowed) {
        const html = mailer.buildHtmlEmail(finalBody, { cta_url, cta_label, brand: storeBrand(shop), to: email, shop });
        const sent = await mailer.sendEmail({ to: email, subject: message_subject || ("הודעה מ-" + storeBrand(shop)), html, text: finalBody, fromName: storeBrand(shop) });
        result.steps.channels.email = { channel: "email", ok: sent.ok, error: sent.error || null, id: sent.id || null };
        if (sent.ok) {
          didSomething = true;
          await db.query(
            `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [shop, action_type || 'email_sent', email, phone || null, JSON.stringify({ channel: 'email', subject: message_subject, customer_name: customer_name || null }), couponCode]
          ).catch(e => console.error("log:", e.message));
        }
      } else {
        result.steps.channels.email = { channel: "email", ok: false, blocked: true, reason: gate.reason, detail: gate.detail };
      }
    }

    if (!didSomething) {
      return res.status(400).json({ ok: false, error: "לא נשלח בשום ערוץ (בדוק שבחרת ערוץ מתאים ושיש פרטי קשר)", steps: result.steps });
    }

    res.json(result);
  } catch (err) {
    console.error("Action execute error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.post("/api/action/build-cart", express.json(), async (req, res) => {
  try {
    const {
      password, email, phone, customer_name,
      items, discount_percentage,
      message_subject, message_body, channels
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

    // Which channels did the merchant pick? (WhatsApp = manual link; Email + SMS
    // send automatically.) Default keeps the old behavior when nothing is passed.
    const chans = Array.isArray(channels) && channels.length
      ? channels
      : (hasPhone ? ['whatsapp'] : ['email']);

    result.steps.channels = {};
    let didSomething = false;

    // ---- WhatsApp: prepare a ready link for manual send ----
    if (chans.includes('whatsapp') && hasPhone) {
      let waPhone = String(phone).replace(/[^0-9]/g, "");
      if (waPhone.startsWith("0")) waPhone = "972" + waPhone.slice(1);
      const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(finalBody)}`;
      result.steps.channels.whatsapp = { channel: "whatsapp", ready_link: waUrl };
      result.steps.message = result.steps.channels.whatsapp; // backward-compat for old UI
      didSomething = true;
    }

    // ---- SMS: send the cart automatically via TextMe ----
    if (chans.includes('sms') && hasPhone && smsSender.isConfigured()) {
      const smsRes = await smsSender.sendOne(shop, { phone, message: finalBody });
      result.steps.channels.sms = { channel: "sms", ok: smsRes.ok, error: smsRes.error || null };
      if (smsRes.ok) didSomething = true;
    }

    // ---- Email: send automatically ----
    if (chans.includes('email') && email) {
      const gate = await compliance.canContactCustomer(shop, { email, phone });
      if (gate.allowed) {
        const html = mailer.buildHtmlEmail(message_body || "הכנו לך עגלה אישית!", {
          cta_url: linkForMessage, cta_label: "לעגלה שלך", brand: storeBrand(shop), to: email, shop
        });
        const sent = await mailer.sendEmail({ to: email, subject: message_subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody, fromName: storeBrand(shop) });
        result.steps.channels.email = { channel: "email", ok: sent.ok, error: sent.error || null, id: sent.id || null };
        if (sent.ok) { didSomething = true; if (!result.steps.message) result.steps.message = result.steps.channels.email; }
      } else {
        result.steps.channels.email = { channel: "email", ok: false, blocked: true, reason: gate.reason, detail: gate.detail };
      }
    }

    if (!didSomething) {
      return res.status(400).json({ ok: false, error: "לא נשלח בשום ערוץ (בדוק שבחרת ערוץ ושיש פרטי קשר)", steps: result.steps });
    }

    await db.query(
      `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
       VALUES ($1, 'personalized_cart', $2, $3, $4, $5)`,
      [shop, email || null, phone || null, JSON.stringify({ draft_order_id: draft.draft_order_id, total: draft.total, customer_name: customer_name || null }), cartCoupon]
    ).catch(e => console.error("log:", e.message));

    res.json(result);
  } catch (err) {
    console.error("Build cart error:", err);
    res.status(500).json({ ok: false, error: safeError(err) });
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
            const sent = await mailer.sendEmail({ to: email, subject: cart.subject || "הכנו לך משהו מיוחד 🛍️", html, text: finalBody, fromName: storeBrand(shop) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.get("/admin/sync-products", async (req, res) => {
  const password = req.query.password;
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "גישה נדחתה" });
  }
  try {
    const result = await shopify.syncProducts(resolveShop(req) || DEFAULT_SHOP);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ error: safeError(err) });
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
          results.push({ error: safeError(err), garment_url: gUrl, category: cat });
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
    res.status(500).json({ error: safeError(err) });
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
        stepResults.push({ step: i + 1, error: safeError(err), garment_url: garmentUrls[i] });
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
    res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ error: safeError(e) });
  }
});

// Was an unauthenticated open proxy: `?url=` was fetched verbatim and the body
// returned. That is server-side request forgery — anyone could point it at
// internal Railway services, at cloud metadata endpoints, or use our IP and
// bandwidth to fetch arbitrary content. It now only proxies the media hosts the
// try-on pipeline actually returns, over https, and never follows redirects
// (which would let an allowed host bounce the request somewhere internal).
const VIDEO_PROXY_HOSTS = new Set([
  "rundiffusion-fal.s3.amazonaws.com",
  "v3.fal.media",
  "fal.media",
  "storage.googleapis.com",
  "replicate.delivery",
  "api.runpod.ai"
]);

app.get("/api/tryon/video-proxy", async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: "Missing url" });
    let target;
    try { target = new URL(String(raw)); }
    catch (e) { return res.status(400).json({ error: "Invalid url" }); }

    if (target.protocol !== "https:") return res.status(400).json({ error: "https only" });
    const host = target.hostname.toLowerCase();
    const allowed = VIDEO_PROXY_HOSTS.has(host) ||
      [...VIDEO_PROXY_HOSTS].some(h => host.endsWith("." + h));
    if (!allowed) return res.status(403).json({ error: "Host not allowed" });

    const videoRes = await fetch(target.toString(), { redirect: "error" });
    if (!videoRes.ok) return res.status(502).json({ error: "Failed to fetch video" });
    res.setHeader("Content-Type", "video/mp4");
    const buffer = await videoRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error("video-proxy:", e.message);
    res.status(500).json({ error: "proxy_failed" });
  }
});

// ===== GDPR / Privacy compliance webhooks (App Store MANDATORY) =====
// Shopify sends three topics (x-shopify-topic header). We must ACTUALLY act:
//   customers/data_request — merchant must supply the customer's data: we log a
//     structured request row so the merchant can be provided the export.
//   customers/redact — delete/anonymize everything we hold about that customer.
//   shop/redact — sent 48h after uninstall: delete ALL data for that shop.
app.post("/webhooks/compliance", express.raw({ type: "*/*" }), verifyShopifyWebhook, async (req, res) => {
  const topic = req.headers["x-shopify-topic"] || "";
  const body = req.body || {};
  const shop = (body.shop_domain || "").toLowerCase();
  console.log(`🔒 [GDPR] ${topic} for ${shop}`);
  try {
    if (topic === "customers/redact") {
      const email = (body.customer && body.customer.email) || null;
      const phone = (body.customer && body.customer.phone) || null;
      const cid = (body.customer && String(body.customer.id)) || null;
      let removed = 0;
      const run = async (sql, params) => {
        const r = await db.query(sql, params).catch(e => { console.error("[GDPR] redact:", e.message); return { rowCount: 0 }; });
        removed += r.rowCount || 0;
      };

      if (cid) {
        await run(`DELETE FROM store_customers WHERE shop_domain=$1 AND shopify_customer_id=$2`, [shop, cid]);
        // Order rows carry the customer inside raw_data — the full Shopify order
        // JSON, with name, email and shipping address. Deleting the customer row
        // while leaving that behind is not erasure. Orders themselves are the
        // merchant's financial record, so the PII is stripped and the row kept.
        await run(`UPDATE store_orders SET raw_data = NULL WHERE shop_domain=$1 AND shopify_customer_id=$2`, [shop, cid]);
        await run(`DELETE FROM customer_profiles WHERE shop_domain=$1 AND store_customer_id=$2`, [shop, cid]);
      }
      if (email) {
        await run(`DELETE FROM store_customers WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        await run(`UPDATE advisor_actions SET target_email=NULL, target_phone=NULL, details = details - 'name' WHERE shop_domain=$1 AND LOWER(target_email)=LOWER($2)`, [shop, email]);
        // Cancelling a queued message leaves its body, name and address in the
        // row. Clear those too.
        await run(`UPDATE scheduled_messages SET status='cancelled', message='', subject=NULL, name=NULL, email=NULL, phone=NULL
                    WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        await run(`DELETE FROM incoming_messages WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        await run(`DELETE FROM abandoned_checkouts WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        await run(`DELETE FROM message_clicks WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        await run(`DELETE FROM tryfit_consenting_customers WHERE shop_domain=$1 AND LOWER(email)=LOWER($2)`, [shop, email]);
        // Chat transcripts quote customer names and addresses back to the
        // merchant, so a conversation mentioning this person still holds their
        // data. Drop any conversation that references the address.
        await run(`DELETE FROM chat_conversations WHERE shop_domain=$1 AND messages::text ILIKE '%' || $2 || '%'`, [shop, email]);
      }
      if (phone) {
        const digits = String(phone).replace(/[^0-9]/g, "");
        if (digits.length >= 7) {
          await run(`UPDATE advisor_actions SET target_phone=NULL WHERE shop_domain=$1 AND regexp_replace(COALESCE(target_phone,''),'[^0-9]','','g') = $2`, [shop, digits]);
          await run(`UPDATE scheduled_messages SET status='cancelled', message='', name=NULL, phone=NULL
                      WHERE shop_domain=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') = $2`, [shop, digits]);
          await run(`DELETE FROM incoming_messages WHERE shop_domain=$1 AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') = $2`, [shop, digits]);
        }
      }
      // message_optouts is intentionally KEPT: we must go on remembering that
      // this person asked not to be contacted. Forgetting a suppression entry
      // would mean messaging them again, which is the harm the law is about.
      console.log(`🔒 [GDPR] customers/redact for ${shop}: ${removed} row(s) affected`);

    } else if (topic === "shop/redact") {
      // Full erasure. The previous list covered 10 tables out of 33 and left
      // behind the store row itself — including the Shopify ACCESS TOKEN.
      const tables = [
        "store_customers", "store_orders", "store_order_items", "store_products",
        "advisor_actions", "scheduled_messages", "incoming_messages", "message_optouts",
        "message_clicks", "store_settings", "abandoned_checkouts", "campaign_results",
        "agent_plans", "agent_tasks", "autopilot_runs", "advisor_memory",
        "advisor_credits", "advisor_credit_ledger", "app_subscriptions", "app_usage_charges",
        "dismissed_opportunities", "chat_conversations", "push_subscriptions",
        "data_requests", "data_access_log", "customer_profiles", "consent_records",
        "tryfit_consenting_customers", "tryon_events", "wa_templates", "shops"
      ];
      for (const t of tables) {
        await db.query(`DELETE FROM ${t} WHERE shop_domain=$1`, [shop]).catch(() => { /* table may not exist */ });
      }
      try { await sessionAuth.revokeAllForShop(shop); } catch (e) {}
      // Last: the credential itself.
      try { await shopify.purgeStore(shop); } catch (e) { console.error("[GDPR] purgeStore:", e.message); }
      console.log(`🔒 [GDPR] shop ${shop} fully redacted (${tables.length} tables + credentials)`);

    } else if (topic === "customers/data_request") {
      // Record the request so the merchant can be given the customer's data.
      await db.query(
        `INSERT INTO data_requests (shop_domain, payload, created_at) VALUES ($1, $2, NOW())`,
        [shop, JSON.stringify(body)]
      ).catch(async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS data_requests (id BIGSERIAL PRIMARY KEY, shop_domain TEXT, payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await db.query(`INSERT INTO data_requests (shop_domain, payload, created_at) VALUES ($1, $2, NOW())`, [shop, JSON.stringify(body)]).catch(() => {});
      });
    }
  } catch (e) { console.error("[GDPR] handler error:", e.message); }
  res.status(200).json({ success: true });
});

app.post("/webhooks/app/uninstalled", express.raw({ type: "*/*" }), verifyShopifyWebhook, async (req, res) => {
  const shop = (req.body && req.body.shop_domain || req.body && req.body.domain || "").toLowerCase() ||
               (req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  console.log("App uninstalled:", shop || "unknown");
  // CRITICAL: the moment a shop uninstalls, all outgoing messaging must stop.
  if (shop) {
    await db.query(`UPDATE scheduled_messages SET status='cancelled' WHERE shop_domain=$1 AND status='pending'`, [shop]).catch(() => {});
    // Was guarded with `&&` against a function that did not exist, so this
    // silently did nothing: the access token stayed in our database and the
    // shop stayed "active" to every scheduler. Awaited and unguarded now, so a
    // failure is visible instead of invisible.
    try { await shopify.deactivateStore(shop); }
    catch (e) { console.error("[uninstall] deactivateStore:", e.message); }
    // Autopilot must not resume for a shop that removed the app.
    try { await storeSettings.updateSettings(shop, { autopilot: "off" }); } catch (e) {}
    // Any session held for this shop stops working immediately.
    try { await sessionAuth.revokeAllForShop(shop); } catch (e) {}
  }
  res.status(200).json({ success: true });
});

app.post("/webhooks/app/scopes_update", express.raw({ type: "*/*" }), verifyShopifyWebhook, (req, res) => {
  console.log("Scopes update:", req.body?.shop_domain || "unknown");
  res.status(200).json({ success: true });
});

function handleCheckoutWebhook(req, res) {
  try {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const secret = shopifyAppSecret();
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
    if (!res.headersSent) res.status(500).json({ error: safeError(err) });
  }
}

app.post("/webhooks/checkouts/create", express.raw({ type: "application/json" }), handleCheckoutWebhook);
app.post("/webhooks/checkouts/update", express.raw({ type: "application/json" }), handleCheckoutWebhook);

function handleOrderWebhook(req, res) {
  try {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const secret = shopifyAppSecret();
    const rawBody = req.body;
    if (!hmacHeader || !secret) return res.status(401).json({ error: "Unauthorized" });
    const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (hash !== hmacHeader) {
      console.log("⚠️  [Webhook] Order HMAC mismatch - rejected");
      return res.status(401).json({ error: "Invalid HMAC" });
    }
    res.status(200).json({ success: true });

    // No default shop here. Falling back to the pilot store meant a webhook
    // without the header credited — and would have billed — a merchant who had
    // nothing to do with the order. A webhook we cannot attribute is a webhook
    // we drop.
    const shopDomain = String(req.headers["x-shopify-shop-domain"] || "").toLowerCase().trim();
    if (!isValidShopDomain(shopDomain)) {
      console.warn("⚠️  [Webhook] order webhook with no usable shop domain — ignored");
      return;
    }
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
    if (!res.headersSent) res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
  // NOTE: ?password= used to be honoured here, letting whoever sent the install
  // link choose the merchant's advisor password. /auth is unauthenticated, so
  // anyone could mail a store a crafted link and then log in as them afterwards.
  // The password is always generated here now, and nothing external sets it.
  oauthStates.set(state, { ts: Date.now(), pw: null });
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

    // Pull the shop's real details (name, owner email, country) so onboarding is
    // personal from second one — and the store's language is set automatically:
    // Israeli shops get Hebrew, everyone else English. (Asaf: Hebrew stays sellable.)
    let shopInfo = {};
    try {
      const sRes = await fetch(`https://${shopDomain}/admin/api/2026-01/shop.json`, {
        headers: { "X-Shopify-Access-Token": tokenData.access_token }
      });
      const sData = await sRes.json();
      shopInfo = (sData && sData.shop) || {};
    } catch (e) { /* defaults below */ }

    const displayName = shopInfo.name || shopDomain.replace(".myshopify.com", "");
    const ownerEmail = shopInfo.email || shopInfo.customer_email || null;
    const isIsraeli = (shopInfo.country_code === "IL") ||
                      ((shopInfo.primary_locale || "").toLowerCase().startsWith("he"));

    await shopify.upsertStore({
      shop_domain: shopDomain,
      access_token: tokenData.access_token,
      advisor_password: advisorPassword,
      display_name: displayName,
      owner_email: ownerEmail,
      public_domain: shopInfo.domain || null
    });

    // Per-shop defaults: brand from the real shop name, language by country,
    // currency accordingly, daily smart-outreach cap 500.
    //
    // The timezone matters more than it looks: every send decision is made in
    // it. Shopify gives us the IANA zone (`iana_timezone`) alongside a display
    // string (`timezone`) that Intl cannot parse — only the former is usable.
    // Without it a US shop would inherit Israel time and message its customers
    // in the middle of the night.
    const shopTz = storeTime.fromShopifyShop(shopInfo);
    try {
      await storeSettings.updateSettings(shopDomain, {
        brand: displayName,
        language: isIsraeli ? "he" : "en",
        currency: isIsraeli ? "₪" : "$",
        daily_cap: 500,
        timezone: shopTz || storeTime.DEFAULT_TZ
      });
      console.log(`[OAuth] ${shopDomain} timezone = ${shopTz || storeTime.DEFAULT_TZ + " (fallback)"}`);
    } catch (e) { console.error("[OAuth] settings init:", e.message); }

    // Register webhooks (checkouts + orders + uninstalled) for this shop.
    try {
      const topics = [
        { topic: "checkouts/create", address: `${APP_BASE_URL}/webhooks/checkouts/create` },
        { topic: "checkouts/update", address: `${APP_BASE_URL}/webhooks/checkouts/update` },
        { topic: "orders/create", address: `${APP_BASE_URL}/webhooks/orders/create` },
        { topic: "app/uninstalled", address: `${APP_BASE_URL}/webhooks/app/uninstalled` }
      ];
      for (const t of topics) {
        await fetch(`https://${shopDomain}/admin/api/2026-01/webhooks.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": tokenData.access_token, "Content-Type": "application/json" },
          body: JSON.stringify({ webhook: { topic: t.topic, address: t.address, format: "json" } })
        }).catch(() => {});
      }
    } catch (e) { console.error("[OAuth] webhook registration:", e.message); }

    // Create the billing subscription now, at install, while we have the
    // merchant's attention.
    //
    // It used to be created only if they happened to notice a card on the home
    // screen, which meant that for most stores the agent worked for free
    // forever — there was no subscription for a usage charge to attach to, and
    // every charge came back 'no_subscription'. Shopify also expects the money
    // conversation to happen at install, not to be discovered later.
    //
    // Approving it is still their decision — this only produces the URL where
    // they can. The agent runs either way; it just cannot bill until they do.
    let billingUrl = null;
    try {
      const sub = await billing.startSubscription(shopDomain, {
        currency: isIsraeli ? "ILS" : "USD"
      });
      billingUrl = sub && sub.confirmationUrl;
      console.log(`[OAuth] ${shopDomain} subscription created (${sub && sub.status})`);
    } catch (e) {
      // Never block an install on billing. A merchant with a working agent and
      // no subscription is recoverable; a failed install is not.
      console.error("[OAuth] startSubscription:", e.message);
    }

    // Personal chat link — the "install and get your agent" moment.
    // A single-use setup link, NOT the password. The old form put the merchant's
    // permanent password in a URL that then lived forever in their mailbox, in
    // the mail provider's logs, in browser history and in every forward.
    // This one logs them in once and is destroyed on use.
    let chatLink = `${APP_BASE_URL}/chat`;
    try {
      const link = await sessionAuth.createSetupLink(shopDomain, { baseUrl: APP_BASE_URL });
      chatLink = link.url;
    } catch (e) {
      console.error("[OAuth] setup link:", e.message);
    }

    // Kick off backfill in the background; when done, email the owner that the
    // team is ready, with their personal link.
    backfillStatus[shopDomain] = { current_phase: "starting", started_at: new Date().toISOString() };
    setImmediate(async () => {
      try {
        const result = await shopify.backfillEntireShop(shopDomain, (progress) => {
          backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], current_phase: progress.phase, ...(progress.stats || {}) };
        });
        backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], ...result };
        // "Your team is ready" email (bilingual by shop language).
        if (ownerEmail) {
          const he = isIsraeli;
          const subject = he ? `הצוות של ${displayName} מוכן לעבודה 🎉` : `Your ${displayName} sales team is ready 🎉`;
          // The password is deliberately NOT in this email. It was shown once on
          // the install success page; mailing it would leave a permanent copy in
          // the merchant's inbox and in the mail provider's logs. The link below
          // is single-use and expires on its own.
          const bodyTxt = he
            ? `היי!\n\nסיימנו לנתח את החנות שלך. דניאל (האנליסט), מאיה (המכירות) ונועה (השירות) מוכנים.\n\nהקישור הבא יכניס אותך פעם אחת — שמור את הסיסמה שהוצגה לך בסיום ההתקנה:\n${chatLink}\n\nנתראה בפנים,\nSmart Advisor`
            : `Hi!\n\nWe finished analyzing your store. Daniel (analyst), Maya (sales) and Noa (support) are ready to work.\n\nThe link below signs you in once — keep the password you were shown at the end of setup:\n${chatLink}\n\nSee you inside,\nSmart Advisor`;
          // language was missing, so an English merchant got their welcome mail
          // laid out right-to-left with a Hebrew footer. transactional keeps the
          // unsubscribe link off it — this is their account mail, not marketing.
          const html = mailer.buildHtmlEmail(bodyTxt, {
            cta_url: chatLink, cta_label: he ? "לצ'אט האישי שלך ←" : "Open your chat →",
            brand: displayName, to: ownerEmail, language: he ? 'he' : 'en', transactional: true
          });
          // fromName was missing, so a brand-new merchant received their welcome
          // email from the FIRST store's name. Every outbound mail carries the
          // identity of the shop it belongs to.
          await mailer.sendEmail({ to: ownerEmail, subject, html, text: bodyTxt, fromName: displayName }).catch(() => {});
        }
      } catch (err) {
        backfillStatus[shopDomain] = { ...backfillStatus[shopDomain], success: false, fatal_error: safeError(err) };
      }
    });

    // Success page for the merchant — bilingual, with the DIRECT chat link.
    const hePage = isIsraeli;
    res.send(`<!DOCTYPE html><html dir="${hePage ? 'rtl' : 'ltr'}" lang="${hePage ? 'he' : 'en'}"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${hePage ? 'החיבור הצליח' : 'Connected!'}</title></head>
      <body style="font-family:Arial,sans-serif;background:#f5f6f8;margin:0;padding:40px 20px;text-align:center;">
        <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:40px 28px;box-shadow:0 4px 20px rgba(0,0,0,.08);">
          <div style="font-size:48px;">🎉</div>
          <h1 style="font-size:22px;color:#111;">${hePage ? `${displayName} מחוברת!` : `${displayName} is connected!`}</h1>
          <p style="color:#444;line-height:1.7;">${hePage
            ? 'הצוות שלך — דניאל, מאיה ונועה — מתחיל עכשיו לנתח את החנות (לקוחות והזמנות). זה ייקח כמה דקות, ונשלח לך מייל כשהכל מוכן.'
            : 'Your team — Daniel, Maya and Noa — is now analyzing your store (customers & orders). This takes a few minutes; we will email you when everything is ready.'}</p>
          <a href="${chatLink}" style="display:inline-block;background:#0a6fe0;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:12px;margin:10px 0;">${hePage ? "לצ'אט האישי שלך ←" : 'Open your personal chat →'}</a>
          <p style="color:#444;line-height:1.7;margin-top:14px;">${hePage ? 'סיסמת הכניסה שלך:' : 'Your password:'}</p>
          <div style="font-size:20px;font-weight:800;letter-spacing:1px;background:#f0f4ff;color:#0a6fe0;padding:12px;border-radius:10px;">${advisorPassword}</div>
          <p style="color:#888;font-size:13px;margin-top:18px;">${hePage
            ? 'שמור את הסיסמה עכשיו — היא מוצגת פעם אחת בלבד ולא נשלחת במייל.'
            : 'Save this password now — it is shown once and is never emailed.'}</p>
          ${billingUrl ? `<div style="border-top:1px solid #eceff3;margin-top:22px;padding-top:20px;text-align:${hePage ? 'right' : 'left'};">
            <div style="font-weight:700;color:#111;margin-bottom:6px;">${hePage ? 'שלב אחרון: אישור התמחור' : 'Last step: approve the pricing'}</div>
            <p style="color:#5b6472;font-size:14px;line-height:1.7;margin:0 0 12px;">${hePage
              ? `${Math.round(billing.COMMISSION_RATE * 100)}% ממכירות שהסוכן הוכיח שהוא יצר — קוד קופון שנוצל, סל שהוא בנה, או קליק במעקב שהסתיים ברכישה. על כל השאר לא משלמים. ${billing.TRIAL_DAYS} ימי ניסיון, ותקרה חודשית שאתה מאשר מראש.`
              : `${Math.round(billing.COMMISSION_RATE * 100)}% of sales the agent can prove it generated — a redeemed coupon, a cart it built, or a tracked click that ended in a purchase. Nothing for anything else. ${billing.TRIAL_DAYS}-day trial, and a monthly cap you approve up front.`}</p>
            <a href="${billingUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;">${hePage ? 'לאישור התמחור ←' : 'Review & approve →'}</a>
          </div>` : ''}
        </div>
      </body></html>`);
  } catch (err) {
    console.error("[OAuth] callback error:", err);
    res.status(500).send("שגיאה בחיבור. נסה שוב או פנה אלינו.");
  }
});

app.get("/admin/list-stores", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  // MASTER VIEW: every store with its settings (language/brand/sender), today's
  // smart-outreach usage vs cap, and WhatsApp credit balance — one control panel.
  const stores = shopify.listStores();
  const enriched = [];
  for (const s of stores) {
    const row = { ...s };
    delete row.access_token; // never expose tokens in the master list
    try { row.settings = await storeSettings.getSettings(s.shop_domain); } catch (e) { row.settings = null; }
    try { row.today = await storeSettings.remainingToday(s.shop_domain); } catch (e) { row.today = null; }
    try { row.wa_credits = await creditsEngine.getBalance(s.shop_domain); } catch (e) { row.wa_credits = null; }
    enriched.push(row);
  }
  res.json({ ok: true, stores: enriched });
});

// Master: update any store's settings (brand/language/sender/cap/autopilot).
// POST /admin/store-settings?password=MASTER  { shop, brand?, language?, ... }
app.post("/admin/store-settings", express.json(), async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "סיסמה שגויה" });
  const shop = (req.body.shop || "").toLowerCase().trim();
  if (!shop) return res.status(400).json({ ok: false, error: "חסר shop" });
  const patch = {};
  for (const k of ["brand", "language", "currency", "sms_sender", "daily_cap", "autopilot", "followup_default", "timezone", "whatsapp_enabled"]) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  res.json(await storeSettings.updateSettings(shop, patch));
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
    res.status(500).json({ ok: false, error: safeError(err) });
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
      results.push({ topic: t.topic, error: safeError(err) });
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
      // Seal any credential still stored in plaintext, then load. Order matters:
      // migrate first so the cache is filled from the encrypted rows.
      await shopify.migrateSecretsToVault().catch(e => console.error("[vault]", e.message));
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

  // Reports fire at 09:00 and 21:00 in EACH STORE'S OWN local time. Previously
  // both fired at Israel's clock, so a US merchant's "what happened overnight"
  // brief was generated at 2 AM their time and their end-of-day report at 2 PM.
  // Fired-once bookkeeping is therefore per shop, keyed on the shop's local date.
  const lastReport = new Map(); // `${shop}|${slot}` -> local date string
  async function runReportSlot(shop, slot, actionType, kind) {
    const tz = await storeTime.tzForShop(shop);
    const hour = storeTime.hourIn(tz);
    if (hour !== slot) return false;
    const localDate = storeTime.dateKeyIn(tz);
    const key = `${shop}|${slot}`;
    if (lastReport.get(key) === localDate) return false;
    lastReport.set(key, localDate);
    const summary = await dailySummary.getDailySummary(shop);
    await db.query(
      `INSERT INTO advisor_actions (shop_domain, action_type, details)
       VALUES ($1, $2, $3)`,
      [shop, actionType, JSON.stringify({ report: summary, date: localDate, kind, timezone: tz })]
    ).catch(e => console.error(`${actionType} log:`, e.message));
    console.log(`${slot === 9 ? "🌅" : "📋"} [${actionType}] ${shop} for ${localDate} (${slot}:00 ${tz})`);
    return true;
  }

  setInterval(async () => {
    for (const shop of allActiveShops()) {
      if (!shopify.hasTokenForShop(shop)) continue;
      try {
        await runReportSlot(shop, 9, "morning_report", "overnight");
        await runReportSlot(shop, 21, "daily_report", "end_of_day");
      } catch (e) {
        console.error(`report scheduler (${shop}):`, e.message);
      }
    }
  }, 60 * 1000);
  console.log("📋 Reports scheduled (09:00 overnight + 21:00 end-of-day, each store's local time)");

  // AUTOPILOT. Ticks every minute but does nothing for almost all of them: each
  // shop acts only when its OWN local clock hits the run hour, and only if its
  // owner turned autopilot on. Shops left on 'approve' are untouched.
  // Expired sessions are dead rows that only grow. Nothing was ever removing
  // them, so the table would keep every login any merchant ever made.
  const purgeSessions = async () => {
    try {
      const n = await sessionAuth.purgeExpired();
      if (n) console.log(`🧹 [sessions] purged ${n} expired`);
    } catch (e) { console.error("[sessions] purge:", e.message); }
  };
  setTimeout(purgeSessions, 60000);
  setInterval(purgeSessions, 6 * 60 * 60 * 1000);

  autopilot.ensureTable().catch(() => {});
  setInterval(async () => {
    try {
      await autopilot.tick(allActiveShops().filter(s => shopify.hasTokenForShop(s)));
    } catch (e) {
      console.error("autopilot tick:", e.message);
    }
  }, 60 * 1000);
  console.log(`🤖 Autopilot scheduled (${autopilot.RUN_HOUR}:00 each store's local time, only where enabled)`);

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

    // ========== Billing sweep (every 15 minutes) ==========
    // Attribution credits sales; this is what charges for them. It is a separate
    // pass on purpose: the webhook and the scan both close sales, and billing
    // inside either one meant the other path collected nothing. Reading the
    // state instead of hooking the event makes it impossible to miss a sale
    // because the wrong path got there first.
    //
    // Slower than the scan because each item costs a Shopify order lookup (to
    // confirm the money actually arrived) and nothing is time-critical: usage
    // records are settled by Shopify on the merchant's billing cycle.
    let sweepRunning = false;
    const runSweep = async () => {
      if (sweepRunning) return;
      sweepRunning = true;
      try {
        const shops = allActiveShops().filter(s => shopify.hasTokenForShop(s));
        await billing.sweepAll(shops);
      } catch (e) {
        console.error("⚠️  [billing] scheduled sweep failed:", e.message);
      } finally {
        sweepRunning = false;
      }
    };
    setTimeout(runSweep, 240000); // 4 min after startup, behind the first scan
    setInterval(runSweep, 15 * 60 * 1000);
    console.log("💳 Billing sweep scheduled (every 15 min, all stores)");
  }

  agentEngine.resumeInterruptedPlans();
  // Message queue: smart-timing sends + follow-up sequences (DB-backed, survives redeploys).
  messageQueue.startScheduler();
  noaEngine.ensureTable().catch(() => {});

  console.log("---\n");
});