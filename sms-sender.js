// ============================================================================
// SMS — one interface, two providers, chosen per shop.
//
//   Twilio  — global. Every shop.
//   TextMe  — Israeli only. The pilot shop, and nothing else.
//
// TextMe reaches Israeli mobiles and nothing else, which meant a store anywhere
// else could set a sender id, watch the SMS channel go green, and have every
// send fall through to email. Twilio is the provider that makes SMS mean
// something for the rest of the world.
//
// The pilot shop stays on TextMe deliberately. It holds an approved sender id
// there and has been sending through it; moving it would mean its texts stop
// until a new sender id is approved somewhere else, for no benefit. That is the
// whole reason the routing exists — not because two providers are nice, but
// because one working thing should not be broken to tidy up.
//
// WHAT CHANGED IN THE PUBLIC INTERFACE
//
// isConfigured() and canReach() used to take no shop. With one provider that
// was merely imprecise; with two it is wrong, and it is the same shape as the
// bug that offered an SMS checkbox to a store that could not send. Both now
// take the shop. Callers that pass none get the honest answer for the default.
// ============================================================================

const textme = require('./sms-provider-textme');
const twilio = require('./sms-provider-twilio');
const compliance = require('./compliance');

const DEFAULT_SHOP = 'seven770.myshopify.com';

/**
 * Which provider serves this shop?
 *
 * The pilot shop is pinned to TextMe by name rather than by configuration, so
 * that adding Twilio credentials cannot silently move it.
 */
function providerFor(shop) {
  const s = String(shop || '').toLowerCase().trim();
  if (s === DEFAULT_SHOP) return textme;
  return twilio;
}

function providerName(shop) {
  return providerFor(shop).NAME;
}

/** Is the provider serving this shop configured at all? */
function isConfigured(shop) {
  return providerFor(shop).isConfigured();
}

/**
 * Can this shop's provider actually deliver to this number?
 *
 * Asked BEFORE the router picks SMS, so an unreachable number costs nothing and
 * falls through to email — rather than being retried three times and marked
 * failed while a perfectly good email address sat unused.
 */
function canReach(phone, shop, opts = {}) {
  const p = providerFor(shop);
  return p.canReach(phone, opts);
}

function normalizePhone(phone, shop, opts = {}) {
  return providerFor(shop).normalizePhone(phone, opts);
}

// ---------------------------------------------------------------------------
// THE OPT-OUT LINK
//
// TextMe appended one automatically (add_unsubscribe=3). Twilio does not — so
// the legal opt-out on every text this platform sends came from the provider,
// and swapping providers without noticing would have removed it from every
// message silently.
//
// An alphanumeric sender cannot receive replies, so "reply STOP" is not an
// opt-out for us anywhere. A link is the only mechanism that works.
//
// Signed with the same key and the same scheme as the email unsubscribe links,
// so one verifier serves both.
// ---------------------------------------------------------------------------
function optOutUrlFor(shop, phone) {
  try {
    const crypto = require('crypto');
    const base = require('./base-url').baseUrl();
    // The last nine digits, inlined rather than imported. This function decides
    // whether a message can legally go out at all, and it must not fail because
    // some caller replaced the compliance module with a partial stub.
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    const key = digits.length >= 9 ? digits.slice(-9) : null;
    if (!key) return null;
    const secret = process.env.UNSUBSCRIBE_SECRET || process.env.ADMIN_PASSWORD || 'unsub';
    const sig = crypto.createHmac('sha256', secret)
      .update(key + '|' + String(shop), 'utf8')
      .digest('base64url').slice(0, 16);
    // Short on purpose: every character is billed, and past 160 the message
    // becomes two. ".myshopify.com" is fourteen of those characters and is the
    // same for every shop, so the link carries the prefix and the server puts
    // the suffix back. The signature is still over the full domain.
    const short = String(shop).replace(/\.myshopify\.com$/, '');
    return `${base}/u?p=${encodeURIComponent(key)}&s=${encodeURIComponent(short)}&t=${sig}`;
  } catch (e) {
    return null;
  }
}

/**
 * Send one SMS. Returns { ok, error?, skipped? }.
 *
 * The sender id is the SHOP's own, always. Without one we refuse rather than
 * borrow another shop's: signing a store's text with a different brand's name
 * is impersonation, and on a shared provider account it burns that brand's
 * sender reputation for messages it never authorised.
 */
async function sendOne(shop, { phone, message, sender, country }) {
  const p = providerFor(shop);
  if (!p.isConfigured()) return { ok: false, error: 'not_configured' };

  let shopSender = sender || null;
  let shopCountry = country || null;
  if (!shopSender || !shopCountry) {
    try {
      const settings = await require('./store-settings').getSettings(shop);
      shopSender = shopSender || settings.sms_sender;
      // country_code first; the timezone is the fallback for shops that
      // installed before that column existed.
      shopCountry = shopCountry || settings.country_code
        || twilio.countryFromTimezone(settings.timezone) || null;
    } catch (e) { /* handled below */ }
  }

  if (!shopSender) {
    return { ok: false, error: 'no_sender_id',
      detail: 'לחנות הזו אין עדיין מזהה שולח מאושר ל-SMS. עד שיוגדר, הפניות יישלחו במייל.' };
  }

  return p.send(shop, {
    phone,
    message,
    sender: shopSender,
    country: shopCountry,
    // TextMe builds its own; Twilio refuses to send without one.
    optOutUrl: p.NAME === 'twilio' ? optOutUrlFor(shop, phone) : null
  });
}

/**
 * Send to many. Messages differ per recipient (personalisation), so this sends
 * individually in a controlled loop.
 */
async function sendBatch(shop, recipients, { sender } = {}) {
  if (!isConfigured(shop)) return { ok: false, error: 'not_configured', sent: 0, failed: 0, skipped: 0 };
  let sent = 0, failed = 0, skipped = 0;
  const results = [];
  for (const rcp of recipients) {
    const res = await sendOne(shop, { phone: rcp.phone, message: rcp.message, sender });
    if (res.ok) sent++;
    else if (res.skipped) skipped++;
    else failed++;
    results.push({ phone: rcp.phone, name: rcp.name || null, ok: res.ok, error: res.error || null });
  }
  return { ok: true, sent, failed, skipped, results };
}

/** Remaining balance, where the provider has such a concept. */
async function getBalance(shop) {
  return providerFor(shop).getBalance();
}

module.exports = {
  isConfigured, normalizePhone, sendOne, sendBatch, getBalance, canReach,
  providerFor, providerName, optOutUrlFor, DEFAULT_SHOP
};
