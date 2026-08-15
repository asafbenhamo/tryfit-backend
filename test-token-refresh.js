// ============================================================================
// TEST: expiring offline access tokens.  node test-token-refresh.js
//
// Shopify stopped accepting the permanent tokens this app was built on:
//
//   [API] Non-expiring access tokens are no longer accepted for the Admin API.
//
// Every Admin API call now depends on an access token that dies after an hour
// and a refresh that has to happen without anybody watching. If this is wrong,
// the agent goes dark at some point in the night and the merchant finds out
// from an empty morning report.
//
// So: the refresh path, the stampede, the expired-refresh dead end, the legacy
// token that must keep working untouched, and the upgrade that converts one.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const tokens = require('./shopify-tokens.js');

// ---- a fake Shopify token endpoint ----------------------------------------
let CALLS = [];
let NEXT = null;          // what the endpoint should answer
let FAIL_STATUS = null;

global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  CALLS.push({ url: String(url), body });
  if (FAIL_STATUS) {
    return { ok: false, status: FAIL_STATUS, json: async () => ({ error: 'invalid_grant' }) };
  }
  return { ok: true, status: 200, json: async () => NEXT };
};

const freshPair = (n) => ({
  access_token: 'atk_' + n, refresh_token: 'rtk_' + n,
  expires_in: 3600, refresh_token_expires_in: 7776000, scope: 'read_orders'
});

(async () => {
  const SHOP = 'omer2-vgakvxso.myshopify.com';
  const creds = { clientId: 'cid', clientSecret: 'csec' };

  console.log('\n-- the install asks for an EXPIRING token --');
  CALLS = []; NEXT = freshPair(1);
  let t = await tokens.exchangeCode(SHOP, Object.assign({ code: 'abc' }, creds));
  ok('it posts to the shop\'s token endpoint', CALLS[0].url === `https://${SHOP}/admin/oauth/access_token`, CALLS[0].url);
  ok('and asks for expiring explicitly', CALLS[0].body.expiring === true, JSON.stringify(CALLS[0].body.expiring));
  ok('the code is sent', CALLS[0].body.code === 'abc');
  ok('an access token comes back', t.access_token === 'atk_1');
  ok('and a refresh token', t.refresh_token === 'rtk_1');
  ok('it is marked as expiring', t.expiring === true);

  console.log('\n-- deadlines are stored as absolute times, not durations --');
  // "expires_in: 3600" saved as-is would look fresh forever after a restart.
  const ms = new Date(t.access_expires_at).getTime() - Date.now();
  ok('access expiry is about an hour away', ms > 3500e3 && ms <= 3600e3, Math.round(ms / 1000) + 's');
  const rms = new Date(t.refresh_expires_at).getTime() - Date.now();
  ok('refresh expiry is about 90 days away', rms > 89 * 864e5 && rms <= 90 * 864e5, Math.round(rms / 864e5) + 'd');

  console.log('\n-- refreshing, with no merchant present --');
  CALLS = []; NEXT = freshPair(2);
  const r = await tokens.refresh(SHOP, Object.assign({ refreshToken: 'rtk_1' }, creds));
  ok('it uses grant_type=refresh_token', CALLS[0].body.grant_type === 'refresh_token', CALLS[0].body.grant_type);
  ok('it sends the refresh token', CALLS[0].body.refresh_token === 'rtk_1');
  ok('no code and no session token are involved', !CALLS[0].body.code && !CALLS[0].body.subject_token);
  ok('a NEW access token comes back', r.access_token === 'atk_2');
  ok('and a NEW refresh token — the old one is now spent',
     r.refresh_token === 'rtk_2' && r.refresh_token !== 'rtk_1');

  console.log('\n-- when the refresh token is dead --');
  CALLS = []; FAIL_STATUS = 400;
  let threw = null;
  try { await tokens.refresh(SHOP, Object.assign({ refreshToken: 'rtk_old' }, creds)); }
  catch (e) { threw = e; }
  ok('it throws', !!threw);
  ok('and says the merchant must reconnect', threw && threw.needsReconnect === true, String(threw && threw.needsReconnect));
  FAIL_STATUS = 500;
  threw = null;
  try { await tokens.refresh(SHOP, Object.assign({ refreshToken: 'rtk_old' }, creds)); }
  catch (e) { threw = e; }
  ok('a 500 is NOT treated as needing a reconnect', threw && threw.needsReconnect === false,
     String(threw && threw.needsReconnect));
  FAIL_STATUS = null;

  console.log('\n-- when to refresh --');
  ok('a token with an hour left is not refreshed', tokens.isExpired(new Date(Date.now() + 3600e3)) === false);
  ok('one inside the safety margin IS refreshed', tokens.isExpired(new Date(Date.now() + 60e3)) === true);
  ok('an already-expired one is refreshed', tokens.isExpired(new Date(Date.now() - 1000)) === true);
  // The margin exists because a request that starts with two seconds of validity
  // and takes three is a coin flip, and it lands on a merchant's campaign.
  ok('the margin is minutes, not seconds', tokens.REFRESH_MARGIN_MS >= 60e3, String(tokens.REFRESH_MARGIN_MS));

  console.log('\n-- a LEGACY non-expiring token is left alone --');
  ok('no expiry means not expired', tokens.isExpired(null) === false);
  ok('and it does not need reconnecting', tokens.needsReconnect({ token: 'x', refresh_token: null }) === false);
  CALLS = []; NEXT = { access_token: 'legacy_only' };   // Shopify's old response
  const legacy = tokens.normalize({ access_token: 'legacy_only' });
  ok('a response with no refresh token is marked NOT expiring', legacy.expiring === false);
  ok('and gets no invented deadline', legacy.access_expires_at === null, String(legacy.access_expires_at));

  console.log('\n-- upgrading a legacy token without the merchant --');
  CALLS = []; NEXT = freshPair(3);
  const up = await tokens.upgradeLegacyToken(SHOP, Object.assign({ legacyToken: 'old_permanent' }, creds));
  ok('it uses the token-exchange grant',
     CALLS[0].body.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange', CALLS[0].body.grant_type);
  ok('the subject is the existing offline token',
     CALLS[0].body.subject_token === 'old_permanent'
     && CALLS[0].body.subject_token_type === 'urn:shopify:params:oauth:token-type:offline-access-token',
     CALLS[0].body.subject_token_type);
  ok('it requests an offline token back',
     CALLS[0].body.requested_token_type === 'urn:shopify:params:oauth:token-type:offline-access-token');
  ok('and asks for expiring', CALLS[0].body.expiring === true);
  ok('the result is a refreshable pair', up.access_token === 'atk_3' && up.refresh_token === 'rtk_3');

  console.log('\n-- a refresh stampede must not spend the token twice --');
  // Ten queued messages for one shop all notice the token is stale at the same
  // instant. Shopify invalidates the previous refresh token on every use, so
  // ten parallel refreshes would leave nine holding a dead one.
  CALLS = []; NEXT = freshPair(4);
  let ran = 0;
  const work = () => tokens.once(SHOP, async () => {
    ran++;
    return (await tokens.refresh(SHOP, Object.assign({ refreshToken: 'rtk_3' }, creds))).access_token;
  });
  const results = await Promise.all(Array.from({ length: 10 }, work));
  ok('only ONE refresh actually ran', ran === 1, String(ran));
  ok('only one call reached Shopify', CALLS.length === 1, String(CALLS.length));
  ok('all ten callers got the same token', new Set(results).size === 1 && results[0] === 'atk_4',
     JSON.stringify([...new Set(results)]));

  console.log('\n-- and the lock clears, so the next refresh can happen --');
  CALLS = []; NEXT = freshPair(5);
  const later = await tokens.once(SHOP, async () =>
    (await tokens.refresh(SHOP, Object.assign({ refreshToken: 'rtk_4' }, creds))).access_token);
  ok('a later refresh runs normally', later === 'atk_5', later);

  console.log('\n-- two shops refresh independently --');
  CALLS = []; NEXT = freshPair(6);
  const [a, b] = await Promise.all([
    tokens.once('a.myshopify.com', async () => { await new Promise(r => setTimeout(r, 20)); return 'A'; }),
    tokens.once('b.myshopify.com', async () => 'B')
  ]);
  ok('one shop does not block another', a === 'A' && b === 'B');

  console.log('\n-- a shop whose refresh window has closed --');
  ok('expired refresh -> needs reconnect',
     tokens.needsReconnect({ refresh_token: 'x', refresh_expires_at: new Date(Date.now() - 1000) }) === true);
  ok('a live refresh window does not',
     tokens.needsReconnect({ refresh_token: 'x', refresh_expires_at: new Date(Date.now() + 864e5) }) === false);
  ok('no store at all -> needs reconnect', tokens.needsReconnect(null) === true);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
