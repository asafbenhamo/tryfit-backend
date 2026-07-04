// ============================================================================
// import-flashy-optouts.js — ONE-TIME import of existing Flashy unsubscribers.
//
// The webhook only catches unsubscribes from the moment it's connected onward.
// This script backfills everyone who ALREADY unsubscribed in Flashy, so the
// advisor never contacts them.
//
// USAGE (run once, locally or on Railway shell):
//   1. In Flashy, export your "unsubscribed / not-approved-for-mailing" contacts
//      to a CSV. It should contain an email column and/or a phone column.
//   2. Put the CSV somewhere this script can read it.
//   3. Run:
//        node import-flashy-optouts.js path/to/unsubscribed.csv
//
//   Optional shop override (defaults to FLASHY_SHOP or seven770.myshopify.com):
//        node import-flashy-optouts.js path/to/unsubscribed.csv seven770.myshopify.com
//
// The CSV is parsed leniently: it auto-detects columns whose header contains
// "email"/"מייל" or "phone"/"טלפון"/"נייד". Rows are added via compliance.addOptOut.
// ============================================================================

const fs = require('fs');
const compliance = require('./compliance');

function parseCsvLine(line) {
  // Minimal CSV parse: handles simple quoted fields and commas.
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, '');
  if (p.startsWith('972')) p = '0' + p.slice(3);
  if (/^5\d{8}$/.test(p)) p = '0' + p;
  return /^05\d{8}$/.test(p) ? p : null;
}

async function main() {
  const csvPath = process.argv[2];
  const shop = process.argv[3] || process.env.FLASHY_SHOP || 'seven770.myshopify.com';

  if (!csvPath) {
    console.error('Usage: node import-flashy-optouts.js <csv-file> [shop-domain]');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error('File not found:', csvPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) { console.error('Empty CSV.'); process.exit(1); }

  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const emailIdx = header.findIndex(h => h.includes('email') || h.includes('מייל') || h.includes('דוא'));
  const phoneIdx = header.findIndex(h => h.includes('phone') || h.includes('טלפון') || h.includes('נייד') || h.includes('mobile'));

  if (emailIdx === -1 && phoneIdx === -1) {
    console.error('Could not find an email or phone column in header:', header.join(' | '));
    console.error('Rename a column to include "email" or "phone" and retry.');
    process.exit(1);
  }

  console.log(`Importing Flashy opt-outs into shop=${shop}`);
  console.log(`email column: ${emailIdx > -1 ? header[emailIdx] : '(none)'} | phone column: ${phoneIdx > -1 ? header[phoneIdx] : '(none)'}`);

  let added = 0, skipped = 0, failed = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const email = emailIdx > -1 ? (cells[emailIdx] || '').trim() : '';
    const phone = phoneIdx > -1 ? normalizePhone(cells[phoneIdx]) : null;
    const cleanEmail = email && email.includes('@') ? email.toLowerCase() : null;

    if (!cleanEmail && !phone) { skipped++; continue; }

    try {
      await compliance.addOptOut(shop, { email: cleanEmail, phone, reason: 'flashy_import' });
      added++;
      if (added % 100 === 0) console.log(`  ...${added} added`);
    } catch (err) {
      failed++;
      console.error(`  row ${i} failed:`, err.message);
    }
  }

  console.log('----------------------------------------');
  console.log(`DONE. added=${added}, skipped(no contact)=${skipped}, failed=${failed}`);
  console.log('These people will no longer be contacted by the advisor.');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });