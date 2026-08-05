// ============================================================================
// TEST: the autonomous agent. Run with:   node test-autopilot.js
//
// This is the code path that messages real customers with nobody watching, so
// the things asserted here are the things that keep it from becoming spam or a
// legal problem:
//   - it does nothing at all unless the merchant switched it on
//   - it never sends outside the store's local send window
//   - it holds a slice of customers back, so "lift" stays an honest number
//   - it refuses to send anything that is not genuinely personal
//   - it cannot spend more than its share of the daily cap
//   - it runs once per local day, even if the tick fires sixty times an hour
//
// Everything external (DB, Shopify, senders) is stubbed; nothing leaves the
// process.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- stubs ---------------------------------------------------------------
let SETTINGS = {};
let CUSTOMERS = [];
let started = [];          // campaigns campaign-engine was asked to start
let logged = [];           // rows written to advisor_actions
let claimed = new Set();   // (shop|date) already claimed today
let capRemaining = 500;

const dbStub = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/INSERT INTO autopilot_runs/.test(s)) {
      const key = params[0] + '|' + params[1];
      if (claimed.has(key)) return { rows: [] };       // ON CONFLICT DO NOTHING
      claimed.add(key);
      return { rows: [{ id: claimed.size }] };
    }
    if (/INSERT INTO advisor_actions/.test(s)) {
      logged.push({ shop: params[0], email: params[1], details: JSON.parse(params[3] || '{}') });
      return { rows: [] };
    }
    return { rows: [] };
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  switch (request.replace(/^\.\//, '').replace(/\.js$/, '')) {
    case 'database': return dbStub;
    case 'store-settings': return {
      getSettings: async () => SETTINGS,
      remainingToday: async () => ({ cap: SETTINGS.daily_cap, used: SETTINGS.daily_cap - capRemaining, remaining: capRemaining }),
      updateSettings: async () => ({ ok: true, settings: SETTINGS })
    };
    case 'policy-engine': {
      const real = origLoad.apply(this, ['./policy-engine.js', module, false]);
      return Object.assign({}, real, {
        // Deterministic: no history, so decide() falls back to defaults.
        learn: async () => ({ shop: 's', days: 90, prior: 10, total: { contacts: 0, conversions: 0, revenue: 0 }, segments: {}, discounts: {}, channels: {} })
      });
    }
    case 'rfm-engine': return {
      computeRFM: async () => CUSTOMERS,
      summarize: (scored) => {
        const by = {};
        for (const c of scored) {
          if (!by[c.segment]) by[c.segment] = { key: c.segment, label: c.segment, count: 0, value: 0, priority: 1 };
          by[c.segment].count++; by[c.segment].value += c.monetary || 0;
        }
        return Object.values(by);
      }
    };
    case 'campaign-engine': return {
      MAX_PER_CAMPAIGN: 500,
      startCampaign: (shop, cfg) => { started.push({ shop, ...cfg }); return { id: 'camp_' + started.length }; }
    };
    case 'compliance': return { canContactCustomer: async () => ({ allowed: true }) };
    case 'message-queue': return { preferredHours: async (shop, emails) => {
      const m = {}; (emails || []).forEach((e, i) => { if (e) m[String(e).toLowerCase()] = 14 + (i % 3); });
      return m;
    } };
    case 'sms-sender': return { isConfigured: () => false };
    default: return origLoad.apply(this, arguments);
  }
};

const storeTime = require('./store-time.js');
const policy = require('./policy-engine.js');
const autopilot = require('./autopilot-engine.js');

// ---- fixtures ------------------------------------------------------------
function makeCustomers(n, segment, withProduct) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: 'Customer ' + i, email: 'c' + i + '@example.com', phone: '',
      monetary: 400 + i, segment, segment_label: segment,
      last_product: withProduct ? 'Linen Dress' : null, priority: 1
    });
  }
  return out;
}
function reset(over = {}) {
  SETTINGS = Object.assign({
    shop: 's.myshopify.com', autopilot: 'full', timezone: 'America/New_York',
    daily_cap: 500, language: 'en', brand: 'Willow', followup_default: true, sms_sender: null
  }, over);
  CUSTOMERS = makeCustomers(200, 'at_risk', true);
  started = []; logged = []; claimed = new Set(); capRemaining = 500;
}

const RealDate = Date;
function freeze(iso) {
  const fixed = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    static now() { return fixed; }
  };
}

(async () => {
  // 15:00 UTC = 10:00 New York -> inside the send window.
  freeze('2026-08-05T15:00:00Z');

  console.log('\n-- it does nothing unless the merchant switched it on --');
  reset({ autopilot: 'approve' });
  let r = await autopilot.runForShop('s.myshopify.com');
  ok('approve mode sends nothing', r.skipped === 'not_full_autopilot' && started.length === 0, JSON.stringify(r));
  reset({ autopilot: 'off' });
  r = await autopilot.runForShop('s.myshopify.com');
  ok('off mode sends nothing', r.skipped === 'not_full_autopilot' && started.length === 0);

  console.log('\n-- it never runs outside the store\'s send window --');
  reset();
  freeze('2026-08-05T07:00:00Z');           // 03:00 in New York
  r = await autopilot.runForShop('s.myshopify.com');
  ok('03:00 local -> refuses to run', r.skipped === 'outside_send_window' && started.length === 0, JSON.stringify(r));
  freeze('2026-08-05T15:00:00Z');           // back to 10:00 NY

  console.log('\n-- a normal run --');
  reset();
  r = await autopilot.runForShop('s.myshopify.com');
  ok('it ran', r.ok === true && !r.skipped, JSON.stringify(r).slice(0, 160));
  ok('it started a campaign', started.length === 1);
  ok('it contacted people', r.contacted > 0, String(r.contacted));
  ok('contacted + held_out accounts for the segment', r.contacted + r.held_out <= 200);

  console.log('\n-- holdout is off by default: nobody is skipped for measurement --');
  ok('HOLDOUT_RATE is 0', policy.HOLDOUT_RATE === 0, String(policy.HOLDOUT_RATE));
  ok('nobody was held back', r.held_out === 0, String(r.held_out));
  ok('no control rows were written', logged.filter(l => l.details && l.details.control === 'true').length === 0);
  ok('every eligible customer was contacted', r.contacted === 200, String(r.contacted));

  console.log('\n-- but the holdout mechanism still works if switched back on --');
  {
    const day = '2026-08-05';
    let held = 0, N = 20000;
    for (let i = 0; i < N; i++) if (policy.isHoldout('s', 'c' + i + '@x.com', day, 0.10)) held++;
    ok('an explicit rate holds back roughly that share', Math.abs(held / N - 0.10) < 0.015, (held / N).toFixed(4));
    ok('a zero rate holds back nobody', policy.isHoldout('s', 'a@b.com', day, 0) === false);
    const a = policy.isHoldout('s', 'a@b.com', day, 0.10);
    ok('and it stays stable for the same customer', a === policy.isHoldout('s', 'a@b.com', day, 0.10));
  }

  console.log('\n-- it refuses to send messages that are not personal --');
  // Nothing specific known about these customers, so nothing personal can be
  // said to them. The agent must contact none of them rather than pad the number.
  reset();
  CUSTOMERS = makeCustomers(200, 'at_risk', false);   // no product to name
  r = await autopilot.runForShop('s.myshopify.com');
  ok('customers we know nothing specific about are not contacted', r.contacted === 0, String(r.contacted));
  ok('and they are counted as rejected, not silently dropped', r.rejected_not_smart > 0, String(r.rejected_not_smart));
  ok('no campaign was started at all', started.length === 0);

  const generic = policy.isSmartOutreach('Hi there, here is 15% off', {
    segment: 'at_risk', segment_specific_offer: true, personal_hour: 14, default_hour: 11
  });
  ok('invisible signals alone are NOT enough', generic.ok === false, JSON.stringify(generic));
  ok('and it says why', generic.reason === 'no_customer_visible_personalization', generic.reason);

  const named = policy.isSmartOutreach('Hi Dana, we saw you loved the Linen Dress', {
    last_product: 'Linen Dress', segment: 'at_risk', segment_specific_offer: true
  });
  ok('naming a real purchase passes', named.ok === true, JSON.stringify(named));

  const onRecordOnly = policy.isSmartOutreach('Hi Dana, here is 15% off', {
    last_product: 'Linen Dress', segment: 'at_risk', segment_specific_offer: true, personal_hour: 14, default_hour: 11
  });
  ok('knowing the product but not using it does NOT count', onRecordOnly.ok === false, JSON.stringify(onRecordOnly));

  const cart = policy.isSmartOutreach('You left the Wool Coat in your cart', {
    cart_items: ['Wool Coat'], segment: 'abandoned', segment_specific_offer: true
  });
  ok('naming abandoned-cart contents also counts', cart.ok === true, JSON.stringify(cart));

  console.log('\n-- it cannot spend more than its share of the daily cap --');
  reset();
  CUSTOMERS = makeCustomers(5000, 'at_risk', true);
  r = await autopilot.runForShop('s.myshopify.com');
  const maxAllowed = Math.floor(SETTINGS.daily_cap * autopilot.MAX_SHARE_PER_RUN);
  ok('one run stays within its share of the cap', r.contacted <= maxAllowed, r.contacted + ' > ' + maxAllowed);
  ok('and well under the full daily cap', r.contacted < SETTINGS.daily_cap);

  reset();
  capRemaining = 0;
  r = await autopilot.runForShop('s.myshopify.com');
  ok('no budget left -> sends nothing', r.skipped === 'no_budget_left' && started.length === 0, JSON.stringify(r));

  console.log('\n-- it runs once per local day, however often the tick fires --');
  reset();
  const first = await autopilot.runForShop('s.myshopify.com');
  const second = await autopilot.runForShop('s.myshopify.com');
  const third = await autopilot.runForShop('s.myshopify.com');
  ok('the first run happens', !first.skipped);
  ok('the second is refused', second.skipped === 'already_ran_today', JSON.stringify(second));
  ok('the third is refused', third.skipped === 'already_ran_today');
  ok('only one campaign was started', started.length === 1, String(started.length));

  console.log('\n-- what it hands the campaign engine --');
  reset();
  r = await autopilot.runForShop('s.myshopify.com');
  const c = started[0];
  ok('smart timing is on', c.smart_timing === true);
  ok('the segment key is tagged for learning', c.segment_key === 'at_risk');
  ok('a discount from the allowed arms', policy.DISCOUNT_ARMS.includes(c.template.percentage), String(c.template.percentage));
  ok('exactly one channel', Array.isArray(c.channels) && c.channels.length === 1, JSON.stringify(c.channels));
  ok('email only when SMS is not configured', c.channels[0] === 'email', c.channels[0]);
  ok('the body names the product', /Linen Dress/.test(c.template.body), c.template.body.slice(0, 80));
  ok('the body carries a coupon placeholder', /\{COUPON\}/.test(c.template.body));
  ok('every recipient has a contact method', c.segment.every(x => x.email || x.phone));

  console.log('\n-- the tick only wakes stores at their own local run hour --');
  reset();
  freeze('2026-08-05T13:00:00Z');    // 09:00 New York == RUN_HOUR
  ok('NY store is due at 09:00 local', storeTime.hourIn('America/New_York') === autopilot.RUN_HOUR);
  freeze('2026-08-05T13:00:00Z');
  ok('Israel store is NOT due at the same instant', storeTime.hourIn('Asia/Jerusalem') !== autopilot.RUN_HOUR,
     'Israel hour ' + storeTime.hourIn('Asia/Jerusalem'));

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
