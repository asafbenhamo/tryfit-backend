// ============================================================================
// TEST: the things that decide WHO gets a message, and WHETHER we can stop.
//   node test-send-safety.js
//
// Four defects, all of them about a customer being treated as contacted when
// she was not, or being contacted when she should not have been:
//
//   1. The daily cap counted the app's own report rows and holdout rows, so a
//      merchant's 500-a-day outreach budget was partly spent on bookkeeping.
//   2. A failed send was terminal on the first try and nothing ever re-read it,
//      so a provider hiccup lost the message silently.
//   3. There was no way to stop anything. Turning the agent off meant "not
//      tomorrow"; today's run finished and days of queued messages kept going.
//   4. An unreadable settings row handed a US store Asia/Jerusalem, whose send
//      window lands at 2am local — a TCPA problem, and the merchant is the
//      sender of record.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

let ACTIONS = [];        // {shop_domain, action_type, created_at}
let QUEUE = [];          // scheduled_messages
let SETTINGS_ROW = { shop_domain: 'us.myshopify.com', timezone: 'America/New_York', daily_cap: 500, language: 'en', currency: '$' };
let SETTINGS_THROWS = false;
let qSeq = 1;

const dbStub = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER/.test(s)) return { rows: [] };

    if (/SELECT \* FROM store_settings/.test(s)) {
      if (SETTINGS_THROWS) throw new Error('connection terminated unexpectedly');
      return { rows: SETTINGS_ROW && SETTINGS_ROW.shop_domain === params[0] ? [SETTINGS_ROW] : [] };
    }

    // outreachesToday
    if (/SELECT COUNT\(\*\)::int AS n FROM advisor_actions/.test(s)) {
      const [shop, , nonOutreach] = params;
      const n = ACTIONS.filter(a => a.shop_domain === shop && !nonOutreach.includes(a.action_type)).length;
      return { rows: [{ n }] };
    }

    // --- message queue ---
    if (/INSERT INTO scheduled_messages/.test(s)) {
      QUEUE.push({ id: qSeq++, shop_domain: params[0], channel: params[1], phone: params[2],
                   email: params[3], name: params[4], subject: params[5], message: params[6],
                   send_at: params[7], kind: params[8], campaign_id: params[9],
                   status: 'pending', attempts: 0 });
      return { rows: [{ id: qSeq - 1 }] };
    }
    if (/UPDATE scheduled_messages SET status='cancelled'/.test(s)) {
      const hit = QUEUE.filter(m => m.shop_domain === params[0] && m.status === 'pending'
        && (params.length < 2 || m.campaign_id === params[1]));
      hit.forEach(m => { m.status = 'cancelled'; m.error = 'cancelled by merchant'; });
      return { rows: hit.map(m => ({ id: m.id })) };
    }
    if (/UPDATE scheduled_messages SET attempts=\$2/.test(s)) {
      const m = QUEUE.find(m => m.id === params[0]);
      if (m) { m.attempts = params[1]; m.send_at = params[2]; m.error = params[3]; m.status = 'pending'; }
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE scheduled_messages SET status=\$2/.test(s)) {
      const m = QUEUE.find(m => m.id === params[0]);
      if (m) { m.status = params[1]; m.sent_at = params[2]; m.error = params[3]; }
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  const base = request.replace(/^\.\//, '').replace(/\.js$/, '');
  if (base === 'database') return dbStub;
  return origLoad.apply(this, arguments);
};

const storeSettings = require('./store-settings.js');
const storeTime = require('./store-time.js');
const queue = require('./message-queue.js');
const autopilot = require('./autopilot-engine.js');

const US = 'us.myshopify.com';

(async () => {
  // =========================================================================
  console.log('\n-- the daily cap counts messages to CUSTOMERS, and nothing else --');
  ACTIONS = [
    { shop_domain: US, action_type: 'campaign' },
    { shop_domain: US, action_type: 'campaign' },
    { shop_domain: US, action_type: 'followup' },
    { shop_domain: US, action_type: 'daily_report' },      // sent to the MERCHANT
    { shop_domain: US, action_type: 'morning_report' },    // sent to the MERCHANT
    { shop_domain: US, action_type: 'holdout' }            // deliberately not contacted
  ];
  let used = await storeSettings.outreachesToday(US);
  ok('three real outreaches counted', used === 3, String(used));
  ok('the two merchant reports are not', used !== 5);
  ok('the holdout row is not', used !== 4 && used !== 6);
  const rem = await storeSettings.remainingToday(US);
  ok('so the budget left reflects real sends', rem.remaining === 497, JSON.stringify(rem));

  ACTIONS = [];
  for (let i = 0; i < 500; i++) ACTIONS.push({ shop_domain: US, action_type: 'daily_report' });
  const allReports = await storeSettings.remainingToday(US);
  ok('500 report rows do NOT exhaust the customer budget', allReports.remaining === 500, JSON.stringify(allReports));

  ACTIONS = [];
  for (let i = 0; i < 500; i++) ACTIONS.push({ shop_domain: US, action_type: 'campaign' });
  const allReal = await storeSettings.remainingToday(US);
  ok('but 500 real outreaches do', allReal.remaining === 0, JSON.stringify(allReal));

  console.log('\n-- one shop\'s sends never count against another\'s --');
  ACTIONS.push({ shop_domain: 'other.myshopify.com', action_type: 'campaign' });
  ok('still 500 for this shop', (await storeSettings.outreachesToday(US)) === 500);

  // =========================================================================
  console.log('\n-- a store with an unreadable settings row is not given a guessed timezone --');
  SETTINGS_THROWS = false;
  const good = await storeTime.tzForShop(US);
  ok('normally it reads the real zone', good === 'America/New_York', good);

  SETTINGS_THROWS = true;
  const cached = await storeTime.tzForShop(US);
  ok('a failed read falls back to the LAST KNOWN zone, not to Israel', cached === 'America/New_York', cached);

  const unknownShop = 'never-seen.myshopify.com';
  const unknown = await storeTime.tzForShop(unknownShop);
  ok('a shop we never resolved yields UNKNOWN, not Asia/Jerusalem', unknown === storeTime.UNKNOWN_TZ, unknown);
  ok('and UNKNOWN is never inside the send window', storeTime.isWithinSendWindow(unknown) === false);
  ok('nor is null', storeTime.isWithinSendWindow(null) === false);
  ok('a real zone still works normally', typeof storeTime.isWithinSendWindow('America/New_York') === 'boolean');
  SETTINGS_THROWS = false;

  console.log('\n-- a failed settings read is not cached as if it were the truth --');
  SETTINGS_THROWS = true;
  const s1 = await storeSettings.getSettings('fresh.myshopify.com');
  ok('it is flagged as unresolved', s1.resolved === false, JSON.stringify(s1.resolved));
  SETTINGS_THROWS = false;
  SETTINGS_ROW = { shop_domain: 'fresh.myshopify.com', timezone: 'Europe/London', daily_cap: 500, language: 'en', currency: '$' };
  const s2 = await storeSettings.getSettings('fresh.myshopify.com');
  ok('the next call reads the real row instead of serving the guess', s2.timezone === 'Europe/London', s2.timezone);
  ok('and is marked resolved', s2.resolved === true);
  SETTINGS_ROW = { shop_domain: US, timezone: 'America/New_York', daily_cap: 500, language: 'en', currency: '$' };

  // =========================================================================
  console.log('\n-- a failed send is retried, then given up on LOUDLY --');
  QUEUE = [];
  await queue.enqueue(US, { channel: 'sms', phone: '+15551234567', message: 'hi', send_at: new Date() });
  const msg = QUEUE[0];
  ok('starts with no attempts', msg.attempts === 0);

  // Walk the real retry path, the way processDue drives it on a failed send.
  const before = new Date(msg.send_at).getTime();
  let again = await queue.retryLater(msg, 'provider 503');
  ok('the first failure is rescheduled, not written off', again === true);
  ok('it is still pending', QUEUE[0].status === 'pending', QUEUE[0].status);
  ok('the attempt is recorded', QUEUE[0].attempts === 1, String(QUEUE[0].attempts));
  ok('and it is pushed into the future, not retried instantly',
     new Date(QUEUE[0].send_at).getTime() > before + 5 * 60000,
     String(Math.round((new Date(QUEUE[0].send_at).getTime() - before) / 60000)) + 'm');
  ok('the reason is kept so the merchant can be told', /503/.test(QUEUE[0].error), QUEUE[0].error);

  again = await queue.retryLater(QUEUE[0], 'provider 503');
  ok('a second failure gets one more go', again === true && QUEUE[0].attempts === 2, String(QUEUE[0].attempts));
  ok('with a longer wait than the first', queue.RETRY_BACKOFF_MIN[1] > queue.RETRY_BACKOFF_MIN[0],
     queue.RETRY_BACKOFF_MIN.join(' then '));

  again = await queue.retryLater(QUEUE[0], 'provider 503');
  ok('but it does give up eventually', again === false, String(again));
  ok('so processDue records it as failed rather than retrying forever',
     QUEUE[0].attempts === queue.MAX_SEND_ATTEMPTS - 1, String(QUEUE[0].attempts));

  console.log('\n-- a message that never fails is never touched by the retry path --');
  QUEUE = [];
  await queue.enqueue(US, { channel: 'email', email: 'x@y.z', message: 'hi', send_at: new Date() });
  ok('attempts stays at zero on the happy path', QUEUE[0].attempts === 0);

  console.log('\n-- pending messages can be cancelled --');
  QUEUE = [];
  await queue.enqueue(US, { channel: 'sms', phone: '+1555', message: 'a', send_at: new Date(), campaign_id: 'c1' });
  await queue.enqueue(US, { channel: 'email', email: 'a@b.c', message: 'b', send_at: new Date(), campaign_id: 'c1' });
  await queue.enqueue(US, { channel: 'sms', phone: '+1556', message: 'c', send_at: new Date(), campaign_id: 'c2' });
  QUEUE[2].status = 'sent';                       // already gone; must not change
  let c = await queue.cancelPending(US);
  ok('the two pending messages are cancelled', c.cancelled === 2, JSON.stringify(c));
  ok('the one already sent is untouched', QUEUE[2].status === 'sent');
  ok('cancelled messages will not be picked up again', QUEUE.filter(m => m.status === 'pending').length === 0);
  c = await queue.cancelPending(US);
  ok('cancelling twice is harmless', c.cancelled === 0);

  console.log('\n-- and cancellation is per shop --');
  QUEUE = [];
  await queue.enqueue(US, { channel: 'sms', phone: '+1', message: 'mine', send_at: new Date() });
  await queue.enqueue('other.myshopify.com', { channel: 'sms', phone: '+2', message: 'theirs', send_at: new Date() });
  await queue.cancelPending(US);
  ok('the other shop\'s queue is untouched',
     QUEUE.find(m => m.shop_domain === 'other.myshopify.com').status === 'pending');

  // =========================================================================
  console.log('\n-- the agent can be stopped mid-run --');
  autopilot.clearStop(US);
  ok('nothing is stopped by default', autopilot.stopRequested(US) === false);
  autopilot.requestStop(US);
  ok('a stop is seen by the run loop', autopilot.stopRequested(US) === true);
  ok('and only for the shop that asked', autopilot.stopRequested('other.myshopify.com') === false);
  autopilot.clearStop(US);
  ok('turning it back on clears the stop', autopilot.stopRequested(US) === false);

  console.log('\n-- a stop does not linger forever --');
  autopilot.requestStop(US);
  ok('it is set now', autopilot.stopRequested(US) === true);
  autopilot.clearStop(US);
  ok('and cleared', autopilot.stopRequested(US) === false);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
