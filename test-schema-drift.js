// ============================================================================
// SCHEMA DRIFT — does the SQL in the code match the SQL that built the database?
//
// Two of the four failures in the last seeding run were this, and both had been
// live for a long time without anyone noticing:
//
//   1. Every backfill wrote its audit record with
//        INSERT INTO data_access_log (shop_domain, action_type, action_details, ...)
//      and data_access_log has no action_type, no action_details and no
//      performed_by. So the audit trail this app formally tells Shopify it
//      keeps was never written once — and the failure printed a warning line
//      and carried on.
//
//   2. store_customers and store_orders carry a foreign key to shops, and
//      nothing in the codebase has ever inserted a row into shops. Every
//      customer and every order fetched for a newly installed shop was rejected
//      by the constraint. The backfill reported COMPLETE.
//
// Neither is the sort of thing an integration test catches, because both fail
// softly and both need a real database to fail at all. They are, however,
// perfectly visible in the source: the schema says what the columns are, and
// the code says what it writes. So compare them here, offline, in a second.
// ============================================================================

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}

const ROOT = __dirname;
const jsFiles = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.js') && !f.startsWith('test-') && f !== 'smoke-test.js')
  .map(f => path.join(ROOT, f));

// ---------------------------------------------------------------------------
// Build the picture of what the database actually has.
//
// Tables come from two places: schema.sql, and the CREATE TABLE statements the
// app runs at boot for tables it manages itself (advisor_stores and friends).
// ALTER TABLE ... ADD COLUMN counts too — that is how columns get added to
// tables that already exist in production.
// ---------------------------------------------------------------------------
const CONSTRAINT_WORDS = new Set([
  'primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like', 'partition'
]);

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// Split a CREATE TABLE body on the commas that separate column definitions,
// ignoring commas inside NUMERIC(10,2), DEFAULT '{}'::jsonb and the like.
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, current = '', quote = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function collectTables(sqlText, tables) {
  const createRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:;|`|\n\s*`)/gi;
  let m;
  while ((m = createRe.exec(sqlText))) {
    const name = m[1].toLowerCase();
    const body = m[2];
    const cols = tables[name] || (tables[name] = { columns: new Set(), references: new Set() });
    // Split on top-level commas, not on newlines: several of these tables
    // declare more than one column per line ("phone TEXT, email TEXT, name
    // TEXT,") and a line-based reader silently loses all but the first, then
    // reports every one of the rest as a column that does not exist.
    for (const part of splitTopLevel(stripSqlComments(body))) {
      const first = (part.trim().split(/[\s(]/)[0] || '').toLowerCase();
      if (!first || CONSTRAINT_WORDS.has(first)) continue;
      if (!/^[a-z0-9_]+$/.test(first)) continue;
      cols.columns.add(first);
    }
    const refRe = /REFERENCES\s+([a-z0-9_]+)\s*\(/gi;
    let r;
    while ((r = refRe.exec(body))) cols.references.add(r[1].toLowerCase());
  }

  const alterRe = /ALTER TABLE\s+([a-z0-9_]+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z0-9_]+)/gi;
  while ((m = alterRe.exec(sqlText))) {
    const name = m[1].toLowerCase();
    const t = tables[name] || (tables[name] = { columns: new Set(), references: new Set() });
    t.columns.add(m[2].toLowerCase());
  }
}

const tables = {};
collectTables(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'), tables);
for (const file of jsFiles) collectTables(fs.readFileSync(file, 'utf8'), tables);

console.log(`\n-- parsed ${Object.keys(tables).length} table definitions --`);
ok('schema.sql parsed and produced tables', Object.keys(tables).length > 10,
   `${Object.keys(tables).length} found`);
ok('data_access_log is one of them', !!tables.data_access_log);
ok('shops is one of them', !!tables.shops);

// ---------------------------------------------------------------------------
// Every INSERT must name columns that exist.
// ---------------------------------------------------------------------------
console.log('\n-- every INSERT names real columns --');
let insertsChecked = 0;
const badInserts = [];

for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const insRe = /INSERT INTO\s+([a-z0-9_]+)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = insRe.exec(src))) {
    const table = m[1].toLowerCase();
    const known = tables[table];
    if (!known || known.columns.size === 0) continue;   // table we do not define here
    const cols = m[2].split(',')
      .map(c => c.trim().toLowerCase())
      .filter(c => /^[a-z0-9_]+$/.test(c));
    if (!cols.length) continue;
    insertsChecked++;
    for (const col of cols) {
      if (!known.columns.has(col)) {
        const line = src.slice(0, m.index).split('\n').length;
        badInserts.push(`${path.basename(file)}:${line}  ${table}.${col}`);
      }
    }
  }
}

ok(`checked a meaningful number of INSERTs (${insertsChecked})`, insertsChecked >= 10);
ok('no INSERT writes a column that does not exist', badInserts.length === 0,
   badInserts.join('  |  '));

// ---------------------------------------------------------------------------
// Every foreign-key parent must be populated by something.
//
// A foreign key to a table nobody writes to is not a constraint, it is a wall.
// This is the check that would have caught store_customers -> shops.
// ---------------------------------------------------------------------------
console.log('\n-- every FK parent table is actually populated by the code --');
const parents = new Set();
for (const t of Object.values(tables)) for (const r of t.references) parents.add(r);

const allSrc = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const orphanParents = [];
for (const parent of parents) {
  const writes = new RegExp(`INSERT INTO\\s+${parent}\\b`, 'i').test(allSrc);
  if (!writes) orphanParents.push(parent);
}
ok(`found foreign-key parents to check (${parents.size})`, parents.size > 0,
   [...parents].join(', '));
ok('no table is referenced by a foreign key but never inserted into',
   orphanParents.length === 0,
   orphanParents.length ? `nothing ever inserts into: ${orphanParents.join(', ')}` : '');

// ---------------------------------------------------------------------------
// The specific guarantees behind the two live bugs, pinned so they cannot
// quietly come back.
// ---------------------------------------------------------------------------
console.log('\n-- the two regressions, pinned --');
const clientSrc = fs.readFileSync(path.join(ROOT, 'shopify-client.js'), 'utf8');

ok('shops row is created when a store is installed',
   /async function upsertStore[\s\S]{0,800}?ensureShopRow\(/.test(clientSrc));
ok('shops row is ensured before a backfill writes anything',
   /async function backfillEntireShop[\s\S]{0,600}?ensureShopRow\(/.test(clientSrc));
ok('ensureShopRow is idempotent (ON CONFLICT DO NOTHING)',
   /INSERT INTO shops[\s\S]{0,300}?ON CONFLICT[\s\S]{0,60}?DO NOTHING/i.test(clientSrc));
ok('ensureShopRow does NOT write the access token into the plaintext column',
   !/INSERT INTO shops\s*\([^)]*shopify_access_token/i.test(clientSrc));

const shopsCols = tables.shops ? tables.shops.columns : new Set();
const ensureCols = (clientSrc.match(/INSERT INTO shops\s*\(([^)]*)\)/i) || [null, ''])[1]
  .split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
ok('every column ensureShopRow writes exists on shops',
   ensureCols.length > 0 && ensureCols.every(c => shopsCols.has(c)),
   `writes [${ensureCols.join(', ')}]`);

ok('backfill no longer reports success unconditionally',
   !/stats\.success = true;/.test(clientSrc));
ok('backfill reports failure when it fetched rows and saved none',
   /stats\.success\s*=\s*fetched === 0 \|\| saved > 0/.test(clientSrc));

const logInsert = (clientSrc.match(/INSERT INTO data_access_log\s*\(([\s\S]*?)\)/i) || [null, ''])[1]
  .split(',').map(c => c.trim().toLowerCase()).filter(c => /^[a-z0-9_]+$/.test(c));
ok('the backfill audit INSERT names only real data_access_log columns',
   logInsert.length > 0 && logInsert.every(c => tables.data_access_log.columns.has(c)),
   `writes [${logInsert.join(', ')}]`);
ok('a failed audit write is reported as an error, not a shrug',
   /could not write data_access_log/.test(clientSrc) &&
   /console\.error\([^)]*data_access_log/.test(clientSrc));

console.log(`\n${failed === 0 ? 'all' : passed + ' of ' + (passed + failed)} ${passed} assertions passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed === 0 ? 0 : 1);
