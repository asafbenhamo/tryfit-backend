// ============================================================================
// TEST: billing. Run with:   node test-billing.js
//
// Charging a merchant twice for the same sale is the fastest way to lose them,
// and charging past the cap they approved is a policy violation. Both are
// guarded here. Shopify and Postgres are stubbed; no network, no money.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- stubs ---------------------------------------------------------------
let claimed = new Map();     // idempotency_key -> row  (stands in for the UNIQUE index)
let charges = [];            // rows
let nextId = 1;
let graphqlCalls = [];
let SUB = null;              // what Shopify reports as the active subscription

const dbStub = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    // The claim is an upsert now, not INSERT ... DO NOTHING: a charge that
    // failed for a temporary reason has to be reclaimable, or the sale is
    // never billed. Reclaim requires a non-terminal status, attempts left, and
    // a cooled-off last attempt — mirrored here so the guarantees are real.
    if (/INSERT INTO app_usage_charges/.test(s)) {
      const [shop, actionId, , key, amount, , , terminal, maxAttempts, retryMin] = params;
      const existing = claimed.get(key);
      if (!existing) {
        const row = { id: nextId++, shop, action_id: actionId, key, amount: Number(amount),
                      status: 'pending', attempts: 1, last_attempt_at: new Date() };
        claimed.set(key, row); charges.push(row);
        return { rows: [{ id: row.id, attempts: 1 }] };
      }
      const cooled = !existing.last_attempt_at ||
        existing.last_attempt_at < new Date(Date.now() - Number(retryMin) * 60000);
      if (terminal.includes(existing.status) || existing.attempts >= maxAttempts || !cooled) return { rows: [] };
      existing.status = 'pending'; existing.attempts += 1;
      existing.last_attempt_at = new Date(); existing.amount = Number(amount);
      return { rows: [{ id: existing.id, attempts: existing.attempts }] };
    }
    if (/SELECT status, attempts FROM app_usage_charges WHERE idempotency_key/.test(s)) {
      const row = claimed.get(params[0]);
      return { rows: row ? [{ status: row.status, attempts: row.attempts }] : [] };
    }
    if (/UPDATE app_usage_charges SET status/.test(s)) {
      const row = charges.find(c => c.id === params[0]);
      if (row) row.status = /status='(\w+)'/.exec(s) ? /status='(\w+)'/.exec(s)[1] : 'updated';
      return { rows: [] };
    }
    if (/SELECT .*FROM app_usage_charges/.test(s)) return { rows: charges };
    return { rows: [] };
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  const base = request.replace(/^\.\//, '').replace(/\.js$/, '');
  if (base === 'database') return dbStub;
  // getFreshToken is what billing calls now — tokens expire hourly, so the
  // client refreshes before every request. getTokenForShop is kept because
  // hasTokenForShop still uses it.
  if (base === 'shopify-client') return {
    getTokenForShop: () => 'shpat_fake',
    getFreshToken: async () => 'shpat_fake',
    hasTokenForShop: () => true
  };
  return origLoad.apply(this, arguments);
};

const billing = require('./billing-engine.js');

// Stub fetch, not the module's graphql(): the engine calls its own graphql by
// closure, so patching the export would do nothing. Going through fetch also
// means the real GraphQL request building and error handling is under test.
global.fetch = async (url, opts) => {
  const body = JSON.parse((opts && opts.body) || '{}');
  const query = body.query || '';
  const vars = body.variables || {};
  graphqlCalls.push({ query, vars });   // keep it whole: truncating hid the mutation name
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

  if (/currentAppInstallation/.test(query)) {
    return reply({ currentAppInstallation: { activeSubscriptions: SUB ? [SUB] : [] } });
  }
  if (/appUsageRecordCreate/.test(query)) {
    return reply({ appUsageRecordCreate: { userErrors: [], appUsageRecord: { id: 'gid://usage/1', price: vars.price } } });
  }
  if (/appSubscriptionCreate/.test(query)) {
    return reply({ appSubscriptionCreate: { userErrors: [], confirmationUrl: 'https://shop/confirm',
      appSubscription: { id: 'gid://sub/1', status: 'PENDING', lineItems: [{ id: 'gid://li/1' }] } } });
  }
  return reply({});
};
const isUsageCall = (c) => /appUsageRecordCreate/.test(c.query);

function activeSub(cap = 500, used = 0) {
  return { id: 'gid://sub/1', status: 'ACTIVE', test: true,
    lineItems: [{ id: 'gid://li/1', plan: { pricingDetails: {
      terms: '5%', balanceUsed: { amount: String(used), currencyCode: 'USD' },
      cappedAmount: { amount: String(cap), currencyCode: 'USD' } } } }] };
}
function reset() { claimed = new Map(); charges = []; nextId = 1; graphqlCalls = []; SUB = activeSub(); }

(async () => {
  console.log('\n-- commission maths --');
  reset();
  const cases = [[100, 5], [19.99, 1], [450, 22.5], [0.10, 0.01]];
  for (const [rev, want] of cases) {
    reset();
    const r = await billing.recordCommission('s.myshopify.com', { actionId: nextId, attributedRevenue: rev, currency: 'USD' });
    ok(`${rev} revenue -> ${want} charged`, r.ok && Math.abs(r.amount - want) < 0.005, JSON.stringify(r));
  }

  console.log('\n-- zero and negative revenue are never charged --');
  reset();
  for (const rev of [0, -50, null, undefined, 'abc']) {
    const r = await billing.recordCommission('s.myshopify.com', { actionId: 99, attributedRevenue: rev });
    ok(`revenue ${JSON.stringify(rev)} -> no charge`, r.ok !== true, JSON.stringify(r));
  }

  console.log('\n-- THE critical one: the same sale can never be billed twice --');
  reset();
  const first = await billing.recordCommission('s.myshopify.com', { actionId: 4242, attributedRevenue: 200, currency: 'USD' });
  ok('first attempt charges', first.ok === true && first.amount === 10, JSON.stringify(first));
  const again = await billing.recordCommission('s.myshopify.com', { actionId: 4242, attributedRevenue: 200, currency: 'USD' });
  ok('second attempt is refused', again.ok === false && again.skipped === 'already_billed', JSON.stringify(again));
  const third = await billing.recordCommission('s.myshopify.com', { actionId: 4242, attributedRevenue: 999, currency: 'USD' });
  ok('even with a different amount it is refused', third.ok === false && third.skipped === 'already_billed');
  const usageCalls = graphqlCalls.filter(isUsageCall);
  ok('Shopify was called exactly once', usageCalls.length === 1, String(usageCalls.length));
  ok('the idempotency key names the action', /action-4242$/.test(first.idempotencyKey), first.idempotencyKey);

  console.log('\n-- different sales bill separately --');
  reset();
  await billing.recordCommission('s.myshopify.com', { actionId: 1, attributedRevenue: 100 });
  await billing.recordCommission('s.myshopify.com', { actionId: 2, attributedRevenue: 100 });
  await billing.recordCommission('s.myshopify.com', { actionId: 3, attributedRevenue: 100 });
  ok('three sales -> three charges', graphqlCalls.filter(isUsageCall).length === 3);

  console.log('\n-- the approved cap is never exceeded --');
  reset(); SUB = activeSub(500, 495);              // only $5 of headroom left
  const over = await billing.recordCommission('s.myshopify.com', { actionId: 77, attributedRevenue: 1000 }); // wants $50
  ok('a charge past the cap is refused', over.ok === false && over.skipped === 'over_capped_amount', JSON.stringify(over));
  ok('and it says how much room is left', over.remaining === 5 && over.needed === 50, JSON.stringify(over));
  ok('Shopify was not called', graphqlCalls.filter(isUsageCall).length === 0);
  const fits = await billing.recordCommission('s.myshopify.com', { actionId: 78, attributedRevenue: 80 }); // wants $4
  ok('a charge that fits still goes through', fits.ok === true && fits.amount === 4, JSON.stringify(fits));

  console.log('\n-- no approved subscription means no charge --');
  reset(); SUB = null;
  const noSub = await billing.recordCommission('s.myshopify.com', { actionId: 5, attributedRevenue: 500 });
  ok('refused with a clear reason', noSub.ok === false && noSub.skipped === 'no_active_subscription', JSON.stringify(noSub));
  ok('Shopify usage API was not called', graphqlCalls.filter(isUsageCall).length === 0);

  console.log('\n-- a pending (unapproved) subscription is not active --');
  reset(); SUB = { id: 'gid://sub/1', status: 'PENDING', lineItems: [{ id: 'gid://li/1', plan: { pricingDetails: {} } }] };
  const pend = await billing.recordCommission('s.myshopify.com', { actionId: 6, attributedRevenue: 500 });
  ok('pending -> no charge', pend.ok === false, JSON.stringify(pend));

  console.log('\n-- subscription status reads cap and usage --');
  reset(); SUB = activeSub(500, 120);
  const st = await billing.getSubscription('s.myshopify.com');
  ok('reports active', st.active === true && st.status === 'ACTIVE');
  ok('reports used', st.used === 120, String(st.used));
  ok('reports remaining', st.remaining === 380, String(st.remaining));
  ok('carries the line item id needed for usage records', st.line_item_gid === 'gid://li/1');

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
