// ======================
// ATTRIBUTION ENGINE
// ----------------------
// Closes the loop on advisor actions by PULLING recent orders from Shopify,
// instead of relying on the orders/create webhook (which can fail on HMAC).
//
// For each recent order it tries, in order, to mark exactly ONE pending advisor
// action as converted (no double-counting — stops at the first tier that matches):
//   1. by coupon code  — she redeemed a code this agent created for her
//   2. by draft order  — the order came from a cart this agent built
//   3. by link click   — she clicked our tracked link, then bought within 3 days
//                        OF THAT CLICK
//
// There is deliberately no time-window tier ("bought within N days of any
// message") and no name matching. Both were removed: they credit the agent for
// sales it had nothing to do with, and this number is what the merchant is
// billed 5% of. An unprovable sale is worth less to us than a merchant who
// stops believing the dashboard. Keep this list and the code in step — the
// header once described two tiers that no longer existed.
//
// Idempotent: only acts on actions still in outcome='pending', so the same order
// is never counted twice across runs.
// ======================

const db = require("./database");
const shopify = require("./shopify-client");

const SHOP = "seven770.myshopify.com";

// Pull orders updated in the last N days (matches the 3-day attribution window,
// with a small buffer so nothing is missed between runs).
const LOOKBACK_DAYS = 4;

function digits(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}

// Make sure we have a column recording WHICH order closed each action. This is how
// we guarantee a single order can never be credited to more than one action (e.g.
// when the merchant sent the same customer two different coupons by email + WhatsApp).
let _colReady = false;
async function ensureOrderColumn() {
  if (_colReady) return;
  await db.query(`ALTER TABLE advisor_actions ADD COLUMN IF NOT EXISTS converting_order_id TEXT`).catch(()=>{});
  // Try to enforce uniqueness, but don't crash if legacy duplicate rows exist —
  // the upfront orderAlreadyCredited() guard already prevents new double-counts.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_converting_order
                  ON advisor_actions (shop_domain, converting_order_id)
                  WHERE converting_order_id IS NOT NULL`)
    .catch(e => console.warn('[attribution] unique index not created (likely legacy dupes):', e.message));
  _colReady = true;
}

// Has this specific order already been credited to some action? If so, we must not
// credit it again — this is the core guard against double-counting one sale.
async function orderAlreadyCredited(shopDomain, orderId) {
  if (!orderId) return false;
  const r = await db.query(
    `SELECT 1 FROM advisor_actions
     WHERE shop_domain = $1 AND converting_order_id = $2 FETCH FIRST 1 ROWS ONLY`,
    [shopDomain, String(orderId)]
  );
  return r.rows.length > 0;
}

// Has this order stopped being a sale? A cancelled or fully refunded order is
// money the merchant does not have, and it must not sit in their dashboard as
// revenue the agent earned — nor be billed 5% of.
function voidReason(order) {
  if (order.cancelled_at) return 'cancelled';
  const fs = String(order.financial_status || '').toLowerCase();
  if (fs === 'refunded' || fs === 'voided') return fs;
  return null;
}

// Take back a credit. Delegated to billing-engine because the interesting half
// is the billing side — whether we already charged for it, and therefore
// whether we now owe the merchant a credit.
async function reverseCredit(shopDomain, orderId, why) {
  try {
    const r = await db.query(
      `SELECT id FROM advisor_actions
        WHERE shop_domain=$1 AND converting_order_id=$2 AND outcome='converted'`,
      [shopDomain, String(orderId)]);
    if (!r.rows.length) return 0;
    const billing = require('./billing-engine');
    for (const row of r.rows) await billing.reverseAction(shopDomain, row.id, why);
    return r.rows.length;
  } catch (e) {
    console.error('[attribution] reverseCredit:', e.message);
    return 0;
  }
}

function buildBuyerName(order) {
  const name = (
    (order.customer ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim() : "") ||
    (order.shipping_address && order.shipping_address.name) ||
    (order.billing_address && order.billing_address.name) ||
    ""
  );
  return name.trim().toLowerCase() || null;
}

// Try to close exactly one pending action for a single order.
// Returns { closed: bool, amount, via } describing what happened.
//
// This function CREDITS. It does not bill. Billing is a separate sweep
// (billing-engine.sweepUnbilled) that runs off the state this leaves behind —
// see the long note at the top of billing-engine.js for why the two were split.
async function attributeOrder(shopDomain, order) {
  await ensureOrderColumn();
  const orderId = order.id != null ? String(order.id) : (order.order_id != null ? String(order.order_id) : null);

  // An order can stop being a sale after we credited it. The 5-minute scan uses
  // updated_at_min, so a cancellation or a refund brings the order back through
  // here — which makes this the natural place to take the credit back.
  if (orderId) {
    const void_ = voidReason(order);
    if (void_) {
      const undone = await reverseCredit(shopDomain, orderId, void_);
      if (undone) console.log(`↩️  [Attribution] order ${orderId} ${void_} — credit reversed`);
      return { closed: false, voided: void_, reversed: undone };
    }
  }

  // GUARD: if this exact order already credited an action, never credit it again.
  // This stops one sale from being counted twice when the same customer got two
  // different coupons (e.g. one by email and one by WhatsApp).
  if (orderId && await orderAlreadyCredited(shopDomain, orderId)) {
    return { closed: false, alreadyCredited: true };
  }

  const orderTotal = parseFloat(order.total_price || order.current_total_price || 0);
  const buyerEmail = (order.email || (order.customer && order.customer.email) || "").toLowerCase() || null;
  const buyerPhone = digits(order.phone || (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone)) || null;
  const buyerName = buildBuyerName(order);
  // When the order was placed. Time-window tiers must only credit the advisor if
  // the order happened AFTER the advisor reached out — never before.
  const orderCreatedAt = order.created_at || order.processed_at || null;

  // --- Tier 1: by coupon code ---
  const codes = (order.discount_codes || []).map(d => (d.code || "").toUpperCase()).filter(Boolean);
  for (const code of codes) {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $3, closed_at = NOW(),
           converting_order_id = $4,
           details = details || '{"attribution":"coupon"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1 AND coupon_code = $2 AND outcome = 'pending'
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, code, orderTotal, orderId]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - coupon] ${code} +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "coupon", actionId: r.rows[0].id };
    }
  }

  // --- Tier 2: by draft order (personalized cart) ---
  if (order.source_name === "draft_order") {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $4, closed_at = NOW(),
           converting_order_id = $5,
           details = details || '{"attribution":"draft_order"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1 AND action_type = 'personalized_cart' AND outcome = 'pending'
           AND ( ($2::text IS NOT NULL AND lower(target_email) = $2)
              OR ($3::text IS NOT NULL AND regexp_replace(target_phone,'[^0-9]','','g') = $3) )
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, buyerEmail, buyerPhone, orderTotal, orderId]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - draft cart] +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "draft_order", actionId: r.rows[0].id };
    }
  }

  // --- Tier 3: by phone/email, order placed within 3 days AFTER outreach ---
  // --- Tier 3 (NEW): customer CLICKED the tracking link in our message, then bought
  // within 3 days of that click. This is real, provable engagement — not a guess
  // based on time since the message. Replaces the old "bought within 3 days of any
  // message" window. ---
  if (buyerEmail || buyerPhone) {
    let click = null;
    try {
      const clickTracker = require('./click-tracker');
      click = await clickTracker.recentClickForBuyer(shopDomain, { email: buyerEmail, phone: buyerPhone }, 3);
    } catch (e) { /* click tracking is best-effort */ }

    if (click) {
      // Prefer the exact action tied to the click; otherwise fall back to a pending
      // action for this customer.
      const r = await db.query(
        `UPDATE advisor_actions
         SET outcome = 'converted', attributed_revenue = $3, closed_at = NOW(),
             converting_order_id = $4,
             details = details || '{"attribution":"link_click"}'::jsonb
         WHERE id = (
           SELECT id FROM advisor_actions
           WHERE shop_domain = $1 AND outcome = 'pending'
             AND ( ($5::bigint IS NOT NULL AND id = $5::bigint)
                OR ($2::text IS NOT NULL AND lower(target_email) = $2)
                OR ($6::text IS NOT NULL AND regexp_replace(target_phone,'[^0-9]','','g') = $6) )
           ORDER BY (id = $5::bigint) DESC, created_at DESC
           FETCH FIRST 1 ROWS ONLY
         )
         RETURNING id`,
        [shopDomain, buyerEmail, orderTotal, orderId, click.action_id || null, buyerPhone]
      );
      if (r.rows.length > 0) {
        console.log(`💰 [Attribution - link click] ${buyerEmail || buyerPhone} +${orderTotal}₪ (action ${r.rows[0].id})`);
        return { closed: true, amount: orderTotal, via: "link_click", actionId: r.rows[0].id };
      }
    }
  }

  return { closed: false };
}

// Pull recent orders from Shopify and run attribution on each.
// `shopDomain` is required in practice — the default exists only so older call
// sites keep working. Defaulting to a specific shop in a multi-tenant engine is
// a footgun: a missed argument silently attributes and BILLS against the wrong
// merchant, so callers should always pass it explicitly.
async function runAttribution(shopDomain = SHOP) {
  if (!shopDomain) return { ok: false, reason: "no_shop" };
  if (!shopify.hasTokenForShop(shopDomain)) {
    return { ok: false, reason: "no_token" };
  }
  const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let scanned = 0, closed = 0, totalAmount = 0, reversed = 0;
  const breakdown = { coupon: 0, draft_order: 0, link_click: 0 };

  try {
    // status=any so we catch paid orders regardless of fulfillment state.
    const data = await shopify.shopifyGet(
      shopDomain,
      `orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(sinceDate)}`
    );
    const orders = data.orders || [];
    for (const order of orders) {
      scanned++;
      const r = await attributeOrder(shopDomain, order);
      if (r.reversed) reversed += r.reversed;
      if (r.closed) {
        closed++;
        totalAmount += r.amount || 0;
        if (breakdown[r.via] != null) breakdown[r.via]++;

        // NOT billed here. It used to be, and that is precisely why the app
        // collected nothing: the orders/create webhook closes almost every sale
        // before this scan sees it, so this branch — the only one that billed —
        // never ran. billing-engine.sweepUnbilled() now bills off the state we
        // leave behind, whichever path wrote it.
        //
        // Notify the merchant in real time that the agent converted a sale.
        try {
          const push = require('./push-engine');
          if (push.isConfigured()) {
            // In the merchant's language and currency. This was a fixed Hebrew
            // string with a ₪ sign, pushed to the phone of every merchant on the
            // platform regardless of where they trade.
            const { st } = require('./server-i18n');
            const set = await require('./store-settings').getSettings(shopDomain).catch(() => ({}));
            const amt = (set.currency || '₪') + Math.round(r.amount || 0).toLocaleString();
            await push.sendToShop(shopDomain, {
              title: st(set.language, 'push.saleTitle'),
              body: st(set.language, 'push.saleBody', { amount: amt }),
              tag: 'conversion',
              url: '/'
            });
          }
        } catch (e) { /* never let a push failure break attribution */ }
      }
    }
    console.log(`🔁 [Attribution] scanned ${scanned} orders, closed ${closed}, reversed ${reversed}, +${Math.round(totalAmount)}₪`,
      JSON.stringify(breakdown));
    // After closing what we can, retire pending actions that are past the 3-day window.
    const expired = await expireOldActions(shopDomain);
    return { ok: true, scanned, closed, reversed, total_amount: Math.round(totalAmount), breakdown, expired };
  } catch (err) {
    console.error("⚠️  [Attribution] run failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// Mark pending actions that can no longer convert as 'expired'. An action is past
// hope once more than 3 days have elapsed since it was created (the attribution
// window has closed) — keeping it 'pending' forever would inflate the "waiting"
// count. We move it to 'expired' so the UI can show it separately as not-converted.
// Idempotent and safe: only touches outcome='pending'.
async function expireOldActions(shopDomain) {
  try {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'expired'
       WHERE shop_domain = $1
         AND outcome = 'pending'
         AND created_at < NOW() - INTERVAL '3 days'
         AND action_type NOT IN ('daily_report','morning_report')
       RETURNING id`,
      [shopDomain]
    );
    if (r.rows.length > 0) {
      console.log(`⌛ [Attribution] expired ${r.rows.length} stale pending actions (>3 days)`);
    }
    return r.rows.length;
  } catch (err) {
    console.error("⚠️  [Attribution] expireOldActions failed:", err.message);
    return 0;
  }
}

module.exports = { runAttribution, attributeOrder, expireOldActions, voidReason, reverseCredit };