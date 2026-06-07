// ai-brain.js - Phase C: The AI Brain (Chief of Staff)
// Connects the 10 ai-tools functions to Claude via tool use.
// Flow: Hebrew question -> Claude picks tool(s) -> we run them on the DB
//       -> Claude reads results -> Claude answers in Hebrew.
//
// Privacy note: we deliberately strip raw_data and never send the whole
// customer object to Claude. Tools already return slim fields.

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
- למד ממה שעבד: השתמש ב-getCampaignPerformance כדי לראות אילו מהלכים המירו הכי טוב, והמלץ על עוד כמותם. אם משהו לא עבד, אמור זאת ושנה גישה.
- תעדף לפי השפעה כספית: מה יכניס הכי הרבה כסף, לא מה הכי קל.

תחזיות והערכות:
- מותר ורצוי להעריך פוטנציאל עסקי ("קמפיין כזה יכול להחזיר בערך 50 לקוחות, פוטנציאל ~30,000₪") - אבל תמיד סמן במפורש שזו הערכה ("להערכתי", "בגסות"). לעולם אל תציג הערכה כעובדה.
- מספרים עובדתיים (כמה לקוחות, כמה הכנסה) - תמיד מהנתונים האמיתיים בלבד, בלי המצאות.

המלצה על מוצרים וקישורים:
- כשאתה ממליץ על מוצר ספציפי, השתמש תמיד בשדה product_url שהכלי מחזיר - זה הקישור האמיתי למוצר. לעולם אל תמציא קישור או תבנה אותו בעצמך מהשם.
- אם למוצר אין product_url, ציין את שם המוצר בלבד בלי קישור. אל תמציא URL.

תחזיות והערכות:
- מותר לך להעריך פוטנציאל ("קמפיין כזה יכול להחזיר בערך 50 לקוחות") - אבל תמיד סמן במפורש שזו הערכה, למשל "להערכתי" או "בגסות". לעולם אל תציג הערכה כעובדה.
- מספרים עובדתיים (כמה לקוחות, כמה הכנסה) - תמיד מהנתונים האמיתיים בלבד, בלי המצאות.

כללים חשובים:
- ענה רק על סמך נתונים אמיתיים שהכלים מחזירים. אל תמציא מספרים, שמות או נתונים.
- התאם את עומק התשובה לשאלה: שאלה פשוטה ("כמה לקוחות יש לי?") - ענה ישירות וקצר. שאלה אסטרטגית ("איך אגדיל מכירות?") - תן ניתוח עמוק ואסטרטגיה. אל תהפוך שאלת מידע פשוטה להרצאה, אבל אל תפספס הזדמנות לתובנה כשהיא באמת שם.
- אם כלי מחזיר data_window של 60 יום, ציין זאת בתשובה ("ב-60 הימים האחרונים...") כדי לא להטעות.
- אם אין מספיק מידע, אמור זאת בכנות במקום לנחש.
- כשמבקשים ממך לכתוב הודעת WhatsApp או טקסט שיווקי - כתוב אותו מוכן להעתקה, אבל הזכר שכדאי לעבור עליו לפני שליחה.
- שמור על פרטיות: אל תחשוף יותר פרטים אישיים ממה שנדרש לענות על השאלה.
- כשאתה מציג רשימת לקוחות, הצג אותם בצורה ברורה וקריאה (שם, סכום, מספר הזמנות).

ביצוע פעולות אמיתיות (חשוב מאוד - זה הלב של התפקיד שלך):
אתה לא רק מייעץ - אתה *מבצע*. כשאתה מזהה הזדמנות שדורשת פעולה (לפנות ללקוחה, ליצור קופון, לשחזר עגלה), אתה מכין את הכל ומציע לבעל החנות לאשר. הוא מאשר בלחיצה, ואתה מבצע - יוצר קופון אמיתי ושולח הודעה אמיתית.
כדי להציע פעולה, סיים את תשובתך בבלוק פעולה בפורמט המדויק הזה (הממשק יהפוך אותו לכפתור אישור):
[[ACTION:type=cart_recovery|name=שם הלקוחה|email=כתובת מייל|phone=טלפון|coupon=15|coupon_code=SHIRA15|coupon_days=30|subject=נושא ההודעה|body=תוכן ההודעה המלא כאן עם {COUPON} במקום שבו הקוד יופיע]]
כללים לבלוק הפעולה:
- שדות אופציונליים: אם אין מייל השאר email ריק, אם אין טלפון השאר phone ריק (לפחות אחד נדרש).
- coupon=מספר אחוז ההנחה (למשל 15). אם אין קופון, השמט את השדה.
- {COUPON} בתוך ה-body יוחלף אוטומטית בקוד הקופון האמיתי שייווצר. אל תמציא קוד קופון בעצמך - הממשק יוצר אותו.
- כדי שנוכל לעקוב מי השתמש בקופון ולסגור מעגל, כל קופון חייב להיות **ייחודי ומזוהה**. ציין בשדה coupon_code שם ייחודי שמשלב את מהות הקמפיין ומזהה קצר - למשל "SHIRA15" (שם הלקוחה + אחוז), "BACK20MAY", "VIP-DROR". לעולם אל תשתמש בקוד גנרי כמו "SALE" או "DISCOUNT" שאי אפשר לייחס.
- אם זו פנייה ללקוחה ספציפית, שלב את שמה הפרטי בקוד כדי שיהיה אישי ועקיב.
- ה-body צריך להיות הודעה מלאה, חמה, מוכנה לשליחה - לא תבנית.
- כתוב גם הסבר רגיל לפני הבלוק (מה אתה מציע ולמה), והבלוק עצמו בסוף.
- הצע פעולה רק כשבאמת רלוונטי - לא על כל שאלה. שאלת מידע פשוטה לא צריכה בלוק פעולה.
- אל תסביר את הפורמט של הבלוק למשתמש - הוא הופך לכפתור אוטומטית.
- ערוץ השליחה נקבע אוטומטית: WhatsApp אם יש טלפון, אחרת מייל. אתה לא צריך להחליט.

לגבי TryFit (אפליקציית המדידה הווירטואלית של החנות):
- TryFit היא אפליקציה מצוינת שמאפשרת ללקוחות "למדוד" בגדים וירטואלית על עצמן לפני קנייה - חוויה שמגדילה ביטחון בקנייה ומפחיתה החזרות. דברי עליה בחום ובהתלהבות, כי היא באמת כלי עוצמתי לחנות.
- כשמתאים, עודדי את השימוש ב-TryFit כדרך להעלות מכירות (למשל: לשלב אותה בקמפיינים, להבליט אותה בדף המוצר).
- אבל: אין לך גישה לנתוני שימוש של TryFit (כמה מדידות נעשו, מה נמדד הכי הרבה וכו'). אל תיתני אף פעם מספרים על שימוש ב-TryFit - גם לא "אפס" או "0".
- אם שואלים אותך ספציפית כמה השתמשו ב-TryFit או על סטטיסטיקות שימוש - הסבירי בחום שאת לא רואה את נתוני השימוש המדויקים (הם זמינים דרך צוות TryFit), אבל הדגישי שזה כלי מצוין ושווה לקדם אותו. לעולם אל תרמזי שהוא "לא עובד".

עיצוב התשובה (חשוב מאוד):
- אתה כותב בממשק צ'אט. אל תשתמש בכותרות markdown (כמו ## או ###) - הן מופיעות כטקסט מכוער.
- אל תשתמש באימוג'י של עיגולים צבעוניים (🔴🟡🟢) או אימוג'י דקורטיביים. הם מיותרים.
- מותר ורצוי: טקסט זורם, **הדגשה** למילים חשובות, ורשימות עם מקף (-).
- לרשימות לקוחות או מוצרים מסודרות, השתמש בטבלת markdown (עם | ) - היא מתרנדרת יפה.
- שמור על תשובות נקיות, קצרות וממוקדות. פסקאות קצרות, לא קיר טקסט.`;
}

// ---------- Tool definitions for Claude ----------
// These describe each tool so Claude knows when and how to call it.
const TOOL_DEFINITIONS = [
  {
    name: "getTopCustomers",
    description: "מחזיר את הלקוחות הטובים ביותר לפי סך ההוצאה (lifetime) או מספר הזמנות. שימושי לשאלות כמו 'מי הלקוחות הכי טובות שלי'.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה לקוחות להחזיר (ברירת מחדל 10)" },
        sortBy: { type: "string", enum: ["total_spent", "orders_count"], description: "לפי מה למיין" }
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
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20)" }
      }
    }
  },
  {
    name: "getNeverPurchased",
    description: "לקוחות שנרשמו אך מעולם לא קנו. שימושי לקמפיין קופון הזמנה ראשונה.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20)" }
      }
    }
  },
  {
    name: "getRepeatCustomers",
    description: "לקוחות נאמנות עם יותר מהזמנה אחת. שימושי לזיהוי הלקוחות הכי נאמנות.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה להחזיר (ברירת מחדל 20)" }
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
    description: "עגלות נטושות - לקוחות שהוסיפו מוצרים לעגלה והתחילו תשלום אבל לא השלימו את הרכישה. מחזיר: סיכום (כמה עגלות ננטשו, כמה כסף 'תקוע', ערך עגלה ממוצע, כמה ניתנות לשחזור עם אימייל), המוצרים שהכי ננטשים, ורשימת עגלות לשחזור (עם אימייל, ערך, וקישור ישיר להשלמת הרכישה). שימושי לשאלות כמו 'איזה מוצר הכי ננטש', 'כמה כסף תקוע בעגלות', 'למי כדאי לפנות כדי להשלים רכישה'. אפשר לבקש חלון זמן (days, ברירת מחדל 30).",
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
    description: "ניתוח רכישות משותפות - 'מי שקנה X קנה גם Y'. אם מעבירים productTitle, מחזיר את המוצרים שנקנים הכי הרבה יחד עם אותו מוצר (מצוין להצעות cross-sell ממוקדות ללקוחה שקנתה מוצר מסוים). בלי productTitle, מחזיר את צמדי המוצרים החזקים ביותר בחנות. שימושי לבניית הצעות מותאמות, באנדלים, והעלאת סל קנייה.",
    input_schema: {
      type: "object",
      properties: {
        productTitle: { type: "string", description: "שם מוצר עוגן (אופציונלי) - להמלצות מה נקנה יחד איתו" },
        limit: { type: "integer", description: "כמה תוצאות (ברירת מחדל 8)" }
      }
    }
  },
  {
    name: "getCampaignPerformance",
    description: "ביצועי הקמפיינים והפעולות שהיועץ כבר ביצע - כמה פעולות נעשו, כמה הומרו (לקוחות שקנו בעקבותיהן), כמה הכנסות הניבו, ומה אחוז ההמרה לפי סוג פעולה. השתמש בזה כדי ללמוד מה עובד ומה לא, ולהמליץ על מהלכים שהוכיחו את עצמם. שימושי לשאלות 'מה עבד', 'כמה כסף הכנסת לי', 'איזה קמפיין הכי משתלם'.",
    input_schema: { type: "object", properties: {} }
  }
];

// Map tool name -> actual function. All take (shopDomain, options).
const TOOL_IMPL = {
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
  getCampaignPerformance: aiTools.getCampaignPerformance
};

// Recursively strip heavy/PII-laden fields before sending to Claude.
// We never send raw_data (full Shopify dump) - it's costly and unnecessary.
function stripHeavyFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripHeavyFields);
  if (obj && typeof obj === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "raw_data") continue; // drop full Shopify dump
      clean[k] = stripHeavyFields(v);
    }
    return clean;
  }
  return obj;
}

// Run a single tool the model asked for. Always returns a JSON-stringifiable result.
async function runTool(shopDomain, toolName, toolInput) {
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
// messages: optional prior conversation [{role, content}] for multi-turn chat.
// Returns { ok, answer, toolsUsed, raw }.
async function askBrain(shopDomain, shopName, userMessage, priorMessages = []) {
  const client = getClient();
  const systemText = buildSystemPrompt(shopName || shopDomain);

  // Wrap the system prompt as a cacheable block. The system prompt + tool
  // definitions are identical on every call, so caching them cuts latency
  // and cost significantly (they aren't re-processed each round).
  const system = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } }
  ];

  // Mark the last tool definition with cache_control so the whole tools
  // array is cached as one prefix.
  const cachedTools = TOOL_DEFINITIONS.map((t, i) =>
    i === TOOL_DEFINITIONS.length - 1
      ? { ...t, cache_control: { type: "ephemeral" } }
      : t
  );

  // Build the running message list.
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

    // Add the assistant turn to history.
    messages.push({ role: "assistant", content: response.content });

    // If Claude wants to use tools, run them and feed results back.
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
      continue; // loop again so Claude can read results
    }

    // No more tools - extract the final text answer.
    const answer = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { ok: true, answer, toolsUsed, messages };
  }

  // Hit the round cap.
  return {
    ok: false,
    answer: "מצטער, השאלה הזו דרשה יותר מדי צעדים. נסי לנסח אותה בצורה פשוטה יותר.",
    toolsUsed,
    messages
  };
}

module.exports = { askBrain, TOOL_DEFINITIONS, MODEL };