// ============================================================================
// SMS SENDER — sends SMS via TextMe (textme.co.il), an Israeli SMS provider.
//
// API: POST https://my.textme.co.il/api  (JSON)
//   username     — account username
//   source       — sender ID (e.g. "770"), max 11 chars, letters/digits only
//   message      — up to 1005 chars (TextMe allows 201 Hebrew chars per single SMS)
//   destinations — { phone: [{ phone: "05XXXXXXXX" }, ...] }
//   add_unsubscribe = 3 — TextMe appends a one-click unsubscribe link automatically
//
// Config per shop (or global env):
//   TEXTME_USERNAME, TEXTME_API_KEY (password), TEXTME_SENDER (default sender id)
//
// Opt-out is enforced TWICE for safety:
//   1. We skip any phone already in our message_optouts table (compliance).
//   2. We pass add_unsubscribe=3 so TextMe adds its own removal link (legal req).
// ============================================================================

const compliance = require('./compliance');

const TEXTME_ENDPOINT = 'https://my.textme.co.il/api';

function isConfigured() {
  return !!(process.env.TEXTME_USERNAME && process.env.TEXTME_API_KEY);
}

// Normalize an Israeli phone to TextMe's accepted format (05XXXXXXXX).
//
// TextMe is an Israeli provider and only reaches Israeli mobiles. That is a real
// limit of the provider, not something normalisation can fix by accepting more
// formats — a +1 number handed to TextMe is not delivered, it is rejected.
//
// What was wrong was the layers ABOVE this one. The settings screen lets any
// shop enter a sender id, which switched SMS on; the router then sent every
// phone-owning customer down this path; and the queue treated the resulting
// invalid_phone as a transient failure, retried it three times and marked it
// failed. Those customers were never reached by ANY channel, even though most
// of them had a perfectly good email address — and they still counted against
// the shop's daily budget. canReach() below lets the router skip SMS for a
// number this provider cannot deliver to and fall through to email instead.
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, '');
  // Convert international 972 prefix to local 0.
  if (p.startsWith('972')) p = '0' + p.slice(3);
  // Must be a valid Israeli mobile: 05XXXXXXXX (10 digits).
  if (/^05\d{8}$/.test(p)) return p;
  // Sometimes stored without leading 0 (5XXXXXXXX).
  if (/^5\d{8}$/.test(p)) return '0' + p;
  return null; // invalid, not a mobile, or outside this provider's reach
}

// Can the configured SMS provider actually deliver to this number? Asked BEFORE
// choosing SMS, so an unreachable number costs nothing and falls through to a
// channel that works.
function canReach(phone) {
  return normalizePhone(phone) !== null;
}

// Send one SMS. Returns { ok, id?, error? }.
async function sendOne(shop, { phone, message, sender }) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, error: 'invalid_phone' };

  // Opt-out gate (our own list).
  if (await compliance.isOptedOut(shop, { phone: to })) {
    return { ok: false, error: 'opted_out', skipped: true };
  }

  // SMS AS A SERVICE: the sender id is the SHOP's own name/number (from its
  // settings, once verified with the SMS provider), falling back to the global
  // env sender. Every shop's customers see the shop's name, not ours.
  let shopSender = sender || null;
  if (!shopSender) {
    try { shopSender = (await require('./store-settings').getSettings(shop)).sms_sender; }
    catch (e) { /* handled below */ }
  }
  // Refuse rather than borrow another shop's identity. Sending a store's
  // customers a text signed with a different brand's name is impersonation, and
  // on a shared provider account it also puts that brand's sender reputation at
  // risk for messages it never authorised.
  if (!shopSender) {
    return { ok: false, error: 'no_sender_id',
      detail: 'לחנות הזו אין עדיין מזהה שולח מאושר ל-SMS. עד שיוגדר, הפניות יישלחו במייל.' };
  }

  // Body per TextMe docs: everything wrapped in "sms", username under "user",
  // each phone as { "_": "05xxxxxxxx" }. Auth is via Bearer TOKEN header.
  const body = {
    sms: {
      user: { username: process.env.TEXTME_USERNAME },
      source: String(shopSender).slice(0, 11),
      message: message,
      add_unsubscribe: 3, // TextMe appends its own one-click removal link (legal)
      destinations: { phone: [ { "_": to } ] }
    }
  };

  try {
    const r = await fetch(TEXTME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TEXTME_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch (e) { data = { raw }; }

    if (!r.ok) return { ok: false, error: `http_${r.status}`, detail: raw.slice(0, 300) };

    // TextMe success = status 0 (with a shipment_id). Any nonzero status is an error;
    // the "message" field then describes it. We never report a false success.
    const status = data && data.status;
    const isSuccess = (status === 0 || status === '0');
    if (isSuccess) {
      return { ok: true, response: data, shipment_id: data.shipment_id || null };
    }
    // Error: surface TextMe's own message + the raw body for debugging.
    const msg = (data && data.message) ? data.message : 'unknown_response';
    return { ok: false, error: `TextMe status ${status}: ${msg}`, detail: raw.slice(0, 300), response: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Send to many recipients. Each recipient: { phone, message, name? }.
// Messages can differ per recipient (personalization), so we send individually
// but in a controlled loop. Returns { ok, sent, failed, skipped, results }.
async function sendBatch(shop, recipients, { sender } = {}) {
  if (!isConfigured()) return { ok: false, error: 'not_configured', sent: 0, failed: 0, skipped: 0 };
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

// Check remaining balance (so the agent can warn before a big campaign).
async function getBalance() {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  try {
    const r = await fetch('https://my.textme.co.il/api/getBalance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TEXTME_API_KEY}`
      },
      body: JSON.stringify({
        username: process.env.TEXTME_USERNAME
      })
    });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
    return { ok: r.ok, balance: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, normalizePhone, sendOne, sendBatch, getBalance, canReach };