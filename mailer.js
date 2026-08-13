// mailer.js - Email sending via Resend for the AI Chief of Staff.
// Sends real emails (e.g. cart-recovery, win-back) after merchant approval.
// Fails safe: if RESEND_API_KEY is missing, returns an error instead of crashing.
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
// Default sender. Set MAIL_FROM in Railway, e.g. "SEVENSEVENTY 770 <noreply@sevenseventy.co.il>".
const FROM_EMAIL = process.env.MAIL_FROM || "SEVENSEVENTY 770 <onboarding@resend.dev>";
const REPLY_TO = process.env.MAIL_REPLY_TO || "info@sevenseventy.co.il";
// Optional brand logo URL (must be a public https image). Set MAIL_LOGO_URL in Railway.
const LOGO_URL = process.env.MAIL_LOGO_URL || "";

/**
 * Send a single email.
 * Returns { ok, id } or { ok:false, error }.
 */
async function sendEmail({ to, subject, html, text, fromName, replyTo }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  if (!to || !subject || (!html && !text)) {
    return { ok: false, error: "missing to/subject/body" };
  }
  // EMAIL AS A SERVICE: every shop sends through OUR infrastructure, but the
  // customer sees the SHOP's name as the sender ("Nora Boutique <noreply@...>").
  // The address stays ours (verified domain); only the display name is per-shop.
  let from = FROM_EMAIL;
  if (fromName) {
    const addr = (FROM_EMAIL.match(/<([^>]+)>/) || [null, FROM_EMAIL])[1];
    const cleanName = String(fromName).replace(/[<>"]/g, '').slice(0, 60);
    from = `${cleanName} <${addr}>`;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: from,
        // Reply-To is the SHOP's, falling back to the platform address only
        // when the caller does not know one. This used to spread the per-call
        // replyTo and then overwrite it on the very next line with the global
        // REPLY_TO -- later key wins in an object literal -- so every merchant's
        // customer who hit Reply landed in the pilot store's inbox.
        to: Array.isArray(to) ? to : [to],
        ...((replyTo || REPLY_TO) ? { reply_to: replyTo || REPLY_TO } : {}),
        subject,
        html: html || undefined,
        text: text || undefined
      })
    });
    const data = await res.json();
    if (res.status >= 200 && res.status < 300) {
      console.log(`[Mailer] Sent to ${to}: "${subject}" (id: ${data.id})`);
      return { ok: true, id: data.id };
    } else {
      console.error(`[Mailer] Send failed (${res.status}):`, JSON.stringify(data).substring(0, 200));
      return { ok: false, error: data.message || `status ${res.status}` };
    }
  } catch (err) {
    console.error(`[Mailer] Exception:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Wrap plain text into a clean, professional RTL Hebrew HTML email.
 * URLs in the text become clickable links automatically.
 */
function buildHtmlEmail(bodyText, opts = {}) {
  const brand = opts.brand || "770";
  const logoUrl = opts.logo_url || LOGO_URL;
  // Direction follows the shop's language: Hebrew shops RTL, international LTR.
  const isEn = (opts.language === 'en');
  const dir = isEn ? 'ltr' : 'rtl';
  const align = isEn ? 'left' : 'right';

  let safe = String(bodyText || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  safe = safe.replace(/(https?:\/\/[^\s<]+[^\s<.,)!?])/g, function (url) {
    return '<a href="' + url + '" style="color:#111;text-decoration:underline;word-break:break-all;">' + url + '</a>';
  });
  safe = safe.replace(/\n/g, "<br>");

  const header = logoUrl
    ? '<img src="' + logoUrl + '" alt="' + brand + '" style="max-width:170px;height:auto;display:block;margin:0 auto;">'
    : '<div style="font-size:30px;font-weight:900;letter-spacing:1px;color:#111;text-align:center;">' + brand + '</div>';

  const cta = (opts.cta_url && opts.cta_label)
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 8px;">' +
        '<tr><td style="border-radius:10px;background:#111;">' +
          '<a href="' + opts.cta_url + '" style="display:inline-block;padding:14px 38px;color:#fff;' +
          'text-decoration:none;font-size:16px;font-weight:700;letter-spacing:.5px;">' + opts.cta_label + '</a>' +
        '</td></tr></table>'
    : "";

  // The link is signed so the endpoint can tell which shop issued it, and it
  // only opens a confirmation page — the opt-out itself happens on POST, because
  // mail scanners follow links and were unsubscribing people who never clicked.
  const unsubBase = process.env.PUBLIC_BASE_URL || "https://tryfit-backend-production.up.railway.app";
  const unsubShop = opts.shop ? '&shop=' + encodeURIComponent(opts.shop) : '';
  let unsubSig = '';
  if (opts.to && opts.shop) {
    try {
      const crypto = require('crypto');
      const secret = process.env.ADMIN_PASSWORD || 'unsub';
      unsubSig = '&t=' + crypto.createHmac('sha256', secret)
        .update(String(opts.to).toLowerCase() + '|' + String(opts.shop), 'utf8')
        .digest('base64url').slice(0, 24);
    } catch (e) { /* unsigned links are still honoured */ }
  }
  const unsubLabel = isEn ? 'Unsubscribe' : 'להסרה מרשימת התפוצה';
  // Transactional mail carries no unsubscribe link. The welcome mail with the
  // merchant's own sign-in link is not marketing, and offering to unsubscribe
  // them from their own account mail is both wrong and a way to lose the person
  // who installed the app. Marketing to their customers still always carries it.
  const unsub = (opts.to && !opts.transactional)
    ? '<a href="' + unsubBase + '/unsubscribe?email=' + encodeURIComponent(opts.to) + unsubShop + unsubSig + '" style="color:#aaa;text-decoration:underline;">' + unsubLabel + '</a>'
    : "";
  const defaultFooter = isEn ? ('Sent by ' + brand) : ('נשלח מ-' + brand);

  return '<!DOCTYPE html>\n' +
'<html dir="' + dir + '" lang="' + (isEn ? 'en' : 'he') + '">\n' +
'<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>\n' +
'<body style="margin:0;padding:0;background:#f2f2f3;font-family:\'Segoe UI\',Arial,Helvetica,sans-serif;">\n' +
'  <div style="max-width:560px;margin:0 auto;padding:28px 16px;">\n' +
'    <div style="padding:8px 0 22px;">' + header + '</div>\n' +
'    <div style="background:#ffffff;border-radius:18px;padding:40px 34px;direction:' + dir + ';text-align:' + align + ';box-shadow:0 4px 24px rgba(0,0,0,0.07);">\n' +
'      <div style="font-size:16.5px;line-height:1.85;color:#2a2a2a;">' + safe + '</div>\n' +
'      ' + cta + '\n' +
'    </div>\n' +
'    <div style="text-align:center;color:#9a9a9a;font-size:12px;line-height:1.7;margin-top:22px;">\n' +
'      ' + (opts.footer || defaultFooter) + '<br>\n' +
'      ' + unsub + '\n' +
'    </div>\n' +
'  </div>\n' +
'</body>\n' +
'</html>';
}

function isConfigured() {
  return !!RESEND_API_KEY;
}

module.exports = { sendEmail, buildHtmlEmail, isConfigured };