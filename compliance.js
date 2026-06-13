// compliance.js - Safety & legal guardrails for outbound customer actions.
// Enforces:
//   1. Working hours (no messages outside 11:00-21:00 Israel time)
//   2. Opt-out list (never contact customers who asked to stop - legal requirement)
//   3. Cooldown - a SOFT warning (not a block) if we contacted her in the last few days
// Every outbound send MUST pass through canContactCustomer() first.

const db = require('./database');

function israelHour() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      hour: 'numeric',
      hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour');
    return h ? parseInt(h.value, 10) : new Date().getUTCHours() + 2;
  } catch (e) {
    return (new Date().getUTCHours() + 2) % 24;
  }
}

const WORK_START = 11; // 11:00
const WORK_END = 21;   // 21:00

function isWithinWorkingHours() {
  const h = israelHour();
  return h >= WORK_START && h < WORK_END;
}

function workingHoursStatus() {
  const h = israelHour();
  return {
    israel_hour: h,
    within_hours: h >= WORK_START && h < WORK_END,
    window: `${WORK_START}:00-${WORK_END}:00`
  };
}

// ---------- Opt-out list ----------
async function isOptedOut(shop, { email, phone } = {}) {
  if (!email && !phone) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM message_optouts
       WHERE shop_domain = $1
         AND (($2::text IS NOT NULL AND $2 <> '' AND email = $2)
           OR ($3::text IS NOT NULL AND $3 <> '' AND phone = $3))
       FETCH FIRST 1 ROWS ONLY`,
      [shop, email || null, phone || null]
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
// Returns { allowed: bool, reason, detail, warning? }
// HARD blocks (allowed:false): outside working hours, opted-out (legal).
// SOFT warning (allowed:true + warning): recently contacted - merchant may override.
async function canContactCustomer(shop, { email, phone } = {}, opts = {}) {
  // 1. Working hours - hard block (unless overridden for a manual send)
  if (!opts.ignoreHours && !isWithinWorkingHours()) {
    const h = israelHour();
    return {
      allowed: false,
      reason: 'outside_working_hours',
      detail: `השעה בישראל ${h}:00 - מחוץ לחלון השליחה (${WORK_START}:00-${WORK_END}:00). ההודעה לא נשלחה.`
    };
  }
  // 2. Opt-out - hard block (legal requirement, never overridable)
  if (await isOptedOut(shop, { email, phone })) {
    return {
      allowed: false,
      reason: 'opted_out',
      detail: 'הלקוחה ביקשה לא לקבל הודעות. ההודעה לא נשלחה (חובה חוקית).'
    };
  }
  // 3. Cooldown - SOFT warning only. The send is ALLOWED; we just flag it so the
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

module.exports = {
  israelHour,
  isWithinWorkingHours,
  workingHoursStatus,
  isOptedOut,
  addOptOut,
  isInCooldown,
  canContactCustomer
};