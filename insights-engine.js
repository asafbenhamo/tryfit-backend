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

// How many days to rest a customer after we've contacted them (created a coupon /
// reached out), so the insights don't keep surfacing the same people every day.
const CONTACTED_COOLDOWN_DAYS = 4;

// SQL fragment: exclude customers we've already contacted in the cooldown window.
// Matches on email OR phone against advisor_actions (ignoring report rows).
// $1 must be shop_domain. Use as: AND <emailCol> NOT IN (...) style via NOT EXISTS.
function notRecentlyContacted(emailCol, phoneCol) {
  return `NOT EXISTS (
    SELECT 1 FROM advisor_actions aa
    WHERE aa.shop_domain = $1
      AND aa.action_type NOT IN ('daily_report','morning_report')
      AND aa.created_at >= NOW() - INTERVAL '${CONTACTED_COOLDOWN_DAYS} days'
      AND (
        (aa.target_email IS NOT NULL AND aa.target_email = ${emailCol}) OR
        (aa.target_phone IS NOT NULL AND aa.target_phone = ${phoneCol})
      )
  )`;
}

// SQL fragment: exclude customers who opted out of messaging (message_optouts).
// $1 must be shop_domain. emailCol/phoneCol are the columns in the outer query.
function notOptedOut(emailCol, phoneCol) {
  return `NOT EXISTS (
    SELECT 1 FROM message_optouts mo
    WHERE mo.shop_domain = $1
      AND (
        (mo.email IS NOT NULL AND mo.email <> '' AND ${emailCol} IS NOT NULL AND ${emailCol} <> ''
         AND lower(mo.email) = lower(${emailCol}))
        OR
        (mo.phone IS NOT NULL AND regexp_replace(mo.phone,'[^0-9]','','g') <> ''
         AND ${phoneCol} IS NOT NULL AND regexp_replace(${phoneCol},'[^0-9]','','g') <> ''
         AND regexp_replace(mo.phone,'[^0-9]','','g') = regexp_replace(${phoneCol},'[^0-9]','','g'))
      )
  )`;
}

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
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY total_spent DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => ({
      type: 'dormant_vip',
      priority: 1,
      title: `לקוחה VIP שנעלמה: ${(c.first_name || '') + ' ' + (c.last_name || '')}`.trim(),
      detail: `הוציאה ${Math.round(c.total_spent).toLocaleString()}₪ ב-${c.orders_count} הזמנות, אבל לא קנתה כבר ${c.days_since} ימים. שווה לפנות אליה אישית עם עגלה מותאמת והטבה לפני שתלך למתחרים.`,
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
      priority: 3,
      title: `מוכר חזק ועומד להיגמר: ${p.title}`,
      detail: `נמכרו ${p.units_sold} יחידות ב-30 יום (קצב מהיר), נשארו רק ${p.total_inventory}. כל יום שאזל = מכירות שאתה מפסיד. שווה לחדש מלאי עכשיו.`,
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
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
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

// ---------- 1b. Personal: big new customer worth welcoming ----------
// A customer whose FIRST order happened in the last 7 days and was large.
// Personal touch: welcome + nudge toward a second purchase.
async function detectNewBigCustomers(shop) {
  return runDetector('newBigCustomers', async () => {
    const r = await db.query(
      `SELECT first_name, last_name, email, phone, total_spent, orders_count,
              last_order_date
       FROM store_customers
       WHERE shop_domain = $1
         AND orders_count = 1
         AND total_spent >= 300
         AND last_order_date >= NOW() - INTERVAL '7 days'
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY total_spent DESC
       FETCH FIRST 3 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => ({
      type: 'new_big_customer',
      priority: 2,
      title: `לקוחה חדשה ושווה: ${((c.first_name || '') + ' ' + (c.last_name || '')).trim()}`,
      detail: `קנתה בפעם הראשונה ב-${Math.round(c.total_spent).toLocaleString()}₪ בימים האחרונים. פנייה אישית עכשיו (תודה + הטבה לקנייה הבאה) הופכת קונה חד-פעמית ללקוחה קבועה.`,
      action_hint: 'welcome_second_purchase',
      data: {
        name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
        email: c.email, phone: c.phone,
        total_spent: Math.round(c.total_spent)
      }
    }));
  });
}

// Relaxed fallback for dormant VIPs: when the strict pool is empty (everyone
// recently contacted / opted out), widen thresholds so the merchant still gets
// actionable per-customer opportunities instead of an empty list.
async function detectDormantRelaxed(shop) {
  return runDetector('dormantRelaxed', async () => {
    const r = await db.query(
      `SELECT first_name, last_name, email, phone,
              total_spent, orders_count, last_order_date,
              EXTRACT(DAY FROM (NOW() - last_order_date))::int AS days_since
       FROM store_customers
       WHERE shop_domain = $1
         AND total_spent > 500
         AND orders_count >= 1
         AND last_order_date IS NOT NULL
         AND last_order_date < NOW() - INTERVAL '30 days'
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY total_spent DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => ({
      type: 'dormant_customer',
      priority: 2,
      title: `לקוחה ששווה להחזיר: ${((c.first_name || '') + ' ' + (c.last_name || '')).trim()}`,
      detail: `הוציאה ${Math.round(c.total_spent).toLocaleString()}₪ ולא קנתה כבר ${c.days_since} ימים. פנייה אישית עם הטבה יכולה להחזיר אותה.`,
      action_hint: 'send_winback',
      data: {
        name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
        email: c.email, phone: c.phone,
        total_spent: Math.round(c.total_spent),
        days_since: c.days_since
      }
    }));
  });
}

// ---------- Main entry: gather all insights ----------
async function getInsights(shop) {
  const [vips, lowStock, abandoned, shift, newBig] = await Promise.all([
    detectDormantVIPs(shop),
    detectLowStockBestsellers(shop),
    detectHighValueAbandoned(shop),
    detectSalesShift(shop),
    detectNewBigCustomers(shop)
  ]);

  // Customer-specific (personal) opportunities first: carts, VIPs, new customers.
  let personal = [...abandoned, ...vips, ...newBig];

  // GUARANTEE at least 3 personal opportunities. If strict pools came back thin
  // (cooldown/opt-out emptied them), widen in two stages:
  //   (1) relaxed dormant pool (lower spend bar, still respects cooldown+optout)
  //   (2) last-resort pool that IGNORES cooldown (still respects opt-out!) so the
  //       merchant always sees named customers worth contacting.
  if (personal.filter(isPersonal).length < 3) {
    const relaxed = await detectDormantRelaxed(shop);
    personal = mergePersonal(personal, relaxed, 3);
  }
  if (personal.filter(isPersonal).length < 3) {
    const lastResort = await detectPersonalLastResort(shop);
    personal = mergePersonal(personal, lastResort, 3);
  }

  const supporting = [...shift, ...lowStock.slice(0, 2)]; // context + at most 2 stock alerts

  const all = [...personal, ...supporting]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 7);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    count: all.length,
    insights: all
  };
}

// Merge new personal opportunities in, de-duplicating by email/phone, up to `target`.
function mergePersonal(current, additions, target) {
  const seen = new Set(current.map(p => (p.data && (p.data.email || p.data.phone)) || ''));
  for (const ins of additions) {
    if (current.filter(isPersonal).length >= target) break;
    const key = (ins.data && (ins.data.email || ins.data.phone)) || '';
    if (key && !seen.has(key)) { current.push(ins); seen.add(key); }
  }
  return current;
}

function isPersonal(ins) {
  return ins && ['dormant_vip', 'new_big_customer', 'dormant_customer', 'high_value_abandoned'].includes(ins.type);
}

// Last resort: best customers by spend, IGNORING the contact cooldown (but never
// opted-out). Resilient to NULL last_order_date (falls back to shopify_updated_at /
// shopify_created_at) so high-value customers always surface. Ensures the list
// always has named customers worth a personal message.
async function detectPersonalLastResort(shop) {
  return runDetector('personalLastResort', async () => {
    const r = await db.query(
      `SELECT first_name, last_name, email, phone,
              total_spent, orders_count,
              COALESCE(last_order_date, shopify_updated_at, shopify_created_at) AS effective_date,
              EXTRACT(DAY FROM (NOW() - COALESCE(last_order_date, shopify_updated_at, shopify_created_at)))::int AS days_since
       FROM store_customers
       WHERE shop_domain = $1
         AND total_spent > 200
         AND orders_count >= 1
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY total_spent DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => {
      const days = c.days_since;
      const sinceTxt = (days != null && days > 0) ? `לא קנתה כבר ${days} ימים. ` : '';
      return {
        type: 'dormant_customer',
        priority: 2,
        title: `לקוחה ששווה לפנות אליה: ${((c.first_name || '') + ' ' + (c.last_name || '')).trim()}`,
        detail: `הוציאה ${Math.round(c.total_spent).toLocaleString()}₪ ב-${c.orders_count} הזמנות. ${sinceTxt}פנייה אישית עם הטבה יכולה להחזיר אותה לקנייה.`,
        action_hint: 'send_winback',
        data: {
          name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
          email: c.email, phone: c.phone,
          total_spent: Math.round(c.total_spent),
          days_since: days
        }
      };
    });
  });
}

module.exports = {
  getInsights,
  detectDormantVIPs,
  detectLowStockBestsellers,
  detectHighValueAbandoned,
  detectSalesShift
};