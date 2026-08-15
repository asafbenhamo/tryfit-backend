// ============================================================================
// FLASHY SYNC — bidirectional opt-out (unsubscribe) sync with Flashy.
//
// Flashy is the merchant's PRIMARY email/SMS platform. To avoid contacting anyone
// who has unsubscribed (a spam-law exposure for the merchant), we keep both lists
// in sync:
//
//   1. WE → FLASHY  (pushUnsubscribe): when someone opts out through the advisor,
//      push that removal to Flashy so they stop there too.
//
//   2. FLASHY → US  (handleWebhook): when someone unsubscribes in Flashy, Flashy
//      fires a `contact_unsubscribed` webhook (contact_id only, no email/phone).
//      We resolve the contact_id to email/phone via Flashy's API, then add them to
//      our local message_optouts so the advisor never contacts them.
//
// DESIGN — FAIL-SAFE: A failure talking to Flashy must NEVER block a local opt-out.
// The local removal always wins; the Flashy push is best-effort and logged.
//
// ENV:
//   FLASHY_API_KEY        — API key from the merchant's Flashy account ("General")
//   FLASHY_LIST_ID        — main list id (31840)
//   FLASHY_WEBHOOK_SECRET — shared secret to verify incoming webhooks (optional)
//   FLASHY_SHOP           — shop domain these opt-outs belong to (e.g. seven770.myshopify.com)
// ============================================================================

const compliance = require('./compliance');

// Base URL for Flashy's REST API. Flashy moved off the old flashyapp.com/api host;
// the current base is my.flashy.app. Overridable via env in case it changes again.
const FLASHY_BASE = process.env.FLASHY_API_BASE || 'https://my.flashy.app/api';

function apiKey()        { return process.env.FLASHY_API_KEY || null; }
function listId()        { return process.env.FLASHY_LIST_ID || '31840'; }
function webhookSecret() { return process.env.FLASHY_WEBHOOK_SECRET || null; }
function shopDomain()    { return process.env.FLASHY_SHOP || 'seven770.myshopify.com'; }

function isConfigured() {
  return !!(apiKey() && listId());
}

// ---------------------------------------------------------------------------
// 1. WE → FLASHY : push an unsubscribe to Flashy (best-effort, never throws).
//    Called AFTER a successful local opt-out. Accepts { email, phone }.
// ---------------------------------------------------------------------------
async function pushUnsubscribe({ email, phone } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!email && !phone) return { ok: false, reason: 'no_identifier' };

  // Flashy unsubscribe endpoint. When removing by phone, phone_contact:true tells
  // Flashy the subscriber key is a phone number rather than an email.
  const subscriber = {};
  if (email) subscriber.email = email;
  if (phone) subscriber.phone = phone;

  const body = {
    key: apiKey(),
    subscriber,
    phone_contact: (!email && !!phone) // phone-only removal
  };

  try {
    const r = await fetch(`${FLASHY_BASE}/lists/${listId()}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const raw = await r.text();
    if (!r.ok) {
      console.error('[flashy-sync] push failed:', r.status, raw.slice(0, 200));
      return { ok: false, reason: `http_${r.status}`, detail: raw.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    console.error('[flashy-sync] push error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Resolve a Flashy contact_id (hash) to its email/phone, so we can store a
// meaningful opt-out locally. The webhook only gives us the contact_id.
// Best-effort: returns { email, phone } or {} if it can't be resolved.
// ---------------------------------------------------------------------------
async function resolveContact(contactId) {
  if (!isConfigured() || !contactId) return {};
  try {
    // Flashy exposes contact lookup by id. We try the documented contacts endpoint;
    // if the shape differs, we degrade gracefully and return {} (caller handles it).
    const r = await fetch(`${FLASHY_BASE}/contacts/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey(), contact_id: contactId })
    });
    if (!r.ok) return {};
    const data = await r.json().catch(() => ({}));
    // Flashy contact objects expose email/phone at the top level or under .contact.
    const c = (data && (data.contact || data.data || data)) || {};
    return {
      email: c.email || null,
      phone: c.phone || c.phone_number || null
    };
  } catch (err) {
    console.error('[flashy-sync] resolveContact error:', err.message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// 2. FLASHY → US : handle an incoming webhook.
//    Flashy posts an array of events; we act on `contact_unsubscribed`.
//    We resolve the contact and add a LOCAL opt-out. Fail-safe: if we can't
//    resolve email/phone, we still record the contact_id as a marker so there's
//    an audit trail (and a follow-up import can reconcile it).
// ---------------------------------------------------------------------------
async function handleWebhook(payload, providedSecret) {
  // Shared-secret check. The old condition also required `providedSecret` to be
  // truthy, so a caller who simply OMITTED the secret skipped verification
  // entirely — the check was bypassed by sending less, not more.
  const secret = webhookSecret();
  if (secret) {
    const given = String(providedSecret || '');
    if (!given || given.length !== secret.length) {
      return { ok: false, reason: 'bad_secret', processed: 0 };
    }
    const crypto = require('crypto');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad_secret', processed: 0 };
    }
  }

  // Flashy sends either a single event object or an array of them.
  const events = Array.isArray(payload) ? payload : [payload];
  let processed = 0, skipped = 0;

  for (const ev of events) {
    if (!ev || ev.event !== 'contact_unsubscribed') { skipped++; continue; }
    const contactId = ev.contact_id || null;
    if (!contactId) { skipped++; continue; }

    let { email, phone } = await resolveContact(contactId);

    // Fail-safe: even if we couldn't resolve the real email/phone, record SOMETHING
    // so the removal is not silently lost. We store the contact_id under email as a
    // marker (prefixed) — a later import can reconcile it to a real address.
    if (!email && !phone) {
      email = `flashy:${contactId}`;
    }

    try {
      await compliance.addOptOut(shopDomain(), { email, phone, reason: 'flashy_webhook' });
      processed++;
    } catch (err) {
      console.error('[flashy-sync] local opt-out failed:', err.message);
      skipped++;
    }
  }

  return { ok: true, processed, skipped };
}

// ---------------------------------------------------------------------------
// optOutEverywhere : the single entry point for "remove this person everywhere".
// Always does the LOCAL opt-out first (authoritative), then best-effort pushes to
// Flashy. A Flashy failure never affects the local result.
// ---------------------------------------------------------------------------
async function optOutEverywhere(shop, { email, phone, reason } = {}) {
  // 1. Local opt-out ALWAYS first and always wins.
  let local;
  try {
    local = await compliance.addOptOut(shop, { email, phone, reason: reason || 'manual' });
  } catch (err) {
    console.error('[flashy-sync] local addOptOut failed:', err.message);
    local = { ok: false, error: err.message };
  }

  // 2. Best-effort push to Flashy — but ONLY for the shop that owns this Flashy
  //    account.
  //
  //    There is one global FLASHY_API_KEY and one global list, belonging to the
  //    pilot merchant. This pushed on every opt-out from every shop, so a
  //    customer of merchant B who unsubscribed had their email handed to a
  //    different merchant's mailing-list account — disclosing one store's
  //    customer to another, on the one action where the person had just asked
  //    to be left alone.
  let flashy = { ok: false, reason: 'not_configured' };
  if (isConfigured()) {
    if (shop && shop !== shopDomain()) {
      flashy = { ok: false, reason: 'not_this_shops_account' };
    } else {
      flashy = await pushUnsubscribe({ email, phone });
    }
  }

  return { ok: true, local, flashy };
}

// ---------------------------------------------------------------------------
// status : quick health/config view for the /webhook/flashy/status route.
// ---------------------------------------------------------------------------
function status() {
  return {
    configured: isConfigured(),
    has_api_key: !!apiKey(),
    list_id: listId(),
    webhook_secret_set: !!webhookSecret(),
    shop: shopDomain()
  };
}

module.exports = {
  isConfigured,
  pushUnsubscribe,
  handleWebhook,
  optOutEverywhere,
  resolveContact,
  status
};