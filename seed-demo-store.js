// ============================================================================
// SEED A DEMO STORE — give the agent something real to work with.
//
//   node seed-demo-store.js <shop.myshopify.com> --yes-write-to-this-store
//
// An empty store makes the whole product look broken: no customers to segment,
// no orders to learn from, a home screen of zeroes and a chat that answers "0"
// to everything. This creates customers and completed orders through Shopify's
// own API, so the data is genuinely in the store and arrives here through the
// normal backfill rather than being faked into our database.
//
// WHY IT IS THIS CAREFUL
//
// A seeding script is a loaded gun pointed at whatever shop you name. Run
// against a real business it injects invented people and invented orders into
// their customer list, their reports, and their accounting. So:
//
//   - the shop must be named explicitly; there is no default
//   - --yes-write-to-this-store is required, spelled out, every run
//   - it asks Shopify what plan the shop is on and REFUSES anything that is not
//     a development / partner / trial store, unless --force is also given
//   - it refuses outright, with no override, for the store this project is
//     required never to touch
//
// ORDER DATES
//
// Shopify does not let an app backdate an order, so everything created here is
// timestamped now. RFM segmentation is built on recency, and a store where
// every order happened in the same minute segments into one bucket. After
// seeding, the local copy of the order dates is spread across the past year so
// the segments are meaningful. That rewrite is LOCAL ONLY and clearly logged —
// Shopify's own records stay exactly as they happened.
// ============================================================================

const shopify = require('./shopify-client');
const db = require('./database');

const PROTECTED = /neta[-\s]?efrati|efrati/i;

// Enough variety that segmentation has something to separate.
const FIRST = ['Dana', 'Maya', 'Noa', 'Shira', 'Tamar', 'Yael', 'Rotem', 'Adi', 'Lior', 'Gal',
               'Omer', 'Ido', 'Nadav', 'Eitan', 'Yonatan', 'Amit', 'Roni', 'Talia', 'Hila', 'Sivan'];
const LAST = ['Levi', 'Cohen', 'Mizrahi', 'Peretz', 'Avraham', 'Friedman', 'Katz', 'Shapira',
              'Barak', 'Regev', 'Naor', 'Segal'];
const PRODUCTS = [
  { title: 'Linen Midi Dress', price: 289 }, { title: 'Oversized Denim Jacket', price: 349 },
  { title: 'Ribbed Knit Top', price: 129 }, { title: 'Wide Leg Trousers', price: 259 },
  { title: 'Silk Scarf', price: 89 }, { title: 'Leather Crossbody Bag', price: 399 },
  { title: 'Cotton Shirt Dress', price: 219 }, { title: 'Chunky Sole Boots', price: 459 },
  { title: 'Cashmere Blend Cardigan', price: 379 }, { title: 'Pleated Skirt', price: 199 }
];

// A spread that produces every RFM segment rather than one blob: a few whales,
// a long tail, some who bought last week and some who vanished a year ago.
const PROFILES = [
  { n: 3,  orders: [4, 7], daysAgo: [2, 20],    label: 'champions' },
  { n: 4,  orders: [2, 4], daysAgo: [10, 45],   label: 'loyal' },
  { n: 3,  orders: [3, 6], daysAgo: [120, 220], label: 'at risk / cant lose' },
  { n: 5,  orders: [1, 1], daysAgo: [3, 30],    label: 'new' },
  { n: 5,  orders: [1, 2], daysAgo: [200, 340], label: 'dormant' }
];

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function shopifyPost(shop, endpoint, body) {
  const token = await shopify.getFreshToken(shop);
  if (!token) throw new Error(`no usable access token for ${shop} — reconnect the app`);
  const res = await fetch(`https://${shop}/admin/api/2026-01/${endpoint}`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// Is this a store it is safe to invent people in?
async function looksLikeDevStore(shop) {
  try {
    const d = await shopify.shopifyGet(shop, 'shop.json');
    const plan = String((d && d.shop && d.shop.plan_name) || '').toLowerCase();
    return {
      ok: /partner_test|affiliate|development|plus_partner_sandbox|staff_business|trial/.test(plan),
      plan: plan || '(unknown)'
    };
  } catch (e) {
    return { ok: false, plan: `(could not read: ${e.message})` };
  }
}

async function seed(shop, { customers = 20, force = false } = {}) {
  console.log(`\nSeeding ${shop}\n`);

  const created = [];
  let orderCount = 0;

  for (const profile of PROFILES) {
    for (let i = 0; i < profile.n; i++) {
      const first = pick(FIRST), last = pick(LAST);
      const email = `${first}.${last}${rnd(100, 999)}@example.com`.toLowerCase();
      // Israeli mobile shape, so the SMS path has something valid to route.
      const phone = '+9725' + rnd(0, 9) + String(rnd(1000000, 9999999));

      let customer;
      try {
        const r = await shopifyPost(shop, 'customers.json', {
          customer: {
            first_name: first, last_name: last, email, phone,
            verified_email: true,
            // Consent matters: the agent skips anyone who declined, so seeded
            // customers must genuinely have accepted or the demo shows nothing.
            email_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in' },
            tags: 'seeded-demo'
          }
        });
        customer = r.customer;
      } catch (e) {
        console.log(`  skip ${email}: ${String(e.message).slice(0, 120)}`);
        continue;
      }

      const nOrders = rnd(profile.orders[0], profile.orders[1]);
      for (let o = 0; o < nOrders; o++) {
        const items = [];
        for (let k = 0; k < rnd(1, 3); k++) {
          const p = pick(PRODUCTS);
          items.push({ title: p.title, price: p.price, quantity: rnd(1, 2) });
        }
        try {
          // Draft order, then complete it. The app has write_draft_orders but
          // not write_orders, and completing a draft is the supported way to
          // end up with a real order. Custom line items mean this works on a
          // store with no products in it.
          const draft = await shopifyPost(shop, 'draft_orders.json', {
            draft_order: {
              customer: { id: customer.id },
              line_items: items,
              tags: 'seeded-demo',
              use_customer_default_address: false
            }
          });
          await shopifyPost(shop, `draft_orders/${draft.draft_order.id}/complete.json`, {});
          orderCount++;
        } catch (e) {
          console.log(`  order failed for ${email}: ${String(e.message).slice(0, 120)}`);
        }
        await sleep(220);   // Shopify's REST limit is 2/sec; stay under it.
      }

      created.push({ email, daysAgo: profile.daysAgo, label: profile.label });
      console.log(`  ${first} ${last}  ${nOrders} order(s)   [${profile.label}]`);
      await sleep(220);
    }
  }

  console.log(`\n${created.length} customers, ${orderCount} orders created in Shopify.`);
  return created;
}

// Shopify timestamps every seeded order "now", and RFM is built on recency —
// so without this every customer lands in the same segment and the demo shows
// one bucket. Rewrites OUR copy only.
async function spreadDatesLocally(shop, created) {
  console.log('\nSpreading order dates in the LOCAL copy (Shopify\'s records are untouched)...');
  let moved = 0;
  for (const c of created) {
    const days = rnd(c.daysAgo[0], c.daysAgo[1]);
    try {
      const r = await db.query(
        `UPDATE store_orders
            SET ordered_at = NOW() - ($3 || ' days')::interval
          WHERE shop_domain = $1
            AND shopify_customer_id IN (
              SELECT shopify_customer_id FROM store_customers
               WHERE shop_domain = $1 AND LOWER(email) = LOWER($2))
          RETURNING id`,
        [shop, c.email, String(days)]);
      moved += r.rows.length;
    } catch (e) {
      console.log(`  could not move ${c.email}: ${e.message}`);
    }
  }
  console.log(`${moved} order rows re-dated locally.`);
}

(async () => {
  const args = process.argv.slice(2);
  const shop = (args.find(a => a.includes('.myshopify.com')) || '').toLowerCase().trim();
  const confirmed = args.includes('--yes-write-to-this-store');
  const force = args.includes('--force');
  const skipDates = args.includes('--no-date-spread');
  const count = parseInt((args.find(a => a.startsWith('--customers=')) || '').split('=')[1], 10);

  if (!shop) {
    console.error('Usage: node seed-demo-store.js <shop.myshopify.com> --yes-write-to-this-store');
    process.exit(1);
  }
  if (PROTECTED.test(shop)) {
    console.error('REFUSED: this store is marked never-touch in this project. No override exists.');
    process.exit(1);
  }
  if (!confirmed) {
    console.error(`REFUSED: this writes invented customers and orders into ${shop}.`);
    console.error('If that is really what you want, add --yes-write-to-this-store');
    process.exit(1);
  }

  // Railway's copy button appends the variable's NAME to its value, so the URL
  // arrives as ".../railway-DATABASE_PUBLIC_URL". Postgres then reports
  // 'database "railway-DATABASE_PUBLIC_URL" does not exist', which is accurate
  // and tells you nothing about the cause. Caught twice in a row here; say what
  // it actually is.
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) {
    console.error('REFUSED: DATABASE_URL is not set. Copy DATABASE_PUBLIC_URL from the Postgres');
    console.error('service in Railway (not the app service, and not the internal .railway.internal one).');
    process.exit(1);
  }
  if (/-DATABASE_(PUBLIC_)?URL$|-Railway$/i.test(dbUrl)) {
    console.error('REFUSED: DATABASE_URL has the variable NAME stuck on the end:');
    console.error('  ...' + dbUrl.slice(-45));
    console.error("Railway's copy button does that. Delete everything after the database name");
    console.error('(the URL should end in "/railway") and run it again.');
    process.exit(1);
  }
  if (/\.railway\.internal/.test(dbUrl)) {
    console.error('REFUSED: that is the INTERNAL database host, which only resolves inside');
    console.error("Railway's own network. From a laptop you need DATABASE_PUBLIC_URL, which");
    console.error('looks like postgresql://...@something.proxy.rlwy.net:PORT/railway');
    process.exit(1);
  }

  await shopify.loadStores();
  if (!shopify.hasTokenForShop(shop)) {
    console.error(`REFUSED: no access token for ${shop}. Connect the app to it first.`);
    process.exit(1);
  }

  const dev = await looksLikeDevStore(shop);
  console.log(`Shopify reports plan: ${dev.plan}`);
  if (!dev.ok && !force) {
    console.error('\nREFUSED: that does not look like a development store.');
    console.error('Seeding a real shop puts invented people in a real customer list,');
    console.error('a real inbox, and real reports. Add --force only if you are certain.');
    process.exit(1);
  }
  if (!dev.ok && force) console.log('\n--force given on a non-development store. Proceeding.\n');

  const created = await seed(shop, { customers: isNaN(count) ? 20 : count, force });

  if (created.length && !skipDates) {
    console.log('\nWaiting 20s for the backfill to pull these in...');
    await sleep(20000);
    await spreadDatesLocally(shop, created);
  }

  console.log('\nDone. Open the app and ask it how many customers you have.');
  console.log('If the numbers are still zero, the backfill has not finished — wait a minute and retry.');
  process.exit(0);
})().catch(e => { console.error('seed failed:', e.message); process.exit(2); });
