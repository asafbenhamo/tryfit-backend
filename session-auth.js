// ============================================================================
// SESSION AUTH — replaces "the password travels with every request".
//
// Until now every call carried ?password=<the store's actual password> in the
// query string. That password is the only thing standing between the internet
// and a merchant's entire customer list, and a query string is the worst place
// to put it:
//
//   - it lands in server access logs, proxy logs and Railway's request log
//   - it is stored in browser history and synced across devices
//   - it leaks via the Referer header to any third-party resource on the page
//   - it ends up in bug reports and screenshots
//   - it is bookmarkable and shareable by accident
//
// It also never expires: once seen, it is valid forever, everywhere.
//
// A login now mints a short-lived random token instead. The token travels in an
// Authorization header, is stored only as a SHA-256 hash on our side (a database
// leak yields nothing usable), expires, and can be revoked — individually on
// logout, or for a whole store when its password changes.
//
// Tokens live in Postgres rather than memory because Railway redeploys often,
// and logging every merchant out on every deploy is not acceptable.
// ============================================================================

const crypto = require('crypto');
const db = require('./database');

const TOKEN_BYTES = 32;                       // 256 bits
const TTL_DAYS = 14;                          // absolute lifetime
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // extend at most once a day

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS advisor_sessions (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      shop_domain TEXT,
      is_master BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip TEXT,
      user_agent TEXT
    )`).catch(e => console.error('[session] table:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_hash ON advisor_sessions(token_hash)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_shop ON advisor_sessions(shop_domain)`).catch(() => {});
  tableReady = true;
}

// Only the hash is ever persisted. Losing the database does not hand anyone a
// working session.
function hash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

// Compare two secrets without leaking their contents through timing. A plain
// === returns faster the earlier the first difference is, which is measurable
// over enough requests and lets an attacker recover a password character by
// character.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length —
  // so hash both to a fixed width first and compare that.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Mint a session for a successful login. Returns the RAW token, which is the
// only moment it exists in plaintext on our side.
async function create(shop, { isMaster = false, ip = null, userAgent = null } = {}) {
  await ensureTable();
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expires = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO advisor_sessions (token_hash, shop_domain, is_master, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [hash(token), shop || null, !!isMaster, expires, ip, String(userAgent || '').slice(0, 300)]
  );
  return { token, expires_at: expires.toISOString(), ttl_days: TTL_DAYS };
}

// Look a token up. Returns { shop, is_master } or null. Expired rows never
// resolve, and are cleaned up opportunistically.
async function resolve(token) {
  if (!token) return null;
  await ensureTable();
  try {
    const r = await db.query(
      `SELECT id, shop_domain, is_master, last_seen_at
         FROM advisor_sessions
        WHERE token_hash = $1 AND expires_at > NOW()`,
      [hash(token)]);
    const row = r.rows[0];
    if (!row) return null;

    // Rolling expiry, but write at most once a day so a busy merchant does not
    // generate an UPDATE per request.
    const last = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - last > REFRESH_AFTER_MS) {
      db.query(
        `UPDATE advisor_sessions
            SET last_seen_at = NOW(), expires_at = NOW() + ($2 || ' days')::interval
          WHERE id = $1`,
        [row.id, String(TTL_DAYS)]
      ).catch(() => {});
    }
    return { shop: row.shop_domain, is_master: !!row.is_master };
  } catch (e) {
    console.error('[session] resolve:', e.message);
    return null;
  }
}

async function revoke(token) {
  if (!token) return { ok: true };
  await ensureTable();
  await db.query(`DELETE FROM advisor_sessions WHERE token_hash = $1`, [hash(token)]).catch(() => {});
  return { ok: true };
}

// Every session for a shop — used when its password changes, so an old password
// cannot keep living on through a session someone else already holds.
async function revokeAllForShop(shop) {
  await ensureTable();
  const r = await db.query(`DELETE FROM advisor_sessions WHERE shop_domain = $1`, [shop]).catch(() => ({ rowCount: 0 }));
  return { ok: true, revoked: r.rowCount || 0 };
}

async function purgeExpired() {
  await ensureTable();
  const r = await db.query(`DELETE FROM advisor_sessions WHERE expires_at < NOW()`).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

// Pull the bearer token off a request. HEADERS ONLY, deliberately:
//
//   - not the query string, which is the leak this whole module exists to close
//   - not the JSON body either, because auth is resolved in middleware that runs
//     before this app's per-route body parsers, so a body token would resolve on
//     some routes and silently not on others. An auth path that works sometimes
//     is worse than one that never does.
function extractToken(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (h['x-advisor-token']) return String(h['x-advisor-token']).trim();
  return null;
}

module.exports = {
  ensureTable, create, resolve, revoke, revokeAllForShop, purgeExpired,
  extractToken, safeEqual, hash,
  TTL_DAYS
};
