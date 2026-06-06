// insights-engine.js - Proactive Insights Engine for the AI Chief of Staff
// Scans the shop's data daily and surfaces actionable OPPORTUNITIES
// (not just data the merchant already sees in Shopify).
//
// Each detector returns an array of "insight" objects:
//   { type, priority, title, detail, action_hint, data }
// These are later phrased into human Hebrew by the AI and shown on chat open.
//
// All detectors are wrapped so one failure never breaks the others.

const db = require('./database');

// ---------- helper: run a detector safely ----------
async function runDetector(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[insights] ${label} failed:`, err.message);
    return [];
  }
}

// ---------- 1. VIP customers who went quiet ----------
// A VIP (high lifetime spend) whose last order is far past their usual rhythm.
// We approximate "usual rhythm": if they have many orders but haven't bought in 45+ days.
async function detectDormantVIPs(shop) {
  return runDetector('dormantVIPs', async () => {
    const r = await db.query(
      `SELECT first_name, last_name, email, phone,
              total_spent, orders_count, last_order_date,
              EXTRACT(DAY FROM (NOW() - last_order_date))::int AS days_since
       FROM store_customers
       WHERE shop_domain = $1
         AND total_spent > 1500
         AND orders_count >= 2
         AND last_order_date IS NOT NULL
         AND last_order_date < NOW() - INTERVAL '45 days'
       ORDER BY total_spent DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => ({
      type: 'dormant_vip',
      priority: 1,
      title: `לקוחה VIP שנעלמה: ${(c.first_name || '') + ' ' + (c.last_name || '')}`.trim(),
      detail: `הוציאה ${Math.round(c.total_spent).toLocaleString()}₪ ב-${c.orders_count} הזמנות, אבל לא קנתה כבר ${c.days_since} ימים.`,
      action_hint: 'send_winback',
      data: {
        name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
        email: c.email, phone: c.phone,
        total_spent: Math.round(c.total_spent),
        orders_count: c.orders_count,
        days_since: c.days_since
      }
    }));
  });
}

// ---------- 2. Fast-selling product running low on stock ----------
// Sold well in the last 30 days but inventory is now low -> reorder before stockout.
async function detectLowStockBestsellers(shop) {
  return runDetector('lowStockBestsellers', async () => {
    const r = await db.query(
      `WITH recent_sales AS (
         SELECT oi.shopify_product_id,
                SUM(oi.quantity)::int AS units_sold
         FROM store_order_items oi
         JOIN store_orders o
           ON o.shop_domain = oi.shop_domain
          AND o.shopify_order_id = oi.shopify_order_id
         WHERE oi.shop_domain = $1
           AND o.ordered_at >= NOW() - INTERVAL '30 days'
           AND oi.shopify_product_id IS NOT NULL
         GROUP BY oi.shopify_product_id
       )
       SELECT p.title, p.total_inventory, p.handle,
              rs.units_sold
       FROM recent_sales rs
       JOIN store_products p
         ON p.shop_domain = $1
        AND p.shopify_product_id = rs.shopify_product_id
       WHERE p.available = TRUE
         AND p.total_inventory > 0
         AND p.total_inventory <= 5
         AND rs.units_sold >= 3
       ORDER BY rs.units_sold DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(p => ({
      type: 'low_stock_bestseller',
      priority: 2,
      title: `מוצר חם עומד להיגמר: ${p.title}`,
      detail: `נמכרו ${p.units_sold} יחידות ב-30 יום, נשארו רק ${p.total_inventory} במלאי. שווה להזמין לפני שייגמר.`,
      action_hint: 'reorder',
      data: {
        title: p.title, units_sold: p.units_sold,
        inventory: p.total_inventory, handle: p.handle
      }
    }));
  });
}

// ---------- 3. High-value abandoned carts from recent days ----------
async function detectHighValueAbandoned(shop) {
  return runDetector('highValueAbandoned', async () => {
    const r = await db.query(
      `SELECT email, phone, total_price, item_count,
              abandoned_checkout_url, line_items,
              EXTRACT(DAY FROM (NOW() - shopify_created_at))::int AS days_ago
       FROM abandoned_checkouts
       WHERE shop_domain = $1
         AND completed_at IS NULL
         AND email IS NOT NULL AND email <> ''
         AND total_price >= 400
         AND shopify_created_at >= NOW() - INTERVAL '7 days'
       ORDER BY total_price DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => ({
      type: 'high_value_abandoned',
      priority: 3,
      title: `עגלה נטושה בערך גבוה: ${Math.round(c.total_price).toLocaleString()}₪`,
      detail: `לקוחה השאירה ${c.item_count} פריטים בשווי ${Math.round(c.total_price).toLocaleString()}₪ לפני ${c.days_ago} ימים. יש אימייל - אפשר לפנות.`,
      action_hint: 'recover_cart',
      data: {
        email: c.email, phone: c.phone,
        total: Math.round(c.total_price),
        item_count: c.item_count,
        recovery_url: c.abandoned_checkout_url,
        days_ago: c.days_ago
      }
    }));
  });
}

// ---------- 4. Sharp sales change vs previous week ----------
async function detectSalesShift(shop) {
  return runDetector('salesShift', async () => {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(total_price) FILTER (
           WHERE ordered_at >= NOW() - INTERVAL '7 days'), 0)::numeric(12,2) AS this_week,
         COALESCE(SUM(total_price) FILTER (
           WHERE ordered_at >= NOW() - INTERVAL '14 days'
             AND ordered_at < NOW() - INTERVAL '7 days'), 0)::numeric(12,2) AS last_week
       FROM store_orders
       WHERE shop_domain = $1
         AND financial_status NOT IN ('voided','refunded')`,
      [shop]
    );
    const row = r.rows[0] || {};
    const thisWeek = parseFloat(row.this_week || 0);
    const lastWeek = parseFloat(row.last_week || 0);
    if (lastWeek < 100) return []; // not enough base to compare

    const pctChange = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
    if (Math.abs(pctChange) < 20) return []; // only flag meaningful shifts

    const up = pctChange > 0;
    return [{
      type: 'sales_shift',
      priority: 4,
      title: up ? `המכירות עלו ${pctChange}% השבוע 📈` : `המכירות ירדו ${Math.abs(pctChange)}% השבוע 📉`,
      detail: up
        ? `השבוע ${Math.round(thisWeek).toLocaleString()}₪ מול ${Math.round(lastWeek).toLocaleString()}₪ בשבוע שעבר. שווה להבין מה עבד ולחזק.`
        : `השבוע ${Math.round(thisWeek).toLocaleString()}₪ מול ${Math.round(lastWeek).toLocaleString()}₪ בשבוע שעבר. שווה לבדוק מה השתנה.`,
      action_hint: up ? 'investigate_growth' : 'investigate_drop',
      data: { this_week: Math.round(thisWeek), last_week: Math.round(lastWeek), pct_change: pctChange }
    }];
  });
}

// ---------- Main entry: gather all insights ----------
async function getInsights(shop) {
  const [vips, lowStock, abandoned, shift] = await Promise.all([
    detectDormantVIPs(shop),
    detectLowStockBestsellers(shop),
    detectHighValueAbandoned(shop),
    detectSalesShift(shop)
  ]);

  // Merge, sort by priority (1 = most important), cap to top 6.
  const all = [...vips, ...lowStock, ...abandoned, ...shift]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 6);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    count: all.length,
    insights: all
  };
}

module.exports = {
  getInsights,
  detectDormantVIPs,
  detectLowStockBestsellers,
  detectHighValueAbandoned,
  detectSalesShift
};