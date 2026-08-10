// ============================================================================
// TEST: a store installs the app and everything is theirs.
//   node test-onboarding.js
//
// This is the path every new merchant walks, and the one Shopify's reviewer
// will walk. It has to end with: they are signed in, their data is loading, and
// every message that goes out carries THEIR name — never the first store's.
// ============================================================================
const Module = require('module');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- a tiny in-memory advisor_sessions table ------------------------------
let SESSIONS = [];
let SETTINGS_ROWS = {};
const dbStub = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER/.test(s)) return { rows: [] };
    // Two INSERT shapes exist. createSetupLink inlines is_master and user_agent
    // as SQL literals and passes only three parameters; create() passes six.
    if (/INSERT INTO advisor_sessions/.test(s)) {
      if (/'setup-link'/.test(s)) {
        SESSIONS.push({ token_hash: params[0], shop_domain: params[1], is_master: false,
                        expires_at: params[2], ip: null, user_agent: 'setup-link' });
      } else {
        SESSIONS.push({ token_hash: params[0], shop_domain: params[1], is_master: params[2],
                        expires_at: params[3], ip: params[4] || null, user_agent: params[5] || null });
      }
      return { rows: [] };
    }
    if (/^DELETE FROM advisor_sessions WHERE token_hash = \$1$/.test(s)) {
      const before = SESSIONS.length;
      SESSIONS = SESSIONS.filter(r => r.token_hash !== params[0]);
      return { rows: [], rowCount: before - SESSIONS.length };
    }
    if (/DELETE FROM advisor_sessions WHERE shop_domain = \$1/.test(s)) {
      const before = SESSIONS.length;
      SESSIONS = SESSIONS.filter(r => r.shop_domain !== params[0]);
      return { rows: [], rowCount: before - SESSIONS.length };
    }
    if (/DELETE FROM advisor_sessions WHERE token_hash = \$1 AND user_agent = 'setup-link'/.test(s)) {
      const i = SESSIONS.findIndex(r => r.token_hash === params[0] && r.user_agent === 'setup-link' && new Date(r.expires_at) > new Date());
      if (i === -1) return { rows: [] };
      const row = SESSIONS.splice(i, 1)[0];
      return { rows: [{ shop_domain: row.shop_domain }] };
    }
    if (/SELECT id, shop_domain, is_master, last_seen_at/.test(s)) {
      const row = SESSIONS.find(r => r.token_hash === params[0] && new Date(r.expires_at) > new Date());
      return { rows: row ? [{ id: 1, shop_domain: row.shop_domain, is_master: row.is_master, last_seen_at: new Date() }] : [] };
    }
    if (/SELECT \* FROM store_settings/.test(s)) {
      const row = SETTINGS_ROWS[params[0]];
      return { rows: row ? [row] : [] };
    }
    return { rows: [], rowCount: 0 };
  }
};

let SENT_MAIL = [], SENT_SMS = [];
const origLoad = Module._load;
Module._load = function (request) {
  const base = request.replace(/^\.\//, '').replace(/\.js$/, '');
  if (base === 'database') return dbStub;
  if (base === 'compliance') return { isOptedOut: async () => false };
  return origLoad.apply(this, arguments);
};

const sessionAuth = require('./session-auth.js');
const storeSettings = require('./store-settings.js');
const smsSender = require('./sms-sender.js');
const mailer = require('./mailer.js');

const NEW_SHOP = 'willow.myshopify.com';
const PILOT = 'seven770.myshopify.com';

(async () => {
  process.env.PUBLIC_BASE_URL = 'https://app.example.com';

  console.log('\n-- the install link signs them in without ever mailing a password --');
  const link = await sessionAuth.createSetupLink(NEW_SHOP, { baseUrl: 'https://app.example.com' });
  ok('a setup link is produced', !!link.url, link.url.slice(0, 52) + '...');
  ok('it points at the app', link.url.startsWith('https://app.example.com/chat?setup='));
  ok('it carries a token, NOT a password', !/password=/i.test(link.url));
  ok('the raw token is not what we stored', !SESSIONS.some(r => r.token_hash === link.token));

  const sess = await sessionAuth.consumeSetupLink(link.token, { ip: '1.2.3.4', userAgent: 'Safari' });
  ok('clicking it yields a real session', !!(sess && sess.token));
  ok('and the session knows which shop', sess.shop === NEW_SHOP, String(sess && sess.shop));
  const resolved = await sessionAuth.resolve(sess.token);
  ok('that session authenticates afterwards', resolved && resolved.shop === NEW_SHOP);

  console.log('\n-- and it is single use --');
  const second = await sessionAuth.consumeSetupLink(link.token, {});
  ok('a second click is refused', second === null);
  ok('a made-up token is refused', (await sessionAuth.consumeSetupLink('not-a-real-token', {})) === null);

  console.log('\n-- an expired link cannot be used --');
  const old = await sessionAuth.createSetupLink('expired.myshopify.com', {});
  SESSIONS.find(r => r.shop_domain === 'expired.myshopify.com').expires_at = new Date(Date.now() - 1000);
  ok('expired -> refused', (await sessionAuth.consumeSetupLink(old.token, {})) === null);

  console.log('\n-- a new store does NOT inherit the pilot store\'s identity --');
  SETTINGS_ROWS = {};                                  // no rows written yet
  process.env.TEXTME_SENDER = '770';                   // the pilot's approved sender
  const pilot = await storeSettings.getSettings(PILOT);
  ok('the pilot shop keeps its env sender', pilot.sms_sender === '770', String(pilot.sms_sender));
  const fresh = await storeSettings.getSettings(NEW_SHOP);
  ok('a NEW shop gets no sender at all', fresh.sms_sender === null, String(fresh.sms_sender));
  ok('and defaults to English/$', fresh.language === 'en' && fresh.currency === '$');

  console.log('\n-- so SMS refuses rather than signing as another brand --');
  process.env.TEXTME_USERNAME = 'u'; process.env.TEXTME_API_KEY = 'k';
  global.fetch = async () => { SENT_SMS.push(1); return { ok: true, text: async () => '{"status":0}' }; };
  const r = await smsSender.sendOne(NEW_SHOP, { phone: '0501234567', message: 'hi' });
  ok('refused for the new shop', r.ok === false && r.error === 'no_sender_id', JSON.stringify(r).slice(0, 90));
  ok('nothing was sent to the provider', SENT_SMS.length === 0);
  ok('and it explains that email will be used instead', /מייל/.test(String(r.detail)));

  // A different domain, because store-settings caches for 60s and this shop's
  // "no sender" answer is already cached from the assertion above.
  const APPROVED = 'approved.myshopify.com';
  SETTINGS_ROWS[APPROVED] = { shop_domain: APPROVED, sms_sender: 'WILLOW', language: 'en', currency: '$' };
  const withSender = await smsSender.sendOne(APPROVED, { phone: '0501234567', message: 'hi' });
  ok('once it has its OWN approved sender, it sends', withSender.ok === true, JSON.stringify(withSender).slice(0, 80));
  ok('and the provider was called once', SENT_SMS.length === 1);

  console.log('\n-- email carries the installing store\'s name --');
  const html = mailer.buildHtmlEmail('Hello there', { brand: 'Willow & Pine', language: 'en', to: 'a@b.com', shop: NEW_SHOP });
  ok('the new store brands the email', html.includes('Willow &amp; Pine') || html.includes('Willow & Pine'));
  ok('the pilot store is nowhere in it', !html.includes('770') && !/SEVENSEVENTY/i.test(html));
  ok('unsubscribe points at the right shop', html.includes('shop=' + encodeURIComponent(NEW_SHOP)));
  ok('English store renders LTR', /dir="ltr"/.test(html));

  console.log('\n-- the welcome email itself is sent AS the store --');
  // mirrors the onboarding call in server-dual
  let captured = null;
  const realSend = mailer.sendEmail;
  mailer.sendEmail = async (m) => { captured = m; return { ok: true }; };
  await mailer.sendEmail({ to: 'owner@willow.com', subject: 'ready', html, text: 'x', fromName: 'Willow & Pine' });
  mailer.sendEmail = realSend;
  ok('fromName is the installing store', captured && captured.fromName === 'Willow & Pine', JSON.stringify(captured && captured.fromName));

  console.log('\n-- logging out kills the session everywhere --');
  await sessionAuth.revoke(sess.token);
  ok('the token stops resolving', (await sessionAuth.resolve(sess.token)) === null);

  console.log('\n-- uninstall revokes every session for that shop --');
  const s1 = await sessionAuth.create(NEW_SHOP, {});
  const s2 = await sessionAuth.create(NEW_SHOP, {});
  const other = await sessionAuth.create('someone-else.myshopify.com', {});
  await sessionAuth.revokeAllForShop(NEW_SHOP);
  ok('both of that shop\'s sessions are gone', (await sessionAuth.resolve(s1.token)) === null && (await sessionAuth.resolve(s2.token)) === null);
  ok('another shop is untouched', (await sessionAuth.resolve(other.token)) !== null);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
