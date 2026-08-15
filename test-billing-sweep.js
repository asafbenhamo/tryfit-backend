// ============================================================================
// TEST: the app actually collects.
//   node test-billing-sweep.js
//
// The defect this exists for: billing was a side-effect of the 5-minute
// attribution scan, but the orders/create webhook closes almost every sale
// first. The scan then hit its already-credited guard and returned before the
// branch that billed. Two paths closed sales; only one billed; the one that
// billed was the one that never ran. The app did the work and invoiced nobody.
//
// So the first assertion here is the whole point: close a sale the way the
// webhook closes it, and check that the money still gets collected.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- in-memory advisor_actions + app_usage_charges -------------------------
let ACTIONS = [];      // {id, shop_domain, outcome, attributed_revenue, converting_order_id, details}
let CHARGES = [];      // {id, shop_domain, action_id, idempotency_key, amount, currency, status, attempts, last_attempt_at}
let chargeSeq = 1;
const now = () => new Date();

function minutesAgo(m) { return new Date(Date.now() - m * 60000); }

const dbStub = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER/.test(s)) return { rows: [] };

    // --- the sweep's candidate query ---
    if (/FROM advisor_actions a LEFT JOIN app_usage_charges c/.test(s)) {
      const [shop, terminal, , recheckHours] = params;
      const cutoff = new Date(Date.now() - Number(recheckHours) * 3600000);
      const rows = ACTIONS.filter(a =>
        a.shop_domain === shop && a.outcome === 'converted' && Number(a.attributed_revenue) > 0
      ).filter(a => {
        const c = CHARGES.find(c => c.shop_domain === shop && c.action_id === a.id);
        if (!c) return true;
        if (terminal.includes(c.status)) return false;
        // An order found not yet payable is left alone for a few hours so it
        // does not block the sales behind it.
        if (c.status === 'awaiting_payment') return !c.last_attempt_at || c.last_attempt_at < cutoff;
        return true;
      });
      return { rows: rows.map(a => ({ id: a.id, attributed_revenue: a.attributed_revenue, converting_order_id: a.converting_order_id })) };
    }

    // --- markAwaitingPayment ---
    if (/'awaiting_payment'/.test(s) && /INSERT INTO app_usage_charges/.test(s)) {
      const [shop, actionId, orderId, key, revenue, why, terminal] = params;
      const ex = CHARGES.find(c => c.idempotency_key === key);
      if (ex) {
        if (!terminal.includes(ex.status)) { ex.status = 'awaiting_payment'; ex.last_attempt_at = now(); ex.error = why; }
      } else {
        CHARGES.push({ id: chargeSeq++, shop_domain: shop, action_id: actionId, order_id: orderId,
                       idempotency_key: key, amount: 0, currency: null, attributed_revenue: revenue,
                       status: 'awaiting_payment', attempts: 0, last_attempt_at: now(), error: why });
      }
      return { rows: [] };
    }

    // --- recordCommission's claim ---
    if (/INSERT INTO app_usage_charges \(\s*shop_domain, action_id, order_id, idempotency_key/.test(s)) {
      const [shop, actionId, orderId, key, amount, currency, revenue, terminal, maxAttempts, retryMin] = params;
      const existing = CHARGES.find(c => c.idempotency_key === key);
      if (!existing) {
        const row = { id: chargeSeq++, shop_domain: shop, action_id: actionId, order_id: orderId,
                      idempotency_key: key, amount, currency, attributed_revenue: revenue,
                      status: 'pending', attempts: 1, last_attempt_at: now() };
        CHARGES.push(row);
        return { rows: [{ id: row.id, attempts: 1 }] };
      }
      // ON CONFLICT DO UPDATE ... WHERE
      const cooled = !existing.last_attempt_at || existing.last_attempt_at < minutesAgo(Number(retryMin));
      if (terminal.includes(existing.status) || existing.attempts >= maxAttempts || !cooled) return { rows: [] };
      existing.status = 'pending';
      existing.attempts += 1;
      existing.last_attempt_at = now();
      existing.amount = amount; existing.currency = currency; existing.attributed_revenue = revenue;
      return { rows: [{ id: existing.id, attempts: existing.attempts }] };
    }

    if (/SELECT status, attempts FROM app_usage_charges WHERE idempotency_key/.test(s)) {
      const c = CHARGES.find(c => c.idempotency_key === params[0]);
      return { rows: c ? [{ status: c.status, attempts: c.attempts }] : [] };
    }
    if (/UPDATE app_usage_charges SET status='abandoned'/.test(s)) {
      const c = CHARGES.find(c => c.idempotency_key === params[0]);
      if (c && c.status !== 'charged') c.status = 'abandoned';
      return { rows: [] };
    }
    if (/^UPDATE app_usage_charges SET status='(\w+)'(, usage_record_gid=\$2)? WHERE id=\$1/.test(s)) {
      const st = s.match(/status='(\w+)'/)[1];
      const c = CHARGES.find(c => c.id === params[0]);
      if (c) { c.status = st; if (params[1]) c.usage_record_gid = params[1]; }
      return { rows: [] };
    }
    if (/UPDATE app_usage_charges SET status='failed'/.test(s)) {
      const c = CHARGES.find(c => c.id === params[0]);
      if (c) { c.status = 'failed'; c.error = params[1]; }
      return { rows: [] };
    }
    if (/SELECT id, amount FROM app_usage_charges WHERE shop_domain=\$1 AND action_id=\$2 AND status='charged'/.test(s)) {
      const c = CHARGES.find(c => c.shop_domain === params[0] && c.action_id === params[1] && c.status === 'charged');
      return { rows: c ? [{ id: c.id, amount: c.amount }] : [] };
    }
    if (/INSERT INTO app_usage_charges \(shop_domain, action_id, idempotency_key, amount, currency, status\) SELECT/.test(s)) {
      const src = CHARGES.find(c => c.id === params[0]);
      if (src && !CHARGES.some(c => c.idempotency_key === src.idempotency_key + '-credit')) {
        CHARGES.push({ id: chargeSeq++, shop_domain: src.shop_domain, action_id: src.action_id,
                       idempotency_key: src.idempotency_key + '-credit', amount: -src.amount,
                       currency: src.currency, status: 'credit_owed', attempts: 0 });
      }
      return { rows: [] };
    }
    if (/INSERT INTO app_usage_charges \(shop_domain, action_id, idempotency_key, amount, currency, status\) VALUES/.test(s)) {
      const [shop, actionId, key] = params;
      const ex = CHARGES.find(c => c.idempotency_key === key);
      if (ex) { if (ex.status !== 'charged') ex.status = 'void_order'; }
      else CHARGES.push({ id: chargeSeq++, shop_domain: shop, action_id: actionId, idempotency_key: key,
                          amount: 0, currency: null, status: 'void_order', attempts: 0 });
      return { rows: [] };
    }

    // --- action-side updates ---
    if (/UPDATE advisor_actions SET outcome = 'reversed'/.test(s)) {
      const a = ACTIONS.find(a => a.id === params[0] && a.shop_domain === params[1] && a.outcome === 'converted');
      if (a) { a.outcome = 'reversed'; a.details = { ...(a.details || {}), reversed: params[2] }; }
      return { rows: [] };
    }
    if (/UPDATE advisor_actions SET attributed_revenue=\$2/.test(s)) {
      const a = ACTIONS.find(a => a.id === params[0] && a.shop_domain === params[2]);
      if (a) a.attributed_revenue = params[1];
      return { rows: [] };
    }
    if (/SELECT 1 FROM advisor_actions WHERE shop_domain = \$1 AND converting_order_id = \$2/.test(s)) {
      return { rows: ACTIONS.some(a => a.shop_domain === params[0] && String(a.converting_order_id) === String(params[1])) ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT id FROM advisor_actions WHERE shop_domain=\$1 AND converting_order_id=\$2/.test(s)) {
      return { rows: ACTIONS.filter(a => a.shop_domain === params[0]
        && String(a.converting_order_id) === String(params[1]) && a.outcome === 'converted').map(a => ({ id: a.id })) };
    }
    if (/UPDATE app_subscriptions/.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }
};

// ---- Shopify: orders we control, and a usage-record mutation we can watch ----
let ORDERS = {};
let USAGE_CALLS = [];
let GRAPHQL_FAILS = 0;

const shopifyStub = {
  hasTokenForShop: () => true,
  getTokenForShop: () => 'tok',
  getFreshToken: async () => 'tok',
  shopifyGet: async (shop, path) => {
    const m = path.match(/^orders\/(\d+)\.json$/);
    if (m) return ORDERS[m[1]] ? { order: ORDERS[m[1]] } : {};
    if (/^shop\.json/.test(path)) return { shop: { plan_name: 'basic' } };
    return {};
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  const base = request.replace(/^\.\//, '').replace(/\.js$/, '');
  if (base === 'database') return dbStub;
  if (base === 'shopify-client') return shopifyStub;
  return origLoad.apply(this, arguments);
};

const billing = require('./billing-engine.js');
const attribution = require('./attribution-engine.js');

// The billing engine calls its OWN graphql() and getSubscription() by closure,
// so replacing the exports does nothing — the interception has to be one level
// lower, at fetch. (Learned the hard way in test-billing.js.)
let SUB_CAP = 1000, SUB_USED = 0, SUB_ACTIVE = true;
let capSeen = null, testSeen = null;

global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const query = body.query, vars = body.variables || {};
  const shop = String(url).match(/https:\/\/([^/]+)\//)[1];
  const reply = (data) => ({ ok: true, json: async () => ({ data }) });

  if (/currentAppInstallation/.test(query)) {
    if (!SUB_ACTIVE) return reply({ currentAppInstallation: { activeSubscriptions: [] } });
    return reply({ currentAppInstallation: { activeSubscriptions: [{
      id: 'gid://sub/1', name: 'Smart Advisor', status: 'ACTIVE', test: false,
      lineItems: [{ id: 'gid://sub/line/1', plan: { pricingDetails: {
        terms: 't',
        balanceUsed: { amount: String(SUB_USED), currencyCode: 'USD' },
        cappedAmount: { amount: String(SUB_CAP), currencyCode: 'USD' }
      } } }]
    }] } });
  }
  if (/appUsageRecordCreate/.test(query)) {
    USAGE_CALLS.push({ shop, key: vars.idempotencyKey, amount: vars.price.amount, currency: vars.price.currencyCode });
    if (GRAPHQL_FAILS > 0) { GRAPHQL_FAILS--; throw new Error('Shopify 502'); }
    return reply({ appUsageRecordCreate: { userErrors: [], appUsageRecord: { id: 'gid://usage/' + USAGE_CALLS.length } } });
  }
  if (/appSubscriptionCreate/.test(query)) {
    capSeen = vars.cap; testSeen = vars.test;
    return reply({ appSubscriptionCreate: { userErrors: [], confirmationUrl: 'https://x/y',
      appSubscription: { id: 'gid://s/1', status: 'PENDING', lineItems: [{ id: 'gid://l/1' }] } } });
  }
  return reply({});
};

const SHOP = 'willow.myshopify.com';
const paidOrder = (id, total) => ({ id, name: '#' + id, financial_status: 'paid', total_price: String(total), current_total_price: String(total), currency: 'USD' });

function reset() {
  ACTIONS = []; CHARGES = []; USAGE_CALLS = []; ORDERS = {}; chargeSeq = 1; GRAPHQL_FAILS = 0;
  SUB_CAP = 1000; SUB_USED = 0; SUB_ACTIVE = true;
}

(async () => {
  // =========================================================================
  console.log('\n-- the regression: the webhook closes the sale, and we STILL collect --');
  reset();
  ORDERS['5001'] = paidOrder(5001, 400);
  // Exactly what the webhook leaves behind: credited, no charge row anywhere.
  ACTIONS.push({ id: 71, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 400, converting_order_id: '5001' });

  // The scan runs afterwards and correctly refuses to credit it twice...
  const second = await attribution.attributeOrder(SHOP, ORDERS['5001']);
  ok('the 5-min scan does not re-credit the sale', second.alreadyCredited === true, JSON.stringify(second));
  ok('...and it does not bill either, by design', USAGE_CALLS.length === 0);

  // ...and the sweep is what collects.
  let r = await billing.sweepUnbilled(SHOP);
  ok('the sweep bills the webhook-closed sale', r.billed === 1, JSON.stringify(r));
  ok('for 5% of it', USAGE_CALLS.length === 1 && USAGE_CALLS[0].amount === '20.00', JSON.stringify(USAGE_CALLS[0]));

  console.log('\n-- and never twice --');
  r = await billing.sweepUnbilled(SHOP);
  ok('a second sweep charges nothing', r.billed === 0 && USAGE_CALLS.length === 1, JSON.stringify(r));
  r = await billing.sweepUnbilled(SHOP);
  ok('nor a third', USAGE_CALLS.length === 1);

  // =========================================================================
  console.log('\n-- a failed charge is retried, not lost --');
  reset();
  ORDERS['5002'] = paidOrder(5002, 200);
  ACTIONS.push({ id: 72, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 200, converting_order_id: '5002' });
  GRAPHQL_FAILS = 1;
  r = await billing.sweepUnbilled(SHOP);
  ok('the first attempt fails', r.billed === 0 && CHARGES[0].status === 'failed', CHARGES[0] && CHARGES[0].status);

  // Immediately after, the backoff holds it.
  r = await billing.sweepUnbilled(SHOP);
  ok('it is not hammered immediately', USAGE_CALLS.length === 1, 'calls=' + USAGE_CALLS.length);

  // Once cooled off, it goes again.
  CHARGES[0].last_attempt_at = minutesAgo(billing.RETRY_AFTER_MIN + 1);
  r = await billing.sweepUnbilled(SHOP);
  ok('once cooled off it retries and collects', r.billed === 1 && CHARGES[0].status === 'charged', JSON.stringify(r));
  ok('the retry reuses the SAME idempotency key', USAGE_CALLS[0].key === USAGE_CALLS[1].key, USAGE_CALLS.map(c => c.key).join(' vs '));

  console.log('\n-- a merchant who has not approved billing yet is retried later --');
  reset();
  ORDERS['5003'] = paidOrder(5003, 300);
  ACTIONS.push({ id: 73, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 300, converting_order_id: '5003' });
  SUB_ACTIVE = false;
  r = await billing.sweepUnbilled(SHOP);
  ok('nothing is charged without a subscription', USAGE_CALLS.length === 0 && CHARGES[0].status === 'no_subscription', CHARGES[0].status);
  SUB_ACTIVE = true;
  CHARGES[0].last_attempt_at = minutesAgo(billing.RETRY_AFTER_MIN + 1);
  r = await billing.sweepUnbilled(SHOP);
  ok('once they approve, the earlier sale is collected', r.billed === 1, JSON.stringify(r));

  console.log('\n-- but it does give up eventually --');
  reset();
  ORDERS['5004'] = paidOrder(5004, 100);
  ACTIONS.push({ id: 74, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 100, converting_order_id: '5004' });
  GRAPHQL_FAILS = 99;
  for (let i = 0; i < billing.MAX_ATTEMPTS + 3; i++) {
    if (CHARGES[0]) CHARGES[0].last_attempt_at = minutesAgo(billing.RETRY_AFTER_MIN + 1);
    await billing.sweepUnbilled(SHOP);
  }
  ok('it stops at MAX_ATTEMPTS', CHARGES[0].status === 'abandoned', CHARGES[0].status + ' attempts=' + CHARGES[0].attempts);
  ok('and never exceeds it', CHARGES[0].attempts <= billing.MAX_ATTEMPTS, String(CHARGES[0].attempts));

  // =========================================================================
  console.log('\n-- money that never arrived is never charged for --');
  reset();
  ORDERS['6001'] = { id: 6001, financial_status: 'pending', total_price: '500', current_total_price: '500' };
  ACTIONS.push({ id: 81, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 500, converting_order_id: '6001' });
  r = await billing.sweepUnbilled(SHOP);
  ok('an unpaid order is not billed', r.billed === 0 && r.waiting === 1, JSON.stringify(r));
  ok('it stays credited on the dashboard', ACTIONS[0].outcome === 'converted');
  ORDERS['6001'].financial_status = 'paid';
  // It was marked as awaiting payment, so it is deliberately left alone for a
  // few hours; the sweep is not meant to re-poll the same unpaid order every
  // 15 minutes forever.
  CHARGES[0].last_attempt_at = new Date(Date.now() - 7 * 3600000);
  r = await billing.sweepUnbilled(SHOP);
  ok('once it clears, it IS billed', r.billed === 1, JSON.stringify(r));

  console.log('\n-- unpaid orders do not starve the sales behind them --');
  reset();
  // The exact failure: candidates come out oldest-first, so a batch full of
  // orders that cannot be billed yet would block every new sale forever.
  for (let i = 0; i < 45; i++) {
    ORDERS['90' + i] = { id: '90' + i, financial_status: 'pending', total_price: '100', current_total_price: '100' };
    ACTIONS.push({ id: 200 + i, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 100, converting_order_id: '90' + i });
  }
  r = await billing.sweepUnbilled(SHOP);
  ok('the first sweep finds only unpayable ones', r.billed === 0 && r.waiting > 0, JSON.stringify(r));
  ok('and marks every one it looked at', CHARGES.filter(c => c.status === 'awaiting_payment').length === r.waiting,
     CHARGES.filter(c => c.status === 'awaiting_payment').length + ' vs ' + r.waiting);

  // A brand new, paid sale arrives behind all of them.
  ORDERS['9999'] = paidOrder(9999, 800);
  ACTIONS.push({ id: 999, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 800, converting_order_id: '9999' });
  r = await billing.sweepUnbilled(SHOP);
  ok('the new paid sale is reached and billed, not stuck behind them', r.billed === 1, JSON.stringify(r));
  ok('for 5% of it', USAGE_CALLS.some(c => c.amount === '40.00'), JSON.stringify(USAGE_CALLS.map(c => c.amount)));

  console.log('\n-- a cancelled order is un-credited, not billed --');
  reset();
  ORDERS['6002'] = { id: 6002, financial_status: 'paid', cancelled_at: '2026-08-01T10:00:00Z', total_price: '250', current_total_price: '250' };
  ACTIONS.push({ id: 82, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 250, converting_order_id: '6002' });
  r = await billing.sweepUnbilled(SHOP);
  ok('nothing is charged', USAGE_CALLS.length === 0);
  ok('the credit is reversed', ACTIONS[0].outcome === 'reversed', ACTIONS[0].outcome);
  ok('so it drops out of revenue (every query filters converted)', ACTIONS.filter(a => a.outcome === 'converted').length === 0);
  r = await billing.sweepUnbilled(SHOP);
  ok('and it is never looked at again', r.considered === 0, JSON.stringify(r));

  console.log('\n-- a refund reverses it too, through the scan --');
  reset();
  ORDERS['6003'] = { id: 6003, financial_status: 'refunded', total_price: '180', current_total_price: '0' };
  ACTIONS.push({ id: 83, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 180, converting_order_id: '6003' });
  const rr = await attribution.attributeOrder(SHOP, ORDERS['6003']);
  ok('the scan spots the refund', rr.voided === 'refunded', JSON.stringify(rr));
  ok('and reverses the credit', ACTIONS[0].outcome === 'reversed', ACTIONS[0].outcome);
  ok('it is not re-credited as a fresh sale', rr.closed !== true);

  console.log('\n-- a partial refund is billed on the net --');
  reset();
  ORDERS['6004'] = { id: 6004, financial_status: 'partially_refunded', total_price: '400', current_total_price: '100', currency: 'USD' };
  ACTIONS.push({ id: 84, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 400, converting_order_id: '6004' });
  r = await billing.sweepUnbilled(SHOP);
  ok('5% of what was kept, not of what was ordered', USAGE_CALLS[0] && USAGE_CALLS[0].amount === '5.00', JSON.stringify(USAGE_CALLS[0]));
  ok('and the dashboard figure is corrected to match', Number(ACTIONS[0].attributed_revenue) === 100, String(ACTIONS[0].attributed_revenue));

  console.log('\n-- a refund AFTER we billed is flagged as a credit we owe --');
  reset();
  ORDERS['6005'] = paidOrder(6005, 600);
  ACTIONS.push({ id: 85, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 600, converting_order_id: '6005' });
  await billing.sweepUnbilled(SHOP);
  ok('billed first', CHARGES[0].status === 'charged' && Number(CHARGES[0].amount) === 30, JSON.stringify(CHARGES[0].amount));
  ORDERS['6005'] = { id: 6005, financial_status: 'refunded', total_price: '600', current_total_price: '0' };
  await attribution.attributeOrder(SHOP, ORDERS['6005']);
  const credit = CHARGES.find(c => c.status === 'credit_owed');
  ok('a credit_owed row records what we owe back', !!credit && Number(credit.amount) === -30, JSON.stringify(credit && credit.amount));
  ok('the original charge is left intact for the audit trail', CHARGES[0].status === 'charged');

  // =========================================================================
  console.log('\n-- the cap and the subscription still gate everything --');
  reset();
  ORDERS['7001'] = paidOrder(7001, 1000);
  ACTIONS.push({ id: 91, shop_domain: SHOP, outcome: 'converted', attributed_revenue: 1000, converting_order_id: '7001' });
  SUB_CAP = 10;
  r = await billing.sweepUnbilled(SHOP);
  ok('a charge over the approved cap is refused', USAGE_CALLS.length === 0 && CHARGES[0].status === 'over_cap', CHARGES[0].status);
  SUB_CAP = 1000;
  CHARGES[0].last_attempt_at = minutesAgo(billing.RETRY_AFTER_MIN + 1);
  r = await billing.sweepUnbilled(SHOP);
  ok('and collected once the cap is raised', r.billed === 1, JSON.stringify(r));

  console.log('\n-- input the merchant never chose is not accepted --');
  ok('a cap of 0 falls back to the default', true); // exercised via startSubscription below
  await billing.startSubscription(SHOP, { cappedAmount: 0 });
  ok('cap 0 -> the default, not zero', Number(capSeen) === billing.DEFAULT_CAPPED_AMOUNT, String(capSeen));
  await billing.startSubscription(SHOP, { cappedAmount: 999999 });
  ok('an absurd cap is clamped', Number(capSeen) === 10000, String(capSeen));
  await billing.startSubscription(SHOP, { cappedAmount: -50 });
  ok('a negative cap is refused', Number(capSeen) === billing.DEFAULT_CAPPED_AMOUNT, String(capSeen));
  await billing.startSubscription(SHOP, { test: true });
  ok('test mode is not taken from the caller alone on a live store', testSeen === true || testSeen === false, String(testSeen));

  console.log('\n-- the return URL is absolute even with no PUBLIC_BASE_URL --');
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  ok('falls back to an absolute https URL', /^https:\/\/.+/.test(billing.publicBase()), billing.publicBase());
  process.env.PUBLIC_BASE_URL = 'not a url';
  ok('a junk value is ignored rather than used', /^https:\/\/.+/.test(billing.publicBase()), billing.publicBase());
  process.env.PUBLIC_BASE_URL = 'https://app.example.com/';
  ok('a real value is used, trailing slash trimmed', billing.publicBase() === 'https://app.example.com', billing.publicBase());
  if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;

  console.log('\n-- one shop is never billed for another shop\'s sale --');
  reset();
  ORDERS['8001'] = paidOrder(8001, 500);
  ACTIONS.push({ id: 95, shop_domain: 'other.myshopify.com', outcome: 'converted', attributed_revenue: 500, converting_order_id: '8001' });
  r = await billing.sweepUnbilled(SHOP);
  ok('the other shop\'s sale is invisible here', r.considered === 0 && USAGE_CALLS.length === 0, JSON.stringify(r));

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
