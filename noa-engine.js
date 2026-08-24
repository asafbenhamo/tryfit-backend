// ============================================================================
// NOA — agent #3: customer-facing replies, 24/7.
//
// When Maya's campaigns go out, customers reply: "יש במידה M?", "עד מתי הקוד?",
// "כמה זמן משלוח?". Today those replies died unanswered — and a customer who
// REPLIES to a marketing message is the hottest lead there is.
//
// Noa v1 (SMS inbound):
//   1. "הסר"/"STOP" replies -> immediate opt-out everywhere (spam-law critical).
//   2. Real questions -> Noa answers ONLY from real store data (sizes, stock,
//      coupons, shipping the merchant configured). Task-specific, short, honest.
//   3. Anything she isn't sure about -> tells the customer the owner will reply,
//      and pushes a notification to the merchant with the question.
//   4. Every inbound + reply is logged (incoming_messages) and the merchant is
//      notified — full transparency, no silent bot.
// ============================================================================

const db = require('./database');
const compliance = require('./compliance');
const smsSender = require('./sms-sender');
const storeSettings = require('./store-settings');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS incoming_messages (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      channel TEXT DEFAULT 'sms',
      phone TEXT, email TEXT, customer_name TEXT,
      message TEXT NOT NULL,
      reply TEXT, handled_by TEXT,          -- 'noa' | 'optout' | 'merchant_needed'
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(e => console.error('[noa] table:', e.message));
  tableReady = true;
}

const OPTOUT_RE = /^\s*(הסר|הסירו|להסיר|תסירו|די|stop|unsubscribe|remove)\s*[.!]?\s*$/i;

// Defensive parse: TextMe webhook field names may vary; look in common keys.
function extractInbound(body) {
  const b = body || {};
  const flat = typeof b === 'object' ? b : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (flat[k]) return String(flat[k]);
      if (flat.sms && flat.sms[k]) return String(flat.sms[k]);
      if (flat.message && typeof flat.message === 'object' && flat.message[k]) return String(flat.message[k]);
    }
    return null;
  };
  const phone = pick('phone', 'msisdn', 'from', 'source', 'sender', 'caller');
  const text = pick('message', 'text', 'body', 'content', 'sms_text') ||
               (typeof b.message === 'string' ? b.message : null);
  return { phone, text };
}

// Gather what Noa is allowed to answer from: the customer's own history + coupons.
async function customerContext(shop, phone) {
  const ctx = { name: null, last_products: [], coupon: null };
  try {
    const norm = smsSender.normalizePhone(phone, shop);
    const variants = [norm, norm ? '972' + norm.slice(1) : null, phone].filter(Boolean);
    const c = await db.query(
      `SELECT shopify_customer_id, first_name, last_name, email FROM store_customers
       WHERE shop_domain=$1 AND (phone = ANY($2) OR REGEXP_REPLACE(COALESCE(phone,''),'[^0-9]','','g') = ANY($2))
       LIMIT 1`, [shop, variants]);
    if (c.rows.length) {
      const cust = c.rows[0];
      ctx.name = ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim() || null;
      ctx.email = cust.email || null;
      const p = await db.query(
        `SELECT i.title FROM store_orders o
         JOIN store_order_items i ON i.shopify_order_id = o.shopify_order_id AND i.shop_domain = o.shop_domain
         WHERE o.shop_domain=$1 AND o.shopify_customer_id=$2
         ORDER BY o.ordered_at DESC FETCH FIRST 3 ROWS ONLY`,
        [shop, cust.shopify_customer_id]);
      ctx.last_products = p.rows.map(r => r.title).filter(Boolean);
      // The most recent coupon the advisor issued her (so Noa can answer "מה הקוד שלי?").
      const cp = await db.query(
        `SELECT coupon_code, created_at FROM advisor_actions
         WHERE shop_domain=$1 AND coupon_code IS NOT NULL
           AND (target_phone = ANY($2) OR (target_email IS NOT NULL AND LOWER(target_email)=LOWER($3)))
         ORDER BY created_at DESC LIMIT 1`,
        [shop, variants, ctx.email || '']);
      if (cp.rows.length) ctx.coupon = cp.rows[0].coupon_code;
    }
  } catch (e) { console.error('[noa] context:', e.message); }
  return ctx;
}

// Ask the model for a short, honest service reply. Fail-safe: null => hand to merchant.
async function draftReply(shop, ctx, customerText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  let MODEL = 'claude-sonnet-5';
  try { MODEL = require('./ai-brain').MODEL || MODEL; } catch (e) { /* default */ }

  // The store, in ITS OWN words. This prompt used to hardcode "an Israeli
  // fashion store (770)" and sevenseventy.co.il for every tenant, and rule 3
  // forced the reply into Hebrew — so a customer of any other merchant who
  // texted back got a Hebrew reply, signed by a store they had never bought
  // from, linking a competitor's website.
  const settings = await storeSettings.getSettings(shop).catch(() => ({}));
  const brand = settings.brand || String(shop || '').replace('.myshopify.com', '');
  const isEn = settings.language === 'en';
  let siteUrl = '';
  try { siteUrl = require('./shopify-client').getPublicDomain(shop) || ''; } catch (e) { /* optional */ }

  const prompt = isEn ? `You are Noa, a customer service rep for ${brand}. A customer has replied to an SMS from the store.

What you know (this is ALL of it — do not invent anything beyond it):
- Customer name: ${ctx.name || 'unknown'}
- Recent purchases: ${ctx.last_products.join(', ') || 'unknown'}
- The last personal coupon code sent to her: ${ctx.coupon || 'none'}
- Store website: ${siteUrl || 'unknown'}

Her message: "${customerText}"

Binding rules:
1. Answer ONLY if the answer is in the information above (e.g. what is my code, what did I buy). Never invent sizes, stock, prices or delivery times — you have no access to them.
2. If you cannot answer confidently from that information, reply with exactly: HANDOFF
3. If you can: one or two warm sentences in English, max 180 characters, no links, at most one emoji.
4. If she is interested in buying, mention her personal code if she has one.

Reply with the message text only, or the word HANDOFF.` : `את נועה, נציגת שירות של ${brand}. לקוחה ענתה להודעת SMS של החנות.

מה ידוע (זה כל המידע — אסור להמציא מעבר לו):
- שם הלקוחה: ${ctx.name || 'לא ידוע'}
- קניות אחרונות: ${ctx.last_products.join(', ') || 'לא ידוע'}
- קוד קופון אישי אחרון שנשלח לה: ${ctx.coupon || 'אין'}
- אתר החנות: ${siteUrl || 'לא ידוע'}

הודעת הלקוחה: "${customerText}"

כללים מחייבים:
1. עני רק אם התשובה נמצאת במידע למעלה (למשל: מה הקוד שלי, מה קניתי). אל תמציאי מידות, מלאי, מחירים או זמני משלוח — אין לך גישה אליהם.
2. אם אי אפשר לענות בביטחון מהמידע — השיבי בדיוק: HANDOFF
3. אם כן עונה: משפט-שניים חמים בעברית, עד 180 תווים, בלי קישורים, אפשר אימוג'י אחד.
4. אם הלקוחה מתעניינת בקנייה — הזכירי את הקוד האישי שלה אם קיים.

השיבי רק את טקסט התשובה או המילה HANDOFF.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = (((data.content || []).find(b => b.type === 'text') || {}).text || '').trim();
    if (!text || /HANDOFF/i.test(text)) return null;
    return text.slice(0, 200);
  } catch (e) { console.error('[noa] draft:', e.message); return null; }
}

// Main entry: handle one inbound SMS. Returns what happened (for the webhook response).
async function handleInbound(shop, rawBody) {
  await ensureTable();
  const { phone, text } = extractInbound(rawBody);
  if (!phone || !text) return { ok: false, reason: 'unparsed', raw_keys: Object.keys(rawBody || {}) };

  const norm = smsSender.normalizePhone(phone, shop) || phone;
  let pushEngine = null;
  try { pushEngine = require('./push-engine'); } catch (e) { /* optional */ }

  // ---- 1. Opt-out keywords: honor immediately, everywhere (incl. Flashy push) ----
  if (OPTOUT_RE.test(text)) {
    // Confirm to the customer FIRST (after opt-out the gate would block us), then remove.
    // Confirmed in the STORE's language. A customer of a US shop who texts STOP
    // used to get the confirmation in Hebrew.
    const stopEn = (await storeSettings.getSettings(shop).catch(() => ({}))).language === 'en';
    const stopMsg = stopEn
      ? "You've been removed from our list. Thanks, and take care."
      : 'הוסרת מרשימת התפוצה שלנו. תודה ולהתראות 💜';
    try { await smsSender.sendOne(shop, { phone: norm, message: stopMsg }); } catch (e) { /* ok */ }
    try {
      const flashySync = require('./flashy-sync');
      await flashySync.optOutEverywhere(shop, { phone: norm, reason: 'sms_reply_stop' });
    } catch (e) {
      await compliance.addOptOut(shop, { phone: norm, reason: 'sms_reply_stop' }).catch(() => {});
    }
    await log(shop, norm, text, '(אישור הסרה)', 'optout');
    return { ok: true, handled: 'optout' };
  }

  // ---- 2. A real reply: Noa answers from real data, or hands off honestly ----
  const ctx = await customerContext(shop, norm);
  const reply = await draftReply(shop, ctx, text);

  if (reply) {
    const sent = await smsSender.sendOne(shop, { phone: norm, message: reply });
    await log(shop, norm, text, reply, sent.ok ? 'noa' : 'merchant_needed', ctx.name);
    if (pushEngine) pushEngine.sendToShop(shop, {
      title: `💬 ${ctx.name || norm} ענתה — נועה טיפלה`,
      body: `"${text.slice(0, 60)}" → "${reply.slice(0, 60)}"`,
      url: '/chat'
    }).catch(() => {});
    return { ok: true, handled: 'noa', replied: sent.ok };
  }

  // Handoff: tell the customer a human will answer, alert the merchant loudly.
  const holdEn = (await storeSettings.getSettings(shop).catch(() => ({}))).language === 'en';
  const first = ctx.name ? ' ' + ctx.name.split(' ')[0] : '';
  const holdMsg = holdEn
    ? `Hi${first}! We got your message and the store will get back to you very soon.`
    : `היי${first}! קיבלנו את ההודעה שלך 💜 בעל החנות יחזור אלייך ממש בקרוב.`;
  await smsSender.sendOne(shop, { phone: norm, message: holdMsg }).catch(() => {});
  await log(shop, norm, text, holdMsg, 'merchant_needed', ctx.name);
  if (pushEngine) pushEngine.sendToShop(shop, {
    title: `🔔 לקוחה מחכה לתשובה ממך!`,
    body: `${ctx.name || norm}: "${text.slice(0, 90)}"`,
    url: '/chat'
  }).catch(() => {});
  return { ok: true, handled: 'merchant_needed' };
}

async function log(shop, phone, message, reply, handledBy, name) {
  await db.query(
    `INSERT INTO incoming_messages (shop_domain, phone, customer_name, message, reply, handled_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [shop, phone, name || null, message, reply, handledBy]
  ).catch(e => console.error('[noa] log:', e.message));
}

// extractInbound is exported so the webhook can resolve WHICH shop an inbound
// message belongs to before handing it off.
module.exports = { handleInbound, ensureTable, extractInbound };