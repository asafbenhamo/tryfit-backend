// ============================================================================
// TEST: the browser never sends the merchant's password.  node test-client-auth.js
//
// chat.html builds ~26 URLs of the form `/api/x?password=` + PASSWORD. A query
// string is written verbatim into server access logs, kept in browser history,
// and leaked through Referer to third-party origins — and that password never
// expires. Rather than trust 26 call sites (and a 27th someone adds later), one
// fetch wrapper strips it and sends a session token instead.
//
// This test lifts that wrapper straight out of chat.html and runs it, so it
// fails if the shipped code regresses.
// ============================================================================
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const html = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');
const src = (html.match(/\(function patchFetch\(\)\{[\s\S]*?\n  \}\)\(\);/) || [])[0];
if (!src) { console.error('could not find patchFetch in chat.html'); process.exit(2); }

// Minimal browser surface the wrapper touches.
global.Headers = class Headers {
  constructor(init) {
    this.map = new Map();
    if (init instanceof Headers) init.map.forEach((v, k) => this.map.set(k, v));
    else if (Array.isArray(init)) init.forEach(([k, v]) => this.map.set(String(k).toLowerCase(), v));
    else if (init && typeof init === 'object') Object.entries(init).forEach(([k, v]) => this.map.set(String(k).toLowerCase(), v));
  }
  set(k, v) { this.map.set(String(k).toLowerCase(), v); }
  get(k) { return this.map.get(String(k).toLowerCase()); }
};
global.URLSearchParams = require('url').URLSearchParams;

let captured = null;
global.window = { fetch: (url, opts) => { captured = { url, opts }; return Promise.resolve({}); } };
let AUTH_TOKEN = '', SELECTED_SHOP = '';
// The wrapper also reads the embedded-mode flags. They must be in scope: the
// wrapper's outer try/catch would otherwise swallow the ReferenceError and let
// every request out with no Authorization header at all, which is a fail-safe
// direction but would make this suite pass while testing nothing.
let EMBEDDED = false, APP_BRIDGE_READY = false, SHOPIFY_ID_TOKEN = null;

// Evaluate the real wrapper with our variables in scope.
new Function('window', 'Headers', 'URLSearchParams',
  'return function(getTok, getShop, getEmb, getReady, getSid){ ' +
  'Object.defineProperty(globalThis, "AUTH_TOKEN", { get: getTok, configurable: true });' +
  'Object.defineProperty(globalThis, "SELECTED_SHOP", { get: getShop, configurable: true });' +
  'Object.defineProperty(globalThis, "EMBEDDED", { get: getEmb, configurable: true });' +
  'Object.defineProperty(globalThis, "APP_BRIDGE_READY", { get: getReady, configurable: true });' +
  'globalThis.shopifySessionToken = async () => getSid();' +
  src + ' }')(global.window, global.Headers, global.URLSearchParams)(
    () => AUTH_TOKEN, () => SELECTED_SHOP, () => EMBEDDED, () => APP_BRIDGE_READY, () => SHOPIFY_ID_TOKEN);

const call = (url, opts) => { captured = null; window.fetch(url, opts); return captured; };
// The embedded path awaits App Bridge, so the capture is not synchronous.
const callAsync = async (url, opts) => { captured = null; await window.fetch(url, opts); return captured; };
const auth = (c) => c.opts && c.opts.headers && c.opts.headers.get && c.opts.headers.get('authorization');

(async () => {
  const PW = 'the-merchants-actual-password';
  const TOK = 'Zm9vYmFyYmF6cXV4';

  console.log('\n-- before login there is no token, so nothing changes --');
  AUTH_TOKEN = ''; SELECTED_SHOP = '';
  let c = call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: PW }) });
  ok('the login call itself still carries the password', JSON.parse(c.opts.body).password === PW);
  ok('and no Authorization header is invented', !auth(c));

  console.log('\n-- once a token exists, the password stops travelling --');
  AUTH_TOKEN = TOK;
  c = call('/api/insights?password=' + encodeURIComponent(PW));
  ok('password removed from the query string', c.url.indexOf('password') === -1, c.url);
  ok('the endpoint is otherwise unchanged', c.url === '/api/insights', c.url);
  ok('the token is sent as a bearer header', auth(c) === 'Bearer ' + TOK, String(auth(c)));

  c = call('/api/chat/get/42?password=' + encodeURIComponent(PW) + '&limit=10');
  ok('other query params survive', c.url === '/api/chat/get/42?limit=10', c.url);

  c = call('/api/autopilot?password=' + encodeURIComponent(PW), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW, on: true })
  });
  ok('password removed from the JSON body too', JSON.parse(c.opts.body).password === undefined, c.opts.body);
  ok('the rest of the body survives', JSON.parse(c.opts.body).on === true);
  ok('existing headers are preserved', c.opts.headers.get('content-type') === 'application/json');
  ok('and the token is still attached', auth(c) === 'Bearer ' + TOK);

  console.log('\n-- the password never appears in ANY outgoing request --');
  AUTH_TOKEN = TOK;
  const urls = [
    '/api/insights?password=' + PW, '/api/settings?password=' + PW,
    '/api/advisor-actions-log?password=' + PW, '/api/team-stats?password=' + PW,
    '/api/autopilot/policy?password=' + PW, '/admin/list-stores?password=' + PW
  ];
  let leaked = [];
  for (const u of urls) {
    const r = call(u, { method: 'POST', body: JSON.stringify({ password: PW, x: 1 }) });
    if (String(r.url).includes(PW)) leaked.push('url:' + u);
    if (String(r.opts.body).includes(PW)) leaked.push('body:' + u);
  }
  ok('zero leaks across ' + urls.length + ' endpoints, url and body', leaked.length === 0, leaked.join(' | '));

  console.log('\n-- master still names the store it is acting on --');
  SELECTED_SHOP = 'willow.myshopify.com';
  c = call('/api/settings?password=' + PW);
  ok('shop is appended', c.url.indexOf('shop=willow.myshopify.com') > -1, c.url);
  ok('while the password is still gone', c.url.indexOf('password') === -1, c.url);
  c = call('/api/autopilot', { method: 'POST', body: JSON.stringify({ on: false }) });
  ok('and added to the body', JSON.parse(c.opts.body).shop === 'willow.myshopify.com');
  SELECTED_SHOP = '';

  console.log('\n-- non-API URLs are left alone --');
  c = call('/go/abc123');
  ok('a tracking link is untouched', c.url === '/go/abc123' && !auth(c));
  c = call('https://cdn.example.com/x.png');
  ok('an external URL gets no credentials', !auth(c));

  console.log('\n-- headers arriving in other shapes still work --');
  AUTH_TOKEN = TOK;
  c = call('/api/x', { headers: new Headers({ 'X-Thing': '1' }) });
  ok('Headers instance', auth(c) === 'Bearer ' + TOK && c.opts.headers.get('x-thing') === '1');
  c = call('/api/x', { headers: [['X-Thing', '2']] });
  ok('array of pairs', auth(c) === 'Bearer ' + TOK && c.opts.headers.get('x-thing') === '2');
  c = call('/api/x');
  ok('no headers at all', auth(c) === 'Bearer ' + TOK);

  console.log('\n-- a malformed body is passed through, not destroyed --');
  c = call('/api/x', { method: 'POST', body: 'not json at all' });
  ok('left exactly as it was', c.opts.body === 'not json at all');

  // ==========================================================================
  console.log('\n-- embedded in the Shopify admin: Shopify\'s token, never a password --');
  EMBEDDED = true; APP_BRIDGE_READY = true; SHOPIFY_ID_TOKEN = 'shopify.session.jwt';
  AUTH_TOKEN = ''; SELECTED_SHOP = '';

  c = await callAsync('/api/insights?password=' + encodeURIComponent(PW));
  ok('Shopify\'s session token is sent', auth(c) === 'Bearer shopify.session.jwt', String(auth(c)));
  ok('the password is stripped from the query string', c.url.indexOf('password') === -1, c.url);

  c = await callAsync('/api/autopilot?password=' + encodeURIComponent(PW), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW, on: true })
  });
  ok('and from the JSON body', JSON.parse(c.opts.body).password === undefined, c.opts.body);
  ok('the rest of the body survives', JSON.parse(c.opts.body).on === true);
  ok('existing headers are preserved', c.opts.headers.get('content-type') === 'application/json');

  // The merchant's own password must never travel in the admin, even if a call
  // site still writes it and even if the PWA token happens to be lying around.
  AUTH_TOKEN = TOK;
  c = await callAsync('/api/settings?password=' + encodeURIComponent(PW), {
    method: 'POST', body: JSON.stringify({ password: PW })
  });
  ok('Shopify\'s token wins over the PWA token', auth(c) === 'Bearer shopify.session.jwt', String(auth(c)));
  ok('and the password still does not leave', !String(c.url).includes(PW) && !String(c.opts.body).includes(PW));

  console.log('\n-- if App Bridge never came up, we do not invent a token --');
  APP_BRIDGE_READY = false; AUTH_TOKEN = TOK;
  c = await callAsync('/api/insights?password=' + encodeURIComponent(PW));
  ok('falls back to the PWA token', auth(c) === 'Bearer ' + TOK, String(auth(c)));

  APP_BRIDGE_READY = true; SHOPIFY_ID_TOKEN = null; AUTH_TOKEN = TOK;
  c = await callAsync('/api/insights?password=' + encodeURIComponent(PW));
  ok('a null Shopify token does not blank out auth', auth(c) === 'Bearer ' + TOK, String(auth(c)));

  console.log('\n-- non-API URLs are untouched in embedded mode too --');
  SHOPIFY_ID_TOKEN = 'shopify.session.jwt';
  c = await callAsync('/chat?shop=willow.myshopify.com');
  ok('no Authorization header on a page load', !auth(c));
  ok('the URL is unchanged', c.url === '/chat?shop=willow.myshopify.com', c.url);

  EMBEDDED = false; APP_BRIDGE_READY = false; SHOPIFY_ID_TOKEN = null;

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})();
