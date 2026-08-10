// ============================================================================
// STORE TIME — every wall-clock decision, in the STORE'S OWN timezone.
//
// Why this module exists: until now every time decision in the system was
// hardcoded to Asia/Jerusalem — the send window, the personal "best hour",
// the morning report, the daily counters. For an Israeli shop that is correct.
// For a US shop "09:00-20:30 Israel" is midnight-11:30am Eastern, i.e. the
// agent would text customers at 2 AM local.
//
// That is not just bad manners. US marketing messages outside 08:00-21:00 in
// the RECIPIENT's local time violate the TCPA, at $500-$1,500 per message, and
// the sender of record is the merchant. The same holds in Israel (08:00-21:00).
// So: one conservative window, expressed in the store's local time.
//
// Everything here is pure + synchronous except resolveTz(), which reads
// store_settings (cached 60s by store-settings.js).
// ============================================================================

const DEFAULT_TZ = 'Asia/Jerusalem';   // legacy default: the original pilot shop
// Returned when we genuinely do not know a shop's zone. Deliberately not a real
// zone: nothing may treat it as one and send on the strength of it.
const UNKNOWN_TZ = '__unknown__';

// The send window, in the store's local time. Deliberately narrower than what
// either jurisdiction allows, so we are never near the line:
//   Israel  — law allows 08:00-21:00
//   US TCPA — allows 08:00-21:00 local
const SEND_START_HOUR = 9;      // 09:00
const SEND_END_HOUR = 20;       // 20:30 (see SEND_END_MIN)
const SEND_END_MIN = 30;

// A timezone string is only usable if the platform's ICU data knows it.
function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch (e) { return false; }
}

function normalizeTz(tz) {
  return isValidTz(tz) ? tz : DEFAULT_TZ;
}

// Shopify's shop.json returns BOTH `timezone` ("(GMT-05:00) Eastern Time (US &
// Canada)") and `iana_timezone` ("America/New_York"). Only the IANA one is
// usable by Intl; the display string must never reach this module.
function fromShopifyShop(shopJson) {
  if (!shopJson) return null;
  const iana = shopJson.iana_timezone || shopJson.ianaTimezone || null;
  return isValidTz(iana) ? iana : null;
}

// ---------------------------------------------------------------------------
// Reading the clock in a given zone.
// ---------------------------------------------------------------------------

// The wall-clock parts (y/m/d/h/min) as seen in `tz`, right now or at `when`.
//
// `when` is normalised through new Date(...) rather than tested with
// `instanceof Date`: a Date handed back by the pg driver, or built in another
// realm, fails instanceof and would silently be replaced by "now" — meaning a
// window check would answer about the present instead of the instant asked
// about. Anything unparseable also falls back to now, never NaN.
function partsIn(tz, when) {
  let d;
  if (when === undefined || when === null) d = new Date();
  else { d = new Date(when); if (isNaN(d.getTime())) d = new Date(); }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTz(tz),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  // hour12:false still emits "24" for midnight in some ICU builds.
  let hour = parseInt(out.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(out.year, 10),
    month: parseInt(out.month, 10),
    day: parseInt(out.day, 10),
    hour,
    minute: parseInt(out.minute, 10),
    second: parseInt(out.second, 10)
  };
}

function hourIn(tz, when) { return partsIn(tz, when).hour; }

// 'YYYY-MM-DD' as seen in tz. Used to fire once-per-local-day jobs.
function dateKeyIn(tz, when) {
  const p = partsIn(tz, when);
  return String(p.year) + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Converting a store-local wall clock into a real UTC instant.
//
// The offset of a zone changes with DST, so we cannot add a fixed number. We
// ask what a candidate instant looks like in `tz`, measure how far off it is
// from the wall clock we wanted, and correct. Two passes settle DST edges.
// ---------------------------------------------------------------------------
function zonedTimeToUtc(tz, { year, month, day, hour, minute = 0 }) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(tz, new Date(guess));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const drift = wanted - seen;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

// ---------------------------------------------------------------------------
// The send window.
// ---------------------------------------------------------------------------
function isWithinSendWindow(tz, when) {
  // An unknown zone is not a reason to fall back to a default one and send
  // anyway — the whole point of the window is that it is the RECIPIENT's
  // evening, and a guessed zone can put that at 2am. No zone, no send.
  if (tz === null || tz === UNKNOWN_TZ) return false;
  const p = partsIn(tz, when);
  if (p.hour < SEND_START_HOUR) return false;
  if (p.hour > SEND_END_HOUR) return false;
  if (p.hour === SEND_END_HOUR && p.minute > SEND_END_MIN) return false;
  return true;
}

function sendWindowLabel() {
  return String(SEND_START_HOUR).padStart(2, '0') + ':00-'
       + String(SEND_END_HOUR).padStart(2, '0') + ':' + String(SEND_END_MIN).padStart(2, '0');
}

// Next legal send instant for a target local `hour`, at least `minLeadMs` from
// now, clamped into the window, jittered across half an hour so a batch does
// not arrive as one obvious blast. Returns a real Date (UTC instant).
function nextSendAt(tz, hour, daysFromNow = 0, minLeadMs = 10 * 60 * 1000) {
  tz = normalizeTz(tz);
  let h = parseInt(hour, 10);
  if (isNaN(h) || h < SEND_START_HOUR) h = SEND_START_HOUR + 1;
  if (h > SEND_END_HOUR - 1) h = SEND_END_HOUR - 1;

  const now = new Date();
  const p = partsIn(tz, now);
  const minute = Math.floor(Math.random() * 30);

  let target = zonedTimeToUtc(tz, {
    year: p.year, month: p.month, day: p.day + daysFromNow, hour: h, minute
  });
  // Too soon (or already past) — roll to the same hour tomorrow, local.
  if (target.getTime() - now.getTime() < minLeadMs) {
    target = zonedTimeToUtc(tz, {
      year: p.year, month: p.month, day: p.day + daysFromNow + 1, hour: h, minute
    });
  }
  return target;
}

// ---------------------------------------------------------------------------
// Shop-aware convenience. Kept async + lazy-required so this module stays
// dependency-free for callers that already know the timezone.
// ---------------------------------------------------------------------------
// The last zone we successfully read for each shop. A transient database
// failure should not change what time of day a store's customers are contacted.
const lastKnownTz = new Map();

async function tzForShop(shop) {
  try {
    const settings = require('./store-settings');
    const s = await settings.getSettings(shop);
    // resolved === false means the settings read failed and every value in `s`
    // is a default — including a timezone that has nothing to do with this shop.
    if (s && s.resolved === false) {
      const known = lastKnownTz.get(shop);
      if (known) return known;
      console.error(`[time] no timezone for ${shop} and settings unreadable — refusing to guess`);
      return UNKNOWN_TZ;
    }
    const tz = normalizeTz(s && s.timezone);
    lastKnownTz.set(shop, tz);
    return tz;
  } catch (e) {
    const known = lastKnownTz.get(shop);
    if (known) return known;
    console.error(`[time] tzForShop(${shop}) failed and nothing cached:`, e.message);
    return UNKNOWN_TZ;
  }
}

module.exports = {
  DEFAULT_TZ, UNKNOWN_TZ,
  SEND_START_HOUR, SEND_END_HOUR, SEND_END_MIN,
  isValidTz, normalizeTz, fromShopifyShop,
  partsIn, hourIn, dateKeyIn, zonedTimeToUtc,
  isWithinSendWindow, sendWindowLabel, nextSendAt,
  tzForShop
};
