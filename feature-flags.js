// feature-flags.js - Controls which shops get the new data collection features

const DATA_COLLECTION_ENABLED_SHOPS = [
  'seven770.myshopify.com'
];

function isDataCollectionEnabled(shopDomain) {
  if (!shopDomain) return false;
  return DATA_COLLECTION_ENABLED_SHOPS.includes(shopDomain.toLowerCase().trim());
}

function getDataCollectionShops() {
  return [...DATA_COLLECTION_ENABLED_SHOPS];
}

module.exports = {
  isDataCollectionEnabled,
  getDataCollectionShops,
  DATA_COLLECTION_ENABLED_SHOPS
};