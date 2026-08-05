// ============================================================================
// MORNING BRIEF — the autonomous "while you slept" report.
//
// This is the heart of the autonomous experience the merchant signed up for:
// open the app in the morning and see (1) what closed overnight, (2) a ready-made
// plan for today built on RFM analysis, prioritized by ROI. The merchant approves
// once; the agent executes all day.
//
// Returns a structured object the UI renders as the morning card.
// ============================================================================

const db = require('./database');
const rfmEngine = require('./rfm-engine');
const storeTime = require('./store-time');

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (e) { console.error(`[morning-brief] ${label}:`, e.message); return fallback; }
}

async function getMorningBrief(shop) {
  // 1. What happened overnight: conversions + revenue closed since yesterday 9am.
  const overnight = await safe('overnight', async () => {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE outcome='converted' AND closed_at >= NOW() - INTERVAL '24 hours')::int AS conversions,
         COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted' AND closed_at >= NOW() - INTERVAL '24 hours'),0)::numeric AS revenue,
         COUNT(*) FILTER (WHERE outcome='pending')::int AS pending
       FROM advisor_actions WHERE shop_domain=$1`,
      [shop]
    );
    const row = r.rows[0] || {};
    return {
      conversions: row.conversions || 0,
      revenue: Math.round(parseFloat(row.revenue || 0)),
      pending: row.pending || 0
    };
  }, { conversions: 0, revenue: 0, pending: 0 });

  // 2. Today's opportunity: RFM analysis of the whole base, top priority segments.
  const plan = await safe('plan', async () => {
    const scored = await rfmEngine.computeRFM(shop, { limit: 2000 });
    if (scored.length === 0) return { moves: [], total_customers: 0, projected: 0 };
    const summary = rfmEngine.summarize(scored);

    // LEARNING LOOP: real historical performance per segment (last 90 days).
    // revenue-per-contact = attributed ₪ / contacts. With enough data (>=10
    // contacts) the projection uses REAL numbers instead of the generic estimate —
    // so the advisor gets smarter with every campaign it runs.
    let perf = {};
    try {
      const h = await db.query(
        `SELECT details->>'segment' AS seg,
                COUNT(*)::int AS contacts,
                COUNT(*) FILTER (WHERE outcome='converted')::int AS conversions,
                COALESCE(SUM(attributed_revenue) FILTER (WHERE outcome='converted'),0)::numeric AS revenue
         FROM advisor_actions
         WHERE shop_domain=$1 AND details->>'segment' IS NOT NULL
           AND created_at > NOW() - INTERVAL '90 days'
         GROUP BY details->>'segment'`, [shop]);
      for (const row of h.rows) {
        perf[row.seg] = {
          contacts: row.contacts,
          conversions: row.conversions,
          rev_per_contact: row.contacts > 0 ? parseFloat(row.revenue) / row.contacts : 0
        };
      }
    } catch (e) { /* no history yet — use estimates */ }

    // Build prioritized moves from the highest-ROI segments (priority 1 & 2).
    const moves = [];
    const priorityKeys = ['cant_lose', 'at_risk', 'about_to_sleep', 'one_time', 'new'];
    for (const seg of summary) {
      if (!priorityKeys.includes(seg.key)) continue;
      if (seg.count === 0) continue;
      const sample = scored.find(c => c.segment === seg.key);
      const pct = sample ? sample.recommended_offer.percentage : 12;
      const hist = perf[seg.key];
      let projected, basis;
      if (hist && hist.contacts >= 10) {
        // Real data: what a contact in this segment actually produced historically.
        projected = Math.round(hist.rev_per_contact * seg.count);
        basis = `מבוסס ביצועים אמיתיים: ${hist.conversions}/${hist.contacts} המרות ב-90 הימים האחרונים`;
      } else {
        // Not enough history yet — conservative estimate.
        projected = Math.round(seg.value * 0.12);
        basis = 'הערכה ראשונית (עוד אין מספיק היסטוריה לפלח הזה)';
      }
      moves.push({
        segment: seg.key,
        label: seg.label,
        customers: seg.count,
        discount: pct,
        projected_revenue: projected,
        basis,
        why: sample ? sample.reason : ''
      });
    }
    // Sort by projected revenue (biggest opportunity first).
    moves.sort((a, b) => b.projected_revenue - a.projected_revenue);
    const projected = moves.reduce((s, m) => s + m.projected_revenue, 0);
    const totalCustomers = moves.reduce((s, m) => s + m.customers, 0);
    return { moves: moves.slice(0, 4), total_customers: totalCustomers, projected, segments: summary };
  }, { moves: [], total_customers: 0, projected: 0 });

  // 3. A warm, human greeting line — in the STORE's local time, so a New York
  //    merchant opening the app at 9am is not greeted with "good evening".
  const tz = await storeTime.tzForShop(shop);
  const hour = storeTime.hourIn(tz);
  const greeting = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';

  return {
    ok: true,
    greeting,
    timezone: tz,
    local_hour: hour,
    overnight,
    plan,
    generated_at: new Date().toISOString()
  };
}

module.exports = { getMorningBrief };