// campaign-engine.js - Autonomous batch campaign runner.
// For each customer in the segment: creates a personal coupon, builds the
// personalized message, and:
//   - EMAIL customers -> sends automatically (through the safety gate).
//   - WHATSAPP customers -> does NOT auto-send (no Business API). Instead it
//     PREPARES a ready wa.me link and returns it to the UI so the merchant can
//     send it in one click. These are reported as "prepared", NOT "sent".
//
// This fixes the old bug where WhatsApp links were counted as "sent" and then
// thrown away (the merchant never saw them).
//
// Progress is held in-memory (per running campaign). The UI polls /status and
// reads the prepared WhatsApp links from there.

const db = require('./database');
const shopify = require('./shopify-client');
const mailer = require('./mailer');
const compliance = require('./compliance');

const MAX_PER_CAMPAIGN = 50;       // safety cap
const SEND_DELAY_MS = 600;         // small pace between customers

// Cooldown: don't re-contact a customer we already messaged in the last N days.
// During development/testing this is short (1 day) so you can test freely.
// ⚠️ BEFORE GOING LIVE TO REAL CUSTOMERS: change this back to 14.
const CAMPAIGN_COOLDOWN_DAYS = 1;

// In-memory registry of running/finished campaigns.
const campaigns = {};

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
    status: c.status, total: c.total, done: c.done,
    sent: c.sent,             // emails actually sent
    prepared: c.prepared,     // WhatsApp links ready for the merchant to click
    skipped: c.skipped, failed: c.failed,
    revenue_potential: Math.round(c.revenue_potential || 0),
    campaign_type: c.campaign_type,
    whatsapp: c.whatsapp,     // [{ name, phone, coupon, link, sent:false }]
    started_at: c.started_at, finished_at: c.finished_at
  };
}

// Transliterate a Hebrew name to Latin letters so the coupon code is personal
// (e.g. שושי -> SHOSHI) instead of falling back to a generic "VIP".
function hebrewToLatin(str) {
  const map = {
    'א':'','ב':'B','ג':'G','ד':'D','ה':'H','ו':'V','ז':'Z','ח':'CH','ט':'T',
    'י':'Y','כ':'K','ך':'K','ל':'L','מ':'M','ם':'M','נ':'N','ן':'N','ס':'S',
    'ע':'','פ':'P','ף':'P','צ':'TS','ץ':'TS','ק':'K','ר':'R','ש':'SH','ת':'T'
  };
  return String(str || '').split('').map(ch => (ch in map ? map[ch] : ch)).join('');
}

// Build a unique personal coupon code from a name/email.
// Tries the (transliterated) name first, then the email prefix, then 'VIP'.
function personalCode(nameOrEmail, pct) {
  const translit = hebrewToLatin(nameOrEmail);
  let base = translit.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  if (!base && nameOrEmail && nameOrEmail.includes('@')) {
    base = nameOrEmail.split('@')[0].replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  }
  if (!base) base = 'VIP';
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${base}${pct}${suffix}`;
}

/**
 * Start a campaign in the background.
 * segment: array of { name, email, phone, est_value }
 * template: { percentage, days_valid, subject, body }  body may contain {NAME} and {COUPON}
 * Returns { id } immediately; work continues async.
 */
function startCampaign(shop, { campaign_type, segment, template }) {
  const id = newCampaignId();
  const capped = (segment || []).slice(0, MAX_PER_CAMPAIGN);

  campaigns[id] = {
    shop, campaign_type: campaign_type || 'campaign',
    status: 'running', total: capped.length, done: 0,
    sent: 0, prepared: 0, skipped: 0, failed: 0, revenue_potential: 0,
    whatsapp: [],   // prepared WhatsApp links the merchant will click to send
    started_at: new Date().toISOString(), finished_at: null, log: []
  };

  runCampaign(id, shop, capped, template).catch(err => {
    console.error('[campaign] fatal:', err.message);
    if (campaigns[id]) { campaigns[id].status = 'error'; campaigns[id].error = err.message; }
  });

  return { id };
}

async function runCampaign(id, shop, segment, template) {
  const c = campaigns[id];
  const pct = parseInt(template.percentage) || 10;
  const days = parseInt(template.days_valid) || 2; // 48-hour validity by default

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
      const hasPhone = contact.phone && String(contact.phone).replace(/[^0-9]/g, '').length >= 8;

      // Safety gate. For WhatsApp we IGNORE working hours (the merchant sends the
      // link manually, whenever they choose) but STILL enforce opt-out + cooldown.
      // For email (auto-send) we enforce the full gate including hours.
      const gate = await compliance.canContactCustomer(shop, contact, { ignoreHours: hasPhone, cooldownDays: CAMPAIGN_COOLDOWN_DAYS });
      if (!gate.allowed) {
        c.skipped++; c.done++;
        c.log.push({ customer: cust.name || cust.email, skipped: gate.reason });
        continue;
      }

      // Personal coupon (stacks on the store's automatic discount by default)
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
      // Always state the 48-hour validity so it matches the real coupon expiry,
      // and to create urgency. Only add it if not already mentioned.
      if (finalCode && !body.includes('48 שעות')) body += `\nהקוד תקף ל-48 שעות בלבד ⏰`;

      if (hasPhone) {
        // WhatsApp: PREPARE a ready link. Do NOT count as "sent" - the merchant
        // sends it by clicking. We add it to the whatsapp list for the UI.
        let wa = String(contact.phone).replace(/[^0-9]/g, '');
        if (wa.startsWith('0')) wa = '972' + wa.slice(1);
        const waLink = `https://wa.me/${wa}?text=${encodeURIComponent(body)}`;

        c.whatsapp.push({
          name: cust.name || '',
          phone: contact.phone,
          coupon: finalCode,
          link: waLink,
          sent: false
        });
        c.prepared++; c.done++;
        c.revenue_potential += parseFloat(cust.est_value || 0);

        // Log as 'prepared' (not converted) so attribution still works when she buys,
        // but we are honest that it hasn't been sent yet.
        await db.query(
          `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [shop, c.campaign_type, contact.email, contact.phone,
           JSON.stringify({ channel: 'whatsapp', campaign_id: id, prepared: true }), finalCode]
        ).catch(e => console.error('[campaign] log:', e.message));

      } else if (contact.email) {
        // Email: auto-send through the gate (already checked above)
        const html = mailer.buildHtmlEmail(body, { brand: '770', to: contact.email });
        const sent = await mailer.sendEmail({ to: contact.email, subject: template.subject || 'הודעה מ-770', html, text: body });
        if (!sent.ok) { c.failed++; c.done++; c.log.push({ customer: cust.email, failed: sent.error }); continue; }

        c.sent++; c.done++;
        c.revenue_potential += parseFloat(cust.est_value || 0);

        await db.query(
          `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [shop, c.campaign_type, contact.email, contact.phone,
           JSON.stringify({ channel: 'email', campaign_id: id }), finalCode]
        ).catch(e => console.error('[campaign] log:', e.message));

      } else {
        c.skipped++; c.done++; c.log.push({ customer: cust.name, skipped: 'no_contact' }); continue;
      }

      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    } catch (err) {
      c.failed++; c.done++;
      c.log.push({ customer: cust.name || cust.email, failed: err.message });
    }
  }

  if (c) {
    c.status = 'done';
    c.finished_at = new Date().toISOString();
    console.log(`🏁 [Campaign ${id}] done: ${c.sent} emails sent, ${c.prepared} WhatsApp prepared, ${c.skipped} skipped, ${c.failed} failed`);
  }
}

module.exports = { startCampaign, getCampaignStatus, stopCampaign, listActiveCampaigns, MAX_PER_CAMPAIGN };