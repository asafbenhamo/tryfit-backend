// mailer.js - Email sending via Resend for the AI Chief of Staff.
// Sends real emails (e.g. cart-recovery, win-back) after merchant approval.
// Fails safe: if RESEND_API_KEY is missing, returns an error instead of crashing.

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

// Default sender. Until a custom domain is verified in Resend, use their
// shared sandbox sender. Once sevenseventy.co.il is verified, switch FROM_EMAIL.
const FROM_EMAIL = process.env.MAIL_FROM || "770 <onboarding@resend.dev>";
const REPLY_TO = process.env.MAIL_REPLY_TO || "sevenseventyshopify@gmail.com";

/**
 * Send a single email.
 * Returns { ok, id } or { ok:false, error }.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  if (!to || !subject || (!html && !text)) {
    return { ok: false, error: "missing to/subject/body" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        reply_to: REPLY_TO,
        subject,
        html: html || undefined,
        text: text || undefined
      })
    });

    const data = await res.json();
    if (res.status >= 200 && res.status < 300) {
      console.log(`📧 [Mailer] Sent to ${to}: "${subject}" (id: ${data.id})`);
      return { ok: true, id: data.id };
    } else {
      console.error(`❌ [Mailer] Send failed (${res.status}):`, JSON.stringify(data).substring(0, 200));
      return { ok: false, error: data.message || `status ${res.status}` };
    }
  } catch (err) {
    console.error(`❌ [Mailer] Exception:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Wrap plain text into a simple, clean RTL Hebrew HTML email.
 */
function buildHtmlEmail(bodyText, opts = {}) {
  const safe = String(bodyText || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  const cta = opts.cta_url && opts.cta_label
    ? `<div style="margin:24px 0;text-align:center;">
         <a href="${opts.cta_url}" style="background:#0b8aff;color:#fff;text-decoration:none;
            padding:13px 30px;border-radius:10px;font-size:16px;font-weight:600;display:inline-block;">
            ${opts.cta_label}</a>
       </div>`
    : "";
  // Legal: every marketing email must include an unsubscribe link.
  const unsubBase = process.env.PUBLIC_BASE_URL || "https://tryfit-backend-production.up.railway.app";
  const unsub = opts.to
    ? `<a href="${unsubBase}/unsubscribe?email=${encodeURIComponent(opts.to)}" style="color:#999;">להסרה מרשימת התפוצה</a>`
    : "";
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:30px 20px;">
    <div style="background:#fff;border-radius:16px;padding:32px 28px;direction:rtl;text-align:right;
                box-shadow:0 2px 12px rgba(0,0,0,0.06);">
      <div style="font-size:22px;font-weight:800;color:#111;margin-bottom:18px;">${opts.brand || "770"}</div>
      <div style="font-size:16px;line-height:1.7;color:#333;">${safe}</div>
      ${cta}
    </div>
    <div style="text-align:center;color:#999;font-size:12px;margin-top:16px;">
      ${opts.footer || "נשלח באמצעות היועץ החכם של 770"}<br>${unsub}
    </div>
  </div>
</body>
</html>`;
}

function isConfigured() {
  return !!RESEND_API_KEY;
}

module.exports = { sendEmail, buildHtmlEmail, isConfigured };