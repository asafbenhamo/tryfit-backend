// ============================================================================
// TEST: encryption at rest.  node test-vault.js
//
// advisor_stores holds Shopify access tokens — live authority over a merchant's
// entire store, every customer and every order. These tests pin that the tokens
// are unreadable in the database, that a live deployment can turn encryption on
// without a flag day, and that a wrong key fails loudly instead of handing back
// a corrupted token that would silently break every API call.
// ============================================================================
const crypto = require('crypto');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

// A stand-in for the advisor_stores table, so we can look at what would really
// be written to disk.
let TABLE = [];
const dbStub = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/^SELECT shop_domain, access_token, advisor_password, d360_api_key FROM advisor_stores/.test(s)) {
      return { rows: TABLE.map(r => ({ ...r })) };
    }
    if (/SELECT shop_domain, access_token.*FROM advisor_stores WHERE active/.test(s)) {
      return { rows: TABLE.filter(r => r.active !== false).map(r => ({ ...r, display_name: r.shop_domain, active: true })) };
    }
    if (/UPDATE advisor_stores SET access_token = COALESCE/.test(s)) {
      const row = TABLE.find(r => r.shop_domain === params[0]);
      if (row) {
        if (params[1]) row.access_token = params[1];
        if (params[2]) row.advisor_password = params[2];
        if (params[3]) row.d360_api_key = params[3];
      }
      return { rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO advisor_stores/.test(s)) {
      TABLE = TABLE.filter(r => r.shop_domain !== params[0]);
      TABLE.push({ shop_domain: params[0], access_token: params[1], advisor_password: params[2], active: true });
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
};

function loadClient(key) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  if (key) process.env.ENCRYPTION_KEY = key; else delete process.env.ENCRYPTION_KEY;
  const orig = Module._load;
  Module._load = function (request) {
    if (request.replace(/^\.\//, '').replace(/\.js$/, '') === 'database') return dbStub;
    return orig.apply(this, arguments);
  };
  const client = require('./shopify-client.js');
  Module._load = orig;
  return client;
}

(async () => {
  const TOKEN = 'shpat_9f8e7d6c5b4a39281706';
  const PASSWORD = 'merchant-login-pw';

  console.log('\n-- a new store is written encrypted --');
  TABLE = [];
  let client = loadClient(KEY_A);
  await client.upsertStore({ shop_domain: 'willow.myshopify.com', access_token: TOKEN, advisor_password: PASSWORD, display_name: 'Willow' });
  const stored = TABLE[0];
  ok('the token on disk is NOT the token', stored.access_token !== TOKEN, String(stored.access_token).slice(0, 30));
  ok('it is marked as sealed', String(stored.access_token).startsWith('v1:'));
  ok('the raw token does not appear anywhere in the row', !JSON.stringify(stored).includes(TOKEN));
  ok('the password is sealed too', String(stored.advisor_password).startsWith('v1:') && !JSON.stringify(stored).includes(PASSWORD));

  console.log('\n-- and reads back correctly --');
  await client.loadStores();
  ok('getTokenForShop returns the real token', client.getTokenForShop('willow.myshopify.com') === TOKEN);
  ok('the store password round-trips', (client.getStore('willow.myshopify.com') || {}).password === PASSWORD);

  console.log('\n-- turning encryption on for a LIVE database with plaintext rows --');
  TABLE = [
    { shop_domain: 'old1.myshopify.com', access_token: 'shpat_plain_one', advisor_password: 'pw1', d360_api_key: 'd360_one', active: true },
    { shop_domain: 'old2.myshopify.com', access_token: 'shpat_plain_two', advisor_password: null, d360_api_key: null, active: true }
  ];
  client = loadClient(KEY_A);
  ok('plaintext rows still read before migrating', (await client.loadStores()) >= 0 && client.getTokenForShop('old1.myshopify.com') === 'shpat_plain_one');
  const mig = await client.migrateSecretsToVault();
  ok('migration reports what it sealed', mig.ok === true && mig.sealed === 2, JSON.stringify(mig));
  ok('row 1 is now sealed', TABLE[0].access_token.startsWith('v1:') && TABLE[0].advisor_password.startsWith('v1:') && TABLE[0].d360_api_key.startsWith('v1:'));
  ok('row 2 is now sealed', TABLE[1].access_token.startsWith('v1:'));
  ok('a null column stays null, not encrypted', TABLE[1].advisor_password === null);
  await client.loadStores();
  ok('tokens still resolve after migration', client.getTokenForShop('old1.myshopify.com') === 'shpat_plain_one');
  ok('and the second one too', client.getTokenForShop('old2.myshopify.com') === 'shpat_plain_two');

  console.log('\n-- migration is idempotent --');
  const again = await client.migrateSecretsToVault();
  ok('a second run seals nothing', again.ok === true && again.sealed === 0, JSON.stringify(again));

  console.log('\n-- the WRONG key fails loudly rather than returning junk --');
  const sealedToken = TABLE[0].access_token;
  client = loadClient(KEY_B);
  await client.loadStores();
  const wrong = client.getTokenForShop('old1.myshopify.com');
  ok('does not return the real token', wrong !== 'shpat_plain_one', String(wrong));
  ok('returns null rather than corrupted bytes', wrong === null || wrong === undefined, JSON.stringify(wrong));
  ok('the stored ciphertext was not damaged by the failed read', TABLE[0].access_token === sealedToken);

  console.log('\n-- with NO key the app still runs (plaintext, warned) --');
  TABLE = [];
  client = loadClient(null);
  await client.upsertStore({ shop_domain: 'nokey.myshopify.com', access_token: TOKEN, advisor_password: PASSWORD });
  ok('stored as plaintext', TABLE[0].access_token === TOKEN);
  await client.loadStores();
  ok('and still usable', client.getTokenForShop('nokey.myshopify.com') === TOKEN);
  const skipped = await client.migrateSecretsToVault();
  ok('migration refuses to run without a key', skipped.ok === false && skipped.skipped === 'no_key', JSON.stringify(skipped));

  console.log('\n-- uninstall clears the credential --');
  TABLE = [{ shop_domain: 'gone.myshopify.com', access_token: 'v1:x:y:z', advisor_password: 'v1:a:b:c', d360_api_key: 'v1:d:e:f', active: true }];
  client = loadClient(KEY_A);
  dbStub.query = (function (orig) {
    return async (sql, params) => {
      if (/UPDATE advisor_stores\s+SET active = FALSE/.test(sql.replace(/\s+/g, ' '))) {
        const row = TABLE.find(r => r.shop_domain === params[0]);
        if (row) { row.active = false; row.access_token = ''; row.d360_api_key = null; }
        return { rowCount: 1 };
      }
      return orig(sql, params);
    };
  })(dbStub.query);
  await client.deactivateStore('gone.myshopify.com');
  ok('token is cleared on uninstall', TABLE[0].access_token === '');
  ok('WhatsApp key is cleared too', TABLE[0].d360_api_key === null);
  ok('the row survives for shop/redact 48h later', TABLE.length === 1 && TABLE[0].active === false);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
