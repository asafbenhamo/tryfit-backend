// ============================================================================
// TEST: does a merchant land in THEIR store, and only ever their store?
//   node test-shop-binding.js
//
// Now that Shopify's session token is the only merchant credential, one
// question decides whether this app is safe to install: when the token says
// "willow", does the request read willow's customers — and is there any way to
// make it read someone else's?
//
// This is the failure that would matter most and complain least. Nothing would
// error. A merchant would simply open the app and see another shop's revenue,
// another shop's customer list, and a chat agent confidently answering about a
// business that is not theirs. So this mints REAL tokens — signed the way
// Shopify signs them, with the app secret — and tries, deliberately, to cross
// the line:
//
//   - a valid token for A, plus ?shop=B in the query string
//   - a valid token for A, plus shop B in the JSON body
//   - a token whose `dest` and `iss` name different shops
//   - a token signed with a different app's secret
//   - a token minted for a different app (wrong aud)
//   - an expired token, and one that is not valid yet
//   - alg:none, and a token with the signature stripped
//
// Runs against the real server over real HTTP, because the thing being tested
// is the whole chain — verifier, session middleware, resolveShop, and the
// endpoint — not any one function in it.
// ============================================================================
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const PORT = Number(process.env.TEST_PORT || (39100 + (process.pid % 90)));
const BASE = 'http://127.0.0.1:' + PORT;

const SECRET = 'app-secret-under-test';
const OTHER_SECRET = 'a-different-apps-secret';
const API_KEY = 'client-id-under-test';

const A = 'willow.myshopify.com';
const B = 'ravenwood.myshopify.com';

// ---------------------------------------------------------------------------
// Mint a token exactly as Shopify does: HS256 over base64url(header).base64url(payload).
// ---------------------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint(overrides = {}, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const shop = overrides.shop || A;
  const payload = Object.assign({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: API_KEY,
    sub: '42',
    exp: nowSec + 60,
    nbf: nowSec - 10,
    iat: nowSec,
    jti: String(nowSec)
  }, overrides.claims || {});
  delete payload.shop;
  const h = b64(header), p = b64(payload);
  if (header.alg === 'none') return `${h}.${p}.`;
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

const SERVER = path.join(__dirname, 'server-dual.js');
const boot = [
  "const Module = require('module');",
  "const orig = Module._load;",
  "Module._load = function (r) {",
  "  const b = r.replace(/^[.][/]/, '').replace(/[.]js$/, '');",
  "  if (b === 'database') return {",
  "    testConnection: async () => false, pool: null, initializeSchema: async () => {},",
  "    query: async () => ({ rows: [], rowCount: 0 })",
  "  };",
  "  if (b === 'shopify-client') {",
  "    const real = orig.apply(this, arguments);",
  "    const stores = [",
  "      { shop_domain: " + JSON.stringify(A) + ", name: 'Willow' },",
  "      { shop_domain: " + JSON.stringify(B) + ", name: 'Ravenwood' }",
  "    ];",
  "    return Object.assign({}, real, {",
  "      listStores: () => stores,",
  "      getStore: (d) => stores.find(s => s.shop_domain === d) || null,",
  "      hasTokenForShop: () => true,",
  "      getTokenForShop: () => 'tok',",
  "      getFreshToken: async () => 'tok',",
  "      hasAcceptedTerms: () => true",
  "    });",
  "  }",
  "  return orig.apply(this, arguments);",
  "};",
  'require(' + JSON.stringify(SERVER) + ');'
].join('\n');

const child = spawn(process.execPath, ['-e', boot], {
  env: Object.assign({}, process.env, {
    DATABASE_URL: 'postgres://stub',
    ADVISOR_SHOPIFY_KEY: API_KEY,
    ADVISOR_SHOPIFY_SECRET: SECRET,
    SHOPIFY_API_SECRET: SECRET,
    MASTER_PASSWORD: 'masterpwmaster',
    ANTHROPIC_API_KEY: 'k', PUBLIC_BASE_URL: 'https://x.test', PORT: String(PORT)
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

const childLog = [];
const drain = (s) => s.on('data', d => {
  String(d).split('\n').forEach(l => { if (l.trim()) childLog.push(l); });
  while (childLog.length > 40) childLog.shift();
});
drain(child.stdout); drain(child.stderr);

const done = (code) => {
  process.exitCode = code;
  try { child.kill(); } catch (e) {}
  try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch (e) {}
  try {
    const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (d && typeof d.close === 'function') d.close().catch(() => {});
  } catch (e) {}
  setTimeout(() => process.exit(code), 5000).unref();
};

async function call(pathname, token, opts = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + pathname, {
    method: opts.body ? 'POST' : 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let body; try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body };
}

// Which shop did the server decide this request was for?
const shopOf = (r) => (r.body && (r.body.shop || (r.body.settings && r.body.settings.shop))) || null;

async function waitForServer(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health/security'); await r.text().catch(() => {}); return true; }
    catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

(async () => {
  if (!(await waitForServer())) {
    console.error('server never came up. Last lines from it:');
    console.error(childLog.slice(-15).join('\n'));
    return done(2);
  }

  const denied = r => r.status === 401 || r.status === 403;

  console.log('\n-- the ordinary case: a merchant opens the app from their admin --');
  let r = await call('/api/whoami', mint({ shop: A }));
  ok('whoami identifies the shop with no password anywhere', shopOf(r) === A,
     'HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 140));
  r = await call('/api/settings', mint({ shop: A }));
  ok('and settings resolve to that same shop', shopOf(r) === A, JSON.stringify(r.body).slice(0, 140));

  r = await call('/api/whoami', mint({ shop: B }));
  ok('a token for the OTHER shop resolves to the other shop', shopOf(r) === B, JSON.stringify(r.body).slice(0, 140));

  console.log('\n-- trying to cross the line while holding a valid token for A --');
  r = await call('/api/settings?shop=' + encodeURIComponent(B), mint({ shop: A }));
  ok('?shop=B is ignored — the token decides, not the query string', shopOf(r) === A,
     'resolved to ' + shopOf(r));

  r = await call('/api/autopilot', mint({ shop: A }), { body: { shop: B, enabled: true } });
  ok('shop B in the POST body does not redirect the write', shopOf(r) !== B,
     'resolved to ' + shopOf(r));

  r = await call('/api/whoami?shop=' + encodeURIComponent(B), mint({ shop: A }));
  ok('whoami still reports A', shopOf(r) === A, 'reported ' + shopOf(r));

  console.log('\n-- tokens that must not authenticate at all --');
  const rejects = [
    ['signed with a different app\'s secret', mint({ shop: A }, { secret: OTHER_SECRET })],
    ['minted for a different app (wrong aud)', mint({ shop: A, claims: { aud: 'someone-elses-client-id' } })],
    ['dest and iss naming different shops', mint({ shop: A, claims: { iss: `https://${B}/admin` } })],
    ['expired', mint({ shop: A, claims: { exp: Math.floor(Date.now() / 1000) - 600 } })],
    ['not valid yet', mint({ shop: A, claims: { nbf: Math.floor(Date.now() / 1000) + 600 } })],
    ['alg:none with no signature', mint({ shop: A }, { header: { alg: 'none', typ: 'JWT' } })],
    ['signature stripped off a good token', mint({ shop: A }).replace(/\.[^.]+$/, '.')],
    ['dest pointing at a host that is not myshopify.com',
      mint({ shop: A, claims: { dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' } })],
    ['dest over http', mint({ shop: A, claims: { dest: `http://${A}`, iss: `http://${A}/admin` } })]
  ];
  for (const [label, tok] of rejects) {
    const rr = await call('/api/settings', tok);
    ok(`a token ${label} is refused`, denied(rr), 'HTTP ' + rr.status + ' resolved to ' + shopOf(rr));
  }

  console.log('\n-- and a rejected token does not fall back to something weaker --');
  r = await call('/api/settings?shop=' + encodeURIComponent(A), mint({ shop: A }, { secret: OTHER_SECRET }));
  ok('a bad token plus a named shop is still refused', denied(r), 'HTTP ' + r.status);
  r = await call('/api/settings?shop=' + encodeURIComponent(A), null);
  ok('no token at all is refused', denied(r), 'HTTP ' + r.status);

  console.log('\n-- the merchant is never the platform operator --');
  r = await call('/admin/sync-products?shop=' + encodeURIComponent(A), mint({ shop: A }));
  ok('a merchant token cannot reach an operator-only endpoint', denied(r), 'HTTP ' + r.status);

  console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  done(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); done(2); });
