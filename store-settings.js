// ============================================================================
// STORE SETTINGS — per-shop configuration. The foundation for App Store
// readiness: nothing brand/language/channel-specific may be hardcoded anymore.
//
// Every shop gets: brand name, language (he/en), currency, SMS sender id,
// autopilot mode, and the DAILY smart-outreach cap (default 500/day — every
// outreach must be genuinely smart; the cap bounds both customer annoyance and
// our AI/messaging costs).
//
// Resolution order: store_settings row → shopify.getStore(shop).name → legacy
// defaults (770 for the original pilot shop). Cached for 60s.
// ============================================================================

const db = require('./database');

const DEFAULT_SHOP = 'seven770.myshopify.com';

const DEFAULTS = {
  brand: null,            // resolved below
  language: 'he',         // 'he' | 'en' — existing shops stay Hebrew (Asaf: keep IL version sellable)
  currency: '₪',          // '₪' | '$'
  sms_sender: null,       // per-shop sender id (falls back to env TEXTME_SENDER)
  daily_cap: 500,         // smart outreaches per DAY per shop
  autopilot: 'approve',   // 'off' | 'approve' (morning plan needs a click) | 'full'
  followup_default: true  // sequences on by default
};

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      shop_domain TEXT PRIMARY KEY,
      brand TEXT, language TEXT, currency TEXT,
      sms_sender TEXT, daily_cap INT, autopilot TEXT,
      followup_default BOOLEAN,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[settings] table:', e.message));
  tableReady = true;
}

const cache = new Map(); // shop -> { at, settings }
const TTL = 60 * 1000;

function legacyBrand(shop) {
  if (shop === DEFAULT_SHOP) return '770';
  try {
    const shopify = require('./shopify-client');
    const s = shopify.getStore(shop);
    if (s && s.name) return s.name;
  } catch (e) { /* fall through */ }
  return (shop || '').replace('.myshopify.com', '');
}

async function getSettings(shop) {
  shop = (shop || DEFAULT_SHOP).toLowerCase().trim();
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL) return hit.settings;

  await ensureTable();
  let row = null;
  try {
    const r = await db.query(`SELECT * FROM store_settings WHERE shop_domain=$1`, [shop]);
    row = r.rows[0] || null;
  } catch (e) { /* defaults */ }

  const s = {
    shop,
    brand: (row && row.brand) || legacyBrand(shop),
    language: (row && row.language) || DEFAULTS.language,
    currency: (row && row.currency) || DEFAULTS.currency,
    sms_sender: (row && row.sms_sender) || process.env.TEXTME_SENDER || null,
    daily_cap: (row && row.daily_cap != null) ? row.daily_cap : DEFAULTS.daily_cap,
    autopilot: (row && row.autopilot) || DEFAULTS.autopilot,
    followup_default: (row && row.followup_default != null) ? row.followup_default : DEFAULTS.followup_default
  };
  cache.set(shop, { at: Date.now(), settings: s });
  return s;
}

async function updateSettings(shop, patch = {}) {
  shop = (shop || '').toLowerCase().trim();
  if (!shop) return { ok: false, error: 'no_shop' };
  await ensureTable();
  const allowed = ['brand', 'language', 'currency', 'sms_sender', 'daily_cap', 'autopilot', 'followup_default'];
  const cur = await getSettings(shop);
  const next = { ...cur };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  try {
    await db.query(
      `INSERT INTO store_settings (shop_domain, brand, language, currency, sms_sender, daily_cap, autopilot, followup_default, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (shop_domain) DO UPDATE SET
         brand=$2, language=$3, currency=$4, sms_sender=$5, daily_cap=$6, autopilot=$7, followup_default=$8, updated_at=NOW()`,
      [shop, next.brand, next.language, next.currency, next.sms_sender, next.daily_cap, next.autopilot, next.followup_default]
    );
    cache.delete(shop);
    return { ok: true, settings: await getSettings(shop) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------------------
// DAILY SMART-OUTREACH CAP (500/day default).
// Counts today's outreaches (advisor_actions rows created today, Israel/shop tz
// approximated as UTC day for simplicity) and answers how many are left.
// Both the campaign engine and the message queue must consult this.
// ---------------------------------------------------------------------------
async function outreachesToday(shop) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM advisor_actions
       WHERE shop_domain=$1 AND created_at >= date_trunc('day', NOW())`,
      [shop]);
    return (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) { return 0; }
}

async function remainingToday(shop) {
  const s = await getSettings(shop);
  const used = await outreachesToday(shop);
  return { cap: s.daily_cap, used, remaining: Math.max(0, s.daily_cap - used) };
}

module.exports = { getSettings, updateSettings, remainingToday, outreachesToday, DEFAULT_SHOP };