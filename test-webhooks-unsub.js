// ============================================================================
// TEST: inbound webhooks and unsubscribe.  node test-webhooks-unsub.js
//
// Three things that were open:
//   - /webhook/sms-incoming skipped its check when the env secret was unset, so
//     anyone could post a fabricated inbound SMS and have the agent reply by SMS
//     to a number of their choosing, on the merchant's account.
//   - the Flashy webhook check was skipped when the caller simply OMITTED the
//     secret — bypassed by sending less, not more.
//   - /unsubscribe acted on GET, so mail scanners that follow links were
//     silently unsubscribing customers who never clicked.
// ============================================================================
const crypto = require('crypto');
const express = require('express');
const http = require('http');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const ADMIN = 'test-admin-password';
const SMS_SECRET = 'sms-hook-secret';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}
const unsubToken = (email, shop) => crypto.createHmac('sha256', ADMIN)
  .update(String(email || '').toLowerCase() + '|' + String(shop || ''), 'utf8')
  .digest('base64url').slice(0, 24);

// ---- a server mirroring the real handlers ---------------------------------
let OPTED_OUT = [];
let NOA_CALLS = [];
const app = express();
app.use(express.json());

app.post('/webhook/sms-incoming', (req, res) => {
  const secret = process.env.TEXTME_WEBHOOK_SECRET || null;
  if (!secret) return res.status(503).json({ ok: false, reason: 'webhook_not_configured' });
  const given = String(req.query.secret || '');
  if (!given || !safeEqual(given, secret)) return res.status(401).json({ ok: false, reason: 'bad_secret' });
  NOA_CALLS.push(req.body);
  res.status(200).json({ ok: true });
});

app.get('/unsubscribe', (req, res) => {
  const email = String(req.query.email || '');
  if (!email) return res.status(400).send('missing');
  res.send('<form method="POST" action="/unsubscribe">confirm</form>');
});
app.post('/unsubscribe', express.urlencoded({ extended: false }), (req, res) => {
  const email = String((req.body && req.body.email) || '');
  if (!email) return res.status(400).send('missing');
  const shop = String((req.body && req.body.shop) || 'default.myshopify.com').toLowerCase();
  const given = String((req.body && req.body.t) || '');
  if (given && !safeEqual(given, unsubToken(email, shop))) return res.status(400).send('bad link');
  OPTED_OUT.push({ email, shop, signed: !!given });
  res.send('done');
});

const server = http.createServer(app);

function req(method, path, body, isForm) {
  return new Promise((resolve) => {
    const payload = body ? (isForm ? new URLSearchParams(body).toString() : JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: payload ? {
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    if (payload) r.write(payload);
    r.end();
  });
}

// ---- the Flashy check, lifted from flashy-sync ----------------------------
function flashyCheck(secret, providedSecret) {
  if (!secret) return { ok: true, reason: 'no_secret_configured' };
  const given = String(providedSecret || '');
  if (!given || given.length !== secret.length) return { ok: false, reason: 'bad_secret' };
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_secret' };
  return { ok: true };
}

server.listen(0, async () => {
  console.log('\n-- inbound SMS webhook fails CLOSED --');
  delete process.env.TEXTME_WEBHOOK_SECRET;
  let r = await req('POST', '/webhook/sms-incoming', { from: '+15551234567', text: 'hi' });
  ok('no secret configured -> refused, not accepted', r.status === 503, String(r.status));
  ok('the agent was never invoked', NOA_CALLS.length === 0);

  process.env.TEXTME_WEBHOOK_SECRET = SMS_SECRET;
  r = await req('POST', '/webhook/sms-incoming', { from: '+1555', text: 'hi' });
  ok('missing secret -> 401', r.status === 401, String(r.status));
  r = await req('POST', '/webhook/sms-incoming?secret=wrong', { from: '+1555', text: 'hi' });
  ok('wrong secret -> 401', r.status === 401, String(r.status));
  r = await req('POST', `/webhook/sms-incoming?secret=${SMS_SECRET}`, { from: '+1555', text: 'hi' });
  ok('correct secret -> accepted', r.status === 200 && NOA_CALLS.length === 1, String(r.status));

  console.log('\n-- the Flashy check cannot be bypassed by omitting the secret --');
  ok('omitted -> refused', flashyCheck('s3cret', undefined).ok === false);
  ok('empty string -> refused', flashyCheck('s3cret', '').ok === false);
  ok('null -> refused', flashyCheck('s3cret', null).ok === false);
  ok('wrong -> refused', flashyCheck('s3cret', 'nope!!').ok === false);
  ok('correct -> accepted', flashyCheck('s3cret', 's3cret').ok === true);
  ok('no secret configured -> open by design (nothing to verify against)', flashyCheck(null, 'anything').ok === true);

  console.log('\n-- unsubscribe does not act on GET --');
  OPTED_OUT = [];
  const EMAIL = 'dana@example.com', SHOP = 'willow.myshopify.com';
  const sig = unsubToken(EMAIL, SHOP);
  r = await req('GET', `/unsubscribe?email=${encodeURIComponent(EMAIL)}&shop=${SHOP}&t=${sig}`);
  ok('GET returns a page', r.status === 200);
  ok('and nobody was unsubscribed by it', OPTED_OUT.length === 0, JSON.stringify(OPTED_OUT));
  ok('the page asks for confirmation', /form method="POST"/i.test(r.body));

  console.log('\n-- a mail scanner following the link changes nothing --');
  OPTED_OUT = [];
  for (let i = 0; i < 5; i++) await req('GET', `/unsubscribe?email=${encodeURIComponent(EMAIL)}&shop=${SHOP}&t=${sig}`);
  ok('five automated fetches, zero unsubscribes', OPTED_OUT.length === 0);

  console.log('\n-- confirming actually unsubscribes --');
  r = await req('POST', '/unsubscribe', { email: EMAIL, shop: SHOP, t: sig }, true);
  ok('POST performs it', r.status === 200 && OPTED_OUT.length === 1, JSON.stringify(OPTED_OUT));
  ok('against the right shop', OPTED_OUT[0].shop === SHOP);
  ok('and it is recorded as signed', OPTED_OUT[0].signed === true);

  console.log('\n-- a forged signature is refused --');
  OPTED_OUT = [];
  r = await req('POST', '/unsubscribe', { email: EMAIL, shop: SHOP, t: 'forged-token-here' }, true);
  ok('bad signature -> 400', r.status === 400, String(r.status));
  ok('nothing recorded', OPTED_OUT.length === 0);
  // Signed for one shop, replayed against another.
  r = await req('POST', '/unsubscribe', { email: EMAIL, shop: 'other.myshopify.com', t: sig }, true);
  ok('a signature from another shop is refused', r.status === 400, String(r.status));

  console.log('\n-- links already in customers\' inboxes keep working --');
  OPTED_OUT = [];
  r = await req('POST', '/unsubscribe', { email: EMAIL, shop: SHOP }, true);
  ok('unsigned legacy link still unsubscribes', r.status === 200 && OPTED_OUT.length === 1);
  ok('but is marked unsigned', OPTED_OUT[0].signed === false);

  server.close();
  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
});
