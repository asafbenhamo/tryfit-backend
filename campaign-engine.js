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

const MAX_PER_CAMPAIGN = 50000;    // hard technical ceiling (UI confirms above 500)
const SEND_DELAY_MS = 600;         // small pace between customers

// Cooldown: don't re-contact a customer we already messaged in the last N days.
// During development/testing this is short (1 day) so you can test freely.
// ⚠️ BEFORE GOING LIVE TO REAL CUSTOMERS: change this back to 14.
const CAMPAIGN_COOLDOWN_DAYS = 4;

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
function startCampaign(shop, { campaign_type, segment, template, channels, smart_timing, segment_key, followup }) {
  const id = newCampaignId();
  const capped = (segment || []).slice(0, MAX_PER_CAMPAIGN);
  const chans = Array.isArray(channels) && channels.length ? channels : ['whatsapp', 'email'];

  campaigns[id] = {
    shop, campaign_type: campaign_type || 'campaign',
    status: 'running', total: capped.length, done: 0,
    sent: 0, prepared: 0, skipped: 0, failed: 0, revenue_potential: 0,
    channels: chans,
    smart_timing: !!smart_timing,          // schedule each contact at her best hour
    segment_key: segment_key || null,      // RFM segment tag (feeds the learning loop)
    followup: followup !== false,          // auto follow-up sequence (default ON)
    queued: 0,                             // messages placed in the smart-timing queue
    followups_queued: 0,
    whatsapp: [],   // prepared WhatsApp links the merchant will click to send
    sms_sent: 0,
    started_at: new Date().toISOString(), finished_at: null, log: []
  };

  runCampaign(id, shop, capped, template, chans).catch(err => {
    console.error('[campaign] fatal:', err.message);
    if (campaigns[id]) { campaigns[id].status = 'error'; campaigns[id].error = err.message; }
  });

  return { id };
}

async function runCampaign(id, shop, segment, template, channels) {
  const c = campaigns[id];
  const chans = channels || c.channels || ['whatsapp', 'email'];
  const wantWhatsapp = chans.includes('whatsapp');
  const wantEmail = chans.includes('email');
  const wantSms = chans.includes('sms');
  const smsSender = require('./sms-sender');
  const mq = require('./message-queue');

  // SMART TIMING: pre-compute each customer's personal best hour (from her own
  // order history) in ONE batched query. Sends are then queued for that hour.
  let bestHours = {};
  if (c.smart_timing) {
    try { bestHours = await mq.preferredHours(shop, segment.map(s => s.email)); }
    catch (e) { console.error('[campaign] preferredHours:', e.message); }
  }
  const pct = parseInt(template.percentage) || 10;
  const amountIls = template.amount_ils ? parseFloat(template.amount_ils) : null;
  const isFixed = !!amountIls && amountIls > 0;
  const allowCombine = (template.combine === 'no' || template.combine === false) ? false : true;
  const days = parseInt(template.days_valid) || 2; // 48-hour validity by default
  // Merchant's own existing coupon code, if they asked to use a specific one for the
  // whole campaign instead of letting the agent generate personal codes.
  const fixedCode = (template.fixed_code || template.coupon_code || '').toString().trim().toUpperCase() || null;
  // Extended coupon types (optional): free_shipping, bxgy (3+1), category-limited,
  // and minimum-spend requirements.
  const couponType = (template.coupon_type || '').toString().trim() || null; // 'free_shipping' | 'bxgy'
  const collectionId = template.collection_id ? Number(template.collection_id) : null;
  const minSubtotal = template.min_subtotal != null && template.min_subtotal !== '' ? parseFloat(template.min_subtotal) : null;
  const buyQty = template.buy_quantity ? parseInt(template.buy_quantity) : null;
  const getQty = template.get_quantity ? parseInt(template.get_quantity) : null;

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

      // Coupon: if the merchant supplied their OWN existing code (fixed_code), use it
      // for everyone exactly as requested — don't create a new one. Otherwise create a
      // personal per-customer code (the default).
      let finalCode = null;
      if (fixedCode) {
        finalCode = fixedCode; // merchant's own code, used for all recipients
      } else {
        const code = personalCode(cust.name || cust.email, isFixed ? Math.round(amountIls) : pct);
        const coupon = await shopify.createDiscountCode(shop, {
          percentage: isFixed ? null : pct,
          amount_ils: isFixed ? amountIls : null,
          combine: allowCombine,
          code, days_valid: days,
          // Extended coupon types (all optional, passed from the campaign template):
          type: couponType,                    // 'free_shipping' | 'bxgy' | undefined
          collection_id: collectionId,         // limit to a category
          min_subtotal: minSubtotal,           // valid only above this spend
          buy_quantity: buyQty, get_quantity: getQty, // for 3+1 style
          free_shipping: couponType === 'free_shipping',
          title: `קמפיין ${c.campaign_type} - ${cust.name || cust.email || ''}`
        });
        finalCode = coupon.ok ? coupon.code : null;
      }

      // Personalize message
      // {PRODUCT_LINE}: if we know the customer's last product, weave in a warm,
      // personal reference ("we saw you loved X") — the key edge over generic blasts.
      let productLine = '';
      if (cust.last_product) {
        productLine = `ראינו שאהבת את ${cust.last_product} - חשבנו שיעניין אותך לחזור. `;
      }
      let body = (template.body || '')
        .replace(/\{NAME\}/g, cust.name || '')
        .replace(/\{PRODUCT_LINE\}/g, productLine)
        .replace(/\{PRODUCT\}/g, cust.last_product || '')
        .replace(/\{COUPON\}/g, finalCode || '');
      // Only auto-append the "קוד אישי" + validity lines when WE generated a personal
      // code. When the merchant supplied their own fixed code, the code already lives
      // in the body text they wrote — never add a second one.
      if (finalCode && !fixedCode) {
        if (!body.includes(finalCode)) body += `\n\nקוד אישי: ${finalCode}`;
        if (!body.includes('48 שעות')) body += `\nהקוד תקף ל-48 שעות בלבד ⏰`;
      }

      // Base URL for tracking links. Be defensive: strip any accidental
      // "NAME = value" or quotes, and keep only a clean https URL.
      let BASE = process.env.PUBLIC_BASE_URL || "https://tryfit-backend-production.up.railway.app";
      BASE = String(BASE).replace(/^[^=]*=\s*/, '').replace(/['"\s]/g, '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(BASE)) BASE = "https://tryfit-backend-production.up.railway.app";

      // Create ONE action row (for attribution) + ONE tracking link, shared across
      // whichever channels the merchant chose for this customer.
      let actionId = null;
      try {
        const ins = await db.query(
          `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [shop, c.campaign_type, contact.email, contact.phone,
           JSON.stringify({ channels: chans, campaign_id: id, segment: c.segment_key || null, customer_name: cust.name || null }), finalCode]
        );
        actionId = ins.rows[0] && ins.rows[0].id;
      } catch (e) { console.error('[campaign] log:', e.message); }

      let buyLink = shopify.getPublicDomain(shop);
      try {
        const clickTracker = require('./click-tracker');
        const token = await clickTracker.createLink(shop, { actionId, email: contact.email, phone: contact.phone, couponCode: finalCode });
        buyLink = `${BASE}/go/${token}`;
      } catch (e) { /* fall back to plain store link */ }
      const fullBody = body + `\n\n🛍️ למימוש ההטבה ולרכישה:\n${buyLink}`;

      let didSomething = false;

      // ---- WhatsApp: prepare a ready wa.me link for the merchant to click ----
      if (wantWhatsapp && hasPhone) {
        let wa = String(contact.phone).replace(/[^0-9]/g, '');
        if (wa.startsWith('0')) wa = '972' + wa.slice(1);
        const waLink = `https://wa.me/${wa}?text=${encodeURIComponent(fullBody)}`;
        c.whatsapp.push({ name: cust.name || '', phone: contact.phone, coupon: finalCode, link: waLink, sent: false });
        c.prepared++;
        didSomething = true;
      }

      // ---- SMS: instant, or queued at her personal best hour (smart timing) ----
      if (wantSms && hasPhone && smsSender.isConfigured()) {
        if (c.smart_timing) {
          const hour = bestHours[(contact.email || '').toLowerCase()] || 11;
          await mq.enqueue(shop, {
            channel: 'sms', phone: contact.phone, email: contact.email, name: cust.name || null,
            message: fullBody, send_at: mq.computeSendAt(hour), kind: 'timed',
            campaign_id: id, segment: c.segment_key || null
          }).then(() => { c.queued++; didSomething = true; })
            .catch(e => c.log.push({ customer: cust.name, sms_failed: e.message }));
        } else {
          try {
            const r = await smsSender.sendOne(shop, { phone: contact.phone, message: fullBody });
            if (r.ok) { c.sms_sent++; didSomething = true; }
            else if (!r.skipped) { c.log.push({ customer: cust.name, sms_failed: r.error }); }
          } catch (e) { c.log.push({ customer: cust.name, sms_failed: e.message }); }
        }
      }

      // ---- Email: instant, or queued at her personal best hour (smart timing) ----
      if (wantEmail && contact.email) {
        if (c.smart_timing) {
          const hour = bestHours[(contact.email || '').toLowerCase()] || 11;
          await mq.enqueue(shop, {
            channel: 'email', email: contact.email, phone: contact.phone, name: cust.name || null,
            subject: template.subject || 'הודעה מ-770',
            message: fullBody, send_at: mq.computeSendAt(hour), kind: 'timed',
            campaign_id: id, segment: c.segment_key || null
          }).then(() => { c.queued++; didSomething = true; })
            .catch(e => c.log.push({ customer: cust.email, failed: e.message }));
        } else {
          const html = mailer.buildHtmlEmail(fullBody, { brand: '770', to: contact.email });
          const sent = await mailer.sendEmail({ to: contact.email, subject: template.subject || 'הודעה מ-770', html, text: fullBody });
          if (sent.ok) { c.sent++; didSomething = true; }
          else { c.log.push({ customer: cust.email, failed: sent.error }); }
        }
      }

      // ---- SEQUENCE: auto follow-up in 3 days for whoever doesn't convert. ----
      // Research: a sequence converts 2-3x a one-shot. The follow-up gets a FRESH
      // coupon (created at send time — the original 48h code will have expired),
      // slightly sweeter (+5%, capped 25%). Skipped automatically at send time if
      // she converted or opted out. Only when we generate personal % codes.
      if (c.followup && didSomething && !isFixed && !fixedCode && pct > 0) {
        const fuChannel = (wantSms && hasPhone && smsSender.isConfigured()) ? 'sms'
                        : (wantEmail && contact.email) ? 'email' : null;
        if (fuChannel) {
          const firstName = (cust.name || '').split(' ')[0];
          const fuPct = Math.min(pct + 5, 25);
          const fuProduct = cust.last_product ? `ראינו שאהבת את ${cust.last_product} — ` : '';
          const fuBody = `היי${firstName ? ' ' + firstName : ''} 💜 רק תזכורת קטנה — ${fuProduct}ההטבה שלך עדיין מחכה.\nקוד חדש בשבילך (${fuPct}%): {COUPON}\nתקף ל-48 שעות ⏰\n🛍️ למימוש:\n{LINK}`;
          await mq.enqueue(shop, {
            channel: fuChannel, phone: contact.phone, email: contact.email, name: cust.name || null,
            subject: 'שמרנו לך את זה 💜',
            message: fuBody, send_at: mq.computeSendAt(11, 3), kind: 'followup', step: 2,
            campaign_id: id, segment: c.segment_key || null,
            coupon_pct: fuPct, coupon_days: 2
          }).then(() => { c.followups_queued++; })
            .catch(e => console.error('[campaign] followup enqueue:', e.message));
        }
      }

      if (didSomething) {
        c.done++;
        c.revenue_potential += parseFloat(cust.est_value || 0);
      } else {
        c.skipped++; c.done++; c.log.push({ customer: cust.name, skipped: 'no_matching_channel' });
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