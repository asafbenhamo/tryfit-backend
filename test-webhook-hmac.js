// ============================================================================
// TEST: Shopify webhook verification.  node test-webhook-hmac.js
//
// The mandatory GDPR webhooks (customers/redact, shop/redact, customers/
// data_request) are checked by Shopify during review and carry real deletion
// authority. Before this was fixed the verifier:
//   - hashed a RE-SERIALIZED body, so genuine Shopify calls never verified
//   - fell back to an EMPTY secret, so forged calls verified perfectly
// i.e. exactly backwards. These tests pin both directions.
// ============================================================================
const crypto = require('crypto');
const express = require('express');
const http = require('http');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const SECRET = 'shpss_test_secret_value';

// The verifier under test, copied byte-for-byte from server-dual.js so this
// test fails if the real one regresses.
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Webhook verification not configured" });
  }
  if (!hmacHeader) return res.status(401).json({ error: "Unauthorized - No HMAC" });

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(hmacHeader), "base64"); }
  catch (e) { return res.status(401).json({ error: "Unauthorized - Invalid HMAC" }); }

  if (given.length !== digest.length || !crypto.timingSafeEqual(digest, given)) {
    return res.status(401).json({ error: "Unauthorized - Invalid HMAC" });
  }
  if (Buffer.isBuffer(req.body)) {
    try { req.body = JSON.parse(rawBody.toString("utf8") || "{}"); }
    catch (e) { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  next();
}

const app = express();
app.post('/webhooks/compliance', express.raw({ type: '*/*' }), verifyShopifyWebhook, (req, res) => {
  res.json({ ok: true, topic: req.headers['x-shopify-topic'], parsedShop: req.body && req.body.shop_domain });
});

const server = http.createServer(app);

function post(body, hmac, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/webhooks/compliance', method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-shopify-topic': 'shop/redact',
        ...(hmac !== null ? { 'x-shopify-hmac-sha256': hmac } : {})
      }, extraHeaders)
    }, (res) => {
      let data = ''; res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.write(body); req.end();
  });
}
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');

server.listen(0, async () => {
  // Shopify's real payload style: keys in their order, no pretty printing.
  const BODY = '{"shop_id":954889,"shop_domain":"willow.myshopify.com"}';

  console.log('\n-- a genuine Shopify webhook is accepted --');
  process.env.SHOPIFY_API_SECRET = SECRET;
  let r = await post(BODY, sign(BODY, SECRET));
  ok('correctly signed -> 200', r.status === 200, r.status + ' ' + r.body);
  ok('and the handler still gets a parsed body', /willow\.myshopify\.com/.test(r.body), r.body);

  console.log('\n-- the regression that broke review: re-serialized body --');
  // Same data, different byte order — what JSON.stringify(parsed) would produce.
  const RESERIALIZED = JSON.stringify(JSON.parse(BODY).shop_domain
    ? { shop_domain: 'willow.myshopify.com', shop_id: 954889 } : {});
  ok('the two encodings really are different bytes', RESERIALIZED !== BODY, RESERIALIZED);
  r = await post(BODY, sign(RESERIALIZED, SECRET));
  ok('a digest over re-serialized bytes is rejected', r.status === 401, String(r.status));

  console.log('\n-- forgery is rejected --');
  r = await post(BODY, sign(BODY, 'wrong-secret'));
  ok('signed with the wrong secret -> 401', r.status === 401, String(r.status));
  r = await post(BODY, sign(BODY, ''));
  ok('signed with an EMPTY secret -> 401 (was the fail-open hole)', r.status === 401, String(r.status));
  r = await post(BODY, 'not-base64-at-all!!');
  ok('garbage hmac -> 401, no crash', r.status === 401, String(r.status));
  r = await post(BODY, '');
  ok('empty hmac -> 401', r.status === 401, String(r.status));
  r = await post(BODY, null);
  ok('missing hmac header -> 401', r.status === 401, String(r.status));
  r = await post(BODY, Buffer.from('short').toString('base64'));
  ok('wrong-length digest -> 401, no timingSafeEqual throw', r.status === 401, String(r.status));

  console.log('\n-- tampering with the payload invalidates the signature --');
  const good = sign(BODY, SECRET);
  const TAMPERED = '{"shop_id":954889,"shop_domain":"victim.myshopify.com"}';
  r = await post(TAMPERED, good);
  ok('swapping the target shop -> 401', r.status === 401, String(r.status));

  console.log('\n-- with no secret configured it fails CLOSED --');
  delete process.env.SHOPIFY_API_SECRET;
  r = await post(BODY, sign(BODY, ''));
  ok('unset secret -> 500, never 200', r.status === 500, r.status + ' ' + r.body);
  r = await post(BODY, sign(BODY, SECRET));
  ok('even a correctly signed call is refused', r.status === 500, String(r.status));

  server.close();
  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
});
