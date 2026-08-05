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
  language: 'en',         // 'he' | 'en' — English is the default; Israeli installs are switched to 'he' at onboarding
  currency: '$',          // '₪' | '$' — matches the default language
  sms_sender: null,       // per-shop sender id (falls back to env TEXTME_SENDER)
  daily_cap: 500,         // smart outreaches per DAY per shop
  autopilot: 'approve',   // 'off' | 'approve' (morning plan needs a click) | 'full'
  followup_default: true, // sequences on by default
  // IANA zone, captured from Shopify at install. EVERY wall-clock decision
  // (send window, personal best hour, morning report, daily counters) is made
  // in this zone. Existing shops default to the original pilot's zone so their
  // behaviour is unchanged.
  timezone: 'Asia/Jerusalem'
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
  // Added after the table shipped — existing deployments need the column.
  await db.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS timezone TEXT`)
    .catch(e => console.error('[settings] timezone column:', e.message));
  tableReady = true;
}

const cache = new Map(); // shop -> { at, settings }
const TTL = 60 * 1000;

// A stored timezone is only usable if the platform's ICU data knows it —
// otherwise every Intl call downstream would throw at send time.
function validTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  catch (e) { return null; }
}

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
    followup_default: (row && row.followup_default != null) ? row.followup_default : DEFAULTS.followup_default,
    timezone: validTz(row && row.timezone) || DEFAULTS.timezone
  };
  cache.set(shop, { at: Date.now(), settings: s });
  return s;
}

async function updateSettings(shop, patch = {}) {
  shop = (shop || '').toLowerCase().trim();
  if (!shop) return { ok: false, error: 'no_shop' };
  await ensureTable();
  const allowed = ['brand', 'language', 'currency', 'sms_sender', 'daily_cap', 'autopilot', 'followup_default', 'timezone'];
  const cur = await getSettings(shop);
  const next = { ...cur };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  // Never persist a timezone Intl cannot resolve — it would break every send.
  next.timezone = validTz(next.timezone) || DEFAULTS.timezone;
  try {
    await db.query(
      `INSERT INTO store_settings (shop_domain, brand, language, currency, sms_sender, daily_cap, autopilot, followup_default, timezone, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (shop_domain) DO UPDATE SET
         brand=$2, language=$3, currency=$4, sms_sender=$5, daily_cap=$6, autopilot=$7, followup_default=$8, timezone=$9, updated_at=NOW()`,
      [shop, next.brand, next.language, next.currency, next.sms_sender, next.daily_cap, next.autopilot, next.followup_default, next.timezone]
    );
    cache.delete(shop);
    return { ok: true, settings: await getSettings(shop) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------------------
// DAILY SMART-OUTREACH CAP (500/day default).
// Counts today's outreaches and answers how many are left. "Today" is the
// STORE's local day, not UTC — otherwise a shop in Los Angeles gets its budget
// reset at 5 PM local, mid-afternoon, and can send 1000 in one working day.
// Both the campaign engine and the message queue must consult this.
// ---------------------------------------------------------------------------
async function outreachesToday(shop) {
  try {
    const s = await getSettings(shop);
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM advisor_actions
       WHERE shop_domain=$1
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2`,
      [shop, s.timezone]);
    return (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) { return 0; }
}

async function remainingToday(shop) {
  const s = await getSettings(shop);
  const used = await outreachesToday(shop);
  return { cap: s.daily_cap, used, remaining: Math.max(0, s.daily_cap - used) };
}

module.exports = { getSettings, updateSettings, remainingToday, outreachesToday, DEFAULT_SHOP };