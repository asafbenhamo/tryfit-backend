// ============================================================================
// TEST: the storefront popup.  node test-popup.js
//
// This is the one endpoint in the product that ANYONE on the internet may write
// to. Everything else needs a session, a password or a signed Shopify token;
// this takes an email address from a stranger's browser on someone else's
// domain. So the tests are mostly about what happens when the stranger is not
// a customer: junk addresses, bots, floods, and attempts to write into a shop
// that did not ask for it.
//
// The other half is the consent record. An address on its own is not evidence
// that anyone agreed to anything — if a complaint ever arrives, what matters is
// who agreed, when, from where, and to exactly what wording.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

let SUBS = [], SETTINGS = {}, CUSTOMERS = [];
const dbStub = {
  query: async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER/.test(s)) return { rows: [] };

    if (/SELECT \* FROM popup_settings/.test(s)) {
      const r = SETTINGS[p[0]];
      return { rows: r ? [{ shop_domain: p[0], enabled: r.enabled, config: r }] : [] };
    }
    if (/INSERT INTO popup_settings/.test(s)) {
      SETTINGS[p[0]] = JSON.parse(p[2]); SETTINGS[p[0]].enabled = p[1];
      return { rows: [] };
    }
    if (/INSERT INTO popup_subscribers/.test(s)) {
      const [shop, email, gender, status, ctext, cip, cua, surl, token, confirmed] = p;
      const found = SUBS.find(x => x.shop_domain === shop && x.email.toLowerCase() === email.toLowerCase());
      if (found) {
        // ON CONFLICT DO UPDATE ... WHERE status <> 'unsubscribed'
        if (found.status === 'unsubscribed') return { rows: [] };
        if (gender && !found.gender) found.gender = gender;
        return { rows: [{ id: found.id, status: found.status }] };
      }
      const row = { id: SUBS.length + 1, shop_domain: shop, email, gender, status,
                    consent_text: ctext, consent_ip: cip, consent_ua: cua, source_url: surl,
                    confirm_token: token, confirmed_at: confirmed, created_at: new Date() };
      SUBS.push(row);
      return { rows: [{ id: row.id, status: row.status }] };
    }
    if (/UPDATE popup_subscribers SET status='subscribed'/.test(s)) {
      const r = SUBS.find(x => x.shop_domain === p[0] && x.confirm_token === p[1] && x.status === 'pending');
      if (!r) return { rows: [] };
      r.status = 'subscribed'; r.confirmed_at = new Date(); r.confirm_token = null;
      return { rows: [{ email: r.email, gender: r.gender }] };
    }
    if (/INSERT INTO store_customers/.test(s)) {
      CUSTOMERS.push({ shop: p[0], email: p[1] });
      return { rows: [] };
    }
    if (/FROM popup_subscribers WHERE shop_domain/.test(s)) {
      const mine = SUBS.filter(x => x.shop_domain === p[0]);
      return { rows: [{ subscribed: mine.filter(x => x.status === 'subscribed').length,
                        pending: mine.filter(x => x.status === 'pending').length,
                        week: mine.length, month: mine.length }] };
    }
    return { rows: [], rowCount: 0 };
  }
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r.replace(/^\.\//, '').replace(/\.js$/, '') === 'database') return dbStub;
  return origLoad.apply(this, arguments);
};

const popup = require('./popup-engine.js');
const SHOP = 'willow.myshopify.com';
const OTHER = 'other.myshopify.com';

const reset = () => { SUBS = []; SETTINGS = {}; CUSTOMERS = []; };

(async () => {
  console.log('\n-- what counts as an email address --');
  const good = ['dana@example.com', 'a.b+tag@sub.example.co.uk', 'x@y.io', 'UPPER@Example.COM'];
  for (const g of good) ok('accepts ' + g, popup.normalizeEmail(g) !== null, String(popup.normalizeEmail(g)));
  ok('and lowercases it', popup.normalizeEmail('UPPER@Example.COM') === 'upper@example.com');
  const bad = ['', ' ', 'nope', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a@b .com',
               'a@@b.com', 'a<b>@c.com', 'a@b,c.com', 'x'.repeat(300) + '@y.com', null, undefined, 12345, {}];
  for (const b of bad) ok('rejects ' + JSON.stringify(b), popup.normalizeEmail(b) === null, String(popup.normalizeEmail(b)));

  console.log('\n-- a real signup --');
  reset();
  await popup.saveConfig(SHOP, { enabled: true, discount_code: 'WELCOME10' });
  let r = await popup.subscribe(SHOP, {
    email: 'Dana@Example.com', gender: 'woman',
    consentText: 'I agree to receive marketing emails.',
    ip: '203.0.113.9', userAgent: 'Mozilla/5.0', sourceUrl: 'https://willow.com/products/dress'
  });
  ok('it succeeds', r.ok === true && r.status === 'subscribed', JSON.stringify(r));
  ok('the discount code comes back', r.discount_code === 'WELCOME10');
  const row = SUBS[0];
  ok('the address is stored lowercased', row.email === 'dana@example.com', row.email);

  console.log('\n-- the consent record, which is the part that matters --');
  ok('the exact wording shown is stored', row.consent_text === 'I agree to receive marketing emails.');
  ok('the IP is stored', row.consent_ip === '203.0.113.9');
  ok('the user agent is stored', row.consent_ua === 'Mozilla/5.0');
  ok('the page they were on is stored', row.source_url === 'https://willow.com/products/dress');
  ok('and when', !!row.created_at);
  ok('gender is kept when asked for', row.gender === 'woman');

  console.log('\n-- a subscriber becomes someone the agent can actually message --');
  ok('they are added to the customer list', CUSTOMERS.length === 1 && CUSTOMERS[0].email === 'dana@example.com',
     JSON.stringify(CUSTOMERS));

  console.log('\n-- signing up twice does not duplicate or re-mail --');
  const before = SUBS.length;
  r = await popup.subscribe(SHOP, { email: 'dana@example.com', ip: '203.0.113.9' });
  ok('the second attempt still reports success', r.ok === true);
  ok('but no second row is created', SUBS.length === before, String(SUBS.length));

  console.log('\n-- someone who unsubscribed is NOT resurrected --');
  SUBS[0].status = 'unsubscribed';
  r = await popup.subscribe(SHOP, { email: 'dana@example.com', ip: '203.0.113.9' });
  ok('the visitor is told it worked', r.ok === true);
  ok('but they stay unsubscribed', SUBS[0].status === 'unsubscribed', SUBS[0].status);
  ok('and it is flagged as suppressed internally', r.suppressed === true, JSON.stringify(r));

  console.log('\n-- bots --');
  reset();
  await popup.saveConfig(SHOP, { enabled: true });
  r = await popup.subscribe(SHOP, { email: 'bot@spam.com', honeypot: 'Acme Inc', ip: '198.51.100.1' });
  ok('a filled honeypot is treated as success', r.ok === true, JSON.stringify(r));
  ok('but nothing is stored', SUBS.length === 0, String(SUBS.length));
  ok('and it is marked a decoy internally', r.decoy === true);

  console.log('\n-- one address cannot flood a list --');
  reset();
  await popup.saveConfig(SHOP, { enabled: true });
  let accepted = 0, limited = 0;
  for (let i = 0; i < popup.MAX_PER_IP + 4; i++) {
    const res = await popup.subscribe(SHOP, { email: 'flood' + i + '@x.com', ip: '198.51.100.7' });
    if (res.ok) accepted++; else if (res.error === 'rate_limited') limited++;
  }
  ok('the per-IP limit bites', accepted === popup.MAX_PER_IP, String(accepted));
  ok('and says so', limited > 0, String(limited));
  const fresh = await popup.subscribe(SHOP, { email: 'someone@else.com', ip: '198.51.100.99' });
  ok('a different visitor is unaffected', fresh.ok === true, JSON.stringify(fresh));

  console.log('\n-- one shop cannot be written into another\'s list --');
  reset();
  await popup.saveConfig(SHOP, { enabled: true });
  await popup.saveConfig(OTHER, { enabled: true });
  await popup.subscribe(SHOP, { email: 'a@a.com', ip: '1.1.1.1' });
  await popup.subscribe(OTHER, { email: 'b@b.com', ip: '2.2.2.2' });
  const mine = SUBS.filter(s => s.shop_domain === SHOP);
  ok('each signup lands under its own shop', mine.length === 1 && mine[0].email === 'a@a.com', JSON.stringify(mine));
  const theirs = SUBS.filter(s => s.shop_domain === OTHER);
  ok('and the other shop has only its own', theirs.length === 1 && theirs[0].email === 'b@b.com');
  const st = await popup.stats(SHOP);
  ok('stats are per shop', st.subscribed === 1, JSON.stringify(st));

  console.log('\n-- double opt-in --');
  reset();
  await popup.saveConfig(SHOP, { enabled: true, double_opt_in: true, discount_code: 'HELLO' });
  r = await popup.subscribe(SHOP, { email: 'pending@x.com', ip: '3.3.3.3' });
  ok('the signup is pending, not subscribed', r.status === 'pending', JSON.stringify(r));
  ok('a confirm token is issued', !!r.confirm_token);
  ok('the code is NOT revealed before confirming', !r.discount_code, String(r.discount_code));
  ok('and they are not yet in the customer list', CUSTOMERS.length === 0, String(CUSTOMERS.length));

  let c = await popup.confirm(SHOP, r.confirm_token);
  ok('confirming works', c.ok === true, JSON.stringify(c));
  ok('now they are subscribed', SUBS[0].status === 'subscribed');
  ok('now the code is revealed', c.discount_code === 'HELLO');
  ok('and now they are a customer the agent can message', CUSTOMERS.length === 1);
  c = await popup.confirm(SHOP, r.confirm_token);
  ok('the confirm link is single use', c.ok === false, JSON.stringify(c));
  ok('a made-up token is refused', (await popup.confirm(SHOP, 'nope')).ok === false);
  ok('an empty token is refused', (await popup.confirm(SHOP, '')).ok === false);

  console.log('\n-- config --');
  reset();
  const cfg0 = await popup.getConfig('brand-new.myshopify.com');
  ok('a shop that never configured it has the popup OFF', cfg0.enabled === false);
  const cfg1 = await popup.saveConfig(SHOP, { enabled: true, headline: 'Join us', delay_seconds: 3 });
  ok('settings save', cfg1.enabled === true && cfg1.headline === 'Join us' && cfg1.delay_seconds === 3, JSON.stringify(cfg1));
  const cfg2 = await popup.saveConfig(SHOP, { delay_seconds: 99999 });
  ok('an absurd delay is clamped', cfg2.delay_seconds <= 365, String(cfg2.delay_seconds));
  const cfg3 = await popup.saveConfig(SHOP, { enabled: 'false' });
  ok('a string "false" turns it off', cfg3.enabled === false);
  const cfg4 = await popup.saveConfig(SHOP, { evil: 'DROP TABLE', shop_domain: OTHER });
  ok('unknown fields are ignored', cfg4.evil === undefined, JSON.stringify(cfg4.evil));
  ok('and the shop cannot be reassigned through config', cfg4.shop === SHOP, cfg4.shop);
  const cfg5 = await popup.saveConfig(SHOP, { headline: 'x'.repeat(900) });
  ok('a huge headline is truncated', cfg5.headline.length <= 400, String(cfg5.headline.length));

  console.log('\n-- who the popup is shown to --');
  reset();
  const fresh2 = await popup.getConfig('brand-new-2.myshopify.com');
  ok('by default it is shown on EVERY visit', fresh2.frequency_days === 0, String(fresh2.frequency_days));
  const f1 = await popup.saveConfig(SHOP, { frequency_days: 7 });
  ok('the merchant can space it out', f1.frequency_days === 7, String(f1.frequency_days));
  const f2 = await popup.saveConfig(SHOP, { frequency_days: 0 });
  ok('and put it back to every visit', f2.frequency_days === 0, String(f2.frequency_days));

  console.log('\n-- the links at the foot of the popup --');
  const dflt = await popup.getConfig('links-default.myshopify.com');
  ok('privacy defaults to the store\'s own Shopify policy page',
     dflt.privacy_url === '/policies/privacy-policy', String(dflt.privacy_url));
  // Relative matters: the script runs on the MERCHANT'S domain, so a relative
  // path resolves to their policy. An absolute one would send a shopper to us.
  ok('the default is RELATIVE, so it resolves on their domain and not ours',
     dflt.privacy_url.charAt(0) === '/', dflt.privacy_url);
  ok('accessibility has no default, because there is no standard path',
     dflt.accessibility_url === null, String(dflt.accessibility_url));
  const withLinks = await popup.saveConfig(SHOP, {
    privacy_url: '/policies/privacy-policy', accessibility_url: '/pages/accessibility'
  });
  ok('both can be set', withLinks.privacy_url === '/policies/privacy-policy'
     && withLinks.accessibility_url === '/pages/accessibility', JSON.stringify(withLinks.accessibility_url));
  const cleared = await popup.saveConfig(SHOP, { accessibility_url: '' });
  ok('and cleared, to show no link at all', cleared.accessibility_url === null, String(cleared.accessibility_url));

  console.log('\n-- a signup with no shop goes nowhere --');
  ok('empty shop is refused', (await popup.subscribe('', { email: 'a@b.com' })).ok === false);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
