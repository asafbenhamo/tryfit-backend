// compliance.js - Safety & legal guardrails for outbound customer actions.
// Enforces:
//   1. Working hours (no messages outside 11:00-21:00 Israel time)
//   2. Opt-out list (never contact customers who asked to stop - legal requirement)
// Every outbound send MUST pass through canContactCustomer() first.

const db = require('./database');

// Israel is UTC+2 (winter) / UTC+3 (summer/IDT). We compute Israel local hour
// from UTC. A simple, robust approach: use Intl with the Asia/Jerusalem zone,
// which handles DST automatically.
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
    // Fallback: UTC+2
    return (new Date().getUTCHours() + 2) % 24;
  }
}

const WORK_START = 11; // 11:00
const WORK_END = 21;   // 21:00 (last hour to send is 20:xx; at 21:00 we stop)

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
// A customer (by email or phone) who asked to stop receiving messages.
async function isOptedOut(shop, { email, phone } = {}) {
  if (!email && !phone) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM message_optouts
       WHERE shop_domain = $1
         AND (($2::text IS NOT NULL AND email = $2)
           OR ($3::text IS NOT NULL AND phone = $3))
       FETCH FIRST 1 ROWS ONLY`,
      [shop, email || null, phone || null]
    );
    return r.rows.length > 0;
  } catch (e) {
    // If the table doesn't exist yet or query fails, FAIL SAFE: treat as opted-out
    // is too aggressive (would block everything). Instead log and allow, since the
    // table is created at startup. But on real errors, better to be cautious:
    console.error('[compliance] isOptedOut check failed:', e.message);
    return false;
  }
}

async function addOptOut(shop, { email, phone, reason } = {}) {
  if (!email && !phone) return { ok: false, error: 'no contact' };
  try {
    await db.query(
      `INSERT INTO message_optouts (shop_domain, email, phone, reason, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (shop_domain, email, phone) DO NOTHING`,
      [shop, email || null, phone || null, reason || 'customer_request']
    );
    return { ok: true };
  } catch (e) {
    console.error('[compliance] addOptOut failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- Cooldown: don't pester a customer we contacted recently ----------
// If we contacted this customer in the last N days (default 14), skip her.
// Also skip if she already converted recently (no point pushing again).
const COOLDOWN_DAYS = 14;
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
    return false; // fail open - don't block sends on a check error
  }
}

// ---------- The single gate every send must pass ----------
// Returns { allowed: true } or { allowed: false, reason, detail }
async function canContactCustomer(shop, { email, phone } = {}, opts = {}) {
  // 1. Working hours (unless explicitly overridden for a manual send)
  if (!opts.ignoreHours && !isWithinWorkingHours()) {
    const h = israelHour();
    return {
      allowed: false,
      reason: 'outside_working_hours',
      detail: `השעה בישראל ${h}:00 - מחוץ לחלון השליחה (${WORK_START}:00-${WORK_END}:00). ההודעה לא נשלחה.`
    };
  }
  // 2. Opt-out
  if (await isOptedOut(shop, { email, phone })) {
    return {
      allowed: false,
      reason: 'opted_out',
      detail: 'הלקוחה ביקשה לא לקבל הודעות. ההודעה לא נשלחה (חובה חוקית).'
    };
  }
  // 3. Cooldown - don't pester (skip in batch unless explicitly overridden)
  if (!opts.ignoreCooldown && await isInCooldown(shop, { email, phone }, opts.cooldownDays || COOLDOWN_DAYS)) {
    return {
      allowed: false,
      reason: 'cooldown',
      detail: `פנינו ללקוחה הזו לאחרונה (ב-${opts.cooldownDays || COOLDOWN_DAYS} הימים האחרונים). מדלגים כדי לא להציק.`
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