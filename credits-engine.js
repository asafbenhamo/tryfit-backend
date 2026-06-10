// credits-engine.js - WhatsApp message credits, per shop.
//
// Model: each automatic WhatsApp message sent via the 360dialog API costs ONE
// credit. The merchant tops up credits (manually by us now; via a payment
// provider later). Price per credit is set by PRICE_PER_CREDIT_ILS (₪0.25),
// shown in the UI. We keep a running balance per shop AND a full ledger of every
// top-up and deduction — the ledger is what a future billing/invoice system and
// any audit will rely on, so we never just mutate a number without recording why.
//
// Nothing here talks to a payment provider yet. `addCredits` is the single seam
// where, later, a successful charge will call in instead of an admin action.

const db = require('./database');

const PRICE_PER_CREDIT_ILS = 0.25; // what the merchant pays per credit
const COST_PER_CREDIT_ILS = 0.15;  // rough Meta/360dialog cost (for our margin view)

async function ensureCreditsTables() {
  try {
    // Running balance per shop.
    await db.query(`
      CREATE TABLE IF NOT EXISTS advisor_credits (
        shop_domain TEXT PRIMARY KEY,
        balance     INTEGER NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Immutable ledger: one row per top-up (+) or send (-).
    await db.query(`
      CREATE TABLE IF NOT EXISTS advisor_credit_ledger (
        id          SERIAL PRIMARY KEY,
        shop_domain TEXT NOT NULL,
        delta       INTEGER NOT NULL,        -- +N for top-up, -1 per message
        reason      TEXT,                    -- 'topup_manual','topup_paid','send_whatsapp','refund'
        balance_after INTEGER,
        meta        JSONB,                   -- e.g. { to, template, campaign_id }
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_credit_ledger_shop ON advisor_credit_ledger(shop_domain, created_at DESC)`).catch(()=>{});
  } catch (err) {
    console.error('⚠️  [credits] ensureCreditsTables failed:', err.message);
  }
}

// Current balance for a shop (0 if no row yet).
async function getBalance(shop) {
  try {
    const r = await db.query(`SELECT balance FROM advisor_credits WHERE shop_domain = $1`, [shop]);
    return r.rows[0] ? r.rows[0].balance : 0;
  } catch (err) {
    console.error('⚠️  [credits] getBalance failed:', err.message);
    return 0;
  }
}

// Add credits (top-up). reason: 'topup_manual' now, 'topup_paid' once billing exists.
// Returns the new balance. This is the seam a payment webhook will call later.
async function addCredits(shop, amount, reason = 'topup_manual', meta = {}) {
  const n = parseInt(amount);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'amount must be positive' };
  try {
    const newBalance = await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO advisor_credits (shop_domain, balance, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (shop_domain) DO UPDATE SET balance = advisor_credits.balance + $2, updated_at = NOW()`,
        [shop, n]
      );
      const b = await client.query(`SELECT balance FROM advisor_credits WHERE shop_domain = $1`, [shop]);
      const bal = b.rows[0].balance;
      await client.query(
        `INSERT INTO advisor_credit_ledger (shop_domain, delta, reason, balance_after, meta)
         VALUES ($1, $2, $3, $4, $5)`,
        [shop, n, reason, bal, JSON.stringify(meta || {})]
      );
      return bal;
    });
    return { ok: true, balance: newBalance, added: n };
  } catch (err) {
    console.error('⚠️  [credits] addCredits failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Atomically spend ONE credit for a send. Returns {ok:true,balance} or
// {ok:false, reason:'no_credits'} if the balance is empty. Never goes negative.
async function deductOne(shop, meta = {}) {
  try {
    return await db.transaction(async (client) => {
      // Lock the row and check balance.
      const r = await client.query(
        `SELECT balance FROM advisor_credits WHERE shop_domain = $1 FOR UPDATE`, [shop]
      );
      const bal = r.rows[0] ? r.rows[0].balance : 0;
      if (bal <= 0) return { ok: false, reason: 'no_credits', balance: 0 };
      const newBal = bal - 1;
      await client.query(
        `UPDATE advisor_credits SET balance = $2, updated_at = NOW() WHERE shop_domain = $1`,
        [shop, newBal]
      );
      await client.query(
        `INSERT INTO advisor_credit_ledger (shop_domain, delta, reason, balance_after, meta)
         VALUES ($1, -1, 'send_whatsapp', $2, $3)`,
        [shop, newBal, JSON.stringify(meta || {})]
      );
      return { ok: true, balance: newBal };
    });
  } catch (err) {
    console.error('⚠️  [credits] deductOne failed:', err.message);
    return { ok: false, reason: 'error', error: err.message };
  }
}

// Refund one credit (e.g. the send failed after we deducted). Keeps the ledger honest.
async function refundOne(shop, meta = {}) {
  return addCredits(shop, 1, 'refund', meta);
}

// Recent ledger rows for display.
async function getLedger(shop, limit = 50) {
  try {
    const r = await db.query(
      `SELECT delta, reason, balance_after, meta, created_at
       FROM advisor_credit_ledger WHERE shop_domain = $1
       ORDER BY created_at DESC FETCH FIRST ${parseInt(limit)} ROWS ONLY`,
      [shop]
    );
    return r.rows;
  } catch (err) {
    return [];
  }
}

module.exports = {
  PRICE_PER_CREDIT_ILS,
  COST_PER_CREDIT_ILS,
  ensureCreditsTables,
  getBalance,
  addCredits,
  deductOne,
  refundOne,
  getLedger
};