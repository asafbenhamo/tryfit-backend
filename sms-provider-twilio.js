// ============================================================================
// TWILIO — the global SMS provider.
//
// TextMe reaches Israeli mobiles and nothing else. Any store outside Israel
// could set a sender id, watch the SMS channel go green, and then have every
// single send fall through to email because the number was unreachable. This is
// the provider that makes SMS mean something for the rest of the world.
//
// TextMe stays in place for the pilot store, which already holds an approved
// sender id there. Nothing about that shop changes. See sms-sender.js.
//
// API: POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
//   Basic auth: AccountSid : AuthToken
//   form-encoded: To, From (or MessagingServiceSid), Body
//
// Config: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//         TWILIO_MESSAGING_SERVICE_SID (optional but preferred),
//         TWILIO_FROM_NUMBER (fallback sender where a name is not allowed)
//
// TWO THINGS THAT ARE NOT OBVIOUS AND WILL BITE
//
// 1. Twilio does NOT append an opt-out. TextMe did, automatically, via
//    add_unsubscribe=3 — which means the legal opt-out on every text this
//    platform has ever sent came from the provider, not from us. Swapping
//    providers without noticing would have quietly removed it from every
//    message. So this module appends one itself, and refuses to send if it
//    cannot build one.
//
// 2. An alphanumeric sender ("WILLOW") cannot receive replies, anywhere. So
//    "reply STOP" is not an opt-out for us — a link is the only one that works.
//    And in the US and Canada Twilio does not permit alphanumeric senders at
//    all; a text there needs a real number, which has to be bought per account.
//    Rather than fail at send time, canReach() says so up front so the router
//    picks email instead.
// ============================================================================

const compliance = require('./compliance');

const NAME = 'twilio';

// Countries where the carriers refuse an alphanumeric sender id. A message to
// these needs a real originating number.
// Sources differ on the long tail; these are the ones that matter for a
// storefront and are not in dispute.
const NO_ALPHA_SENDER = new Set(['US', 'CA', 'CN', 'PR', 'VI', 'GU', 'AS', 'MP']);

// Enough of the E.164 country map to resolve a local number when we know the
// store's country. Anything else must arrive already in E.164, which is how
// Shopify stores customer phone numbers.
const DIAL_CODES = {
  IL: '972', US: '1', CA: '1', GB: '44', AU: '61', NZ: '64', IE: '353',
  DE: '49', FR: '33', ES: '34', IT: '39', NL: '31', BE: '32', PT: '351',
  SE: '46', NO: '47', DK: '45', FI: '358', PL: '48', CZ: '420', AT: '43',
  CH: '41', GR: '30', RO: '40', HU: '36', BG: '359', HR: '385', SK: '421',
  BR: '55', MX: '52', AR: '54', CL: '56', CO: '57', ZA: '27', IN: '91',
  JP: '81', KR: '82', SG: '65', HK: '852', TH: '66', MY: '60', PH: '63',
  ID: '62', VN: '84', TR: '90', AE: '971', SA: '966', EG: '20', RU: '7',
  UA: '380', CY: '357', MT: '356', LU: '352', IS: '354', EE: '372',
  LV: '371', LT: '370', SI: '386', RS: '381'
};

// The store's country, when nobody recorded it.
//
// country_code is captured at install, but shops that installed before that
// column existed have none — and without a country a LOCAL number ("054...")
// cannot be expanded into E.164 at all. Every one of those customers would go
// unreachable overnight.
//
// The timezone has been captured since long before, and for these zones it
// names the country unambiguously. Anything not listed returns null, which is
// honest: numbers already in E.164 still work, local ones do not.
const TZ_COUNTRY = {
  'Asia/Jerusalem': 'IL', 'Asia/Tel_Aviv': 'IL',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Lisbon': 'PT',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ',
  'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH', 'Europe/Athens': 'GR',
  'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO', 'Europe/Istanbul': 'TR',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Singapore': 'SG',
  'Asia/Hong_Kong': 'HK', 'Asia/Bangkok': 'TH', 'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE',
  'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Santiago': 'CL', 'America/Bogota': 'CO'
};

// Every US and Canadian zone shares one dial code, so the prefix is enough.
function countryFromTimezone(tz) {
  const z = String(tz || '');
  if (!z) return null;
  if (TZ_COUNTRY[z]) return TZ_COUNTRY[z];
  if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Toronto|Vancouver|Edmonton|Winnipeg|Halifax)$/.test(z)) return 'US';
  if (/^(US|Canada)\//.test(z)) return 'US';
  return null;
}

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

/**
 * To E.164 ("+972541234567"). Returns null when we cannot be sure — and null
 * genuinely means "do not try", because a wrong guess is a message delivered to
 * a stranger, or billed and dropped.
 *
 * `country` is the STORE's country, used only to expand a local number. A
 * number that already carries a country code is never reinterpreted.
 */
function normalizePhone(raw, { country } = {}) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Already international.
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/[^0-9]/g, '');
    return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : null;
  }
  // 00 is the other way of writing +.
  const bare = s.replace(/[^0-9]/g, '');
  if (bare.startsWith('00')) {
    const digits = bare.slice(2);
    return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : null;
  }

  // Local number. Only resolvable if we know which country it is local TO.
  const cc = String(country || '').toUpperCase();
  const dial = DIAL_CODES[cc];
  if (!dial) return null;

  // National trunk prefix: most countries write local numbers with a leading 0
  // that is dropped in international form. North America does not.
  let national = bare;
  if (dial !== '1' && national.startsWith('0')) national = national.slice(1);
  if (!/^\d{6,14}$/.test(national)) return null;

  const full = dial + national;
  return /^[1-9]\d{7,14}$/.test(full) ? '+' + full : null;
}

/** Country of an E.164 number, for the alphanumeric-sender rules. */
function countryOf(e164) {
  if (!e164 || !e164.startsWith('+')) return null;
  const d = e164.slice(1);
  if (d.startsWith('1')) return 'US';              // NANP — treated as no-alpha
  for (const [cc, dial] of Object.entries(DIAL_CODES)) {
    if (dial !== '1' && d.startsWith(dial)) return cc;
  }
  return null;
}

/** Is an alphanumeric sender id allowed for this destination? */
function allowsAlphaSender(e164) {
  const cc = countryOf(e164);
  return !(cc && NO_ALPHA_SENDER.has(cc));
}

/**
 * Can we deliver to this number at all?
 *
 * Answered BEFORE the router picks SMS, so an unreachable number costs nothing
 * and falls through to email rather than being retried three times and written
 * off — which is what used to happen to every non-Israeli customer.
 */
function canReach(phone, opts = {}) {
  const to = normalizePhone(phone, opts);
  if (!to) return false;
  // A destination that forbids alphanumeric senders is only reachable if we
  // actually hold a number to send from. Saying "reachable" and then failing at
  // send time is the exact trap this replaces.
  // A destination that forbids a shop-name sender is reachable only if we hold
  // something else to send from: a Messaging Service pool, or a number. Saying
  // "reachable" and then failing at send time is the trap this replaces.
  if (!allowsAlphaSender(to) && !fromNumber() && !messagingServiceSid()) return false;
  return true;
}

function fromNumber() {
  return process.env.TWILIO_FROM_NUMBER || null;
}

// A Messaging Service is a POOL of senders — an alphanumeric id, a UK long code,
// a US toll-free number, whatever has been added to it — and Twilio picks the
// one that is legal for each destination, per message.
//
// This is what makes one account reach customers in many countries. Buying a
// number in the console asks which country the NUMBER lives in; it does not
// decide who you may text. Destinations are governed by the account's
// Geo Permissions, and the sender for each destination is what the pool solves.
function messagingServiceSid() {
  return process.env.TWILIO_MESSAGING_SERVICE_SID || null;
}

// The Twilio errors whose cause is a setting, not a bug. Without this the
// merchant sees a number and a sentence and has no idea that the answer is one
// checkbox in a console they may never have opened.
const TWILIO_CODES = {
  21408: {
    he: 'החשבון לא מורשה לשלוח למדינה הזו. צריך להפעיל אותה ב-Geo Permissions.',
    en: 'The account is not permitted to send to this country. Enable it in Geo Permissions.',
    fix: 'Twilio Console → Messaging → Settings → Geo Permissions'
  },
  21606: {
    he: 'המספר שממנו שולחים לא מתאים ליעד הזה.',
    en: 'The From number cannot send to this destination.',
    fix: 'Add a sender for this country to the Messaging Service sender pool'
  },
  21612: {
    he: 'אין מסלול מהמספר הזה ליעד הזה.',
    en: 'No route from this sender to this destination.',
    fix: 'Add a sender for this country to the Messaging Service sender pool'
  },
  21608: {
    he: 'חשבון הניסיון של Twilio שולח רק למספרים מאומתים.',
    en: 'A Twilio trial account can only send to verified numbers.',
    fix: 'Upgrade the Twilio account, or verify the destination number'
  },
  21211: {
    he: 'מספר הטלפון של הלקוח אינו תקין.',
    en: "The customer's phone number is not valid.",
    fix: null
  }
};

async function send(shop, { phone, message, sender, country, optOutUrl }) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };

  const to = normalizePhone(phone, { country });
  if (!to) return { ok: false, error: 'invalid_phone' };

  if (await compliance.isOptedOut(shop, { phone: to })) {
    return { ok: false, error: 'opted_out', skipped: true };
  }

  // Pick who the message comes from.
  //
  // Preference is the shop's own name, because that is what a customer
  // recognises. Where the destination forbids it, a real number is the only
  // legal option — and if we hold none, refuse rather than borrow one, exactly
  // as the SMS path has always refused to borrow a sender id.
  let from = null;
  let useService = false;
  if (sender && allowsAlphaSender(to)) {
    // Most of the world: the shop's own name, no number needed anywhere.
    from = String(sender).slice(0, 11);
  } else if (messagingServiceSid()) {
    // The US, Canada and the rest of the no-name list. Let Twilio choose a
    // compliant sender from the pool rather than guessing at one here.
    useService = true;
  } else if (fromNumber()) {
    from = fromNumber();
  } else {
    return {
      ok: false,
      error: 'no_sender_for_destination',
      detail: `במדינה של ${to} אי אפשר לשלוח בשם החנות, וצריך מספר אמיתי או Messaging Service שאין לנו. ההודעה תישלח במייל.`
    };
  }

  // The opt-out. TextMe added one for us; Twilio does not, and a marketing text
  // with no way off the list is not a thing to send by accident.
  if (!optOutUrl) {
    return { ok: false, error: 'no_optout_link', detail: 'refusing to send marketing SMS without an opt-out' };
  }
  const body = `${message}\n${optOutUrl}`;

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', body);
  // A Messaging Service handles sender selection, per-country compliance and
  // sticky sender for us when one is configured; the explicit From is the
  // fallback for a bare account.
  // This used to read `&& !sender`, and `sender` is always the shop's name — so
  // the Messaging Service was never used at all, and every destination that
  // forbids a name fell back to a single number or was refused. The pool is the
  // whole point: it is what lets one account reach many countries.
  if (useService) {
    form.set('MessagingServiceSid', messagingServiceSid());
  } else {
    form.set('From', from);
  }

  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch (e) { data = { raw }; }

    if (!r.ok) {
      // Twilio's own message beats "http_400", but a few codes are worth naming
      // outright because the fix is a setting in the console and the raw text
      // does not say so.
      const code = data && data.code;
      const known = TWILIO_CODES[code];
      const msg = (data && (data.message || data.detail)) || `http_${r.status}`;
      return {
        ok: false,
        error: known ? known.he : `Twilio ${r.status}: ${msg}`,
        error_en: known ? known.en : msg,
        code,
        fix: known ? known.fix : null,
        detail: raw.slice(0, 300)
      };
    }
    // Twilio reports failure inside a 201 too, via status.
    if (data && (data.status === 'failed' || data.status === 'undelivered')) {
      return { ok: false, error: `Twilio ${data.status}: ${data.error_message || ''}`, response: data };
    }
    return { ok: true, response: data, message_sid: data && data.sid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Twilio bills postpaid, so there is no balance to read the way TextMe has one.
// Saying so is better than returning a zero that reads like an empty account.
async function getBalance() {
  return { ok: false, error: 'not_applicable', detail: 'Twilio is billed per message, not prepaid' };
}

module.exports = {
  NAME, isConfigured, normalizePhone, canReach, send, getBalance,
  allowsAlphaSender, countryOf, countryFromTimezone, messagingServiceSid,
  TWILIO_CODES, NO_ALPHA_SENDER, DIAL_CODES
};
