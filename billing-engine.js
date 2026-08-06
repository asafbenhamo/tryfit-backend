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
// ============================================================================

const db = require('./database');
const shopify = require('./shopify-client');

const API_VERSION = '2026-01';

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
  await db.query(`CREATE INDEX IF NOT EXISTS idx_usage_shop ON app_usage_charges(shop_domain, created_at DESC)`).catch(() => {});
  tableReady = true;
}

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

async function startSubscription(shop, opts = {}) {
  await ensureTable();
  const cap = Number(opts.cappedAmount || DEFAULT_CAPPED_AMOUNT);
  const currency = String(opts.currency || 'USD').toUpperCase();
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const returnUrl = `${base}/billing/confirmed?shop=${encodeURIComponent(shop)}`;
  // Shopify shows these terms on the approval screen. They must describe the
  // charge honestly — this is what the merchant is agreeing to.
  const terms = `${Math.round(COMMISSION_RATE * 100)}% of sales the agent is proven to have generated (a redeemed coupon, an agent-built cart, or a tracked click followed by a purchase). No charge for sales it cannot prove. Capped at ${cap} ${currency} per 30 days.`;

  const data = await graphql(shop, CREATE_SUBSCRIPTION, {
    name: 'Smart Advisor — performance pricing',
    returnUrl,
    trialDays: opts.trialDays != null ? Number(opts.trialDays) : TRIAL_DAYS,
    // A development store cannot be charged for real; test charges let the whole
    // flow be exercised end to end without money moving.
    test: opts.test === true,
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

async function recordCommission(shop, { actionId, attributedRevenue, currency, description }) {
  await ensureTable();
  const revenue = Number(attributedRevenue) || 0;
  if (revenue <= 0) return { ok: false, skipped: 'no_revenue' };

  const amount = Math.round(revenue * COMMISSION_RATE * 100) / 100;
  if (amount <= 0) return { ok: false, skipped: 'amount_rounds_to_zero' };

  const idempotencyKey = `advisor-${shop}-action-${actionId}`;

  // Claim the charge locally FIRST. If this insert conflicts, some other run
  // already billed this sale and we must not call Shopify again.
  const claim = await db.query(
    `INSERT INTO app_usage_charges (shop_domain, action_id, idempotency_key, amount, currency, attributed_revenue, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [shop, actionId || null, idempotencyKey, amount, currency || 'USD', revenue]
  ).catch(e => { console.error('[billing] claim:', e.message); return { rows: [] }; });

  if (!claim.rows[0]) return { ok: false, skipped: 'already_billed', idempotencyKey };
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
            COUNT(*) FILTER (WHERE status='failed')::int AS n_failed
       FROM app_usage_charges WHERE shop_domain=$1`, [shop]
  ).catch(() => ({ rows: [{}] }));
  return { ok: true, charges: r.rows, totals: totals.rows[0] || {} };
}

module.exports = {
  ensureTable, startSubscription, getSubscription, recordCommission, charges, graphql,
  COMMISSION_RATE, DEFAULT_CAPPED_AMOUNT, TRIAL_DAYS
};
