// ai-tools.js - Phase B: Tool Layer for the AI Chief of Staff
// Each function returns structured JSON that the AI can use as a "tool".
// IMPORTANT:
//   - store_customers fields (total_spent, orders_count, last_order_date) are LIFETIME, from Shopify.
//   - store_orders / store_order_items are limited to the LAST 60 DAYS (Shopify scope limit).
//     => Any tool that reads orders returns "data_window": "last_60_days" so the AI knows.
//   - Every function is wrapped in try/catch. If the DB fails, the tool returns
//     { ok:false, error:... } and NEVER throws — TryFit core must keep working.

const db = require('./database');

// ---------- helpers ----------

// Safe wrapper: runs a query function, never throws.
async function safe(label, fn) {
  try {
    const data = await fn();
    return { ok: true, ...data };
  } catch (err) {
    console.error(`[ai-tools] ${label} failed:`, err.message);
    return { ok: false, error: err.message, tool: label };
  }
}

// Whitelist for ORDER BY to prevent SQL injection on column names.
const CUSTOMER_SORT = {
  total_spent: 'total_spent',
  orders_count: 'orders_count',
  last_order_date: 'last_order_date'
};

// ---------- 1. getTopCustomers ----------
// Best customers by lifetime spend (or orders). Includes everyone by default.
async function getTopCustomers(shopDomain, options = {}) {
  return safe('getTopCustomers', async () => {
    const limit = Math.min(parseInt(options.limit) || 10, 100);
    const sortBy = CUSTOMER_SORT[options.sortBy] || 'total_spent';
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1
       ORDER BY ${sortBy} DESC
       LIMIT $2`,
      [shopDomain, limit]
    );
    return { count: result.rows.length, customers: result.rows };
  });
}

// ---------- 2. getDormantCustomers ----------
// Customers who PAID before but went quiet. Target for "we miss you" outreach.
async function getDormantCustomers(shopDomain, options = {}) {
  return safe('getDormantCustomers', async () => {
    const daysInactive = parseInt(options.daysInactive) || 30;
    const minSpent = parseFloat(options.minSpent) || 0;
    const limit = Math.min(parseInt(options.limit) || 20, 100);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1
         AND orders_count > 0
         AND total_spent >= $2
         AND (last_order_date IS NULL
              OR last_order_date < NOW() - ($3 || ' days')::interval)
       ORDER BY total_spent DESC
       LIMIT $4`,
      [shopDomain, minSpent, String(daysInactive), limit]
    );
    return {
      days_inactive: daysInactive,
      count: result.rows.length,
      customers: result.rows
    };
  });
}

// ---------- 3. getNeverPurchased ----------
// Registered but never bought. Target for first-order coupon.
async function getNeverPurchased(shopDomain, options = {}) {
  return safe('getNeverPurchased', async () => {
    const limit = Math.min(parseInt(options.limit) || 20, 100);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city, marketing_consent
       FROM store_customers
       WHERE shop_domain = $1
         AND (orders_count = 0 OR orders_count IS NULL)
       ORDER BY last_synced_at DESC NULLS LAST
       LIMIT $2`,
      [shopDomain, limit]
    );
    return { count: result.rows.length, customers: result.rows };
  });
}

// ---------- 4. getRepeatCustomers ----------
// Most loyal: more than one order.
async function getRepeatCustomers(shopDomain, options = {}) {
  return safe('getRepeatCustomers', async () => {
    const limit = Math.min(parseInt(options.limit) || 20, 100);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1
         AND orders_count > 1
       ORDER BY orders_count DESC, total_spent DESC
       LIMIT $2`,
      [shopDomain, limit]
    );
    return { count: result.rows.length, customers: result.rows };
  });
}

// ---------- 5. getCustomerProfile ----------
// Full profile for one customer by email (or shopify id).
async function getCustomerProfile(shopDomain, options = {}) {
  return safe('getCustomerProfile', async () => {
    const { email, shopifyCustomerId } = options;
    if (!email && !shopifyCustomerId) {
      return { found: false, reason: 'no email or customer id provided' };
    }
    const result = await db.query(
      `SELECT * FROM store_customers
       WHERE shop_domain = $1
         AND ($2::text IS NULL OR email = $2)
         AND ($3::text IS NULL OR shopify_customer_id::text = $3)
       LIMIT 1`,
      [shopDomain, email || null, shopifyCustomerId || null]
    );
    if (result.rows.length === 0) return { found: false };
    const customer = result.rows[0];

    // recent orders (last 60 days window)
    const orders = await db.query(
      `SELECT order_number, total_price, currency, financial_status, ordered_at
       FROM store_orders
       WHERE shop_domain = $1 AND shopify_customer_id = $2
       ORDER BY ordered_at DESC
       LIMIT 20`,
      [shopDomain, customer.shopify_customer_id]
    );
    return {
      found: true,
      customer,
      recent_orders: orders.rows,
      recent_orders_window: 'last_60_days'
    };
  });
}

// ---------- 6. searchCustomers ----------
// Free-text search by name or email.
async function searchCustomers(shopDomain, options = {}) {
  return safe('searchCustomers', async () => {
    const q = (options.query || '').trim();
    if (!q) return { count: 0, customers: [] };
    const like = `%${q}%`;
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1
         AND (email ILIKE $2
              OR first_name ILIKE $2
              OR last_name ILIKE $2
              OR (first_name || ' ' || last_name) ILIKE $2)
       ORDER BY total_spent DESC
       LIMIT 25`,
      [shopDomain, like]
    );
    return { query: q, count: result.rows.length, customers: result.rows };
  });
}

// ---------- 7. getTopProducts ----------
// Best-selling products. NOTE: orders are last-60-days only.
async function getTopProducts(shopDomain, options = {}) {
  return safe('getTopProducts', async () => {
    const limit = Math.min(parseInt(options.limit) || 10, 50);
    const result = await db.query(
      `SELECT title, product_type, vendor,
              SUM(quantity)::int AS units_sold,
              SUM(price * quantity)::numeric(12,2) AS revenue
       FROM store_order_items
       WHERE shop_domain = $1
       GROUP BY title, product_type, vendor
       ORDER BY units_sold DESC
       LIMIT $2`,
      [shopDomain, limit]
    );
    return {
      data_window: 'last_60_days',
      count: result.rows.length,
      products: result.rows
    };
  });
}

// ---------- 8. getRevenueStats ----------
// Revenue summary over the available order window (max 60 days).
async function getRevenueStats(shopDomain, options = {}) {
  return safe('getRevenueStats', async () => {
    const days = Math.min(parseInt(options.days) || 30, 60);
    const result = await db.query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total_price),0)::numeric(12,2) AS revenue,
              COALESCE(AVG(total_price),0)::numeric(12,2) AS avg_order_value,
              MIN(ordered_at) AS first_order,
              MAX(ordered_at) AS last_order
       FROM store_orders
       WHERE shop_domain = $1
         AND ordered_at > NOW() - ($2 || ' days')::interval`,
      [shopDomain, String(days)]
    );
    return {
      data_window: `last_${days}_days`,
      max_window_note: 'orders limited to last 60 days by Shopify scope',
      stats: result.rows[0]
    };
  });
}

// ---------- 9. getTryFitInsights ----------
// Try-on activity from tryon_events.
async function getTryFitInsights(shopDomain, options = {}) {
  return safe('getTryFitInsights', async () => {
    const days = parseInt(options.days) || 30;
    const result = await db.query(
      `SELECT COUNT(*)::int AS total_tryons,
              COUNT(*) FILTER (WHERE success)::int AS successful,
              COUNT(DISTINCT identifier)::int AS unique_users
       FROM tryon_events
       WHERE shop_domain = $1
         AND created_at > NOW() - ($2 || ' days')::interval`,
      [shopDomain, String(days)]
    );
    const byProduct = await db.query(
      `SELECT product_title, product_category, COUNT(*)::int AS tryons
       FROM tryon_events
       WHERE shop_domain = $1
         AND created_at > NOW() - ($2 || ' days')::interval
       GROUP BY product_title, product_category
       ORDER BY tryons DESC
       LIMIT 10`,
      [shopDomain, String(days)]
    );
    return {
      data_window: `last_${days}_days`,
      summary: result.rows[0],
      top_tried_products: byProduct.rows
    };
  });
}

// ---------- 10. generateWhatsAppMessage ----------
// Builds a Hebrew WhatsApp text tailored to a customer + intent.
// Returns the text; does NOT send anything.
async function generateWhatsAppMessage(shopDomain, options = {}) {
  return safe('generateWhatsAppMessage', async () => {
    const { email, intent = 'comeback' } = options;
    if (!email) return { ok: false, reason: 'no email provided' };

    const profile = await getCustomerProfile(shopDomain, { email });
    if (!profile.found) return { found: false };

    const name = profile.customer.first_name || 'לקוחה יקרה';
    const templates = {
      comeback: `היי ${name}! 💕 התגעגענו אלייך ב-770. הכנו לך 15% הנחה על הקנייה הבאה עם הקוד COMEBACK15. מחכות לראות אותך!`,
      first_order: `היי ${name}! 🎉 ברוכה הבאה ל-770! מתנה בשבילך: 10% הנחה על ההזמנה הראשונה עם הקוד WELCOME10.`,
      vip: `היי ${name}! ✨ את מהלקוחות הכי מיוחדות שלנו. רצינו לפנק אותך בגישה מוקדמת לקולקציה החדשה + 20% הנחה אישית.`,
      winback_big: `היי ${name}! מזמן לא התראינו 🙏 כלקוחה חשובה שלנו, שמרנו לך הטבה מיוחדת. נשמח לראות אותך שוב ב-770.`
    };
    const text = templates[intent] || templates.comeback;
    return {
      found: true,
      intent,
      customer: { name, email, total_spent: profile.customer.total_spent },
      message: text,
      note: 'text only — not sent. Review before sending.'
    };
  });
}

module.exports = {
  getTopCustomers,
  getDormantCustomers,
  getNeverPurchased,
  getRepeatCustomers,
  getCustomerProfile,
  searchCustomers,
  getTopProducts,
  getRevenueStats,
  getTryFitInsights,
  generateWhatsAppMessage
};