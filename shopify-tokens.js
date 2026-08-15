// ============================================================================
// EXPIRING OFFLINE ACCESS TOKENS.
//
// Shopify stopped accepting the permanent access tokens this app was built on:
//
//   [API] Non-expiring access tokens are no longer accepted for the Admin API.
//   Start using expiring offline tokens.
//
// Public apps created on or after 1 April 2026 must use expiring tokens, and
// every public app must migrate by 1 January 2027. It is not a warning — the
// Admin API answers 403 and the app can read nothing at all. The old app kept
// working only because it predates the cutoff.
//
// The shape of the new thing:
//
//   access_token   lives 1 hour
//   refresh_token  lives 90 days, and every refresh issues a NEW one, so a shop
//                  that is touched regularly never needs the merchant again
//
// That last point is what makes the agent still possible. A refresh needs only
// the refresh token and the app's own credentials — no merchant, no browser, no
// session. Background work (the morning run, the 5-minute attribution scan, the
// billing sweep) keeps working, and each of those refreshes rolls the 90 days
// forward.
//
// A shop that goes untouched for 90 days does need the merchant to reconnect.
// That is a real edge, and the app tells them rather than failing quietly —
// see `needsReconnect`.
// ============================================================================

const crypto = require('crypto');

// Refresh this long before the token actually dies. A request that starts with
// 55 minutes of validity and takes 30 seconds is fine; one that starts with two
// seconds left is a coin flip, and the failure lands on a merchant's campaign.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Serializes refreshes per shop. Without it, ten queued messages for the same
// store all notice the token is stale at the same moment and fire ten refreshes;
// Shopify issues a new refresh_token each time and invalidates the previous, so
// nine of them race to store a token that is already dead.
const inFlight = new Map();

function tokenUrl(shop) {
  return `https://${shop}/admin/oauth/access_token`;
}

// Exchange an authorization code for an EXPIRING offline token pair.
// `expiring: 1` is the entire difference from what this app did before.
async function exchangeCode(shop, { code, clientId, clientSecret }) {
  const res = await fetch(tokenUrl(shop), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      expiring: 1
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return normalize(data);
}

// Trade a refresh token for a fresh pair. No merchant involved — this is what
// lets the agent keep working while nobody is looking at it.
async function refresh(shop, { refreshToken, clientId, clientSecret }) {
  const res = await fetch(tokenUrl(shop), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(`refresh failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    // A dead refresh token is not a transient error and must not be retried
    // forever — it means the merchant has to reconnect.
    err.needsReconnect = (res.status === 400 || res.status === 401);
    throw err;
  }
  return normalize(data);
}

// Convert a NON-expiring token that already works into an expiring pair,
// without sending the merchant through OAuth again. This is the migration path
// for shops installed before the cutoff.
async function upgradeLegacyToken(shop, { legacyToken, clientId, clientSecret }) {
  const res = await fetch(tokenUrl(shop), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: legacyToken,
      subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: 1
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`legacy upgrade failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return normalize(data);
}

// Turn Shopify's response into absolute times. Storing "expires_in: 3600" and
// working out the deadline later is how a token ends up treated as fresh
// forever after a restart.
function normalize(data) {
  const now = Date.now();
  const accessTtl = Number(data.expires_in) || 3600;
  const refreshTtl = Number(data.refresh_token_expires_in) || (90 * 24 * 3600);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    scope: data.scope || null,
    // A token with no expiry is a LEGACY one; say so explicitly rather than
    // inventing a deadline it does not have.
    expiring: !!data.refresh_token,
    access_expires_at: data.refresh_token ? new Date(now + accessTtl * 1000) : null,
    refresh_expires_at: data.refresh_token ? new Date(now + refreshTtl * 1000) : null
  };
}

function isExpired(expiresAt, marginMs = REFRESH_MARGIN_MS) {
  if (!expiresAt) return false;                 // legacy, non-expiring
  return new Date(expiresAt).getTime() - marginMs <= Date.now();
}

// Can this shop still be refreshed without the merchant?
function needsReconnect(store) {
  if (!store) return true;
  if (!store.refresh_token) return false;       // legacy token, still valid until the cutoff
  if (!store.refresh_expires_at) return false;
  return new Date(store.refresh_expires_at).getTime() <= Date.now();
}

// One refresh per shop at a time. Callers all await the same promise.
function once(shop, fn) {
  if (inFlight.has(shop)) return inFlight.get(shop);
  const p = fn().finally(() => inFlight.delete(shop));
  inFlight.set(shop, p);
  return p;
}

module.exports = {
  exchangeCode, refresh, upgradeLegacyToken, normalize,
  isExpired, needsReconnect, once,
  REFRESH_MARGIN_MS
};
