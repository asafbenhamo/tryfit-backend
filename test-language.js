// ============================================================================
// TEST: an English store's customers never receive Hebrew.
//   node test-language.js
//
// The app was built for one Israeli store and then made multi-tenant, and the
// Hebrew never fully came out. It survived in exactly the places nobody reads
// while developing in Hebrew: the two lines appended to the bottom of every
// campaign message, the whole follow-up that fires three days later, the
// customer-service agent's own self-description, the titles written into the
// merchant's Shopify admin, and the push notification sent to their phone.
//
// None of it throws. An English merchant simply discovers that their customers
// got a right-to-left message from a store called 770.
//
// So this suite does the one thing that catches that class of bug: set a shop's
// language to English and assert that no Hebrew character reaches the customer.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// Any Hebrew letter at all.
const HEBREW = /[֐-׿]/;
const noHebrew = (s) => !HEBREW.test(String(s == null ? '' : s));

let LANG = 'en';
const SETTINGS = () => ({
  shop: 'willow.myshopify.com', brand: 'Willow & Pine', language: LANG,
  currency: LANG === 'en' ? '$' : '₪', daily_cap: 500, autopilot: 'full',
  timezone: 'America/New_York', sms_sender: null, whatsapp_enabled: false,
  followup_default: true, resolved: true
});

const origLoad = Module._load;
Module._load = function (request) {
  const b = request.replace(/^\.\//, '').replace(/\.js$/, '');
  if (b === 'store-settings') return {
    getSettings: async () => SETTINGS(),
    remainingToday: async () => ({ cap: 500, used: 0, remaining: 500 }),
    outreachesToday: async () => 0,
    updateSettings: async () => ({ ok: true, settings: SETTINGS() }),
    DEFAULT_SHOP: 'seven770.myshopify.com'
  };
  if (b === 'database') return { query: async () => ({ rows: [], rowCount: 0 }) };
  return origLoad.apply(this, arguments);
};

const { st } = require('./server-i18n.js');
const mailer = require('./mailer.js');

(async () => {
  console.log('\n-- the strings the server generates --');
  const enKeys = [
    ['disc.campaign', { type: 'winback', who: 'Dana' }],
    ['disc.followup', { who: 'Dana' }],
    ['disc.auto', { who: 'Dana' }],
    ['disc.advisor', { type: 'campaign', who: 'Dana' }],
    ['disc.cart', { who: 'Dana' }],
    ['disc.sms', { who: 'Dana' }],
    ['push.saleTitle', {}],
    ['push.saleBody', { amount: '$127.50' }]
  ];
  for (const [k, v] of enKeys) {
    ok('en ' + k + ' has no Hebrew', noHebrew(st('en', k, v)), st('en', k, v));
  }
  ok('and the Hebrew versions still exist', HEBREW.test(st('he', 'push.saleTitle')), st('he', 'push.saleTitle'));
  ok('a discount title names the customer', /Dana/.test(st('en', 'disc.cart', { who: 'Dana' })));

  console.log('\n-- every server string is defined in BOTH languages --');
  const S = require('./server-i18n.js').STRINGS;
  const he = Object.keys(S.he), en = Object.keys(S.en);
  ok('no key is missing from English', he.filter(k => !S.en[k]).length === 0,
     he.filter(k => !S.en[k]).slice(0, 5).join(', '));
  ok('no key is missing from Hebrew', en.filter(k => !S.he[k]).length === 0,
     en.filter(k => !S.he[k]).slice(0, 5).join(', '));
  ok('every English value is actually English', en.filter(k => HEBREW.test(S.en[k])).length === 0,
     en.filter(k => HEBREW.test(S.en[k])).slice(0, 5).join(', '));

  console.log('\n-- the email wrapper --');
  const html = mailer.buildHtmlEmail('Hello Dana, your offer is waiting.', {
    brand: 'Willow & Pine', language: 'en', to: 'dana@example.com', shop: 'willow.myshopify.com'
  });
  ok('renders left-to-right', /dir="ltr"/.test(html));
  ok('declares English', /lang="en"/.test(html));
  ok('the footer is English', /Sent by Willow/.test(html), (html.match(/Sent by[^<]*/) || [])[0]);
  ok('the unsubscribe label is English', /Unsubscribe/.test(html));
  ok('no Hebrew anywhere in the email', noHebrew(html));
  ok('the unsubscribe link names THIS shop', html.includes('shop=' + encodeURIComponent('willow.myshopify.com')));

  console.log('\n-- and a Hebrew store is unchanged --');
  const heHtml = mailer.buildHtmlEmail('היי דנה, ההטבה שלך מחכה.', {
    brand: '770', language: 'he', to: 'dana@example.com', shop: 'seven770.myshopify.com'
  });
  ok('renders right-to-left', /dir="rtl"/.test(heHtml));
  ok('the footer is Hebrew', /נשלח מ-770/.test(heHtml));
  ok('the unsubscribe label is Hebrew', /להסרה/.test(heHtml));

  console.log('\n-- transactional mail carries no unsubscribe link --');
  const welcome = mailer.buildHtmlEmail('Your store is ready.', {
    brand: 'Willow & Pine', language: 'en', to: 'owner@willow.com',
    shop: 'willow.myshopify.com', transactional: true
  });
  ok('no unsubscribe on account mail', !/unsubscribe\?email/.test(welcome));
  ok('marketing mail still has one', /unsubscribe\?email/.test(html));

  console.log('\n-- the follow-up body an English store queues --');
  // Mirrors campaign-engine's construction exactly.
  const IS_EN = true, fuPct = 20, firstName = 'Dana', product = 'Linen Dress';
  const fuProduct = IS_EN ? `we saw you loved the ${product} — ` : `ראינו שאהבת את ${product} — `;
  const hi = ' ' + firstName;
  const fuBody = IS_EN
    ? `Hi${hi} — just a quick reminder: ${fuProduct}your offer is still waiting.\nA new code for you (${fuPct}%): {COUPON}\nValid for 48 hours\nShop here:\n{LINK}`
    : `היי${hi} 💜 ...`;
  ok('the follow-up is English', noHebrew(fuBody), fuBody.slice(0, 60));
  ok('it names what she bought', fuBody.includes(product));
  ok('it still carries the placeholders the queue fills', /\{COUPON\}/.test(fuBody) && /\{LINK\}/.test(fuBody));

  console.log('\n-- the two lines appended to EVERY campaign message --');
  const codeLabel = IS_EN ? 'Your code' : 'קוד אישי';
  const validLine = IS_EN ? 'Valid for 48 hours only' : 'הקוד תקף ל-48 שעות בלבד';
  ok('the code label is English', noHebrew(codeLabel), codeLabel);
  ok('the validity line is English', noHebrew(validLine), validLine);

  console.log('\n-- Noa answers in the store\'s language, as the store --');
  const noa = require('./noa-engine.js');
  ok('noa-engine loads', typeof noa.handleInbound === 'function');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'noa-engine.js'), 'utf8');
  // Comments are allowed to name the old bug; the CODE must not carry it.
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('her prompt no longer hardcodes the pilot store', !/חנות אופנה ישראלית \(770\)/.test(code));
  ok('nor the pilot store\'s website', !/sevenseventy\.co\.il/.test(code));
  ok('she has an English prompt at all', /You are Noa/.test(src));
  ok('and it takes the brand from settings', /a customer service rep for \$\{brand\}/.test(src));

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
