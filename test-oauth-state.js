// ============================================================================
// TEST: the OAuth state survives a round trip.  node test-oauth-state.js
//
// This exists because of a bug that broke EVERY install and that no test and no
// manual check caught.
//
// The state is shop + timestamp + nonce + signature, joined and base64url'd.
// It was joined with "." — and a shop domain contains dots. So
// "omer2-vgakvxso.myshopify.com" made the payload split into six fields instead
// of four, the length check rejected it, and the callback answered "state לא
// תקין" for every store, forever.
//
// What let it through: I verified /auth by checking it returned a 302 to
// Shopify with a state parameter present. That proves the state can be MADE.
// Nothing proved it could be READ BACK. A round trip is one line more of test
// and the only one that would have failed.
//
// So every case here generates a state and then reads it, and the domains used
// are real shapes with the dots left in.
// ============================================================================
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// Mirrors server-dual exactly. Kept in step by the assertion at the bottom,
// which reads the real source and fails if the separator ever changes here
// without changing there.
const SEP = '|';
const SECRET = 'shpss_test_secret';
const TTL_MS = 15 * 60 * 1000;

function makeState(shop, now = Date.now()) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = [shop, now, nonce].join(SEP);
  const sig = crypto.createHmac('sha256', SECRET).update(payload, 'utf8').digest('base64url').slice(0, 32);
  return Buffer.from(payload + SEP + sig, 'utf8').toString('base64url');
}

function readState(state, now = Date.now()) {
  try {
    const raw = Buffer.from(String(state || ''), 'base64url').toString('utf8');
    const parts = raw.split(SEP);
    if (parts.length !== 4) return null;
    const [shop, ts, nonce, sig] = parts;
    const expect = crypto.createHmac('sha256', SECRET)
      .update([shop, ts, nonce].join(SEP), 'utf8').digest('base64url').slice(0, 32);
    if (sig !== expect) return null;
    if (!Number(ts) || now - Number(ts) > TTL_MS) return null;
    return shop;
  } catch (e) { return null; }
}

(async () => {
  console.log('\n-- the round trip, with the dots that broke it --');
  const shops = [
    'omer2-vgakvxso.myshopify.com',      // the store that exposed it
    'nxpyjw-x8.myshopify.com',
    'seven770.myshopify.com',
    'a.myshopify.com',
    'a-very-long-store-name-with-many-hyphens.myshopify.com'
  ];
  for (const shop of shops) {
    const back = readState(makeState(shop));
    ok('survives ' + shop, back === shop, String(back));
  }
  ok('a domain with three dots still yields exactly the shop',
     readState(makeState('shop.eu.myshopify.com')) === 'shop.eu.myshopify.com');

  console.log('\n-- forging --');
  const good = makeState('willow.myshopify.com');
  ok('a state signed with a different secret is refused', (() => {
    const nonce = crypto.randomBytes(8).toString('hex');
    const payload = ['willow.myshopify.com', Date.now(), nonce].join(SEP);
    const sig = crypto.createHmac('sha256', 'WRONG').update(payload, 'utf8').digest('base64url').slice(0, 32);
    return readState(Buffer.from(payload + SEP + sig, 'utf8').toString('base64url'));
  })() === null);
  ok('an unsigned payload is refused',
     readState(Buffer.from(['willow.myshopify.com', Date.now(), 'abc', ''].join(SEP), 'utf8').toString('base64url')) === null);
  ok('flipping a character of the state is refused',
     readState(good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A')) === null);

  console.log('\n-- swapping the shop after signing --');
  // The exact attack the signature exists to stop: take a valid state and try
  // to point it at someone else's store.
  const raw = Buffer.from(good, 'base64url').toString('utf8').split(SEP);
  const swapped = ['victim.myshopify.com', raw[1], raw[2], raw[3]].join(SEP);
  ok('a state minted for one shop cannot be reused for another',
     readState(Buffer.from(swapped, 'utf8').toString('base64url')) === null);

  console.log('\n-- lifetime --');
  ok('a fresh state is accepted', readState(makeState('willow.myshopify.com')) !== null);
  const old = makeState('willow.myshopify.com', Date.now() - TTL_MS - 1000);
  ok('an expired state is refused', readState(old) === null);
  ok('one just inside the window is accepted',
     readState(makeState('willow.myshopify.com', Date.now() - TTL_MS + 5000)) !== null);

  console.log('\n-- garbage --');
  for (const junk of [null, undefined, '', 'abc', '....', '||||', 'x'.repeat(500), 12345, {}, []]) {
    ok('refuses ' + JSON.stringify(junk), readState(junk) === null);
  }

  console.log('\n-- the shipped code uses the same separator as this test --');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server-dual.js'), 'utf8');
  ok('server-dual defines OAUTH_STATE_SEP', /const OAUTH_STATE_SEP = "\|"/.test(src));
  ok('and it is NOT a dot', !/const OAUTH_STATE_SEP = "\."/.test(src));
  ok('makeOAuthState joins with it', /\[shop, Date\.now\(\), nonce\]\.join\(OAUTH_STATE_SEP\)/.test(src));
  ok('readOAuthState splits on it', /raw\.split\(OAUTH_STATE_SEP\)/.test(src));
  ok('nothing splits the state on a dot any more', !/raw\.split\("\."\)/.test(src));

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
