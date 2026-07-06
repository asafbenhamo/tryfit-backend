// ============================================================================
// COPYWRITER — Maya writes a UNIQUE message per RFM segment instead of one
// static template for everyone. Research: segment-tailored copy that references
// what the customer actually bought lifts opens 15-25% and doesn't read like a
// generic Flashy blast (our key differentiation).
//
// One AI call PER SEGMENT (not per customer) — smart cost/quality balance:
// a campaign touches at most ~6 segments => ~6 cheap calls total.
// Placeholders kept for per-customer personalization done by campaign-engine:
//   {NAME} {PRODUCT_LINE} {COUPON}
// Fail-safe: any error => caller falls back to the static template.
// ============================================================================

const SEGMENT_BRIEFS = {
  cant_lose: 'לקוחה שהייתה מהשוות ביותר בחנות ונעלמה לגמרי. טון: מתגעגעות, אישי, מוערך — לא נואש. ההצעה נדיבה כי היא שווה את זה.',
  at_risk: 'לקוחה טובה שמתחילה להתרחק. טון: חם, "חשבנו עלייך", תזכורת עדינה עם תמריץ.',
  about_to_sleep: 'לקוחה שמתקררת. טון: קליל ומזמין, בלי לחץ.',
  one_time: 'קנתה פעם אחת בלבד. טון: מסביר פנים, נותן סיבה ממשית לחזור, תמריץ חזק.',
  new: 'לקוחה חדשה אחרי קנייה ראשונה. טון: מתלהב, ברוכה הבאה למשפחה, דוחף קנייה שנייה.',
  loyal: 'לקוחה נאמנה שקונה בקביעות. טון: הוקרה, VIP, בלי למכור חזק.',
  champions: 'הלקוחה הכי טובה שיש. טון: בלעדי, גישה מוקדמת, יחס אישי — לא הנחה זולה.',
  promising: 'לקוחה עם פוטנציאל. טון: חברותי, מזמין להתאהב בחנות.',
  lost: 'לקוחה שנעלמה מזמן. טון: ניסיון אחרון קצר וכן, בלי דרמה.'
};

async function generateSegmentCopy(shop, { segment_key, segment_label, discount, sample = [] } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let MODEL = 'claude-sonnet-5';
  try { MODEL = require('./ai-brain').MODEL || MODEL; } catch (e) { /* default */ }

  // Message language follows the SHOP's configured language (he for Israeli
  // stores, en for international ones) — same brain, right voice per market.
  let lang = 'he';
  try { lang = (await require('./store-settings').getSettings(shop)).language || 'he'; } catch (e) { /* he */ }

  const brief = SEGMENT_BRIEFS[segment_key] || 'לקוחה של חנות אופנה. טון חם ואישי.';
  const examples = sample.slice(0, 3).map(s =>
    `- ${s.name || 'לקוחה'}${s.last_product ? `, קנתה לאחרונה: ${s.last_product}` : ''}`).join('\n');

  const langRules = lang === 'en'
    ? `1. Write in natural, warm ENGLISH — like a friend texting, not an ad. 3-4 lines max.
2. You MUST include {NAME} once (customer name), {PRODUCT_LINE} once (a sentence about what she bought — replaced automatically), and {COUPON} once (the code).
3. No shouting caps, no "HUGE SALE", at most one or two emoji.
4. Don't invent prices or specific products.
5. Short email subject line (up to 6 words), in English.`
    : `1. 3-4 שורות מקסימום, עברית טבעית וחמה — כמו חברה שכותבת, לא פרסומת.
2. חובה לכלול את הצירוף {NAME} פעם אחת (שם הלקוחה), {PRODUCT_LINE} פעם אחת (משפט על המוצר שקנתה — יוחלף אוטומטית), ו-{COUPON} פעם אחת (הקוד).
3. בלי אותיות גדולות צועקות, בלי "מבצע ענק", מקסימום אימוג'י אחד-שניים.
4. אל תמציאי מחירים או מוצרים ספציפיים.
5. שורת נושא קצרה למייל (עד 6 מילים).`;

  const prompt = `אתה מאיה — אשת מכירות של חנות אונליין. כתבי הודעת SMS/וואטסאפ קצרה לפלח לקוחות.

הפלח: ${segment_label || segment_key}
אפיון: ${brief}
הנחה מאושרת: ${discount || 10}%
דוגמאות לקוחות בפלח:
${examples || '- (אין דוגמאות)'}

חוקים מחייבים:
${langRules}

השיבי JSON בלבד, בלי הסברים ובלי גרשי קוד:
{"subject": "...", "body": "..."}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.body || !parsed.body.includes('{COUPON}')) return null; // must keep placeholders
    if (!parsed.body.includes('{NAME}')) parsed.body = 'היי {NAME} 💜 ' + parsed.body;
    if (!parsed.body.includes('{PRODUCT_LINE}')) parsed.body = parsed.body.replace('{NAME}', '{NAME}, {PRODUCT_LINE}').replace(', ,', ',');
    return { subject: (parsed.subject || 'חשבנו עלייך 💜').slice(0, 60), body: parsed.body.slice(0, 800) };
  } catch (e) {
    console.error('[copywriter]', e.message);
    return null; // caller falls back to static template
  }
}

module.exports = { generateSegmentCopy };