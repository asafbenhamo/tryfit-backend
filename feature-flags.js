// feature-flags.js - Controls which shops get the data collection features.
//
// A shop is enabled if EITHER:
//   1. It's in the hardcoded list below (770 - always on), OR
//   2. It's a registered store in the DB (advisor_stores), i.e. any shop that
//      connected via OAuth or was added via /admin/add-store.
// This makes every newly-connected store work end-to-end (backfill + daily sync
// + webhooks) without editing this file.

const DATA_COLLECTION_ENABLED_SHOPS = [
  'seven770.myshopify.com'
];

// Lazy require to avoid any load-order issues; shopify-client does not require
// this file back, so there is no circular dependency.
function registeredShops() {
  try {
    const shopify = require('./shopify-client');
    if (typeof shopify.listStores === 'function') {
      return shopify.listStores().map(s => (s.shop_domain || '').toLowerCase().trim());
    }
  } catch (e) { /* during early startup the cache may be empty; fall back */ }
  return [];
}

function isDataCollectionEnabled(shopDomain) {
  if (!shopDomain) return false;
  const d = shopDomain.toLowerCase().trim();
  if (DATA_COLLECTION_ENABLED_SHOPS.includes(d)) return true;
  return registeredShops().includes(d);
}

function getDataCollectionShops() {
  // Union of hardcoded + registered, de-duplicated.
  const set = new Set(DATA_COLLECTION_ENABLED_SHOPS.map(s => s.toLowerCase().trim()));
  for (const d of registeredShops()) set.add(d);
  return [...set];
}

module.exports = {
  isDataCollectionEnabled,
  getDataCollectionShops,
  DATA_COLLECTION_ENABLED_SHOPS
};