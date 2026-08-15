// ============================================================================
// TEST: the unsubscribe page, against the REAL express app.
//   node test-unsubscribe-live.js
//
// Why this exists as a separate, live test.
//
// test-webhooks-unsub.js passed all 23 of its assertions while GET /unsubscribe
// returned HTTP 500 to every customer who clicked it, for every merchant, for
// as long as the endpoint has existed. It tested the compliance functions the
// handler calls, never the handler. The bug was one undefined function — `esc`
// existed only in chat.html, client-side — and no amount of stubbing the layer
// underneath would ever have found it.
//
// So this one runs the actual server and makes actual HTTP requests. The
// unsubscribe link is the legally required way out of our messages and it sits
// at the bottom of every marketing email the platform sends; if it 500s we are
// both breaking the law and, from the customer's side, refusing to stop.
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// A fixed port collides when suites run back to back and the previous
// listener has not been reaped yet, which surfaces as 'server never came up'.
const PORT = Number(process.env.TEST_PORT || (39000 + (process.pid % 900)));
const BASE = 'http://127.0.0.1:' + PORT;

// The server runs in a CHILD process, not this one. Booting express in-process
// means the test can only end by calling process.exit() while libuv still holds
// the listening socket and the app's nine setIntervals, which trips an assertion
// inside async.c on Windows and reads exactly like a failing test. A child is
// simply killed.
const SERVER = path.join(__dirname, 'server-dual.js');
const boot = [
  "const Module = require('module');",
  "const orig = Module._load;",
  "Module._load = function (r) {",
  "  const b = r.replace(/^[.][/]/, '').replace(/[.]js$/, '');",
  "  if (b === 'database') return {",
  "    testConnection: async () => false, pool: null, initializeSchema: async () => {},",
  "    query: async (sql, p) => {",
  "      p = p || [];",
  "      if (/INSERT INTO message_optouts/.test(sql)) {",
  "        console.log('OPTOUT ' + JSON.stringify({ shop: p[0], email: p[1], phone: p[2], reason: p[3] }));",
  "      }",
  "      return { rows: [], rowCount: 0 };",
  "    }",
  "  };",
  "  return orig.apply(this, arguments);",
  "};",
  'require(' + JSON.stringify(SERVER) + ');'
].join('\n');

const child = spawn(process.execPath, ['-e', boot], {
  env: Object.assign({}, process.env, {
    DATABASE_URL: 'postgres://stub', ADMIN_PASSWORD: 'testpwtestpw',
    MASTER_PASSWORD: 'masterpwmaster', ADVISOR_SHOPIFY_SECRET: 's',
    SHOPIFY_API_SECRET: 's', ANTHROPIC_API_KEY: 'k',
    PUBLIC_BASE_URL: 'https://x.test', PORT: String(PORT)
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

// Opt-outs are reported by the child over stdout, so the parent can assert on
// what actually reached the database layer.
const OPTOUTS = [];
child.stdout.on('data', (d) => {
  String(d).split('\n').forEach((line) => {
    const m = line.match(/^OPTOUT (\{.*\})\s*$/);
    if (m) { try { OPTOUTS.push(JSON.parse(m[1])); } catch (e) { /* ignore */ } }
  });
});

const done = (code) => { try { child.kill(); } catch (e) {} process.exit(code); };

const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.text() }; };
const post = async (p, form) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  return { status: r.status, body: await r.text() };
};

// Wait for the child to accept connections rather than guessing at a delay.
async function waitForServer(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(BASE + '/unsubscribe'); return true; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!(await waitForServer())) { console.error('server never came up'); return done(2); }

  const SHOP = 'willow.myshopify.com';

  console.log('\n-- a customer clicks the unsubscribe link in a marketing email --');
  let r = await get('/unsubscribe?email=dana%40example.com&shop=' + encodeURIComponent(SHOP));
  ok('the page loads at all', r.status === 200, 'HTTP ' + r.status);
  ok('it does NOT return a server error', !/ReferenceError|is not defined|<pre>/.test(r.body), r.body.slice(0, 120));
  ok('it tells her which address it is about', r.body.includes('dana@example.com'));
  ok('it carries her shop into the form', r.body.includes(SHOP));
  ok('it asks before doing anything (GET never opts out)', OPTOUTS.length === 0);
  ok('there is a button to confirm', /<button[^>]*type="submit"/.test(r.body));

  console.log('\n-- she confirms --');
  r = await post('/unsubscribe', 'email=dana%40example.com&shop=' + encodeURIComponent(SHOP));
  ok('the confirmation succeeds', r.status === 200, 'HTTP ' + r.status);
  await new Promise(res => setTimeout(res, 300));   // let the child's stdout arrive
  ok('she is recorded as opted out', OPTOUTS.length === 1, JSON.stringify(OPTOUTS));
  ok('against HER merchant, not the pilot store', OPTOUTS[0] && OPTOUTS[0].shop === SHOP, OPTOUTS[0] && OPTOUTS[0].shop);
  ok('and a reason is stored (the column the table was missing)', OPTOUTS[0] && !!OPTOUTS[0].reason,
     JSON.stringify(OPTOUTS[0] && OPTOUTS[0].reason));

  console.log('\n-- the page cannot be turned into an attack --');
  r = await get('/unsubscribe?email=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
  ok('injected markup is escaped, not rendered', !/<img src=x/.test(r.body) && /&lt;img/.test(r.body));
  ok('no server error on hostile input', r.status === 200 && !/ReferenceError/.test(r.body), 'HTTP ' + r.status);
  r = await get('/unsubscribe?email=a%40b.c&shop=' + encodeURIComponent('"><script>alert(1)</script>'));
  ok('a hostile shop value is escaped too', !/<script>alert/.test(r.body));

  console.log('\n-- a link with no address is refused, politely --');
  r = await get('/unsubscribe');
  ok('missing email -> 400, not a crash', r.status === 400, 'HTTP ' + r.status);
  ok('and it explains itself in HTML, not a stack trace', /<html/i.test(r.body) && !/ReferenceError/.test(r.body));

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  done(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); done(2); });
