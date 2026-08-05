// ============================================================================
// POLICY ENGINE — the part that makes the agent get better instead of just busy.
//
// Until now the system MEASURED (morning-brief computed revenue-per-contact per
// segment) but never DECIDED with it: the number was printed on a card and the
// merchant chose. This module closes that loop. It reads what actually happened,
// scores every option, and returns the move to make — then records the choice so
// the next round can score it too.
//
// Three things it has to get right:
//
// 1. SMALL SAMPLES LIE. A segment contacted 3 times where one person happened to
//    buy looks infinitely better than one contacted 400 times at a steady 9%.
//    Every score is shrunk toward the shop's own overall revenue-per-contact
//    (empirical Bayes). With few observations a segment scores near the shop
//    average; only sustained evidence moves it. Nothing is "best" by luck.
//
// 2. MEASURING WHAT YOU ALREADY CHOSE TEACHES NOTHING NEW. If the agent only
//    ever contacts the segment that currently looks best, it can never find out
//    that a different offer would have done better — it converges on the first
//    thing that worked and stays there. So a slice of traffic is deliberately
//    spent on alternatives (epsilon-greedy).
//
// 3. ATTRIBUTED REVENUE IS NOT INCREMENTAL REVENUE. A customer who was going to
//    buy anyway, who clicks the link and uses the coupon, is counted as a win by
//    the attribution engine. That inflates every number. So a HOLDOUT slice gets
//    no message at all, and their purchase rate is measured from real orders.
//    The gap between contacted and held-out is what the agent actually added.
//    This is the number the 5%-of-sales pricing has to stand on.
//
// Everything degrades safely: with no history at all, the policy returns the
// same conservative defaults the system used before.
// ============================================================================

const db = require('./database');

// --- tuning ---------------------------------------------------------------
const LOOKBACK_DAYS = 90;      // how far back performance is read
const SHRINK_WEIGHT = 30;      // pseudo-contacts pulling a score toward the shop mean
const MIN_TO_EXPLOIT = 50;     // below this an arm is never treated as "known good"
const MIN_TO_SUPPRESS = 60;    // never switch an arm off on thin evidence
const SUPPRESS_RATIO = 0.25;   // ...and only if it earns <25% of the shop average
const EXPLORE_RATE = 0.15;     // share of picks spent on alternatives
// Share of customers deliberately left uncontacted so incremental lift can be
// measured. OFF by default (product decision): the agent contacts everyone it
// can, and revenue is reported the way every marketing platform reports it —
// attributed, including sales that might have happened anyway.
//
// Turning this off costs ONLY the "what did the agent add over doing nothing"
// number. It does not affect learning: the policy compares arms against each
// other (this segment vs that one, 15% vs 20%), which needs no control group.
// Set to e.g. 0.10 to switch incremental measurement back on.
const HOLDOUT_RATE = 0;
const ATTRIBUTION_WINDOW_DAYS = 7; // purchase window used for holdout comparison

// Offers the agent is allowed to choose between. Kept coarse on purpose: finer
// buckets split the data thinner and slow learning down for no real gain.
const DISCOUNT_ARMS = [10, 15, 20, 25];
const CHANNEL_ARMS = ['email', 'sms', 'whatsapp'];

function bucketDiscount(pct) {
  const n = parseInt(pct, 10);
  if (isNaN(n)) return null;
  let best = DISCOUNT_ARMS[0], dist = Infinity;
  for (const a of DISCOUNT_ARMS) { const d = Math.abs(a - n); if (d < dist) { dist = d; best = a; } }
  return best;
}

async function safe(label, fn, fallback) {
  try { return await fn(); }
  catch (e) { console.error(`[policy] ${label}:`, e.message); return fallback; }
}

// ---------------------------------------------------------------------------
// LEARN — read outcomes and turn them into scores.
//
// Returns { prior, segments:{}, discounts:{}, channels:{}, total } where each
// entry is { contacts, conversions, revenue, raw, score, confident, suppressed }.
//   raw   = revenue / contacts          (what actually happened)
//   score = shrunk toward `prior`       (what we're willing to bet on)
// ---------------------------------------------------------------------------
async function learn(shop, opts = {}) {
  const days = opts.days || LOOKBACK_DAYS;

  // WINSORIZING CAP. Order values are heavy-tailed: one wedding-sized order can
  // be 50x a typical one. Left uncapped, a single whale landing on one arm makes
  // that arm look permanently best, and an agent running unattended for months
  // would keep steering everything toward it. Each conversion is therefore
  // counted at no more than the shop's own 90th-percentile order — the arm still
  // gets full credit for converting, just not for the size of one lucky basket.
  const cap = await safe('cap', async () => {
    const r = await db.query(
      `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY attributed_revenue)::numeric AS p90
         FROM advisor_actions
        WHERE shop_domain=$1 AND outcome='converted' AND attributed_revenue > 0
          AND created_at > NOW() - ($2 || ' days')::interval`,
      [shop, String(days)]);
    const p90 = r.rows[0] && parseFloat(r.rows[0].p90);
    return (p90 && p90 > 0) ? p90 : null;
  }, null);
  // No history -> no cap to apply; LEAST(x, NULL) is NULL in SQL, so use a
  // sentinel that can never bind below a real value.
  const capParam = cap === null ? Number.MAX_SAFE_INTEGER : cap;

  const overall = await safe('overall', async () => {
    const r = await db.query(
      `SELECT COUNT(*)::int AS contacts,
              COUNT(*) FILTER (WHERE outcome='converted')::int AS conversions,
              COALESCE(SUM(LEAST(attributed_revenue, $3::numeric)) FILTER (WHERE outcome='converted'),0)::numeric AS revenue
         FROM advisor_actions
        WHERE shop_domain=$1
          AND created_at > NOW() - ($2 || ' days')::interval
          AND COALESCE(details->>'control','') <> 'true'`,
      [shop, String(days), capParam]);
    return r.rows[0] || {};
  }, {});

  const contacts = parseInt(overall.contacts, 10) || 0;
  const revenue = parseFloat(overall.revenue) || 0;
  // The shop's own average is the prior. Before any history exists we fall back
  // to a deliberately low number so nothing looks good until it has earned it.
  const prior = contacts > 0 ? revenue / contacts : 0;

  async function byDimension(sqlExpr) {
    return safe('byDimension', async () => {
      const r = await db.query(
        `SELECT ${sqlExpr} AS arm,
                COUNT(*)::int AS contacts,
                COUNT(*) FILTER (WHERE outcome='converted')::int AS conversions,
                COALESCE(SUM(LEAST(attributed_revenue, $3::numeric)) FILTER (WHERE outcome='converted'),0)::numeric AS revenue
           FROM advisor_actions
          WHERE shop_domain=$1
            AND created_at > NOW() - ($2 || ' days')::interval
            AND COALESCE(details->>'control','') <> 'true'
            AND ${sqlExpr} IS NOT NULL
          GROUP BY 1`,
        [shop, String(days), capParam]);
      const out = {};
      for (const row of r.rows) {
        const c = row.contacts, rev = parseFloat(row.revenue) || 0;
        // Empirical-Bayes shrinkage: pretend we also saw SHRINK_WEIGHT contacts
        // that performed exactly at the shop average.
        const score = (rev + SHRINK_WEIGHT * prior) / (c + SHRINK_WEIGHT);
        out[String(row.arm)] = {
          contacts: c,
          conversions: row.conversions,
          revenue: Math.round(rev),
          raw: c > 0 ? rev / c : 0,
          score,
          confident: c >= MIN_TO_EXPLOIT,
          suppressed: c >= MIN_TO_SUPPRESS && prior > 0 && score < prior * SUPPRESS_RATIO
        };
      }
      return out;
    }, {});
  }

  const [segments, discounts, channels] = await Promise.all([
    byDimension(`details->>'segment'`),
    byDimension(`details->>'discount_arm'`),
    byDimension(`details->>'channel'`)
  ]);

  return {
    shop, days, prior,
    outlier_cap: cap,
    total: { contacts, conversions: parseInt(overall.conversions, 10) || 0, revenue: Math.round(revenue) },
    segments, discounts, channels
  };
}

// ---------------------------------------------------------------------------
// CHOOSE — pick an arm, sometimes exploring.
// `candidates` are the arms available right now; suppressed ones are dropped
// unless that would leave nothing to pick.
// ---------------------------------------------------------------------------
function chooseArm(stats, candidates, rng = Math.random) {
  const arms = (candidates || []).filter(Boolean).map(String);
  if (arms.length === 0) return { arm: null, why: 'no_candidates' };

  const live = arms.filter(a => !(stats[a] && stats[a].suppressed));
  const pool = live.length > 0 ? live : arms;   // never suppress everything
  if (pool.length === 1) return { arm: pool[0], why: 'only_option' };

  // Explore: spend a slice on something other than the current favourite so the
  // agent keeps learning instead of locking onto its first success.
  if (rng() < EXPLORE_RATE) {
    const pick = pool[Math.floor(rng() * pool.length)];
    return { arm: pick, why: 'explore' };
  }

  // Exploit ONLY among arms that cleared the evidence bar. Shrinkage alone is
  // not enough here: revenue is heavy-tailed, so a single outlier order on a
  // 2-contact arm can still out-score a 400-contact arm with a steady record.
  // Arms without evidence are not eligible to win — they earn their evidence
  // through the exploration slice above, which is exactly what it is for.
  const confident = pool.filter(a => stats[a] && stats[a].confident);
  if (confident.length === 0) {
    const pick = pool[Math.floor(rng() * pool.length)];
    return { arm: pick, why: 'no_evidence_yet' };
  }
  let best = null, bestScore = -Infinity;
  for (const a of confident) {
    const score = stats[a].score;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return { arm: best, why: 'exploit', score: bestScore };
}

// Rank segments worth contacting today, best expected value first.
// `available` = [{ key, count, value, discount }] from the RFM summary.
function rankSegments(stats, available) {
  return (available || [])
    .filter(s => s && s.key && s.count > 0)
    .map(s => {
      const st = stats.segments[s.key];
      // Expected value = what one contact in this segment is worth * how many
      // customers are in it. With no history the shop prior stands in.
      const perContact = st ? st.score : stats.prior;
      return {
        ...s,
        per_contact: perContact,
        expected: Math.round(perContact * s.count),
        contacts_seen: st ? st.contacts : 0,
        suppressed: !!(st && st.suppressed),
        basis: st
          ? (st.confident
              ? `נמדד: ${st.conversions}/${st.contacts} המרות ב-${stats.days} יום`
              : `מדגם קטן (${st.contacts} פניות) — משוקלל מול ממוצע החנות`)
          : 'אין עדיין היסטוריה לפלח הזה'
      };
    })
    .filter(s => !s.suppressed)
    .sort((a, b) => b.expected - a.expected);
}

// ---------------------------------------------------------------------------
// DECIDE — the single call the autopilot makes per segment.
// ---------------------------------------------------------------------------
function decide(stats, segment, opts = {}) {
  const rng = opts.rng || Math.random;
  const allowedChannels = opts.allowedChannels || CHANNEL_ARMS;

  const discount = chooseArm(stats.discounts, DISCOUNT_ARMS, rng);
  const channel = chooseArm(stats.channels, allowedChannels, rng);

  return {
    segment,
    discount: parseInt(discount.arm, 10) || (opts.defaultDiscount || 15),
    discount_why: discount.why,
    channel: channel.arm || 'email',
    channel_why: channel.why,
    exploring: discount.why !== 'exploit' || channel.why !== 'exploit'
  };
}

// Should this particular customer be held out (deliberately not contacted)?
// With HOLDOUT_RATE at 0 this is always false and every eligible customer gets
// contacted. Stable per customer+day when enabled, so the same person is not
// held out on one channel and contacted on another.
function isHoldout(shop, customerKey, dayKey, rate = HOLDOUT_RATE) {
  if (!rate || rate <= 0) return false;
  if (!customerKey) return false;
  const s = `${shop}|${customerKey}|${dayKey}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000 < rate;
}

// ---------------------------------------------------------------------------
// MEASURE LIFT — the honest number.
//
// Compares customers the agent contacted against customers it deliberately did
// not, on the same signal: did they place a real order within the window?
// Attribution is not used here at all — it only sees people who were contacted,
// so it cannot answer "would they have bought anyway".
// ---------------------------------------------------------------------------
async function measureLift(shop, opts = {}) {
  const days = opts.days || 30;
  const win = opts.window || ATTRIBUTION_WINDOW_DAYS;

  return safe('measureLift', async () => {
    const r = await db.query(
      `WITH touched AS (
         SELECT LOWER(a.target_email) AS email,
                MIN(a.created_at) AS at,
                (COALESCE(a.details->>'control','') = 'true') AS is_control
           FROM advisor_actions a
          WHERE a.shop_domain = $1
            AND a.target_email IS NOT NULL AND a.target_email <> ''
            AND a.created_at > NOW() - ($2 || ' days')::interval
          GROUP BY LOWER(a.target_email), (COALESCE(a.details->>'control','') = 'true')
       ),
       outcome AS (
         SELECT t.email, t.is_control,
                EXISTS (
                  SELECT 1 FROM store_orders o
                    JOIN store_customers c
                      ON c.shop_domain = o.shop_domain
                     AND c.shopify_customer_id = o.shopify_customer_id
                   WHERE o.shop_domain = $1
                     AND LOWER(c.email) = t.email
                     AND o.ordered_at >= t.at
                     AND o.ordered_at < t.at + ($3 || ' days')::interval
                ) AS bought,
                COALESCE((
                  SELECT SUM(o.total_price) FROM store_orders o
                    JOIN store_customers c
                      ON c.shop_domain = o.shop_domain
                     AND c.shopify_customer_id = o.shopify_customer_id
                   WHERE o.shop_domain = $1
                     AND LOWER(c.email) = t.email
                     AND o.ordered_at >= t.at
                     AND o.ordered_at < t.at + ($3 || ' days')::interval
                ), 0) AS revenue
           FROM touched t
       )
       SELECT is_control,
              COUNT(*)::int AS people,
              COUNT(*) FILTER (WHERE bought)::int AS buyers,
              COALESCE(SUM(revenue),0)::numeric AS revenue
         FROM outcome
        GROUP BY is_control`,
      [shop, String(days), String(win)]);

    const side = (isControl) => {
      const row = r.rows.find(x => x.is_control === isControl);
      const people = row ? row.people : 0;
      const buyers = row ? row.buyers : 0;
      const revenue = row ? parseFloat(row.revenue) || 0 : 0;
      return {
        people, buyers,
        revenue: Math.round(revenue),
        conversion_rate: people > 0 ? buyers / people : 0,
        revenue_per_person: people > 0 ? revenue / people : 0
      };
    };

    const contacted = side(false), control = side(true);
    // Enough of a control group to say anything at all?
    const usable = control.people >= 30 && contacted.people >= 30;
    const liftPerPerson = contacted.revenue_per_person - control.revenue_per_person;

    return {
      ok: true, days, window_days: win,
      contacted, control, usable,
      lift_per_person: liftPerPerson,
      lift_pct: control.revenue_per_person > 0
        ? (liftPerPerson / control.revenue_per_person)
        : null,
      // What the agent plausibly ADDED, as opposed to what it got credit for.
      incremental_revenue: usable ? Math.round(liftPerPerson * contacted.people) : null,
      note: usable
        ? 'מבוסס על השוואה לקבוצת ביקורת שלא קיבלה פנייה'
        : 'עוד אין מספיק נתונים בקבוצת הביקורת כדי למדוד תרומה אמיתית'
    };
  }, { ok: false });
}

// ---------------------------------------------------------------------------
// THE SMART-OUTREACH GATE.
//
// The promise is 500 GENUINELY personal outreaches a day, not 500 blasts. With
// a human approving each batch, judgement supplied that bar. Running unattended,
// something has to enforce it — otherwise volume quietly becomes spam and the
// merchant's list burns out, which costs far more than the campaign earns.
//
// Signals split into two kinds, because they are not interchangeable:
//
//   VISIBLE   — things the recipient can see are about HER: a product she
//               actually bought, named in the text; the contents of her cart.
//   TARGETING — things that make the send smarter but that she cannot perceive:
//               a segment-tuned discount, a send hour learned from her orders.
//
// A naive "any 2 of 3" bar is not a bar at all: the targeting signals are
// nearly always present (the offer always comes from the policy, most repeat
// buyers have a personal hour), so "Hi Dana, here's 15% off" sent at 2pm would
// score 2 and pass — which is exactly the generic blast this is meant to stop.
//
// So: at least one VISIBLE signal is REQUIRED, plus one more of either kind.
// A customer we know nothing specific about simply does not get contacted by
// the unattended agent. Fewer messages, every one of them real.
//
// Returns { ok, signals, missing } — callers must not send when ok is false.
// ---------------------------------------------------------------------------
const MIN_SIGNALS = 2;
const VISIBLE_SIGNALS = ['named_product', 'named_cart'];

function isSmartOutreach(message, ctx = {}) {
  const body = String(message || '').toLowerCase();
  const signals = [];

  // Naming a thing only counts if it actually appears in the text. Having it on
  // record and not using it is not personalization.
  const mentions = (v) => {
    const s = String(v || '').trim();
    return s.length >= 3 && body.includes(s.toLowerCase());
  };

  if (mentions(ctx.last_product)) signals.push('named_product');
  if (Array.isArray(ctx.cart_items) && ctx.cart_items.some(mentions)) signals.push('named_cart');
  if (ctx.segment && ctx.segment_specific_offer) signals.push('segment_offer');
  if (ctx.personal_hour != null && ctx.personal_hour !== ctx.default_hour) signals.push('personal_hour');

  const visible = signals.filter(s => VISIBLE_SIGNALS.includes(s));
  const all = ['named_product', 'named_cart', 'segment_offer', 'personal_hour'];

  return {
    ok: visible.length >= 1 && signals.length >= MIN_SIGNALS,
    signals,
    visible,
    missing: all.filter(s => !signals.includes(s)),
    required: MIN_SIGNALS,
    reason: visible.length === 0
      ? 'no_customer_visible_personalization'
      : (signals.length < MIN_SIGNALS ? 'not_enough_signals' : null)
  };
}

module.exports = {
  learn, chooseArm, rankSegments, decide, isHoldout, measureLift, bucketDiscount,
  isSmartOutreach, MIN_SIGNALS, VISIBLE_SIGNALS,
  DISCOUNT_ARMS, CHANNEL_ARMS,
  EXPLORE_RATE, HOLDOUT_RATE, MIN_TO_EXPLOIT, MIN_TO_SUPPRESS, SUPPRESS_RATIO, SHRINK_WEIGHT
};
