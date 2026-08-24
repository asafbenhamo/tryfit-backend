// ============================================================================
// TEST: SMS goes global, without breaking the shop that already worked.
//   node test-sms-providers.js
//
// TextMe reaches Israeli mobiles and nothing else. Any store outside Israel
// could set a sender id, watch the SMS channel turn green, and then have every
// message fall through to email. Twilio is the provider that makes SMS mean
// something for the rest of the world.
//
// The pilot shop stays on TextMe on purpose. It holds an approved sender id
// there; moving it would stop its texts until a new one is approved somewhere
// else, for nothing. Half of this file exists to keep that true.
//
// THE THING THAT WOULD HAVE BEEN LOST SILENTLY
//
// Every text this platform has ever sent carried a legal opt-out that came from
// TextMe, not from us — add_unsubscribe=3, one parameter, easy to not notice.
// Twilio has no equivalent. Swapping providers without building one would have
// removed the opt-out from every marketing SMS, and nothing would have failed,
// errored, or looked different. So: Twilio refuses to send without a link, the
// link is signed, and the endpoint behind it honours the request even when the
// signature does not match — because turning someone away from an opt-out page
// is the one failure here with legal consequences.
// ============================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

process.env.PUBLIC_BASE_URL = 'https://smartadvisor.test';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TEXTME_USERNAME = 'u';
process.env.TEXTME_API_KEY = 'k';

const sms = require('./sms-sender');
const twilio = require('./sms-provider-twilio');
const textme = require('./sms-provider-textme');

const PILOT = sms.DEFAULT_SHOP;
const SHOP = 'willow.myshopify.com';

// ---------------------------------------------------------------------------
console.log('\n-- the pilot shop does not move --');
// ---------------------------------------------------------------------------
ok('the pilot shop still sends through TextMe', sms.providerName(PILOT) === 'textme');
ok('every other shop sends through Twilio', sms.providerName(SHOP) === 'twilio');
ok('the pinning is by shop name, so adding Twilio keys cannot move the pilot',
   /s === DEFAULT_SHOP\) return textme/.test(fs.readFileSync(path.join(__dirname, 'sms-sender.js'), 'utf8')));
ok('an unknown shop defaults to the global provider, not the Israeli one',
   sms.providerName('brand-new.myshopify.com') === 'twilio');

// ---------------------------------------------------------------------------
console.log('\n-- reach is answered by the right provider --');
// ---------------------------------------------------------------------------
ok('TextMe reaches an Israeli mobile', textme.canReach('+972541234567'));
ok('TextMe does NOT reach a US number', !textme.canReach('+14155552671'));
ok('Twilio reaches an Israeli mobile', twilio.canReach('+972541234567'));
ok('Twilio reaches a UK mobile', twilio.canReach('+447911123456'));
ok('a US number is unreachable while we hold no US number to send from',
   !twilio.canReach('+14155552671'));

// ---------------------------------------------------------------------------
console.log('\n-- E.164, and when a local number cannot be resolved --');
// ---------------------------------------------------------------------------
ok('an international number passes through', twilio.normalizePhone('+972541234567') === '+972541234567');
ok('00 is understood as +', twilio.normalizePhone('00972541234567') === '+972541234567');
ok('a local number resolves when the store country is known',
   twilio.normalizePhone('054-123-4567', { country: 'IL' }) === '+972541234567');
ok('the national leading zero is dropped',
   twilio.normalizePhone('07911123456', { country: 'GB' }) === '+447911123456');
ok('North America keeps its digits', twilio.normalizePhone('(415) 555-2671', { country: 'US' }) === '+14155552671');
ok('a local number with NO known country is refused rather than guessed',
   twilio.normalizePhone('0541234567') === null);
ok('nonsense is refused', twilio.normalizePhone('12345', { country: 'IL' }) === null);
ok('the store country falls back to the timezone for shops installed before it was recorded',
   twilio.countryFromTimezone('Asia/Jerusalem') === 'IL' &&
   twilio.countryFromTimezone('America/New_York') === 'US' &&
   twilio.countryFromTimezone('Mars/Olympus') === null);

// ---------------------------------------------------------------------------
console.log('\n-- the sender name, and where it is not allowed --');
// ---------------------------------------------------------------------------
ok('a shop name is allowed as sender in Israel', twilio.allowsAlphaSender('+972541234567'));
ok('and in the UK', twilio.allowsAlphaSender('+447911123456'));
ok('but never in the US', !twilio.allowsAlphaSender('+14155552671'));
ok('nor in Canada', !twilio.allowsAlphaSender('+15145551234'));

// ---------------------------------------------------------------------------
console.log('\n-- the opt-out link Twilio will not add for us --');
// ---------------------------------------------------------------------------
const url = sms.optOutUrlFor(SHOP, '+972541234567');
ok('a link is produced', !!url, String(url));
ok('it is short enough to leave a usable message in one segment', url.length < 80, url.length + ' chars');
ok('it carries the shop prefix, not the full domain', /[?&]s=willow(&|$)/.test(url), url);
ok('it carries the last nine digits, the same form compliance matches on',
   /[?&]p=541234567(&|$)/.test(url), url);
ok('it is signed', /[?&]t=[A-Za-z0-9_-]{16}(&|$)/.test(url), url);
ok('the same number written differently produces the SAME link',
   sms.optOutUrlFor(SHOP, '0541234567') === url && sms.optOutUrlFor(SHOP, '00972541234567') === url);
ok('a different shop produces a different signature',
   sms.optOutUrlFor('other.myshopify.com', '+972541234567') !== url);
ok('an unusable number produces no link at all', sms.optOutUrlFor(SHOP, '123') === null);

// ---------------------------------------------------------------------------
console.log('\n-- and Twilio refuses to send a marketing text without one --');
// ---------------------------------------------------------------------------
(async () => {
  let called = false;
  const realFetch = global.fetch;
  global.fetch = async () => { called = true; return { ok: true, text: async () => '{"sid":"SM1"}' }; };

  let r = await twilio.send(SHOP, { phone: '+972541234567', message: 'hi', sender: 'WILLOW', optOutUrl: null });
  ok('no opt-out link means no send', r.ok === false && r.error === 'no_optout_link', JSON.stringify(r));
  ok('and the provider was never called', called === false);

  called = false;
  let sentBody = null;
  global.fetch = async (u, opts) => {
    called = true; sentBody = String(opts && opts.body || '');
    return { ok: true, text: async () => '{"sid":"SM1","status":"queued"}' };
  };
  r = await twilio.send(SHOP, { phone: '+972541234567', message: 'hi', sender: 'WILLOW', optOutUrl: 'https://x.test/u?p=1' });
  ok('with a link, it sends', r.ok === true, JSON.stringify(r));
  ok('the link is in the message body', /x\.test/.test(decodeURIComponent(sentBody)), sentBody.slice(0, 120));
  ok('the shop name is the sender', /From=WILLOW/.test(sentBody), sentBody.slice(0, 120));

  // -------------------------------------------------------------------------
  // ONE CUSTOMER LIST, MANY COUNTRIES
  //
  // Buying a number in the Twilio console asks which country the NUMBER lives
  // in. It does not decide who you may text. A Messaging Service is a POOL of
  // senders and Twilio picks the legal one per destination — which is how a
  // shop with customers in six countries is served by one account.
  //
  // The selection used to be unreachable: the condition read `&& !sender`, and
  // sender is always the shop's name, so the pool was never used at all.
  // -------------------------------------------------------------------------
  console.log('\n-- one account, customers in several countries --');
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG_test';
  const wire = [];
  global.fetch = async (u, opts) => {
    wire.push(decodeURIComponent(String(opts && opts.body || '')));
    return { ok: true, text: async () => '{"sid":"SM1","status":"queued"}' };
  };
  const dests = ['+972541234567', '+447911123456', '+4915112345678', '+14155552671'];
  for (const d of dests) {
    await twilio.send(SHOP, { phone: d, message: 'hi', sender: 'WILLOW', optOutUrl: 'https://x.test/u?p=1' });
  }
  ok('Israel gets the shop name as sender', /From=WILLOW/.test(wire[0]), wire[0].slice(0, 60));
  ok('the UK gets the shop name too', /From=WILLOW/.test(wire[1]), wire[1].slice(0, 60));
  ok('Germany too', /From=WILLOW/.test(wire[2]), wire[2].slice(0, 60));
  ok('the US, where a name is illegal, goes through the sender pool',
     /MessagingServiceSid=MG_test/.test(wire[3]) && !/From=WILLOW/.test(wire[3]), wire[3].slice(0, 80));
  ok('a Messaging Service makes US numbers reachable', twilio.canReach('+14155552671'));

  ok('a geo-permission refusal is explained as a setting, not a bug',
     twilio.TWILIO_CODES[21408] && /Geo Permissions/.test(twilio.TWILIO_CODES[21408].fix));
  ok('a trial-account refusal names the real cause',
     twilio.TWILIO_CODES[21608] && /trial/i.test(twilio.TWILIO_CODES[21608].en));

  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  ok('without a pool or a number, the US is honestly unreachable',
     !twilio.canReach('+14155552671'));

  // A US destination with no number of ours to send from.
  delete process.env.TWILIO_FROM_NUMBER;
  r = await twilio.send(SHOP, { phone: '+14155552671', message: 'hi', sender: 'WILLOW', optOutUrl: 'https://x.test/u?p=1' });
  ok('a US destination with no number of ours refuses, naming the reason',
     r.ok === false && r.error === 'no_sender_for_destination', JSON.stringify(r).slice(0, 140));

  global.fetch = realFetch;

  // -------------------------------------------------------------------------
  console.log('\n-- opt-outs survive the change of number format --');
  // -------------------------------------------------------------------------
  const compliance = require('./compliance');
  const forms = ['+972541234567', '00972541234567', '972541234567', '0541234567', '054-123-4567'];
  const keys = forms.map(f => compliance.phoneKey(f));
  ok('the same person is one key however their number was written',
     new Set(keys).size === 1, keys.join(' / '));
  ok('the opt-out query matches on that key, not on string equality',
     /RIGHT\(regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 9\) = \$3/
       .test(fs.readFileSync(path.join(__dirname, 'compliance.js'), 'utf8')));
  ok('the declined-marketing block matches the same way',
     /RIGHT\(regexp_replace\(COALESCE\(phone,''\),'\[\^0-9\]','','g'\), 9\) = \$3/
       .test(fs.readFileSync(path.join(__dirname, 'compliance.js'), 'utf8')));

  // -------------------------------------------------------------------------
  console.log('\n-- nothing asks a provider about a shop it does not serve --');
  // -------------------------------------------------------------------------
  const sources = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && !f.startsWith('test-') && !f.startsWith('sms-'))
    .map(f => ({ name: f, src: fs.readFileSync(path.join(__dirname, f), 'utf8') }));
  const blind = [];
  for (const f of sources) {
    for (const m of f.src.matchAll(/smsSender\.(isConfigured|canReach)\(([^)]*)\)/g)) {
      const args = m[2].trim();
      const shopless = m[1] === 'isConfigured' ? args === '' : !/,/.test(args);
      if (shopless) blind.push(`${f.name}: ${m[0]}`);
    }
  }
  ok('every isConfigured/canReach call names the shop', blind.length === 0, blind.join(', '));

  // -------------------------------------------------------------------------
  // ONE MERCHANT IS NEVER SENT AS ANOTHER
  //
  // At App Store scale the platform holds one Twilio account, and a single
  // shared US number under it would mean every merchant's American customers
  // receiving texts from the same sender. That is the shared-identity problem
  // refused everywhere else here — and carrier reputation attaches to the
  // sender, so one bad actor getting filtered takes every other merchant with
  // them.
  // -------------------------------------------------------------------------
  console.log('\n-- each shop sends under its own Twilio identity --');
  const Module = require('module');
  const origLoad = Module._load;
  const STORES = {
    'willow.myshopify.com': { twilio_subaccount_sid: 'ACwillow', twilio_messaging_service_sid: 'MGwillow', twilio_auth_token: null },
    'own.myshopify.com':    { twilio_subaccount_sid: 'ACtheirs', twilio_messaging_service_sid: 'MGtheirs', twilio_auth_token: 'theirtoken' },
    'plain.myshopify.com':  {}
  };
  Module._load = function (rq) {
    if (String(rq).replace(/^\.\//, '').replace(/\.js$/, '') === 'shopify-client') {
      return { getStore: (d) => STORES[d] || null };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('./sms-provider-twilio')];
  const tw2 = require('./sms-provider-twilio');
  process.env.TWILIO_ACCOUNT_SID = 'ACplatform';
  process.env.TWILIO_AUTH_TOKEN = 'platformtok';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGplatform';

  let acct = tw2.accountFor('willow.myshopify.com');
  ok('a shop with a subaccount sends under its own account',
     acct.sid === 'ACwillow' && acct.own === true, JSON.stringify(acct));
  ok('a subaccount authenticates with the platform token, so no per-shop secret is stored',
     acct.token === 'platformtok');
  ok('it uses its own sender pool, not the platform one', acct.messagingServiceSid === 'MGwillow');

  acct = tw2.accountFor('own.myshopify.com');
  ok('a merchant on their OWN Twilio account uses their own token',
     acct.token === 'theirtoken' && acct.sid === 'ACtheirs');

  acct = tw2.accountFor('plain.myshopify.com');
  ok('an unprovisioned shop falls back to the platform, so nothing breaks first',
     acct.sid === 'ACplatform');
  ok('and is reported as NOT its own, because that changes what we may promise',
     acct.own === false);

  ok('reachability is asked of the shop own account',
     tw2.canReach('+14155552671', { shop: 'willow.myshopify.com' }) === true);

  Module._load = origLoad;

  console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
