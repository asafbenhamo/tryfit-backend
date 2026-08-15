// ============================================================================
// SHOPIFY SESSION TOKENS — how an EMBEDDED app knows who is asking.
//
// When the app runs inside the Shopify admin, there is no password and no
// cookie: cookies are unreliable in a third-party iframe, and a password would
// mean asking a merchant who is already signed in to Shopify to sign in again.
// Instead App Bridge hands the front end a short-lived JWT, signed by Shopify
// with OUR app's client secret, and the front end sends it as a bearer token.
//
// Verifying it is the entire security boundary for the embedded app, so this is
// deliberately strict and deliberately small — no JWT library, because the one
// thing that matters here is that we never accept a token we did not check.
//
// The classic ways to get this wrong, and what we do instead:
//
//   alg=none / algorithm confusion — a token whose header says the signature
//     algorithm is "none", or RS256 when we expect HS256, so verification is
//     skipped or done with the wrong key. We accept HS256 and nothing else.
//
//   Trusting the payload before the signature — reading `dest` to find the shop
//     and only then checking the signature (or not at all). Signature first,
//     always; nothing in the payload means anything until it verifies.
//
//   Ignoring exp/nbf — Shopify's tokens live about a minute. A captured token
//     that never expires is a permanent credential.
//
//   Not checking aud — a valid Shopify token issued for a DIFFERENT app would
//     otherwise authenticate here. `aud` must be our own API key.
//
//   Timing-unsafe comparison — the signature is compared with timingSafeEqual.
//
// Docs: the token's `dest` is the shop it came from ("https://x.myshopify.com"),
// `iss` is that shop's admin URL, `aud` is the app's client ID, `sub` is the
// user, and `exp`/`nbf`/`iat` bound its life.
// ============================================================================

const crypto = require('crypto');

// Shopify's tokens are ~60s. A little leeway absorbs clock skew between their
// servers and ours without meaningfully extending a stolen token's usefulness.
const CLOCK_SKEW_SEC = 10;

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // Hash to a fixed width first: timingSafeEqual throws on a length mismatch,
  // and throwing would itself leak the length.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Does this even look like a session token? Used to decide whether to try the
// Shopify path at all, so our own opaque session tokens are not run through it.
function looksLikeJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3 && token.length > 40;
}

// Verify and decode. Returns { shop, sub, aud, exp } or null. NEVER throws —
// a malformed token is simply not authenticated.
//
// `apiKey` and `apiSecret` are passed in rather than read from the environment
// so this module stays testable and has no hidden configuration.
function verify(token, { apiKey, apiSecret, now = Date.now() } = {}) {
  try {
    if (!looksLikeJwt(token) || !apiSecret) return null;
    const [headerB64, payloadB64, sigB64] = token.split('.');

    // 1. Header: HS256 only. Not "none", not RS256, not a lowercase variant.
    let header;
    try { header = JSON.parse(b64urlToBuf(headerB64).toString('utf8')); }
    catch (e) { return null; }
    if (!header || header.alg !== 'HS256') return null;

    // 2. Signature, BEFORE reading anything from the payload.
    const expected = crypto.createHmac('sha256', apiSecret)
      .update(`${headerB64}.${payloadB64}`, 'utf8')
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!safeEqual(sigB64, expected)) return null;

    // 3. Only now is the payload worth reading.
    let p;
    try { p = JSON.parse(b64urlToBuf(payloadB64).toString('utf8')); }
    catch (e) { return null; }
    if (!p) return null;

    // 4. Lifetime.
    const nowSec = Math.floor(now / 1000);
    if (typeof p.exp !== 'number' || nowSec > p.exp + CLOCK_SKEW_SEC) return null;
    if (typeof p.nbf === 'number' && nowSec + CLOCK_SKEW_SEC < p.nbf) return null;

    // 5. Audience: this token must have been minted for THIS app. Without this
    //    check, any Shopify app's token would authenticate here.
    if (!apiKey || !p.aud || !safeEqual(p.aud, apiKey)) return null;

    // 6. The shop. `dest` is authoritative; `iss` must agree with it, or the
    //    token is describing two different stores and we trust neither.
    const shop = shopFromUrl(p.dest);
    if (!shop) return null;
    if (p.iss) {
      const issShop = shopFromUrl(p.iss);
      if (!issShop || issShop !== shop) return null;
    }

    return { shop, sub: p.sub || null, aud: p.aud, exp: p.exp, jti: p.jti || null };
  } catch (e) {
    return null;
  }
}

// "https://store.myshopify.com/admin" -> "store.myshopify.com", and nothing else.
// Anything that is not a myshopify.com host is rejected outright: this value
// decides which merchant's customer data the request may touch.
function shopFromUrl(u) {
  try {
    const url = new URL(String(u || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) return null;
    return host;
  } catch (e) {
    return null;
  }
}

module.exports = { verify, looksLikeJwt, shopFromUrl, CLOCK_SKEW_SEC };
