const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
require("dotenv").config();
const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"]
}));
app.use(express.json());

// ======================
// BACKEND MODE: "fashn" or "runpod"
// Set in .env file: BACKEND_MODE=runpod
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
// === FASHN FUNCTIONS ===

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

// === RUNPOD FUNCTIONS ===

async function submitRunPod(dataUri, garmentUrl, category) {
  // Map "auto" category to "tops" for RunPod (FASHN VTON doesn't support "auto")
  let rpCategory = category;
  if (!rpCategory || rpCategory === "auto") rpCategory = "tops";

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

// === UNIFIED SUBMIT FUNCTIONS ===

async function submitJob(dataUri, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") {
    return await submitRunPod(dataUri, garmentUrl, category);
  } else {
    return await submitFashn(dataUri, garmentUrl, category);
  }
}

async function submitAndWait(modelImage, garmentUrl, category) {
  if (BACKEND_MODE === "runpod") {
    return await submitAndWaitRunPod(modelImage, garmentUrl, category);
  } else {
    return await submitAndWaitFashn(modelImage, garmentUrl, category);
  }
}

// === ROUTES ===

app.post("/api/tryon/generate", upload.single("model_image"), async (req, res) => {
  try {
    console.log("=== NEW TRY-ON REQUEST [" + BACKEND_MODE + "] ===");
    const ip = getRealIP(req);
    const dailyLimit = parseDailyLimit(req.body.daily_limit);
    console.log("User IP:", ip, "| Limit:", dailyLimit);
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעת למגבלה היומית. חזור מחר!" });
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
      // RunPod: submit and wait for result
      const outputImage = await submitAndWaitRunPod(dataUri, garmentImageUrl, category);
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      res.json({
        status: "completed",
        output: [outputImage],
        prediction_id: "runpod-direct"
      });
    } else {
      // FASHN: submit and return prediction_id for polling
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
      return res.status(429).json({ error: "הגעת למגבלה היומית. חזור מחר!" });
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
    if (!checkRateLimit(ip, dailyLimit)) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "הגעת למגבלה היומית. חזור מחר!" });
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
      // RunPod status check
      const response = await fetch(RUNPOD_BASE_URL + "/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + RUNPOD_API_KEY }
      });
      const data = await response.json();
      // Map RunPod status to FASHN-compatible format
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
      // FASHN status check
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
  console.log("Backend mode:", BACKEND_MODE.toUpperCase());
  if (BACKEND_MODE === "fashn") {
    console.log("FASHN API Key loaded:", process.env.FASHN_API_KEY ? "YES" : "NO");
  } else {
    console.log("RunPod Endpoint:", RUNPOD_ENDPOINT_ID);
  }
  console.log("Rate limit: dynamic per store");
});