// ============================================================================
// TEST: send timing. Run with:   node test-send-timing.js
//
// This guards the single most dangerous invariant in the product: a marketing
// message must only ever go out inside the RECIPIENT store's local send window.
// Outside it, US law (TCPA) charges $500-$1,500 per message and the merchant --
// not us -- is the sender of record. The agent sends unattended, so nothing
// catches a regression here except this file.
//
// No dependencies, no database: store-settings and the DB are stubbed.
// ============================================================================
const T = require('./store-time.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   -> ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

console.log('\n-- timezone validation --');
ok('valid IANA accepted', T.isValidTz('America/New_York'));
ok('display string rejected', !T.isValidTz('(GMT-05:00) Eastern Time (US & Canada)'));
ok('empty rejected', !T.isValidTz(''));
ok('null rejected', !T.isValidTz(null));
eq('normalize falls back', T.normalizeTz('nonsense/zone'), 'Asia/Jerusalem');
eq('normalize keeps valid', T.normalizeTz('Europe/London'), 'Europe/London');

console.log('\n-- reading shopify shop.json --');
eq('picks iana_timezone', T.fromShopifyShop({
  timezone: '(GMT-05:00) Eastern Time (US & Canada)', iana_timezone: 'America/New_York'
}), 'America/New_York');
eq('ignores display-only', T.fromShopifyShop({ timezone: '(GMT+02:00) Jerusalem' }), null);
eq('null-safe', T.fromShopifyShop(null), null);

console.log('\n-- wall clock in zone --');
// 2026-01-15T12:00:00Z  ->  NY is UTC-5 in January
const winter = new Date('2026-01-15T12:00:00Z');
eq('NY winter hour', T.hourIn('America/New_York', winter), 7);
eq('Jerusalem winter hour', T.hourIn('Asia/Jerusalem', winter), 14);
// 2026-07-15T12:00:00Z  ->  NY is UTC-4 (EDT), Jerusalem UTC+3 (IDT)
const summer = new Date('2026-07-15T12:00:00Z');
eq('NY summer hour (DST)', T.hourIn('America/New_York', summer), 8);
eq('Jerusalem summer hour (DST)', T.hourIn('Asia/Jerusalem', summer), 15);
// date rollover across the dateline of local midnight
// 03:30Z on Mar 10 is 23:30 on Mar 9 in NY (EDT, UTC-4) — still the previous local day.
eq('NY date key before local midnight', T.dateKeyIn('America/New_York', new Date('2026-03-10T03:30:00Z')), '2026-03-09');
eq('Tokyo date key after midnight', T.dateKeyIn('Asia/Tokyo', new Date('2026-03-09T16:30:00Z')), '2026-03-10');

console.log('\n-- local wall clock -> real UTC instant --');
function roundTrip(tz, y, m, d, h, min) {
  const utc = T.zonedTimeToUtc(tz, { year: y, month: m, day: d, hour: h, minute: min });
  const back = T.partsIn(tz, utc);
  return back.year === y && back.month === m && back.day === d && back.hour === h && back.minute === min;
}
ok('NY 10:00 Jan round-trips', roundTrip('America/New_York', 2026, 1, 15, 10, 0));
ok('NY 10:00 Jul round-trips (EDT)', roundTrip('America/New_York', 2026, 7, 15, 10, 0));
ok('Jerusalem 10:00 Jan round-trips', roundTrip('Asia/Jerusalem', 2026, 1, 15, 10, 0));
ok('Jerusalem 10:00 Jul round-trips (IDT)', roundTrip('Asia/Jerusalem', 2026, 7, 15, 10, 0));
ok('Kolkata half-hour offset round-trips', roundTrip('Asia/Kolkata', 2026, 6, 1, 14, 30));
ok('Sydney (southern DST) round-trips', roundTrip('Australia/Sydney', 2026, 12, 1, 9, 15));
// The day AFTER a US spring-forward — 10:00 exists normally.
ok('NY day after spring-forward', roundTrip('America/New_York', 2026, 3, 9, 10, 0));
// Verify a known instant exactly: 2026-01-15 10:00 NY == 15:00Z
eq('NY 10:00 Jan is 15:00Z',
   T.zonedTimeToUtc('America/New_York', { year: 2026, month: 1, day: 15, hour: 10, minute: 0 }).toISOString(),
   '2026-01-15T15:00:00.000Z');
eq('NY 10:00 Jul is 14:00Z',
   T.zonedTimeToUtc('America/New_York', { year: 2026, month: 7, day: 15, hour: 10, minute: 0 }).toISOString(),
   '2026-07-15T14:00:00.000Z');

console.log('\n-- send window (09:00-20:30 store-local) --');
const inWin = (tz, iso) => T.isWithinSendWindow(tz, new Date(iso));
// 2 AM in New York — the exact case that was broken before.
ok('NY 02:00 local is BLOCKED', !inWin('America/New_York', '2026-01-15T07:00:00Z'));
ok('NY 08:59 local is BLOCKED', !inWin('America/New_York', '2026-01-15T13:59:00Z'));
ok('NY 09:00 local is allowed', inWin('America/New_York', '2026-01-15T14:00:00Z'));
ok('NY 20:30 local is allowed', inWin('America/New_York', '2026-01-16T01:30:00Z'));
ok('NY 20:31 local is BLOCKED', !inWin('America/New_York', '2026-01-16T01:31:00Z'));
ok('NY 23:00 local is BLOCKED', !inWin('America/New_York', '2026-01-16T04:00:00Z'));
ok('Jerusalem 10:00 local is allowed', inWin('Asia/Jerusalem', '2026-01-15T08:00:00Z'));
ok('Jerusalem 03:00 local is BLOCKED', !inWin('Asia/Jerusalem', '2026-01-15T01:00:00Z'));
eq('window label', T.sendWindowLabel(), '09:00-20:30');

console.log('\n-- nextSendAt always lands inside the window, in the RIGHT zone --');
const zones = ['America/New_York', 'America/Los_Angeles', 'Asia/Jerusalem', 'Europe/London',
               'Australia/Sydney', 'Asia/Kolkata', 'America/Sao_Paulo', 'Pacific/Auckland'];
let bad = [];
for (const tz of zones) {
  for (let h = 0; h <= 23; h++) {
    for (let d = 0; d <= 3; d++) {
      const when = T.nextSendAt(tz, h, d);
      if (!T.isWithinSendWindow(tz, when)) bad.push(tz + ' hour=' + h + ' day=' + d + ' -> ' + T.partsIn(tz, when).hour + ':' + T.partsIn(tz, when).minute);
      if (when.getTime() < Date.now()) bad.push(tz + ' hour=' + h + ' day=' + d + ' -> IN THE PAST');
    }
  }
}
ok('every nextSendAt across 8 zones x 24 hours x 4 days is legal', bad.length === 0, bad.slice(0, 6).join(' | '));

// Out-of-range requested hours get clamped, not rejected.
for (const tz of zones) {
  const early = T.nextSendAt(tz, 3), late = T.nextSendAt(tz, 23);
  if (!T.isWithinSendWindow(tz, early)) bad.push(tz + ' clamp-early');
  if (!T.isWithinSendWindow(tz, late)) bad.push(tz + ' clamp-late');
}
ok('hour 3 and hour 23 are clamped into the window', bad.length === 0, bad.join(' | '));

// Lead time is respected.
const soon = T.nextSendAt('Asia/Jerusalem', T.hourIn('Asia/Jerusalem'), 0);
ok('never schedules less than 10 min out', soon.getTime() - Date.now() >= 10 * 60 * 1000 - 1000);

// ============================================================================
// WIRING: drive the real compliance.js and message-queue.js with a stubbed DB
// and stubbed settings, to prove the gate is actually consulted on the send
// path — not just that the helper computes the right answer in isolation.
// ============================================================================
const Module = require('module');

const SHOP_TZ = {
  'il.myshopify.com': 'Asia/Jerusalem',
  'ny.myshopify.com': 'America/New_York',
  'la.myshopify.com': 'America/Los_Angeles'
};
let dueRows = [], dbLog = [], smsSent = [], mailSent = [];

const origLoad = Module._load;
Module._load = function (request) {
  switch (request.replace(/^\.\//, '')) {
    case 'database': return {
      query: async (sql, params) => {
        dbLog.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 60), params });
        if (/FROM scheduled_messages/.test(sql)) return { rows: dueRows };
        return { rows: [] };   // no opt-outs, no cooldown, no prior conversions
      }
    };
    case 'store-settings': return {
      getSettings: async (shop) => ({ shop, timezone: SHOP_TZ[shop] || 'Asia/Jerusalem', daily_cap: 500, brand: 'X', language: 'en' }),
      remainingToday: async () => ({ cap: 500, used: 0, remaining: 500 })
    };
    case 'sms-sender': return { isConfigured: () => true, sendOne: async (s, m) => { smsSent.push(m); return { ok: true }; } };
    case 'mailer': return { buildHtmlEmail: () => '<p>x</p>', sendEmail: async (m) => { mailSent.push(m); return { ok: true }; } };
    default: return origLoad.apply(this, arguments);
  }
};

const compliance = require('./compliance.js');
const queue = require('./message-queue.js');

// Freeze the clock at a chosen UTC instant.
const RealDate = Date;
function freeze(iso) {
  const fixed = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    static now() { return fixed; }
  };
}
function unfreeze() { global.Date = RealDate; }

(async () => {
  console.log('\n-- the gate reads each shop\'s own zone --');
  // 15:00 UTC = 17:00 Israel, 10:00 New York, 07:00 Los Angeles
  freeze('2026-01-15T15:00:00Z');
  ok('Israel 17:00 -> allowed', await compliance.isWithinWorkingHours('il.myshopify.com'));
  ok('New York 10:00 -> allowed', await compliance.isWithinWorkingHours('ny.myshopify.com'));
  ok('Los Angeles 07:00 -> BLOCKED', !(await compliance.isWithinWorkingHours('la.myshopify.com')));

  // 07:00 UTC = 09:00 Israel, 02:00 New York — the exact case that used to send.
  freeze('2026-01-15T07:00:00Z');
  ok('Israel 09:00 -> allowed', await compliance.isWithinWorkingHours('il.myshopify.com'));
  ok('New York 02:00 -> BLOCKED', !(await compliance.isWithinWorkingHours('ny.myshopify.com')));

  const gate = await compliance.canContactCustomer('ny.myshopify.com', { email: 'a@b.com' });
  ok('canContactCustomer blocks NY at 02:00', gate.allowed === false && gate.reason === 'outside_working_hours', JSON.stringify(gate));
  ok('the block names the store zone', gate.timezone === 'America/New_York', gate.timezone);
  ok('canContactCustomer allows Israel at 09:00',
     (await compliance.canContactCustomer('il.myshopify.com', { email: 'a@b.com' })).allowed === true);

  console.log('\n-- a due message outside the window is deferred, never sent --');
  smsSent = []; mailSent = []; dbLog = [];
  dueRows = [{ id: 1, shop_domain: 'ny.myshopify.com', channel: 'sms', phone: '+12125551234',
               email: 'a@b.com', name: 'Dana', message: 'hi', kind: 'timed', created_at: new RealDate() }];
  const r1 = await queue.processDue(10);
  ok('nothing sent at 02:00 NY', smsSent.length === 0 && mailSent.length === 0);
  ok('counted as out_of_hours', r1.out_of_hours === 1, JSON.stringify(r1));
  const resched = dbLog.find(d => /UPDATE scheduled_messages SET send_at/.test(d.sql));
  ok('it was rescheduled, not marked sent', !!resched);
  if (resched) ok('rescheduled into the NY window', T.isWithinSendWindow('America/New_York', resched.params[1]),
                  'landed at ' + T.hourIn('America/New_York', resched.params[1]) + ':00 NY');

  smsSent = []; dbLog = [];
  dueRows = [{ id: 2, shop_domain: 'il.myshopify.com', channel: 'sms', phone: '+972501234567',
               email: 'c@d.com', name: 'Noa', message: 'shalom', kind: 'timed', created_at: new RealDate() }];
  const r2 = await queue.processDue(10);
  ok('the Israeli shop at 09:00 does send', smsSent.length === 1 && r2.sent === 1, JSON.stringify(r2));

  console.log('\n-- computeSendAt resolves per shop --');
  unfreeze();
  for (const [shop, tz] of Object.entries(SHOP_TZ)) {
    ok(shop + ' -> inside its own window',
       T.isWithinSendWindow(tz, await queue.computeSendAt(shop, 10)));
  }

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });



