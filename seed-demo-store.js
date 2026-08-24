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

// Exit without tripping libuv. process.exit() while the pg pool still holds
// open sockets fires "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// on Windows — right after a REFUSED message, which makes a correct refusal
// look like a crash. Drain the pool first.
async function bail(code) {
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(code);
}

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// An Israeli mobile number Shopify will actually accept.
//
// Restricting to "prefixes in use" was not enough. Shopify validates with
// libphonenumber, which does not treat 05X plus any seven digits as a number:
// 054 never carries a 0 in the next position, and 055 is handed out in small
// sub-blocks (5501, 5517, 552x…) rather than as a whole range. Random digits in
// those ranges came back 422 {"phone":["is invalid"]} and cost a customer each
// time — four of twenty on the last run.
//
// 050, 052, 053 and 058 are allocated whole, so anything after them is valid.
// 054 is included with its first digit constrained, because Partner is too big
// a carrier for a realistic demo list to be missing it.
function israeliMobile() {
  const prefix = pick(['50', '52', '53', '58', '54']);
  const rest = prefix === '54'
    ? String(rnd(1, 9)) + String(rnd(100000, 999999))
    : String(rnd(1000000, 9999999));
  return '+972' + prefix + rest;
}

async function shopifyPost(shop, endpoint, body, method = 'POST') {
  const token = await shopify.getFreshToken(shop);
  if (!token) throw new Error(`no usable access token for ${shop} — reconnect the app`);
  const res = await fetch(`https://${shop}/admin/api/2026-01/${endpoint}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      // Without an explicit Accept, Shopify answers 406 with an EMPTY body on
      // some endpoints — an error that says nothing about what is wrong.
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    // Carry the status and Retry-After out with the error. Callers that want to
    // back off should not have to regex a message string to find out they were
    // throttled.
    const err = new Error(`${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.retryAfterMs = Math.round((Number(res.headers.get('retry-after')) || 0) * 1000) || null;
    throw err;
  }
  return data;
}

// Completing a draft order is metered separately from the rest of the Admin
// API, and far more tightly:
//   429 {"errors":"Exceeded draft order API rate limit, please try again in a minute"}
// The run that finally got past the 406 hit this on nearly every order and
// produced six out of fifty. Shopify does not publish the number, so rather
// than hard-code a guess the pace tunes itself: every 429 widens the gap, a
// clean streak narrows it again. Slow, but it finishes, and it stops guessing.
const MIN_GAP_MS = 2500, MAX_GAP_MS = 45000;
let completionGapMs = 9000;
let cleanStreak = 0;

async function completeDraft(shop, draftId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(completionGapMs);
    try {
      await shopifyPost(shop, `draft_orders/${draftId}/complete.json`, {}, 'PUT');
      if (++cleanStreak >= 4) {
        completionGapMs = Math.max(MIN_GAP_MS, Math.round(completionGapMs * 0.75));
        cleanStreak = 0;
      }
      return true;
    } catch (e) {
      if (e.status !== 429) throw e;
      cleanStreak = 0;
      completionGapMs = Math.min(MAX_GAP_MS, Math.round(completionGapMs * 1.7));
      const waitMs = e.retryAfterMs || completionGapMs;
      console.log(`  rate limited — waiting ${Math.round(waitMs / 1000)}s, pacing now ${Math.round(completionGapMs / 1000)}s/order`);
      await sleep(waitMs);
    }
  }
  return false;
}

// Is this a store it is safe to invent people in?
//
// plan_name is NOT a reliable signal any more: a genuine development store —
// created in Partners, wearing the "dev" badge in its own admin — reported
// plan_name "basic" and was refused. The field Shopify itself uses is the
// boolean Shop.plan.partnerDevelopment, GraphQL-only, so ask that first and
// keep the plan-name heuristic as the fallback for anything that cannot
// answer GraphQL.
async function looksLikeDevStore(shop) {
  try {
    const token = await shopify.getFreshToken(shop);
    if (token) {
      const res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ shop { plan { partnerDevelopment displayName } } }' })
      });
      const data = await res.json().catch(() => null);
      const plan = data && data.data && data.data.shop && data.data.shop.plan;
      if (plan && typeof plan.partnerDevelopment === 'boolean') {
        return {
          ok: plan.partnerDevelopment,
          plan: (plan.displayName || 'unknown') + (plan.partnerDevelopment ? ' (partner development)' : '')
        };
      }
    }
  } catch (e) { /* fall through to the REST heuristic */ }
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

// Remove what earlier runs left behind.
//
// Every failed run still creates rows: customers that succeeded before the
// failure, and draft orders that were created but never completed. Run the
// seeder three times and the store holds sixty customers and a hundred
// dangling drafts, and the numbers the agent reports stop meaning anything.
//
// Only ever touches things tagged `seeded-demo`, which only this script
// applies — a real customer is never in scope.
async function clean(shop) {
  console.log('\nRemoving data from earlier runs (tagged seeded-demo)...');
  const token = await shopify.getFreshToken(shop);
  const del = async (path) => {
    const r = await fetch(`https://${shop}/admin/api/2026-01/${path}`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' }
    });
    return r.ok || r.status === 404;
  };

  let drafts = 0, custs = 0, orders = 0;
  try {
    // Completed orders first. A draft that was completed is no longer listed as
    // an open draft — it is a real order now, carrying the tag it inherited
    // from the draft — and an order attached to a customer blocks that
    // customer's deletion just as a draft does. Cancel before delete: Shopify
    // refuses to delete an order that is still open.
    const o = await shopify.shopifyGet(shop, 'orders.json?limit=250&status=any');
    let seededOrders = 0;
    for (const order of (o.orders || [])) {
      if (!/seeded-demo/.test(order.tags || '')) continue;
      seededOrders++;
      try { await shopifyPost(shop, `orders/${order.id}/cancel.json`, {}); } catch (e) { /* already cancelled, or not permitted */ }
      if (await del(`orders/${order.id}.json`)) orders++;
      await sleep(280);
    }
    // Cancelling and deleting orders needs write_orders, which this app
    // deliberately does not request: asking every merchant for permission to
    // modify their orders, to support a script only we ever run, is not a trade
    // worth making. So say plainly that the orders are staying, rather than
    // printing "0 orders removed" and letting it look like there were none.
    if (seededOrders && !orders) {
      console.log(`  ${seededOrders} seeded order(s) left in place — removing orders needs the`);
      console.log('  write_orders permission, which this app does not ask for. Delete them from');
      console.log('  the Shopify admin if you want them gone.');
    }
  } catch (e) { console.log('  orders: ' + e.message.slice(0, 100)); }

  try {
    // Dangling drafts next: a draft holding a customer blocks that customer's
    // deletion, so the order matters.
    const d = await shopify.shopifyGet(shop, 'draft_orders.json?limit=250&status=open');
    for (const draft of (d.draft_orders || [])) {
      if (!/seeded-demo/.test(draft.tags || '')) continue;
      if (await del(`draft_orders/${draft.id}.json`)) drafts++;
      await sleep(220);
    }
  } catch (e) { console.log('  drafts: ' + e.message.slice(0, 100)); }

  try {
    const c = await shopify.shopifyGet(shop, 'customers.json?limit=250');
    for (const cust of (c.customers || [])) {
      if (!/seeded-demo/.test(cust.tags || '')) continue;
      if (await del(`customers/${cust.id}.json`)) custs++;
      await sleep(220);
    }
  } catch (e) { console.log('  customers: ' + e.message.slice(0, 100)); }

  // The local copies too, or the agent keeps reporting people who no longer
  // exist in Shopify.
  let localC = 0, localO = 0;
  try {
    const r1 = await db.query(
      `DELETE FROM store_orders WHERE shop_domain=$1 AND shopify_customer_id IN (
         SELECT shopify_customer_id FROM store_customers
          WHERE shop_domain=$1 AND email LIKE '%@example.com') RETURNING id`, [shop]);
    localO = r1.rows.length;
    const r2 = await db.query(
      `DELETE FROM store_customers WHERE shop_domain=$1 AND email LIKE '%@example.com' RETURNING id`, [shop]);
    localC = r2.rows.length;
  } catch (e) { console.log('  local: ' + e.message.slice(0, 100)); }

  console.log(`Removed ${custs} customers, ${orders} orders and ${drafts} draft orders from Shopify, `
    + `${localC} customers and ${localO} orders locally.`);
}

async function seed(shop, { customers = 20, force = false } = {}) {
  const plannedOrders = PROFILES.reduce((sum, p) => sum + p.n * ((p.orders[0] + p.orders[1]) / 2), 0);
  console.log(`\nSeeding ${shop}\n`);
  console.log(`About ${Math.round(plannedOrders)} orders to create. Shopify meters draft-order`);
  console.log(`completion tightly, so this paces itself and will take several minutes.\n`);

  const created = [];
  let orderCount = 0;
  let failedOrders = 0;

  for (const profile of PROFILES) {
    for (let i = 0; i < profile.n; i++) {
      const first = pick(FIRST), last = pick(LAST);
      const email = `${first}.${last}${rnd(100, 999)}@example.com`.toLowerCase();
      const phone = israeliMobile();

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
        const msg = String(e.message);
        // One protected-customer-data refusal means they will ALL refuse: the
        // app has not declared PCD access in the dashboard. Printing nineteen
        // more identical 403s and then "Done" made a hard blocker read like a
        // successful run with some skips.
        if (/protected customer data/i.test(msg)) {
          console.error('\nSTOPPED: Shopify refuses customer data until access is DECLARED for this app.');
          console.error('A dashboard setting, not a review — dev stores work immediately after:');
          console.error('  Dev Dashboard -> the app -> API access -> Protected customer data access');
          console.error('  -> select "Protected customer data", tick Name / Email / Phone / Address,');
          console.error('  -> one-line reason each, Save.');
          console.error('Only a public App Store listing needs the full review.');
          await bail(1);
        }
        console.log(`  skip ${email}: ${msg.slice(0, 120)}`);
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
          // PUT, and paced. Sending POST here returned 406 with no body, so
          // every draft was created and none was ever turned into an order;
          // once that was fixed the draft-order rate limit rejected them
          // instead. completeDraft owns both the method and the pacing.
          if (await completeDraft(shop, draft.draft_order.id)) {
            orderCount++;
          } else {
            failedOrders++;
            console.log(`  order gave up after repeated rate limits for ${email}`);
          }
        } catch (e) {
          failedOrders++;
          console.log(`  order failed for ${email}: ${String(e.message).slice(0, 120)}`);
        }
      }

      created.push({ email, daysAgo: profile.daysAgo, label: profile.label });
      console.log(`  ${first} ${last}  ${nOrders} order(s)   [${profile.label}]`);
      await sleep(220);
    }
  }

  console.log(`\n${created.length} customers, ${orderCount} orders created in Shopify.`);
  if (failedOrders) {
    console.log(`${failedOrders} order(s) could not be created. Re-run with --clean to start over,`);
    console.log(`or leave it: the segments only need enough history to be distinguishable.`);
  }
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
  // --clean removes what earlier runs left; --clean-only stops after that.
  const doClean = args.includes('--clean') || args.includes('--clean-only');
  const cleanOnly = args.includes('--clean-only');
  const count = parseInt((args.find(a => a.startsWith('--customers=')) || '').split('=')[1], 10);

  if (!shop) {
    console.error('Usage: node seed-demo-store.js <shop.myshopify.com> --yes-write-to-this-store');
    console.error('  --clean        remove data from earlier runs first');
    console.error('  --clean-only   remove it and stop');
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
    await bail(1);
  }

  const dev = await looksLikeDevStore(shop);
  console.log(`Shopify reports plan: ${dev.plan}`);
  if (!dev.ok && !force) {
    console.error('\nREFUSED: that does not look like a development store.');
    console.error('Seeding a real shop puts invented people in a real customer list,');
    console.error('a real inbox, and real reports. Add --force only if you are certain.');
    await bail(1);
  }
  if (!dev.ok && force) console.log('\n--force given on a non-development store. Proceeding.\n');

  if (doClean) await clean(shop);
  if (cleanOnly) { console.log('\nClean only — nothing seeded.'); await bail(0); }

  const created = await seed(shop, { customers: isNaN(count) ? 20 : count, force });

  // A run that created nothing is a failure, whatever the reason — saying
  // "Done" after 0 customers is how the PCD blocker got read as success.
  if (!created.length) {
    console.error('\nFAILED: nothing was created. Fix the errors above and run again.');
    await bail(1);
  }

  if (created.length && !skipDates) {
    // Run the backfill OURSELVES rather than hoping one happens. The install-time
    // backfill ran before this data existed, and the orders/create webhook is
    // parked pending Protected Customer Data approval — so without this pull,
    // nothing seeded here would ever reach the local database, and the date
    // spread below would have no rows to work on.
    console.log('\nPulling the seeded data into the local database (full backfill)...');
    try {
      await shopify.backfillEntireShop(shop, (p) => {
        if (p && p.phase) console.log('  ' + p.phase);
      });
    } catch (e) {
      console.log('  backfill failed (' + e.message + ') — waiting 20s and continuing anyway');
      await sleep(20000);
    }
    await spreadDatesLocally(shop, created);
  }

  console.log('\nDone. Open the app and ask it how many customers you have.');
  console.log('If the numbers are still zero, the backfill has not finished — wait a minute and retry.');
  await bail(0);
})().catch(async e => { console.error('seed failed:', e.message); await bail(2); });
