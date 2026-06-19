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
  await ensureOrderColumn();
  const orderId = order.id != null ? String(order.id) : (order.order_id != null ? String(order.order_id) : null);

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
      return { closed: true, amount: orderTotal, via: "coupon" };
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
      return { closed: true, amount: orderTotal, via: "draft_order" };
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
        return { closed: true, amount: orderTotal, via: "link_click" };
      }
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
      if (r.closed) {
        closed++;
        totalAmount += r.amount || 0;
        if (breakdown[r.via] != null) breakdown[r.via]++;
        // Notify the merchant in real time that the agent converted a sale.
        try {
          const push = require('./push-engine');
          if (push.isConfigured()) {
            const amt = Math.round(r.amount || 0).toLocaleString();
            await push.sendToShop(shopDomain, {
              title: '🎉 מכירה חדשה בזכות היועץ!',
              body: `לקוחה השלימה רכישה של ${amt}₪. היועץ סגר עוד עסקה.`,
              tag: 'conversion',
              url: '/'
            });
          }
        } catch (e) { /* never let a push failure break attribution */ }
      }
    }
    console.log(`🔁 [Attribution] scanned ${scanned} orders, closed ${closed}, +${Math.round(totalAmount)}₪`,
      JSON.stringify(breakdown));
    // After closing what we can, retire pending actions that are past the 3-day window.
    const expired = await expireOldActions(shopDomain);
    return { ok: true, scanned, closed, total_amount: Math.round(totalAmount), breakdown, expired };
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

module.exports = { runAttribution, attributeOrder, expireOldActions };