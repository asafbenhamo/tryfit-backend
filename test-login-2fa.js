// ============================================================================
// TEST: two-step login.  node test-login-2fa.js
//
// The password is no longer enough on its own: a code goes to the address on
// file and the session is only minted once that code comes back. Which makes
// this code a credential, and every shortcut around it a way in.
//
// Written as an attacker: brute force, replay, expiry, guessing the challenge
// id, using someone else's challenge, and mailbox flooding.
// ============================================================================
const crypto = require('crypto');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

// ---- an in-memory login_challenges table ----------------------------------
let ROWS = [];
const dbStub = {
  query: async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE|^ALTER/.test(s)) return { rows: [] };

    if (/SELECT COUNT\(\*\)::int AS n FROM login_challenges/.test(s)) {
      const cutoff = new Date(Date.now() - 3600e3);
      return { rows: [{ n: ROWS.filter(r => r.email === p[0] && r.created_at > cutoff).length }] };
    }
    if (/INSERT INTO login_challenges/.test(s)) {
      ROWS.push({ id: p[0], shop_domain: p[1], is_master: p[2], email: p[3], code_hash: p[4],
                  expires_at: p[5], ip: p[6], user_agent: p[7], attempts: 0, created_at: new Date() });
      return { rows: [] };
    }
    if (/UPDATE login_challenges SET expires_at = NOW\(\)/.test(s)) {
      ROWS.forEach(r => { if (r.email === p[0] && r.id !== p[1] && new Date(r.expires_at) > new Date()) r.expires_at = new Date(); });
      return { rows: [] };
    }
    if (/SELECT \* FROM login_challenges WHERE id = \$1/.test(s)) {
      const r = ROWS.find(r => r.id === p[0]);
      return { rows: r ? [r] : [] };
    }
    if (/UPDATE login_challenges SET attempts = attempts \+ 1/.test(s)) {
      const r = ROWS.find(r => r.id === p[0]);
      if (!r) return { rows: [] };
      r.attempts += 1;
      return { rows: [{ attempts: r.attempts }] };
    }
    if (/DELETE FROM login_challenges WHERE id = \$1/.test(s)) {
      const before = ROWS.length;
      ROWS = ROWS.filter(r => r.id !== p[0]);
      return { rows: [], rowCount: before - ROWS.length };
    }
    if (/DELETE FROM login_challenges WHERE expires_at < NOW\(\)/.test(s)) {
      const before = ROWS.length;
      ROWS = ROWS.filter(r => new Date(r.expires_at) > new Date());
      return { rows: [], rowCount: before - ROWS.length };
    }
    return { rows: [], rowCount: 0 };
  }
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r.replace(/^\.\//, '').replace(/\.js$/, '') === 'database') return dbStub;
  return origLoad.apply(this, arguments);
};

const twofa = require('./login-2fa.js');
const SHOP = 'willow.myshopify.com';
const EMAIL = 'owner@willow.com';

(async () => {
  console.log('\n-- the happy path --');
  ROWS = [];
  const ch = await twofa.issue({ shop: SHOP, email: EMAIL, ip: '1.2.3.4' });
  ok('a challenge is issued', ch.ok === true);
  ok('with a code of the stated length', new RegExp('^\\d{' + twofa.CODE_DIGITS + '}$').test(ch.code), ch.code);
  ok('and an unguessable id', ch.id && ch.id.length >= 30, String(ch.id && ch.id.length));
  ok('the id is NOT the code', ch.id !== ch.code);

  const stored = ROWS[0];
  ok('the code is stored HASHED, never in the clear', stored.code_hash !== ch.code
     && stored.code_hash === crypto.createHash('sha256').update(ch.code, 'utf8').digest('hex'));
  ok('the row does not contain the code anywhere', !JSON.stringify(stored).includes(ch.code));

  const v = await twofa.verify(ch.id, ch.code);
  ok('the right code opens it', v.ok === true, JSON.stringify(v));
  ok('and names the shop it was issued for', v.shop === SHOP, v.shop);
  ok('not master', v.is_master === false);

  console.log('\n-- single use: a code cannot be replayed --');
  ok('the challenge is gone after success', ROWS.length === 0);
  const again = await twofa.verify(ch.id, ch.code);
  ok('the same code a second time is refused', again.ok === false, JSON.stringify(again));

  console.log('\n-- brute force --');
  ROWS = [];
  const b = await twofa.issue({ shop: SHOP, email: EMAIL });
  const wrong = (b.code === '000000') ? '111111' : '000000';
  let lastErr = null;
  for (let i = 0; i < twofa.MAX_ATTEMPTS; i++) lastErr = await twofa.verify(b.id, wrong);
  ok('the challenge is burned after MAX_ATTEMPTS', lastErr.error === 'too_many_attempts', JSON.stringify(lastErr));
  ok('and it really is gone', ROWS.length === 0);
  const afterBurn = await twofa.verify(b.id, b.code);
  ok('even the CORRECT code no longer works', afterBurn.ok === false, JSON.stringify(afterBurn));

  console.log('\n-- the attempt counter cannot be dodged --');
  ROWS = [];
  const c = await twofa.issue({ shop: SHOP, email: EMAIL });
  await twofa.verify(c.id, '000001');
  ok('a wrong guess is counted', ROWS[0] && ROWS[0].attempts === 1, String(ROWS[0] && ROWS[0].attempts));
  await twofa.verify(c.id, '000002');
  ok('and so is the next', ROWS[0] && ROWS[0].attempts === 2);
  const left = await twofa.verify(c.id, '000003');
  ok('it reports how many tries remain', left.attempts_left === twofa.MAX_ATTEMPTS - 3, JSON.stringify(left));
  const good = await twofa.verify(c.id, c.code);
  ok('the real code still works within the budget', good.ok === true);

  console.log('\n-- expiry --');
  ROWS = [];
  const d = await twofa.issue({ shop: SHOP, email: EMAIL });
  ROWS[0].expires_at = new Date(Date.now() - 1000);
  const exp = await twofa.verify(d.id, d.code);
  ok('an expired code is refused', exp.ok === false && exp.error === 'expired', JSON.stringify(exp));
  ok('and the row is cleaned up', ROWS.length === 0);

  console.log('\n-- guessing the challenge id --');
  ROWS = [];
  const e = await twofa.issue({ shop: SHOP, email: EMAIL });
  ok('an unknown challenge id is refused', (await twofa.verify('not-a-real-id', e.code)).ok === false);
  ok('an empty challenge is refused', (await twofa.verify('', e.code)).ok === false);
  ok('a null challenge is refused', (await twofa.verify(null, e.code)).ok === false);
  ok('an empty code is refused', (await twofa.verify(e.id, '')).ok === false);
  ok('a null code is refused', (await twofa.verify(e.id, null)).ok === false);
  ok('and none of that consumed an attempt', ROWS[0].attempts === 0, String(ROWS[0].attempts));

  console.log('\n-- one merchant\'s code cannot open another\'s challenge --');
  ROWS = [];
  const alpha = await twofa.issue({ shop: 'alpha.myshopify.com', email: 'a@alpha.com' });
  const beta  = await twofa.issue({ shop: 'beta.myshopify.com',  email: 'b@beta.com' });
  const cross = await twofa.verify(beta.id, alpha.code);
  ok('alpha\'s code does not open beta\'s challenge', cross.ok === false || alpha.code === beta.code,
     'codes collided by chance: ' + (alpha.code === beta.code));
  const own = await twofa.verify(beta.id, beta.code);
  ok('beta\'s own code opens beta\'s challenge', own.ok === true && own.shop === 'beta.myshopify.com', JSON.stringify(own));

  console.log('\n-- issuing a new code invalidates the old one --');
  ROWS = [];
  const first = await twofa.issue({ shop: SHOP, email: EMAIL });
  const second = await twofa.issue({ shop: SHOP, email: EMAIL });
  // Both rows remain — the older one is EXPIRED, not deleted, because the
  // hourly issue limit counts rows and deleting them disabled it.
  const usable = ROWS.filter(r => new Date(r.expires_at) > new Date());
  ok('only the newest challenge is still usable', usable.length === 1 && usable[0].id === second.id,
     usable.length + ' usable of ' + ROWS.length);
  ok('the first code is dead', (await twofa.verify(first.id, first.code)).ok === false);
  ok('the second works', (await twofa.verify(second.id, second.code)).ok === true);

  console.log('\n-- mailbox flooding --');
  ROWS = [];
  let issued = 0, refused = null;
  for (let i = 0; i < twofa.MAX_ISSUES_PER_HOUR + 3; i++) {
    const r = await twofa.issue({ shop: SHOP, email: EMAIL });
    if (r.ok) issued++; else refused = r;
  }
  ok('it stops issuing after the hourly limit', issued === twofa.MAX_ISSUES_PER_HOUR, String(issued));
  ok('and says why', refused && refused.error === 'too_many_requests', JSON.stringify(refused));
  // The limit must not have been bought by throwing away the old rows: the
  // superseded codes still have to be dead.
  ok('every issue is still on record', ROWS.filter(r => r.email === EMAIL).length === twofa.MAX_ISSUES_PER_HOUR,
     String(ROWS.filter(r => r.email === EMAIL).length));
  const live = ROWS.filter(r => r.email === EMAIL && new Date(r.expires_at) > new Date());
  ok('but only the newest is still usable', live.length === 1, String(live.length));

  console.log('\n-- the master challenge --');
  ROWS = [];
  const m = await twofa.issue({ shop: null, isMaster: true, email: 'admin@smartadvisor.app' });
  const mv = await twofa.verify(m.id, m.code);
  ok('opens as master', mv.ok === true && mv.is_master === true, JSON.stringify(mv));
  ok('with no shop attached', mv.shop === null, String(mv.shop));

  console.log('\n-- codes are random, not sequential --');
  ROWS = [];
  const codes = new Set();
  for (let i = 0; i < 40; i++) {
    const r = await twofa.issue({ shop: SHOP, email: 'gen' + i + '@x.com' });
    codes.add(r.code);
  }
  ok('40 issues produce ~40 distinct codes', codes.size >= 38, String(codes.size));
  ok('all are the right shape', [...codes].every(c => new RegExp('^\\d{' + twofa.CODE_DIGITS + '}$').test(c)));

  console.log('\n-- the address is masked when shown back --');
  ok('local part is hidden', twofa.maskEmail('dana@example.com').startsWith('d')
     && !twofa.maskEmail('dana@example.com').includes('dana'), twofa.maskEmail('dana@example.com'));
  ok('the domain is kept so they know which inbox', twofa.maskEmail('dana@example.com').endsWith('@example.com'));
  ok('junk does not throw', twofa.maskEmail('') === '•••' && twofa.maskEmail(null) === '•••');

  console.log('\n-- the email we send --');
  const enMail = twofa.codeEmail('123456', { brand: 'Willow', language: 'en' });
  ok('the code is in the subject, so it is readable from a notification', enMail.subject.includes('123456'));
  ok('and in the body', enMail.text.includes('123456'));
  ok('English store gets English', !/[֐-׿]/.test(enMail.subject + enMail.text));
  const heMail = twofa.codeEmail('123456', { brand: '770', language: 'he' });
  ok('Hebrew store gets Hebrew', /[֐-׿]/.test(heMail.text));
  ok('it warns what an unexpected code means', /did not try to sign in/i.test(enMail.text));

  console.log('\n-- no email, no challenge --');
  ok('issue without an address is refused', (await twofa.issue({ shop: SHOP, email: null })).ok === false);

  console.log('\n' + (fail ? fail + ' FAILING' : 'all ' + pass + ' assertions passed'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test threw:', e); process.exit(2); });
