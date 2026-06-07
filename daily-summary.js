// daily-summary.js - The advisor's daily briefing (principle 5).
// "What changed, what I did, what I achieved, what's next."
// Aggregates the last 24h across orders, advisor actions, and opportunities.
// All queries are safe-wrapped so one failure never breaks the summary.

const db = require('./database');
const insightsEngine = require('./insights-engine');

async function safe(label, fn, fallback) {
  try { return await fn(); }
  catch (e) { console.error(`[daily-summary] ${label} failed:`, e.message); return fallback; }
}

async function getDailySummary(shop) {
  // 1. What changed: orders + revenue in the last 24h vs the previous 24h
  const sales = await safe('sales', async () => {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE ordered_at >= NOW() - INTERVAL '24 hours')::int AS orders_today,
         COALESCE(SUM(total_price) FILTER (WHERE ordered_at >= NOW() - INTERVAL '24 hours'),0)::numeric(12,2) AS revenue_today,
         COUNT(*) FILTER (WHERE ordered_at >= NOW() - INTERVAL '48 hours' AND ordered_at < NOW() - INTERVAL '24 hours')::int AS orders_yesterday,
         COALESCE(SUM(total_price) FILTER (WHERE ordered_at >= NOW() - INTERVAL '48 hours' AND ordered_at < NOW() - INTERVAL '24 hours'),0)::numeric(12,2) AS revenue_yesterday
       FROM store_orders
       WHERE shop_domain = $1 AND financial_status NOT IN ('voided','refunded')`,
      [shop]
    );
    return r.rows[0] || {};
  }, {});

  // 2. What I did: advisor actions in the last 24h
  const actions = await safe('actions', async () => {
    const r = await db.query(
      `SELECT
         COUNT(*)::int AS actions_today,
         COUNT(*) FILTER (WHERE action_type LIKE '%email%')::int AS emails,
         COUNT(*) FILTER (WHERE action_type LIKE '%whatsapp%')::int AS whatsapps,
         COUNT(*) FILTER (WHERE coupon_code IS NOT NULL)::int AS coupons
       FROM advisor_actions
       WHERE shop_domain = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [shop]
    );
    return r.rows[0] || {};
  }, {});

  // 3. What I achieved: conversions + revenue attributed (all-time + last 24h)
  const achieved = await safe('achieved', async () => {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric(12,2) AS total_revenue,
         COUNT(*) FILTER (WHERE outcome='converted')::int AS total_conversions,
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted' AND closed_at >= NOW() - INTERVAL '24 hours'),0)::numeric(12,2) AS revenue_today,
         COUNT(*) FILTER (WHERE outcome='converted' AND closed_at >= NOW() - INTERVAL '24 hours')::int AS conversions_today,
         COUNT(*) FILTER (WHERE outcome='pending')::int AS pending
       FROM advisor_actions
       WHERE shop_domain = $1`,
      [shop]
    );
    return r.rows[0] || {};
  }, {});

  // 4. What's next: top opportunities right now
  const opportunities = await safe('opportunities', async () => {
    const ins = await insightsEngine.getInsights(shop);
    return ins.insights || [];
  }, []);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    changed: {
      orders_today: sales.orders_today || 0,
      revenue_today: Math.round(parseFloat(sales.revenue_today || 0)),
      orders_yesterday: sales.orders_yesterday || 0,
      revenue_yesterday: Math.round(parseFloat(sales.revenue_yesterday || 0))
    },
    did: {
      actions: actions.actions_today || 0,
      emails: actions.emails || 0,
      whatsapps: actions.whatsapps || 0,
      coupons: actions.coupons || 0
    },
    achieved: {
      total_revenue: Math.round(parseFloat(achieved.total_revenue || 0)),
      total_conversions: achieved.total_conversions || 0,
      revenue_today: Math.round(parseFloat(achieved.revenue_today || 0)),
      conversions_today: achieved.conversions_today || 0,
      pending: achieved.pending || 0
    },
    next: opportunities.slice(0, 3)
  };
}

module.exports = { getDailySummary };