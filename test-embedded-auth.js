// ============================================================================
// EMBEDDED AUTH — inside the Shopify admin, nobody is ever asked to sign in.
//
// Shopify already authenticated the merchant before it opened us. App Bridge
// mints a short-lived token signed with our app secret, the server verifies it
// and learns which shop is asking. There is nothing left for the merchant to
// prove, and asking them to prove it anyway is both a dead end for them and,
// to a Shopify reviewer, evidence the integration is not real.
//
// The plumbing for this already existed and was correct. What was wrong was
// everything around it: the sign-in form was visible by default, so it sat on
// screen for as long as App Bridge took to boot; and when the embedded
// handshake failed the form simply stayed, which is the exact outcome the
// embedding was built to prevent.
//
// Also covers base-url.js, because the public address is read in eleven places
// and two of them used to ignore the environment variable entirely — so setting
// it moved the customer-facing links and left the OAuth redirect behind.
// ============================================================================

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server-dual.js'), 'utf8');

// ---------------------------------------------------------------------------
console.log('\n-- base-url.js resolves one public address --');
// ---------------------------------------------------------------------------
function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of ['PUBLIC_BASE_URL', 'RAILWAY_PUBLIC_DOMAIN']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./base-url')];
  const mod = require('./base-url');
  try { return fn(mod); } finally { process.env = saved; }
}

ok('an explicit PUBLIC_BASE_URL wins',
   withEnv({ PUBLIC_BASE_URL: 'https://smartadvisor.co.il' }, m => m.baseUrl()) === 'https://smartadvisor.co.il');
ok('a trailing slash is stripped, so joins never double up',
   withEnv({ PUBLIC_BASE_URL: 'https://smartadvisor.co.il/' }, m => m.url('/unsubscribe'))
     === 'https://smartadvisor.co.il/unsubscribe');
ok('a path with no leading slash still joins correctly',
   withEnv({ PUBLIC_BASE_URL: 'https://a.co' }, m => m.url('popup.js')) === 'https://a.co/popup.js');
ok('http is refused — we ask strangers to click these links',
   withEnv({ PUBLIC_BASE_URL: 'http://smartadvisor.co.il' }, m => m.baseUrl()) !== 'http://smartadvisor.co.il');
ok('a bare hostname is refused rather than producing relative links',
   withEnv({ PUBLIC_BASE_URL: 'smartadvisor.co.il' }, m => m.baseUrl()) !== 'smartadvisor.co.il');
ok('whitespace-only is treated as unset',
   withEnv({ PUBLIC_BASE_URL: '   ' }, m => m.baseUrl()) === m0LegacyFallback());
ok('Railway\'s own domain is used before the hard-coded legacy host',
   withEnv({ RAILWAY_PUBLIC_DOMAIN: 'smart-advisor.up.railway.app' }, m => m.baseUrl())
     === 'https://smart-advisor.up.railway.app');
ok('with nothing set at all it still returns a usable absolute URL',
   /^https:\/\/\S+$/.test(withEnv({}, m => m.baseUrl())));

function m0LegacyFallback() {
  delete require.cache[require.resolve('./base-url')];
  return require('./base-url').LEGACY_FALLBACK;
}

// ---------------------------------------------------------------------------
console.log('\n-- nothing hard-codes the address behind the resolver\'s back --');
// ---------------------------------------------------------------------------
const codeFiles = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.js') && !f.startsWith('test-') && f !== 'base-url.js')
  .map(f => path.join(ROOT, f));

const offenders = [];
for (const file of codeFiles) {
  const src = fs.readFileSync(file, 'utf8');
  // Split on \r?\n. These files are CRLF, and `.` does not match \r, so `.*$`
  // never reached the end of a line and the comment filter below matched
  // nothing at all — flagging every commented-out URL as live code.
  src.split(/\r?\n/).forEach((line, i) => {
    if (!/tryfit-backend-production/.test(line)) return;
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');   // comments are fine
    if (/tryfit-backend-production/.test(code)) {
      offenders.push(`${path.basename(file)}:${i + 1}`);
    }
  });
}
ok('no live code path hard-codes the legacy host', offenders.length === 0, offenders.join(', '));

ok('the OAuth redirect base comes from the resolver',
   /const APP_BASE_URL = publicUrl\.baseUrl\(\)/.test(server));
ok('the server announces its public address at boot',
   /publicUrl\.report\(\)/.test(server));

// ---------------------------------------------------------------------------
console.log('\n-- the sign-in form never appears inside the Shopify admin --');
// ---------------------------------------------------------------------------
const head = html.slice(0, html.indexOf('</head>'));

ok('embedded is detected from host OR embedded=1',
   /__SHOPIFY_EMBEDDED__\s*=\s*!!host \|\| q\.get\('embedded'\) === '1'/.test(head));
ok('the host is remembered for the session, so in-app navigation stays signed in',
   /sessionStorage\.setItem\('shopify_host'/.test(head) &&
   /sessionStorage\.getItem\('shopify_host'\)/.test(head));
ok('a remembered host only revives while still inside a frame',
   /else if \(framed\) host = sessionStorage\.getItem/.test(head) &&
   /try \{ framed = window\.top !== window\.self; \} catch/.test(head));
ok('private-mode sessionStorage failure does not break boot',
   /try \{[\s\S]{0,200}?sessionStorage\.setItem\('shopify_host'[\s\S]{0,600}?\} catch/.test(head));

ok('the gate is hidden by a rule written into <head>, before the body renders',
   /html\.embedded-boot #gate\{display:none !important\}/.test(head));
ok('that rule is applied only when embedded',
   /if \(window\.__SHOPIFY_EMBEDDED__\) \{[\s\S]{0,200}?embedded-boot/.test(head));
ok('there is an explicit way to reveal the gate again',
   /__showGate__\s*=\s*function/.test(head) &&
   /classList\.remove\('embedded-boot'\)/.test(head));
ok('the reconnect prompt uses it instead of fighting the !important rule',
   /function showReconnect[\s\S]{0,220}?__showGate__\(\)/.test(html));

// ---------------------------------------------------------------------------
console.log('\n-- a failed handshake shows a diagnostic, never a password box --');
// ---------------------------------------------------------------------------
const bootstrap = (html.match(/setTimeout\(async \(\) => \{[\s\S]*?\}, 0\);/) || [''])[0];
ok('the bootstrap runs deferred, after the fetch wrapper is installed',
   bootstrap.length > 0);
ok('an embedded visitor who fails the handshake gets the diagnostic',
   /if \(EMBEDDED\) \{\s*\n\s*if \(await tryEmbedded\(\)\) return;\s*\n\s*return showEmbeddedFailure\(\);/.test(bootstrap));
ok('the operator console is behind an explicit flag',
   /OPERATOR_MODE = new URLSearchParams\(location\.search\)\.get\('console'\) === '1'/.test(html));
ok('only that flag can reveal the sign-in fields',
   /if \(OPERATOR_MODE\) \{[\s\S]{0,240}?operatorLogin'\)\.style\.display = 'block'/.test(bootstrap) &&
   (html.match(/operatorLogin'\)\.style\.display = 'block'/g) || []).length === 1);
ok('a plain visitor is told where to click instead of being offered a form',
   /id="openFromShopify"/.test(html) && /data-i18n="openIn\.body"/.test(html));
ok('the sign-in fields start hidden in the markup',
   /id="operatorLogin" style="display:none"/.test(html));
ok('the diagnostic exists and replaces the gate contents',
   /function showEmbeddedFailure\(\)[\s\S]{0,600}?g\.innerHTML =/.test(html));
ok('it offers a reload',
   /embedRetry'\)\.onclick = \(\) => location\.reload\(\)/.test(html));
ok('reinstall breaks out of the iframe — Shopify refuses to render consent framed',
   /window\.top\.location\.href = '\/auth\?shop='/.test(html));
ok('it never renders a password input',
   !/function showEmbeddedFailure[\s\S]{0,900}?type="password"/.test(html));
// Count definitions (key followed by a colon), not the call sites that read them.
const defs = k => (html.match(new RegExp("'embedFail\\." + k + "':", 'g')) || []).length;
ok('both languages define every new string',
   ['title', 'body', 'retry', 'reinstall'].every(k => defs(k) === 2),
   ['title', 'body', 'retry', 'reinstall'].map(k => `${k}=${defs(k)}`).join(' '));

// ---------------------------------------------------------------------------
console.log('\n-- every embedded API call carries a Shopify-signed token --');
// ---------------------------------------------------------------------------
ok('the wrapper mints a fresh token per request when embedded',
   /if \(EMBEDDED && APP_BRIDGE_READY\) \{[\s\S]{0,200}?await shopifySessionToken\(\)/.test(html));
ok('it sends it as a bearer token',
   /h\.set\('Authorization', 'Bearer ' \+ sid\)/.test(html));
ok('it strips any password the call sites still write',
   /params\.delete\('password'\)/.test(html));
ok('the token is fetched per call, not cached in a variable',
   !/let\s+CACHED_SESSION_TOKEN/.test(html));

// ---------------------------------------------------------------------------
console.log('\n-- the server trusts only a properly signed Shopify token --');
// ---------------------------------------------------------------------------
ok('a JWT is verified against the app secret',
   /shopifySessionToken\.verify\(token, \{[\s\S]{0,120}?apiSecret: shopifyAppSecret\(\)/.test(server));
ok('a merchant in their own admin is never the platform super-admin',
   /via: 'shopify'[\s\S]{0,40}?\}/.test(server) &&
   /is_master: false, via: 'shopify'/.test(server));
ok('a failed JWT does not fall through to the opaque-token verifier',
   /if \(shopifySessionToken\.looksLikeJwt\(token\)\) \{[\s\S]*?\} else \{[\s\S]{0,200}?sessionAuth\.resolve/.test(server));

const st = require('./shopify-session-token');
ok('a tampered token is rejected',
   st.verify('eyJhbGciOiJIUzI1NiJ9.eyJkZXN0IjoiaHR0cHM6Ly9hLm15c2hvcGlmeS5jb20ifQ.bad',
             { apiKey: 'k', apiSecret: 's' }) === null);
ok('a token with no secret configured is rejected rather than trusted',
   st.verify('a.b.c', { apiKey: 'k', apiSecret: '' }) === null);

console.log(`\n${failed === 0 ? 'all' : passed + ' of ' + (passed + failed)} ${passed} assertions passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed === 0 ? 0 : 1);
