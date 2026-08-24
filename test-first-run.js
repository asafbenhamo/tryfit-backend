// ============================================================================
// TEST: a brand-new store is configured before it is asked to send.
//   node test-first-run.js
//
// What happened, on a real install:
//
//   The merchant installed the app on a new store. The agent drafted a win-back
//   message. The channel picker offered SMS, so they ticked SMS. The send
//   failed with "לא נשלח בשום ערוץ (בדוק שבחרת ערוץ מתאים ושיש פרטי קשר)" —
//   which points at the customer's contact details, the one thing that was
//   fine. The real reason was that nobody had ever asked that store for an SMS
//   sender id.
//
// Three separate defects lined up to produce it:
//
//   1. The SMS checkbox was enabled from GET /api/sms/status, which returned
//      smsSender.isConfigured() — whether OUR TextMe account exists. In
//      production it always does, so every store was offered SMS, including one
//      installed five minutes earlier that could not send a single message.
//      A channel must be offered on the strength of the SHOP's configuration.
//
//   2. The send endpoint knew exactly why it refused and threw it away.
//
//   3. Nothing after install ever collected the settings that make sending
//      possible, so the first action a merchant took was guaranteed to fail.
//
// Runs against the real server over HTTP, because what is being tested is the
// agreement between endpoints, not any one function.
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const PORT = Number(process.env.TEST_PORT || (39300 + (process.pid % 90)));
const BASE = 'http://127.0.0.1:' + PORT;
const MASTER_PW = 'masterpwmaster';
const SHOP = 'newstore.myshopify.com';

// An in-memory store_settings so the setup endpoints exercise real persistence
// logic rather than a stub that always agrees with them.
const SERVER = path.join(__dirname, 'server-dual.js');
const boot = [
  "const Module = require('module');",
  "const orig = Module._load;",
  "let SETTINGS = null;",     // no row: exactly a brand-new store
  "let OWNER = null;",
  "Module._load = function (r) {",
  "  const b = r.replace(/^[.][/]/, '').replace(/[.]js$/, '');",
  "  if (b === 'database') return {",
  "    testConnection: async () => false, pool: null, initializeSchema: async () => {},",
  "    query: async (sql, p) => {",
  "      p = p || [];",
  "      if (/INSERT INTO store_settings/.test(sql)) {",
  "        if (/setup_completed_at = NOW\\(\\)|setup_completed_at, updated_at/.test(sql)) {",
  "          SETTINGS = Object.assign({ shop_domain: p[0] }, SETTINGS || {}, { setup_completed_at: new Date().toISOString() });",
  "        } else {",
  "          SETTINGS = Object.assign({}, SETTINGS || {}, {",
  "            shop_domain: p[0], brand: p[1], language: p[2], currency: p[3],",
  "            sms_sender: p[4], daily_cap: p[5], autopilot: p[6], followup_default: p[7],",
  "            timezone: p[8], whatsapp_enabled: p[9]",
  "          });",
  "        }",
  "        return { rows: [], rowCount: 1 };",
  "      }",
  "      if (/SELECT \\* FROM store_settings/.test(sql)) return { rows: SETTINGS ? [SETTINGS] : [] };",
  // A customer base spread across several countries — the case a merchant
  // actually has, and the one the sender-id question is really about.
  "      if (/FROM store_customers/.test(sql) && /GROUP BY/.test(sql)) return { rows: [",
  "        { country: 'Israel', n: 412 }, { country: 'United States', n: 48 },",
  "        { country: 'United Kingdom', n: 30 }, { country: 'Canada', n: 6 },",
  "        { country: '?', n: 4 } ] };",
  "      return { rows: [], rowCount: 0 };",
  "    }",
  "  };",
  "  if (b === 'shopify-client') {",
  "    const real = orig.apply(this, arguments);",
  "    const store = { shop_domain: " + JSON.stringify(SHOP) + ", name: 'New Store', owner_email: null, logo_url: null };",
  "    return Object.assign({}, real, {",
  "      listStores: () => [store],",
  "      getStore: (d) => (d === store.shop_domain ? Object.assign({}, store, { owner_email: OWNER }) : null),",
  "      hasTokenForShop: () => true, getTokenForShop: () => 'tok',",
  "      getFreshToken: async () => 'tok', hasAcceptedTerms: () => true,",
  "      setOwnerEmail: async (d, e) => { OWNER = e; return { ok: true }; }",
  "    });",
  "  }",
  "  return orig.apply(this, arguments);",
  "};",
  'require(' + JSON.stringify(SERVER) + ');'
].join('\n');

const child = spawn(process.execPath, ['-e', boot], {
  env: Object.assign({}, process.env, {
    DATABASE_URL: 'postgres://stub',
    MASTER_PASSWORD: MASTER_PW,
    // The platform SMS account IS configured — that is the whole point. It was
    // enough to light up the checkbox for a shop that could not send.
    // The platform SMS accounts ARE configured — that is the whole point. A
    // working provider account was enough to light up the checkbox for a shop
    // that could not send. Non-pilot shops route to Twilio.
    TEXTME_USERNAME: 'u', TEXTME_API_KEY: 'k', TEXTME_SENDER: 'PILOT',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok',
    RESEND_API_KEY: 'r',
    ADVISOR_SHOPIFY_SECRET: 's', SHOPIFY_API_SECRET: 's', ANTHROPIC_API_KEY: 'k',
    PUBLIC_BASE_URL: 'https://x.test', PORT: String(PORT)
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});

const childLog = [];
const drain = (s) => s.on('data', d => {
  String(d).split('\n').forEach(l => { if (l.trim()) childLog.push(l); });
  while (childLog.length > 40) childLog.shift();
});
drain(child.stdout); drain(child.stderr);

const done = (code) => {
  process.exitCode = code;
  try { child.kill(); } catch (e) {}
  try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch (e) {}
  try {
    const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (d && typeof d.close === 'function') d.close().catch(() => {});
  } catch (e) {}
  setTimeout(() => process.exit(code), 5000).unref();
};

const q = (p) => p + (p.includes('?') ? '&' : '?') + 'password=' + encodeURIComponent(MASTER_PW) + '&shop=' + encodeURIComponent(SHOP);
const get = async (p) => {
  const r = await fetch(BASE + q(p));
  let body; try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body };
};
const post = async (p, obj) => {
  const r = await fetch(BASE + q(p), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ password: MASTER_PW, shop: SHOP }, obj))
  });
  let body; try { body = await r.json(); } catch (e) { body = {}; }
  return { status: r.status, body };
};

async function waitForServer(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health/security'); await r.text().catch(() => {}); return true; }
    catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

(async () => {
  if (!(await waitForServer())) {
    console.error('server never came up. Last lines:'); console.error(childLog.slice(-15).join('\n'));
    return done(2);
  }

  console.log('\n-- a brand-new store, before anyone configures anything --');
  let r = await get('/api/sms/status');
  ok('SMS is reported UNAVAILABLE even though our provider account works',
     r.body.available === false, JSON.stringify(r.body));
  ok('and it says why', r.body.why === 'no approved sender id for this shop', r.body.why);
  ok('and names the setting that would fix it', r.body.setup_needed === 'sms_sender', r.body.setup_needed);
  ok('the platform account is separately reported as fine, so the merchant is not blamed',
     r.body.provider_configured === true);

  r = await get('/api/setup');
  ok('setup is not complete', r.body.complete === false, JSON.stringify(r.body).slice(0, 120));
  const fields = (r.body.missing || []).map(m => m.field);
  ok('it asks for the SMS sender id', fields.includes('sms_sender'), fields.join(', '));
  ok('it asks for a contact email', fields.includes('owner_email'), fields.join(', '));
  ok('every missing item explains what it costs to leave unset',
     (r.body.missing || []).every(m => m.why && m.why_en));
  ok('the store name is prefilled from Shopify', r.body.values.brand === 'New Store', r.body.values.brand);
  ok('a sender id is suggested, already legal for the provider',
     /^[A-Za-z0-9]{1,11}$/.test(r.body.values.suggested_sms_sender || ''), r.body.values.suggested_sms_sender);

  console.log('\n-- setup refuses values that would fail later --');
  r = await post('/api/setup', { sms_sender: 'This Is Far Too Long' });
  ok('an over-long sender id is rejected at the form, not truncated at send time',
     r.status === 400 && r.body.field === 'sms_sender', JSON.stringify(r.body).slice(0, 140));
  r = await post('/api/setup', { sms_sender: 'שלום' });
  ok('a non-latin sender id is rejected', r.status === 400, JSON.stringify(r.body).slice(0, 120));
  r = await post('/api/setup', { owner_email: 'not-an-email' });
  ok('an invalid contact email is rejected', r.status === 400 && r.body.field === 'owner_email');
  // Email is the channel that still works when SMS is skipped. A store with no
  // address means every customer who replies to a marketing message reaches
  // nobody, so setup must not be completable without one.
  r = await post('/api/setup', { brand: 'New Store', sms_sender: 'NEWSTORE' });
  ok('setup cannot be completed with no email at all',
     r.status === 400 && r.body.field === 'owner_email', JSON.stringify(r.body).slice(0, 140));

  r = await get('/api/setup');
  ok('and none of those rejections marked setup complete', r.body.complete === false);

  console.log('\n-- the merchant completes setup --');
  r = await post('/api/setup', { brand: 'New Store', sms_sender: 'NEWSTORE', owner_email: 'hi@newstore.test' });
  ok('it saves', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 140));
  ok('and SMS becomes available in the same response',
     r.body.channels && r.body.channels.available && r.body.channels.available.sms === true,
     JSON.stringify(r.body.channels || {}).slice(0, 160));

  r = await get('/api/sms/status');
  ok('the channel picker now sees SMS as available', r.body.available === true, JSON.stringify(r.body));
  r = await get('/api/setup');
  ok('setup no longer blocks', r.body.complete === true);
  ok('nothing is still missing', (r.body.missing || []).length === 0, JSON.stringify(r.body.missing));

  console.log('\n-- skipping SMS is a real choice, not a trap --');
  r = await post('/api/setup', { sms_sender: '', owner_email: 'hi@newstore.test' });
  ok('clearing the sender id is allowed', r.status === 200 && r.body.ok === true);
  ok('SMS goes back to unavailable rather than failing at send time',
     r.body.channels.available.sms === false, JSON.stringify(r.body.channels.available));
  r = await get('/api/setup');
  ok('and setup stays complete — they chose email', r.body.complete === true);
  ok('the email survived, so replies still reach the store',
     r.body.values.owner_email === 'hi@newstore.test', r.body.values.owner_email);

  // -------------------------------------------------------------------------
  // "Will my customers know it is from me?"
  //
  // The setup screen used to answer "needs approval from the SMS provider",
  // which is true and useless to a merchant with 412 Israeli customers and 48
  // American ones. This answers it against their actual list.
  // -------------------------------------------------------------------------
  console.log('\n-- where the merchant\'s own name will actually show --');
  r = await get('/api/sms/coverage');
  ok('coverage is reported', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 120));
  ok('it counts every customer with a phone', r.body.total_with_phone === 500, String(r.body.total_with_phone));
  ok('Israel and the UK see the shop name', r.body.name_shown.customers === 442,
     JSON.stringify(r.body.name_shown).slice(0, 160));
  ok('the US and Canada cannot, and are counted separately',
     r.body.number_required.customers === 54, JSON.stringify(r.body.number_required).slice(0, 160));
  ok('and it says whether we hold a number for them at all',
     r.body.number_required.we_have_one === false);
  ok('a customer with no country recorded is reported as unknown, not guessed',
     r.body.unknown.customers === 4, JSON.stringify(r.body.unknown));
  ok('the countries are named, not just counted',
     r.body.number_required.countries.some(c => c.code === 'US') &&
     r.body.name_shown.countries.some(c => c.code === 'IL'));

  console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  done(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); done(2); });
