// ============================================================================
// TEST: Shopify session-token verification.
//   node test-session-token.js
//
// When the app is embedded in the Shopify admin, this JWT is the WHOLE security
// boundary. There is no password and no cookie — if verification can be talked
// into accepting a token it should not, anyone can read any merchant's customer
// list. So this suite is written as an attacker, not as a user: almost every
// assertion is an attempt to get a forged or misused token accepted.
// ============================================================================
const crypto = require('crypto');
const sst = require('./shopify-session-token.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const API_KEY = 'app-client-id-123';
const SECRET = 'shpss_the_app_secret';
const SHOP = 'willow.myshopify.com';

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const sign = (h, p, secret) => crypto.createHmac('sha256', secret)
  .update(`${b64(h)}.${b64(p)}`, 'utf8').digest('base64url');

function makeToken(over = {}, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.assign({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: API_KEY,
    sub: '42',
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: 'abc'
  }, over);
  return `${b64(header)}.${b64(payload)}.${sign(header, payload, secret)}`;
}

const V = (tok, over = {}) => sst.verify(tok, Object.assign({ apiKey: API_KEY, apiSecret: SECRET }, over));

(async () => {
  console.log('\n-- a genuine token from the merchant\'s admin --');
  const good = V(makeToken());
  ok('is accepted', !!good, JSON.stringify(good));
  ok('and names the right shop', good && good.shop === SHOP, good && good.shop);
  ok('and carries the user id', good && good.sub === '42');

  console.log('\n-- forging the signature --');
  ok('a token signed with the WRONG secret is refused',
     V(makeToken({}, { secret: 'not-the-secret' })) === null);
  ok('a token with no signature at all is refused',
     V(b64({ alg: 'HS256' }) + '.' + b64({ dest: `https://${SHOP}`, aud: API_KEY, exp: 9e9 }) + '.') === null);
  const t = makeToken();
  ok('flipping one character of the signature is refused',
     V(t.slice(0, -1) + (t.slice(-1) === 'A' ? 'B' : 'A')) === null);

  console.log('\n-- algorithm confusion --');
  ok('alg:none is refused', V(makeToken({}, { header: { alg: 'none', typ: 'JWT' } })) === null);
  ok('alg:None (different case) is refused', V(makeToken({}, { header: { alg: 'None' } })) === null);
  ok('alg:HS512 is refused', V(makeToken({}, { header: { alg: 'HS512' } })) === null);
  ok('alg:RS256 is refused', V(makeToken({}, { header: { alg: 'RS256' } })) === null);
  ok('a missing alg is refused', V(makeToken({}, { header: { typ: 'JWT' } })) === null);

  console.log('\n-- editing the payload after signing --');
  // Take a valid token and swap the shop, keeping the original signature.
  const parts = makeToken().split('.');
  const tampered = parts[0] + '.' + b64({
    iss: 'https://victim.myshopify.com/admin', dest: 'https://victim.myshopify.com',
    aud: API_KEY, sub: '42', exp: Math.floor(Date.now() / 1000) + 60
  }) + '.' + parts[2];
  ok('swapping the shop invalidates it', V(tampered) === null);

  console.log('\n-- a token for a DIFFERENT app --');
  ok('the wrong aud is refused', V(makeToken({ aud: 'someone-elses-app' })) === null);
  ok('a missing aud is refused', V(makeToken({ aud: undefined })) === null);
  ok('and we refuse to verify when WE have no api key configured',
     V(makeToken(), { apiKey: null }) === null);
  ok('nor with no secret configured', V(makeToken(), { apiSecret: null }) === null);

  console.log('\n-- lifetime --');
  const past = Math.floor(Date.now() / 1000) - 3600;
  ok('an expired token is refused', V(makeToken({ exp: past })) === null);
  ok('a token with no exp is refused', V(makeToken({ exp: undefined })) === null);
  ok('a non-numeric exp is refused', V(makeToken({ exp: '9999999999' })) === null);
  ok('a token not valid yet (nbf in the future) is refused',
     V(makeToken({ nbf: Math.floor(Date.now() / 1000) + 600 })) === null);
  ok('a token that expired one second ago is still inside clock skew',
     V(makeToken({ exp: Math.floor(Date.now() / 1000) - 1 })) !== null);
  ok('but well past the skew it is refused',
     V(makeToken({ exp: Math.floor(Date.now() / 1000) - (sst.CLOCK_SKEW_SEC + 30) })) === null);

  console.log('\n-- the shop the token names --');
  ok('dest and iss must agree', V(makeToken({ iss: 'https://other.myshopify.com/admin' })) === null);
  ok('a non-Shopify dest is refused', V(makeToken({ dest: 'https://evil.example.com' })) === null);
  ok('http (not https) is refused', V(makeToken({ dest: `http://${SHOP}` })) === null);
  ok('a lookalike host is refused', V(makeToken({ dest: 'https://willow.myshopify.com.evil.com' })) === null);
  ok('a subdomain trick is refused', V(makeToken({ dest: 'https://evil.willow.myshopify.com' })) === null);
  ok('a missing dest is refused', V(makeToken({ dest: undefined })) === null);
  ok('an empty dest is refused', V(makeToken({ dest: '' })) === null);
  ok('a token with iss absent but a valid dest is accepted',
     V(makeToken({ iss: undefined })) !== null);

  console.log('\n-- garbage in --');
  for (const junk of [null, undefined, '', 'abc', 'a.b', 'a.b.c.d', 'x'.repeat(200),
                      '....', '{}.{}.{}', 12345, {}, []]) {
    ok('refuses ' + JSON.stringify(junk), V(junk) === null);
  }
  ok('does not throw on any of them', true);

  console.log('\n-- our own opaque session tokens are not mistaken for these --');
  const ours = crypto.randomBytes(32).toString('base64url');
  ok('a random 256-bit token is not JWT-shaped', sst.looksLikeJwt(ours) === false, ours.slice(0, 16) + '...');
  ok('and does not verify', V(ours) === null);

  console.log('\n-- shopFromUrl on its own --');
  ok('admin URL -> host', sst.shopFromUrl('https://willow.myshopify.com/admin') === SHOP);
  ok('bare origin -> host', sst.shopFromUrl('https://willow.myshopify.com') === SHOP);
  ok('uppercase is normalised', sst.shopFromUrl('https://WILLOW.myshopify.com') === SHOP);
  ok('non-Shopify -> null', sst.shopFromUrl('https://example.com') === null);
  ok('javascript: -> null', sst.shopFromUrl('javascript:alert(1)') === null);
  ok('garbage -> null', sst.shopFromUrl('not a url') === null);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
