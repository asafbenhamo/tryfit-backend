// ============================================================================
// TEST: a message is never signed with another merchant's identity.
//   node test-sender-identity.js
//
// sms-sender already enforces this and always has: without a per-shop sender id
// it REFUSES to send rather than borrow one, because signing a store's text
// with a different brand's name is impersonation and burns that brand's sender
// reputation for messages it never authorised.
//
// Email did the opposite, quietly, for every merchant.
//
//   - mailer.sendEmail accepts a `replyTo` argument. A repo-wide grep found the
//     word in exactly three places, all inside mailer.js: the parameter, a
//     comment, and the line that reads it. NO CALLER HAS EVER PASSED ONE. So
//     every marketing email went out with reply_to = MAIL_REPLY_TO, whose
//     default is the pilot store's own inbox. A customer of a brand-new
//     boutique hit Reply on a win-back email and reached an unrelated business.
//
//   - buildHtmlEmail reads opts.logo_url. No caller passed one either, so a
//     single env logo headed every shop's mail.
//
//   - brand fell back to the literal '770' in four places, two of them behind a
//     `.catch(() => ({}))`. A database hiccup put the pilot brand's name at the
//     top of a different merchant's campaign.
//
// The fix resolves identity inside mailer, from the shop, because threading an
// argument through six call sites works until someone adds a seventh.
// ============================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------------------
// Stub the store directory so mailer resolves against known shops, then drive
// the real mailer and read what it would actually put on the wire.
// ---------------------------------------------------------------------------
const STORES = {
  'willow.myshopify.com':    { shop_domain: 'willow.myshopify.com',    name: 'Willow & Pine', owner_email: 'hello@willow.test', logo_url: 'https://cdn.test/willow.png' },
  'ravenwood.myshopify.com': { shop_domain: 'ravenwood.myshopify.com', name: 'Ravenwood',     owner_email: 'shop@ravenwood.test', logo_url: null },
  'bare.myshopify.com':      { shop_domain: 'bare.myshopify.com',      name: null,            owner_email: null, logo_url: null }
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  const base = String(request).replace(/^\.\//, '').replace(/\.js$/, '');
  if (base === 'shopify-client') {
    return { getStore: (d) => STORES[String(d || '').toLowerCase()] || null };
  }
  return origLoad.apply(this, arguments);
};

process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_REPLY_TO = 'info@sevenseventy.co.il';   // the pilot inbox
process.env.MAIL_LOGO_URL = 'https://cdn.test/pilot-logo.png';
process.env.MAIL_FROM = 'SEVENSEVENTY 770 <noreply@sevenseventy.co.il>';

delete require.cache[require.resolve('./mailer')];
const mailer = require('./mailer');

// Capture the Resend payload instead of sending.
let lastPayload = null;
global.fetch = async (url, opts) => {
  lastPayload = JSON.parse(opts.body);
  return { status: 200, json: async () => ({ id: 'msg_1' }) };
};

const send = async (args) => { lastPayload = null; await mailer.sendEmail(args); return lastPayload; };

(async () => {
  console.log('\n-- reply-to belongs to the shop that sent the message --');
  let p = await send({ to: 'customer@example.com', subject: 's', text: 'b', shop: 'willow.myshopify.com' });
  ok('a Willow customer replying reaches Willow', p.reply_to === 'hello@willow.test', p.reply_to);
  ok('and NOT the pilot inbox', p.reply_to !== 'info@sevenseventy.co.il');

  p = await send({ to: 'customer@example.com', subject: 's', text: 'b', shop: 'ravenwood.myshopify.com' });
  ok('a Ravenwood customer reaches Ravenwood', p.reply_to === 'shop@ravenwood.test', p.reply_to);

  p = await send({ to: 'x@example.com', subject: 's', text: 'b', shop: 'willow.myshopify.com', replyTo: 'explicit@given.test' });
  ok('an explicit replyTo still wins', p.reply_to === 'explicit@given.test', p.reply_to);

  p = await send({ to: 'x@example.com', subject: 's', text: 'b', shop: 'nosuch.myshopify.com' });
  ok('an unknown shop falls back to the platform address rather than a random one',
     p.reply_to === 'info@sevenseventy.co.il', p.reply_to);

  console.log('\n-- the sender NAME is the shop, the address stays ours --');
  p = await send({ to: 'x@example.com', subject: 's', text: 'b', shop: 'willow.myshopify.com', fromName: 'Willow & Pine' });
  ok('the customer sees the shop name', /^Willow & Pine </.test(p.from), p.from);
  ok('on our verified domain', /noreply@sevenseventy\.co\.il>$/.test(p.from), p.from);

  console.log('\n-- the logo and the brand in the email body --');
  let html = mailer.buildHtmlEmail('hello', { shop: 'willow.myshopify.com', to: 'x@example.com' });
  ok('Willow gets Willow\'s logo', html.includes('https://cdn.test/willow.png'));
  ok('and not the platform logo', !html.includes('pilot-logo.png'));

  html = mailer.buildHtmlEmail('hello', { shop: 'ravenwood.myshopify.com', to: 'x@example.com' });
  ok('a shop with no logo shows its own NAME, not another shop\'s logo',
     html.includes('Ravenwood') && !html.includes('willow.png'));

  html = mailer.buildHtmlEmail('hello', { shop: 'bare.myshopify.com', to: 'x@example.com' });
  ok('a shop with no name and no logo falls back to its own domain, never to 770',
     html.includes('bare') && !/>770</.test(html), html.slice(html.indexOf('font-size:30px'), html.indexOf('font-size:30px') + 160));

  console.log('\n-- the pilot brand is not a fallback anywhere --');
  const sources = fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.js') && !f.startsWith('test-'))
    .map(f => ({ name: f, src: read(f) }));
  const pilotFallback = sources.filter(f => /\|\|\s*['"]770['"]/.test(f.src)).map(f => f.name);
  ok('no file falls back to the literal 770 brand', pilotFallback.length === 0, pilotFallback.join(', '));

  console.log('\n-- every customer-facing send carries its shop --');
  // A send without `shop` cannot resolve identity and silently reverts to the
  // platform reply-to — the exact bug. Catch a new call site that forgets.
  const missing = [];
  for (const f of sources) {
    if (f.name === 'mailer.js') continue;
    const re = /mailer\.sendEmail\(\{([\s\S]{0,400}?)\}\)/g;
    let m;
    while ((m = re.exec(f.src))) {
      const args = m[1];
      // Sends to the merchant or the operator are not customer-facing; they are
      // identified by their recipient, not by a shop.
      if (/to:\s*(ownerEmail|owner|process\.env)/.test(args)) continue;
      // Nor is transactional mail. A sign-in code goes to the merchant
      // themselves, and pointing its reply-to at their own inbox helps nobody.
      // Detected from the message built immediately above the send.
      if (/transactional:\s*true/.test(f.src.slice(Math.max(0, m.index - 600), m.index))) continue;
      if (!/\bshop\b/.test(args)) {
        missing.push(`${f.name}:${f.src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  ok('no customer-facing sendEmail omits the shop', missing.length === 0, missing.join(', '));

  console.log('\n-- SMS still refuses rather than borrowing an identity --');
  const sms = read('sms-sender.js');
  ok('no sender id means refuse, not fall back',
     /if \(!shopSender\) \{[\s\S]{0,200}?error: 'no_sender_id'/.test(sms));
  const settings = read('store-settings.js');
  ok('the env sender is reachable only by the pilot shop',
     /sms_sender:.*shop === DEFAULT_SHOP \?.*TEXTME_SENDER/.test(settings));

  console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
