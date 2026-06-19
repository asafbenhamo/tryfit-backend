// click-tracker.js - Tracks when a customer clicks the link in an outreach message.
// This is the basis of the new, fairer attribution: the advisor only credits a sale
// when the customer ACTUALLY clicked the link we sent (or used a coupon) — not just
// because they happened to buy within a few days of any message.
const db = require('./database');
const crypto = require('crypto');

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_clicks (
      id SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      action_id BIGINT,
      target_email TEXT,
      target_phone TEXT,
      coupon_code TEXT,
      clicked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[clicks] ensureTables:', e.message));
  await db.query(`ALTER TABLE message_clicks ADD COLUMN IF NOT EXISTS coupon_code TEXT`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_clicks_shop ON message_clicks(shop_domain)`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_clicks_contact ON message_clicks(shop_domain, target_email, target_phone)`).catch(()=>{});
}
ensureTables();

// Create a short unique token for a tracking link, tied to the action + customer +
// the personal coupon (so clicking can auto-apply it in the store).
async function createLink(shopDomain, { actionId, email, phone, couponCode }) {
  await ensureTables();
  const token = crypto.randomBytes(6).toString('base64url'); // ~8 chars, URL-safe
  await db.query(
    `INSERT INTO message_clicks (shop_domain, token, action_id, target_email, target_phone, coupon_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [shopDomain, token, actionId || null, email || null, phone || null, couponCode || null]
  ).catch(e => console.error('[clicks] createLink:', e.message));
  return token;
}

// Record that a token was clicked (idempotent: keeps the FIRST click time). Returns
// the row including which coupon to auto-apply on the store.
async function recordClick(token) {
  await ensureTables();
  const r = await db.query(
    `UPDATE message_clicks SET clicked_at = COALESCE(clicked_at, NOW())
     WHERE token = $1
     RETURNING shop_domain, target_email, target_phone, action_id, coupon_code`,
    [token]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

// Did this customer click a link AND has it been <= windowDays since that click?
// Returns the most recent qualifying click row, or null. Used by attribution.
async function recentClickForBuyer(shopDomain, { email, phone }, windowDays) {
  await ensureTables();
  const days = windowDays || 3;
  const r = await db.query(
    `SELECT id, token, action_id, clicked_at
     FROM message_clicks
     WHERE shop_domain = $1
       AND clicked_at IS NOT NULL
       AND clicked_at >= NOW() - ($2 || ' days')::interval
       AND (
         ($3::text IS NOT NULL AND lower(target_email) = lower($3))
         OR ($4::text IS NOT NULL AND target_phone IS NOT NULL
             AND regexp_replace(target_phone,'[^0-9]','','g') = regexp_replace($4,'[^0-9]','','g'))
       )
     ORDER BY clicked_at DESC
     FETCH FIRST 1 ROWS ONLY`,
    [shopDomain, String(days), email || null, phone || null]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

module.exports = { ensureTables, createLink, recordClick, recentClickForBuyer };