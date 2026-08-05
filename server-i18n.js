// ============================================================================
// SERVER-SIDE i18n — for text the SERVER generates and the app displays.
//
// chat.html translates its own chrome, but plenty of what the merchant reads is
// composed here: RFM segment names and the reasoning behind them, why a move was
// chosen, the opportunities the agent found. Those arrived as Hebrew strings no
// matter what language the interface was in, so an English store saw an English
// shell wrapped around Hebrew explanations.
//
// Usage:  const { st } = require('./server-i18n');
//         st(lang, 'seg.at_risk.label')
//         st(lang, 'brief.basisReal', { conversions: 5, contacts: 40 })
//
// Unknown key or language falls back to Hebrew, then to the key itself, so a
// missing entry degrades to something readable instead of "undefined".
// ============================================================================

const STRINGS = {
  he: {
    // --- RFM segments: name + why this customer is in it ---
    'seg.champions.label': 'מובילות (Champions)',
    'seg.champions.reason': 'לקוחה מצוינת — קונה לאחרונה, הרבה, ובסכומים גבוהים. שווה לפנק בגישה מוקדמת ולא בהנחה עמוקה (לשמור על מרווח).',
    'seg.loyal.label': 'נאמנות',
    'seg.loyal.reason': 'לקוחה נאמנה שקונה בקביעות. הטבה קטנה + הכרה שומרות עליה.',
    'seg.cant_lose.label': 'אסור לאבד (Can\'t Lose Them)',
    'seg.cant_lose.reason': 'לקוחה שהייתה בעלת ערך גבוה ונעלמה לגמרי — כאן ה-ROI הכי אסימטרי. הצעה נדיבה מוצדקת כי שוויה גבוה והסיכון לאבד אותה אמיתי.',
    'seg.at_risk.label': 'בסיכון',
    'seg.at_risk.reason': 'לקוחה ששווה כסף ומתחילה להיעלם — בדיוק החלון לתפוס אותה לפני שתעבור למתחרים.',
    'seg.about_to_sleep.label': 'עומדת להירדם',
    'seg.about_to_sleep.reason': 'לקוחה שמתחילה להתרחק. תזכורת חמה בזמן הנכון מחזירה חלק טוב מהן.',
    'seg.new.label': 'חדשות',
    'seg.new.reason': 'לקוחה חדשה. המעבר לקנייה שנייה הוא הרגע הקריטי בנאמנות — דחיפה עכשיו מכפילה את הסיכוי שתישאר.',
    'seg.promising.label': 'מבטיחות',
    'seg.promising.reason': 'קנתה לאחרונה והראתה פוטנציאל. הטבה ממוקדת יכולה להפוך אותה ללקוחה חוזרת.',
    'seg.one_time.label': 'חד-פעמיות',
    'seg.one_time.reason': 'קנתה פעם אחת בלבד. תמריץ חזק (25%) + הוכחה חברתית הם הדרך המוכחת להשיג את הקנייה השנייה.',
    'seg.lost.label': 'אבודות',
    'seg.lost.reason': 'לקוחה שלא קנתה מזמן. ניסיון אחרון בעלות נמוכה — חלק יחזרו, השאר אפשר להפסיק לפנות אליהן.',
    'seg.needs_attention.label': 'דורשות תשומת לב',
    'seg.needs_attention.reason': 'לקוחה עם פוטנציאל שלא נכנסת לפלח ברור — פנייה אישית עם הטבה מתונה.',

    // --- why a projection / choice looks the way it does ---
    'brief.basisReal': 'מבוסס ביצועים אמיתיים: {conversions}/{contacts} המרות ב-90 הימים האחרונים',
    'brief.basisEstimate': 'הערכה ראשונית (עוד אין מספיק היסטוריה לפלח הזה)',
    'brief.morning': 'בוקר טוב',
    'brief.noon': 'צהריים טובים',
    'brief.evening': 'ערב טוב',

    'policy.measured': 'נמדד: {conversions}/{contacts} המרות ב-{days} יום',
    'policy.smallSample': 'מדגם קטן ({contacts} פניות) — משוקלל מול ממוצע החנות',
    'policy.noHistory': 'אין עדיין היסטוריה לפלח הזה',
    'policy.liftOk': 'מבוסס על השוואה לקבוצת ביקורת שלא קיבלה פנייה',
    'policy.liftPending': 'עוד אין מספיק נתונים בקבוצת הביקורת כדי למדוד תרומה אמיתית',

    // --- opportunities the agent surfaces on the home screen ---
    'ins.customer': 'לקוחה',
    'ins.perfectMoment.title': 'הרגע המושלם לפנות ל{name}',
    'ins.perfectMoment.detail': 'היא קונה בערך כל {gap} ימים, ועברו כבר {since} ימים מההזמנה האחרונה - בדיוק החלון שבו היא נוטה לחזור. פנייה אישית עכשיו, עם המלצה מתאימה והטבה קטנה, צפויה להמיר במיוחד.',
    'ins.dormantVip.title': 'לקוחה VIP שנעלמה: {name}',
    'ins.dormantVip.detail': 'הוציאה {spent} ב-{orders} הזמנות (מהלקוחות המובילים בחנות), אבל לא קנתה כבר {since} ימים. שווה לפנות אליה אישית עם עגלה מותאמת והטבה לפני שתלך למתחרים.',
    'ins.reorder.title': 'מוכר חזק ועומד להיגמר: {product}',
    'ins.reorder.detail': 'נמכרו {sold} יחידות ב-30 יום (קצב מהיר), נשארו רק {left}. כל יום שאזל = מכירות שאתה מפסיד. שווה לחדש מלאי עכשיו.',
    'ins.cart.title': 'עגלה נטושה בערך גבוה: {amount}',
    'ins.cart.detail': 'לקוחה השאירה {items} פריטים בשווי {amount} לפני {days} ימים. יש אימייל - אפשר לפנות.',
    'ins.trendUp.title': 'המכירות עלו {pct}% השבוע 📈',
    'ins.trendDown.title': 'המכירות ירדו {pct}% השבוע 📉',
    'ins.trendUp.detail': 'השבוע {thisWeek} מול {lastWeek} בשבוע שעבר. שווה להבין מה עבד ולחזק.',
    'ins.trendDown.detail': 'השבוע {thisWeek} מול {lastWeek} בשבוע שעבר. שווה לבדוק מה השתנה.',
    'ins.newValuable.title': 'לקוחה חדשה ושווה: {name}',
    'ins.newValuable.detail': 'קנתה בפעם הראשונה ב-{spent} בימים האחרונים. פנייה אישית עכשיו (תודה + הטבה לקנייה הבאה) הופכת קונה חד-פעמית ללקוחה קבועה.',
    'ins.winback.title': 'לקוחה ששווה להחזיר: {name}',
    'ins.winback.detail': 'הוציאה {spent} ולא קנתה כבר {since} ימים. פנייה אישית עם הטבה יכולה להחזיר אותה.',
    'ins.best.title': '📈 מה הכי עובד אצלך: {label}',
    'ins.best.detail': 'מהלך מסוג "{label}" ממיר אצלך {rate}% ({converted} מתוך {total}) והכניס {revenue} ב-60 הימים האחרונים. זה המהלך הכי רווחי שלך - שווה לעשות ממנו עוד.',
    'ins.followup.title': '{n} לקוחות לא הגיבו לפנייה האחרונה',
    'ins.followup.detail': 'פנינו אליהן לפני יותר מ-3 ימים והן עוד לא קנו. שווה לנסות שוב - הצעה: גישה אחרת מהפעם הקודמת (הודעה אחרת, אולי הטבה מעט גדולה יותר, או תזכורת עדינה). אתה מחליט אם ואיך לפנות.',
    'ins.crossSell.title': 'הזדמנות צולבת: מי שקנה "{a}" שווה להציע לו "{b}"',
    'ins.crossSell.detail': '{together} לקוחות קנו את שניהם יחד. יש {n} לקוחות שקנו את "{a}" אבל עדיין לא את "{b}" - הצעה ממוקדת אליהם צפויה להמיר היטב.',
    'ins.worthReaching.title': 'לקוחה ששווה לפנות אליה: {name}',
    'ins.worthReaching.detail': 'הוציאה {spent} ב-{orders} הזמנות. {since}פנייה אישית עם הטבה יכולה להחזיר אותה לקנייה.',
    'ins.notBoughtSince': 'לא קנתה כבר {days} ימים. ',
    'ins.move.abandoned_cart': 'שחזור עגלות נטושות',
    'ins.move.dormant_vip': 'החזרת לקוחות VIP',
    'ins.move.one_time': 'דחיפה לקנייה שנייה',
    'ins.move.personalized_cart': 'עגלה מותאמת אישית',
    'ins.move.winback': 'win-back',
    'ins.move.campaign': 'קמפיין',
    'ins.move.agent': 'פעולות הסוכן'
  },

  en: {
    'seg.champions.label': 'Champions',
    'seg.champions.reason': 'An excellent customer — bought recently, often, and at high value. Worth rewarding with early access rather than a deep discount (protect the margin).',
    'seg.loyal.label': 'Loyal',
    'seg.loyal.reason': 'A loyal customer who buys steadily. A small perk plus recognition keeps her.',
    'seg.cant_lose.label': "Can't Lose Them",
    'seg.cant_lose.reason': 'She used to be high value and has disappeared entirely — the most asymmetric ROI there is. A generous offer is justified: she is worth a lot and the risk of losing her is real.',
    'seg.at_risk.label': 'At Risk',
    'seg.at_risk.reason': 'A valuable customer who is starting to slip away — exactly the window to catch her before she moves to a competitor.',
    'seg.about_to_sleep.label': 'About to Sleep',
    'seg.about_to_sleep.reason': 'She is starting to drift. A warm reminder at the right moment brings a good share of them back.',
    'seg.new.label': 'New',
    'seg.new.reason': 'A new customer. The move to a second purchase is the critical moment for loyalty — a nudge now doubles the odds she stays.',
    'seg.promising.label': 'Promising',
    'seg.promising.reason': 'Bought recently and showed potential. A focused offer can turn her into a repeat customer.',
    'seg.one_time.label': 'One-Time Buyers',
    'seg.one_time.reason': 'Bought exactly once. A strong incentive (25%) plus social proof is the proven way to earn the second purchase.',
    'seg.lost.label': 'Lost',
    'seg.lost.reason': 'Has not bought in a long time. One last low-cost attempt — some will come back, and the rest you can stop contacting.',
    'seg.needs_attention.label': 'Needs Attention',
    'seg.needs_attention.reason': 'A customer with potential who does not fall into a clear segment — a personal message with a moderate offer.',

    'brief.basisReal': 'Based on real performance: {conversions}/{contacts} conversions in the last 90 days',
    'brief.basisEstimate': 'Initial estimate (not enough history for this segment yet)',
    'brief.morning': 'Good morning',
    'brief.noon': 'Good afternoon',
    'brief.evening': 'Good evening',

    'policy.measured': 'Measured: {conversions}/{contacts} conversions over {days} days',
    'policy.smallSample': 'Small sample ({contacts} outreaches) — weighted against the shop average',
    'policy.noHistory': 'No history for this segment yet',
    'policy.liftOk': 'Based on a comparison with a control group that received nothing',
    'policy.liftPending': 'Not enough control-group data yet to measure real contribution',

    'ins.customer': 'this customer',
    'ins.perfectMoment.title': 'The perfect moment to reach {name}',
    'ins.perfectMoment.detail': 'She buys roughly every {gap} days, and it has been {since} days since her last order — exactly the window when she tends to come back. A personal message now, with a fitting recommendation and a small offer, should convert unusually well.',
    'ins.dormantVip.title': 'A VIP who vanished: {name}',
    'ins.dormantVip.detail': 'She spent {spent} across {orders} orders (one of your top customers), but has not bought in {since} days. Worth reaching out personally with a tailored cart and an offer before she goes to a competitor.',
    'ins.reorder.title': 'Selling fast and about to run out: {product}',
    'ins.reorder.detail': '{sold} units sold in 30 days (a fast pace), only {left} left. Every day it is out of stock is lost sales. Worth restocking now.',
    'ins.cart.title': 'High-value abandoned cart: {amount}',
    'ins.cart.detail': 'A customer left {items} items worth {amount} {days} days ago. There is an email on file — you can reach her.',
    'ins.trendUp.title': 'Sales are up {pct}% this week 📈',
    'ins.trendDown.title': 'Sales are down {pct}% this week 📉',
    'ins.trendUp.detail': '{thisWeek} this week against {lastWeek} last week. Worth understanding what worked and doubling down.',
    'ins.trendDown.detail': '{thisWeek} this week against {lastWeek} last week. Worth checking what changed.',
    'ins.newValuable.title': 'A valuable new customer: {name}',
    'ins.newValuable.detail': 'Bought for the first time at {spent} in the last few days. A personal message now (a thank-you plus an offer on the next purchase) turns a one-time buyer into a regular.',
    'ins.winback.title': 'A customer worth winning back: {name}',
    'ins.winback.detail': 'She spent {spent} and has not bought in {since} days. A personal message with an offer could bring her back.',
    'ins.best.title': '📈 What works best for you: {label}',
    'ins.best.detail': 'Moves of type "{label}" convert at {rate}% for you ({converted} of {total}) and brought in {revenue} over the last 60 days. This is your most profitable move — worth doing more of it.',
    'ins.followup.title': '{n} customers did not respond to the last outreach',
    'ins.followup.detail': 'We reached them more than 3 days ago and they have not bought. Worth another try with a different angle than last time (a different message, maybe a slightly bigger offer, or a gentle reminder). You decide whether and how to reach out.',
    'ins.crossSell.title': 'Cross-sell opportunity: people who bought "{a}" are worth offering "{b}"',
    'ins.crossSell.detail': '{together} customers bought both together. There are {n} customers who bought "{a}" but not yet "{b}" — a focused offer to them should convert well.',
    'ins.worthReaching.title': 'A customer worth reaching: {name}',
    'ins.worthReaching.detail': 'She spent {spent} across {orders} orders. {since}A personal message with an offer could bring her back to buy.',
    'ins.notBoughtSince': 'Has not bought in {days} days. ',
    'ins.move.abandoned_cart': 'Abandoned cart recovery',
    'ins.move.dormant_vip': 'Winning back VIPs',
    'ins.move.one_time': 'Nudge to a second purchase',
    'ins.move.personalized_cart': 'Personalized cart',
    'ins.move.winback': 'Win-back',
    'ins.move.campaign': 'Campaign',
    'ins.move.agent': 'Agent actions'
  }
};

function st(lang, key, vars) {
  const table = STRINGS[lang === 'en' ? 'en' : 'he'];
  let s = table[key];
  if (s === undefined) s = (STRINGS.he[key] !== undefined ? STRINGS.he[key] : key);
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// Convenience: resolve a shop's language once, then translate many strings.
async function forShop(shop) {
  let lang = 'he';
  try {
    const settings = require('./store-settings');
    const s = await settings.getSettings(shop);
    if (s && s.language) lang = s.language;
  } catch (e) { /* default */ }
  return { lang, t: (key, vars) => st(lang, key, vars) };
}

module.exports = { st, forShop, STRINGS };
