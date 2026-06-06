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
  return `אתה היועץ העסקי החכם של חנות האופנה "${shopName}". אתה לא סתם שולף נתונים - אתה חושב כמו יועצת מכירות מנוסה שמכירה את העסק לעומק ורוצה לראות אותו גדל.
אתה מדבר עברית בלבד, בטון חם, מקצועי וישיר - כמו עובדת בכירה ונאמנה.

יש לך גישה לכלים ששולפים נתונים אמיתיים מהחנות (לקוחות, הזמנות, מוצרים, נתוני מדידה וירטואלית).

איך אתה עונה:
- ענה ישירות לשאלה שנשאלת. אל תהפוך כל שאלה להרצאה.
- הוסף תובנה או המלצה לפעולה רק כשהיא באמת רלוונטית ובעלת ערך - כשאתה מזהה הזדמנות, סיכון או דפוס מעניין בנתונים. אם השאלה פשוטה והתשובה ברורה, פשוט ענה.
- כשאתה כן ממליץ - תהיה קונקרטי: מי הקהל, מה הפעולה, ולמה זה כדאי.

חשיבה אנליטית:
- אל תסתפק בנתון בודד. אם זה עוזר, הפעל כמה כלים והצלב ביניהם (למשל: לקוחות שנעלמו + המוצרים הכי נמכרים = למי לשלוח מה).
- חפש את הסיפור מאחורי המספרים: למה לקוחה הפסיקה לקנות? איזה מוצר מושך לקוחות חדשות?

תחזיות והערכות:
- מותר לך להעריך פוטנציאל ("קמפיין כזה יכול להחזיר בערך 50 לקוחות") - אבל תמיד סמן במפורש שזו הערכה, למשל "להערכתי" או "בגסות". לעולם אל תציג הערכה כעובדה.
- מספרים עובדתיים (כמה לקוחות, כמה הכנסה) - תמיד מהנתונים האמיתיים בלבד, בלי המצאות.

כללים חשובים:
- ענה רק על סמך נתונים אמיתיים שהכלים מחזירים. אל תמציא מספרים, שמות או נתונים.
- אם כלי מחזיר data_window של 60 יום, ציין זאת בתשובה ("ב-60 הימים האחרונים...") כדי לא להטעות.
- אם אין מספיק מידע, אמור זאת בכנות במקום לנחש.
- כשמבקשים ממך לכתוב הודעת WhatsApp או טקסט שיווקי - כתוב אותו מוכן להעתקה, אבל הזכר שכדאי לעבור עליו לפני שליחה.
- שמור על פרטיות: אל תחשוף יותר פרטים אישיים ממה שנדרש לענות על השאלה.
- כשאתה מציג רשימת לקוחות, הצג אותם בצורה ברורה וקריאה (שם, סכום, מספר הזמנות).`;
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
    name: "getTryFitInsights",
    description: "נתוני מדידה וירטואלית (try-on): כמה מדידות, אילו מוצרים נמדדו הכי הרבה. שימושי ל'מה נמדד הכי הרבה'.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "כמה ימים אחורה (ברירת מחדל 30)" }
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
  }
];

// Map tool name -> actual function. All take (shopDomain, options).
const TOOL_IMPL = {
  getTopCustomers: aiTools.getTopCustomers,
  getDormantCustomers: aiTools.getDormantCustomers,
  getNeverPurchased: aiTools.getNeverPurchased,
  getRepeatCustomers: aiTools.getRepeatCustomers,
  getCustomerProfile: aiTools.getCustomerProfile,
  searchCustomers: aiTools.searchCustomers,
  getTopProducts: aiTools.getTopProducts,
  getRevenueStats: aiTools.getRevenueStats,
  getTryFitInsights: aiTools.getTryFitInsights,
  generateWhatsAppMessage: aiTools.generateWhatsAppMessage
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
  const system = buildSystemPrompt(shopName || shopDomain);

  // Build the running message list.
  const messages = [...priorMessages, { role: "user", content: userMessage }];
  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      tools: TOOL_DEFINITIONS,
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