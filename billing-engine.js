// ============================================================================
// BILLING — usage-based charging through Shopify, so the 5%-of-attributed-sales
// model can actually collect.
//
// Shopify requires that any charge to a merchant go through THEIR billing API.
// Invoicing a Shopify merchant out of band for app usage is grounds for removal
// from the App Store, so this is not optional plumbing — without it the app can
// be installed and do work, but cannot take a cent.
//
// The flow:
//   1. appSubscriptionCreate  — a recurring subscription carrying a USAGE
//      pricing line with a capped amount. The cap is a hard ceiling the merchant
//      agrees to up front; Shopify refuses usage charges past it.
//   2. The merchant is redirected to confirmationUrl and approves.
//   3. appUsageRecordCreate  — as sales are attributed, we record a charge
//      against the subscription line. Each record needs an idempotency key so a
//      retry or a double-run never bills twice.
//
// Nothing here charges automatically on its own: recordCommission is called with
// an explicit amount for an explicit attributed order, and refuses to bill the
// same order twice.
//
// HOW BILLING IS TRIGGERED, and why it is a sweep rather than a side-effect.
//
// It used to be a side-effect: the 5-minute attribution scan closed a sale and
// billed for it in the same breath. That collected nothing in production. Two
// code paths close a sale — the orders/create webhook and the scan — and the
// webhook almost always wins, because it fires the instant the order exists
// while the scan runs at most every five minutes. The webhook credited the sale
// and set converting_order_id; the scan then reached its `alreadyCredited`
// guard and returned before the branch holding the charge. The only line that
// billed was on the path that never ran. The app did the work and invoiced
// nobody.
//
// Attribution now only credits. sweepUnbilled() finds converted actions with no
// successful charge and bills them, so it no longer matters which path closed
// the sale. It also gives us three things the inline call could not have:
//
//   - retries. A charge that failed (network, a lapsed subscription, a
//     temporarily exceeded cap) is picked up again on a later sweep instead of
//     being lost the moment the function returned.
//   - payment gating. A sale is credited to the merchant's dashboard when it is
//     placed, but only billed once the money is actually collected — so cash on
//     delivery and bank transfer are not charged as commission until they clear.
//   - reversal. An order cancelled or refunded before we billed is never
//     billed at all.
// ============================================================================

const db = require('./database');
const shopify = require('./shopify-client');

const API_VERSION = '2026-01';

// Where Shopify sends the merchant back after approving a subscription. This
// MUST be absolute — appSubscriptionCreate rejects a relative returnUrl, which
// meant that on any deploy without PUBLIC_BASE_URL set, subscribing failed with
// a GraphQL error and the app could never bill at all. Every other module in
// the codebase already carried this fallback; this one did not.
const DEFAULT_BASE = 'https://tryfit-backend-production.up.railway.app';
function publicBase() {
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/i.test(raw) ? raw : DEFAULT_BASE;
}

// What we charge: a share of revenue we can PROVE we generated (coupon redeemed,
// agent-built cart, or a tracked click followed by a purchase).
const COMMISSION_RATE = 0.05;

// The default ceiling a merchant approves. They are never charged more than this
// in a 30-day window without explicitly approving a higher cap.
const DEFAULT_CAPPED_AMOUNT = 500.0;
const TRIAL_DAYS = 14;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_subscriptions (
      shop_domain TEXT PRIMARY KEY,
      subscription_gid TEXT,
      line_item_gid TEXT,
      status TEXT,
      capped_amount NUMERIC(12,2),
      currency TEXT,
      confirmation_url TEXT,
      activated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[billing] table:', e.message));
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_usage_charges (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      action_id BIGINT,
      idempotency_key TEXT NOT NULL UNIQUE,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT,
      attributed_revenue NUMERIC(12,2),
      usage_record_gid TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[billing] usage table:', e.message));
  // Added after the table shipped. `attempts` and `last_attempt_at` are what
  // make a failed charge recoverable: without them the claim row sat at
  // status='failed' forever and nothing ever looked at it again.
  await db.query(`ALTER TABLE app_usage_charges ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE app_usage_charges ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE app_usage_charges ADD COLUMN IF NOT EXISTS order_id TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_shop ON app_usage_charges(shop_domain, created_at DESC)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_action ON app_usage_charges(shop_domain, action_id)`).catch(() => {});
  tableReady = true;
}

// A charge in one of these states is finished with, one way or another, and must
// never be attempted again.
const TERMINAL = ['charged', 'void_order', 'abandoned'];
// Everything else is retryable, including 'pending'. A process that died between
// calling Shopify and writing the result leaves a row at 'pending' that would
// otherwise be stuck forever — and retrying it is safe, because Shopify dedupes
// on the idempotency key and returns the usage record it already created rather
// than making a second one.
const RETRY_AFTER_MIN = 30;
const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// GraphQL. The billing API is GraphQL-only; shopify-client only speaks REST.
// ---------------------------------------------------------------------------
async function graphql(shop, query, variables = {}) {
  const token = shopify.getTokenForShop(shop);
  if (!token) throw new Error(`no access token for ${shop}`);
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (body.errors && body.errors.length) {
    throw new Error('GraphQL: ' + body.errors.map(e => e.message).join('; '));
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// 1. Ask the merchant to approve a subscription.
// ---------------------------------------------------------------------------
const CREATE_SUBSCRIPTION = `
mutation CreateSub($name: String!, $returnUrl: URL!, $trialDays: Int!, $test: Boolean!, $cap: Decimal!, $currency: CurrencyCode!, $terms: String!) {
  appSubscriptionCreate(
    name: $name
    returnUrl: $returnUrl
    trialDays: $trialDays
    test: $test
    lineItems: [{
      plan: {
        appUsagePricingDetails: {
          cappedAmount: { amount: $cap, currencyCode: $currency }
          terms: $terms
        }
      }
    }]
  ) {
    userErrors { field message }
    confirmationUrl
    appSubscription { id status lineItems { id } }
  }
}`;

// Is this a store that CANNOT be charged for real? Shopify rejects a live
// subscription on a development, partner-test or plus-sandbox store, so the
// whole install fails there unless the charge is flagged as a test. This is
// derived from Shopify rather than taken from the client: `test: true` is
// "never actually bill me", and a request body is not allowed to decide that.
async function isTestStore(shop) {
  try {
    const data = await shopify.shopifyGet(shop, 'shop.json');
    const plan = String((data && data.shop && data.shop.plan_name) || '').toLowerCase();
    return /partner_test|affiliate|development|plus_partner_sandbox|staff_business|trial/.test(plan);
  } catch (e) {
    // Unknown plan. Bill for real rather than silently making every charge a
    // test charge that collects nothing — a failed subscription is visible,
    // a free-forever one is not.
    console.warn('[billing] could not read plan for', shop, '-', e.message);
    return false;
  }
}

async function startSubscription(shop, opts = {}) {
  await ensureTable();
  // The cap is what the merchant is agreeing to. A bad value here is either a
  // subscription Shopify refuses or a ceiling nobody meant to approve.
  let cap = Number(opts.cappedAmount);
  if (!isFinite(cap) || cap <= 0) cap = DEFAULT_CAPPED_AMOUNT;
  cap = Math.min(Math.max(Math.round(cap * 100) / 100, 5), 10000);
  const currency = /^[A-Z]{3}$/.test(String(opts.currency || '').toUpperCase())
    ? String(opts.currency).toUpperCase() : 'USD';
  const returnUrl = `${publicBase()}/billing/confirmed?shop=${encodeURIComponent(shop)}`;
  // Shopify shows these terms on the approval screen. They must describe the
  // charge honestly — this is what the merchant is agreeing to.
  const terms = `${Math.round(COMMISSION_RATE * 100)}% of sales the agent is proven to have generated (a redeemed coupon, an agent-built cart, or a tracked click followed by a purchase). No charge for sales it cannot prove. Capped at ${cap} ${currency} per 30 days.`;

  const data = await graphql(shop, CREATE_SUBSCRIPTION, {
    name: 'Smart Advisor — performance pricing',
    returnUrl,
    trialDays: opts.trialDays != null ? Number(opts.trialDays) : TRIAL_DAYS,
    // A development store cannot be charged for real; test charges let the whole
    // flow be exercised end to end without money moving. Asked of Shopify, not
    // of the caller — see isTestStore.
    test: opts.test === true || await isTestStore(shop),
    cap: cap.toFixed(2),
    currency,
    terms
  });

  const r = data && data.appSubscriptionCreate;
  if (!r) throw new Error('no appSubscriptionCreate in response');
  if (r.userErrors && r.userErrors.length) {
    throw new Error(r.userErrors.map(e => `${(e.field || []).join('.')}: ${e.message}`).join('; '));
  }

  const sub = r.appSubscription || {};
  const lineItem = (sub.lineItems && sub.lineItems[0]) || {};
  await db.query(
    `INSERT INTO app_subscriptions (shop_domain, subscription_gid, line_item_gid, status, capped_amount, currency, confirmation_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (shop_domain) DO UPDATE SET
       subscription_gid=$2, line_item_gid=$3, status=$4, capped_amount=$5, currency=$6, confirmation_url=$7, updated_at=NOW()`,
    [shop, sub.id || null, lineItem.id || null, sub.status || 'PENDING', cap, currency, r.confirmationUrl || null]
  ).catch(e => console.error('[billing] save subscription:', e.message));

  return { ok: true, confirmationUrl: r.confirmationUrl, subscription_gid: sub.id, status: sub.status, capped_amount: cap, currency };
}

// ---------------------------------------------------------------------------
// 2. What is this shop's subscription doing right now? Read from Shopify, which
//    is the source of truth — a merchant can cancel or decline outside our app.
// ---------------------------------------------------------------------------
const CURRENT_SUBSCRIPTION = `
query {
  currentAppInstallation {
    activeSubscriptions {
      id name status test
      lineItems {
        id
        plan { pricingDetails { ... on AppUsagePricing {
          terms balanceUsed { amount currencyCode } cappedAmount { amount currencyCode }
        } } }
      }
    }
  }
}`;

async function getSubscription(shop) {
  await ensureTable();
  try {
    const data = await graphql(shop, CURRENT_SUBSCRIPTION);
    const subs = (data && data.currentAppInstallation && data.currentAppInstallation.activeSubscriptions) || [];
    const active = subs.find(s => s.status === 'ACTIVE') || subs[0] || null;
    if (!active) return { ok: true, active: false, status: 'NONE' };

    const li = (active.lineItems || [])[0] || {};
    const pd = (li.plan && li.plan.pricingDetails) || {};
    const used = pd.balanceUsed ? parseFloat(pd.balanceUsed.amount) : 0;
    const cap = pd.cappedAmount ? parseFloat(pd.cappedAmount.amount) : null;

    await db.query(
      `UPDATE app_subscriptions SET status=$2, line_item_gid=COALESCE($3, line_item_gid), updated_at=NOW()
        WHERE shop_domain=$1`,
      [shop, active.status, li.id || null]).catch(() => {});

    return {
      ok: true, active: active.status === 'ACTIVE', status: active.status,
      test: !!active.test, subscription_gid: active.id, line_item_gid: li.id || null,
      used, capped_amount: cap,
      remaining: (cap != null) ? Math.max(0, cap - used) : null,
      currency: (pd.cappedAmount && pd.cappedAmount.currencyCode) || null
    };
  } catch (e) {
    // A shop that never approved anything is not an error state.
    return { ok: false, active: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 3. Charge for one attributed sale.
//
// Idempotency is the whole game here: schedulers retry, deploys replay, and
// billing a merchant twice for the same order is the fastest way to lose them.
// The key is derived from the action id, so the same attributed sale can only
// ever produce one charge — enforced by a UNIQUE constraint, not by hope.
// ---------------------------------------------------------------------------
const CREATE_USAGE = `
mutation CreateUsage($subscriptionLineItemId: ID!, $description: String!, $price: MoneyInput!, $idempotencyKey: String!) {
  appUsageRecordCreate(
    subscriptionLineItemId: $subscriptionLineItemId
    description: $description
    price: $price
    idempotencyKey: $idempotencyKey
  ) {
    userErrors { field message }
    appUsageRecord { id createdAt price { amount currencyCode } }
  }
}`;

async function recordCommission(shop, { actionId, attributedRevenue, currency, description, orderId }) {
  await ensureTable();
  const revenue = Number(attributedRevenue) || 0;
  if (revenue <= 0) return { ok: false, skipped: 'no_revenue' };

  const amount = Math.round(revenue * COMMISSION_RATE * 100) / 100;
  if (amount <= 0) return { ok: false, skipped: 'amount_rounds_to_zero' };

  const idempotencyKey = `advisor-${shop}-action-${actionId}`;

  // Claim the charge locally FIRST, so two concurrent runs cannot both call
  // Shopify for the same sale.
  //
  // The claim used to be INSERT ... DO NOTHING, which made the FIRST attempt the
  // ONLY attempt. Everything after the claim can fail for reasons that are
  // temporary and not this sale's fault — the merchant had not approved the
  // subscription yet, the monthly cap was full, Shopify timed out — and every
  // one of those left a row that nothing would ever look at again. Money earned,
  // never invoiced.
  //
  // So the conflict path now reclaims a row that is retryable and cooled off.
  // Retrying is safe in the one place it matters: the idempotency key we send to
  // Shopify is derived from the action id and never changes, so if an earlier
  // attempt did reach Shopify, the retry returns that same usage record instead
  // of creating a second one.
  const claim = await db.query(
    `INSERT INTO app_usage_charges
       (shop_domain, action_id, order_id, idempotency_key, amount, currency, attributed_revenue, status, attempts, last_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',1,NOW())
     ON CONFLICT (idempotency_key) DO UPDATE
        SET status='pending',
            attempts = app_usage_charges.attempts + 1,
            last_attempt_at = NOW(),
            amount = EXCLUDED.amount,
            currency = EXCLUDED.currency,
            attributed_revenue = EXCLUDED.attributed_revenue,
            order_id = COALESCE(EXCLUDED.order_id, app_usage_charges.order_id)
      WHERE app_usage_charges.status <> ALL($8::text[])
        AND app_usage_charges.attempts < $9
        AND (app_usage_charges.last_attempt_at IS NULL
             OR app_usage_charges.last_attempt_at < NOW() - ($10 || ' minutes')::interval)
     RETURNING id, attempts`,
    [shop, actionId || null, orderId ? String(orderId) : null, idempotencyKey, amount,
     currency || 'USD', revenue, TERMINAL, MAX_ATTEMPTS, String(RETRY_AFTER_MIN)]
  ).catch(e => { console.error('[billing] claim:', e.message); return { rows: [] }; });

  if (!claim.rows[0]) {
    // Nothing to do — but WHY matters, because "already paid" and "gave up
    // after eight tries" are very different things to a merchant reading the
    // billing screen.
    const cur = await db.query(
      `SELECT status, attempts FROM app_usage_charges WHERE idempotency_key=$1`, [idempotencyKey]
    ).catch(() => ({ rows: [] }));
    const row = cur.rows[0] || {};
    if (row.status === 'charged') return { ok: false, skipped: 'already_billed', idempotencyKey };
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.query(`UPDATE app_usage_charges SET status='abandoned' WHERE idempotency_key=$1 AND status <> 'charged'`,
        [idempotencyKey]).catch(() => {});
      console.error(`[billing] giving up on action ${actionId} for ${shop} after ${row.attempts} attempts`);
      return { ok: false, skipped: 'max_attempts', attempts: row.attempts };
    }
    return { ok: false, skipped: row.status ? 'cooling_off' : 'already_billed', status: row.status, idempotencyKey };
  }
  const chargeId = claim.rows[0].id;

  const sub = await getSubscription(shop);
  if (!sub.active || !sub.line_item_gid) {
    await db.query(`UPDATE app_usage_charges SET status='no_subscription' WHERE id=$1`, [chargeId]).catch(() => {});
    return { ok: false, skipped: 'no_active_subscription' };
  }
  // Refuse rather than let Shopify reject it: past the cap the merchant has to
  // agree to a higher one, and silently failing charges is worse than saying so.
  if (sub.remaining != null && amount > sub.remaining) {
    await db.query(`UPDATE app_usage_charges SET status='over_cap' WHERE id=$1`, [chargeId]).catch(() => {});
    return { ok: false, skipped: 'over_capped_amount', remaining: sub.remaining, needed: amount };
  }

  try {
    const data = await graphql(shop, CREATE_USAGE, {
      subscriptionLineItemId: sub.line_item_gid,
      description: description || `${Math.round(COMMISSION_RATE * 100)}% of ${revenue} ${sub.currency || currency || 'USD'} in attributed sales`,
      price: { amount: amount.toFixed(2), currencyCode: sub.currency || currency || 'USD' },
      idempotencyKey
    });
    const r = data && data.appUsageRecordCreate;
    if (r && r.userErrors && r.userErrors.length) throw new Error(r.userErrors.map(e => e.message).join('; '));
    const rec = (r && r.appUsageRecord) || {};
    await db.query(`UPDATE app_usage_charges SET status='charged', usage_record_gid=$2 WHERE id=$1`,
      [chargeId, rec.id || null]).catch(() => {});
    console.log(`💰 [billing] ${shop} charged ${amount} for action ${actionId}`);
    return { ok: true, amount, usage_record_gid: rec.id, idempotencyKey };
  } catch (e) {
    await db.query(`UPDATE app_usage_charges SET status='failed', error=$2 WHERE id=$1`,
      [chargeId, String(e.message).slice(0, 300)]).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 4. THE SWEEP. Find sales we credited but never billed, and bill them.
//
// This is what actually collects. It is driven off advisor_actions rather than
// off whichever function happened to close the sale, so it does not care
// whether the webhook or the 5-minute scan got there first — the thing it looks
// for is the state both of them leave behind.
//
// It is also where a sale is checked for being real money before we take a
// commission on it. Attribution credits an order the moment it is placed, which
// is right for the merchant's dashboard, but an order can be unpaid (cash on
// delivery, bank transfer), cancelled an hour later, or refunded. Charging 5%
// of a sale the merchant never received is the fastest way to lose them, so:
//
//   unpaid            -> leave it; a later sweep will pick it up once it clears
//   cancelled/voided  -> reverse the credit, never bill
//   fully refunded    -> reverse the credit, never bill
//   partly refunded   -> bill the net, and correct the credited revenue too
//   paid              -> bill it
// ---------------------------------------------------------------------------
const SWEEP_BATCH = 40;
const SWEEP_LOOKBACK_DAYS = 30;
// How long to leave an order alone after finding it not yet payable.
//
// Without this the sweep starves itself: candidates come out oldest-first, and
// an order that cannot be billed yet (cash on delivery, bank transfer, or one
// Shopify would not return) stays at the head of the queue for the full 30-day
// window. Forty such orders would fill every batch forever and no NEW sale
// would ever be billed. Marking them and skipping them for a few hours keeps
// the queue moving while still coming back to them.
const RECHECK_UNPAID_HOURS = 6;

function orderMoneyState(order) {
  if (!order) return { state: 'unknown' };
  if (order.cancelled_at) return { state: 'void', why: 'cancelled' };
  const fs = String(order.financial_status || '').toLowerCase();
  if (fs === 'refunded' || fs === 'voided') return { state: 'void', why: fs };
  if (fs === 'paid' || fs === 'partially_paid' || fs === 'partially_refunded') {
    // current_total_price is the order total net of refunds. On an untouched
    // order it equals total_price; after a partial refund it is what the
    // merchant actually kept, which is the only honest base for a commission.
    const net = parseFloat(order.current_total_price != null ? order.current_total_price : order.total_price);
    return { state: 'payable', net: isFinite(net) && net > 0 ? net : 0, currency: order.currency || null };
  }
  return { state: 'unpaid', why: fs || 'pending' };
}

async function sweepUnbilled(shop) {
  await ensureTable();
  if (!shopify.hasTokenForShop(shop)) return { ok: false, reason: 'no_token' };

  let due;
  try {
    due = await db.query(
      `SELECT a.id, a.attributed_revenue, a.converting_order_id
         FROM advisor_actions a
         LEFT JOIN app_usage_charges c
           ON c.shop_domain = a.shop_domain AND c.action_id = a.id
        WHERE a.shop_domain = $1
          AND a.outcome = 'converted'
          AND a.attributed_revenue > 0
          AND a.closed_at > NOW() - ($3 || ' days')::interval
          AND (c.id IS NULL OR (
                c.status <> ALL($2::text[])
            AND (c.status <> 'awaiting_payment'
                 OR c.last_attempt_at IS NULL
                 OR c.last_attempt_at < NOW() - ($4 || ' hours')::interval)))
        ORDER BY a.closed_at ASC
        FETCH FIRST ${SWEEP_BATCH} ROWS ONLY`,
      [shop, TERMINAL, String(SWEEP_LOOKBACK_DAYS), String(RECHECK_UNPAID_HOURS)]);
  } catch (e) {
    console.error('[billing] sweep query:', e.message);
    return { ok: false, error: e.message };
  }

  let billed = 0, amount = 0, reversed = 0, waiting = 0, failed = 0;
  for (const row of due.rows) {
    try {
      // Ask Shopify what the order is worth NOW, not what it was worth when it
      // was placed. This is the only way a refund issued after attribution can
      // stop us billing for it.
      let order = null;
      if (row.converting_order_id) {
        const d = await shopify.shopifyGet(shop, `orders/${encodeURIComponent(row.converting_order_id)}.json`)
          .catch(() => null);
        order = (d && d.order) || null;
      }
      // No order id (legacy rows) or Shopify would not answer: skip rather than
      // bill blind. It stays in the queue, but marked, so it does not block the
      // sales behind it.
      if (!order) { await markAwaitingPayment(shop, row, 'order_not_readable'); waiting++; continue; }

      const money = orderMoneyState(order);

      if (money.state === 'void') {
        await reverseAction(shop, row.id, money.why);
        reversed++;
        continue;
      }
      if (money.state !== 'payable') {
        await markAwaitingPayment(shop, row, money.why || 'unpaid');
        waiting++;
        continue;
      }

      // Bill the net, never more than what was credited.
      const billable = Math.min(Number(row.attributed_revenue) || 0, money.net);
      if (billable <= 0) { await reverseAction(shop, row.id, 'refunded_to_zero'); reversed++; continue; }

      // A partial refund also makes the credited figure wrong on the merchant's
      // dashboard. Correct it, so the number they are billed 5% of is the number
      // they see.
      if (billable < Number(row.attributed_revenue) - 0.005) {
        await db.query(`UPDATE advisor_actions SET attributed_revenue=$2 WHERE id=$1 AND shop_domain=$3`,
          [row.id, billable, shop]).catch(() => {});
      }

      const res = await recordCommission(shop, {
        actionId: row.id,
        attributedRevenue: billable,
        currency: money.currency,
        orderId: row.converting_order_id,
        description: `${Math.round(COMMISSION_RATE * 100)}% of an attributed sale (order ${order.name || row.converting_order_id})`
      });
      if (res.ok) { billed++; amount += res.amount || 0; }
      else if (res.skipped === 'already_billed' || res.skipped === 'cooling_off') { /* nothing to say */ }
      else { failed++; console.log(`[billing] action ${row.id} not charged: ${res.skipped || res.error}`); }
    } catch (e) {
      failed++;
      console.error('[billing] sweep item', row.id, e.message);
    }
  }

  if (billed || reversed || failed) {
    console.log(`💳 [billing] ${shop}: billed ${billed} (${amount.toFixed(2)}), reversed ${reversed}, waiting ${waiting}, failed ${failed}`);
  }
  return { ok: true, considered: due.rows.length, billed, amount: Math.round(amount * 100) / 100, reversed, waiting, failed };
}

// Note that this sale is real but not yet collectable, and when we last looked.
// Not a terminal state: recordCommission will happily reclaim the row once the
// money arrives, because 'awaiting_payment' is not in TERMINAL.
async function markAwaitingPayment(shop, row, why) {
  await db.query(
    `INSERT INTO app_usage_charges
       (shop_domain, action_id, order_id, idempotency_key, amount, currency, attributed_revenue,
        status, attempts, last_attempt_at, error)
     VALUES ($1,$2,$3,$4,0,NULL,$5,'awaiting_payment',0,NOW(),$6)
     ON CONFLICT (idempotency_key) DO UPDATE
        SET status='awaiting_payment', last_attempt_at=NOW(), error=$6
      WHERE app_usage_charges.status <> ALL($7::text[])`,
    [shop, row.id, row.converting_order_id ? String(row.converting_order_id) : null,
     `advisor-${shop}-action-${row.id}`, row.attributed_revenue, String(why).slice(0, 200), TERMINAL]
  ).catch(e => console.error('[billing] markAwaitingPayment:', e.message));
}

// Un-credit a sale that turned out not to be one. The action drops out of every
// revenue figure in the app, because they all filter on outcome='converted'.
// If we had already billed for it, say so loudly — a usage record cannot be
// withdrawn through the API, so that is a credit we owe the merchant.
async function reverseAction(shop, actionId, why) {
  await db.query(
    `UPDATE advisor_actions
        SET outcome = 'reversed',
            details = COALESCE(details,'{}'::jsonb) || jsonb_build_object('reversed', $3::text)
      WHERE id = $1 AND shop_domain = $2 AND outcome = 'converted'`,
    [actionId, shop, String(why || 'void')]).catch(e => console.error('[billing] reverse:', e.message));

  const charged = await db.query(
    `SELECT id, amount FROM app_usage_charges WHERE shop_domain=$1 AND action_id=$2 AND status='charged'`,
    [shop, actionId]).catch(() => ({ rows: [] }));
  if (charged.rows[0]) {
    console.error(`⚠️  [billing] ${shop} was charged ${charged.rows[0].amount} for action ${actionId}, which is now ${why}. Credit owed.`);
    await db.query(
      `INSERT INTO app_usage_charges (shop_domain, action_id, idempotency_key, amount, currency, status)
       SELECT shop_domain, action_id, idempotency_key || '-credit', -amount, currency, 'credit_owed'
         FROM app_usage_charges WHERE id=$1
       ON CONFLICT (idempotency_key) DO NOTHING`, [charged.rows[0].id]).catch(() => {});
  } else {
    // Not billed yet, and now never will be.
    await db.query(
      `INSERT INTO app_usage_charges (shop_domain, action_id, idempotency_key, amount, currency, status)
       VALUES ($1,$2,$3,0,NULL,'void_order')
       ON CONFLICT (idempotency_key) DO UPDATE SET status='void_order'
        WHERE app_usage_charges.status <> 'charged'`,
      [shop, actionId, `advisor-${shop}-action-${actionId}`]).catch(() => {});
  }
}

// Sweep every shop that has a token. Called on a timer by the server.
async function sweepAll(shops) {
  const out = [];
  for (const shop of shops || []) {
    try { out.push({ shop, ...(await sweepUnbilled(shop)) }); }
    catch (e) { out.push({ shop, ok: false, error: e.message }); }
  }
  return out;
}

// What has this shop been charged? Shown in the app so billing is never a
// surprise — the merchant can reconcile every charge against an attributed sale.
async function charges(shop, limit = 50) {
  await ensureTable();
  const r = await db.query(
    `SELECT action_id, amount, currency, attributed_revenue, status, created_at
       FROM app_usage_charges WHERE shop_domain=$1
      ORDER BY created_at DESC FETCH FIRST ${parseInt(limit)} ROWS ONLY`, [shop]
  ).catch(() => ({ rows: [] }));
  const totals = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status='charged'),0)::numeric AS billed,
            COUNT(*) FILTER (WHERE status='charged')::int AS n_charged,
            COUNT(*) FILTER (WHERE status='over_cap')::int AS n_over_cap,
            COUNT(*) FILTER (WHERE status='failed')::int AS n_failed,
            COUNT(*) FILTER (WHERE status='abandoned')::int AS n_abandoned,
            COUNT(*) FILTER (WHERE status='void_order')::int AS n_void,
            COALESCE(SUM(-amount) FILTER (WHERE status='credit_owed'),0)::numeric AS credit_owed
       FROM app_usage_charges WHERE shop_domain=$1`, [shop]
  ).catch(() => ({ rows: [{}] }));
  return { ok: true, charges: r.rows, totals: totals.rows[0] || {} };
}

module.exports = {
  ensureTable, startSubscription, getSubscription, recordCommission, charges, graphql,
  sweepUnbilled, sweepAll, reverseAction, isTestStore, orderMoneyState, publicBase,
  COMMISSION_RATE, DEFAULT_CAPPED_AMOUNT, TRIAL_DAYS, MAX_ATTEMPTS, RETRY_AFTER_MIN, TERMINAL
};
