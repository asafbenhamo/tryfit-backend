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

// Evaluate the real wrapper with our variables in scope.
new Function('window', 'Headers', 'URLSearchParams',
  'return function(getTok, getShop){ ' +
  'Object.defineProperty(globalThis, "AUTH_TOKEN", { get: getTok, configurable: true });' +
  'Object.defineProperty(globalThis, "SELECTED_SHOP", { get: getShop, configurable: true });' +
  src + ' }')(global.window, global.Headers, global.URLSearchParams)(() => AUTH_TOKEN, () => SELECTED_SHOP);

const call = (url, opts) => { captured = null; window.fetch(url, opts); return captured; };
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

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})();
