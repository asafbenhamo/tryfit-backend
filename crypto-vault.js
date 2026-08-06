// ============================================================================
// CRYPTO VAULT — encryption at rest for the credentials we hold on behalf of
// merchants.
//
// advisor_stores held Shopify access tokens, merchant login passwords and
// WhatsApp API keys in plaintext. A Shopify access token is not a password —
// it is live authority over a merchant's entire store: every customer, every
// order, the ability to create discounts and read personal data. One leaked
// database backup, one misconfigured Postgres, one contractor with read access,
// and every connected store is compromised at once, silently.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
// than yielding garbage that gets used as a token. A fresh random IV per value,
// because reusing an IV with GCM is catastrophic — it leaks the keystream.
//
// Stored format:  v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
// The prefix lets old plaintext rows be recognised and migrated in place
// instead of requiring a flag-day migration.
//
// The key comes from ENCRYPTION_KEY (32 bytes, hex or base64). Without it the
// vault is a no-op and says so loudly at boot: silently storing plaintext while
// looking encrypted is worse than not pretending.
// ============================================================================

const crypto = require('crypto');

const PREFIX = 'v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;      // GCM standard
const TAG_BYTES = 16;

let _key = null;
let _warned = false;

function key() {
  if (_key !== null) return _key;
  const raw = process.env.ENCRYPTION_KEY || process.env.DATA_ENCRYPTION_KEY || '';
  if (!raw) { _key = false; return _key; }
  let buf = null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) buf = Buffer.from(raw.trim(), 'hex');
    else buf = Buffer.from(raw.trim(), 'base64');
  } catch (e) { buf = null; }
  if (!buf || buf.length !== 32) {
    console.error('[vault] ENCRYPTION_KEY must be 32 bytes (64 hex chars, or base64). Encryption DISABLED.');
    _key = false;
    return _key;
  }
  _key = buf;
  return _key;
}

function isEnabled() { return key() !== false; }

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Encrypt a secret for storage. Returns the value unchanged when no key is
// configured, so the app keeps working — but warns once so it cannot pass
// unnoticed.
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const k = key();
  if (k === false) {
    if (!_warned) {
      console.warn('[vault] ENCRYPTION_KEY is not set — credentials are being stored in PLAINTEXT.');
      _warned = true;
    }
    return plain;
  }
  if (isEncrypted(plain)) return plain;              // already sealed
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

// Decrypt a stored value. Plaintext (pre-migration) passes straight through, so
// reads keep working while rows are being migrated.
function decrypt(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  if (!isEncrypted(stored)) return stored;
  const k = key();
  if (k === false) {
    console.error('[vault] encrypted value found but ENCRYPTION_KEY is not set — cannot decrypt.');
    return null;
  }
  try {
    const parts = String(stored).slice(PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const data = Buffer.from(parts[2], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    // Authentication failure: wrong key, or the ciphertext was tampered with.
    console.error('[vault] decrypt failed:', e.message);
    return null;
  }
}

// Generate a key, for setup instructions.
function generateKey() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { encrypt, decrypt, isEnabled, isEncrypted, generateKey, PREFIX };
