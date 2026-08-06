// ============================================================================
// AUTOPILOT — the agent that runs the store without waiting to be asked.
//
// `store_settings.autopilot` has existed for a while but nothing ever read it:
// every outbound message still needed a human click. This module is what makes
// the setting mean something.
//
//   'off'     — nothing automatic at all.
//   'approve' — today's behaviour: the agent prepares, the merchant approves.
//   'full'    — the agent decides and sends by itself.
//
// In 'full' it wakes once per store-local morning and, for that store only:
//   1. reads what worked (policy-engine) and what the base looks like now (RFM)
//   2. picks the segments worth contacting, the offer, and the channel
//   3. holds a slice of customers back deliberately, so lift stays measurable
//   4. refuses to send anything that is not genuinely personal
//   5. stays inside the daily cap, the send window and the cooldown
//   6. writes down what it did, so the merchant can read it the next morning
//
// Every one of those steps can only ever REDUCE what goes out. There is no path
// through this file that sends more than the approve-mode flow would have.
// ============================================================================

const db = require('./database');
const storeSettings = require('./store-settings');
const storeTime = require('./store-time');
const policy = require('./policy-engine');
const rfmEngine = require('./rfm-engine');
const campaignEngine = require('./campaign-engine');
const compliance = require('./compliance');
const messageQueue = require('./message-queue');

// The agent may spend at most this share of the daily cap on any single run,
// so one morning cannot exhaust the whole day's budget on one segment.
const MAX_SHARE_PER_RUN = 0.4;
const MAX_SEGMENTS_PER_RUN = 3;
const RUN_HOUR = 9;              // store-local hour the daily run happens

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS autopilot_runs (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      local_date TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT DEFAULT 'running',      -- running | done | skipped | error
      contacted INT DEFAULT 0,
      held_out INT DEFAULT 0,
      rejected_not_smart INT DEFAULT 0,
      details JSONB DEFAULT '{}'::jsonb,
      UNIQUE (shop_domain, local_date)
    )`).catch(e => console.error('[autopilot] table:', e.message));
  tableReady = true;
}

// ---------------------------------------------------------------------------
// Should this shop run right now? Once per local day, at the local run hour.
// The UNIQUE(shop_domain, local_date) row is the lock: if two ticks race, the
// second INSERT conflicts and that tick simply does nothing.
// ---------------------------------------------------------------------------
async function claimRun(shop, localDate) {
  await ensureTable();
  try {
    const r = await db.query(
      `INSERT INTO autopilot_runs (shop_domain, local_date, status)
       VALUES ($1,$2,'running')
       ON CONFLICT (shop_domain, local_date) DO NOTHING
       RETURNING id`,
      [shop, localDate]);
    return r.rows[0] ? r.rows[0].id : null;   // null = already claimed today
  } catch (e) {
    console.error('[autopilot] claim:', e.message);
    return null;
  }
}

async function finishRun(runId, patch) {
  await db.query(
    `UPDATE autopilot_runs
        SET finished_at=NOW(), status=$2, contacted=$3, held_out=$4,
            rejected_not_smart=$5, details=$6
      WHERE id=$1`,
    [runId, patch.status, patch.contacted || 0, patch.held_out || 0,
     patch.rejected_not_smart || 0, JSON.stringify(patch.details || {})]
  ).catch(e => console.error('[autopilot] finish:', e.message));
}

// ---------------------------------------------------------------------------
// Build the message for one customer. Returns null when it would not clear the
// smart-outreach bar — the caller counts that as a rejection, not a send.
// ---------------------------------------------------------------------------
function buildMessage(cust, move, settings, lang) {
  const first = String(cust.name || '').split(' ')[0] || '';
  const product = cust.last_product || '';
  const brand = settings.brand || '';

  const he = {
    withProduct: `היי ${first}, ראינו שאהבת את ${product} — בחרנו לך עוד כמה דברים באותו קו.\nהקוד האישי שלך: {COUPON} (${move.discount}% הנחה)\n{LINK}`,
    plain: `היי ${first}, חשבנו עלייך — הכנו לך הצעה אישית.\nהקוד האישי שלך: {COUPON} (${move.discount}% הנחה)\n{LINK}`,
    subject: `${first}, משהו שבחרנו במיוחד בשבילך`
  };
  const en = {
    withProduct: `Hi ${first}, we saw you loved the ${product} — we picked a few more things along the same line.\nYour personal code: {COUPON} (${move.discount}% off)\n{LINK}`,
    plain: `Hi ${first}, we were thinking of you — here is something picked for you.\nYour personal code: {COUPON} (${move.discount}% off)\n{LINK}`,
    subject: `${first}, something we picked for you`
  };
  const copy = lang === 'en' ? en : he;
  const body = product ? copy.withProduct : copy.plain;

  return { subject: copy.subject.replace(/^,\s*/, '').trim() || (brand || 'Hello'), body };
}

// ---------------------------------------------------------------------------
// One store's daily run.
// ---------------------------------------------------------------------------
async function runForShop(shop, opts = {}) {
  const settings = await storeSettings.getSettings(shop);
  if (settings.autopilot !== 'full' && !opts.force) {
    return { ok: true, skipped: 'not_full_autopilot' };
  }

  const tz = settings.timezone;
  const localDate = storeTime.dateKeyIn(tz);

  // Never start a run outside the send window — the whole point is that what it
  // schedules can actually go out today.
  if (!opts.force && !storeTime.isWithinSendWindow(tz)) {
    return { ok: true, skipped: 'outside_send_window' };
  }

  const runId = opts.runId || await claimRun(shop, localDate);
  if (!runId) return { ok: true, skipped: 'already_ran_today' };

  const summary = {
    shop, local_date: localDate, timezone: tz,
    segments: [], contacted: 0, held_out: 0, rejected_not_smart: 0,
    exploring: 0, budget: 0
  };

  try {
    // ---- what is left of today's budget -------------------------------------
    const cap = await storeSettings.remainingToday(shop);
    const budget = Math.min(cap.remaining, Math.floor(settings.daily_cap * MAX_SHARE_PER_RUN));
    summary.budget = budget;
    if (budget <= 0) {
      await finishRun(runId, { status: 'skipped', details: { reason: 'no_budget_left', cap } });
      return { ok: true, skipped: 'no_budget_left', cap };
    }

    // ---- what worked, and what the base looks like now -----------------------
    const stats = await policy.learn(shop);
    const scored = await rfmEngine.computeRFM(shop, { limit: 2000, lang: settings.language });
    if (!scored || scored.length === 0) {
      await finishRun(runId, { status: 'skipped', details: { reason: 'no_customers' } });
      return { ok: true, skipped: 'no_customers' };
    }
    const rfmSummary = rfmEngine.summarize(scored);
    const ranked = policy.rankSegments(stats, rfmSummary, settings.language).slice(0, MAX_SEGMENTS_PER_RUN);
    if (ranked.length === 0) {
      await finishRun(runId, { status: 'skipped', details: { reason: 'all_segments_suppressed' } });
      return { ok: true, skipped: 'all_segments_suppressed' };
    }

    // ---- which channels this shop can actually use --------------------------
    // Channel precedence is a business rule, not something to learn: WhatsApp
    // only when the merchant funded it, then SMS, then email. The policy still
    // chooses the OFFER, but it may not spend credits the merchant did not buy.
    const channelRouter = require('./channel-router');
    const available = await channelRouter.shopChannels(shop, settings);
    summary.channels_available = available;

    let spent = 0;

    for (const seg of ranked) {
      if (spent >= budget) break;

      const move = policy.decide(stats, seg.key, {
        allowedChannels: ['email'],   // offer only; the router assigns the channel
        defaultDiscount: seg.discount || 15
      });
      if (move.exploring) summary.exploring++;

      // Customers in this segment, richest signal first.
      const members = scored
        .filter(c => c.segment === seg.key && (c.email || c.phone))
        .slice(0, Math.max(0, budget - spent));

      const bestHours = await messageQueue.preferredHours(shop, members.map(m => m.email)).catch(() => ({}));

      const recipients = [];
      let heldOut = 0, rejected = 0;

      for (const cust of members) {
        const key = (cust.email || cust.phone || '').toLowerCase();

        // HOLDOUT: deliberately leave a slice uncontacted so the lift the agent
        // reports is a real comparison and not just attributed credit.
        if (policy.isHoldout(shop, key, localDate)) {
          heldOut++;
          await db.query(
            `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details)
             VALUES ($1,'holdout',$2,$3,$4)`,
            [shop, cust.email || null, cust.phone || null,
             JSON.stringify({ control: 'true', segment: seg.key, autopilot: true, local_date: localDate })]
          ).catch(() => {});
          continue;
        }

        // Cooldown / opt-out / window — the same gate every manual send passes.
        const gate = await compliance.canContactCustomer(shop,
          { email: cust.email, phone: cust.phone }, { cooldownDays: 14 });
        if (!gate.allowed || gate.warning === 'recent_contact') continue;

        const personalHour = bestHours[(cust.email || '').toLowerCase()];
        const msg = buildMessage(cust, move, settings, settings.language);

        // THE SMART BAR. Anything that would go out generic is dropped here.
        const smart = policy.isSmartOutreach(msg.body, {
          last_product: cust.last_product,
          segment: seg.key,
          segment_specific_offer: true,       // the offer came from policy.decide
          personal_hour: personalHour,
          default_hour: 11
        });
        if (!smart.ok) { rejected++; continue; }

        recipients.push({
          name: cust.name || '', email: cust.email || '', phone: cust.phone || '',
          est_value: cust.monetary || 0,
          last_product: cust.last_product || null
        });
      }

      summary.held_out += heldOut;
      summary.rejected_not_smart += rejected;

      if (recipients.length === 0) {
        summary.segments.push({ segment: seg.key, contacted: 0, held_out: heldOut, rejected, reason: 'nobody_eligible' });
        continue;
      }

      // Route per customer, then run one campaign per channel group. A woman
      // with a phone gets a text; one with only an address gets an email; the
      // whole segment no longer has to share a single channel.
      const routed = await channelRouter.route(shop, recipients, settings, { credits: available.credits });
      const byChannel = { whatsapp: [], sms: [], email: [] };
      let unreachable = 0;
      for (const a of routed.assignments) {
        if (!a.channel) { unreachable++; continue; }
        byChannel[a.channel].push(a.customer);
      }

      const campaigns = [];
      let segContacted = 0;
      for (const ch of ['whatsapp', 'sms', 'email']) {
        const group = byChannel[ch];
        if (group.length === 0) continue;
        const sample = buildMessage(group[0], move, settings, settings.language);
        const started = campaignEngine.startCampaign(shop, {
          campaign_type: 'autopilot_' + seg.key,
          segment: group,
          template: {
            percentage: move.discount,
            days_valid: 3,
            subject: sample.subject,
            body: sample.body
          },
          channels: [ch],
          smart_timing: true,        // each customer at her own hour
          segment_key: seg.key,
          followup: settings.followup_default !== false
        });
        campaigns.push({ channel: ch, count: group.length, campaign_id: started.id });
        segContacted += group.length;
      }

      spent += segContacted;
      summary.contacted += segContacted;
      summary.unreachable = (summary.unreachable || 0) + unreachable;
      summary.segments.push({
        segment: seg.key,
        label: seg.label,
        contacted: segContacted,
        held_out: heldOut,
        rejected,
        unreachable,
        discount: move.discount,
        why_discount: move.discount_why,
        by_channel: routed.counts,
        campaigns,
        expected: seg.expected,
        basis: seg.basis
      });
    }

    await finishRun(runId, {
      status: 'done',
      contacted: summary.contacted,
      held_out: summary.held_out,
      rejected_not_smart: summary.rejected_not_smart,
      details: summary
    });
    console.log(`🤖 [autopilot] ${shop} ${localDate}: contacted=${summary.contacted} held_out=${summary.held_out} rejected=${summary.rejected_not_smart}`);
    return { ok: true, ...summary };

  } catch (e) {
    console.error(`[autopilot] ${shop}:`, e.message);
    await finishRun(runId, { status: 'error', details: { error: e.message } });
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// The tick. Called every minute from server-dual; does nothing for almost all
// of them. Each shop runs when its OWN local clock reaches RUN_HOUR.
// ---------------------------------------------------------------------------
async function tick(shops) {
  for (const shop of shops || []) {
    try {
      const s = await storeSettings.getSettings(shop);
      if (s.autopilot !== 'full') continue;
      if (storeTime.hourIn(s.timezone) !== RUN_HOUR) continue;
      await runForShop(shop);
    } catch (e) {
      console.error(`[autopilot] tick ${shop}:`, e.message);
    }
  }
}

// What the agent did, for the "here is what I did while you slept" card.
async function recentRuns(shop, limit = 7) {
  await ensureTable();
  try {
    const r = await db.query(
      `SELECT local_date, status, contacted, held_out, rejected_not_smart, details, started_at, finished_at
         FROM autopilot_runs WHERE shop_domain=$1
        ORDER BY local_date DESC FETCH FIRST ${parseInt(limit)} ROWS ONLY`, [shop]);
    return { ok: true, runs: r.rows };
  } catch (e) { return { ok: false, error: e.message, runs: [] }; }
}

module.exports = {
  ensureTable, runForShop, tick, recentRuns, buildMessage,
  RUN_HOUR, MAX_SHARE_PER_RUN, MAX_SEGMENTS_PER_RUN
};
