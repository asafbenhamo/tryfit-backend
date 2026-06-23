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
const crypto = require('crypto');

// How many days to rest a customer after we've contacted them (created a coupon /
// reached out), so the insights don't keep surfacing the same people every day.
const CONTACTED_COOLDOWN_DAYS = 4;

// How long a "swiped away" opportunity stays hidden before it can resurface.
const DISMISS_DAYS = 2;

// ---------- Dynamic per-store thresholds ----------
// Instead of hard-coded "VIP = spent > 1500", we compute thresholds RELATIVE to
// each store's own customers (e.g. the 80th percentile of spend). A boutique and
// a high-ticket store get different, fitting definitions of "VIP". Cached 6h.
const _statsCache = new Map(); // shop -> { at, stats }
async function storeStats(shop) {
  const key = shop.toLowerCase().trim();
  const cached = _statsCache.get(key);
  if (cached && (Date.now() - cached.at) < 6 * 60 * 60 * 1000) return cached.stats;
  let stats = {
    vipSpend: 1500, midSpend: 400,      // sensible fallbacks
    avgGapDays: 45, hasData: false
  };
  try {
    // Spend percentiles among customers who actually bought.
    const r = await db.query(
      `SELECT
         percentile_cont(0.80) WITHIN GROUP (ORDER BY total_spent) AS p80,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spent) AS p50,
         COUNT(*) AS n
       FROM store_customers
       WHERE shop_domain = $1 AND total_spent > 0 AND orders_count >= 1`,
      [shop]
    );
    const row = r.rows[0];
    if (row && Number(row.n) >= 20) {
      stats.vipSpend = Math.max(300, Math.round(Number(row.p80)));
      stats.midSpend = Math.max(100, Math.round(Number(row.p50)));
      stats.hasData = true;
    }
    // Typical days between orders across the store (median gap for repeat buyers).
    const g = await db.query(
      `WITH gaps AS (
         SELECT shopify_customer_id,
                EXTRACT(DAY FROM (ordered_at - LAG(ordered_at) OVER (
                  PARTITION BY shopify_customer_id ORDER BY ordered_at)))::int AS gap
         FROM store_orders
         WHERE shop_domain = $1 AND shopify_customer_id IS NOT NULL AND ordered_at IS NOT NULL
       )
       SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY gap) AS median_gap
       FROM gaps WHERE gap IS NOT NULL AND gap > 0`,
      [shop]
    );
    if (g.rows[0] && g.rows[0].median_gap) {
      stats.avgGapDays = Math.max(14, Math.round(Number(g.rows[0].median_gap)));
    }
  } catch (e) { /* keep fallbacks */ }
  _statsCache.set(key, { at: Date.now(), stats });
  return stats;
}

// A stable ID for an opportunity, so the same customer/insight can be dismissed
// and recognized across visits. Based on type + the customer key (email/phone) or
// the title for non-personal insights.
function opportunityId(ins) {
  const key = (ins.data && (ins.data.email || ins.data.phone))
    || (ins.data && ins.data.product)
    || ins.title || '';
  return crypto.createHash('sha1').update((ins.type || '') + '|' + key).digest('hex').slice(0, 16);
}

async function ensureDismissTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dismissed_opportunities (
      id SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      dismissed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (shop_domain, opportunity_id)
    )`).catch(e => console.error('[insights] ensureDismissTable:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dismiss_shop ON dismissed_opportunities(shop_domain)`).catch(()=>{});
}
ensureDismissTable();

// Record that the merchant swiped away an opportunity (hidden for DISMISS_DAYS).
async function dismissOpportunity(shop, opportunityId) {
  await ensureDismissTable();
  await db.query(
    `INSERT INTO dismissed_opportunities (shop_domain, opportunity_id, dismissed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (shop_domain, opportunity_id) DO UPDATE SET dismissed_at = NOW()`,
    [shop.toLowerCase().trim(), opportunityId]
  ).catch(e => console.error('[insights] dismissOpportunity:', e.message));
  return { ok: true };
}

// Clear all dismissals for a shop (used to restart the deck once swiped through).
async function clearDismissed(shop) {
  await ensureDismissTable();
  await db.query(`DELETE FROM dismissed_opportunities WHERE shop_domain = $1`,
    [shop.toLowerCase().trim()]).catch(()=>{});
  return { ok: true };
}

// Set of opportunity IDs currently hidden for this shop (within the dismiss window).
async function getDismissedSet(shop) {
  await ensureDismissTable();
  try {
    const r = await db.query(
      `SELECT opportunity_id FROM dismissed_opportunities
       WHERE shop_domain = $1 AND dismissed_at >= NOW() - INTERVAL '${DISMISS_DAYS} days'`,
      [shop.toLowerCase().trim()]
    );
    return new Set(r.rows.map(x => x.opportunity_id));
  } catch (e) { return new Set(); }
}


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

// ---------- SMART: Purchase-cycle timing ----------
// For each repeat customer we compute THEIR OWN average gap between orders, then
// surface the ones who are "due" right now (their personal gap has elapsed since
// their last order, within a sensible window). This is the sharpest signal: we
// reach a customer exactly when their own habit says they're ready to buy again.
async function detectDueToReorder(shop) {
  return runDetector('dueToReorder', async () => {
    const r = await db.query(
      `WITH per_customer AS (
         SELECT shopify_customer_id,
                COUNT(*) AS orders_n,
                MAX(ordered_at) AS last_order,
                (EXTRACT(EPOCH FROM (MAX(ordered_at) - MIN(ordered_at))) / 86400.0)
                  / NULLIF(COUNT(*) - 1, 0) AS avg_gap_days
         FROM store_orders
         WHERE shop_domain = $1 AND shopify_customer_id IS NOT NULL AND ordered_at IS NOT NULL
         GROUP BY shopify_customer_id
         HAVING COUNT(*) >= 2
       ),
       due AS (
         SELECT pc.*,
                EXTRACT(DAY FROM (NOW() - pc.last_order))::int AS days_since,
                ROUND(pc.avg_gap_days)::int AS gap
         FROM per_customer pc
         WHERE pc.avg_gap_days BETWEEN 7 AND 240
           AND (NOW() - pc.last_order) >= (pc.avg_gap_days || ' days')::interval
           AND (NOW() - pc.last_order) <= (pc.avg_gap_days * 1.8 || ' days')::interval
       )
       SELECT c.first_name, c.last_name, c.email, c.phone,
              c.total_spent, c.orders_count,
              d.days_since, d.gap
       FROM due d
       JOIN store_customers c
         ON c.shop_domain = $1 AND c.shopify_customer_id = d.shopify_customer_id
       WHERE ${notRecentlyContacted('c.email', 'c.phone')}
         AND ${notOptedOut('c.email', 'c.phone')}
       ORDER BY (d.days_since - d.gap) ASC, c.total_spent DESC
       FETCH FIRST 40 ROWS ONLY`,
      [shop]
    );
    return r.rows.map(c => {
      const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
      return {
        type: 'due_to_reorder',
        priority: 1,
        title: `הרגע המושלם לפנות ל${name || 'לקוחה'}`,
        detail: `היא קונה בערך כל ${c.gap} ימים, ועברו כבר ${c.days_since} ימים מההזמנה האחרונה - בדיוק החלון שבו היא נוטה לחזור. פנייה אישית עכשיו, עם המלצה מתאימה והטבה קטנה, צפויה להמיר במיוחד.`,
        action_hint: 'send_winback',
        data: {
          name, email: c.email, phone: c.phone,
          total_spent: Math.round(c.total_spent || 0),
          orders_count: c.orders_count,
          avg_gap: c.gap, days_since: c.days_since
        }
      };
    });
  });
}

// ---------- 1. VIP customers who went quiet ----------
// A VIP (high lifetime spend) whose last order is far past their usual rhythm.
// We approximate "usual rhythm": if they have many orders but haven't bought in 45+ days.
async function detectDormantVIPs(shop) {
  return runDetector('dormantVIPs', async () => {
    const stats = await storeStats(shop);
    const r = await db.query(
      `SELECT first_name, last_name, email, phone,
              total_spent, orders_count, last_order_date,
              EXTRACT(DAY FROM (NOW() - last_order_date))::int AS days_since
       FROM store_customers
       WHERE shop_domain = $1
         AND total_spent >= $2
         AND orders_count >= 2
         AND last_order_date IS NOT NULL
         AND last_order_date < NOW() - INTERVAL '45 days'
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY total_spent DESC
       FETCH FIRST 5 ROWS ONLY`,
      [shop, stats.vipSpend]
    );
    return r.rows.map(c => ({
      type: 'dormant_vip',
      priority: 1,
      title: `לקוחה VIP שנעלמה: ${(c.first_name || '') + ' ' + (c.last_name || '')}`.trim(),
      detail: `הוציאה ${Math.round(c.total_spent).toLocaleString()}₪ ב-${c.orders_count} הזמנות (מהלקוחות המובילים בחנות), אבל לא קנתה כבר ${c.days_since} ימים. שווה לפנות אליה אישית עם עגלה מותאמת והטבה לפני שתלך למתחרים.`,
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
         AND ${notOptedOut('abandoned_checkouts.email', 'abandoned_checkouts.phone')}
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

// ---------- Learning: what's working best ----------
// Surfaces the best-performing action type (by conversion rate) over the last
// 60 days, so the merchant sees what works and the system reinforces it.
async function detectWhatWorks(shop) {
  return runDetector('whatWorks', async () => {
    const r = await db.query(
      `SELECT action_type,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome='converted')::int AS converted,
              COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric(12,2) AS revenue
       FROM advisor_actions
       WHERE shop_domain = $1
         AND created_at >= NOW() - INTERVAL '60 days'
         AND action_type NOT IN ('daily_report','morning_report')
       GROUP BY action_type
       HAVING COUNT(*) >= 5
       ORDER BY (COUNT(*) FILTER (WHERE outcome='converted')::float / COUNT(*)) DESC
       FETCH FIRST 1 ROWS ONLY`,
      [shop]
    );
    if (!r.rows[0]) return [];
    const w = r.rows[0];
    const rate = Math.round((w.converted / w.total) * 100);
    if (rate < 1) return []; // nothing meaningful learned yet
    const LABELS = {
      abandoned_cart: 'שחזור עגלות נטושות', dormant_vip: 'החזרת לקוחות VIP',
      one_time: 'דחיפה לקנייה שנייה', personalized_cart: 'עגלה מותאמת אישית',
      winback: 'win-back', campaign: 'קמפיין', agent: 'פעולות הסוכן'
    };
    const label = LABELS[w.action_type] || w.action_type;
    return [{
      type: 'what_works',
      priority: 3,
      title: `📈 מה הכי עובד אצלך: ${label}`,
      detail: `מהלך מסוג "${label}" ממיר אצלך ${rate}% (${w.converted} מתוך ${w.total}) והכניס ${Math.round(w.revenue).toLocaleString()}₪ ב-60 הימים האחרונים. זה המהלך הכי רווחי שלך - שווה לעשות ממנו עוד.`,
      action_hint: 'do_more_of_best',
      data: { action_type: w.action_type, action_label: label, rate, converted: w.converted, total: w.total }
    }];
  });
}

// ---------- Follow-up: customers who didn't respond ----------
// Looks at outreach that expired (sent >3 days ago, never converted) in the last
// ~10 days, and suggests a follow-up. Approach: present the count + a suggestion,
// the merchant decides whether to act.
async function detectFollowUp(shop) {
  return runDetector('followUp', async () => {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM advisor_actions
       WHERE shop_domain = $1
         AND outcome = 'expired'
         AND closed_at IS NULL
         AND created_at >= NOW() - INTERVAL '10 days'
         AND created_at < NOW() - INTERVAL '3 days'
         AND action_type NOT IN ('daily_report','morning_report')
         AND (target_email IS NOT NULL OR target_phone IS NOT NULL)`,
      [shop]
    );
    const n = r.rows[0] ? r.rows[0].n : 0;
    if (n < 3) return []; // not worth surfacing for tiny numbers

    return [{
      type: 'follow_up',
      priority: 3,
      title: `${n} לקוחות לא הגיבו לפנייה האחרונה`,
      detail: `פנינו אליהן לפני יותר מ-3 ימים והן עוד לא קנו. שווה לנסות שוב - הצעה: גישה אחרת מהפעם הקודמת (הודעה אחרת, אולי הטבה מעט גדולה יותר, או תזכורת עדינה). אתה מחליט אם ואיך לפנות.`,
      action_hint: 'follow_up_campaign',
      data: { pool_size: n }
    }];
  });
}

// ---------- Cross-sell opportunity ----------
// Finds the strongest product pair (X frequently bought with Y), then counts how
// many customers bought X but NOT Y. Those are prime, data-backed cross-sell
// targets: "47 customers bought X — offer them Y, which X-buyers usually add."
async function detectCrossSell(shop) {
  return runDetector('crossSell', async () => {
    // 1. Strongest co-purchase pair in the last 60 days.
    const pair = await db.query(
      `WITH pairs AS (
         SELECT a.title AS product_a, b.title AS product_b, COUNT(*)::int AS together
         FROM store_order_items a
         JOIN store_order_items b
           ON a.shopify_order_id = b.shopify_order_id AND a.shop_domain = b.shop_domain
          AND a.title < b.title
         WHERE a.shop_domain = $1
           AND a.title IS NOT NULL AND b.title IS NOT NULL
         GROUP BY a.title, b.title
       )
       SELECT product_a, product_b, together
       FROM pairs WHERE together >= 3
       ORDER BY together DESC FETCH FIRST 1 ROWS ONLY`,
      [shop]
    );
    if (!pair.rows[0]) return [];
    const { product_a, product_b, together } = pair.rows[0];

    // 2. How many customers bought A but NOT B (the cross-sell pool).
    const pool = await db.query(
      `SELECT COUNT(DISTINCT o.shopify_customer_id)::int AS n
       FROM store_order_items i
       JOIN store_orders o ON o.shopify_order_id = i.shopify_order_id AND o.shop_domain = i.shop_domain
       WHERE i.shop_domain = $1 AND i.title = $2
         AND o.shopify_customer_id IS NOT NULL
         AND o.shopify_customer_id NOT IN (
           SELECT o2.shopify_customer_id FROM store_order_items i2
           JOIN store_orders o2 ON o2.shopify_order_id = i2.shopify_order_id AND o2.shop_domain = i2.shop_domain
           WHERE i2.shop_domain = $1 AND i2.title = $3 AND o2.shopify_customer_id IS NOT NULL
         )`,
      [shop, product_a, product_b]
    );
    const n = pool.rows[0] ? pool.rows[0].n : 0;
    if (n < 3) return [];

    return [{
      type: 'cross_sell',
      priority: 3,
      title: `הזדמנות צולבת: מי שקנה "${product_a}" שווה להציע לו "${product_b}"`,
      detail: `${together} לקוחות קנו את שניהם יחד. יש ${n} לקוחות שקנו את "${product_a}" אבל עדיין לא את "${product_b}" - הצעה ממוקדת אליהם צפויה להמיר היטב.`,
      action_hint: 'cross_sell_campaign',
      data: { product_a, product_b, together, pool_size: n }
    }];
  });
}

// ---------- Main entry: gather all insights ----------
async function getInsights(shop) {
  const [vips, lowStock, abandoned, shift, newBig, crossSell, followUp, whatWorks, dueReorder] = await Promise.all([
    detectDormantVIPs(shop),
    detectLowStockBestsellers(shop),
    detectHighValueAbandoned(shop),
    detectSalesShift(shop),
    detectNewBigCustomers(shop),
    detectCrossSell(shop),
    detectFollowUp(shop),
    detectWhatWorks(shop),
    detectDueToReorder(shop)
  ]);

  // Customer-specific (personal) opportunities first. "Due to reorder" leads — it's
  // the sharpest signal (right customer, right moment) — then carts, VIPs, new.
  let personal = [...dueReorder, ...abandoned, ...vips, ...newBig];

  // De-dup personal by email/phone so the same person doesn't appear twice across
  // signals (e.g. both "due to reorder" and "dormant VIP").
  personal = dedupPersonal(personal);

  // GUARANTEE a healthy batch of personal opportunities. If strict pools came back
  // thin (cooldown/opt-out emptied them), widen in two stages:
  //   (1) relaxed dormant pool (lower spend bar, still respects cooldown+optout)
  //   (2) last-resort pool that IGNORES cooldown (still respects opt-out!) so the
  //       merchant always sees named customers worth contacting.
  // We aim higher than the display count so there's a real pool to swipe through.
  const PERSONAL_TARGET = 40;
  if (personal.filter(isPersonal).length < PERSONAL_TARGET) {
    const relaxed = await detectDormantRelaxed(shop);
    personal = mergePersonal(personal, relaxed, PERSONAL_TARGET);
  }
  if (personal.filter(isPersonal).length < PERSONAL_TARGET) {
    const lastResort = await detectPersonalLastResort(shop);
    personal = mergePersonal(personal, lastResort, PERSONAL_TARGET);
  }

  // Supporting order: stock alerts + sales shift FIRST (broad store health),
  // then the learning insight, cross-sell, and follow-up - all ABOVE personal.
  const supporting = [...lowStock.slice(0, 2), ...shift, ...whatWorks, ...crossSell, ...followUp];

  // Display order: supporting insights (stock/sales shift) FIRST, then the
  // personal per-customer opportunities BELOW them (merchant preference).
  // Keep the manual supporting order (stock → sales → cross-sell → follow-up);
  // do NOT re-sort by priority, which would scramble it.
  const personalSorted = personal.filter(isPersonal);

  // Attach a stable ID to every opportunity, then drop any the merchant recently
  // swiped away (hidden for DISMISS_DAYS), so swiping surfaces fresh ones.
  const dismissed = await getDismissedSet(shop);
  const withIds = [...supporting, ...personalSorted].map(ins => ({ ...ins, id: opportunityId(ins) }));
  let visible = withIds.filter(ins => !dismissed.has(ins.id));

  // If the merchant has swiped through everything, start the deck over: clear the
  // dismiss list and show all opportunities again.
  if (visible.length === 0 && withIds.length > 0) {
    await clearDismissed(shop);
    visible = withIds;
  }

  // Show a handful; keep the rest as a pool to pull replacements from on swipe.
  const DISPLAY = 5;
  const display = visible.slice(0, DISPLAY);
  const pool = visible.slice(DISPLAY);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    count: display.length,
    insights: display,
    pool: pool
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
  return ins && ['dormant_vip', 'new_big_customer', 'dormant_customer', 'high_value_abandoned', 'due_to_reorder'].includes(ins.type);
}

// Remove duplicate people across personal signals, keeping the first (highest-priority)
// occurrence by email/phone key.
function dedupPersonal(list) {
  const seen = new Set();
  const out = [];
  for (const ins of list) {
    const key = (ins.data && (ins.data.email || ins.data.phone)) || '';
    if (!key) { out.push(ins); continue; }
    if (seen.has(key)) continue;
    seen.add(key); out.push(ins);
  }
  return out;
}

// Last resort: real customers worth contacting, IGNORING the contact cooldown (but
// never opted-out). Resilient to NULL last_order_date. Pulls from the ENTIRE base
// (not just the top spenders) and randomly samples, so over time the merchant can
// reach every customer worth reaching — not the same few hundred.
async function detectPersonalLastResort(shop) {
  return runDetector('personalLastResort', async () => {
    // Pull every customer who has bought at least once and isn't opted out. We keep
    // a low spend floor just to drop near-zero/junk rows, not to exclude real buyers.
    // We randomize IN SQL and cap the fetch generously so performance stays fine even
    // with tens of thousands of customers, while still rotating across the whole base.
    const r = await db.query(
      `SELECT first_name, last_name, email, phone,
              total_spent, orders_count,
              EXTRACT(DAY FROM (NOW() - COALESCE(last_order_date, shopify_updated_at, shopify_created_at)))::int AS days_since
       FROM store_customers
       WHERE shop_domain = $1
         AND total_spent > 50
         AND orders_count >= 1
         AND (email IS NOT NULL OR phone IS NOT NULL)
         AND ${notRecentlyContacted('email', 'phone')}
         AND ${notOptedOut('store_customers.email', 'store_customers.phone')}
       ORDER BY random()
       FETCH FIRST 300 ROWS ONLY`,
      [shop]
    );
    // Already randomized by SQL; surface a large batch to feed the swipe pool so the
    // merchant can keep swiping through genuinely different people across visits.
    const pool = r.rows;
    return pool.slice(0, 120).map(c => {
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
  dismissOpportunity,
  detectDormantVIPs,
  detectLowStockBestsellers,
  detectHighValueAbandoned,
  detectSalesShift
};