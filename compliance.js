// compliance.js - Safety & legal guardrails for outbound customer actions.
// Enforces:
//   1. Send window, in THE STORE'S OWN timezone (see store-time.js)
//   2. Opt-out list (never contact customers who asked to stop - legal requirement)
//   3. Cooldown - a SOFT warning (not a block) if we contacted her in the last few days
// Every outbound send MUST pass through canContactCustomer() first.
//
// The window used to be 11:00-21:00 Israel time, hardcoded, while the message
// queue independently used 09:00-20:30 Israel. Both are now the single window
// defined in store-time.js, evaluated in the store's zone — so a New York shop
// is checked against New York hours instead of Tel Aviv's.

const db = require('./database');
const storeTime = require('./store-time');

// Israel local hour. Kept for callers that still ask for it by name.
function israelHour() {
  return storeTime.hourIn(storeTime.DEFAULT_TZ);
}

// Hour right now in a given shop's zone.
async function shopHour(shop) {
  return storeTime.hourIn(await storeTime.tzForShop(shop));
}

// Is it a legal time to message this shop's customers right now?
async function isWithinWorkingHours(shop) {
  return storeTime.isWithinSendWindow(await storeTime.tzForShop(shop));
}

async function workingHoursStatus(shop) {
  const tz = await storeTime.tzForShop(shop);
  return {
    timezone: tz,
    local_hour: storeTime.hourIn(tz),
    israel_hour: storeTime.hourIn(storeTime.DEFAULT_TZ),
    within_hours: storeTime.isWithinSendWindow(tz),
    window: storeTime.sendWindowLabel()
  };
}

// ---------- Opt-out list ----------
// The last nine digits of a phone number, ignoring punctuation, country code
// and the national leading zero.
//
// Opt-outs were matched on exact string equality, which was fine while every
// number in the system came from one Israeli provider in one format. It stops
// being fine the moment a second provider writes numbers in E.164: the same
// person is "0541234567" in one row and "+972541234567" in the next, the
// equality misses, and we text somebody who told us to stop. That is the one
// failure here with legal consequences, so the comparison is made on a form
// that survives the difference.
//
// Nine digits can in principle collide between two countries. The query is
// already scoped to a single shop, and the direction of a false match is to
// send LESS — a message withheld, never one sent to someone who opted out.
function phoneKey(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  return d.length >= 9 ? d.slice(-9) : (d || null);
}

async function isOptedOut(shop, { email, phone } = {}) {
  if (!email && !phone) return false;
  const key = phone ? phoneKey(phone) : null;
  try {
    const r = await db.query(
      `SELECT 1 FROM message_optouts
       WHERE shop_domain = $1
         AND (($2::text IS NOT NULL AND $2 <> '' AND email = $2)
           OR ($3::text IS NOT NULL AND $3 <> ''
               AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) = $3))
       FETCH FIRST 1 ROWS ONLY`,
      [shop, email || null, key]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error('[compliance] isOptedOut check failed:', e.message);
    return false;
  }
}

async function addOptOut(shop, { email, phone, reason } = {}) {
  if (!email && !phone) return { ok: false, error: 'no contact' };
  try {
    await db.query(
      `INSERT INTO message_optouts (shop_domain, email, phone, reason, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [shop, email || null, phone || null, reason || 'customer_request']
    );
    return { ok: true };
  } catch (e) {
    console.error('[compliance] addOptOut failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- Cooldown: a SOFT signal, never a hard block ----------
// We contacted this customer in the last N days (default 3). Used to WARN the
// merchant, but the merchant can always choose to send anyway.
const COOLDOWN_DAYS = 3;
async function isInCooldown(shop, { email, phone } = {}, days = COOLDOWN_DAYS) {
  if (!email && !phone) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM advisor_actions
       WHERE shop_domain = $1
         AND created_at >= NOW() - ($4 || ' days')::interval
         AND ( ($2::text IS NOT NULL AND lower(target_email) = lower($2))
            OR ($3::text IS NOT NULL AND regexp_replace(target_phone,'[^0-9]','','g') = regexp_replace($3,'[^0-9]','','g')) )
       FETCH FIRST 1 ROWS ONLY`,
      [shop, email || null, phone || null, String(days)]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error('[compliance] isInCooldown failed:', e.message);
    return false;
  }
}

// ---------- The single gate every send must pass ----------
// Did this customer explicitly decline marketing in the merchant's own store?
//
// Deliberately narrow: it answers true ONLY for a stored FALSE. A missing row,
// a NULL, or a database error all answer false (do not block), because failing
// this check closed would silently stop every send for a shop whose customers
// predate consent tracking — and a compliance control that turns the product
// off without saying so gets ripped out rather than fixed.
async function hasDeclinedMarketing(shop, { email, phone } = {}) {
  if (!email && !phone) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM store_customers
        WHERE shop_domain = $1
          AND marketing_consent IS FALSE
          AND ( ($2::text <> '' AND LOWER(email) = LOWER($2))
             OR ($3::text <> '' AND RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 9) = $3) )
        FETCH FIRST 1 ROWS ONLY`,
      // Last nine digits, for the same reason as isOptedOut: this is a hard
      // block, and a format mismatch here means messaging someone who ticked
      // "no marketing" in the merchant's own checkout.
      [shop, email || '', phone ? (phoneKey(phone) || '') : '']);
    return r.rows.length > 0;
  } catch (e) {
    console.error('[compliance] hasDeclinedMarketing:', e.message);
    return false;
  }
}

// Returns { allowed: bool, reason, detail, warning? }
// HARD blocks (allowed:false): outside working hours, opted-out (legal).
// SOFT warning (allowed:true + warning): recently contacted - merchant may override.
async function canContactCustomer(shop, { email, phone } = {}, opts = {}) {
  // 1. Send window - hard block (unless overridden for a manual send).
  //    Evaluated in the STORE's timezone, not the server's and not Israel's.
  if (!opts.ignoreHours) {
    const tz = await storeTime.tzForShop(shop);
    if (!storeTime.isWithinSendWindow(tz)) {
      const h = storeTime.hourIn(tz);
      return {
        allowed: false,
        reason: 'outside_working_hours',
        timezone: tz,
        detail: `השעה המקומית בחנות ${h}:00 (${tz}) - מחוץ לחלון השליחה (${storeTime.sendWindowLabel()}). ההודעה לא נשלחה.`
      };
    }
  }
  // 2. Opt-out - hard block (legal requirement, never overridable)
  if (await isOptedOut(shop, { email, phone })) {
    return {
      allowed: false,
      reason: 'opted_out',
      detail: 'הלקוחה ביקשה לא לקבל הודעות. ההודעה לא נשלחה (חובה חוקית).'
    };
  }
  // 3. Marketing consent - hard block when the customer explicitly declined.
  //
  //    We have stored Shopify's marketing_consent since the first backfill and
  //    the privacy policy told merchants we use it, but NO send path ever read
  //    it: someone who ticked "no marketing" in the store's own checkout was
  //    messaged anyway, with the merchant as sender of record.
  //
  //    Only an explicit FALSE blocks. Unknown (NULL) does not, because most
  //    shops have customers imported from before they tracked consent, and
  //    treating "we never asked" as "they said no" would silence the app for
  //    an entire customer base. That distinction is now stated in the privacy
  //    policy rather than papered over.
  if (!opts.ignoreConsent && await hasDeclinedMarketing(shop, { email, phone })) {
    return {
      allowed: false,
      reason: 'no_marketing_consent',
      detail: 'הלקוחה לא אישרה קבלת דיוור שיווקי בחנות. ההודעה לא נשלחה.'
    };
  }

  // 4. Cooldown - SOFT warning only. The send is ALLOWED; we just flag it so the
  //    merchant knows we reached out recently and can decide. Never blocks.
  if (!opts.ignoreCooldown && await isInCooldown(shop, { email, phone }, opts.cooldownDays || COOLDOWN_DAYS)) {
    return {
      allowed: true,
      warning: 'recent_contact',
      detail: `שים לב: פנינו ללקוחה הזו ב-${opts.cooldownDays || COOLDOWN_DAYS} הימים האחרונים. אפשר לשלוח בכל זאת אם תרצה.`
    };
  }
  return { allowed: true };
}

module.exports = { phoneKey,
  israelHour,
  shopHour,
  isWithinWorkingHours,
  workingHoursStatus,
  isOptedOut,
  addOptOut,
  hasDeclinedMarketing,
  isInCooldown,
  canContactCustomer
};