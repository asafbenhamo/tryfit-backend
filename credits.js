const fs = require("fs");
const path = require("path");

const DB_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "credits.json") : path.join(__dirname, "credits.json");

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch(e) {}
  return { stores: {}, usage: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function checkAndUseCredit(shop, ip) {
  const db = loadDB();
  if (!db.stores[shop]) {
    db.stores[shop] = { credits: 15, plan: "free-trial", total_used: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    saveDB(db);
  }
  const store = db.stores[shop];
  if (store.credits <= 0) return { allowed: false, reason: "no_credits", credits: 0 };
  store.credits--;
  store.total_used = (store.total_used || 0) + 1;
  store.updated_at = new Date().toISOString();
  db.usage.push({ shop, ip, time: new Date().toISOString() });
  if (db.usage.length > 10000) db.usage = db.usage.slice(-5000);
  saveDB(db);
  return { allowed: true, credits: store.credits };
}

function createStore(shop, credits, plan) {
  const db = loadDB();
  if (db.stores[shop]) {
    db.stores[shop].credits += credits;
    db.stores[shop].plan = plan;
    db.stores[shop].updated_at = new Date().toISOString();
  } else {
    db.stores[shop] = { credits, plan, total_used: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  }
  saveDB(db);
  return { message: shop + " — " + db.stores[shop].credits + " credits" };
}

function removeStore(shop) {
  const db = loadDB();
  delete db.stores[shop];
  saveDB(db);
  return { message: shop + " removed" };
}

function addCreditsToStore(shop, amount, reason) {
  const db = loadDB();
  if (!db.stores[shop]) return { error: "Store not found" };
  db.stores[shop].credits += amount;
  db.stores[shop].updated_at = new Date().toISOString();
  saveDB(db);
  return { message: shop + " now has " + db.stores[shop].credits + " credits" };
}

function setCreditsForStore(shop, amount, reason) {
  const db = loadDB();
  if (!db.stores[shop]) return { error: "Store not found" };
  db.stores[shop].credits = amount;
  db.stores[shop].updated_at = new Date().toISOString();
  saveDB(db);
  return { message: shop + " set to " + amount + " credits" };
}

function listStores() {
  const db = loadDB();
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return Object.entries(db.stores).map(([shop, s]) => {
    const usage_30d = db.usage.filter(u => u.shop === shop && (now - new Date(u.time).getTime()) < thirtyDays).length;
    return { shop, ...s, usage_30d };
  }).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function getStoreCredits(shop) {
  const db = loadDB();
  const store = db.stores[shop];
  if (!store) return { credits: 0, active: false };
  return { credits: store.credits, active: store.credits > 0, plan: store.plan };
}

module.exports = { checkAndUseCredit, createStore, removeStore, addCreditsToStore, setCreditsForStore, listStores, getStoreCredits };