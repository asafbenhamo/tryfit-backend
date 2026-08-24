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
  // WhatsApp costs real money per message and is billed against credits the
  // merchant buys up front, so it is OFF until they deliberately turn it on.
  // Email and SMS are always available and need no opt-in.
  whatsapp_enabled: false,
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
      setup_completed_at TIMESTAMPTZ,
      followup_default BOOLEAN,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[settings] table:', e.message));
  // Added after the table shipped — existing deployments need the column.
  await db.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS timezone TEXT`)
    .catch(e => console.error('[settings] timezone column:', e.message));
  // Set once the merchant has been through first-run setup. Null means they
  // never have — which is how a brand-new store ended up being offered an SMS
  // channel it had never been asked to configure.
  await db.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ`)
    .catch(e => console.error('[settings] setup_completed_at column:', e.message));
  // ISO country of the store, captured from Shopify at install. Twilio needs it
  // to expand a LOCAL customer phone ("054...") into E.164 — without it, a
  // number that is not already international simply cannot be delivered to.
  await db.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS country_code TEXT`)
    .catch(e => console.error('[settings] country_code column:', e.message));
  await db.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT FALSE`)
    .catch(e => console.error('[settings] whatsapp_enabled column:', e.message));
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
  let row = null, read = true;
  try {
    const r = await db.query(`SELECT * FROM store_settings WHERE shop_domain=$1`, [shop]);
    row = r.rows[0] || null;
  } catch (e) {
    // "the database is down" and "this shop has no row yet" both used to end up
    // here as an identical bag of defaults. They are not the same: the defaults
    // include a TIMEZONE, and handing a US store Asia/Jerusalem because a query
    // failed means messaging its customers at two in the morning. Flag it so
    // callers that care about the difference can tell.
    read = false;
    console.error('[settings] read failed for', shop, '-', e.message);
  }

  const s = {
    shop,
    // false = these values are guesses because the read failed, not the store's
    // actual configuration.
    resolved: read,
    brand: (row && row.brand) || legacyBrand(shop),
    language: (row && row.language) || DEFAULTS.language,
    currency: (row && row.currency) || DEFAULTS.currency,
    // The env sender belongs to the ORIGINAL pilot shop and is verified with the
    // SMS provider under that brand. Falling back to it for every shop meant a
    // newly-installed store's customers would receive texts signed "770" — an
    // unrelated brand they never bought from. Each shop must have its own
    // approved sender; without one, SMS is simply unavailable to it and the
    // channel router falls through to email.
    sms_sender: (row && row.sms_sender) || (shop === DEFAULT_SHOP ? (process.env.TEXTME_SENDER || null) : null),
    daily_cap: (row && row.daily_cap != null) ? row.daily_cap : DEFAULTS.daily_cap,
    autopilot: (row && row.autopilot) || DEFAULTS.autopilot,
    followup_default: (row && row.followup_default != null) ? row.followup_default : DEFAULTS.followup_default,
    timezone: validTz(row && row.timezone) || DEFAULTS.timezone,
    whatsapp_enabled: (row && row.whatsapp_enabled != null) ? row.whatsapp_enabled : DEFAULTS.whatsapp_enabled,
    setup_completed_at: (row && row.setup_completed_at) || null,
    country_code: (row && row.country_code) || null
  };
  // Never cache a failed read — the next call should try again rather than
  // serve guesses for a minute.
  if (read) cache.set(shop, { at: Date.now(), settings: s });
  return s;
}

// Record that the merchant has been through first-run setup.
//
// Deliberately separate from updateSettings: completing setup is an event, not
// a field the merchant edits. Keeping it out of the allowed-keys list means a
// POST /api/settings can never mark itself complete by accident.
async function markSetupComplete(shop) {
  shop = (shop || '').toLowerCase().trim();
  if (!shop) return { ok: false, error: 'no_shop' };
  await ensureTable();
  try {
    await db.query(
      `INSERT INTO store_settings (shop_domain, setup_completed_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (shop_domain) DO UPDATE SET setup_completed_at = NOW(), updated_at = NOW()`,
      [shop]
    );
    cache.delete(shop);
    return { ok: true };
  } catch (e) {
    console.error('[settings] markSetupComplete failed for', shop, '-', e.message);
    return { ok: false, error: e.message };
  }
}

async function updateSettings(shop, patch = {}) {
  shop = (shop || '').toLowerCase().trim();
  if (!shop) return { ok: false, error: 'no_shop' };
  await ensureTable();
  const allowed = ['brand', 'language', 'currency', 'sms_sender', 'daily_cap', 'autopilot', 'followup_default', 'timezone', 'whatsapp_enabled', 'country_code'];
  const cur = await getSettings(shop);
  const next = { ...cur };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  // Never persist a timezone Intl cannot resolve — it would break every send.
  next.timezone = validTz(next.timezone) || DEFAULTS.timezone;
  try {
    await db.query(
      `INSERT INTO store_settings (shop_domain, brand, language, currency, sms_sender, daily_cap, autopilot, followup_default, timezone, whatsapp_enabled, country_code, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (shop_domain) DO UPDATE SET
         brand=$2, language=$3, currency=$4, sms_sender=$5, daily_cap=$6, autopilot=$7, followup_default=$8, timezone=$9, whatsapp_enabled=$10, country_code=$11, updated_at=NOW()`,
      [shop, next.brand, next.language, next.currency, next.sms_sender, next.daily_cap, next.autopilot, next.followup_default, next.timezone, (next.whatsapp_enabled === true || next.whatsapp_enabled === 'true'), next.country_code || null]
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
// Rows in advisor_actions that are NOT a message to a customer, and so must not
// eat the customer-outreach budget:
//   daily_report / morning_report — the app's own summaries, sent to the MERCHANT
//   holdout                       — a control-group row, which by definition was
//                                   never contacted
// Counting these meant a store's 500 was quietly spent on its own bookkeeping,
// and the last real customers of the day were deferred to tomorrow for nothing.
const NON_OUTREACH = ['daily_report', 'morning_report', 'holdout'];

async function outreachesToday(shop) {
  try {
    const s = await getSettings(shop);
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM advisor_actions
       WHERE shop_domain=$1
         AND action_type <> ALL($3::text[])
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2`,
      [shop, s.timezone, NON_OUTREACH]);
    return (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) { return 0; }
}

async function remainingToday(shop) {
  const s = await getSettings(shop);
  const used = await outreachesToday(shop);
  return { cap: s.daily_cap, used, remaining: Math.max(0, s.daily_cap - used) };
}

module.exports = { markSetupComplete, getSettings, updateSettings, remainingToday, outreachesToday, DEFAULT_SHOP };