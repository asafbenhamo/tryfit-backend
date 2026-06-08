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

const TASK_GAP_MS = 3000; // small pause between moves

// Pull the customer segment for a given move type.
// Returns array of { name, email, phone, est_value }.
async function pullSegment(shop, task) {
  const limit = campaignEngine.MAX_PER_CAMPAIGN;
  let rows = [];
  try {
    if (task.move_type === 'abandoned_cart') {
      const r = await aiTools.getAbandonedCheckouts(shop, { limit, days: 30 });
      rows = (r.recoverable_carts || r.carts || []).map(c => ({
        name: c.name || c.first_name || '', email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_price || 0)
      }));
    } else if (task.move_type === 'dormant_vip') {
      const r = await aiTools.getDormantCustomers(shop, { limit, daysInactive: 30, minSpent: 1000 });
      rows = (r.customers || []).map(c => ({
        name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0) * 0.15 // expect ~15% of lifetime as next order
      }));
    } else if (task.move_type === 'one_time') {
      // bought exactly once - nudge for a second order
      const r = await aiTools.getDormantCustomers(shop, { limit, daysInactive: 20, minSpent: 0 });
      rows = (r.customers || []).filter(c => (c.orders_count || 0) === 1).map(c => ({
        name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '',
        est_value: parseFloat(c.total_spent || 0)
      }));
    } else if (task.move_type === 'hot_product') {
      // promote a hot product to repeat buyers
      const r = await aiTools.getRepeatCustomers(shop, { limit });
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

// Execute one task: pull segment -> start a campaign -> wait for it -> record result.
async function runTask(shop, task) {
  await db.query(`UPDATE agent_tasks SET status='running' WHERE id=$1`, [task.id]).catch(()=>{});

  const segment = await pullSegment(shop, task);
  if (segment.length === 0) {
    await db.query(`UPDATE agent_tasks SET status='skipped', finished_at=NOW(),
      result='{"reason":"no customers in segment"}'::jsonb WHERE id=$1`, [task.id]).catch(()=>{});
    return { sent: 0, skipped: 0 };
  }

  const tmpl = templateFor(task);
  const { id: campId } = campaignEngine.startCampaign(shop, {
    campaign_type: task.move_type,
    segment,
    template: { percentage: task.percentage || 10, days_valid: 14, subject: tmpl.subject, body: tmpl.body }
  });

  // Wait for the campaign to finish (poll its in-memory status)
  let status = campaignEngine.getCampaignStatus(campId);
  while (status && (status.status === 'running' || status.status === 'stopping')) {
    await new Promise(r => setTimeout(r, 1500));
    status = campaignEngine.getCampaignStatus(campId);
  }

  const result = {
    campaign_id: campId,
    sent: status ? status.sent : 0,
    skipped: status ? status.skipped : 0,
    failed: status ? status.failed : 0,
    revenue_potential: status ? Math.round(status.revenue_potential || 0) : 0
  };
  await db.query(`UPDATE agent_tasks SET status='done', finished_at=NOW(), result=$2 WHERE id=$1`,
    [task.id, JSON.stringify(result)]).catch(()=>{});
  return result;
}

// Run an entire approved plan: execute selected tasks by priority, one at a time.
async function runPlan(shop, planId) {
  await db.query(`UPDATE agent_plans SET status='running' WHERE id=$1`, [planId]).catch(()=>{});

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
      const r = await runTask(shop, task);
      console.log(`✅ [Agent] task ${task.id} (${task.move_type}): ${r.sent} sent`);
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
  const tasks = await db.query(`SELECT id, priority, move_type, title, status, result, est_customers, projected_revenue FROM agent_tasks WHERE plan_id=$1 ORDER BY priority ASC`, [planId]);
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

module.exports = { startPlan, stopPlan, getPlanStatus, resumeInterruptedPlans, runTask };