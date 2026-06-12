// whatsapp-sender.js - Automatic WhatsApp sending via 360dialog (per shop).
//
// This is the seam between the advisor and the WhatsApp Business API. It only
// sends APPROVED templates (Meta requires this for business-initiated messages).
// Each successful send costs ONE credit; if the store has no credits, we refuse
// BEFORE calling the API. If the API call fails after we deducted, we refund.
//
// Per-store: the 360dialog API key lives on the store row (shopify-client cache),
// so every shop sends from its own WhatsApp number. Nothing is hardcoded to 770.
//
// Sending is GATED on having an API key configured. Until the merchant finishes
// 360dialog onboarding (account + number + approved template) and we store their
// key, sendTemplate returns { ok:false, reason:'not_configured' } instead of
// throwing — so the rest of the app keeps working and the UI can show a clear msg.

const shopify = require('./shopify-client');
const credits = require('./credits-engine');

const D360_BASE = 'https://waba-v2.360dialog.io';

// Normalize an Israeli phone to international digits (972XXXXXXXXX), no +, no spaces.
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, '');
  if (!p) return null;
  if (p.startsWith('0')) p = '972' + p.slice(1);
  else if (!p.startsWith('972') && p.length === 9) p = '972' + p; // bare 9-digit
  return p;
}

// Is this shop ready to send (has an API key)?
function isConfigured(shop) {
  const cfg = shopify.getWhatsAppConfig(shop);
  return !!(cfg && cfg.d360_api_key);
}

// Send ONE approved template message.
//   shop          - shop_domain (selects the API key)
//   to            - recipient phone (any local format; normalized here)
//   templateName  - the APPROVED template's name in the WABA
//   bodyParams    - array of strings filling {{1}}, {{2}}, ... in the template body
//   opts.languageCode - override template language (default from store, else 'he')
//   opts.urlSuffix    - fills the dynamic URL button's {{1}} (personal cart/coupon link).
//                       The template must have been approved with a dynamic URL button.
//
// Returns:
//   { ok:true, message_id, balance }                    on success (1 credit spent)
//   { ok:false, reason:'no_credits', balance:0 }         caller should prompt top-up
//   { ok:false, reason:'not_configured' }                no API key yet
//   { ok:false, reason:'bad_phone' }                     phone couldn't be parsed
//   { ok:false, reason:'api_error', status, error }      360dialog/Meta rejected
async function sendTemplate(shop, to, templateName, bodyParams = [], opts = {}) {
  const cfg = shopify.getWhatsAppConfig(shop);
  if (!cfg || !cfg.d360_api_key) return { ok: false, reason: 'not_configured' };

  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: 'bad_phone' };

  const languageCode = opts.languageCode || cfg.wa_language || 'he';

  // 1) Reserve a credit FIRST so we never send without charging.
  const deduct = await credits.deductOne(shop, { to: phone, template: templateName, ...(opts.meta || {}) });
  if (!deduct.ok) {
    if (deduct.reason === 'no_credits') return { ok: false, reason: 'no_credits', balance: 0 };
    return { ok: false, reason: 'credit_error', error: deduct.error };
  }

  // 2) Build the template payload.
  const components = [];
  if (Array.isArray(bodyParams) && bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(v => ({ type: 'text', text: String(v == null ? '' : v) }))
    });
  }
  // Dynamic URL button: index 0 is the first button in the approved template.
  // Its suffix parameter completes the fixed base URL defined at approval time.
  if (opts.urlSuffix) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(opts.urlSuffix) }]
    });
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {})
    }
  };

  // 3) Send via 360dialog. Marketing templates may go via /marketing_messages,
  //    but /messages works for all types; we use /messages for simplicity.
  try {
    const resp = await fetch(`${D360_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'D360-API-KEY': cfg.d360_api_key
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Failed after deduct -> refund the credit so the merchant isn't charged.
      await credits.refundOne(shop, { to: phone, template: templateName, failed: true });
      const errMsg = (data && (data.error?.message || data.message)) || `HTTP ${resp.status}`;
      return { ok: false, reason: 'api_error', status: resp.status, error: errMsg };
    }

    const messageId = data?.messages?.[0]?.id || null;
    return { ok: true, message_id: messageId, balance: deduct.balance };
  } catch (err) {
    await credits.refundOne(shop, { to: phone, template: templateName, failed: true });
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

// Send the same template to MANY recipients. Stops early if credits run out, so
// the merchant knows exactly how many went and how many remain unsent.
//   recipients: [{ to, params:[...], meta:{} }]
// Returns { ok, sent, failed, stopped_no_credits, results:[...] }
async function sendTemplateBatch(shop, templateName, recipients = [], opts = {}) {
  if (!isConfigured(shop)) return { ok: false, reason: 'not_configured' };
  let sent = 0, failed = 0, stoppedNoCredits = false;
  const results = [];
  for (const r of recipients) {
    const res = await sendTemplate(shop, r.to, templateName, r.params || [], {
      ...opts,
      urlSuffix: r.urlSuffix || opts.urlSuffix || null,
      meta: r.meta || {}
    });
    results.push({ to: r.to, ...res });
    if (res.ok) { sent++; }
    else if (res.reason === 'no_credits') { stoppedNoCredits = true; break; }
    else { failed++; }
  }
  return { ok: true, sent, failed, stopped_no_credits: stoppedNoCredits, results };
}

module.exports = {
  normalizePhone,
  isConfigured,
  sendTemplate,
  sendTemplateBatch
};