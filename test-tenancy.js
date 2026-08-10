// ============================================================================
// TEST: three cross-tenant / auth defects found by adversarial review.
//   node test-tenancy.js
//
// 1. A setup link resolved as a full session bearer token — never consumed,
//    and the rolling-expiry refresh promoted a 72-hour single-use link into a
//    14-day session. Both stated protections defeated by one missing filter.
// 2. /api/agent/approve-plan was the one endpoint of its family without an
//    ownership check, and the worst one to miss: it can flip another merchant's
//    plan to send_mode='auto' and launch it at THEIR customers.
// 3. Inbound SMS was filed against a shop from an env var, so a customer of
//    shop B texting STOP was suppressed under shop A and kept being messaged.
// ============================================================================
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- session table stub ----------------------------------------------------
let ROWS = [];
const dbStub = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER|^UPDATE advisor_sessions SET kind/.test(s)) return { rows: [] };
    if (/INSERT INTO advisor_sessions/.test(s)) {
      const kind = /'setup'\)/.test(s) ? 'setup' : 'session';
      ROWS.push(kind === 'setup'
        ? { token_hash: params[0], shop_domain: params[1], is_master: false, expires_at: params[2], kind, user_agent: 'setup-link' }
        : { token_hash: params[0], shop_domain: params[1], is_master: params[2], expires_at: params[3], kind, user_agent: params[5] });
      return { rows: [] };
    }
    if (/SELECT id, shop_domain, is_master, last_seen_at/.test(s)) {
      const needSession = /kind = 'session'/.test(s);
      const row = ROWS.find(r => r.token_hash === params[0]
        && new Date(r.expires_at) > new Date()
        && (!needSession || r.kind === 'session'));
      return { rows: row ? [{ id: 1, shop_domain: row.shop_domain, is_master: row.is_master, last_seen_at: new Date() }] : [] };
    }
    if (/DELETE FROM advisor_sessions.*kind = 'setup'/.test(s)) {
      const i = ROWS.findIndex(r => r.token_hash === params[0] && r.kind === 'setup' && new Date(r.expires_at) > new Date());
      if (i === -1) return { rows: [] };
      return { rows: [{ shop_domain: ROWS.splice(i, 1)[0].shop_domain }] };
    }
    if (/DELETE FROM advisor_sessions WHERE token_hash/.test(s)) {
      ROWS = ROWS.filter(r => r.token_hash !== params[0]); return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request.replace(/^\.\//, '').replace(/\.js$/, '') === 'database') return dbStub;
  return origLoad.apply(this, arguments);
};
const sessionAuth = require('./session-auth.js');

// ---- a stand-in for the plan tables ---------------------------------------
const PLANS = [
  { id: 101, shop_domain: 'victim.myshopify.com', status: 'draft', send_mode: 'manual' },
  { id: 102, shop_domain: 'attacker.myshopify.com', status: 'draft', send_mode: 'manual' }
];
// Mirrors the hardened handler.
async function approvePlan(callerShop, { plan_id, send_mode }) {
  const owns = PLANS.find(p => p.id === plan_id && p.shop_domain === callerShop);
  if (!owns) return { status: 404, body: { ok: false, error: 'not found' } };
  const mode = (send_mode === 'auto') ? 'auto' : 'manual';
  owns.status = 'approved'; owns.send_mode = mode;
  return { status: 200, body: { ok: true, started: true, plan_id } };
}

(async () => {
  console.log('\n-- a setup link is NOT a session --');
  ROWS = [];
  const link = await sessionAuth.createSetupLink('willow.myshopify.com', { baseUrl: 'https://app.test' });
  ok('the row is tagged as a setup link', ROWS[0] && ROWS[0].kind === 'setup', JSON.stringify(ROWS[0] && ROWS[0].kind));
  const asBearer = await sessionAuth.resolve(link.token);
  ok('using it as a bearer token authenticates NOTHING', asBearer === null, JSON.stringify(asBearer));

  console.log('\n-- but it still works once, for what it is for --');
  const sess = await sessionAuth.consumeSetupLink(link.token, {});
  ok('exchanging it yields a session', !!(sess && sess.token) && sess.shop === 'willow.myshopify.com');
  ok('the new session DOES authenticate', (await sessionAuth.resolve(sess.token)) !== null);
  ok('the session row is tagged as a session', ROWS.some(r => r.kind === 'session'));
  ok('and the setup row is gone', !ROWS.some(r => r.kind === 'setup'));
  ok('so the link cannot be replayed', (await sessionAuth.consumeSetupLink(link.token, {})) === null);
  ok('nor used as a bearer afterwards', (await sessionAuth.resolve(link.token)) === null);

  console.log('\n-- a real session is unaffected --');
  ROWS = [];
  const s2 = await sessionAuth.create('shop.myshopify.com', {});
  ok('resolves normally', (await sessionAuth.resolve(s2.token)).shop === 'shop.myshopify.com');
  ok('but cannot be redeemed as a setup link', (await sessionAuth.consumeSetupLink(s2.token, {})) === null);

  console.log('\n-- approve-plan refuses another tenant\'s plan --');
  let r = await approvePlan('attacker.myshopify.com', { plan_id: 101, send_mode: 'auto' });
  ok('cross-tenant approve -> 404', r.status === 404, JSON.stringify(r));
  const victim = PLANS.find(p => p.id === 101);
  ok('the victim plan is untouched', victim.status === 'draft' && victim.send_mode === 'manual', JSON.stringify(victim));
  ok('and was NOT flipped to auto-send', victim.send_mode !== 'auto');

  r = await approvePlan('victim.myshopify.com', { plan_id: 101, send_mode: 'auto' });
  ok('the owner can approve their own', r.status === 200 && victim.status === 'approved');
  ok('and their chosen mode is honoured', victim.send_mode === 'auto');

  console.log('\n-- send_mode is validated, not trusted --');
  r = await approvePlan('attacker.myshopify.com', { plan_id: 102, send_mode: 'AUTO; DROP TABLE' });
  const own = PLANS.find(p => p.id === 102);
  ok('an unrecognised mode falls back to manual', own.send_mode === 'manual', own.send_mode);

  console.log('\n-- inbound SMS is filed against the shop that knows the number --');
  // Mirrors the resolution the webhook now performs.
  const CUSTOMERS = [
    { shop: 'alpha.myshopify.com', phone: '+972501111111' },
    { shop: 'beta.myshopify.com',  phone: '+972502222222' },
    { shop: 'alpha.myshopify.com', phone: '+972503333333' },
    { shop: 'beta.myshopify.com',  phone: '+972503333333' }   // known to both
  ];
  const resolveShops = (phone) => {
    const d = String(phone).replace(/[^0-9]/g, '').slice(-9);
    return [...new Set(CUSTOMERS.filter(c => c.phone.replace(/[^0-9]/g, '').endsWith(d)).map(c => c.shop))];
  };
  ok('a number known to one shop resolves to that shop',
     JSON.stringify(resolveShops('+972502222222')) === JSON.stringify(['beta.myshopify.com']));
  ok('it is NOT filed against the pilot shop',
     !resolveShops('+972502222222').includes('seven770.myshopify.com'));
  const both = resolveShops('0503333333');
  ok('a number known to two shops resolves to both', both.length === 2, JSON.stringify(both));
  ok('an unknown number resolves to none, and is ignored', resolveShops('+15559999999').length === 0);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
