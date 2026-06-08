// ======================
// ATTRIBUTION ENGINE
// ----------------------
// Closes the loop on advisor actions by PULLING recent orders from Shopify,
// instead of relying on the orders/create webhook (which can fail on HMAC).
//
// For each recent order it tries, in order, to mark exactly ONE pending advisor
// action as converted (no double-counting — stops at the first tier that matches):
//   1. by coupon code   (certain - the customer used a code the advisor created)
//   2. by draft order    (personalized cart the advisor built)
//   3. by phone/email within 3 days of being contacted
//   4. by customer NAME within 3 days (last resort; name is not unique)
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
async function attributeOrder(shopDomain, order) {
  const orderTotal = parseFloat(order.total_price || order.current_total_price || 0);
  const buyerEmail = (order.email || (order.customer && order.customer.email) || "").toLowerCase() || null;
  const buyerPhone = digits(order.phone || (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone)) || null;
  const buyerName = buildBuyerName(order);

  // --- Tier 1: by coupon code ---
  const codes = (order.discount_codes || []).map(d => (d.code || "").toUpperCase()).filter(Boolean);
  for (const code of codes) {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $3, closed_at = NOW(),
           details = details || '{"attribution":"coupon"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1 AND coupon_code = $2 AND outcome = 'pending'
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, code, orderTotal]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - coupon] ${code} +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "coupon" };
    }
  }

  // --- Tier 2: by draft order (personalized cart) ---
  if (order.source_name === "draft_order") {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $4, closed_at = NOW(),
           details = details || '{"attribution":"draft_order"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1 AND action_type = 'personalized_cart' AND outcome = 'pending'
           AND ( ($2::text IS NOT NULL AND lower(target_email) = $2)
              OR ($3::text IS NOT NULL AND regexp_replace(target_phone,'[^0-9]','','g') = $3) )
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, buyerEmail, buyerPhone, orderTotal]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - draft cart] +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "draft_order" };
    }
  }

  // --- Tier 3: by phone/email within 3 days ---
  if (buyerEmail || buyerPhone) {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $4, closed_at = NOW(),
           details = details || '{"attribution":"time_window_3d"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1
           AND outcome = 'pending'
           AND created_at >= NOW() - INTERVAL '3 days'
           AND ( ($2::text IS NOT NULL AND lower(target_email) = $2)
              OR ($3::text IS NOT NULL AND regexp_replace(target_phone,'[^0-9]','','g') = $3) )
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, buyerEmail, buyerPhone, orderTotal]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - 3day phone/email] ${buyerEmail || buyerPhone} +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "time_window_3d" };
    }
  }

  // --- Tier 4: by customer NAME within 3 days (last resort) ---
  if (buyerName) {
    const r = await db.query(
      `UPDATE advisor_actions
       SET outcome = 'converted', attributed_revenue = $3, closed_at = NOW(),
           details = details || '{"attribution":"name_window_3d"}'::jsonb
       WHERE id = (
         SELECT id FROM advisor_actions
         WHERE shop_domain = $1
           AND outcome = 'pending'
           AND created_at >= NOW() - INTERVAL '3 days'
           AND lower(btrim(details->>'customer_name')) = $2
         ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY
       )
       RETURNING id`,
      [shopDomain, buyerName, orderTotal]
    );
    if (r.rows.length > 0) {
      console.log(`💰 [Attribution - name 3day] "${buyerName}" +${orderTotal}₪ (action ${r.rows[0].id})`);
      return { closed: true, amount: orderTotal, via: "name_window_3d" };
    }
  }

  return { closed: false };
}

// Pull recent orders from Shopify and run attribution on each.
async function runAttribution(shopDomain = SHOP) {
  if (!shopify.hasTokenForShop(shopDomain)) {
    return { ok: false, reason: "no_token" };
  }
  const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let scanned = 0, closed = 0, totalAmount = 0;
  const breakdown = { coupon: 0, draft_order: 0, time_window_3d: 0, name_window_3d: 0 };

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
      if (r.closed) {
        closed++;
        totalAmount += r.amount || 0;
        if (breakdown[r.via] != null) breakdown[r.via]++;
      }
    }
    console.log(`🔁 [Attribution] scanned ${scanned} orders, closed ${closed}, +${Math.round(totalAmount)}₪`,
      JSON.stringify(breakdown));
    return { ok: true, scanned, closed, total_amount: Math.round(totalAmount), breakdown };
  } catch (err) {
    console.error("⚠️  [Attribution] run failed:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { runAttribution, attributeOrder };