const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "credits.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    shop TEXT PRIMARY KEY,
    credits INTEGER DEFAULT 0,
    total_used INTEGER DEFAULT 0,
    plan TEXT DEFAULT 'none',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS credit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const getStore = db.prepare("SELECT * FROM stores WHERE shop = ?");
const addCredits = db.prepare("UPDATE stores SET credits = credits + ?, updated_at = datetime('now') WHERE shop = ?");
const setCredits = db.prepare("UPDATE stores SET credits = ?, updated_at = datetime('now') WHERE shop = ?");
const useCredit = db.prepare("UPDATE stores SET credits = credits - 1, total_used = total_used + 1, updated_at = datetime('now') WHERE shop = ? AND credits > 0");
const logUsage = db.prepare("INSERT INTO usage_log (shop, ip) VALUES (?, ?)");
const logCredit = db.prepare("INSERT INTO credit_log (shop, amount, reason) VALUES (?, ?, ?)");
const getAllStores = db.prepare("SELECT * FROM stores ORDER BY updated_at DESC");
const getUsage30d = db.prepare("SELECT COUNT(*) as count FROM usage_log WHERE shop = ? AND created_at > datetime('now', '-30 days')");

function checkAndUseCredit(shop, ip) {
  const store = getStore.get(shop);
  if (!store) return { allowed: false, reason: "not_found", credits: 0 };
  if (store.credits <= 0) return { allowed: false, reason: "no_credits", credits: 0 };
  const result = useCredit.run(shop);
  if (result.changes === 0) return { allowed: false, reason: "no_credits", credits: 0 };
  logUsage.run(shop, ip);
  return { allowed: true, credits: store.credits - 1 };
}

function createStore(shop, credits, plan) {
  const existing = getStore.get(shop);
  if (existing) {
    addCredits.run(credits, shop);
    db.prepare("UPDATE stores SET plan = ?, updated_at = datetime('now') WHERE shop = ?").run(plan, shop);
    logCredit.run(shop, credits, "Admin add");
    return { message: shop + " +" + credits + " credits" };
  }
  db.prepare("INSERT INTO stores (shop, credits, plan) VALUES (?, ?, ?)").run(shop, credits, plan);
  logCredit.run(shop, credits, "New store");
  return { message: shop + " created with " + credits + " credits" };
}

function removeStore(shop) {
  db.prepare("DELETE FROM stores WHERE shop = ?").run(shop);
  return { message: shop + " removed" };
}

function addCreditsToStore(shop, amount, reason) {
  const store = getStore.get(shop);
  if (!store) return { error: "Store not found" };
  addCredits.run(amount, shop);
  logCredit.run(shop, amount, reason || "Admin top-up");
  const updated = getStore.get(shop);
  return { message: shop + " now has " + updated.credits + " credits" };
}

function setCreditsForStore(shop, amount, reason) {
  const store = getStore.get(shop);
  if (!store) return { error: "Store not found" };
  setCredits.run(amount, shop);
  logCredit.run(shop, amount - store.credits, reason || "Admin set");
  return { message: shop + " set to " + amount + " credits" };
}

function listStores() {
  const stores = getAllStores.all();
  stores.forEach(s => { s.usage_30d = getUsage30d.get(s.shop).count; });
  return stores;
}

function getStoreCredits(shop) {
  const store = getStore.get(shop);
  if (!store) return { credits: 0, active: false };
  return { credits: store.credits, active: store.credits > 0, plan: store.plan };
}

module.exports = { checkAndUseCredit, createStore, removeStore, addCreditsToStore, setCreditsForStore, listStores, getStoreCredits };