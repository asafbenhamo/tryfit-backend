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
        est_value: parseFloat(c.total_price || 0)
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
  const tmpl = templateFor(task);
  const { id: campId } = campaignEngine.startCampaign(shop, {
    campaign_type: task.move_type,
    segment,
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

// Automatic send: for each customer create a personal coupon, then send the
// approved WhatsApp template if they have a phone, else send an email (free).
async function runTaskAuto(shop, task, segment, templateName) {
  const tpl = await waTemplates.getTemplate(shop, templateName);
  const tmpl = templateFor(task); // for email subject/body fallback
  const pct = task.percentage || 10;
  let sentWa = 0, sentEmail = 0, failed = 0, noCredits = false;

  for (const c of segment) {
    if (noCredits && c.phone) { failed++; continue; } // out of credits, skip further WA
    // Personal coupon
    let coupon = null;
    try {
      const namePart = (c.name || 'VIP').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'VIP';
      const suffix = Math.floor(Math.random() * 900 + 100);
      const cc = await shopify.createDiscountCode(shop, {
        percentage: pct, days_valid: 2, combine: true,
        code: `${namePart}${pct}${suffix}`, title: `סוכן אוטומטי: ${c.name || ''}`
      });
      if (cc && cc.ok) coupon = cc.code;
    } catch (e) {}

    // Log the action (attribution) regardless of channel.
    const logAction = async (channel) => {
      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [shop, task.move_type || 'agent', c.email || null, c.phone || null,
         JSON.stringify({ customer_name: c.name, auto: true, agent: true, channel, template: templateName }), coupon]
      ).catch(()=>{});
    };

    if (c.phone && tpl) {
      // WhatsApp via template (costs a credit)
      const discountLabel = `${pct}%`;
      const valueMap = { name: c.name || 'לקוחה', coupon: coupon || '', discount: discountLabel };
      const params = (tpl.body_vars || []).map(v => valueMap[v] != null ? valueMap[v] : '');
      const r = await whatsappSender.sendTemplate(shop, c.phone, templateName, params, { meta: { agent: true } });
      if (r.ok) { sentWa++; await logAction('whatsapp'); }
      else if (r.reason === 'no_credits') { noCredits = true; failed++; }
      else { failed++; }
    } else if (c.email && mailer && mailer.sendEmail) {
      // Email fallback (free)
      try {
        const body = tmpl.body.replace(/\{NAME\}/g, c.name || '').replace(/\{COUPON\}/g, coupon || '');
        await mailer.sendEmail(shop, { to: c.email, subject: tmpl.subject, text: body });
        sentEmail++; await logAction('email');
      } catch (e) { failed++; }
    } else {
      failed++;
    }
  }

  return {
    auto: true,
    sent: sentWa + sentEmail,
    sent_whatsapp: sentWa,
    sent_email: sentEmail,
    failed,
    prepared: 0,
    stopped_no_credits: noCredits,
    whatsapp: [] // auto mode sends directly; no manual squares
  };
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
async function stopPlan(planId) {
  await db.query(`UPDATE agent_plans SET status='stopped', finished_at=NOW() WHERE id=$1`, [planId]).catch(()=>{});
  return { ok: true };
}

// Get plan + tasks status (for live UI).
async function getPlanStatus(planId) {
  const plan = await db.query(`SELECT * FROM agent_plans WHERE id=$1`, [planId]);
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