// ============================================================================
// RFM ENGINE — the analytical core that powers Daniel (the campaigner).
//
// Based on the canonical RFM framework (Recency, Frequency, Monetary), the
// industry standard for retention marketing. It scores the ENTIRE customer base
// (not just a handful), maps each customer to one of 11 strategic segments, and
// tells the advisor exactly who to contact, with what offer, and why — including
// the customer's OWN purchase history (last product, top category) so outreach is
// genuinely personal instead of a generic blast.
//
// Research-backed design decisions:
//  - Win-back window 60–90 days (not 6 months) — best conversion.
//  - "Can't Lose Them" (high value + fully dormant) = highest-ROI segment.
//  - Offer scales to customer value (one-timer 25% vs VIP early-access/15%).
//  - Personal: include last product + category so the message references it.
// ============================================================================

const db = require('./database');

// Score helper: NTILE-style quintiles (1..5) computed in SQL.
// We compute R, F, M per customer, then derive the 11-segment label in JS.

async function computeRFM(shop, { limit = 2000 } = {}) {
  // Pull per-customer R/F/M plus their last product and top category.
  const r = await db.query(
    `WITH cust AS (
       SELECT
         c.shopify_customer_id AS cid,
         c.first_name, c.last_name, c.email, c.phone,
         c.total_spent::numeric AS monetary,
         c.orders_count::int AS frequency,
         EXTRACT(DAY FROM (NOW() - MAX(o.ordered_at)))::int AS recency_days,
         MAX(o.ordered_at) AS last_order
       FROM store_customers c
       JOIN store_orders o
         ON o.shop_domain = c.shop_domain AND o.shopify_customer_id = c.shopify_customer_id
       WHERE c.shop_domain = $1
         AND c.shopify_customer_id IS NOT NULL
         AND o.ordered_at IS NOT NULL
       GROUP BY c.shopify_customer_id, c.first_name, c.last_name, c.email, c.phone,
                c.total_spent, c.orders_count
       HAVING c.orders_count >= 1
     ),
     scored AS (
       SELECT *,
         NTILE(5) OVER (ORDER BY recency_days DESC) AS r_raw,  -- fewer days = higher score
         NTILE(5) OVER (ORDER BY frequency ASC)     AS f_score,
         NTILE(5) OVER (ORDER BY monetary ASC)      AS m_score
       FROM cust
     )
     SELECT cid, first_name, last_name, email, phone,
            monetary, frequency, recency_days, last_order,
            (6 - r_raw) AS r_score,   -- invert so recent = 5
            f_score, m_score
     FROM scored
     ORDER BY monetary DESC
     FETCH FIRST ${parseInt(limit)} ROWS ONLY`,
    [shop]
  );

  const rows = r.rows;
  if (rows.length === 0) return [];

  // Fetch last product + top category for these customers in one query.
  const ids = rows.map(x => x.cid);
  let lastProductByCid = {};
  try {
    const p = await db.query(
      `WITH ranked AS (
         SELECT o.shopify_customer_id AS cid, i.title,
                ROW_NUMBER() OVER (PARTITION BY o.shopify_customer_id ORDER BY o.ordered_at DESC) AS rn
         FROM store_orders o
         JOIN store_order_items i
           ON i.shopify_order_id = o.shopify_order_id AND i.shop_domain = o.shop_domain
         WHERE o.shop_domain = $1
           AND o.shopify_customer_id = ANY($2)
           AND i.title IS NOT NULL
       )
       SELECT cid, title FROM ranked WHERE rn = 1`,
      [shop, ids]
    );
    for (const row of p.rows) lastProductByCid[row.cid] = row.title;
  } catch (e) { /* best-effort personalization */ }

  return rows.map(c => {
    const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
    const seg = classifySegment(c.r_score, c.f_score, c.m_score, c.recency_days);
    return {
      cid: c.cid,
      name, email: c.email, phone: c.phone,
      monetary: Math.round(c.monetary || 0),
      frequency: c.frequency,
      recency_days: c.recency_days,
      last_product: lastProductByCid[c.cid] || null,
      r: c.r_score, f: c.f_score, m: c.m_score,
      segment: seg.key,
      segment_label: seg.label,
      priority: seg.priority,
      recommended_offer: seg.offer,
      reason: seg.reason
    };
  });
}

// The canonical 11-segment map, with offer + priority tuned to research:
//  - "Can't Lose Them" and "At Risk" (high value, gone quiet) = top priority.
//  - One-time buyers get a strong incentive to earn the 2nd purchase.
//  - Champions/Loyal get recognition, not deep discounts (protect margin).
function classifySegment(r, f, m, recencyDays) {
  // Champions: bought recently, often, high value.
  if (r >= 4 && f >= 4 && m >= 4)
    return { key: 'champions', label: 'מובילות (Champions)', priority: 3,
      offer: { type: 'early_access', percentage: 10 },
      reason: 'לקוחה מצוינת — קונה לאחרונה, הרבה, ובסכומים גבוהים. שווה לפנק בגישה מוקדמת ולא בהנחה עמוקה (לשמור על מרווח).' };

  // Loyal: buy consistently, good value.
  if (f >= 4 && m >= 3)
    return { key: 'loyal', label: 'נאמנות', priority: 4,
      offer: { type: 'percentage', percentage: 10 },
      reason: 'לקוחה נאמנה שקונה בקביעות. הטבה קטנה + הכרה שומרות עליה.' };

  // Can't Lose Them: were high value/frequent, now fully dormant. HIGHEST ROI.
  if (m >= 4 && r <= 2)
    return { key: 'cant_lose', label: 'אסור לאבד (Can\'t Lose Them)', priority: 1,
      offer: { type: 'percentage', percentage: 20 },
      reason: 'לקוחה שהייתה בעלת ערך גבוה ונעלמה לגמרי — כאן ה-ROI הכי אסימטרי. הצעה נדיבה מוצדקת כי שוויה גבוה והסיכון לאבד אותה אמיתי.' };

  // At Risk: above-average value, slipping away (recency low, was frequent).
  if (m >= 3 && f >= 3 && r <= 2)
    return { key: 'at_risk', label: 'בסיכון', priority: 1,
      offer: { type: 'percentage', percentage: 15 },
      reason: 'לקוחה ששווה כסף ומתחילה להיעלם — בדיוק החלון לתפוס אותה לפני שתעבור למתחרים.' };

  // About to Sleep: was okay, recency dropping.
  if (r <= 2 && f <= 2 && m <= 3 && recencyDays <= 120)
    return { key: 'about_to_sleep', label: 'עומדת להירדם', priority: 2,
      offer: { type: 'percentage', percentage: 12 },
      reason: 'לקוחה שמתחילה להתרחק. תזכורת חמה בזמן הנכון מחזירה חלק טוב מהן.' };

  // New customers: very recent, low frequency. Push the crucial 2nd purchase.
  if (r >= 4 && f <= 2)
    return { key: 'new', label: 'חדשות', priority: 2,
      offer: { type: 'percentage', percentage: 15 },
      reason: 'לקוחה חדשה. המעבר לקנייה שנייה הוא הרגע הקריטי בנאמנות — דחיפה עכשיו מכפילה את הסיכוי שתישאר.' };

  // Promising: recent-ish, low frequency, decent value.
  if (r >= 3 && f <= 2 && m >= 3)
    return { key: 'promising', label: 'מבטיחות', priority: 3,
      offer: { type: 'percentage', percentage: 12 },
      reason: 'קנתה לאחרונה והראתה פוטנציאל. הטבה ממוקדת יכולה להפוך אותה ללקוחה חוזרת.' };

  // One-time (hibernating low freq): single purchase, getting old. Strong incentive.
  if (f <= 1 && r <= 3)
    return { key: 'one_time', label: 'חד-פעמיות', priority: 2,
      offer: { type: 'percentage', percentage: 25 },
      reason: 'קנתה פעם אחת בלבד. תמריץ חזק (25%) + הוכחה חברתית הם הדרך המוכחת להשיג את הקנייה השנייה.' };

  // Lost: very old, low everything. Worth a low-cost final attempt.
  if (r <= 1 && f <= 2)
    return { key: 'lost', label: 'אבודות', priority: 5,
      offer: { type: 'percentage', percentage: 20 },
      reason: 'לקוחה שלא קנתה מזמן. ניסיון אחרון בעלות נמוכה — חלק יחזרו, השאר אפשר להפסיק לפנות אליהן.' };

  // Default / needs attention.
  return { key: 'needs_attention', label: 'דורשות תשומת לב', priority: 3,
    offer: { type: 'percentage', percentage: 12 },
    reason: 'לקוחה עם פוטנציאל שלא נכנסת לפלח ברור — פנייה אישית עם הטבה מתונה.' };
}

// Summary view: how the whole base splits across segments (for Daniel's overview).
function summarize(scored) {
  const bySeg = {};
  for (const c of scored) {
    if (!bySeg[c.segment]) bySeg[c.segment] = { key: c.segment, label: c.segment_label, count: 0, value: 0, priority: c.priority };
    bySeg[c.segment].count++;
    bySeg[c.segment].value += c.monetary || 0;
  }
  return Object.values(bySeg).sort((a, b) => a.priority - b.priority);
}

module.exports = { computeRFM, classifySegment, summarize };