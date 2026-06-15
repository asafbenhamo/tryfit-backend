// memory-engine.js - Persistent memory for the advisor, per store.
// Two kinds of memory:
//   1. preferences/instructions the merchant gives ("don't contact under 100₪",
//      "prefer WhatsApp") - these apply to EVERY future conversation.
//   2. a rolling summary of recently-handled customers (so the advisor doesn't
//      re-suggest people we just acted on), derived from advisor_actions.
const db = require('./database');

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS advisor_memory (
      id SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'preference',
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[memory] ensureTable:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_memory_shop ON advisor_memory(shop_domain)`).catch(()=>{});
}
ensureTable();

// Save a durable preference/instruction for this store.
async function addPreference(shop, content) {
  if (!content || !content.trim()) return { ok: false };
  await ensureTable();
  await db.query(
    `INSERT INTO advisor_memory (shop_domain, kind, content) VALUES ($1, 'preference', $2)`,
    [shop.toLowerCase().trim(), content.trim()]
  ).catch(e => console.error('[memory] addPreference:', e.message));
  return { ok: true };
}

// List stored preferences for this store (most recent first, capped).
async function getPreferences(shop) {
  await ensureTable();
  try {
    const r = await db.query(
      `SELECT id, content, created_at FROM advisor_memory
       WHERE shop_domain = $1 AND kind = 'preference'
       ORDER BY created_at DESC LIMIT 20`,
      [shop.toLowerCase().trim()]
    );
    return r.rows;
  } catch (e) { return []; }
}

async function deletePreference(shop, id) {
  await ensureTable();
  await db.query(`DELETE FROM advisor_memory WHERE shop_domain = $1 AND id = $2`,
    [shop.toLowerCase().trim(), id]).catch(()=>{});
  return { ok: true };
}

// Build a short text block of recently-contacted customers (last 3 days), so the
// advisor knows who NOT to re-suggest. Derived live from advisor_actions.
async function recentlyHandledSummary(shop) {
  try {
    const r = await db.query(
      `SELECT DISTINCT COALESCE(NULLIF(details->>'customer_name',''), target_email, target_phone) AS who,
              MAX(created_at) AS last
       FROM advisor_actions
       WHERE shop_domain = $1
         AND action_type NOT IN ('daily_report','morning_report')
         AND created_at >= NOW() - INTERVAL '3 days'
       GROUP BY who
       ORDER BY last DESC
       LIMIT 40`,
      [shop.toLowerCase().trim()]
    );
    return r.rows.map(x => x.who).filter(Boolean);
  } catch (e) { return []; }
}

// Assemble the full memory block injected into the system prompt.
async function buildMemoryBlock(shop) {
  const [prefs, handled] = await Promise.all([
    getPreferences(shop),
    recentlyHandledSummary(shop)
  ]);
  let block = '';
  if (prefs.length) {
    block += '\n\n## העדפות והנחיות קבועות של בעל החנות (תמיד לכבד):\n';
    block += prefs.map(p => '- ' + p.content).join('\n');
  }
  if (handled.length) {
    block += '\n\n## לקוחות שכבר פנינו אליהם ב-3 הימים האחרונים (אל תציע אותם שוב אלא אם המשתמש מבקש):\n';
    block += handled.slice(0, 40).join(', ');
  }
  return block;
}

module.exports = {
  addPreference, getPreferences, deletePreference,
  recentlyHandledSummary, buildMemoryBlock, ensureTable
};