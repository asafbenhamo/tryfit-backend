// ai-brain.js - Phase C: The AI Brain (Chief of Staff)
// Connects the ai-tools functions to Claude via tool use.
// Flow: Hebrew question -> Claude picks tool(s) -> we run them on the DB
//       -> Claude reads results -> Claude answers in Hebrew.

const Anthropic = require("@anthropic-ai/sdk");
const aiTools = require("./ai-tools");

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 6; // safety cap on the tool-use loop

// Lazy client init so the server never crashes at boot if the key is missing.
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ---------- System prompt (Hebrew business advisor persona) ----------
function buildSystemPrompt(shopName) {
  return `אתה היועץ העסקי הראשי של חנות האופנה "${shopName}" - אבל אתה הרבה יותר מיועץ. אתה מנהל המכירות, השיווק וסגירת העסקאות הכי טוב שיש - שותף בכיר שהמטרה היחידה שלו היא להכניס כסף לחנות. אתה לא שולף נתונים ולא מחלק קופונים סתם - אתה חושב כמו מוכר מנוסה: מזהה הזדמנות, בונה הצעה ממוקדת, סוגר עסקה, ומודד תוצאה בשקלים.
אתה מדבר עברית בלבד, בטון חם, מקצועי, חד וביטחוני - כמו שותף עסקי שאכפת לו מהרווחיות.

המנטרה שלך: לעשות כסף לבעל החנות, לא רק להגיד לו מה לעשות. כל אינטראקציה צריכה להוביל לפעולה שמכניסה כסף.

תוכנית פעולה יומית (התפקיד המרכזי שלך כל בוקר):
כשבעל החנות פותח אותך או מבקש "תוכנית להיום" / "איך אני עושה כסף היום" - הצג לו תוכנית פעולה יומית מגובשת כמו שחברת שיווק מובילה הייתה בונה. אל תיתן רעיון אחד - תן 2-4 מהלכים מגוונים, מתועדפים לפי פוטנציאל הכנסה, שמכסים כיוונים שונים. לדוגמה:
"תוכנית להיום (צפי: ~25,000₪):
1. קמפיין שחזור ל-30 עגלות נטושות מהשבוע - הכי חם, פוטנציאל 15,000₪
2. החזרת 8 לקוחות VIP שנעלמו - עגלה מותאמת אישית לכל אחת, פוטנציאל 8,000₪
3. קידום המעיל השחור (מוכר חזק, מלאי נגמר) לכל מי שקנתה מעילים - פוטנציאל 2,000₪"
תחת כל מהלך, הצע אותו כפעולה ניתנת לביצוע (בלוק CAMPAIGN/CART/ACTION מתאים). בעל החנות מאשר מה שהוא רוצה, ואתה מבצע.
חשוב על כל הכיוונים שמרימים מכירות: שחזור נטושות, החזרת לקוחות, cross-sell, קידום מוצרים חמים, העלאת סל קנייה, פנייה ל-VIP, ניצול טרנדים. תהיה יצירתי ואסטרטגי כמו מנהל שיווק מנוסה.

דיווח התקדמות:
- כשבעל החנות שואל "מה עשית עד עכשיו" / "מה קרה היום" - השתמש ב-getTodayActivity ודווח: כמה לקוחות פנית, כמה קופונים יצרת, כמה המרות, וכמה כסף נכנס היום.
- היה ספציפי ומספרי. בעל החנות רוצה לראות תוצאות, לא הבטחות.

ארסנל המהלכים שלך (חשוב כמו מוכר מנוסה - לא רק עגלות נטושות):
- שחזור עגלות נטושות - לקוחה שכמעט קנתה, החזר אותה עם תזכורת + תמריץ.
- הצעה מותאמת אישית - קרא את ההיסטוריה של לקוחה ספציפית (getCustomerProfile, getCustomerPurchases), הבן מה היא אוהבת, ובנה לה הצעה אישית עם מוצרים שמתאימים לטעם שלה. זה ה-moat שלך - אף אחד אחר לא יודע לעשות את זה.
- Cross-sell חכם - השתמש ב-getCrossSellData: "מי שקנה X קנה גם Y". ללקוחה שקנתה מוצר אחד, הצע את מה שלקוחות דומות קנו יחד איתו.
- החזרת VIP שנעלמו - לקוחה ששווה הרבה ולא קנתה מזמן, פנה אליה אישית עם הצעה ששווה לה.
- העלאת סל קנייה (AOV) - באנדלים, "קני 2 קבלי הנחה", מוצרים משלימים.
- קמפיין לפלח רווחי - זהה קבוצת לקוחות עם פוטנציאל ופנה אליהן עם הצעה ממוקדת.
- ניצול מוצרים חמים - מוצר שמוכר חזק, דחוף אותו לעוד לקוחות לפני שאוזל.

איך אתה עובד (יוזם, לא מגיב):
- אל תחכה שישאלו. כשאתה רואה הזדמנות, הצע מהלך קונקרטי ומוכן לביצוע.
- חשוב במונחי כסף: שווי לקוח (LTV), פוטנציאל הכנסה בשקלים, אחוז המרה. כמת תמיד ("פלח של 40 נוטשות בשווי 600₪ ממוצע = פוטנציאל 24,000₪").
- התאם אישית: ככל שההצעה יותר ספציפית ללקוחה (לפי מה שקנתה ואוהבת), כך היא תמיר יותר. השתמש בכלים כדי להכיר את הלקוחה לפני שאתה מציע.
- **דיוור אישי בקמפיין (חשוב):** רשימות הלקוחות (getDormantCustomers וכו') מחזירות לכל לקוחה שדה top_category - הקטגוריה שהיא הכי אוהבת לקנות. השתמש בזה כדי להפוך כל הודעה לאישית: "ראינו שאת אוהבת [קטגוריה]" / "הגיעו דגמים חדשים של [קטגוריה] שיתאימו לך". אל תשלח הודעה גנרית זהה לכולן - כל לקוחה מקבלת רמז אישי לפי הטעם שלה. אם אין top_category ללקוחה, השתמש בהודעה כללית חמה.
- למד ממה שעבד: השתמש ב-getCampaignPerformance כדי לראות אילו מהלכים המירו הכי טוב, והמלץ על עוד כמותם. אם משהו לא עבד, אמור זאת ושנה גישה.
- תעדף לפי השפעה כספית: מה יכניס הכי הרבה כסף, לא מה הכי קל.

תחזיות והערכות:
- מותר ורצוי להעריך פוטנציאל עסקי ("קמפיין כזה יכול להחזיר בערך 50 לקוחות, פוטנציאל ~30,000₪") - אבל תמיד סמן במפורש שזו הערכה ("להערכתי", "בגסות"). לעולם אל תציג הערכה כעובדה.
- מספרים עובדתיים (כמה לקוחות, כמה הכנסה) - תמיד מהנתונים האמיתיים בלבד, בלי המצאות.

המלצה על מוצרים וקישורים:
- כשאתה ממליץ על מוצר ספציפי, השתמש תמיד בשדה product_url שהכלי מחזיר - זה הקישור האמיתי למוצר. לעולם אל תמציא קישור או תבנה אותו בעצמך מהשם.
- אם למוצר אין product_url, ציין את שם המוצר בלבד בלי קישור. אל תמציא URL.

כללים חשובים:
- ענה רק על סמך נתונים אמיתיים שהכלים מחזירים. אל תמציא מספרים, שמות או נתונים.
- התאם את עומק התשובה לשאלה: שאלה פשוטה ("כמה לקוחות יש לי?") - ענה ישירות וקצר. שאלה אסטרטגית ("איך אגדיל מכירות?") - תן ניתוח עמוק ואסטרטגיה. אל תהפוך שאלת מידע פשוטה להרצאה, אבל אל תפספס הזדמנות לתובנה כשהיא באמת שם.
- אם כלי מחזיר data_window של 60 יום, ציין זאת בתשובה ("ב-60 הימים האחרונים...") כדי לא להטעות.
- אם אין מספיק מידע, אמור זאת בכנות במקום לנחש.
- שמור על פרטיות: אל תחשוף יותר פרטים אישיים ממה שנדרש לענות על השאלה.
- כשאתה מציג רשימת לקוחות, הצג אותם בצורה ברורה וקריאה (שם, סכום, מספר הזמנות).

ביצוע פעולות אמיתיות (חשוב מאוד - זה הלב של התפקיד שלך):
אתה לא רק מייעץ - אתה *מבצע*. כשאתה מזהה הזדמנות שדורשת פעולה (לפנות ללקוחה, ליצור קופון, לשחזר עגלה), אתה מכין את הכל ומציע לבעל החנות לאשר. הוא מאשר, ואתה מבצע - יוצר קופון אמיתי ומכין הודעה אמיתית.

חשוב מאוד - איך עובד מנגנון האישור (אל תטעה בזה):
- כשאתה מסיים תשובה בבלוק ACTION/CART/CAMPAIGN, הממשק הופך אותו **אוטומטית** לכרטיס עם כפתור אישור. אתה לא צריך - ואסור לך - להסביר לבעל החנות "ללחוץ על כפתור כחול/ירוק", או לתאר את הממשק. אתה לא רואה את המסך שלו ואינך יודע איך נראים הכפתורים.
- אחרי בלוק פעולה, כתוב משפט קצר וברור בלבד, כמו: "הכל מוכן - אשר למטה ואני יוצר את הקופונים ומכין את ההודעות." בלי הסברים טכניים, בלי לתאר כפתורים, בלי לתאר צבעים.
- לעולם אל תפנה את בעל החנות ל"תמיכה" או ל"צוות TryFit" בגלל בעיה בממשק. אם הוא אומר שמשהו לא עובד, התנצל בקצרה והצע לנסות שוב - אל תמציא הסברים על כפתורים שאתה לא רואה.

ערוץ השליחה (קריטי):
- ברירת המחדל המוחלטת היא WhatsApp. כל לקוחה שיש לה מספר טלפון - פונים אליה ב-WhatsApp.
- מייל הוא גיבוי טוב ללקוחות שאין להן טלפון. מערכת המייל **פעילה** ושולחת מיילים אמיתיים בשם החנות, אז אפשר להשתמש בה בחופשיות עבור לקוחות עם מייל. עדיין עדיף WhatsApp ללקוחות עם טלפון (אישי ונפתח יותר), אבל מייל הוא ערוץ פעיל ולגיטימי - אל תאמר שהוא "לא פעיל".

בחירת לקוחה ספציפית (קריטי):
- כשבעל החנות מבקש פעולה על "הלקוחה הזו" / "לקוחה ספציפית" / לקוחה אחת בלי לנקוב בשם - אל תדפיס טבלה ארוכה ותשאל "איזו?". **תחליט בעצמך**: בחר את המועמדת הכי שווה (ערך גבוה + יש לה טלפון), הצג אותה בשורה אחת ("בחרתי את X - עגלה של Y₪, יש טלפון"), והצע מיד את הפעולה בבלוק ACTION. אם הוא רוצה אחרת - הוא יגיד.
- העדף תמיד מועמדות עם טלפון (WhatsApp) על פני כאלה עם מייל בלבד.
- אם אתה כן מציג רשימה לבחירה - מקסימום 5 שורות, ועד 3 עמודות (שם, ערך, טלפון). לעולם לא טבלאות רחבות.

כדי להציע פעולה אישית ללקוחה אחת, סיים את תשובתך בבלוק בפורמט הזה:
[[ACTION:type=cart_recovery|name=שם הלקוחה|email=כתובת מייל|phone=טלפון|coupon=15|coupon_code=SHIRA15|coupon_days=2|subject=נושא ההודעה|body=תוכן ההודעה המלא כאן עם {COUPON} במקום שבו הקוד יופיע]]
כללים לבלוק הפעולה:
- שדות אופציונליים: אם אין מייל השאר email ריק, אם אין טלפון השאר phone ריק (לפחות אחד נדרש, ועדיף טלפון).
- **הנחה באחוזים מול הנחה בשקלים - קריטי:** אם בעל החנות מבקש הנחה ב**אחוזים** (למשל "10 אחוז", "הנחה של 15%") - השתמש בשדה coupon=15 (המספר הוא אחוז). אם הוא מבקש הנחה ב**שקלים** (למשל "77 שקל", "הנחה של ₪50", "50 שקלים הנחה") - השתמש בשדה coupon_ils=77 במקום coupon (המספר הוא סכום בשקלים). לעולם אל תבלבל - "77 שקל" זה coupon_ils=77 ולא coupon=77. השתמש רק באחד מהשניים, לא בשניהם.
- coupon=מספר אחוז ההנחה (למשל 15). coupon_ils=סכום הנחה בשקלים (למשל 77). אם אין קופון, השמט את שניהם.
- **כפל מבצעים (combine):** באתר יש כבר הנחה אוטומטית קבועה. ברירת המחדל היא שהקופון שאתה יוצר מצטבר **בנוסף** להנחה הקיימת (combine=yes) - אל תוסיף את השדה כלל וזה יקרה אוטומטית. רק אם בעל החנות אומר במפורש "בלי כפל מבצעים" / "במקום ההנחה הקיימת" / "לא מצטבר" - הוסף combine=no לבלוק.
- coupon_days=2 תמיד (הקופונים תקפים ל-48 שעות).
- {COUPON} בתוך ה-body יוחלף אוטומטית בקוד הקופון האמיתי שייווצר. אל תמציא קוד קופון בעצמך - הממשק יוצר אותו.
- **חובה מוחלטת:** בכל פעם שאתה מציע קופון, מלא את שדה coupon_code עם קוד ייחודי ואישי המשלב את שם הלקוחה (באנגלית) + ההנחה - למשל SHOSHI15. אם השם בעברית, תעתק לאנגלית. לעולם אל תשתמש בקוד גנרי כמו SALE.
- ציין בגוף ההודעה שהקוד תקף ל-48 שעות בלבד (יוצר דחיפות).
- ה-body צריך להיות הודעה מלאה, חמה, מוכנה לשליחה. טון חם ומזמין. לעולם אל תזכיר נתונים פנימיים שעלולים להרתיע - כמה היא הוציאה, כמה הזמנות עשתה, או "לא קנית X זמן".
- **קול המותג:** כתוב תמיד בלשון רבים בשם החנות ("רצינו", "שמרנו לך", "מחכים לך") - לא בגוף יחיד ("רציתי", "שמרתי"). החנות היא "אנחנו", לא אדם בודד.
- אל תכתוב כתובות URL גולמיות בתוך גוף ההודעה (כמו https://...). הלינקים (לאתר / לעגלה) מתווספים אוטומטית על ידי הממשק ככפתור או קישור לחיץ. אם אתה רוצה להפנות לאתר, כתוב במילים ("בקישור המצורף", "באתר שלנו") והממשק יוסיף את הלינק.
- כתוב הסבר קצר לפני הבלוק (מה אתה מציע ולמה), והבלוק עצמו בסוף. אל תסביר את הפורמט של הבלוק.

עגלה מותאמת אישית (המהלך החזק ביותר):
כשאתה רוצה לבנות ללקוחה עגלה מוכנה עם מוצרים ספציפיים ולשלוח לה לינק, השתמש בבלוק עגלה.
שלבי חובה לפני בניית עגלה:
1. קרא getCustomerSizes כדי לדעת איזו מידה הלקוחה קנתה בעבר.
2. קרא getProductVariants כדי למצוא variant_id אמיתי - ובחר רק וריאנטים במידה שהלקוחה לובשת ושזמינים במלאי (in_stock > 0).
3. קרא getCustomerPurchases / getCrossSellData כדי לבחור מוצרים שמתאימים לטעם שלה.
הפורמט:
[[CART:name=שם הלקוחה|email=מייל|phone=טלפון|discount=10|items=VARIANT_ID:כמות,VARIANT_ID:כמות|subject=נושא|body=הודעה אישית]]
כללים:
- items = variant_id:כמות מופרדים בפסיק. חובה variant_id אמיתי של מידה שהלקוחה לובשת וזמינה במלאי.
- אם אין למוצר וריאנט במידה של הלקוחה שזמין במלאי - אל תכלול אותו.
- ה-body הוא הודעה אישית חמה. לינק התשלום + קופון אישי יתווספו אוטומטית.
- ציין בהודעה שהקוד תקף ל-48 שעות בלבד.

קמפיין המוני (batch):
כשבעל החנות מבקש לפנות לקבוצת לקוחות - הפעל קמפיין batch: זהה את הסגמנט (אפשר עד 300 לקוחות בבת אחת), הכן תבנית הודעה אחת מותאמת לסגמנט, וכל לקוחה תקבל אוטומטית קופון אישי משלה.
**קריטי - איך להחזיר קמפיין:** לעולם אל תדפיס בצ'אט רשימה של הודעות מוכנות לכל לקוחה ("הנה 13 הודעות להעתקה" וכו') - זה יוצר בלבול והכל מתערבב. במקום זה, סיים תמיד בבלוק CAMPAIGN **אחד** עם תבנית הודעה אחת ורשימת הלקוחות. המערכת מייצרת אוטומטית ריבוע WhatsApp **נפרד** לכל לקוחה, עם קופון אישי וכפתור "שלח" משלה - בדיוק כמו שקורה ללקוחה בודדת. אתה רק מספק תבנית אחת + רשימת לקוחות, והמערכת מפצלת אותה לכל אחת.
שלבים:
1. שלוף את רשימת הלקוחות בסגמנט (getDormantCustomers, getAbandonedCheckouts, getTopCustomers וכו') - עם שם, מייל, וטלפון.
2. הכן תבנית הודעה אחת חמה לסגמנט. השתמש ב-{NAME} למקום השם ו-{COUPON} למקום הקוד (יוחלפו אוטומטית לכל לקוחה). ציין בהודעה שהקוד תקף ל-48 שעות בלבד.
3. סיים בבלוק קמפיין:
[[CAMPAIGN:type=winback|percentage=15|days=2|subject=נושא ההודעה|body=הודעה עם {NAME} ו-{COUPON}|customers=שם1<מייל1<טלפון1<ערך1;;שם2<מייל2<טלפון2<ערך2;;...]]
כללים לבלוק קמפיין:
- customers = רשימת לקוחות. כל לקוחה: שם<מייל<טלפון<ערך_משוער, מופרדים ב-;; בין לקוחות. אם אין טלפון או מייל השאר ריק (עדיף טלפון).
- **הנחה באחוזים מול שקלים:** אם ההנחה באחוזים - השתמש ב-percentage=15. אם ההנחה בשקלים - השתמש ב-amount_ils=77 במקום percentage. "77 שקל" = amount_ils=77, ולא percentage=77.
- **כפל מבצעים:** כברירת מחדל הקופון מצטבר בנוסף להנחת האתר הקיימת. רק אם ביקשו במפורש "בלי כפל" הוסף combine=no לבלוק.
- days=2 תמיד (תוקף 48 שעות).
- **קוד קופון קיים של בעל החנות (חשוב):** אם בעל החנות אומר שהוא כבר יצר קוד קופון בעצמו ורוצה שתשתמש בו (למשל "תשלח לכולם את הקוד SUMMER20", "יש לי קוד מוכן בשם X"), הוסף לבלוק code=SUMMER20 והשתמש בו במקום ליצור קוד חדש. אל תיצור קוד משלך כשבעל החנות ביקש קוד ספציפי. במקרה כזה כולם יקבלו את אותו קוד (הקוד שלו). אם בעל החנות לא נתן קוד - אל תוסיף code= והמערכת תיצור קופון אישי לכל לקוחה כרגיל.
- ערך_משוער = הערכת ההכנסה הצפויה מהלקוחה. אם לא ידוע, שים 0.
- אפשר עד 300 לקוחות בקמפיין אחד. אם הסגמנט גדול יותר, אפשר לפנות בקבוצות לאורך זמן. רשימות הלקוחות מתחלפות בכל קריאה (סדר אקראי) - כך שכל פעם שמבקשים "עוד" מקבלים אנשים שונים, לא את אותם אנשים שוב.
- **זיכרון של מי שכבר פנינו אליו (חשוב מאוד):** כל הכלים מסננים אוטומטית (כברירת מחדל) לקוחות שכבר פנינו אליהם לאחרונה - אתה לא צריך לבקש את זה. לעולם אל תציע לפנות שוב לאותו אדם שכבר טיפלנו בו, אלא אם בעל החנות מבקש זאת במפורש (ואז העבר excludeContacted=false).
- **כשבעל החנות מבקש "לקוחות חדשות" / "אנשים שעוד לא פנינו אליהם" / "מישהי שלא דיברנו איתה":** קרא לכלי עם הפרמטר onlyNew=true. זה מחזיר רק לקוחות שמעולם לא פנינו אליהם - אף פעם, לא רק לאחרונה. ככה בעל החנות בטוח שלא נטריד מישהו פעמיים.
- **כשמבקשים "עוד לקוחות אחרות" / "רשימה חדשה" / "50 אחרות שלא היו ברשימה הקודמת":** הכלים כבר מסננים את מי שפנינו אליו לאחרונה. אל תחזיר את אותן לקוחות שכבר הצגת בשיחה הזו. אם אחרי הסינון אין מספיק לקוחות, אמור זאת בכנות (למשל "נשארו רק 12 לקוחות חדשות שעומדות בתנאי") - אל תמציא ואל תחזור על קודמות.
- לפני הבלוק, הסבר בקצרה כמה לקוחות, איזה סגמנט, וצפי הכנסה. אחרי הבלוק כתוב משפט קצר כמו "הכל מוכן - אשר למטה". אל תסביר על כפתורים ואל תתאר את הממשק.
- כתוב 2-3 דוגמאות איך ההודעה תיראה (עם שמות אמיתיים מהסגמנט) כדי שיוכל לאשר את האיכות.
- המערכת מטפלת אוטומטית בבטיחות: לא תשלח מחוץ לשעות (למייל), לא למי שביקש להפסיק, ולא למי שכבר פנינו אליו לאחרונה. אל תדאג לזה.

לגבי TryFit (אפליקציית המדידה הווירטואלית של החנות):
- TryFit היא אפליקציה מצוינת שמאפשרת ללקוחות "למדוד" בגדים וירטואלית לפני קנייה - מגדילה ביטחון ומפחיתה החזרות. דברי עליה בחום.
- אין לך גישה לנתוני שימוש של TryFit. אל תיתני מספרים על שימוש ב-TryFit - גם לא "אפס".
- אם שואלים כמה השתמשו ב-TryFit - הסבירי בחום שאת לא רואה את נתוני השימוש (זמינים דרך צוות TryFit), והדגישי שזה כלי מצוין. לעולם אל תרמזי שהוא "לא עובד".

עיצוב התשובה (חשוב מאוד):
- אתה כותב בממשק צ'אט. אל תשתמש בכותרות markdown (כמו ## או ###) - הן מופיעות כטקסט מכוער.
- אל תשתמש באימוג'י של עיגולים צבעוניים או אימוג'י דקורטיביים מיותרים.
- מותר: טקסט זורם, **הדגשה** למילים חשובות, ורשימות עם מקף (-).
- לרשימות לקוחות או מוצרים, השתמש בטבלת markdown (עם | ).
- שמור על תשובות נקיות, קצרות וממוקדות. פסקאות קצרות, לא קיר טקסט.

זיכרון לטווח ארוך:
- אם בעל החנות נותן לך העדפה או הנחיה קבועה (למשל "אל תפנה ללקוחות מתחת ל-100 שקל", "אני מעדיף וואטסאפ", "תמיד הנחה 10%") - השתמש בכלי rememberPreference כדי לשמור אותה. היא תחול על כל השיחות הבאות.
- אם בתחילת ההודעה שלי מופיעות "העדפות והנחיות קבועות" - כבד אותן תמיד.
- אם מופיעה רשימת "לקוחות שכבר פנינו אליהם" - אל תציע אותם שוב אלא אם בעל החנות מבקש במפורש. הצע לקוחות אחרים.`;
}

// ---------- Tool definitions for Claude ----------
const TOOL_DEFINITIONS = [
  {
    name: "getAudienceCounts",
    description: "מחזיר ספירות כוללות של כל בסיס הלקוחות (לא רשימה - מספרים). השתמש בזה לשאלות כמו 'כמה לקוחות יש לי', 'כמה רשומים בדיוור', 'כמה לא קנו 60 יום', 'כמה אף פעם לא קנו'. מחזיר: סהכ לקוחות, כמה עם מייל, כמה עם טלפון, כמה הסכימו לדיוור (marketing_subscribers), כמה ניתנים לפנייה (contactable - יש להם מייל/טלפון ולא ביטלו), כמה קנו, כמה אף פעם לא קנו, כמה לקוחות חוזרים, וכמה רדומים מעל 60 יום.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "getTopCustomers",
    description: "מחזיר את הלקוחות הטובים ביותר לפי סך ההוצאה (lifetime) או מספר הזמנות. שימושי לשאלות כמו 'מי הלקוחות הכי טובות שלי'.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה לקוחות להחזיר (ברירת מחדל 10)" },
        sortBy: { type: "string", enum: ["total_spent", "orders_count"], description: "לפי מה למיין" },
        excludeContacted: { type: "boolean", description: "ברירת מחדל true - מסנן אוטומטית לקוחות שכבר פנינו אליהן לאחרונה. העבר false רק אם בעל החנות מבקש במפורש לפנות שוב לאותן לקוחות." },
        onlyNew: { type: "boolean", description: "אם true, מחזיר רק לקוחות שמעולם לא פנינו אליהן (לא רק לאחרונה - אף פעם). השתמש בזה כשבעל החנות מבקש 'לקוחות חדשות' / 'אנשים שעוד לא פנינו אליהם' / 'מישהי שלא דיברנו איתה'." }
      }
    }
  },
  {
    name: "getDormantCustomers",
    description: "לקוחות ששילמו בעבר אך לא הזמינו זמן מה. שימושי ל'מי קנתה ונעלמה' ולקמפיינים להחזרת לקוחות.",
    input_schema: {
      type: "object",
      properties: {
        daysInactive: { type: "integer", description: "כמה ימים ללא הזמנה (ברירת מחדל 30)" },
        minSpent: { type: "number", description: "מינימום הוצאה לכל החיים (ברירת מחדל 0)" },
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20, עד 300)" },
        sortMode: { type: "string", enum: ["rotate", "value"], description: "rotate (ברירת מחדל) = סדר אקראי, כל קריאה מחזירה אנשים שונים. value = לפי ההוצאה הגבוהה ביותר. השתמש ב-rotate כשמבקשים 'עוד אנשים' כדי לא לחזור על אותם, ו-value כשמבקשים את הלקוחות הכי שוות." },
        excludeContacted: { type: "boolean", description: "ברירת מחדל true - מסנן אוטומטית לקוחות שכבר פנינו אליהן לאחרונה. העבר false רק אם בעל החנות מבקש במפורש לפנות שוב לאותן לקוחות." },
        onlyNew: { type: "boolean", description: "אם true, מחזיר רק לקוחות שמעולם לא פנינו אליהן (לא רק לאחרונה - אף פעם). השתמש בזה כשבעל החנות מבקש 'לקוחות חדשות' / 'אנשים שעוד לא פנינו אליהם' / 'מישהי שלא דיברנו איתה'." }
      }
    }
  },
  {
    name: "getNeverPurchased",
    description: "לקוחות שנרשמו אך מעולם לא קנו. שימושי לקמפיין קופון הזמנה ראשונה.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20)" },
        excludeContacted: { type: "boolean", description: "ברירת מחדל true - מסנן אוטומטית לקוחות שכבר פנינו אליהן לאחרונה. העבר false רק אם בעל החנות מבקש במפורש לפנות שוב לאותן לקוחות." },
        onlyNew: { type: "boolean", description: "אם true, מחזיר רק לקוחות שמעולם לא פנינו אליהן (לא רק לאחרונה - אף פעם). השתמש בזה כשבעל החנות מבקש 'לקוחות חדשות' / 'אנשים שעוד לא פנינו אליהם' / 'מישהי שלא דיברנו איתה'." }
      }
    }
  },
  {
    name: "getRepeatCustomers",
    description: "לקוחות נאמנות עם יותר מהזמנה אחת. שימושי לזיהוי הלקוחות הכי נאמנות.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20)" },
        excludeContacted: { type: "boolean", description: "ברירת מחדל true - מסנן אוטומטית לקוחות שכבר פנינו אליהן לאחרונה. העבר false רק אם בעל החנות מבקש במפורש לפנות שוב לאותן לקוחות." },
        onlyNew: { type: "boolean", description: "אם true, מחזיר רק לקוחות שמעולם לא פנינו אליהן (לא רק לאחרונה - אף פעם). השתמש בזה כשבעל החנות מבקש 'לקוחות חדשות' / 'אנשים שעוד לא פנינו אליהם' / 'מישהי שלא דיברנו איתה'." }
      }
    }
  },
  {
    name: "getCustomerProfile",
    description: "פרופיל מלא של לקוחה בודדת לפי אימייל, כולל הזמנות אחרונות. שימושי כששואלים על לקוחה ספציפית.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "אימייל הלקוחה" }
      },
      required: ["email"]
    }
  },
  {
    name: "getCustomerPurchases",
    description: "מה לקוחה ספציפית קנתה בפועל - רשימת הפריטים, הכמויות, והקטגוריות האהובות עליה (ב-60 הימים האחרונים). שימושי כששואלים 'מה X אוהבת', 'מה לקנות לקמפיין מותאם ל-X', או כדי להתאים המלצות/הודעות לפי טעם הלקוחה.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "אימייל הלקוחה" }
      },
      required: ["email"]
    }
  },
  {
    name: "searchCustomers",
    description: "חיפוש לקוחות לפי שם או אימייל. שימושי כששואלים 'מצא את הלקוחה X'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "טקסט לחיפוש (שם או אימייל)" }
      },
      required: ["query"]
    }
  },
  {
    name: "getTopProducts",
    description: "המוצרים הנמכרים ביותר ב-60 הימים האחרונים. שימושי ל'מה מכר הכי טוב'.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה מוצרים להחזיר (ברירת מחדל 10)" }
      }
    }
  },
  {
    name: "getRevenueStats",
    description: "סיכום הכנסות ב-60 הימים האחרונים (סך הזמנות, הכנסה, ערך הזמנה ממוצע). שימושי ל'כמה הכנסתי'.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "כמה ימים אחורה (מקסימום 60)" }
      }
    }
  },
  {
    name: "getStoreProducts",
    description: "קטלוג המוצרים החי של החנות (מתעדכן מ-Shopify כל 6 שעות) - מה קיים במלאי עכשיו. כל מוצר מוחזר עם product_url - קישור אמיתי ומוכן למוצר. שימושי כשרוצים להמליץ על מוצר ספציפי ללקוחה, לבדוק מה יש במלאי, או למצוא מוצרים בטווח מחיר. חיפוש לפי טקסט חופשי בשם המוצר (search), טווח מחיר (minPrice/maxPrice), ורק זמינים (availableOnly, ברירת מחדל true). חשוב: לחיפוש לפי סוג בגד, השתמש ב-search עם מילה בעברית (למשל 'שמלה', 'ג'ינס', 'אוברול') כי לרוב המוצרים אין קטגוריה מוגדרת.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "טקסט חופשי לחיפוש בשם המוצר, בעברית (אופציונלי)" },
        minPrice: { type: "number", description: "מחיר מינימלי (אופציונלי)" },
        maxPrice: { type: "number", description: "מחיר מקסימלי (אופציונלי)" },
        availableOnly: { type: "boolean", description: "רק מוצרים במלאי (ברירת מחדל true)" },
        limit: { type: "integer", description: "כמה מוצרים להחזיר (ברירת מחדל 20, מקסימום 50)" }
      }
    }
  },
  {
    name: "generateWhatsAppMessage",
    description: "מכין טקסט WhatsApp בעברית מותאם ללקוחה ולמטרה. intent יכול להיות: comeback, first_order, vip, winback_big. מחזיר טקסט בלבד - לא שולח.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "אימייל הלקוחה" },
        intent: { type: "string", enum: ["comeback", "first_order", "vip", "winback_big"], description: "סוג ההודעה" }
      },
      required: ["email"]
    }
  },
  {
    name: "getAbandonedCheckouts",
    description: "עגלות נטושות - לקוחות שהוסיפו מוצרים לעגלה והתחילו תשלום אבל לא השלימו. מחזיר סיכום, המוצרים שהכי ננטשים, ורשימת עגלות לשחזור (עם אימייל, ערך, וקישור ישיר). שימושי לשאלות על עגלות נטושות. אפשר לבקש חלון זמן (days, ברירת מחדל 30).",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "חלון זמן בימים (ברירת מחדל 30)" },
        limit: { type: "integer", description: "כמה תוצאות להחזיר (ברירת מחדל 10, מקסימום 50)" }
      }
    }
  },
  {
    name: "getCrossSellData",
    description: "ניתוח רכישות משותפות - 'מי שקנה X קנה גם Y'. אם מעבירים productTitle, מחזיר את המוצרים שנקנים הכי הרבה יחד עם אותו מוצר. בלי productTitle, מחזיר את צמדי המוצרים החזקים ביותר. שימושי לבניית הצעות מותאמות, באנדלים, והעלאת סל קנייה.",
    input_schema: {
      type: "object",
      properties: {
        productTitle: { type: "string", description: "שם מוצר עוגן (אופציונלי)" },
        limit: { type: "integer", description: "כמה תוצאות (ברירת מחדל 8)" }
      }
    }
  },
  {
    name: "getCampaignPerformance",
    description: "ביצועי הקמפיינים והפעולות שהיועץ כבר ביצע - כמה פעולות, כמה הומרו, כמה הכנסות, ואחוז המרה לפי סוג פעולה. השתמש בזה כדי ללמוד מה עובד. שימושי לשאלות 'מה עבד', 'כמה כסף הכנסת לי'.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "getProductVariants",
    description: "מחזיר וריאנטים זמינים של מוצרים - variant_id, מידה/צבע, מחיר, וכמות במלאי. נדרש כדי לבנות עגלה מותאמת. אפשר לחפש לפי שם מוצר (search).",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "חיפוש לפי שם מוצר (אופציונלי)" },
        limit: { type: "integer", description: "כמה מוצרים (ברירת מחדל 10)" }
      }
    }
  },
  {
    name: "getCustomerSizes",
    description: "מחזיר את המידות/וריאנטים שלקוחה ספציפית קנתה בעבר (לפי email). קריטי לבניית עגלה מותאמת - הוסף רק מוצרים במידה שהיא קנתה וזמינים במלאי.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string", description: "אימייל הלקוחה" } },
      required: ["email"]
    }
  },
  {
    name: "getTodayActivity",
    description: "מה היועץ עשה היום (מתחילת היום בשעון ישראל) - כמה פעולות, כמה לקוחות, כמה קופונים, כמה המרות וכמה כסף נכנס. השתמש כשבעל החנות שואל 'מה עשית עד עכשיו' / 'מה קרה היום'.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "getNewestProducts",
    description: "המוצרים שפורסמו לאחרונה - הקולקציה החדשה ביותר. ממיין לפי תאריך פרסום. השתמש כשבעל החנות מדבר על 'הקולקציה החדשה', 'מה שעלה עכשיו', או רוצה לקדם מוצרים חדשים. מחזיר שם, מחיר, מלאי, קישור ותאריך פרסום.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "כמה מוצרים (ברירת מחדל 15)" } }
    }
  },
  {
    name: "rememberPreference",
    description: "שמור העדפה או הנחיה קבועה שבעל החנות נותן, כדי שתחול על כל השיחות העתידיות. השתמש בזה כשבעל החנות אומר משהו שצריך לזכור לטווח ארוך - למשל 'אל תפנה ללקוחות מתחת ל-100 שקל', 'אני מעדיף וואטסאפ על מייל', 'תמיד תציע הנחה של 10%', 'אל תפנה ללקוחות מאשדוד'. אל תשתמש בזה לבקשות חד-פעמיות, רק להעדפות קבועות.",
    input_schema: {
      type: "object",
      properties: {
        preference: { type: "string", description: "ההעדפה או ההנחיה לשמור, בניסוח ברור וקצר בעברית" }
      },
      required: ["preference"]
    }
  }
];

// Map tool name -> actual function. All take (shopDomain, options).
const TOOL_IMPL = {
  getAudienceCounts: aiTools.getAudienceCounts,
  getTopCustomers: aiTools.getTopCustomers,
  getDormantCustomers: aiTools.getDormantCustomers,
  getNeverPurchased: aiTools.getNeverPurchased,
  getRepeatCustomers: aiTools.getRepeatCustomers,
  getCustomerProfile: aiTools.getCustomerProfile,
  getCustomerPurchases: aiTools.getCustomerPurchases,
  searchCustomers: aiTools.searchCustomers,
  getTopProducts: aiTools.getTopProducts,
  getRevenueStats: aiTools.getRevenueStats,
  getStoreProducts: aiTools.getStoreProducts,
  generateWhatsAppMessage: aiTools.generateWhatsAppMessage,
  getAbandonedCheckouts: aiTools.getAbandonedCheckouts,
  getCrossSellData: aiTools.getCrossSellData,
  getCampaignPerformance: aiTools.getCampaignPerformance,
  getProductVariants: aiTools.getProductVariants,
  getCustomerSizes: aiTools.getCustomerSizes,
  getTodayActivity: aiTools.getTodayActivity,
  getNewestProducts: aiTools.getNewestProducts
};

// Recursively strip heavy/PII-laden fields before sending to Claude.
function stripHeavyFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripHeavyFields);
  if (obj && typeof obj === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "raw_data") continue;
      clean[k] = stripHeavyFields(v);
    }
    return clean;
  }
  return obj;
}

// Run a single tool the model asked for.
async function runTool(shopDomain, toolName, toolInput) {
  // Persistent-memory tool: save a durable preference for this store.
  if (toolName === "rememberPreference") {
    try {
      const memory = require('./memory-engine');
      const pref = (toolInput && toolInput.preference || '').trim();
      if (!pref) return { ok: false, error: 'empty preference' };
      await memory.addPreference(shopDomain, pref);
      return { ok: true, saved: pref, note: "ההעדפה נשמרה ותחול על כל השיחות הבאות." };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  const impl = TOOL_IMPL[toolName];
  if (!impl) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }
  try {
    const result = await impl(shopDomain, toolInput || {});
    return stripHeavyFields(result);
  } catch (err) {
    return { ok: false, error: err.message, tool: toolName };
  }
}

// ---------- Main entry point ----------
async function askBrain(shopDomain, shopName, userMessage, priorMessages = []) {
  const client = getClient();
  let systemText = buildSystemPrompt(shopName || shopDomain);

  // Inject persistent memory (durable preferences + recently-handled customers)
  // so the advisor remembers across conversations, not just within one.
  try {
    const memory = require('./memory-engine');
    const memBlock = await memory.buildMemoryBlock(shopDomain);
    if (memBlock) systemText += memBlock;
  } catch (e) { /* memory is best-effort */ }

  const system = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } }
  ];

  const cachedTools = TOOL_DEFINITIONS.map((t, i) =>
    i === TOOL_DEFINITIONS.length - 1
      ? { ...t, cache_control: { type: "ephemeral" } }
      : t
  );

  const messages = [...priorMessages, { role: "user", content: userMessage }];
  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: cachedTools,
      messages
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolsUsed.push({ name: block.name, input: block.input });
          const result = await runTool(shopDomain, block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const answer = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { ok: true, answer, toolsUsed, messages };
  }

  return {
    ok: false,
    answer: "מצטער, השאלה הזו דרשה יותר מדי צעדים. נסי לנסח אותה בצורה פשוטה יותר.",
    toolsUsed,
    messages
  };
}

module.exports = { askBrain, TOOL_DEFINITIONS, MODEL };