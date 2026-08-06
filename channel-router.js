// ============================================================================
// CHANNEL ROUTER — which channel each customer gets, and why.
//
// The agent used to let the learned policy pick the channel freely. That is the
// wrong tool for this decision, because the channels are not interchangeable:
//
//   EMAIL     — always available, costs effectively nothing. The floor: any
//               customer with an address can always be reached.
//   SMS       — costs money per message but gets read. Preferred over email
//               whenever we have a phone number and a configured provider.
//   WHATSAPP  — the most expensive by far, and billed against credits the
//               merchant funds up front. Only used when they have deliberately
//               enabled it AND there is balance left. When the balance runs out
//               the agent quietly drops back to SMS rather than stopping.
//
// So precedence is a business rule, not something to learn: WhatsApp (funded)
// → SMS → email, each step falling through when its requirement is not met.
// The policy still learns WITHIN what is available — it just cannot decide to
// spend the merchant's credits on a channel they did not pay for.
//
// Every decision returns the reason, so "why did she get an email and not a
// text?" has an answer.
// ============================================================================

const smsSender = require('./sms-sender');
const mailer = require('./mailer');

function hasPhone(c) {
  const p = String((c && c.phone) || '').replace(/[^0-9]/g, '');
  return p.length >= 9;
}
function hasEmail(c) {
  const e = String((c && c.email) || '').trim();
  return e.length >= 5 && e.includes('@');
}

// What this SHOP could use at all, before looking at any single customer.
// `credits` is passed in so a batch resolves the balance once, not per customer.
async function shopChannels(shop, settings, opts = {}) {
  const out = { whatsapp: false, sms: false, email: false, why: {} };

  out.email = mailer.isConfigured();
  if (!out.email) out.why.email = 'RESEND_API_KEY not configured';

  // TextMe needs both the account env vars and a sender id approved for this shop.
  out.sms = smsSender.isConfigured() && !!settings.sms_sender;
  if (!out.sms) {
    out.why.sms = !smsSender.isConfigured()
      ? 'SMS provider not configured'
      : 'no approved sender id for this shop';
  }

  // WhatsApp is opt-in AND pre-paid. Both must be true.
  const wantsWa = settings.whatsapp_enabled === true || settings.whatsapp_enabled === 'true';
  if (!wantsWa) {
    out.why.whatsapp = 'not enabled for this shop';
  } else {
    let configured = false;
    try { configured = require('./whatsapp-sender').isConfigured(shop); } catch (e) { configured = false; }
    if (!configured) {
      out.why.whatsapp = 'no WhatsApp API key for this shop';
    } else {
      let balance = opts.credits;
      if (balance === undefined) {
        try { balance = await require('./credits-engine').getBalance(shop); }
        catch (e) { balance = 0; }
      }
      out.credits = balance;
      if (!(balance > 0)) out.why.whatsapp = 'no credits left';
      else out.whatsapp = true;
    }
  }
  return out;
}

// The channel for ONE customer, given what the shop can do.
// Returns { channel, reason, considered } — channel is null when unreachable.
function pickForCustomer(customer, available) {
  const considered = [];
  const phone = hasPhone(customer), email = hasEmail(customer);

  if (available.whatsapp) {
    if (phone) return { channel: 'whatsapp', reason: 'funded_whatsapp', considered };
    considered.push('whatsapp: no phone');
  } else if (available.why && available.why.whatsapp) {
    considered.push('whatsapp: ' + available.why.whatsapp);
  }

  if (available.sms) {
    if (phone) return { channel: 'sms', reason: 'preferred_sms', considered };
    considered.push('sms: no phone');
  } else if (available.why && available.why.sms) {
    considered.push('sms: ' + available.why.sms);
  }

  if (available.email) {
    if (email) return { channel: 'email', reason: 'fallback_email', considered };
    considered.push('email: no address');
  } else if (available.why && available.why.email) {
    considered.push('email: ' + available.why.email);
  }

  return { channel: null, reason: 'unreachable', considered };
}

// Route a whole batch in one pass: resolves the shop's capability once, then
// assigns per customer. Returns { assignments, available, counts }.
async function route(shop, customers, settings, opts = {}) {
  const available = await shopChannels(shop, settings, opts);
  const assignments = [];
  const counts = { whatsapp: 0, sms: 0, email: 0, unreachable: 0 };

  // WhatsApp is capped by the credit balance: assigning more than we can pay
  // for would only fail at send time. Everyone past the cap drops to SMS/email.
  let waLeft = available.whatsapp ? (available.credits || 0) : 0;

  for (const c of customers || []) {
    const canWa = available.whatsapp && waLeft > 0;
    const pick = pickForCustomer(c, { ...available, whatsapp: canWa });
    if (pick.channel === 'whatsapp') waLeft--;
    counts[pick.channel || 'unreachable']++;
    assignments.push({ customer: c, ...pick });
  }
  return { assignments, available, counts };
}

module.exports = { route, pickForCustomer, shopChannels, hasPhone, hasEmail };
