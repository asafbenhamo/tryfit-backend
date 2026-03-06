const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();
const creditsSystem = require("./credits");
const adminRouter = require("./admin");

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"]
}));
app.use(express.json());

// ======================
// BACKEND MODE: "fashn" or "runpod"
// ======================
const BACKEND_MODE = process.env.BACKEND_MODE || "fashn";

// RunPod config
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "rpa_94NQI07B7J69J3A25963D9RH0R0FSILF9DFEPEAEwc2qnz";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "4nxbizcdhfxobd";
const RUNPOD_BASE_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

// === RATE LIMIT ===
const userLimits = new Map();
const DEFAULT_DAILY_LIMIT = 3;

function getRealIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

function parseDailyLimit(val) {
  if (val === "0" || val === 0) return -1;
  var n = parseInt(val);
  return (isNaN(n) || n < 1) ? DEFAULT_DAILY_LIMIT : n;
}

function checkRateLimit(ip, limit) {
  if (limit === -1) return true;
  const today = new Date().toDateString();
  const user = userLimits.get(ip);
  if (!user || user.date !== today) {
    userLimits.set(ip, { count: 1, date: today });
    return true;
  }
  if (user.count >= limit) return false;
  user.count++;
  return true;
}

function getShopFromRequest(req) {
  if (req.body.shop) return req.body.shop;
  if (req.headers["x-shop-domain"]) return req.headers["x-shop-domain"];
  try {
    if (req.headers.referer) return new URL(req.headers.referer).hostname;
  } catch (e) {}
  return "";
}

// ======================
// STATIC PAGES
// ======================
app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: BACKEND_MODE });
});

app.get("/privacy", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TryFit - Privacy Policy</title>
<style>
body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.6}
h1{color:#E94560}h2{color:#2D3436;margin-top:30px}
</style>
</head>
<body>
<h1>TryFit Privacy Policy</h1>
<p>Last updated: March 2026</p>
<h2>What We Collect</h2>
<p>TryFit processes photos that customers voluntarily upload to use the virtual try-on feature. These photos are sent to our processing servers solely to generate the try-on result.</p>
<h2>How We Use Your Data</h2>
<p>Uploaded photos are used only to generate virtual try-on images. Photos are not stored permanently and are automatically deleted after processing is complete.</p>
<h2>Data Sharing</h2>
<p>We do not sell, rent, or share customer photos or personal data with third parties. Photos are processed by our AI servers and deleted immediately after the result is generated.</p>
<h2>Data Retention</h2>
<p>Customer photos are temporarily processed and not retained after the try-on result is delivered. No personal data is stored on our servers.</p>
<h2>Cookies</h2>
<p>TryFit does not use cookies or tracking technologies.</p>
<h2>Merchant Data</h2>
<p>We access product images and product information from your Shopify store solely to provide the virtual try-on feature. We do not access customer personal information, order data, or payment information.</p>
<h2>Contact</h2>
<p>For privacy questions, contact us at support@tryfit.app</p>
</body>
</html>`);
});

// ======================
// ADMIN + CREDITS
// ======================
app.use("/admin", adminRouter);

app.get("/api/credits/:shop", (req, res) => {
  res.json(creditsSystem.getStoreCredits(req.params.shop));
});

// ======================
// FASHN FUNCTIONS
// ======================
function buildFashnBody(dataUri, garmentUrl, category) {
  console.log("Building FASHN body with category:", category);
  return {
    model_name: "tryon-v1.6",
    inputs: {
      model_image: dataUri,
      garment_image: garmentUrl,
      category: category || "auto",
      mode: "balanced",
      garment_photo_type: "auto"
    },
    num_samples: 1
  };
}

async function submitFashn(dataUri, garmentUrl, category) {
  const body = buildFashnBody(dataUri, garmentUrl, category);
  const response = await fetch("https://api.fashn.ai/v1/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.FASHN_API_KEY
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function pollFashn(predictionId) {
  for (let i = 0; i < 60; i++) {
    const response = await fetch("https://api.fashn.ai/v1/status/" + predictionId, {
      headers: { "Authorization": "Bearer " + process.env.FASHN_API_KEY }
    });
    const data = await response.json();
    if (data.status === "completed") return data;
    if (data.status === "failed") throw new Error(data.error?.message || "FASHN failed");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error("Timeout");
}

async function submitAndWaitFashn(modelImage, garmentUrl, category) {
  const data = await submitFashn(modelImage, garmentUrl, category);
  if (!data.id) throw new Error(data.message || data.error || "No prediction ID");
  console.log("  FASHN submitted, ID:", data.id);
  const result = await pollFashn(data.id);
  if (result.output && result.output[0]) return result.output[0];
  throw new Error("No output image");
}

// ======================
// RUNPOD FUNCTIONS
// ======================
async function submitRunPod(dataUri, garmentUrl, category) {
  let rpCategory = category;
  const categoryMap = {
    // Upper body
    "tops": "upper_body", "top": "upper_body",
    "shirts": "upper_body", "shirt": "upper_body",
    "blouses": "upper_body", "blouse": "upper_body",
    "sweaters": "upper_body", "sweater": "upper_body",
    "vest": "upper_body", "vests": "upper_body",
    "jackets": "upper_body", "jacket": "upper_body",
    "coats": "upper_body", "coat": "upper_body",
    "hoodies": "upper_body", "hoodie": "upper_body",
    "blazer": "upper_body", "blazers": "upper_body",
    "cardigan": "upper_body", "cardigans": "upper_body",
    "t-shirt": "upper_body", "t-shirts": "upper_body",
    "tshirt": "upper_body", "tshirts": "upper_body",
    "tee": "upper_body", "tees": "upper_body",
    "polo": "upper_body", "polos": "upper_body",
    "tank top": "upper_body", "tank tops": "upper_body",
    "tank": "upper_body", "tanks": "upper_body",
    "camisole": "upper_body", "cami": "upper_body",
    "crop top": "upper_body", "crop tops": "upper_body",
    "tunic": "upper_body", "tunics": "upper_body",
    "henley": "upper_body", "henleys": "upper_body",
    "pullover": "upper_body", "pullovers": "upper_body",
    "sweatshirt": "upper_body", "sweatshirts": "upper_body",
    "fleece": "upper_body",
    "parka": "upper_body", "parkas": "upper_body",
    "windbreaker": "upper_body", "windbreakers": "upper_body",
    "bomber": "upper_body", "bombers": "upper_body",
    "denim jacket": "upper_body",
    "leather jacket": "upper_body",
    "puffer": "upper_body", "puffer jacket": "upper_body",
    "down jacket": "upper_body",
    "trench": "upper_body", "trench coat": "upper_body",
    "poncho": "upper_body",
    "cape": "upper_body",
    "bolero": "upper_body",
    "shrug": "upper_body",
    "kimono": "upper_body",
    "bodysuit": "upper_body", "bodysuits": "upper_body",
    "corset": "upper_body",
    "bustier": "upper_body",
    "bralette": "upper_body",
    // Lower body
    "bottoms": "lower_body", "bottom": "lower_body",
    "pants": "lower_body", "pant": "lower_body",
    "jeans": "lower_body", "jean": "lower_body",
    "denim": "lower_body",
    "trousers": "lower_body", "trouser": "lower_body",
    "shorts": "lower_body", "short": "lower_body",
    "skirts": "lower_body", "skirt": "lower_body",
    "leggings": "lower_body", "legging": "lower_body",
    "joggers": "lower_body", "jogger": "lower_body",
    "sweatpants": "lower_body", "sweatpant": "lower_body",
    "chinos": "lower_body", "chino": "lower_body",
    "khakis": "lower_body", "khaki": "lower_body",
    "cargo pants": "lower_body", "cargo": "lower_body",
    "culottes": "lower_body",
    "capris": "lower_body", "capri": "lower_body",
    "palazzo": "lower_body", "palazzo pants": "lower_body",
    "wide leg pants": "lower_body",
    "skinny jeans": "lower_body",
    "straight jeans": "lower_body",
    "flare pants": "lower_body",
    "mini skirt": "lower_body",
    "midi skirt": "lower_body",
    "maxi skirt": "lower_body",
    "pencil skirt": "lower_body",
    "pleated skirt": "lower_body",
    "bike shorts": "lower_body",
    "bermuda": "lower_body", "bermudas": "lower_body",
    "board shorts": "lower_body",
    "swim trunks": "lower_body",
    // Overall / full body
    "dresses": "overall", "dress": "overall",
    "one-piece": "overall", "onepiece": "overall",
    "set": "overall", "sets": "overall",
    "jumpsuit": "overall", "jumpsuits": "overall",
    "romper": "overall", "rompers": "overall",
    "overalls": "overall", "overall": "overall",
    "playsuit": "overall", "playsuits": "overall",
    "gown": "overall", "gowns": "overall",
    "maxi dress": "overall",
    "midi dress": "overall",
    "mini dress": "overall",
    "cocktail dress": "overall",
    "evening dress": "overall",
    "sundress": "overall", "sundresses": "overall",
    "wrap dress": "overall",
    "shirt dress": "overall",
    "bodycon dress": "overall",
    "a-line dress": "overall",
    "suit": "overall", "suits": "overall",
    "two-piece": "overall", "two piece": "overall",
    "matching set": "overall",
    "co-ord": "overall", "coord": "overall",
    "tracksuit": "overall", "tracksuits": "overall",
    "onesie": "overall",
    "catsuit": "overall",
    "unitard": "overall",
    // Default
    "auto": "upper_body"
  };
  rpCategory = categoryMap[(rpCategory || "").toLowerCase()] || "upper_body";
  const body = {
    input: {
      model_image: dataUri,
      garment_image: garmentUrl,
      category: rpCategory
    }
  };
  const response = await fetch(RUNPOD_BASE_URL + "/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + RUNPOD_API_KEY
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function pollRunPod(jobId) {
  for (let i = 0; i < 120; i++) {
    const response = await fetch(RUNPOD_BASE_URL + "/status/" + jobId, {
      headers: { "Authorization": "Bearer " + RUNPOD_API_KEY }
    });
    const data = await response.json();
    if (data.status === "COMPLETED") return data;
    if (data.status === "FAILED") throw new Error(data.output?.error || "RunPod job failed");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("Timeout waiting for RunPod");
}

async function submitAndWaitRunPod(modelImage, garmentUrl, category) {
  const data = await submitRunPod(modelImage, garmentUrl, category);
  if (!data.id) throw new Error(data.error || "No job ID from RunPod");
  console.log("  RunPod submitted, ID:", data.id);
  const result = await pollRunPod(data.id);
  if (result.output?.image) return result.output.image;
  throw new Error("No output image from RunPod");
}

// === UNIFIED ===
async function submitJob(dataUri, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitRunPod(dataUri, garmentUrl, category);
  return await submitFashn(dataUri, garmentUrl, category);
}

async function submitAndWait(modelImage, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") return await submitAndWaitRunPod(modelImage, garmentUrl, category);
  return await submitAndWaitFashn(modelImage, garmentUrl, category);
}

// ======================
// TRY-ON ROUTES
// ======================
app.post("/api/tryon/generate", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== NEW TRY-ON REQUEST [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    console.log("User IP:", ip, "| Limit:", dailyLimit);

    // === CREDITS CHECK ===
    const shop = getShopFromRequest(req);
    if (shop) {
      const creditCheck = creditsSystem.checkAndUseCredit(shop, ip);
      if (!creditCheck.allowed) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        if (creditCheck.reason === "not_found") {
          return res.status(403).json({ error: "החנות לא רשומה במערכת. צרו קשר עם TryFit." });
        }
        return res.status(403).json({ error: "נגמרו הקרדיטים! צרו קשר לחידוש המנוי.", credits: 0 });
      }
      console.log("Shop:", shop, "| Credits remaining:", creditCheck.credits);
    }

    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    let garmentImageUrl = req.body.garment_image_url;
    if (garmentImageUrl && garmentImageUrl.startsWith("//")) {
      garmentImageUrl = "https:" + garmentImageUrl;
    }
    const category = req.body.garment_category || req.body.category || "auto";
    if (!req.file) return res.status(400).json({ error: "No model image uploaded" });
    if (!garmentImageUrl) return res.status(400).json({ error: "No garment image URL" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    console.log("Category:", category);
    console.log("Garment URL:", garmentImageUrl);

    if (BACKEND_MODE === "runpod") {
      const outputImage = await submitAndWaitRunPod(dataUri, garmentImageUrl, category);
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      res.json({
        status: "completed",
        output: [outputImage],
        prediction_id: "runpod-direct"
      });
    } else {
      const data = await submitFashn(dataUri, garmentImageUrl, category);
      console.log("FASHN response:", JSON.stringify(data));
      if (data.id) {
        res.json({ prediction_id: data.id });
      } else if (data.error) {
        res.status(500).json({ error: data.error });
      } else {
        res.status(500).json({ error: "No prediction ID returned", details: data });
      }
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    }
  } catch (err) {
    console.error("Generate error:", err);
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tryon/generate-multi", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== MULTI-IMAGE TRY-ON [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    if (!req.file) return res.status(400).json({ error: "No model image uploaded" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    let garmentUrls = [];
    try { garmentUrls = JSON.parse(req.body.garment_image_urls); } catch(e) {}
    let categories = [];
    try { categories = JSON.parse(req.body.categories); } catch(e) {}
    if (!garmentUrls.length) return res.status(400).json({ error: "No garment images provided" });
    console.log("Garment URLs:", garmentUrls.length);
    var results = [];
    for (var i = 0; i < garmentUrls.length; i++) {
      var gUrl = garmentUrls[i];
      if (gUrl.startsWith("//")) gUrl = "https:" + gUrl;
      var cat = categories[i] || "auto";

      if (BACKEND_MODE === "runpod") {
        try {
          const outputImage = await submitAndWaitRunPod(dataUri, gUrl, cat);
          results.push({ status: "completed", output: [outputImage], garment_url: gUrl, category: cat });
        } catch (err) {
          results.push({ error: err.message, garment_url: gUrl, category: cat });
        }
      } else {
        var data = await submitFashn(dataUri, gUrl, cat);
        if (data.id) {
          results.push({ prediction_id: data.id, garment_url: gUrl, category: cat });
        } else {
          results.push({ error: data.error || "Failed", garment_url: gUrl, category: cat });
        }
      }
    }
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    res.json({ results: results });
  } catch (err) {
    console.error("Multi generate error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tryon/generate-chain", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== CHAIN TRY-ON [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    console.log("User IP:", ip, "| Limit:", dailyLimit);

    // === CREDITS CHECK ===
    const shop = getShopFromRequest(req);
    console.log("Shop detected:", shop);
    if (shop) {
      const creditCheck = creditsSystem.checkAndUseCredit(shop, ip);
      if (!creditCheck.allowed) {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        if (creditCheck.reason === "not_found") {
          return res.status(403).json({ error: "החנות לא רשומה במערכת. צרו קשר עם TryFit." });
        }
        return res.status(403).json({ error: "נגמרו הקרדיטים! צרו קשר לחידוש המנוי.", credits: 0 });
      }
      console.log("Shop:", shop, "| Credits remaining:", creditCheck.credits);
    }

    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעתם למגבלה היומית. חזרו מחר!" });
    }
    if (!req.file) return res.status(400).json({ error: "No model image" });
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    const dataUri = "data:" + mimeType + ";base64," + base64Image;
    let garmentUrls = [];
    try { garmentUrls = JSON.parse(req.body.garment_image_urls); } catch(e) {}
    let categories = [];
    try { categories = JSON.parse(req.body.categories); } catch(e) {}
    if (!garmentUrls.length) return res.status(400).json({ error: "No garment images" });
    garmentUrls = garmentUrls.map(u => u.startsWith("//") ? "https:" + u : u);
    console.log("Chain steps:", garmentUrls.length);

    let currentModelImage = dataUri;
    let stepResults = [];
    for (let i = 0; i < garmentUrls.length; i++) {
      const cat = categories[i] || "auto";
      console.log("--- Step", i + 1, "/", garmentUrls.length, "---");
      try {
        const outputUrl = await submitAndWait(currentModelImage, garmentUrls[i], cat);
        stepResults.push({ step: i + 1, output_url: outputUrl, garment_url: garmentUrls[i] });
        currentModelImage = outputUrl;
      } catch (err) {
        console.error("  Step", i + 1, "failed:", err.message);
        stepResults.push({ step: i + 1, error: err.message, garment_url: garmentUrls[i] });
      }
    }
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    const finalOutput = stepResults.filter(r => r.output_url).pop();

    res.json({
      steps: stepResults,
      final_output: finalOutput ? finalOutput.output_url : null,
      total_steps: garmentUrls.length,
      successful_steps: stepResults.filter(r => r.output_url).length
    });
  } catch (err) {
    console.error("Chain error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tryon/status/:id", async (req, res) => {
  try {
    const predictionId = req.params.id;

    if (BACKEND_MODE === "runpod") {
      const response = await fetch(RUNPOD_BASE_URL + "/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + RUNPOD_API_KEY }
      });
      const data = await response.json();
      if (data.status === "COMPLETED") {
        res.json({
          status: "completed",
          output: data.output?.image ? [data.output.image] : []
        });
      } else if (data.status === "FAILED") {
        res.json({ status: "failed", error: data.output?.error || "Failed" });
      } else {
        res.json({ status: "processing" });
      }
    } else {
      const response = await fetch("https://api.fashn.ai/v1/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + process.env.FASHN_API_KEY }
      });
      const data = await response.json();
      res.json(data);
    }
  } catch (err) {
    console.error("Status error:", err);
    res.status(500).json({ error: err.message });
  }
});
// === GDPR COMPLIANCE WEBHOOKS ===
app.post("/webhooks/customers/data_request", (req, res) => {
  console.log("GDPR: Customer data request received");
  res.status(200).json({ message: "No customer data stored" });
});

app.post("/webhooks/customers/redact", (req, res) => {
  console.log("GDPR: Customer redact request received");
  res.status(200).json({ message: "No customer data to redact" });
});

app.post("/webhooks/shop/redact", (req, res) => {
  console.log("GDPR: Shop redact request received");
  res.status(200).json({ message: "Shop data redacted" });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
  console.log("Backend mode:", BACKEND_MODE.toUpperCase());
  if (BACKEND_MODE === "fashn") {
    console.log("FASHN API Key loaded:", process.env.FASHN_API_KEY ? "YES" : "NO");
  } else {
    console.log("RunPod Endpoint:", RUNPOD_ENDPOINT_ID);
  }
  console.log("Credits system: ACTIVE");
  console.log("Admin dashboard: /admin");
});