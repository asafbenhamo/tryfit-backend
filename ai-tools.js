// ai-tools.js - Phase B: Tool Layer for the AI Chief of Staff
// Each function returns structured JSON that the AI can use as a "tool".
// IMPORTANT:
//   - store_customers fields (total_spent, orders_count, last_order_date) are LIFETIME, from Shopify.
//   - store_orders / store_order_items are limited to the LAST 60 DAYS (Shopify scope limit).
//     => Any tool that reads orders returns "data_window": "last_60_days" so the AI knows.
//   - Every function is wrapped in try/catch. If the DB fails, the tool returns
//     { ok:false, error:... } and NEVER throws — TryFit core must keep working.

const db = require('./database');
const shopifyClient = require('./shopify-client');
const rfmEngine = require('./rfm-engine');
const smsSender = require('./sms-sender');

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

// How long a customer stays "off the list" after the advisor prepared an action
// for them. After this many days they return to the pool automatically.
const CONTACTED_COOLDOWN_DAYS = 4;

// Builds a SQL fragment that excludes customers the advisor already prepared an
// action for within the cooldown window. Matches on email OR phone against
// advisor_actions. Returns { clause, params } to append to a query.
// `startIndex` is the current highest $N placeholder already used; the fragment
// adds exactly ONE new placeholder ($startIndex+1) for the cooldown day count.
// The clause references store_customers.email / store_customers.phone, so the
// outer query MUST use the table name (not an alias) — all queries here do.
// Excludes customers we've already reached out to. ON BY DEFAULT — the agent must
// pass excludeContacted:false explicitly to re-include them (e.g. the owner says
// "contact them again"). `windowDays` controls how far back "already contacted"
// looks; when the owner asks for genuinely NEW people, the caller passes a very
// large window so anyone ever contacted is excluded.
function buildExcludeContacted(enabled, startIndex, windowDays) {
  // default ON: only skip the exclusion when explicitly set to false
  if (enabled === false) return { clause: '', params: [] };
  const idx = startIndex + 1;
  const days = windowDays != null ? String(windowDays) : String(CONTACTED_COOLDOWN_DAYS);
  const clause = `
    AND NOT EXISTS (
      SELECT 1 FROM advisor_actions aa
      WHERE aa.shop_domain = store_customers.shop_domain
        AND aa.created_at >= NOW() - ($${idx} || ' days')::interval
        AND aa.action_type NOT IN ('daily_report','morning_report')
        AND (
          (aa.target_email IS NOT NULL AND lower(aa.target_email) = lower(store_customers.email))
          OR
          (aa.target_phone IS NOT NULL AND store_customers.phone IS NOT NULL
           AND regexp_replace(aa.target_phone,'[^0-9]','','g') = regexp_replace(store_customers.phone,'[^0-9]','','g'))
        )
    )`;
  return { clause, params: [days] };
}

// SQL fragment that excludes customers who opted out of messaging (message_optouts).
// Matches on email OR phone. Takes no params — references the table by name, so the
// outer query MUST use store_customers (not an alias). Always safe to append.
const EXCLUDE_OPTED_OUT = `
  AND NOT EXISTS (
    SELECT 1 FROM message_optouts mo
    WHERE mo.shop_domain = store_customers.shop_domain
      AND (
        (mo.email IS NOT NULL AND mo.email <> '' AND store_customers.email IS NOT NULL AND store_customers.email <> ''
         AND lower(mo.email) = lower(store_customers.email))
        OR
        (mo.phone IS NOT NULL AND regexp_replace(mo.phone,'[^0-9]','','g') <> ''
         AND store_customers.phone IS NOT NULL AND regexp_replace(store_customers.phone,'[^0-9]','','g') <> ''
         AND regexp_replace(mo.phone,'[^0-9]','','g') = regexp_replace(store_customers.phone,'[^0-9]','','g'))
      )
  )`;

// ---------- getCollections ----------
// Lists the store's categories (collections) so the agent can create a coupon
// limited to a specific category by its id.
async function getCollections(shopDomain) {
  return safe('getCollections', async () => {
    const shopify = require('./shopify-client');
    const cols = await shopify.getCollections(shopDomain);
    return { count: cols.length, collections: cols };
  });
}

// ---------- getAudienceCounts ----------
// Total COUNTS across the whole customer base (not a list). Answers questions like
// "how many customers do I have", "how many are on my mailing list", "how many
// haven't bought in 60 days". This is what lets the agent know the full size of the
// audience, not just the sample it pulls for campaigns.
async function getAudienceCounts(shopDomain, options = {}) {
  return safe('getAudienceCounts', async () => {
    const r = await db.query(
      `SELECT
         COUNT(*)::int AS total_customers,
         COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int AS with_email,
         COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int AS with_phone,
         COUNT(*) FILTER (WHERE marketing_consent = true)::int AS marketing_subscribers,
         COUNT(*) FILTER (WHERE orders_count > 0)::int AS buyers,
         COUNT(*) FILTER (WHERE COALESCE(orders_count,0) = 0)::int AS never_purchased,
         COUNT(*) FILTER (WHERE orders_count >= 2)::int AS repeat_buyers,
         COUNT(*) FILTER (WHERE last_order_date IS NOT NULL
                            AND last_order_date < NOW() - INTERVAL '60 days')::int AS dormant_60d
       FROM store_customers
       WHERE shop_domain = $1`,
      [shopDomain]
    );
    // How many are reachable AND not opted out (the true "mailing list" size).
    const reachable = await db.query(
      `SELECT COUNT(*)::int AS contactable
       FROM store_customers
       WHERE shop_domain = $1
         AND ((email IS NOT NULL AND email <> '') OR (phone IS NOT NULL AND phone <> ''))
         ${EXCLUDE_OPTED_OUT}`,
      [shopDomain]
    );
    const c = r.rows[0] || {};
    c.contactable = (reachable.rows[0] || {}).contactable || 0;
    return c;
  });
}

// ---------- 1. getTopCustomers ----------
// Best customers by lifetime spend (or orders). Includes everyone by default.
async function getTopCustomers(shopDomain, options = {}) {
  return safe('getTopCustomers', async () => {
    const limit = Math.min(parseInt(options.limit) || 10, 50000);
    const sortBy = CUSTOMER_SORT[options.sortBy] || 'total_spent';
    const params = [shopDomain];
    const ex = buildExcludeContacted(options.excludeContacted, params.length, options.onlyNew ? 3650 : options.contactedWindowDays);
    params.push(...ex.params);
    params.push(limit);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1${ex.clause}${EXCLUDE_OPTED_OUT}
       ORDER BY ${sortBy} DESC
       LIMIT $${params.length}`,
      params
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
    const limit = Math.min(parseInt(options.limit) || 20, 50000);
    // Rotation: default to random order so repeated calls surface DIFFERENT people
    // (not the same top-spenders every time). 'value' = highest spenders first.
    const order = options.sortMode === 'value' ? 'c.total_spent DESC' : 'random()';
    const params = [shopDomain, minSpent, String(daysInactive)];
    const ex = buildExcludeContacted(options.excludeContacted, params.length, options.onlyNew ? 3650 : options.contactedWindowDays);
    params.push(...ex.params);
    params.push(limit);
    const result = await db.query(
      `SELECT c.email, c.first_name, c.last_name, c.phone, c.city,
              c.total_spent, c.orders_count, c.last_order_date,
              cat.product_type AS top_category
       FROM store_customers c
       LEFT JOIN LATERAL (
         SELECT i.product_type
         FROM store_order_items i
         JOIN store_orders o ON o.shopify_order_id = i.shopify_order_id AND o.shop_domain = i.shop_domain
         WHERE i.shop_domain = c.shop_domain
           AND o.shopify_customer_id = c.shopify_customer_id
           AND i.product_type IS NOT NULL AND i.product_type <> ''
         GROUP BY i.product_type
         ORDER BY SUM(i.quantity) DESC
         LIMIT 1
       ) cat ON true
       WHERE c.shop_domain = $1
         AND c.orders_count > 0
         AND c.total_spent >= $2
         AND (c.last_order_date IS NULL
              OR c.last_order_date < NOW() - ($3 || ' days')::interval)${ex.clause.replace(/\bstore_customers\./g, 'c.')}${EXCLUDE_OPTED_OUT.replace(/store_customers\./g, 'c.')}
       ORDER BY ${order}
       LIMIT $${params.length}`,
      params
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
    const limit = Math.min(parseInt(options.limit) || 20, 50000);
    const params = [shopDomain];
    const ex = buildExcludeContacted(options.excludeContacted, params.length, options.onlyNew ? 3650 : options.contactedWindowDays);
    params.push(...ex.params);
    params.push(limit);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city, marketing_consent
       FROM store_customers
       WHERE shop_domain = $1
         AND (orders_count = 0 OR orders_count IS NULL)${ex.clause}${EXCLUDE_OPTED_OUT}
       ORDER BY random()
       LIMIT $${params.length}`,
      params
    );
    return { count: result.rows.length, customers: result.rows };
  });
}

// ---------- 4. getRepeatCustomers ----------
// Most loyal: more than one order.
async function getRepeatCustomers(shopDomain, options = {}) {
  return safe('getRepeatCustomers', async () => {
    const limit = Math.min(parseInt(options.limit) || 20, 50000);
    const params = [shopDomain];
    const ex = buildExcludeContacted(options.excludeContacted, params.length, options.onlyNew ? 3650 : options.contactedWindowDays);
    params.push(...ex.params);
    params.push(limit);
    const result = await db.query(
      `SELECT email, first_name, last_name, phone, city,
              total_spent, orders_count, last_order_date
       FROM store_customers
       WHERE shop_domain = $1
         AND orders_count > 1${ex.clause}${EXCLUDE_OPTED_OUT}
       ORDER BY orders_count DESC, total_spent DESC
       LIMIT $${params.length}`,
      params
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
              OR (first_name || ' ' || last_name) ILIKE $2)${EXCLUDE_OPTED_OUT}
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

// ---------- 11. getCustomerPurchases ----------
// What a specific customer actually bought (items), by email.
// Links customer -> orders -> order items. Window limited to last 60 days.
async function getCustomerPurchases(shopDomain, options = {}) {
  return safe('getCustomerPurchases', async () => {
    const { email } = options;
    if (!email) return { found: false, reason: 'no email provided' };

    // Resolve the customer's shopify id from email.
    const cust = await db.query(
      `SELECT shopify_customer_id, first_name, last_name, total_spent, orders_count
       FROM store_customers
       WHERE shop_domain = $1 AND email = $2
       LIMIT 1`,
      [shopDomain, email]
    );
    if (cust.rows.length === 0) return { found: false };
    const customer = cust.rows[0];

    // Aggregate the items this customer bought (joined through their orders).
    const items = await db.query(
      `SELECT i.title, i.product_type, i.vendor,
              SUM(i.quantity)::int AS qty,
              SUM(i.price * i.quantity)::numeric(12,2) AS spent
       FROM store_order_items i
       JOIN store_orders o
         ON o.shopify_order_id = i.shopify_order_id
        AND o.shop_domain = i.shop_domain
       WHERE i.shop_domain = $1
         AND o.shopify_customer_id = $2
       GROUP BY i.title, i.product_type, i.vendor
       ORDER BY qty DESC
       LIMIT 30`,
      [shopDomain, customer.shopify_customer_id]
    );

    // Summarize favorite categories.
    const categories = await db.query(
      `SELECT i.product_type,
              SUM(i.quantity)::int AS qty
       FROM store_order_items i
       JOIN store_orders o
         ON o.shopify_order_id = i.shopify_order_id
        AND o.shop_domain = i.shop_domain
       WHERE i.shop_domain = $1
         AND o.shopify_customer_id = $2
         AND i.product_type IS NOT NULL
       GROUP BY i.product_type
       ORDER BY qty DESC
       LIMIT 5`,
      [shopDomain, customer.shopify_customer_id]
    );

    return {
      found: true,
      data_window: 'last_60_days',
      customer: {
        email,
        name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
        total_spent: customer.total_spent,
        orders_count: customer.orders_count
      },
      items: items.rows,
      top_categories: categories.rows,
      note: items.rows.length === 0
        ? 'no items in the last 60 days (customer may have bought earlier - order history limited to 60 days)'
        : undefined
    };
  });
}

// ---------- 19. getNewestProducts ----------
// The most recently PUBLISHED products (the newest collection that just went
// live). Reads published_at / updated_at from raw_data, so it catches products
// that were created earlier but only just set to active.
async function getNewestProducts(shopDomain, options = {}) {
  return safe('getNewestProducts', async () => {
    const limit = Math.min(parseInt(options.limit) || 15, 40);
    // Pull available products with their raw_data, then sort by published_at in JS
    // (published_at lives inside the JSONB, not a top-level column).
    const result = await db.query(
      `SELECT title, handle, min_price, max_price, total_inventory, raw_data
       FROM store_products
       WHERE shop_domain = $1 AND available = TRUE AND raw_data IS NOT NULL
       FETCH FIRST 500 ROWS ONLY`,
      [shopDomain]
    );

    const PUBLIC_DOMAIN = shopifyClient.getPublicDomain(shopDomain);
    const withDates = result.rows.map(row => {
      let raw = {};
      try { raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data; } catch (e) {}
      const published = raw.published_at || raw.created_at || null;
      const updated = raw.updated_at || null;
      // "freshness" = most recent of published/updated
      const freshness = [published, updated].filter(Boolean).sort().pop() || null;
      return {
        title: row.title,
        url: row.handle ? `${PUBLIC_DOMAIN}/products/${row.handle}` : null,
        price: row.min_price,
        inventory: row.total_inventory,
        published_at: published,
        freshness
      };
    }).filter(p => p.freshness);

    // Sort newest first
    withDates.sort((a, b) => (b.freshness || '').localeCompare(a.freshness || ''));

    return {
      ok: true,
      newest_products: withDates.slice(0, limit),
      note: 'sorted by publish/update date - the top items are the freshest collection that went live most recently. Use these when the merchant asks about the new collection or wants to promote what just launched.'
    };
  });
}

// ---------- 12. getStoreProducts ----------
// Live catalog (synced from Shopify every 6h). Search by free text in title,
// filter by price and availability. Does NOT rely on product_type (mostly empty in 770).
async function getStoreProducts(shopDomain, options = {}) {
  return safe('getStoreProducts', async () => {
    const { search, minPrice, maxPrice, availableOnly = true, limit = 20 } = options;

    const where = ['shop_domain = $1'];
    const params = [shopDomain];
    let p = 1;

    if (availableOnly) {
      where.push('available = TRUE');
    }
    if (search && search.trim()) {
      p++;
      where.push(`title ILIKE $${p}`);
      params.push('%' + search.trim() + '%');
    }
    if (minPrice != null) {
      p++;
      where.push(`min_price >= $${p}`);
      params.push(minPrice);
    }
    if (maxPrice != null) {
      p++;
      where.push(`max_price <= $${p}`);
      params.push(maxPrice);
    }

    const lim = Math.min(parseInt(limit) || 20, 50);

    const result = await db.query(
      `SELECT title, product_type, vendor, tags,
              min_price, max_price, total_inventory, available, handle
       FROM store_products
       WHERE ${where.join(' AND ')}
       ORDER BY available DESC, total_inventory DESC
       LIMIT ${lim}`,
      params
    );

    // Also give a total count of available products for context.
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total_available
       FROM store_products
       WHERE shop_domain = $1 AND available = TRUE`,
      [shopDomain]
    );

    // Build a ready-to-use public URL for each product from its handle.
    // The store's public domain is sevenseventy.co.il.
    const PUBLIC_DOMAIN = shopifyClient.getPublicDomain(shopDomain);
    const products = result.rows.map(p => ({
      ...p,
      product_url: p.handle ? `${PUBLIC_DOMAIN}/products/${p.handle}` : null
    }));

    return {
      ok: true,
      total_available_in_store: countResult.rows[0]?.total_available || 0,
      returned: products.length,
      filters_applied: { search: search || null, minPrice: minPrice ?? null, maxPrice: maxPrice ?? null, availableOnly },
      products: products
    };
  });
}

// ---------- 13. getAbandonedCheckouts ----------
// Abandoned carts (started but not completed). Only rows where completed_at IS NULL
// are truly abandoned. Returns summary stats, most-abandoned products, and a sample
// of recoverable carts (those with an email/phone to reach out to).
async function getAbandonedCheckouts(shopDomain, options = {}) {
  return safe('getAbandonedCheckouts', async () => {
    const { days = 30, limit = 10 } = options;
    const lim = Math.min(parseInt(limit) || 10, 50);
    const dayNum = parseInt(days) || 30;

    // Summary: count + total money stuck, within the time window, not completed.
    const summary = await db.query(
      `SELECT
         COUNT(*)::int AS abandoned_count,
         COALESCE(SUM(total_price), 0)::numeric(12,2) AS total_value_stuck,
         COALESCE(AVG(total_price), 0)::numeric(12,2) AS avg_cart_value,
         COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int AS recoverable_with_email
       FROM abandoned_checkouts
       WHERE shop_domain = $1
         AND completed_at IS NULL
         AND shopify_created_at >= NOW() - ($2 || ' days')::interval`,
      [shopDomain, dayNum]
    );

    // Most-abandoned products: unnest the JSONB line_items and count.
    const topProducts = await db.query(
      `SELECT
         li->>'title' AS product_title,
         SUM((li->>'quantity')::int)::int AS times_abandoned,
         COUNT(DISTINCT ac.id)::int AS in_carts
       FROM abandoned_checkouts ac,
            LATERAL jsonb_array_elements(ac.line_items) li
       WHERE ac.shop_domain = $1
         AND ac.completed_at IS NULL
         AND ac.shopify_created_at >= NOW() - ($2 || ' days')::interval
         AND li->>'title' IS NOT NULL
       GROUP BY li->>'title'
       ORDER BY times_abandoned DESC
       FETCH FIRST ${lim} ROWS ONLY`,
      [shopDomain, dayNum]
    );

    // Recoverable carts: have an email, highest value first. Excludes customers
    // who opted out of messaging (legal requirement).
    const recoverable = await db.query(
      `SELECT email, phone, total_price, item_count,
              line_items, abandoned_checkout_url, shopify_created_at
       FROM abandoned_checkouts
       WHERE shop_domain = $1
         AND completed_at IS NULL
         AND email IS NOT NULL AND email <> ''
         AND shopify_created_at >= NOW() - ($2 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM message_optouts mo
           WHERE mo.shop_domain = abandoned_checkouts.shop_domain
             AND (
               (mo.email IS NOT NULL AND mo.email <> '' AND lower(mo.email) = lower(abandoned_checkouts.email))
               OR
               (mo.phone IS NOT NULL AND regexp_replace(mo.phone,'[^0-9]','','g') <> ''
                AND abandoned_checkouts.phone IS NOT NULL
                AND regexp_replace(mo.phone,'[^0-9]','','g') = regexp_replace(abandoned_checkouts.phone,'[^0-9]','','g'))
             )
         )
       ORDER BY total_price DESC
       FETCH FIRST ${lim} ROWS ONLY`,
      [shopDomain, dayNum]
    );

    return {
      ok: true,
      data_window: `${dayNum} days`,
      summary: summary.rows[0] || {},
      most_abandoned_products: topProducts.rows,
      recoverable_carts: recoverable.rows
    };
  });
}

// ---------- 14. getCrossSellData ----------
// "Customers who bought X also bought Y" - frequently co-purchased products.
// Powers smart cross-sell offers. Based on orders within the data window.
async function getCrossSellData(shopDomain, options = {}) {
  return safe('getCrossSellData', async () => {
    const productTitle = (options.productTitle || '').trim();
    const limit = Math.min(parseInt(options.limit) || 8, 20);

    if (productTitle) {
      // Co-purchase: products that appear in the same orders as the given product
      const result = await db.query(
        `WITH target_orders AS (
           SELECT DISTINCT shopify_order_id
           FROM store_order_items
           WHERE shop_domain = $1 AND title ILIKE $2
         )
         SELECT oi.title, COUNT(DISTINCT oi.shopify_order_id)::int AS co_purchases,
                SUM(oi.quantity)::int AS units
         FROM store_order_items oi
         JOIN target_orders t ON t.shopify_order_id = oi.shopify_order_id
         WHERE oi.shop_domain = $1
           AND oi.title NOT ILIKE $2
         GROUP BY oi.title
         ORDER BY co_purchases DESC
         FETCH FIRST ${limit} ROWS ONLY`,
        [shopDomain, `%${productTitle}%`]
      );
      return {
        anchor_product: productTitle,
        also_bought: result.rows,
        data_window: 'last_60_days'
      };
    }

    // No specific product: return the strongest product PAIRS overall
    const pairs = await db.query(
      `WITH pairs AS (
         SELECT a.title AS product_a, b.title AS product_b,
                COUNT(*)::int AS times_together
         FROM store_order_items a
         JOIN store_order_items b
           ON a.shopify_order_id = b.shopify_order_id
          AND a.shop_domain = b.shop_domain
          AND a.title < b.title
         WHERE a.shop_domain = $1
         GROUP BY a.title, b.title
         HAVING COUNT(*) >= 2
       )
       SELECT * FROM pairs
       ORDER BY times_together DESC
       FETCH FIRST ${limit} ROWS ONLY`,
      [shopDomain]
    );
    return { top_pairs: pairs.rows, data_window: 'last_60_days' };
  });
}

// ---------- 15. getCampaignPerformance ----------
// What the advisor has done and what worked - powers learning.
// Reads advisor_actions to show which action types / coupons converted best.
async function getCampaignPerformance(shopDomain, options = {}) {
  return safe('getCampaignPerformance', async () => {
    const summary = await db.query(
      `SELECT action_type,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'converted')::int AS converted,
              COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'),0)::numeric(12,2) AS revenue
       FROM advisor_actions
       WHERE shop_domain = $1
       GROUP BY action_type
       ORDER BY revenue DESC`,
      [shopDomain]
    );
    const totals = await db.query(
      `SELECT COUNT(*)::int AS total_actions,
              COUNT(*) FILTER (WHERE outcome = 'converted')::int AS total_converted,
              COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome = 'converted'),0)::numeric(12,2) AS total_revenue
       FROM advisor_actions WHERE shop_domain = $1`,
      [shopDomain]
    );
    const t = totals.rows[0] || {};
    const convRate = t.total_actions > 0 ? Math.round((t.total_converted / t.total_actions) * 100) : 0;
    return {
      by_type: summary.rows,
      total_actions: t.total_actions || 0,
      total_converted: t.total_converted || 0,
      conversion_rate_pct: convRate,
      total_revenue: Math.round(parseFloat(t.total_revenue || 0)),
      note: 'use this to learn which campaign types convert best and recommend accordingly'
    };
  });
}

// ---------- 16. getProductVariants ----------
// Extracts purchasable variants (variant_id, size/color, price, stock) from
// the products' raw_data JSON. Needed to build personalized carts (draft orders).
async function getProductVariants(shopDomain, options = {}) {
  return safe('getProductVariants', async () => {
    const search = (options.search || '').trim();
    const limit = Math.min(parseInt(options.limit) || 10, 30);

    const where = ['shop_domain = $1', 'available = TRUE', 'raw_data IS NOT NULL'];
    const params = [shopDomain];
    if (search) {
      params.push('%' + search + '%');
      where.push(`title ILIKE $${params.length}`);
    }

    const result = await db.query(
      `SELECT title, handle, raw_data
       FROM store_products
       WHERE ${where.join(' AND ')}
       ORDER BY total_inventory DESC
       FETCH FIRST ${limit} ROWS ONLY`,
      params
    );

    const products = result.rows.map(row => {
      let variants = [];
      try {
        const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
        variants = (raw.variants || [])
          .filter(v => (parseInt(v.inventory_quantity) || 0) > 0 || v.inventory_management === null)
          .map(v => ({
            variant_id: v.id,
            label: v.title,        // e.g. "M / שחור"
            price: v.price,
            in_stock: parseInt(v.inventory_quantity) || 0
          }));
      } catch (e) { /* skip malformed */ }
      return { title: row.title, handle: row.handle, variants };
    }).filter(p => p.variants.length > 0);

    return { ok: true, returned: products.length, products };
  });
}

// ---------- 17. getCustomerSizes ----------
// What sizes/variants a customer actually bought before. Critical for building
// a personalized cart that only includes items in HER size that are in stock.
async function getCustomerSizes(shopDomain, options = {}) {
  return safe('getCustomerSizes', async () => {
    const { email } = options;
    if (!email) return { found: false, reason: 'no email' };
    const cust = await db.query(
      `SELECT shopify_customer_id FROM store_customers
       WHERE shop_domain = $1 AND email = $2 LIMIT 1`,
      [shopDomain, email]
    );
    if (cust.rows.length === 0) return { found: false };

    const sizes = await db.query(
      `SELECT i.variant_title, COUNT(*)::int AS times_bought
       FROM store_order_items i
       JOIN store_orders o
         ON o.shopify_order_id = i.shopify_order_id AND o.shop_domain = i.shop_domain
       WHERE i.shop_domain = $1
         AND o.shopify_customer_id = $2
         AND i.variant_title IS NOT NULL AND i.variant_title <> ''
       GROUP BY i.variant_title
       ORDER BY times_bought DESC`,
      [shopDomain, cust.rows[0].shopify_customer_id]
    );
    // Extract just the size tokens (e.g. "M / שחור" -> "M", "L" etc.) for guidance
    return {
      found: true,
      purchased_variants: sizes.rows,
      note: 'these are the exact variant labels (size/color) the customer bought before. Only add items to her cart in a size she has bought, and only if that variant is in stock (check getProductVariants).'
    };
  });
}

// ---------- 18. getTodayActivity ----------
// What the advisor did TODAY (since midnight Israel time) - for mid-day "what
// have you done so far?" reports and the end-of-day summary.
async function getTodayActivity(shopDomain, options = {}) {
  return safe('getTodayActivity', async () => {
    const r = await db.query(
      `SELECT action_type,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE outcome='converted')::int AS converted,
              COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric(12,2) AS revenue
       FROM advisor_actions
       WHERE shop_domain = $1
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem')
       GROUP BY action_type
       ORDER BY count DESC`,
      [shopDomain]
    );
    const totals = await db.query(
      `SELECT COUNT(*)::int AS total_actions,
              COUNT(DISTINCT target_email) FILTER (WHERE target_email IS NOT NULL)::int AS unique_customers,
              COUNT(*) FILTER (WHERE outcome='converted')::int AS conversions,
              COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric(12,2) AS revenue,
              COUNT(*) FILTER (WHERE coupon_code IS NOT NULL)::int AS coupons_created
       FROM advisor_actions
       WHERE shop_domain = $1
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem')`,
      [shopDomain]
    );
    const t = totals.rows[0] || {};
    return {
      ok: true,
      today: {
        total_actions: t.total_actions || 0,
        customers_contacted: t.unique_customers || 0,
        coupons_created: t.coupons_created || 0,
        conversions: t.conversions || 0,
        revenue_so_far: Math.round(parseFloat(t.revenue || 0))
      },
      by_type: r.rows,
      note: 'this is what the advisor accomplished today so far'
    };
  });
}

// ---------------------------------------------------------------------------
// RFM SEGMENTATION — Daniel's strongest analytical tool. Scores the WHOLE base
// (Recency/Frequency/Monetary), maps each customer to a strategic segment, and
// returns who to contact, the recommended offer for their value tier, WHY, and
// each customer's last product (so the message can reference what they bought).
// Use this to plan high-converting, personal campaigns instead of generic blasts.
// ---------------------------------------------------------------------------
async function getRFMSegments(shop, options = {}) {
  try {
    const segmentFilter = options.segment || null;       // e.g. 'cant_lose'
    const maxCustomers = Math.min(parseInt(options.limit) || 50, 2000);
    const scored = await rfmEngine.computeRFM(shop, { limit: 2000 });
    if (scored.length === 0) {
      return { ok: true, total: 0, summary: [], customers: [],
        note: 'אין מספיק נתוני הזמנות לניתוח RFM עדיין.' };
    }
    const summary = rfmEngine.summarize(scored);
    let pool = scored;
    if (segmentFilter) pool = scored.filter(c => c.segment === segmentFilter);
    // Default ordering: by segment priority (1 = act first), then by value.
    pool.sort((a, b) => (a.priority - b.priority) || (b.monetary - a.monetary));
    const customers = pool.slice(0, maxCustomers).map(c => ({
      name: c.name, email: c.email, phone: c.phone,
      segment: c.segment, segment_label: c.segment_label,
      total_spent: c.monetary, orders: c.frequency, days_since_order: c.recency_days,
      last_product: c.last_product,
      recommended_discount: c.recommended_offer.percentage,
      offer_type: c.recommended_offer.type,
      why: c.reason
    }));
    return {
      ok: true,
      total: scored.length,
      summary,                  // counts + value per segment, priority-sorted
      customers,                // the actual people to contact (with personal data)
      data_window: 'lifetime_rfm',
      guidance: 'פנה קודם לפלחים בעדיפות 1 (אסור לאבד / בסיכון) — שם ה-ROI הכי גבוה. השתמש ב-last_product כדי לכתוב הודעה אישית ("ראינו שאהבת X"), ובהצעה המומלצת לכל פלח (לא אותו אחוז לכולם).'
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// SEND SMS — send a single SMS to a specific number via TextMe. Respects opt-out.
// Used when the merchant asks the advisor directly to text someone (or to test).
// ---------------------------------------------------------------------------
async function sendSms(shop, options = {}) {
  try {
    if (!smsSender.isConfigured()) {
      return { ok: false, error: 'SMS לא מוגדר עדיין (חסרים מפתחות TextMe).' };
    }
    const phone = (options.phone || '').trim();
    const message = (options.message || '').trim();
    if (!phone) return { ok: false, error: 'חסר מספר טלפון.' };
    if (!message) return { ok: false, error: 'חסר תוכן הודעה.' };
    const r = await smsSender.sendOne(shop, { phone, message });
    if (r.ok) return { ok: true, sent_to: phone, note: 'ה-SMS נשלח.' };
    if (r.skipped) return { ok: false, error: 'הנמען הסיר את עצמו מדיוור — לא נשלח.' };
    return { ok: false, error: `שליחה נכשלה: ${r.error || 'לא ידוע'}`, detail: r.detail || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getAudienceCounts,
  getCollections,
  getTopCustomers,
  getDormantCustomers,
  getNeverPurchased,
  getRepeatCustomers,
  getCustomerProfile,
  searchCustomers,
  getTopProducts,
  getRevenueStats,
  getTryFitInsights,
  generateWhatsAppMessage,
  getCustomerPurchases,
  getStoreProducts,
  getAbandonedCheckouts,
  getCrossSellData,
  getCampaignPerformance,
  getProductVariants,
  getCustomerSizes,
  getTodayActivity,
  getNewestProducts,
  getRFMSegments,
  sendSms
};