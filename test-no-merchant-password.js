// ============================================================================
// TEST: a merchant password opens nothing, anywhere, against the REAL server.
//   node test-no-merchant-password.js
//
// A merchant reaches this app one way: from inside their Shopify admin, where
// Shopify has already authenticated them and hands us a signed token. So there
// is no merchant password any more.
//
// This test exists because deleting the sign-in FORM would have been theatre.
// The form was never the only way in. Every endpoint resolves its shop through
// resolveShop(), and resolveShop() accepted a bare `?password=` in the query
// string — so
//
//     GET /api/settings?password=<the store's password>
//
// returned that merchant's configuration to anyone on the internet holding the
// string, with no session, no Shopify, and no login screen involved at all.
// Removing the form while leaving that would have moved the door, not closed
// it, and the screenshot would have looked identical either way.
//
// So this runs the actual server and actually knocks: on the login endpoint, on
// a normal data endpoint, and on the admin endpoints — with a store password, a
// stale admin password, and nothing at all. The only credential that may still
// open anything is the platform operator's, because Shopify cannot vouch for
// the operator and never will.
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const PORT = Number(process.env.TEST_PORT || (39900 + (process.pid % 90)));
const BASE = 'http://127.0.0.1:' + PORT;

const STORE_PW = 'storepwstorepw';     // what a merchant used to sign in with
const ADMIN_PW = 'testpwtestpw';       // the pilot tenant's old password
const MASTER_PW = 'masterpwmaster';    // the platform operator

// The server runs in a CHILD process: booting express in-process means the test
// can only end by calling process.exit() while libuv still holds the listening
// socket and the app's timers, which trips an assertion inside async.c on
// Windows and reads exactly like a failing test.
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
  // A store that exists and has a password, so a store-password attempt is
  // testing the RULE and not merely failing to find a matching store.
  "  if (b === 'shopify-client') {",
  "    const real = orig.apply(this, arguments);",
  "    const store = { shop_domain: 'willow.myshopify.com', name: 'Willow',",
  "                    password: " + JSON.stringify(STORE_PW) + ", owner_email: 'owner@willow.test' };",
  "    return Object.assign({}, real, {",
  "      listStores: () => [store],",
  "      getStore: (d) => (d === store.shop_domain ? store : null),",
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
    ADMIN_PASSWORD: ADMIN_PW,
    MASTER_PASSWORD: MASTER_PW,
    ADVISOR_SHOPIFY_SECRET: 's', SHOPIFY_API_SECRET: 's', ANTHROPIC_API_KEY: 'k',
    PUBLIC_BASE_URL: 'https://x.test', PORT: String(PORT)
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

// Drain the child's output. Creating the pipes and never reading them lets the
// buffers fill; killing the child and calling process.exit in the same tick
// then leaves a half-closed handle behind and libuv aborts with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
// which is printed AFTER "all assertions passed" and reads exactly like the
// test blowing up at the finish line. Keep a tail for diagnostics.
const childLog = [];
const drain = (stream) => stream.on('data', (d) => {
  String(d).split('\n').forEach(l => { if (l.trim()) childLog.push(l); });
  while (childLog.length > 40) childLog.shift();
});
drain(child.stdout); drain(child.stderr);

// Do NOT call process.exit here. Killing the child and exiting in the same tick
// leaves the child's process and pipe handles mid-close, and libuv aborts with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
// printed AFTER "all assertions passed" — a passing run that reports failure to
// whatever is running it. Set the code, release the handles, let the loop end
// on its own. The unref'd timer is a backstop that cannot itself keep us alive.
const done = (code) => {
  process.exitCode = code;
  try { child.kill(); } catch (e) { /* already gone */ }
  try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch (e) {}
  // Node's fetch keeps connections alive for a few seconds after the last
  // request; closing the dispatcher lets the process end now rather than idling.
  try {
    const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (d && typeof d.close === 'function') d.close().catch(() => {});
  } catch (e) {}
  setTimeout(() => process.exit(code), 5000).unref();
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  let body; try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body };
};
const postJson = async (p, obj) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  });
  let body; try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body };
};

async function waitForServer(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health/security'); await r.text().catch(() => {}); return true; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!(await waitForServer())) {
    console.error('server never came up. Last lines from it:');
    console.error(childLog.slice(-15).join('\n'));
    return done(2);
  }

  const SHOP = 'willow.myshopify.com';
  const denied = r => r.status === 401 || r.status === 403;

  console.log('\n-- the sign-in endpoint no longer signs a merchant in --');
  let r = await postJson('/api/auth/login', { email: 'owner@willow.test', password: STORE_PW });
  ok('a correct store password is refused', denied(r), 'HTTP ' + r.status + ' ' + JSON.stringify(r.body));
  ok('it says why, rather than pretending the password was wrong',
     r.body && r.body.merchant_login_removed === true, JSON.stringify(r.body));
  ok('no session token comes back', !(r.body && r.body.token));

  r = await postJson('/api/auth/login', { password: ADMIN_PW });
  ok('the pilot tenant\'s old admin password is refused too', denied(r), 'HTTP ' + r.status);
  ok('and it mints no session either', !(r.body && r.body.token));

  r = await postJson('/api/auth/login', { password: 'not-any-password-at-all' });
  ok('a wrong password is still refused', denied(r), 'HTTP ' + r.status);

  console.log('\n-- the operator can still get in, because Shopify cannot vouch for them --');
  r = await postJson('/api/auth/login', { password: MASTER_PW });
  ok('the operator password is NOT refused', !denied(r), 'HTTP ' + r.status + ' ' + JSON.stringify(r.body));
  ok('and it does not report the merchant-login message',
     !(r.body && r.body.merchant_login_removed));

  console.log('\n-- the real door: a bare ?password= on an ordinary endpoint --');
  for (const [label, pw] of [['a store password', STORE_PW], ['the old admin password', ADMIN_PW]]) {
    r = await get('/api/settings?password=' + encodeURIComponent(pw) + '&shop=' + encodeURIComponent(SHOP));
    ok(`GET /api/settings with ${label} is refused`, denied(r), 'HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  }
  r = await get('/api/settings?shop=' + encodeURIComponent(SHOP));
  ok('GET /api/settings with no credential at all is refused', denied(r), 'HTTP ' + r.status);

  console.log('\n-- the same password in a header or a JSON body --');
  const hdr = await fetch(BASE + '/api/settings?shop=' + encodeURIComponent(SHOP), {
    headers: { 'x-advisor-password': STORE_PW }
  });
  // Read the body even though nothing needs it. An un-consumed response keeps
  // its socket open, and process.exit() on top of an open socket is what trips
  // the libuv assertion above.
  await hdr.text().catch(() => {});
  ok('the x-advisor-password header is refused', hdr.status === 401 || hdr.status === 403, 'HTTP ' + hdr.status);

  r = await postJson('/api/autopilot', { password: STORE_PW, shop: SHOP, enabled: true });
  ok('a store password in a POST body is refused', denied(r), 'HTTP ' + r.status);

  console.log('\n-- admin endpoints take the operator password and nothing else --');
  for (const [label, pw] of [['a store password', STORE_PW], ['the old admin password', ADMIN_PW]]) {
    r = await get('/admin/sync-products?password=' + encodeURIComponent(pw) + '&shop=' + encodeURIComponent(SHOP));
    ok(`/admin/sync-products with ${label} is refused`, denied(r), 'HTTP ' + r.status);
  }
  r = await get('/admin/backfill/status?password=' + encodeURIComponent(MASTER_PW));
  ok('/admin/backfill/status with the operator password is NOT refused', !denied(r), 'HTTP ' + r.status);

  console.log('\n-- an unauthenticated visitor is simply nobody --');
  r = await get('/api/whoami');
  ok('whoami reports no shop', !(r.body && r.body.shop), JSON.stringify(r.body).slice(0, 120));

  console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  done(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); done(2); });
