// ============================================================================
// PCD ACCESS LOG — who read customers' personal data, when, and what for.
//
// Shopify's protected-customer-data requirements, for the field level this app
// uses (name, email, phone, address), include keeping an audit trail of access
// to that data. It is also the honest basis for answering "do you log access
// to personal data?" on the data-protection questionnaire with a yes — an
// answer that was not true until this file existed.
//
// This is an audit trail, not analytics: shop, actor, purpose, row count,
// time. Never the data itself — an access log that copies the accessed PII
// into another table would be one more place to leak it from.
//
// Writes are fire-and-forget. A logging failure must never break the read it
// is describing; it is reported once per boot and the read proceeds.
// ============================================================================

const db = require('./database');

let tableReady = false;
let warnedOnce = false;

async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS pcd_access_log (
      id           BIGSERIAL PRIMARY KEY,
      shop_domain  TEXT NOT NULL,
      actor        TEXT,          -- 'ai-agent' | 'merchant-ui' | 'autopilot' | 'system'
      purpose      TEXT,          -- e.g. 'tool:getDormantCustomers', 'rfm-scoring'
      record_count INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[pcd-log] table:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pcd_log_shop
                  ON pcd_access_log (shop_domain, created_at DESC)`).catch(() => {});
  tableReady = true;
}

// Fire-and-forget by design: callers do not await this.
function logAccess(shop, { actor = 'app', purpose = 'unspecified', count = null } = {}) {
  if (!shop) return;
  ensureTable()
    .then(() => db.query(
      `INSERT INTO pcd_access_log (shop_domain, actor, purpose, record_count)
       VALUES ($1, $2, $3, $4)`,
      [String(shop).toLowerCase(), String(actor).slice(0, 40), String(purpose).slice(0, 120),
       Number.isFinite(count) ? count : null]))
    .catch(e => {
      if (!warnedOnce) {
        warnedOnce = true;
        console.error('[pcd-log] writes failing (reported once):', e.message);
      }
    });
}

// Wrap a customer-reading function so every call is logged with its result
// size. One wrapper at the export site covers every caller — the chat agent,
// the plan endpoints, the autopilot — including callers added later, which is
// the property a per-call-site approach loses the day someone adds a call.
function audited(name, fn) {
  return async function (shop, ...args) {
    const out = await fn.call(this, shop, ...args);
    try {
      const count = Array.isArray(out) ? out.length
        : (out && Array.isArray(out.customers)) ? out.customers.length
        : (out && Array.isArray(out.rows)) ? out.rows.length
        : (out && typeof out === 'object') ? 1 : 0;
      logAccess(shop, { actor: 'app', purpose: 'tool:' + name, count });
    } catch (e) { /* the read must never fail because of its own audit */ }
    return out;
  };
}

module.exports = { logAccess, audited, ensureTable };
