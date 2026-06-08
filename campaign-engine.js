// campaign-engine.js - Autonomous batch campaign runner.
// Runs a campaign in the BACKGROUND: for each customer in the segment, creates a
// personal coupon + personalized message, sends it (email auto / WhatsApp link),
// respecting all safety gates (hours, opt-out, cooldown). Tracks live progress.
//
// Progress is held in-memory (per running campaign) and also persisted via
// advisor_actions rows. A status endpoint reads the in-memory progress.

const db = require('./database');
const shopify = require('./shopify-client');
const mailer = require('./mailer');
const compliance = require('./compliance');

const MAX_PER_CAMPAIGN = 50;       // safety cap
const SEND_DELAY_MS = 1200;        // pace sends (~1/sec) to avoid spam-like bursts

// In-memory registry of running/finished campaigns.
const campaigns = {}; // { id: { status, total, done, sent, skipped, failed, revenue_potential, started_at, finished_at, log:[] } }

function newCampaignId() {
  return 'camp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

function getCampaignStatus(id) {
  return campaigns[id] || null;
}

function stopCampaign(id) {
  const c = campaigns[id];
  if (!c) return { ok: false, error: 'not found' };
  if (c.status === 'running') {
    c.stopRequested = true;
    c.status = 'stopping';
    return { ok: true, status: 'stopping' };
  }
  return { ok: true, status: c.status };
}

function listActiveCampaigns(shop) {
  return Object.entries(campaigns)
    .filter(([id, c]) => c.shop === shop)
    .map(([id, c]) => ({ id, ...summarize(c) }));
}

function summarize(c) {
  return {
    status: c.status, total: c.total, done: c.done, sent: c.sent,
    skipped: c.skipped, failed: c.failed,
    revenue_potential: Math.round(c.revenue_potential || 0),
    campaign_type: c.campaign_type,
    started_at: c.started_at, finished_at: c.finished_at
  };
}

// Build a unique personal coupon code from a name/email.
function personalCode(nameOrEmail, pct) {
  let base = (nameOrEmail || 'VIP').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'VIP';
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${base}${pct}${suffix}`;
}

/**
 * Start a campaign in the background.
 * segment: array of { name, email, phone, est_value } (already filtered by the brain)
 * template: { percentage, days_valid, subject, body }  body may contain {NAME} and {COUPON}
 * Returns { id } immediately; work continues async.
 */
function startCampaign(shop, { campaign_type, segment, template }) {
  const id = newCampaignId();
  const capped = (segment || []).slice(0, MAX_PER_CAMPAIGN);

  campaigns[id] = {
    shop, campaign_type: campaign_type || 'campaign',
    status: 'running', total: capped.length, done: 0,
    sent: 0, skipped: 0, failed: 0, revenue_potential: 0,
    started_at: new Date().toISOString(), finished_at: null, log: []
  };

  // Fire the async worker (do not await).
  runCampaign(id, shop, capped, template).catch(err => {
    console.error('[campaign] fatal:', err.message);
    if (campaigns[id]) { campaigns[id].status = 'error'; campaigns[id].error = err.message; }
  });

  return { id };
}

async function runCampaign(id, shop, segment, template) {
  const c = campaigns[id];
  const pct = parseInt(template.percentage) || 10;
  const days = parseInt(template.days_valid) || 14;

  for (const cust of segment) {
    if (!c) break;
    if (c.stopRequested) {
      c.status = 'stopped';
      c.finished_at = new Date().toISOString();
      console.log(`🛑 [Campaign ${id}] stopped by user at ${c.done}/${c.total}`);
      return;
    }
    try {
      const contact = { email: cust.email || null, phone: cust.phone || null };

      // Safety gate: hours + opt-out + cooldown
      const gate = await compliance.canContactCustomer(shop, contact, {});
      if (!gate.allowed) {
        c.skipped++; c.done++;
        c.log.push({ customer: cust.name || cust.email, skipped: gate.reason });
        continue;
      }

      // Personal coupon
      const code = personalCode(cust.name || cust.email, pct);
      const coupon = await shopify.createDiscountCode(shop, {
        percentage: pct, code, days_valid: days,
        title: `קמפיין ${c.campaign_type} - ${cust.name || cust.email || ''}`
      });
      const finalCode = coupon.ok ? coupon.code : null;

      // Personalize message
      let body = (template.body || '')
        .replace(/\{NAME\}/g, cust.name || '')
        .replace(/\{COUPON\}/g, finalCode || '');
      if (finalCode && !body.includes(finalCode)) body += `\n\nקוד אישי: ${finalCode}`;

      // Send: WhatsApp link if phone, else email auto
      const hasPhone = contact.phone && String(contact.phone).replace(/[^0-9]/g, '').length >= 8;
      let channel = null, waLink = null;
      if (hasPhone) {
        let wa = String(contact.phone).replace(/[^0-9]/g, '');
        if (wa.startsWith('0')) wa = '972' + wa.slice(1);
        waLink = `https://wa.me/${wa}?text=${encodeURIComponent(body)}`;
        channel = 'whatsapp';
      } else if (contact.email) {
        const html = mailer.buildHtmlEmail(body, { brand: '770', to: contact.email });
        const sent = await mailer.sendEmail({ to: contact.email, subject: template.subject || 'הודעה מ-770', html, text: body });
        channel = 'email';
        if (!sent.ok) { c.failed++; c.done++; c.log.push({ customer: cust.email, failed: sent.error }); continue; }
      } else {
        c.skipped++; c.done++; c.log.push({ customer: cust.name, skipped: 'no_contact' }); continue;
      }

      // Log action (powers attribution + daily report + cooldown)
      await db.query(
        `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shop, c.campaign_type, contact.email, contact.phone,
         JSON.stringify({ channel, campaign_id: id, wa_link: waLink }), finalCode]
      ).catch(e => console.error('[campaign] log:', e.message));

      c.sent++; c.done++;
      c.revenue_potential += parseFloat(cust.est_value || 0);
      c.log.push({ customer: cust.name || cust.email, channel, coupon: finalCode });

      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    } catch (err) {
      c.failed++; c.done++;
      c.log.push({ customer: cust.name || cust.email, failed: err.message });
    }
  }

  if (c) {
    c.status = 'done';
    c.finished_at = new Date().toISOString();
    console.log(`🏁 [Campaign ${id}] done: ${c.sent} sent, ${c.skipped} skipped, ${c.failed} failed`);
  }
}

module.exports = { startCampaign, getCampaignStatus, stopCampaign, listActiveCampaigns, MAX_PER_CAMPAIGN };