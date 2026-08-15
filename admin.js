const express = require("express");
const router = express.Router();
const path = require("path");
const credits = require("./credits");

// No hardcoded fallback — see server-dual.js.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

function adminAuth(req, res, next) {
  // Fail closed when there is no password configured. This compared against
  // "Bearer " + ADMIN_PASSWORD with no null check, so on a deployment where the
  // variable was unset the literal header "Bearer null" authenticated as admin.
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Admin access is not configured" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  // Timing-safe, like every other credential comparison in this codebase.
  let okAuth = false;
  try { okAuth = require("./session-auth").safeEqual(auth.slice(7), ADMIN_PASSWORD); }
  catch (e) { okAuth = false; }
  if (!okAuth) return res.status(401).json({ error: "Unauthorized" });
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
// exportDB/importDB were never implemented — credits.js exports neither, so both
// of these threw a TypeError on every call. Answering honestly beats a 500.
router.get("/api/export", adminAuth, (req, res) => {
  if (typeof credits.exportDB !== "function") {
    return res.status(501).json({ error: "Export is not implemented" });
  }
  res.json({ data: credits.exportDB() });
});

router.post("/api/import", adminAuth, (req, res) => {
  if (typeof credits.importDB !== "function") {
    return res.status(501).json({ error: "Import is not implemented" });
  }
  res.json(credits.importDB(req.body && req.body.data));
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

module.exports = router;