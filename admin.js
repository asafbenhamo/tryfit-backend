const express = require("express");
const router = express.Router();
const path = require("path");
const credits = require("./credits");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tryfit2026";

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.get("/api/stores", adminAuth, (req, res) => {
  res.json({ stores: credits.listStores() });
});

router.post("/api/stores", adminAuth, (req, res) => {
  const { shop, credits: c, plan } = req.body;
  if (!shop) return res.status(400).json({ error: "Shop required" });
  res.json(credits.createStore(shop, c || 0, plan || "none"));
});

router.delete("/api/stores/:shop", adminAuth, (req, res) => {
  res.json(credits.removeStore(req.params.shop));
});

router.post("/api/credits/add", adminAuth, (req, res) => {
  const { shop, amount, reason } = req.body;
  if (!shop || !amount) return res.status(400).json({ error: "Shop and amount required" });
  res.json(credits.addCreditsToStore(shop, amount, reason));
});

router.post("/api/credits/set", adminAuth, (req, res) => {
  const { shop, credits: c, reason } = req.body;
  if (!shop) return res.status(400).json({ error: "Shop required" });
  res.json(credits.setCreditsForStore(shop, c, reason));
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

module.exports = router;