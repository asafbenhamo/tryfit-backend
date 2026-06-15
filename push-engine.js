// push-engine.js - Web Push notifications (real device notifications, even when
// the PWA is closed). Used to alert the merchant the moment the agent converts a
// sale, so they feel it working.
const webpush = require('web-push');
const db = require('./database');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@sevenseventy.co.il';

let configured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    configured = true;
  } catch (e) {
    console.error('[push] VAPID setup failed:', e.message);
  }
}

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[push] ensureTable:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_push_shop ON push_subscriptions(shop_domain)`).catch(()=>{});
}
ensureTable();

function isConfigured() { return configured; }
function publicKey() { return VAPID_PUBLIC; }

// Save (or update) a browser's push subscription for a shop.
async function saveSubscription(shopDomain, subscription) {
  if (!subscription || !subscription.endpoint) return { ok: false, error: 'invalid subscription' };
  await ensureTable();
  try {
    await db.query(
      `INSERT INTO push_subscriptions (shop_domain, endpoint, subscription)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET shop_domain = EXCLUDED.shop_domain, subscription = EXCLUDED.subscription`,
      [shopDomain.toLowerCase().trim(), subscription.endpoint, JSON.stringify(subscription)]
    );
    return { ok: true };
  } catch (e) {
    console.error('[push] saveSubscription:', e.message);
    return { ok: false, error: e.message };
  }
}

// Send a push to every subscription of a shop. Dead subscriptions (410/404) are
// pruned automatically.
async function sendToShop(shopDomain, payload) {
  if (!configured) return { ok: false, error: 'push not configured' };
  await ensureTable();
  const r = await db.query(
    `SELECT endpoint, subscription FROM push_subscriptions WHERE shop_domain = $1`,
    [shopDomain.toLowerCase().trim()]
  );
  if (!r.rows.length) return { ok: true, sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const row of r.rows) {
    try {
      await webpush.sendNotification(row.subscription, body);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [row.endpoint]).catch(()=>{});
      } else {
        console.error('[push] send error:', err.statusCode, err.message);
      }
    }
  }
  return { ok: true, sent };
}

module.exports = { isConfigured, publicKey, saveSubscription, sendToShop, ensureTable };