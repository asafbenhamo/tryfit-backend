// ============================================================================
// STOREFRONT POPUP — how a new store gets a mailing list at all.
//
// The agent is only as good as the list it can write to. A store that installs
// today has whatever customers it already had; this is the thing that grows
// that number every day, from traffic the merchant is already paying for.
//
// It runs on the MERCHANT'S storefront, not in our app: a small script served
// from here, embedded through a Shopify theme app extension, which shows a
// signup panel and posts the address back.
//
// That makes the subscribe endpoint genuinely public and cross-origin — the one
// place in this codebase where anyone on the internet may write. Everything here
// is built around that:
//
//   Consent is the record, not the email. Anti-spam law asks who agreed, when,
//     from where, and to what. A row that holds only an address is not evidence
//     of consent and is worth less than nothing when a complaint arrives, so we
//     store the IP, the user agent, the page, and the exact wording shown.
//
//   Double opt-in is available and off by default. It is the strongest evidence
//     there is, but it costs roughly a third of signups, so it is the merchant's
//     call and not ours to make quietly.
//
//   Anything a stranger can write to gets poisoned. Addresses are validated and
//     length-capped, a honeypot field catches the naive bots, submissions are
//     rate limited per shop and per IP, and a subscription is idempotent so the
//     same address cannot be used to inflate a list or spam a mailbox.
//
//   A popup that shows on every page view is a reason to leave. Frequency is
//     capped client-side and configurable.
// ============================================================================

const crypto = require('crypto');
const db = require('./database');

// Anything longer is not an address, it is an attempt at something.
const MAX_EMAIL = 254;
const MAX_FIELD = 120;

// Deliberately conservative. It is better to reject an exotic-but-valid address
// (the merchant can add it by hand) than to accept junk into a list the agent
// will then mail, because bounces are what get a sending domain blocked.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

const DEFAULTS = {
  enabled: false,           // off until the merchant turns it on
  headline: null,           // null -> the localized default
  subhead: null,
  button_label: null,
  success_text: null,
  incentive: null,          // e.g. "10% off your first order"
  discount_code: null,      // revealed after subscribing, if set
  image_url: null,
  ask_gender: false,        // the Pull&Bear pattern: Woman / Man
  delay_seconds: 6,
  show_after_scroll_pct: 0, // 0 = time-based only
  frequency_days: 14,       // do not ask the same visitor again for N days
  double_opt_in: false,
  consent_text: null        // exactly what the visitor agrees to; stored per signup
};

let tableReady = false;
async function ensureTables() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS popup_settings (
      shop_domain   TEXT PRIMARY KEY,
      enabled       BOOLEAN DEFAULT FALSE,
      config        JSONB DEFAULT '{}'::jsonb,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[popup] settings table:', e.message));

  await db.query(`
    CREATE TABLE IF NOT EXISTS popup_subscribers (
      id            BIGSERIAL PRIMARY KEY,
      shop_domain   TEXT NOT NULL,
      email         TEXT NOT NULL,
      gender        TEXT,
      status        TEXT DEFAULT 'subscribed',  -- subscribed | pending | unsubscribed
      -- The consent record. This is the part that matters if anyone ever asks.
      consent_text  TEXT,
      consent_ip    TEXT,
      consent_ua    TEXT,
      source_url    TEXT,
      confirm_token TEXT,
      confirmed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[popup] subscribers table:', e.message));

  // One row per address per shop. Makes re-subscribing idempotent and stops a
  // bot inflating the count with the same address a thousand times.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_popup_sub
                  ON popup_subscribers (shop_domain, lower(email))`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_popup_sub_shop
                  ON popup_subscribers (shop_domain, created_at DESC)`).catch(() => {});
  tableReady = true;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cache = new Map();          // shop -> { at, cfg }
const TTL = 60 * 1000;

async function getConfig(shop) {
  const key = String(shop || '').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.cfg;
  await ensureTables();
  let row = null;
  try {
    const r = await db.query(`SELECT * FROM popup_settings WHERE shop_domain=$1`, [key]);
    row = r.rows[0] || null;
  } catch (e) { /* defaults */ }
  const cfg = Object.assign({}, DEFAULTS, (row && row.config) || {}, {
    enabled: row ? !!row.enabled : DEFAULTS.enabled,
    shop: key
  });
  cache.set(key, { at: Date.now(), cfg });
  return cfg;
}

const ALLOWED = Object.keys(DEFAULTS);

async function saveConfig(shop, patch = {}) {
  await ensureTables();
  const key = String(shop || '').toLowerCase();
  const current = await getConfig(key);
  const next = Object.assign({}, current);
  for (const k of ALLOWED) {
    if (patch[k] === undefined) continue;
    if (typeof DEFAULTS[k] === 'boolean') next[k] = (patch[k] === true || patch[k] === 'true');
    else if (typeof DEFAULTS[k] === 'number') {
      const n = parseInt(patch[k], 10);
      if (!isNaN(n)) next[k] = Math.max(0, Math.min(n, 365));
    } else {
      const v = patch[k] === null ? null : String(patch[k]).slice(0, 400);
      next[k] = v || null;
    }
  }
  delete next.shop;
  await db.query(
    `INSERT INTO popup_settings (shop_domain, enabled, config, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (shop_domain) DO UPDATE SET enabled=$2, config=$3, updated_at=NOW()`,
    [key, !!next.enabled, JSON.stringify(next)]
  );
  cache.delete(key);
  return getConfig(key);
}

// ---------------------------------------------------------------------------
// Subscribing
// ---------------------------------------------------------------------------
function normalizeEmail(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > MAX_EMAIL) return null;
  if (!EMAIL_RE.test(s)) return null;
  // A dot-less domain is either a typo or a probe; either way we cannot deliver.
  const domain = s.slice(s.lastIndexOf('@') + 1);
  if (!domain.includes('.')) return null;
  return s;
}

// Per-shop and per-IP submission limits, in memory. The window is short and the
// consequence of a restart clearing it is one extra burst, so this does not need
// to survive a redeploy.
const rate = new Map();           // key -> { n, until }
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_PER_SHOP = 300;

function rateHit(key, max) {
  const now = Date.now();
  const cur = rate.get(key);
  if (!cur || now > cur.until) { rate.set(key, { n: 1, until: now + RATE_WINDOW_MS }); return true; }
  if (cur.n >= max) return false;
  cur.n += 1;
  return true;
}

// Returns { ok, status, discount_code? } or { ok:false, error }.
async function subscribe(shop, {
  email, gender = null, consentText = null, ip = null, userAgent = null,
  sourceUrl = null, honeypot = null
} = {}) {
  await ensureTables();
  const key = String(shop || '').toLowerCase();
  if (!key) return { ok: false, error: 'no_shop' };

  // The honeypot is a field a human never sees and never fills. Anything in it
  // is automated. Answer as if it worked — telling a bot it was detected only
  // teaches whoever wrote it to stop filling that field.
  if (honeypot) return { ok: true, status: 'subscribed', decoy: true };

  const addr = normalizeEmail(email);
  if (!addr) return { ok: false, error: 'invalid_email' };

  if (!rateHit('ip:' + (ip || 'none'), MAX_PER_IP)) return { ok: false, error: 'rate_limited' };
  if (!rateHit('shop:' + key, MAX_PER_SHOP)) return { ok: false, error: 'rate_limited' };

  const cfg = await getConfig(key);
  const needsConfirm = !!cfg.double_opt_in;
  const token = needsConfirm ? crypto.randomBytes(24).toString('base64url') : null;
  const status = needsConfirm ? 'pending' : 'subscribed';
  const g = (gender === 'woman' || gender === 'man') ? gender : null;

  try {
    // ON CONFLICT so a second submission of the same address is not an error and
    // not a duplicate — but it must not silently resurrect someone who has since
    // unsubscribed, so that case is left alone.
    const r = await db.query(
      `INSERT INTO popup_subscribers
         (shop_domain, email, gender, status, consent_text, consent_ip, consent_ua, source_url, confirm_token,
          confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (shop_domain, lower(email)) DO UPDATE
          SET gender = COALESCE(EXCLUDED.gender, popup_subscribers.gender)
        WHERE popup_subscribers.status <> 'unsubscribed'
       RETURNING id, status`,
      [key, addr, g, status,
       consentText ? String(consentText).slice(0, 400) : null,
       ip ? String(ip).slice(0, 64) : null,
       userAgent ? String(userAgent).slice(0, MAX_FIELD * 2) : null,
       sourceUrl ? String(sourceUrl).slice(0, 400) : null,
       token, needsConfirm ? null : new Date()]
    );
    // No row back means they had unsubscribed. Honour that silently: the
    // visitor sees success, and we do not start mailing someone who opted out.
    if (!r.rows[0]) return { ok: true, status: 'subscribed', suppressed: true };

    // Feed the agent's own list too, so a signup is immediately a customer the
    // agent can segment and message — that is the entire point of collecting it.
    if (!needsConfirm) await linkToCustomers(key, addr, g).catch(() => {});

    return {
      ok: true,
      status: r.rows[0].status,
      confirm_token: token,
      discount_code: (!needsConfirm && cfg.discount_code) ? cfg.discount_code : null
    };
  } catch (e) {
    console.error('[popup] subscribe:', e.message);
    return { ok: false, error: 'server_error' };
  }
}

// Confirm a double opt-in signup.
async function confirm(shop, token) {
  await ensureTables();
  if (!token) return { ok: false, error: 'invalid' };
  const r = await db.query(
    `UPDATE popup_subscribers
        SET status='subscribed', confirmed_at=NOW(), confirm_token=NULL
      WHERE shop_domain=$1 AND confirm_token=$2 AND status='pending'
      RETURNING email, gender`,
    [String(shop || '').toLowerCase(), String(token)]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return { ok: false, error: 'invalid' };
  await linkToCustomers(String(shop).toLowerCase(), r.rows[0].email, r.rows[0].gender).catch(() => {});
  const cfg = await getConfig(shop);
  return { ok: true, email: r.rows[0].email, discount_code: cfg.discount_code || null };
}

// A subscriber who is not yet a customer still needs to exist in store_customers
// for the agent to segment and contact them. marketing_consent is TRUE because
// they just gave it, explicitly, on the merchant's own site.
async function linkToCustomers(shop, email, gender) {
  await db.query(
    `INSERT INTO store_customers (shop_domain, email, marketing_consent, marketing_consent_updated_at, last_synced_at)
     VALUES ($1,$2,TRUE,NOW(),NOW())
     ON CONFLICT DO NOTHING`,
    [shop, email]
  ).catch(e => {
    // The table's unique key differs across deployments; a failure here must
    // never lose the subscriber, who is already safely in popup_subscribers.
    if (!/duplicate|unique|conflict/i.test(e.message)) console.error('[popup] link:', e.message);
  });
}

async function stats(shop) {
  await ensureTables();
  const key = String(shop || '').toLowerCase();
  const r = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='subscribed')::int AS subscribed,
            COUNT(*) FILTER (WHERE status='pending')::int AS pending,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND status='subscribed')::int AS week,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days' AND status='subscribed')::int AS month
       FROM popup_subscribers WHERE shop_domain=$1`, [key]
  ).catch(() => ({ rows: [{}] }));
  return Object.assign({ subscribed: 0, pending: 0, week: 0, month: 0 }, r.rows[0] || {});
}

module.exports = {
  ensureTables, getConfig, saveConfig, subscribe, confirm, stats,
  normalizeEmail, DEFAULTS, MAX_PER_IP, MAX_PER_SHOP
};
