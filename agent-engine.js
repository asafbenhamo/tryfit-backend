// agent-engine.js - The autonomous agent's execution brain.
// Takes an APPROVED plan (rows in agent_plans + agent_tasks) and executes the
// selected tasks one by one in the background. For each task it pulls the right
// customer segment fresh, then runs a batch campaign via campaign-engine.
//
// State lives in the DB (agent_plans/agent_tasks), so a server restart can
// resume any plan that was left 'running'. Between tasks it reads what worked
// (data-driven learning) to tune the next move.

const db = require('./database');
const aiTools = require('./ai-tools');
const campaignEngine = require('./campaign-engine');
const whatsappSender = require('./whatsapp-sender');
const waTemplates = require('./wa-templates');
const shopify = require('./shopify-client');
const compliance = require('./compliance');
let mailer = null;
try { mailer = require('./mailer'); } catch (e) { mailer = null; }

const TASK_GAP_MS = 3000; // small pause between moves

// Pull the customer segment for a given move type.
// Returns array of { name, email, phone, est_value }.
async function pullSegment(shop, task) {
  // The plan (and any edits via revise-plan) set est_customers = how many
  // customers this move should target. Honor it, capped at the campaign max.
  // Fall back to the campaign max only if no count was set.
  const requested = parseInt(task.est_customers) || 0;
  const cap = campaignEngine.MAX_PER_CAMPAIGN;
  const limit = requested > 0 ? Math.min(requested, cap) : cap;
  let rows = [];
  try {
    if (task.move_type === 'abandoned_cart') {
      const r = await aiTools.getAbandonedCheckouts(shop, { limit, days: 30 });
      rows = (r.recoverable_carts || r.carts || []).map(c => ({
        name: c.name || c.first_name || '', email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_price || 0),
        recovery_url: c.abandoned_checkout_url || null
      }));
    } else if (task.move_type === 'dormant_vip') {
      const r = await aiTools.getDormantCustomers(shop, { limit, daysInactive: 30, minSpent: 1000, excludeContacted: true });
      rows = (r.customers || []).map(c => ({
        name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0) * 0.15 // expect ~15% of lifetime as next order
      }));
    } else if (task.move_type === 'one_time') {
      // bought exactly once - nudge for a second order
      const r = await aiTools.getDormantCustomers(shop, { limit, daysInactive: 20, minSpent: 0, excludeContacted: true });
      rows = (r.customers || []).filter(c => (c.orders_count || 0) === 1).map(c => ({
        name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0)
      }));
    } else if (task.move_type === 'hot_product') {
      // promote a hot product to repeat buyers
      const r = await aiTools.getRepeatCustomers(shop, { limit, excludeContacted: true });
      rows = (r.customers || []).map(c => ({
        name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0) * 0.1
      }));
    } else if (task.move_type === 'rfm_segment') {
      // NEW: pull a specific RFM segment, carrying each customer's last product
      // so the message can be genuinely personal ("we saw you loved X").
      const segKey = (task.params && task.params.rfm_segment) || (task.segment) || null;
      const r = await aiTools.getRFMSegments(shop, { segment: segKey, limit });
      rows = (r.customers || []).map(c => ({
        name: c.name || '', email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0) * 0.15,
        last_product: c.last_product || null,
        rec_discount: c.recommended_discount || task.percentage || 10
      }));
    }
  } catch (e) {
    console.error(`[agent] pullSegment ${task.move_type} failed:`, e.message);
  }
  // keep only those with a contact method
  return rows.filter(c => c.email || c.phone).slice(0, limit);
}

// Build a default message template per move type. body may use {NAME} and {COUPON}.
function templateFor(task) {
  const pct = task.percentage || 10;
  const map = {
    abandoned_cart: {
      subject: 'שכחת משהו? 🛍️ העגלה שלך מחכה',
      body: `היי {NAME}! שמנו לב שהשארת כמה פריטים בעגלה ולא הספקת לסיים.\nשמרנו לך אותם, והנה קוד אישי של ${pct}% שיחכה לך: {COUPON}\nמחכים לראות אותך! 💛`
    },
    dormant_vip: {
      subject: 'התגעגענו אלייך 💛',
      body: `{NAME} היקרה, מזמן לא ראינו אותך ב-770 ובאמת התגעגענו!\nמגיע לך לפנק את עצמך - הכנו לך קוד אישי של ${pct}%: {COUPON}\nבואי לראות מה חדש, בחרנו דברים שבדיוק בסטייל שלך.`
    },
    one_time: {
      subject: 'יש לנו משהו בשבילך 🎁',
      body: `היי {NAME}! שמחנו שקנית אצלנו, ורצינו להזמין אותך לחזור.\nהנה קוד אישי של ${pct}% על הקנייה הבאה: {COUPON}\nמחכים לך! 💛`
    },
    hot_product: {
      subject: 'הפריט שכולן מדברות עליו 🔥',
      body: `{NAME}, יש לנו פריט חדש שעף מהמדפים וחשבנו שתאהבי!\nהנה קוד אישי של ${pct}% כדי שתתפסי אותו לפני שייגמר: {COUPON}`
    },
    rfm_segment: {
      subject: 'חשבנו עלייך 💜',
      body: `היי {NAME} 💜 {PRODUCT_LINE}שמרנו לך קוד אישי של ${pct}%: {COUPON}\nנשמח לראות אותך שוב! 🛍️`
    }
  };
  return map[task.move_type] || map.dormant_vip;
}

// Execute one task: pull segment -> send (manual prepare OR auto send) -> record.
async function runTask(shop, task, opts = {}) {
  const sendMode = opts.sendMode || 'manual';
  const templateName = opts.templateName || null;
  await db.query(`UPDATE agent_tasks SET status='running' WHERE id=$1`, [task.id]).catch(()=>{});

  const segment = await pullSegment(shop, task);
  if (segment.length === 0) {
    await db.query(`UPDATE agent_tasks SET status='skipped', finished_at=NOW(),
      result='{"reason":"no customers in segment"}'::jsonb WHERE id=$1`, [task.id]).catch(()=>{});
    return { sent: 0, skipped: 0, prepared: 0 };
  }

  // ---- AUTOMATIC: agent sends by itself (WhatsApp preferred, email fallback) ----
  if (sendMode === 'auto' && templateName) {
    const result = await runTaskAuto(shop, task, segment, templateName);
    await db.query(`UPDATE agent_tasks SET status='done', finished_at=NOW(), result=$2 WHERE id=$1`,
      [task.id, JSON.stringify(result)]).catch(()=>{});
    return result;
  }

  // ---- MANUAL (existing behavior): prepare wa.me squares via campaign engine ----
  let tmpl = templateFor(task);
  const segKey = (task.params && task.params.rfm_segment) || task.segment || null;

  // Maya writes segment-specific copy (AI) instead of the static template — the
  // messages stop looking like a generic blast. Fail-safe: static template stays.
  if (task.move_type === 'rfm_segment') {
    try {
      const copywriter = require('./copywriter');
      const ai = await copywriter.generateSegmentCopy(shop, {
        segment_key: segKey,
        segment_label: task.title || segKey,
        discount: task.percentage || 10,
        sample: segment.slice(0, 3).map(s => ({ name: s.name, last_product: s.last_product }))
      });
      if (ai && ai.body) tmpl = { subject: ai.subject, body: ai.body };
    } catch (e) { console.error('[agent] copywriter fallback:', e.message); }
  }

  const { id: campId } = campaignEngine.startCampaign(shop, {
    campaign_type: task.move_type,
    segment,
    segment_key: segKey,
    template: { percentage: task.percentage || 10, days_valid: 2, subject: tmpl.subject, body: tmpl.body }
  });

  let status = campaignEngine.getCampaignStatus(campId);
  while (status && (status.status === 'running' || status.status === 'stopping')) {
    await new Promise(r => setTimeout(r, 1500));
    status = campaignEngine.getCampaignStatus(campId);
  }

  const result = {
    campaign_id: campId,
    sent: status ? status.sent : 0,
    prepared: status ? status.prepared : 0,
    skipped: status ? status.skipped : 0,
    failed: status ? status.failed : 0,
    revenue_potential: status ? Math.round(status.revenue_potential || 0) : 0,
    whatsapp: status ? (status.whatsapp || []) : []
  };
  await db.query(`UPDATE agent_tasks SET status='done', finished_at=NOW(), result=$2 WHERE id=$1`,
    [task.id, JSON.stringify(result)]).catch(()=>{});
  return result;
}

// Automatic send: for each customer send the approved WhatsApp template if they
// have a phone, else email (free). Safety: respects working hours and opt-outs,
// creates the personal coupon only AFTER a successful send (no orphan coupons).
async function runTaskAuto(shop, task, segment, templateName) {
  // #3 Send window: never auto-send outside it, in the STORE's local time.
  if (!(await compliance.isWithinWorkingHours(shop))) {
    const st = await compliance.workingHoursStatus(shop);
    return {
      auto: true, sent: 0, sent_whatsapp: 0, sent_email: 0, failed: 0, prepared: 0,
      skipped_hours: segment.length, stopped_no_credits: false, whatsapp: [],
      note: `מחוץ לשעות השליחה (${st.window} ${st.timezone}, עכשיו ${st.local_hour}:00). הסוכן לא שלח.`
    };
  }

  const tpl = await waTemplates.getTemplate(shop, templateName);
  const tmpl = templateFor(task); // email subject/body fallback
  const pct = task.percentage || 10;
  let sentWa = 0, sentEmail = 0, failed = 0, skippedOptout = 0, noCredits = false;

  // Helper: create a personal coupon (called only after a successful send).
  // #5 unique-ish code: name + pct + 5 random chars (much lower collision chance).
  // Returns { code, priceRuleId } so we can delete the price rule on a failed send.
  const makeCoupon = async (name) => {
    try {
      const namePart = (name || 'VIP').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'VIP';
      const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
      const cc = await shopify.createDiscountCode(shop, {
        percentage: pct, days_valid: 2, combine: true,
        code: `${namePart}${pct}${rand}`, title: `סוכן אוטומטי: ${name || ''}`
      });
      return (cc && cc.ok) ? { code: cc.code, priceRuleId: cc.price_rule_id } : { code: null, priceRuleId: null };
    } catch (e) { return { code: null, priceRuleId: null }; }
  };

  const logAction = async (c, channel, coupon) => {
    await db.query(
      `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [shop, task.move_type || 'agent', c.email || null, c.phone || null,
       JSON.stringify({ customer_name: c.name, auto: true, agent: true, channel, template: templateName }), coupon]
    ).catch(()=>{});
  };

  for (const c of segment) {
    if (noCredits && c.phone) { failed++; continue; }

    // #2 Opt-out: never contact a customer who asked to stop (covers all move types,
    // including abandoned_cart which doesn't pass through ai-tools filtering).
    if (await compliance.isOptedOut(shop, { email: c.email, phone: c.phone })) {
      skippedOptout++;
      continue;
    }

    if (c.phone && tpl) {
      // Create the coupon (template needs the code); delete it if the send fails.
      const { code: coupon, priceRuleId } = await makeCoupon(c.name);
      const discountLabel = `${pct}%`;
      // #4 For abandoned carts, pass the recovery link as the dynamic URL suffix.
      const cartSuffix = (task.move_type === 'abandoned_cart' && c.recovery_url) ? c.recovery_url : (coupon || '');
      const valueMap = { name: c.name || 'לקוחה', coupon: coupon || '', discount: discountLabel, link: cartSuffix };
      const params = (tpl.body_vars || []).map(v => valueMap[v] != null ? valueMap[v] : '');
      const r = await whatsappSender.sendTemplate(shop, c.phone, templateName, params, {
        urlSuffix: cartSuffix, meta: { agent: true }
      });
      if (r.ok) { sentWa++; await logAction(c, 'whatsapp', coupon); }
      else if (r.reason === 'no_credits') {
        noCredits = true; failed++;
        if (priceRuleId) await shopify.deleteDiscountCode(shop, priceRuleId).catch(()=>{}); // #1 cleanup
      } else {
        failed++;
        if (priceRuleId) await shopify.deleteDiscountCode(shop, priceRuleId).catch(()=>{}); // #1 cleanup
      }
    } else if (c.email && mailer && mailer.sendEmail) {
      // Email fallback (free). Create coupon, send; clean up if send throws.
      const { code: coupon, priceRuleId } = await makeCoupon(c.name);
      try {
        const storeName = (shopify.getStore(shop)?.name) || (shop === 'seven770.myshopify.com' ? '770' : shop.replace('.myshopify.com',''));
        const storeUrl = shopify.getPublicDomain(shop);
        const body = tmpl.body.replace(/\{NAME\}/g, c.name || '').replace(/\{COUPON\}/g, coupon || '');
        const html = mailer.buildHtmlEmail(body, {
          brand: storeName, to: c.email,
          cta_url: storeUrl, cta_label: 'לאתר החנות',
          footer: `נשלח באמצעות היועץ החכם של ${storeName}`
        });
        const sent = await mailer.sendEmail({ to: c.email, subject: tmpl.subject, html, text: body });
        if (sent && sent.ok) { sentEmail++; await logAction(c, 'email', coupon); }
        else { failed++; if (priceRuleId) await shopify.deleteDiscountCode(shop, priceRuleId).catch(()=>{}); }
      } catch (e) {
        failed++;
        if (priceRuleId) await shopify.deleteDiscountCode(shop, priceRuleId).catch(()=>{}); // cleanup
      }
    } else {
      failed++;
    }
  }

  // #6 Clear, honest summary for the merchant.
  const parts = [];
  if (sentWa) parts.push(`${sentWa} ב-WhatsApp`);
  if (sentEmail) parts.push(`${sentEmail} במייל`);
  if (skippedOptout) parts.push(`${skippedOptout} דולגו (הוסרו מהדיוור)`);
  if (failed) parts.push(`${failed} נכשלו`);
  if (noCredits) parts.push(`נגמרו הקרדיטים באמצע`);

  return {
    auto: true,
    sent: sentWa + sentEmail,
    sent_whatsapp: sentWa,
    sent_email: sentEmail,
    skipped_optout: skippedOptout,
    failed,
    prepared: 0,
    stopped_no_credits: noCredits,
    whatsapp: [],
    note: parts.length ? ('הסוכן: ' + parts.join(', ') + '.') : 'לא נשלחו הודעות.'
  };
}

// #8 Lightweight learning: look at how each move type performed historically
// (conversion rate from advisor_actions) and nudge the discount for the next run.
// Moves that convert well keep a lean discount; moves that convert poorly get a
// small boost (capped) to try to lift them. Returns a map: move_type -> pct delta.
async function learnFromHistory(shop) {
  const tuning = {};
  try {
    const r = await db.query(
      `SELECT action_type,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome='converted')::int AS converted
       FROM advisor_actions
       WHERE shop_domain = $1
         AND created_at >= NOW() - INTERVAL '60 days'
         AND action_type NOT IN ('daily_report','morning_report')
       GROUP BY action_type`,
      [shop]
    );
    for (const row of r.rows) {
      if (row.total < 10) continue; // not enough data to learn from yet
      const rate = row.converted / row.total;
      // Poor (<5%): +3% discount boost. Strong (>20%): -2% (protect margin). Else 0.
      if (rate < 0.05) tuning[row.action_type] = 3;
      else if (rate > 0.20) tuning[row.action_type] = -2;
      else tuning[row.action_type] = 0;
    }
  } catch (e) { /* learning is best-effort, never blocks the run */ }
  return tuning;
}

// Run an entire approved plan: execute selected tasks by priority, one at a time.
async function runPlan(shop, planId) {
  await db.query(`UPDATE agent_plans SET status='running' WHERE id=$1`, [planId]).catch(()=>{});

  // Read the merchant's send choice for this plan (manual | auto + template).
  let sendMode = 'manual', templateName = null;
  try {
    const pr = await db.query(`SELECT send_mode, template_name FROM agent_plans WHERE id=$1`, [planId]);
    if (pr.rows[0]) { sendMode = pr.rows[0].send_mode || 'manual'; templateName = pr.rows[0].template_name || null; }
  } catch (e) { /* columns may not exist on old tables -> manual */ }

  // #8 Learn from the last 60 days before executing this plan.
  const tuning = await learnFromHistory(shop);

  const tasks = await db.query(
    `SELECT * FROM agent_tasks WHERE plan_id=$1 AND selected=TRUE AND status='pending' ORDER BY priority ASC`,
    [planId]
  );

  for (const task of tasks.rows) {
    // Re-check plan wasn't stopped
    const p = await db.query(`SELECT status FROM agent_plans WHERE id=$1`, [planId]);
    if (p.rows[0] && p.rows[0].status === 'stopped') {
      console.log(`🛑 [Agent] plan ${planId} stopped, halting remaining tasks`);
      break;
    }
    // Apply learned tuning to this move's discount (capped 5-25%).
    const delta = tuning[task.move_type] || 0;
    if (delta !== 0) {
      const base = task.percentage || 10;
      task.percentage = Math.max(5, Math.min(25, base + delta));
      console.log(`🧠 [Agent] tuned ${task.move_type}: ${base}% -> ${task.percentage}% (history)`);
    }
    try {
      const r = await runTask(shop, task, { sendMode, templateName });
      console.log(`✅ [Agent] task ${task.id} (${task.move_type}): ${r.sent} sent, ${r.prepared} prepared`);
    } catch (e) {
      console.error(`[agent] task ${task.id} failed:`, e.message);
      await db.query(`UPDATE agent_tasks SET status='failed', finished_at=NOW(), result=$2 WHERE id=$1`,
        [task.id, JSON.stringify({ error: e.message })]).catch(()=>{});
    }
    await new Promise(r => setTimeout(r, TASK_GAP_MS));
  }

  await db.query(`UPDATE agent_plans SET status='done', finished_at=NOW() WHERE id=$1 AND status<>'stopped'`, [planId]).catch(()=>{});
  console.log(`🏁 [Agent] plan ${planId} complete`);
}

// Kick off a plan in the background (non-blocking).
function startPlan(shop, planId) {
  runPlan(shop, planId).catch(err => {
    console.error('[agent] fatal:', err.message);
    db.query(`UPDATE agent_plans SET status='error' WHERE id=$1`, [planId]).catch(()=>{});
  });
}

// Stop a running plan.
// `shop` scopes the write. Plan ids are sequential integers, so without it any
// merchant could stop another merchant's plan just by counting upward.
async function stopPlan(planId, shop) {
  const r = shop
    ? await db.query(`UPDATE agent_plans SET status='stopped', finished_at=NOW() WHERE id=$1 AND shop_domain=$2`, [planId, shop]).catch(() => ({ rowCount: 0 }))
    : await db.query(`UPDATE agent_plans SET status='stopped', finished_at=NOW() WHERE id=$1`, [planId]).catch(() => ({ rowCount: 0 }));
  if (shop && !r.rowCount) return { ok: false, error: 'not found' };
  return { ok: true };
}

// Get plan + tasks status (for live UI).
// Reading a plan exposes the customers it targets, so it is scoped by shop too.
async function getPlanStatus(planId, shop) {
  const plan = shop
    ? await db.query(`SELECT * FROM agent_plans WHERE id=$1 AND shop_domain=$2`, [planId, shop])
    : await db.query(`SELECT * FROM agent_plans WHERE id=$1`, [planId]);
  if (plan.rows.length === 0) return null;
  const tasks = await db.query(`SELECT id, priority, move_type, title, status, result, est_customers, projected_revenue, params FROM agent_tasks WHERE plan_id=$1 ORDER BY priority ASC`, [planId]);
  return { plan: plan.rows[0], tasks: tasks.rows };
}

// On startup: resume any plan left 'running' (server restarted mid-execution).
async function resumeInterruptedPlans() {
  try {
    const r = await db.query(`SELECT id, shop_domain FROM agent_plans WHERE status='running'`);
    for (const row of r.rows) {
      console.log(`🔄 [Agent] resuming interrupted plan ${row.id}`);
      startPlan(row.shop_domain, row.id);
    }
  } catch (e) {
    console.error('[agent] resume failed:', e.message);
  }
}

module.exports = { startPlan, stopPlan, getPlanStatus, resumeInterruptedPlans, runTask, pullSegment, templateFor };