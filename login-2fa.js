// ============================================================================
// TWO-STEP LOGIN — password, then a code sent to the merchant's email.
//
// The password alone was the only thing between the internet and a merchant's
// entire customer list. Passwords get reused, phished, shoulder-surfed and
// pasted into chats; a code delivered to the mailbox on file means stealing the
// password is no longer enough on its own.
//
// The flow is deliberately two calls, not one:
//   1. POST /api/auth/login   { email, password }  -> a challenge id
//   2. POST /api/auth/verify  { challenge, code }  -> a session token
//
// No session exists until step 2 succeeds. Step 1 hands back nothing that
// authenticates anything.
//
// What this file is careful about, and why:
//
//   The code is generated with crypto.randomInt, not Math.random. Math.random
//     is seeded predictably enough that an attacker who sees a few codes can
//     narrow the next one; it must never be used for anything a person logs in
//     with.
//
//   Only a hash of the code is stored. A database leak yields hashes for codes
//     that expire in ten minutes, rather than a list of working ones.
//
//   Attempts are capped and the challenge is burned on the fifth failure. A
//     six-digit code is one in a million per guess, which is fine — and trivial
//     to brute force at a few thousand guesses a second if nobody is counting.
//
//   Comparison is timing-safe, and the code is compared only after the
//     challenge is found and checked for expiry.
//
//   A challenge is single use. It is deleted the moment it succeeds, so a code
//     someone glimpsed cannot be replayed.
//
//   Nothing here reveals whether an email is registered. The caller gets the
//     same answer either way (see the server's login handler) — otherwise this
//     becomes a way to enumerate which stores use the product.
// ============================================================================

const crypto = require('crypto');
const db = require('./database');

const CODE_DIGITS = 6;
const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
// A merchant who keeps asking for codes should not be able to flood their own
// inbox, and an attacker should not be able to use us as a mail cannon.
const MAX_ISSUES_PER_HOUR = 6;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS login_challenges (
      id            TEXT PRIMARY KEY,      -- random, unguessable; NOT a session
      shop_domain   TEXT,                  -- null for the platform admin
      is_master     BOOLEAN DEFAULT FALSE,
      email         TEXT NOT NULL,         -- where the code went
      code_hash     TEXT NOT NULL,         -- sha256 of the code, never the code
      attempts      INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      ip            TEXT,
      user_agent    TEXT
    )`).catch(e => console.error('[2fa] table:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_login_chal_email ON login_challenges(email, created_at DESC)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_login_chal_exp ON login_challenges(expires_at)`).catch(() => {});
  tableReady = true;
}

function hash(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// A uniformly random N-digit code, leading zeros included. randomInt is
// rejection-sampled by Node, so there is no modulo bias.
function generateCode() {
  const max = Math.pow(10, CODE_DIGITS);
  return String(crypto.randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

// "dana@example.com" -> "d••••@example.com". Shown back to the merchant so they
// know which mailbox to open, without printing an address to anyone who reached
// the login screen with a stolen password.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '•••';
  const name = s.slice(0, at), domain = s.slice(at);
  return name[0] + '•'.repeat(Math.max(3, Math.min(name.length - 1, 6))) + domain;
}

// Has this address asked for too many codes lately?
async function tooManyRecent(email) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM login_challenges
        WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [String(email).toLowerCase()]);
    return ((r.rows[0] && r.rows[0].n) || 0) >= MAX_ISSUES_PER_HOUR;
  } catch (e) {
    return false;   // never lock a merchant out because a COUNT failed
  }
}

// Create a challenge. Returns { id, code, email, masked } — `code` is the ONLY
// moment it exists in plaintext on our side; the caller emails it and forgets it.
async function issue({ shop = null, isMaster = false, email, ip = null, userAgent = null }) {
  await ensureTable();
  if (!email) return { ok: false, error: 'no_email' };
  const addr = String(email).toLowerCase().trim();

  if (await tooManyRecent(addr)) return { ok: false, error: 'too_many_requests' };

  const id = crypto.randomBytes(24).toString('base64url');
  const code = generateCode();
  const expires = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

  await db.query(
    `INSERT INTO login_challenges (id, shop_domain, is_master, email, code_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, shop, !!isMaster, addr, hash(code), expires, ip, String(userAgent || '').slice(0, 300)]
  );

  // Older challenges for this address are now moot: EXPIRE them, do not delete
  // them.
  //
  // Deleting was the obvious thing and it quietly disabled the hourly limit —
  // tooManyRecent() counts rows from the last hour, and wiping them on every
  // issue meant the count was always 1, so an attacker could ask for unlimited
  // codes and bury the merchant's real one under a hundred others. Expiring
  // kills the old codes just as dead while leaving the evidence that they were
  // asked for.
  await db.query(
    `UPDATE login_challenges SET expires_at = NOW()
      WHERE email = $1 AND id <> $2 AND expires_at > NOW()`, [addr, id]
  ).catch(() => {});

  return { ok: true, id, code, email: addr, masked: maskEmail(addr), expires_at: expires.toISOString(), ttl_minutes: TTL_MINUTES };
}

// Redeem a challenge. Returns { ok:true, shop, is_master } or { ok:false, error }.
// Never throws, and never says anything that distinguishes "no such challenge"
// from "wrong code" beyond what the caller needs to show a person.
async function verify(challengeId, code) {
  await ensureTable();
  if (!challengeId || !code) return { ok: false, error: 'invalid' };
  try {
    const r = await db.query(`SELECT * FROM login_challenges WHERE id = $1`, [String(challengeId)]);
    const row = r.rows[0];
    if (!row) return { ok: false, error: 'invalid' };

    if (new Date(row.expires_at) <= new Date()) {
      await db.query(`DELETE FROM login_challenges WHERE id = $1`, [row.id]).catch(() => {});
      return { ok: false, error: 'expired' };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await db.query(`DELETE FROM login_challenges WHERE id = $1`, [row.id]).catch(() => {});
      return { ok: false, error: 'too_many_attempts' };
    }

    // Count the attempt BEFORE comparing. If the process dies mid-verify, the
    // attempt must still have been spent — otherwise the counter is bypassable
    // by hanging up on every request.
    const bumped = await db.query(
      `UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [row.id]).catch(() => ({ rows: [] }));
    const attempts = (bumped.rows[0] && bumped.rows[0].attempts) || (row.attempts + 1);

    if (!safeEqual(hash(String(code).trim()), row.code_hash)) {
      if (attempts >= MAX_ATTEMPTS) {
        await db.query(`DELETE FROM login_challenges WHERE id = $1`, [row.id]).catch(() => {});
        return { ok: false, error: 'too_many_attempts' };
      }
      return { ok: false, error: 'wrong_code', attempts_left: MAX_ATTEMPTS - attempts };
    }

    // Correct. Burn it — single use, no replay.
    await db.query(`DELETE FROM login_challenges WHERE id = $1`, [row.id]).catch(() => {});
    return { ok: true, shop: row.shop_domain || null, is_master: !!row.is_master, email: row.email };
  } catch (e) {
    console.error('[2fa] verify:', e.message);
    return { ok: false, error: 'invalid' };
  }
}

// Housekeeping. Deliberately keeps rows for an hour past expiry, because the
// hourly issue-rate limit counts them — purging on expiry alone would reset
// that counter and hand back the flooding hole the expire-don't-delete change
// above closed.
async function purgeExpired() {
  await ensureTable();
  const r = await db.query(
    `DELETE FROM login_challenges WHERE created_at < NOW() - INTERVAL '2 hours'`
  ).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

// The email itself. Plain and short on purpose: a login code is the one message
// where a person should not have to read anything.
function codeEmail(code, { brand, language, minutes = TTL_MINUTES } = {}) {
  const en = language === 'en';
  const name = brand || 'Smart Advisor';
  const subject = en ? `${code} is your Smart Advisor login code`
                     : `${code} — קוד הכניסה שלך ל-Smart Advisor`;
  const text = en
    ? `Your login code for ${name} is:\n\n${code}\n\nIt expires in ${minutes} minutes.\n\nIf you did not try to sign in, someone may know your password — change it, and the code alone will not let them in.`
    : `קוד הכניסה שלך ל-${name}:\n\n${code}\n\nהקוד תקף ל-${minutes} דקות.\n\nאם לא ניסית להתחבר — ייתכן שמישהו יודע את הסיסמה שלך. שנה אותה; הקוד לבדו לא יכניס אף אחד.`;
  return { subject, text };
}

module.exports = {
  ensureTable, issue, verify, purgeExpired, maskEmail, codeEmail,
  CODE_DIGITS, TTL_MINUTES, MAX_ATTEMPTS, MAX_ISSUES_PER_HOUR
};
