// ============================================================================
// TEST: the app asks for every permission it uses, and asks once.
//   node test-scopes.js
//
// A merchant installed the app, saw it connect, watched it write a campaign,
// chose the channels, pressed send — and got
//
//   price_rule failed (403): {"errors":"[API] This action requires merchant
//   approval for write_price_rules scope."}
//
// The scope list lived in two files that disagreed with each other and with the
// code, and nothing compared them. A missing permission is invisible until the
// exact moment it is needed, which is always the worst moment: after the
// merchant has done the work, inside the one action they came to perform, with
// a raw Shopify error as the explanation.
//
// So: one source of truth, and three checks against it.
//   1. the .toml Shopify installs from matches it exactly
//   2. the OAuth URL the server builds matches it exactly
//   3. every Shopify write the code performs has the scope that permits it
// ============================================================================

const fs = require('fs');
const path = require('path');
const scopes = require('./shopify-scopes');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? '  -> ' + x : '')); } };

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------------------
console.log('\n-- the list itself --');
// ---------------------------------------------------------------------------
const list = scopes.list();
ok('every scope carries a reason it is asked for',
   scopes.SCOPES.every(s => s.why && s.why.length > 10),
   scopes.SCOPES.filter(s => !s.why || s.why.length <= 10).map(s => s.scope).join(', '));
ok('no scope is listed twice', new Set(list).size === list.length);
ok('the string is sorted, so an edit does not read as a scope change',
   scopes.asString() === list.slice().sort().join(','));
ok('write_price_rules is in it — the one the 403 was about',
   list.includes('write_price_rules'));
ok('scopes with no reference anywhere in the code are not requested',
   !list.includes('read_locations') && !list.includes('read_marketing_events'));

// ---------------------------------------------------------------------------
console.log('\n-- the .toml Shopify installs from --');
// ---------------------------------------------------------------------------
const tomlFiles = fs.readdirSync(ROOT).filter(f => /^shopify\.app\..*\.toml$/.test(f));
ok('there is an app config to check', tomlFiles.length > 0, tomlFiles.join(', '));

for (const f of tomlFiles) {
  const toml = read(f);
  const m = toml.match(/^\s*scopes\s*=\s*"([^"]*)"/m);
  if (!m) { ok(`${f} declares access scopes`, false); continue; }
  const declared = m[1].split(',').map(x => x.trim()).filter(Boolean).sort();
  ok(`${f} matches shopify-scopes.js exactly`,
     declared.join(',') === scopes.asString(),
     'toml has [' + declared.join(', ') + ']');
}

// ---------------------------------------------------------------------------
console.log('\n-- the OAuth URL the server builds --');
// ---------------------------------------------------------------------------
const server = read('server-dual.js');
ok('the server takes its scopes from the module, not a second literal',
   /const OAUTH_SCOPES = shopifyScopes\.asString\(\)/.test(server));
ok('there is no hand-written scope string left in the server',
   !/read_customers,write_customers,read_orders/.test(server));
ok('the OAuth URL actually sends them',
   /scope=\$\{encodeURIComponent\(OAUTH_SCOPES\)\}/.test(server));

// ---------------------------------------------------------------------------
console.log('\n-- every write the code performs is permitted --');
//
// Maps a Shopify REST resource we write to the scope that allows it. If the
// code gains a write to a resource that is not in this table, that is a new
// permission nobody declared, and the test should be updated deliberately
// rather than the failure being discovered by a merchant.
// ---------------------------------------------------------------------------
const WRITES = [
  { pattern: /price_rules(?:\/\$\{[^}]+\})?\.json/, scope: 'write_price_rules', what: 'creating and deleting campaign coupons' },
  { pattern: /discount_codes\.json/,                scope: 'write_price_rules', what: 'attaching a code to a price rule' },
  { pattern: /draft_orders(?:\/|\.json)/,           scope: 'write_draft_orders', what: 'building a pre-filled recovery cart' },
  { pattern: /customers(?:\/\$\{[^}]+\})?\.json/,   scope: 'write_customers',   what: 'recording consent and opt-outs' }
];

const codeFiles = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.js') && !f.startsWith('test-'))
  .map(f => ({ name: f, src: read(f) }));

for (const w of WRITES) {
  const used = codeFiles.filter(f => w.pattern.test(f.src)).map(f => f.name);
  if (!used.length) continue;   // not used; nothing to permit
  ok(`${w.what} is permitted by ${w.scope}`,
     list.includes(w.scope),
     'used in ' + used.join(', ') + ' but the scope is not requested');
}

// The seeder cancels and deletes orders, which needs write_orders. That scope is
// deliberately NOT requested: it is a development-only convenience, and asking
// every merchant for permission to modify their orders to support a script they
// will never run is not a trade worth making.
const seeder = codeFiles.find(f => f.name === 'seed-demo-store.js');
if (seeder) {
  ok('write_orders is deliberately absent even though the seeder wants it',
     !list.includes('write_orders'));
  ok('and the seeder says so where it tries',
     /write_orders/.test(seeder.src),
     'seed-demo-store.js should explain why order cleanup can fail');
}

// ---------------------------------------------------------------------------
console.log('\n-- comparing what a shop granted against what we need --');
// ---------------------------------------------------------------------------
ok('a full grant reports nothing missing', scopes.missingFrom(list).length === 0);
ok('an empty grant reports everything missing', scopes.missingFrom([]).length === list.length);
ok('the exact grant this store had reports only write_price_rules',
   JSON.stringify(scopes.missingFrom([
     'read_customers', 'write_customers', 'read_orders', 'read_products', 'read_inventory',
     'read_checkouts', 'read_fulfillments', 'read_locations', 'read_price_rules',
     'read_discounts', 'read_marketing_events', 'write_discounts', 'write_draft_orders'
   ])) === JSON.stringify(['write_price_rules']));
ok('a write grant satisfies its read counterpart',
   scopes.missingFrom(list.filter(s => s.startsWith('write_')))
     .every(s => !['read_customers', 'read_price_rules', 'read_discounts'].includes(s)));
ok('Shopify\'s {handle} object shape is accepted, not just plain strings',
   scopes.missingFrom(list.map(handle => ({ handle }))).length === 0);
ok('junk in the granted list does not crash it',
   Array.isArray(scopes.missingFrom([null, undefined, '', { handle: '' }])));

// ---------------------------------------------------------------------------
console.log('\n-- the app notices a short grant before the merchant does --');
// ---------------------------------------------------------------------------
ok('whoami reports which scopes are missing',
   /missing_scopes = shopifyScopes\.missingFrom\(granted\)/.test(server));
ok('and offers a reconnect link when any are',
   /missing_scopes\.length[\s\S]{0,80}?\/auth\?shop=/.test(server));
ok('an unknown grant is reported as unknown, not as broken',
   /missing_scopes = null/.test(server));

const html = read('chat.html');
ok('the client shows the permission prompt on the way in',
   /if \(d\.missing_scopes && d\.missing_scopes\.length\)/.test(html));
ok('it names the permissions rather than asking for blind trust',
   /missingScopes\.join\(', '\)/.test(html));
ok('both languages have the wording',
   (html.match(/'reconnect\.scopeTitle':/g) || []).length === 2 &&
   (html.match(/'reconnect\.scopeBody':/g) || []).length === 2 &&
   (html.match(/'reconnect\.scopeCta':/g) || []).length === 2);

console.log(`\n${fail === 0 ? 'all' : pass + ' of ' + (pass + fail)} ${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail === 0 ? 0 : 1);
