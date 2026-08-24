// shopify-client.js - Shopify Admin API client for data platform
// Used to fetch customer and order data when a customer uses TryFit with consent.
// Only operates for shops that have a configured token (currently only seven770).

const db = require('./database');
const vault = require('./crypto-vault');

const SHOPIFY_API_VERSION = '2026-01';

// Map shop domain -> environment variable name for its token.
// 770 stays here as an env-based token (unchanged). Any NEW store is added to
// the database (advisor_stores) and loaded into the cache below — so we never
// have to touch env or code to onboard a new shop.
const SHOP_TOKEN_MAP = {
  'seven770.myshopify.com': 'SHOPIFY_770_TOKEN'
};

// In-memory cache of DB-backed stores: shop_domain -> { token, password, name, public_domain, active }
// getTokenForShop stays SYNCHRONOUS (many call sites depend on that), so we read
// from this cache, which is refreshed from the DB at startup and after changes.
const storeCache = new Map();

// Create the advisor_stores table if missing. Safe to call repeatedly.
async function ensureStoreTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS advisor_stores (
        shop_domain   TEXT PRIMARY KEY,
        access_token  TEXT NOT NULL,
        advisor_password TEXT,
        display_name  TEXT,
        public_domain TEXT,
        active        BOOLEAN DEFAULT TRUE,
        terms_accepted_at TIMESTAMPTZ,
        d360_api_key  TEXT,
        wa_language   TEXT DEFAULT 'he',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // For tables created before these columns existed.
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS d360_api_key TEXT`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS wa_language TEXT DEFAULT 'he'`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS logo_url TEXT`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS owner_email TEXT`).catch(()=>{});
    // Expiring offline access tokens. Shopify stopped accepting the permanent
    // kind this app was built on; see shopify-tokens.js.
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS refresh_token TEXT`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`).catch(()=>{});
    await db.query(`ALTER TABLE advisor_stores ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ`).catch(()=>{});
  } catch (err) {
    console.error('⚠️  [stores] ensureStoreTable failed:', err.message);
  }
}

// Load all DB-backed stores into the in-memory cache.
async function loadStores() {
  try {
    await ensureStoreTable();
    const r = await db.query(`SELECT shop_domain, access_token, advisor_password, display_name, public_domain, active, terms_accepted_at, d360_api_key, wa_language, logo_url, owner_email, refresh_token, access_expires_at, refresh_expires_at FROM advisor_stores WHERE active = TRUE`);
    storeCache.clear();
    for (const row of r.rows) {
      storeCache.set(row.shop_domain.toLowerCase().trim(), {
        // Decrypted here, at the single place the cache is filled, so every
        // caller downstream keeps working unchanged. Rows written before
        // encryption was enabled pass through untouched.
        token: vault.decrypt(row.access_token),
        password: vault.decrypt(row.advisor_password),
        name: row.display_name,
        public_domain: row.public_domain,
        active: row.active,
        terms_accepted_at: row.terms_accepted_at,
        d360_api_key: vault.decrypt(row.d360_api_key),
        wa_language: row.wa_language || 'he',
        logo_url: row.logo_url || null,
        owner_email: row.owner_email || null,
        refresh_token: vault.decrypt(row.refresh_token),
        access_expires_at: row.access_expires_at || null,
        refresh_expires_at: row.refresh_expires_at || null
      });
    }
    console.log(`🏪 [stores] loaded ${storeCache.size} store(s) from DB`);
    return storeCache.size;
  } catch (err) {
    console.error('⚠️  [stores] loadStores failed:', err.message);
    return 0;
  }
}

// Seal any credential still sitting in plaintext. Runs once at boot and is a
// no-op afterwards, so enabling encryption on a live deployment needs no
// downtime and no flag day: reads already tolerate both forms.
async function migrateSecretsToVault() {
  if (!vault.isEnabled()) return { ok: false, skipped: 'no_key' };
  await ensureStoreTable();
  let sealed = 0;
  try {
    const r = await db.query(`SELECT shop_domain, access_token, advisor_password, d360_api_key FROM advisor_stores`);
    for (const row of r.rows) {
      const patch = {};
      if (row.access_token && !vault.isEncrypted(row.access_token)) patch.access_token = vault.encrypt(row.access_token);
      if (row.advisor_password && !vault.isEncrypted(row.advisor_password)) patch.advisor_password = vault.encrypt(row.advisor_password);
      if (row.d360_api_key && !vault.isEncrypted(row.d360_api_key)) patch.d360_api_key = vault.encrypt(row.d360_api_key);
      if (!Object.keys(patch).length) continue;
      await db.query(
        `UPDATE advisor_stores
            SET access_token = COALESCE($2, access_token),
                advisor_password = COALESCE($3, advisor_password),
                d360_api_key = COALESCE($4, d360_api_key)
          WHERE shop_domain = $1`,
        [row.shop_domain, patch.access_token || null, patch.advisor_password || null, patch.d360_api_key || null]
      );
      sealed++;
    }
    if (sealed) console.log(`🔐 [vault] encrypted credentials for ${sealed} store(s)`);
    return { ok: true, sealed };
  } catch (e) {
    console.error('[vault] migration failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Called when Shopify tells us the app was uninstalled.
//
// The uninstall handler used to invoke this through an `&&` guard, and the
// function did not exist — so it silently did nothing and the store's access
// token stayed valid and cached indefinitely. Shopify revokes the token at
// their end, but holding a credential for a merchant who has removed the app
// is exactly what "delete data on uninstall" is meant to prevent, and the
// scheduler kept treating the shop as live.
//
// The row is kept (marked inactive, token cleared) so that shop/redact, which
// arrives 48 hours later, can still find the shop and finish the deletion.
async function deactivateStore(shopDomain) {
  const domain = (shopDomain || '').toLowerCase().trim();
  if (!domain) return { ok: false, error: 'no_shop' };
  await ensureStoreTable();
  try {
    await db.query(
      `UPDATE advisor_stores
          SET active = FALSE, access_token = '', d360_api_key = NULL
        WHERE shop_domain = $1`, [domain]);
    storeCache.delete(domain);
    console.log(`🔌 [stores] ${domain} deactivated, token cleared`);
    return { ok: true };
  } catch (e) {
    console.error('[stores] deactivateStore:', e.message);
    return { ok: false, error: e.message };
  }
}

// Remove every trace of a shop. Called by the shop/redact GDPR webhook.
async function purgeStore(shopDomain) {
  const domain = (shopDomain || '').toLowerCase().trim();
  if (!domain) return { ok: false, error: 'no_shop' };
  try {
    await db.query(`DELETE FROM advisor_stores WHERE shop_domain = $1`, [domain]);
    storeCache.delete(domain);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Add or update a store, then refresh the cache.
// Every row in the data-platform tables — store_customers, store_orders, and
// the rest — carries a foreign key to shops(shop_domain). That table is left
// over from the platform this app grew out of, and NOTHING in this codebase has
// ever written to it: the rows in it were put there by hand for the pilot store.
//
// So for every shop that has installed since, the entire backfill inserted
// nothing. Twenty customers fetched, twenty foreign-key violations, and then
// "COMPLETE  Customers: 0/20" — a merchant whose agent reports zero customers
// forever, with the reason visible only in a server log they never see.
//
// The access token is deliberately NOT written here. shops.shopify_access_token
// is plaintext by the old schema's design; tokens live encrypted in
// advisor_stores and stay there.
async function ensureShopRow(shopDomain, displayName = null) {
  const domain = String(shopDomain || '').toLowerCase().trim();
  if (!domain) return false;
  try {
    await db.query(
      `INSERT INTO shops (shop_domain, display_name, installed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (shop_domain) DO NOTHING`,
      [domain, displayName]
    );
    return true;
  } catch (e) {
    console.error(`❌ [DB] ensureShopRow failed for ${domain}: ${e.message}`);
    return false;
  }
}

async function upsertStore({ shop_domain, access_token, advisor_password, display_name, public_domain }) {
  const domain = shop_domain.toLowerCase().trim();
  await ensureStoreTable();
  // Before anything else: without this row every customer and order we later
  // pull for this shop is rejected by the foreign key.
  await ensureShopRow(domain, display_name);
  await db.query(
    `INSERT INTO advisor_stores (shop_domain, access_token, advisor_password, display_name, public_domain, active)
     VALUES ($1,$2,$3,$4,$5,TRUE)
     ON CONFLICT (shop_domain) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       advisor_password = COALESCE(EXCLUDED.advisor_password, advisor_stores.advisor_password),
       display_name = COALESCE(EXCLUDED.display_name, advisor_stores.display_name),
       public_domain = COALESCE(EXCLUDED.public_domain, advisor_stores.public_domain),
       active = TRUE`,
    [domain, vault.encrypt(access_token), vault.encrypt(advisor_password || null), display_name || null, public_domain || null]
  );
  await loadStores();
  return { ok: true, shop_domain: domain };
}

// Set a store's 360dialog WhatsApp API key (and optional template language).
async function setWhatsAppConfig(shopDomain, { d360_api_key, wa_language }) {
  const domain = (shopDomain || '').toLowerCase().trim();
  await ensureStoreTable();
  await db.query(
    `UPDATE advisor_stores
     SET d360_api_key = COALESCE($2, d360_api_key),
         wa_language  = COALESCE($3, wa_language)
     WHERE shop_domain = $1`,
    [domain, vault.encrypt(d360_api_key || null), wa_language || null]
  );
  await loadStores();
  return { ok: true };
}

// Update a store's owner email (receives sample copies of campaign emails).
async function setOwnerEmail(shopDomain, ownerEmail) {
  const domain = (shopDomain || '').toLowerCase().trim();
  await ensureStoreTable();
  const r = await db.query(
    `UPDATE advisor_stores SET owner_email = $2 WHERE shop_domain = $1`,
    [domain, ownerEmail || null]
  );
  await loadStores();
  return { ok: r.rowCount > 0, updated: r.rowCount };
}

// Update a store's logo URL (used for the PWA home-screen icon).
async function setStoreLogo(shopDomain, logoUrl) {
  const domain = (shopDomain || '').toLowerCase().trim();
  await ensureStoreTable();
  const r = await db.query(
    `UPDATE advisor_stores SET logo_url = $2 WHERE shop_domain = $1`,
    [domain, logoUrl || null]
  );
  await loadStores();
  return { ok: r.rowCount > 0, updated: r.rowCount };
}

// Update a store's advisor login password.
async function setAdvisorPassword(shopDomain, newPassword) {
  const domain = (shopDomain || '').toLowerCase().trim();
  if (!newPassword) return { ok: false, error: 'missing password' };
  await ensureStoreTable();
  const r = await db.query(
    `UPDATE advisor_stores SET advisor_password = $2 WHERE shop_domain = $1`,
    [domain, vault.encrypt(newPassword)]
  );
  await loadStores();
  return { ok: r.rowCount > 0, updated: r.rowCount };
}

// Get a store's WhatsApp config (api key + language), or null.
function getWhatsAppConfig(shopDomain) {
  const s = getStore(shopDomain);
  if (!s) return null;
  return { d360_api_key: s.d360_api_key || null, wa_language: s.wa_language || 'he' };
}

// Public storefront domain for a shop (for building customer-facing links).
// Reads public_domain from the store registry; 770 (env-based) falls back to its
// known domain. Always returns a full https:// URL with no trailing slash.
function getPublicDomain(shopDomain) {
  const d = (shopDomain || '').toLowerCase().trim();
  if (d === 'seven770.myshopify.com') return 'https://sevenseventy.co.il';
  const s = getStore(d);
  let pub = (s && s.public_domain) ? String(s.public_domain).trim() : '';
  if (!pub) return `https://${d}`; // fallback: the myshopify domain itself works
  if (!/^https?:\/\//i.test(pub)) pub = 'https://' + pub;
  return pub.replace(/\/+$/, '');
}

// Return the store config (from DB cache) for a domain, or null.
function getStore(shopDomain) {
  if (!shopDomain) return null;
  return storeCache.get(shopDomain.toLowerCase().trim()) || null;
}

// Has this store accepted the terms of service? 770 (env) is treated as accepted.
function hasAcceptedTerms(shopDomain) {
  const domain = (shopDomain || '').toLowerCase().trim();
  if (SHOP_TOKEN_MAP[domain]) return true; // 770 / env stores: implicitly accepted
  const s = storeCache.get(domain);
  return !!(s && s.terms_accepted_at);
}

// Record that a store accepted the terms (idempotent).
async function acceptTerms(shopDomain) {
  const domain = (shopDomain || '').toLowerCase().trim();
  if (SHOP_TOKEN_MAP[domain]) return { ok: true, already: true }; // 770: nothing to store
  await db.query(
    `UPDATE advisor_stores SET terms_accepted_at = NOW() WHERE shop_domain = $1 AND terms_accepted_at IS NULL`,
    [domain]
  );
  await loadStores();
  return { ok: true };
}

// List all known stores (env-based 770 + DB-backed), for admin/onboarding views.
function listStores() {
  const out = [];
  for (const [domain, envVar] of Object.entries(SHOP_TOKEN_MAP)) {
    if (process.env[envVar]) out.push({ shop_domain: domain, source: 'env' });
  }
  for (const [domain, cfg] of storeCache.entries()) {
    if (!SHOP_TOKEN_MAP[domain]) out.push({ shop_domain: domain, source: 'db', name: cfg.name });
  }
  return out;
}

/**
 * Get the access token for a specific shop.
 * Resolution order: env map (770) first, then the DB-backed store cache.
 * Returns null if no token is configured for this shop.
 */
function getTokenForShop(shopDomain) {
  if (!shopDomain) return null;
  const normalized = shopDomain.toLowerCase().trim();
  // 1. env-based (770) — unchanged behavior
  const envVar = SHOP_TOKEN_MAP[normalized];
  if (envVar && process.env[envVar]) return process.env[envVar];
  // 2. DB-backed stores (new shops)
  const store = storeCache.get(normalized);
  if (store && store.token) return store.token;
  return null;
}

/**
 * Check if we have a working token for a shop
 */
function hasTokenForShop(shopDomain) {
  return getTokenForShop(shopDomain) !== null;
}

// ---------------------------------------------------------------------------
// EXPIRING TOKENS
//
// Shopify now rejects the permanent tokens this app was built on. Access tokens
// live an hour; a refresh token (90 days, renewed on every use) buys a new pair
// without the merchant present, which is what keeps the unattended work — the
// morning run, the attribution scan, the billing sweep — possible at all.
//
// getTokenForShop stays synchronous because a dozen call sites and
// hasTokenForShop depend on it. Everything that actually CALLS Shopify goes
// through getFreshToken instead, which refreshes first when the token is close
// to expiry.
// ---------------------------------------------------------------------------
const shopifyTokens = require('./shopify-tokens');

// Shops whose legacy-token upgrade was already attempted this process. See the
// legacy branch in getFreshToken for why a failure must not be retried per call.
const legacyUpgradeTried = new Set();

async function getFreshToken(shopDomain) {
  const shop = (shopDomain || '').toLowerCase().trim();
  if (!shop) return null;

  // The pilot store's env token is managed outside this table.
  const envVar = SHOP_TOKEN_MAP[shop];
  if (envVar && process.env[envVar]) return process.env[envVar];

  const store = storeCache.get(shop);
  if (!store || !store.token) return null;

  // A legacy non-expiring token: upgrade it IN PLACE, the first time it is
  // used. For a store installed on the NEW app this is not optional — Shopify
  // rejects its legacy token outright, so without the upgrade every call 403s
  // until someone reinstalls by hand. Exactly that happened with the first
  // demo store: install completed, token stored, and the app was blind.
  //
  // One attempt per shop per process. A store whose token belongs to the OLD
  // app fails this exchange (the token was issued to different credentials) —
  // that is expected, it falls back to its legacy token, which pre-cutoff apps
  // may still use. Retrying that on every call would hammer Shopify for a
  // failure that cannot change until the store moves to the new app.
  if (!store.refresh_token || !store.access_expires_at) {
    if (legacyUpgradeTried.has(shop)) return store.token;
    return shopifyTokens.once(shop, async () => {
      legacyUpgradeTried.add(shop);
      const up = await upgradeShopToken(shop);
      const fresh = storeCache.get(shop);
      return (up.ok && fresh && fresh.token) ? fresh.token : store.token;
    });
  }

  if (!shopifyTokens.isExpired(store.access_expires_at)) return store.token;

  if (shopifyTokens.needsReconnect(store)) {
    console.error(`[tokens] ${shop}: refresh token has expired — the merchant must reconnect`);
    return null;
  }

  // One refresh per shop, however many callers noticed at once.
  return shopifyTokens.once(shop, async () => {
    try {
      const fresh = await shopifyTokens.refresh(shop, {
        refreshToken: store.refresh_token,
        clientId: appClientId(),
        clientSecret: appClientSecret()
      });
      await saveTokens(shop, fresh);
      console.log(`[tokens] ${shop}: access token refreshed`);
      return fresh.access_token;
    } catch (e) {
      if (e.needsReconnect) {
        console.error(`[tokens] ${shop}: refresh rejected — the merchant must reconnect. ${e.message}`);
        // Clear the deadline so we stop hammering Shopify on every request.
        await db.query(
          `UPDATE advisor_stores SET refresh_expires_at = NOW() WHERE shop_domain = $1`, [shop]
        ).catch(() => {});
        await loadStores();
        return null;
      }
      console.error(`[tokens] ${shop}: refresh failed, using the existing token — ${e.message}`);
      return store.token;   // transient; the call may still work
    }
  });
}

// The app's own credentials. Read the same names the server resolves, so a
// migration to a new Shopify app does not leave this module on the old one.
function appClientId() {
  for (const n of ['ADVISOR_SHOPIFY_KEY2', 'ADVISOR_SHOPIFY_KEY', 'SHOPIFY_API_KEY']) {
    if ((process.env[n] || '').trim()) return process.env[n].trim();
  }
  return null;
}
function appClientSecret() {
  for (const n of ['SHOPIFY_API_SECRET2', 'ADVISOR_SHOPIFY_SECRET2', 'SHOPIFY_API_SECRET', 'ADVISOR_SHOPIFY_SECRET']) {
    if ((process.env[n] || '').trim()) return process.env[n].trim();
  }
  return null;
}

// Persist a token pair. Encrypted, like every other credential here.
async function saveTokens(shopDomain, t) {
  const shop = (shopDomain || '').toLowerCase().trim();
  await db.query(
    `UPDATE advisor_stores
        SET access_token = $2, refresh_token = $3,
            access_expires_at = $4, refresh_expires_at = $5
      WHERE shop_domain = $1`,
    [shop, vault.encrypt(t.access_token), vault.encrypt(t.refresh_token || null),
     t.access_expires_at, t.refresh_expires_at]
  );
  await loadStores();
  return { ok: true };
}

// Convert a shop still holding a permanent token into an expiring pair, with no
// merchant involvement. Shopify requires every public app to have done this by
// 1 January 2027; doing it lazily means a store keeps working right up until it
// is first touched after the change ships.
async function upgradeShopToken(shopDomain) {
  const shop = (shopDomain || '').toLowerCase().trim();
  const store = storeCache.get(shop);
  if (!store || !store.token) return { ok: false, error: 'no_token' };
  if (store.refresh_token) return { ok: true, already: true };
  try {
    const fresh = await shopifyTokens.upgradeLegacyToken(shop, {
      legacyToken: store.token,
      clientId: appClientId(),
      clientSecret: appClientSecret()
    });
    await saveTokens(shop, fresh);
    console.log(`[tokens] ${shop}: upgraded to an expiring token`);
    return { ok: true, upgraded: true };
  } catch (e) {
    console.error(`[tokens] ${shop}: upgrade failed — ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Generic Shopify Admin API GET request.
 * Handles rate limiting, retries, and pagination.
 */
async function shopifyGet(shopDomain, endpoint, retries = 3) {
  const token = await getFreshToken(shopDomain);
  if (!token) {
    throw new Error(`No token configured for shop: ${shopDomain}`);
  }

  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '2');
        console.log(`⏳ [Shopify] Rate limited, waiting ${retryAfter}s...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API ${response.status}: ${errorText.substring(0, 200)}`);
      }

      return await response.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`⚠️  [Shopify] Attempt ${attempt} failed: ${err.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/**
 * Find a customer by email address.
 * Returns the customer object or null if not found.
 */
async function findCustomerByEmail(shopDomain, email) {
  if (!email) return null;

  try {
    const query = encodeURIComponent(`email:${email}`);
    const data = await shopifyGet(shopDomain, `customers/search.json?query=${query}`);

    if (data.customers && data.customers.length > 0) {
      return data.customers[0];
    }
    return null;
  } catch (err) {
    console.error(`❌ [Shopify] findCustomerByEmail failed for ${email}:`, err.message);
    return null;
  }
}

/**
 * Find a customer by phone number.
 */
async function findCustomerByPhone(shopDomain, phone) {
  if (!phone) return null;

  try {
    const query = encodeURIComponent(`phone:${phone}`);
    const data = await shopifyGet(shopDomain, `customers/search.json?query=${query}`);

    if (data.customers && data.customers.length > 0) {
      return data.customers[0];
    }
    return null;
  } catch (err) {
    console.error(`❌ [Shopify] findCustomerByPhone failed:`, err.message);
    return null;
  }
}

/**
 * Get a customer by Shopify ID with full details.
 */
async function getCustomerById(shopDomain, customerId) {
  try {
    const data = await shopifyGet(shopDomain, `customers/${customerId}.json`);
    return data.customer || null;
  } catch (err) {
    console.error(`❌ [Shopify] getCustomerById failed for ${customerId}:`, err.message);
    return null;
  }
}

/**
 * Get all orders for a specific customer.
 * Note: Shopify limits this to last 60 days by default unless read_all_orders scope is granted.
 */
async function getCustomerOrders(shopDomain, customerId, limit = 250) {
  try {
    const data = await shopifyGet(
      shopDomain,
      `customers/${customerId}/orders.json?status=any&limit=${limit}`
    );
    return data.orders || [];
  } catch (err) {
    console.error(`❌ [Shopify] getCustomerOrders failed for ${customerId}:`, err.message);
    return [];
  }
}

// Return a clean primary phone ONLY. We deliberately do NOT fall back to the
// shipping/default address phone, because that is often the RECIPIENT's number
// (a gift, a different address, an old number) - sending a marketing message
// there reaches the wrong person. Better to have no phone (skip / email later)
// than a wrong one. Returns a normalized number or null.
function cleanPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9+]/g, '');
  // Normalize +972 / 972 to local 0-prefixed form for validation.
  if (p.startsWith('+972')) p = '0' + p.slice(4);
  else if (p.startsWith('972')) p = '0' + p.slice(3);
  // Israeli mobile: 05X + 7 digits = 10 digits starting with 05.
  if (/^05\d{8}$/.test(p)) return p;
  return null; // not a clean mobile -> treat as no phone
}

// Compute the customer's last order date from the orders Shopify returns on the
// customer object. Shopify does NOT provide a `last_order_date` field, so the
// old code always saved null. We derive it from last_order_id presence + the
// orders sync (server refreshes it from store_orders too).
function deriveLastOrderDate(shopifyCustomer) {
  // If Shopify gives us a structured last order, use its created_at.
  if (shopifyCustomer.last_order && shopifyCustomer.last_order.created_at) {
    return shopifyCustomer.last_order.created_at;
  }
  // Otherwise null here; the scheduled sync in server-dual.js fills it from
  // store_orders (MAX(ordered_at) per customer).
  return null;
}

/**
 * Save a Shopify customer to our store_customers table (Tier 1 - all customers).
 * Returns the database row ID.
 */
async function saveStoreCustomer(shopDomain, shopifyCustomer) {
  if (!shopifyCustomer || !shopifyCustomer.id) return null;

  try {
    const result = await db.query(`
      INSERT INTO store_customers (
        shop_domain, shopify_customer_id, email, first_name, last_name,
        phone, city, province, country, shopify_created_at, shopify_updated_at,
        total_spent, orders_count, last_order_date, shopify_tags,
        marketing_consent, marketing_consent_updated_at, raw_data, last_synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
      )
      ON CONFLICT (shop_domain, shopify_customer_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        phone = EXCLUDED.phone,
        city = EXCLUDED.city,
        province = EXCLUDED.province,
        country = EXCLUDED.country,
        shopify_updated_at = EXCLUDED.shopify_updated_at,
        total_spent = EXCLUDED.total_spent,
        orders_count = EXCLUDED.orders_count,
        last_order_date = EXCLUDED.last_order_date,
        shopify_tags = EXCLUDED.shopify_tags,
        marketing_consent = EXCLUDED.marketing_consent,
        marketing_consent_updated_at = EXCLUDED.marketing_consent_updated_at,
        raw_data = EXCLUDED.raw_data,
        last_synced_at = NOW()
      RETURNING id
    `, [
      shopDomain,
      shopifyCustomer.id,
      shopifyCustomer.email || null,
      shopifyCustomer.first_name || null,
      shopifyCustomer.last_name || null,
      cleanPhone(shopifyCustomer.phone || shopifyCustomer.default_address?.phone),
      shopifyCustomer.default_address?.city || null,
      shopifyCustomer.default_address?.province || null,
      shopifyCustomer.default_address?.country || null,
      shopifyCustomer.created_at || null,
      shopifyCustomer.updated_at || null,
      parseFloat(shopifyCustomer.total_spent || '0'),
      shopifyCustomer.orders_count || 0,
      deriveLastOrderDate(shopifyCustomer),
      (shopifyCustomer.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      shopifyCustomer.accepts_marketing || false,
      shopifyCustomer.accepts_marketing_updated_at || null,
      JSON.stringify(shopifyCustomer)
    ]);

    return result.rows[0]?.id || null;
  } catch (err) {
    console.error(`❌ [DB] saveStoreCustomer failed:`, err.message);
    return null;
  }
}

/**
 * Save a Shopify order with all its line items.
 */
async function saveStoreOrder(shopDomain, shopifyOrder) {
  if (!shopifyOrder || !shopifyOrder.id) return null;

  try {
    // Save the order
    await db.query(`
      INSERT INTO store_orders (
        shop_domain, shopify_order_id, shopify_customer_id, order_number,
        total_price, subtotal_price, total_discounts, currency,
        financial_status, fulfillment_status, discount_codes, source_name,
        ordered_at, raw_data, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
      )
      ON CONFLICT (shop_domain, shopify_order_id)
      DO UPDATE SET
        total_price = EXCLUDED.total_price,
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
    `, [
      shopDomain,
      shopifyOrder.id,
      shopifyOrder.customer?.id || null,
      shopifyOrder.order_number?.toString() || shopifyOrder.name || null,
      parseFloat(shopifyOrder.total_price || '0'),
      parseFloat(shopifyOrder.subtotal_price || '0'),
      parseFloat(shopifyOrder.total_discounts || '0'),
      shopifyOrder.currency || null,
      shopifyOrder.financial_status || null,
      shopifyOrder.fulfillment_status || null,
      (shopifyOrder.discount_codes || []).map(d => d.code).filter(Boolean),
      shopifyOrder.source_name || null,
      shopifyOrder.created_at || null,
      JSON.stringify(shopifyOrder)
    ]);

    // Save line items
    if (shopifyOrder.line_items && Array.isArray(shopifyOrder.line_items)) {
      // First delete existing items for this order (in case of update)
      await db.query(
        `DELETE FROM store_order_items WHERE shop_domain = $1 AND shopify_order_id = $2`,
        [shopDomain, shopifyOrder.id]
      );

      // Then insert all items
      for (const item of shopifyOrder.line_items) {
        await db.query(`
          INSERT INTO store_order_items (
            shop_domain, shopify_order_id, shopify_product_id, shopify_variant_id,
            title, variant_title, vendor, product_type, quantity, price,
            total_discount, sku, tags, raw_data
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          shopDomain,
          shopifyOrder.id,
          item.product_id || null,
          item.variant_id || null,
          item.title || null,
          item.variant_title || null,
          item.vendor || null,
          item.product_type || null,
          item.quantity || 1,
          parseFloat(item.price || '0'),
          parseFloat(item.total_discount || '0'),
          item.sku || null,
          [],
          JSON.stringify(item)
        ]);
      }
    }

    return shopifyOrder.id;
  } catch (err) {
    console.error(`❌ [DB] saveStoreOrder failed:`, err.message);
    return null;
  }
}

/**
 * Mark a customer as consenting to TryFit data sharing.
 * Creates entry in tryfit_consenting_customers table (Tier 2).
 */
async function addTryFitConsent(shopDomain, params) {
  const {
    storeCustomerId,
    shopifyCustomerId,
    identifier,
    email,
    consentTextVersion = 'v1.0',
    consentText = null,
    ipAddress = null,
    userAgent = null
  } = params;

  try {
    const result = await db.query(`
      INSERT INTO tryfit_consenting_customers (
        shop_domain, shopify_customer_id, store_customer_id, 
        identifier, email, first_consent_at, latest_consent_at, consent_active
      ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), TRUE)
      ON CONFLICT (shop_domain, identifier)
      DO UPDATE SET
        shopify_customer_id = COALESCE(EXCLUDED.shopify_customer_id, tryfit_consenting_customers.shopify_customer_id),
        store_customer_id = COALESCE(EXCLUDED.store_customer_id, tryfit_consenting_customers.store_customer_id),
        email = COALESCE(EXCLUDED.email, tryfit_consenting_customers.email),
        latest_consent_at = NOW(),
        consent_active = TRUE,
        revoked_at = NULL
      RETURNING id
    `, [
      shopDomain,
      shopifyCustomerId || null,
      storeCustomerId || null,
      identifier,
      email || null
    ]);

    const tryfitCustomerId = result.rows[0]?.id;

    // Log the consent action (audit trail)
    if (tryfitCustomerId) {
      await db.query(`
        INSERT INTO consent_records (
          shop_domain, tryfit_customer_id, identifier, action,
          consent_text_version, consent_text, ip_address, user_agent, shopify_customer_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        shopDomain,
        tryfitCustomerId,
        identifier,
        'consent_given',
        consentTextVersion,
        consentText,
        ipAddress,
        userAgent,
        shopifyCustomerId || null
      ]);
    }

    return tryfitCustomerId;
  } catch (err) {
    console.error(`❌ [DB] addTryFitConsent failed:`, err.message);
    return null;
  }
}

/**
 * The main "magic" function:
 * When a customer uses TryFit with consent, this does the full backfill.
 */
async function backfillCustomerData(shopDomain, params) {
  const { email, phone, identifier, ipAddress, userAgent } = params;

  if (!email && !phone) {
    console.log(`📊 [Backfill] No email/phone provided, skipping for ${identifier}`);
    return { success: false, reason: 'no_identifier' };
  }

  if (!hasTokenForShop(shopDomain)) {
    console.log(`📊 [Backfill] No Shopify token for ${shopDomain}, skipping`);
    return { success: false, reason: 'no_token' };
  }

  console.log(`📊 [Backfill] Starting for ${shopDomain} | email: ${email || 'none'} | phone: ${phone || 'none'}`);

  try {
    // Step 1: Find customer in Shopify
    let shopifyCustomer = null;
    if (email) {
      shopifyCustomer = await findCustomerByEmail(shopDomain, email);
    }
    if (!shopifyCustomer && phone) {
      shopifyCustomer = await findCustomerByPhone(shopDomain, phone);
    }

    if (!shopifyCustomer) {
      console.log(`📊 [Backfill] Customer not found in Shopify for ${email || phone}`);
      await addTryFitConsent(shopDomain, { identifier, email, ipAddress, userAgent });
      return { success: false, reason: 'customer_not_in_shopify' };
    }

    console.log(`📊 [Backfill] Found Shopify customer ID: ${shopifyCustomer.id}`);

    // Step 2: Save to store_customers (Tier 1)
    const storeCustomerId = await saveStoreCustomer(shopDomain, shopifyCustomer);

    // Step 3: Add to TryFit verified pool (Tier 2)
    const tryfitCustomerId = await addTryFitConsent(shopDomain, {
      storeCustomerId,
      shopifyCustomerId: shopifyCustomer.id,
      identifier,
      email: shopifyCustomer.email || email,
      ipAddress,
      userAgent
    });

    // Step 4: Fetch and save all orders
    const orders = await getCustomerOrders(shopDomain, shopifyCustomer.id);
    console.log(`📊 [Backfill] Fetched ${orders.length} orders for customer ${shopifyCustomer.id}`);

    let savedOrders = 0;
    for (const order of orders) {
      const saved = await saveStoreOrder(shopDomain, order);
      if (saved) savedOrders++;
    }

    console.log(`✅ [Backfill] Complete: ${savedOrders}/${orders.length} orders saved for ${shopifyCustomer.email || shopifyCustomer.id}`);

    return {
      success: true,
      shopifyCustomerId: shopifyCustomer.id,
      storeCustomerId,
      tryfitCustomerId,
      ordersSaved: savedOrders,
      totalOrders: orders.length
    };
  } catch (err) {
    console.error(`❌ [Backfill] Failed for ${identifier}:`, err.message);
    return { success: false, reason: 'error', error: err.message };
  }
}

/**
 * List the store's collections (categories) — both custom and smart collections.
 * Used so the advisor can create a coupon limited to a specific category.
 */
async function getCollections(shopDomain) {
  if (!hasTokenForShop(shopDomain)) return [];
  const out = [];
  for (const kind of ['custom_collections', 'smart_collections']) {
    try {
      const data = await shopifyGet(shopDomain, `${kind}.json?limit=250`);
      const arr = data[kind] || [];
      for (const col of arr) {
        out.push({ id: col.id, title: col.title, handle: col.handle, products_count: col.products_count });
      }
    } catch (e) { /* one kind failing shouldn't block the other */ }
  }
  return out;
}

/**
 * Verify Shopify API connectivity on startup.
 */
async function verifyConnection(shopDomain) {
  if (!hasTokenForShop(shopDomain)) {
    return { connected: false, reason: 'no_token' };
  }

  try {
    const data = await shopifyGet(shopDomain, 'shop.json');
    if (data.shop) {
      console.log(`✅ [Shopify] Connected to ${data.shop.name} (${shopDomain})`);
      return { connected: true, shopName: data.shop.name };
    }
    return { connected: false, reason: 'invalid_response' };
  } catch (err) {
    console.error(`❌ [Shopify] Connection test failed for ${shopDomain}:`, err.message);
    return { connected: false, reason: 'api_error', error: err.message };
  }
}

/**
 * Get all customers from a shop using since_id pagination (reliable).
 */
async function getAllCustomers(shopDomain, onProgress = null) {
  const customers = [];
  let sinceId = 0;
  let page = 1;
  const token = await getFreshToken(shopDomain);
  if (!token) throw new Error(`No token for ${shopDomain}`);

  while (true) {
    try {
      const endpoint = `customers.json?limit=250&order=id+asc&since_id=${sinceId}`;
      const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 429) {
        console.log(`⏳ [Shopify] Rate limited, waiting 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const pageCustomers = data.customers || [];
      if (pageCustomers.length === 0) break;

      customers.push(...pageCustomers);
      sinceId = pageCustomers[pageCustomers.length - 1].id;

      console.log(`📦 [Backfill] Customers page ${page}: ${pageCustomers.length} (total: ${customers.length})`);
      if (onProgress) onProgress({ phase: 'customers', page, count: customers.length });

      if (pageCustomers.length < 250) break;

      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`❌ [Backfill] getAllCustomers page ${page} failed:`, err.message);
      break;
    }
  }

  return customers;
}

/**
 * Get all orders from a shop using since_id pagination (reliable).
 * Note: Limited to last 60 days unless read_all_orders scope is granted.
 */
async function getAllOrders(shopDomain, onProgress = null) {
  const orders = [];
  let sinceId = 0;
  let page = 1;
  const token = await getFreshToken(shopDomain);
  if (!token) throw new Error(`No token for ${shopDomain}`);

  while (true) {
    try {
      const endpoint = `orders.json?limit=250&status=any&order=id+asc&since_id=${sinceId}`;
      const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 429) {
        console.log(`⏳ [Shopify] Rate limited, waiting 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const pageOrders = data.orders || [];
      if (pageOrders.length === 0) break;

      orders.push(...pageOrders);
      sinceId = pageOrders[pageOrders.length - 1].id;

      console.log(`📦 [Backfill] Orders page ${page}: ${pageOrders.length} (total: ${orders.length})`);
      if (onProgress) onProgress({ phase: 'orders', page, count: orders.length });

      if (pageOrders.length < 250) break;

      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`❌ [Backfill] getAllOrders page ${page} failed:`, err.message);
      break;
    }
  }

  return orders;
}

/**
 * THE BIG ONE - Backfill the entire shop.
 */
async function backfillEntireShop(shopDomain, onProgress = null) {
  if (!hasTokenForShop(shopDomain)) {
    return { success: false, reason: 'no_token' };
  }

  // Self-healing for shops that installed before ensureShopRow existed. Cheap,
  // idempotent, and it is the difference between saving every row and saving
  // none of them.
  await ensureShopRow(shopDomain);

  const startTime = Date.now();
  const stats = {
    started_at: new Date().toISOString(),
    shop_domain: shopDomain,
    customers_fetched: 0,
    customers_saved: 0,
    customers_failed: 0,
    orders_fetched: 0,
    orders_saved: 0,
    orders_failed: 0,
    duration_seconds: 0,
    errors: []
  };

  try {
    console.log(`\n🚀 [Backfill] Starting FULL backfill for ${shopDomain}\n`);
    if (onProgress) onProgress({ phase: 'starting', stats });

    console.log(`📥 [Backfill] Phase 1: Fetching all customers...`);
    const customers = await getAllCustomers(shopDomain, onProgress);
    stats.customers_fetched = customers.length;
    console.log(`✅ [Backfill] Fetched ${customers.length} customers from Shopify`);

    console.log(`💾 [Backfill] Phase 2: Saving customers to database...`);
    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i];
      const saved = await saveStoreCustomer(shopDomain, customer);
      if (saved) {
        stats.customers_saved++;
      } else {
        stats.customers_failed++;
      }
      if (i % 50 === 0 && i > 0) {
        console.log(`   Saved ${stats.customers_saved}/${customers.length} customers...`);
        if (onProgress) onProgress({ phase: 'saving_customers', stats });
      }
    }
    console.log(`✅ [Backfill] Saved ${stats.customers_saved} customers (${stats.customers_failed} failed)`);

    console.log(`📥 [Backfill] Phase 3: Fetching all orders...`);
    const orders = await getAllOrders(shopDomain, onProgress);
    stats.orders_fetched = orders.length;
    console.log(`✅ [Backfill] Fetched ${orders.length} orders from Shopify`);

    console.log(`💾 [Backfill] Phase 4: Saving orders to database...`);
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const saved = await saveStoreOrder(shopDomain, order);
      if (saved) {
        stats.orders_saved++;
      } else {
        stats.orders_failed++;
      }
      if (i % 50 === 0 && i > 0) {
        console.log(`   Saved ${stats.orders_saved}/${orders.length} orders...`);
        if (onProgress) onProgress({ phase: 'saving_orders', stats });
      }
    }
    console.log(`✅ [Backfill] Saved ${stats.orders_saved} orders (${stats.orders_failed} failed)`);

    stats.duration_seconds = Math.round((Date.now() - startTime) / 1000);
    // A backfill that saved nothing is not a success. This used to be an
    // unconditional `true`, so 0 of 20 printed the same cheerful COMPLETE as
    // 20 of 20 and returned success to every caller.
    const fetched = stats.customers_fetched + stats.orders_fetched;
    const saved = stats.customers_saved + stats.orders_saved;
    stats.success = fetched === 0 || saved > 0;
    stats.completed_at = new Date().toISOString();

    try {
      // These are the columns data_access_log actually has. The old INSERT
      // named action_type/action_details/performed_by — none of which exist —
      // so every backfill of every shop failed to record its own access to
      // customer data, and said so in a line starting with a warning sign that
      // nobody was reading.
      await db.query(`
        INSERT INTO data_access_log (
          endpoint, shop_domain, accessor_type, accessor_id,
          purpose, records_accessed, filters, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        'backfillEntireShop',
        shopDomain,
        'system',
        'admin_endpoint',
        'full_backfill',
        saved,
        JSON.stringify(stats)
      ]);
    } catch (e) {
      // Loud. This is the audit trail SECURITY.md promises Shopify exists.
      console.error('❌ [Backfill] could not write data_access_log:', e.message);
    }

    if (stats.success) {
      console.log(`\n🎉 [Backfill] COMPLETE in ${stats.duration_seconds}s`);
    } else {
      console.error(`\n❌ [Backfill] FAILED in ${stats.duration_seconds}s — fetched ${fetched} record(s) from Shopify and saved none.`);
    }
    console.log(`   Customers: ${stats.customers_saved}/${stats.customers_fetched}`);
    console.log(`   Orders: ${stats.orders_saved}/${stats.orders_fetched}\n`);

    if (onProgress) onProgress({ phase: 'complete', stats });

    return stats;
  } catch (err) {
    console.error(`❌ [Backfill] FATAL error:`, err.message);
    stats.success = false;
    stats.fatal_error = err.message;
    stats.duration_seconds = Math.round((Date.now() - startTime) / 1000);
    return stats;
  }
}

/**
 * Get all products from a shop using since_id pagination.
 */
async function getAllProducts(shopDomain, onProgress = null) {
  const products = [];
  let sinceId = 0;
  let page = 1;
  const token = await getFreshToken(shopDomain);
  if (!token) throw new Error(`No token for ${shopDomain}`);

  while (true) {
    try {
      const endpoint = `products.json?limit=250&order=id+asc&since_id=${sinceId}`;
      const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 429) {
        console.log(`⏳ [Shopify] Rate limited, waiting 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const pageProducts = data.products || [];
      if (pageProducts.length === 0) break;

      products.push(...pageProducts);
      sinceId = pageProducts[pageProducts.length - 1].id;

      console.log(`📦 [Products] Page ${page}: ${pageProducts.length} (total: ${products.length})`);
      if (onProgress) onProgress({ phase: 'products', page, count: products.length });

      if (pageProducts.length < 250) break;

      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`❌ [Products] getAllProducts page ${page} failed:`, err.message);
      break;
    }
  }

  return products;
}

/**
 * Save a single Shopify product to store_products (upsert).
 */
async function saveStoreProduct(shopDomain, product) {
  if (!product || !product.id) return null;

  try {
    const variants = product.variants || [];
    const prices = variants.map(v => parseFloat(v.price || '0')).filter(p => p > 0);
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const totalInventory = variants.reduce((sum, v) => sum + (parseInt(v.inventory_quantity) || 0), 0);
    const available = product.status === 'active' && totalInventory > 0;
    const imageUrl = product.image?.src || (product.images && product.images[0]?.src) || null;
    const tags = (product.tags || '').split(',').map(t => t.trim()).filter(Boolean);

    await db.query(`
      INSERT INTO store_products (
        shop_domain, shopify_product_id, title, product_type, vendor,
        status, tags, min_price, max_price, total_inventory, available,
        image_url, handle, shopify_created_at, shopify_updated_at, raw_data, last_synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
      )
      ON CONFLICT (shop_domain, shopify_product_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        product_type = EXCLUDED.product_type,
        vendor = EXCLUDED.vendor,
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        min_price = EXCLUDED.min_price,
        max_price = EXCLUDED.max_price,
        total_inventory = EXCLUDED.total_inventory,
        available = EXCLUDED.available,
        image_url = EXCLUDED.image_url,
        handle = EXCLUDED.handle,
        shopify_updated_at = EXCLUDED.shopify_updated_at,
        raw_data = EXCLUDED.raw_data,
        last_synced_at = NOW()
    `, [
      shopDomain,
      product.id,
      product.title || null,
      product.product_type || null,
      product.vendor || null,
      product.status || null,
      tags,
      minPrice,
      maxPrice,
      totalInventory,
      available,
      imageUrl,
      product.handle || null,
      product.created_at || null,
      product.updated_at || null,
      JSON.stringify(product)
    ]);

    return product.id;
  } catch (err) {
    console.error(`❌ [DB] saveStoreProduct failed:`, err.message);
    return null;
  }
}

/**
 * Sync the entire product catalog for a shop.
 */
async function syncProducts(shopDomain) {
  if (!hasTokenForShop(shopDomain)) {
    return { success: false, reason: 'no_token' };
  }

  const startTime = Date.now();
  try {
    console.log(`🔄 [Products] Starting catalog sync for ${shopDomain}`);
    const products = await getAllProducts(shopDomain);

    let saved = 0, failed = 0;
    for (const product of products) {
      const ok = await saveStoreProduct(shopDomain, product);
      if (ok) saved++; else failed++;
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ [Products] Sync complete: ${saved} saved, ${failed} failed (${duration}s)`);
    return { success: true, fetched: products.length, saved, failed, duration_seconds: duration };
  } catch (err) {
    console.error(`❌ [Products] Sync failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get all abandoned checkouts from a shop using since_id pagination.
 */
async function getAllAbandonedCheckouts(shopDomain, onProgress = null) {
  const checkouts = [];
  let sinceId = 0;
  let page = 1;
  const token = await getFreshToken(shopDomain);
  if (!token) throw new Error(`No token for ${shopDomain}`);

  while (true) {
    try {
      const endpoint = `checkouts.json?limit=250&since_id=${sinceId}`;
      const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 429) {
        console.log(`⏳ [Shopify] Rate limited, waiting 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`Shopify API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const pageCheckouts = data.checkouts || [];
      if (pageCheckouts.length === 0) break;

      checkouts.push(...pageCheckouts);
      sinceId = pageCheckouts[pageCheckouts.length - 1].id;

      console.log(`📦 [Checkouts] Page ${page}: ${pageCheckouts.length} (total: ${checkouts.length})`);
      if (onProgress) onProgress({ phase: 'checkouts', page, count: checkouts.length });

      if (pageCheckouts.length < 250) break;

      page++;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`❌ [Checkouts] getAllAbandonedCheckouts page ${page} failed:`, err.message);
      break;
    }
  }

  return checkouts;
}

/**
 * Save a single abandoned checkout to abandoned_checkouts (upsert).
 */
async function saveAbandonedCheckout(shopDomain, checkout) {
  if (!checkout || !checkout.id) return null;

  try {
    const lineItems = (checkout.line_items || []).map(li => ({
      title: li.title || null,
      product_id: li.product_id || null,
      variant_title: li.variant_title || null,
      quantity: li.quantity || 0,
      price: parseFloat(li.price || '0')
    }));
    const itemCount = lineItems.reduce((sum, li) => sum + (li.quantity || 0), 0);

    await db.query(`
      INSERT INTO abandoned_checkouts (
        shop_domain, shopify_checkout_id, token, email, phone,
        shopify_customer_id, total_price, subtotal_price, currency,
        item_count, line_items, abandoned_checkout_url, completed_at,
        shopify_created_at, shopify_updated_at, raw_data, last_synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
      )
      ON CONFLICT (shop_domain, shopify_checkout_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        total_price = EXCLUDED.total_price,
        subtotal_price = EXCLUDED.subtotal_price,
        item_count = EXCLUDED.item_count,
        line_items = EXCLUDED.line_items,
        abandoned_checkout_url = EXCLUDED.abandoned_checkout_url,
        completed_at = EXCLUDED.completed_at,
        shopify_updated_at = EXCLUDED.shopify_updated_at,
        raw_data = EXCLUDED.raw_data,
        last_synced_at = NOW()
    `, [
      shopDomain,
      checkout.id,
      checkout.token || null,
      checkout.email || null,
      checkout.phone || null,
      checkout.customer?.id || null,
      parseFloat(checkout.total_price || '0'),
      parseFloat(checkout.subtotal_price || '0'),
      checkout.currency || null,
      itemCount,
      JSON.stringify(lineItems),
      checkout.abandoned_checkout_url || null,
      checkout.completed_at || null,
      checkout.created_at || null,
      checkout.updated_at || null,
      JSON.stringify(checkout)
    ]);

    return checkout.id;
  } catch (err) {
    console.error(`❌ [DB] saveAbandonedCheckout failed:`, err.message);
    return null;
  }
}

/**
 * Sync all abandoned checkouts for a shop.
 */
async function syncAbandonedCheckouts(shopDomain) {
  if (!hasTokenForShop(shopDomain)) {
    return { success: false, reason: 'no_token' };
  }

  const startTime = Date.now();
  try {
    console.log(`🔄 [Checkouts] Starting abandoned-checkout sync for ${shopDomain}`);
    const checkouts = await getAllAbandonedCheckouts(shopDomain);

    let saved = 0, failed = 0;
    for (const checkout of checkouts) {
      const ok = await saveAbandonedCheckout(shopDomain, checkout);
      if (ok) saved++; else failed++;
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ [Checkouts] Sync complete: ${saved} saved, ${failed} failed (${duration}s)`);
    return { success: true, fetched: checkouts.length, saved, failed, duration_seconds: duration };
  } catch (err) {
    console.error(`❌ [Checkouts] Sync failed:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Create a real discount code in Shopify.
 * Creates a price_rule (the discount logic) + a discount_code (the code customers type).
 * percentage: e.g. 10 for 10% off. days_valid: how long the code is active.
 *
 * combinesWith (default true): when true, the code is allowed to STACK on top of
 * the store's existing automatic order discount (e.g. the site-wide 10%). This is
 * what makes the personal coupon an "extra" discount rather than replacing the
 * automatic one. Set combine:false to force a standalone, non-stacking code.
 *
 * Returns { ok, code, price_rule_id, discount_code_id } or { ok:false, error }.
 */
// Delete a discount (its price rule) — used to clean up an orphan coupon that was
// created but never delivered (the send failed). Best-effort; never throws.
async function deleteDiscountCode(shopDomain, priceRuleId) {
  if (!priceRuleId || !hasTokenForShop(shopDomain)) return { ok: false };
  try {
    const token = await getFreshToken(shopDomain);
    const base = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    await fetch(`${base}/price_rules/${priceRuleId}.json`, { method: 'DELETE', headers });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function createDiscountCode(shopDomain, opts = {}) {
  if (!hasTokenForShop(shopDomain)) {
    return { ok: false, error: 'no_token' };
  }
  const token = await getFreshToken(shopDomain);
  const base = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const code = (opts.code || `SAVE${Math.floor(Math.random() * 9000 + 1000)}`).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Discount can be either a PERCENTAGE (e.g. 15%) or a FIXED amount in ILS
  // (e.g. ₪77 off). The advisor decides which based on how the merchant phrased it.
  const isFixed = !!(opts.amount_ils || opts.fixed_amount || opts.discount_type === 'fixed');
  const fixedAmount = isFixed
    ? Math.max(parseFloat(opts.amount_ils || opts.fixed_amount) || 0, 1)
    : null;
  const percentage = Math.min(Math.max(parseFloat(opts.percentage) || 10, 1), 90);
  const daysValid = parseInt(opts.days_valid) || 30;
  const startsAt = new Date();
  const endsAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000);
  // Default to stacking ON (combine with the store's automatic discount).
  const allowCombine = opts.combine === false ? false : true;

  // ---- Coupon type detection ----
  // free_shipping: discount applies to the shipping line.
  // bxgy: "buy X get Y" (e.g. 3+1). prerequisite_quantity buy, entitled_quantity free.
  // collection: discount limited to a specific category/collection (entitled_collection_ids).
  // min_subtotal: only valid above a spend threshold (e.g. "over 300₪").
  const isFreeShipping = opts.type === 'free_shipping' || opts.free_shipping === true;
  const isBxgy = opts.type === 'bxgy' || (opts.buy_quantity && opts.get_quantity);
  const collectionId = opts.collection_id || (Array.isArray(opts.collection_ids) && opts.collection_ids[0]) || null;
  const minSubtotal = opts.min_subtotal != null ? parseFloat(opts.min_subtotal) : null;

  let priceRuleId = null;
  try {
    // Step 1: build the price rule (the discount definition), shaped by coupon type.
    const pr = {
      title: opts.title || `יועץ: ${code}`,
      customer_selection: 'all',
      once_per_customer: true,
      usage_limit: opts.usage_limit || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      combines_with: {
        order_discounts: allowCombine,
        product_discounts: allowCombine,
        shipping_discounts: allowCombine
      }
    };

    if (isFreeShipping) {
      // Free shipping coupon (optionally only above a subtotal).
      pr.target_type = 'shipping_line';
      pr.target_selection = 'all';
      pr.allocation_method = 'each';
      pr.value_type = 'percentage';
      pr.value = '-100.0';
    } else if (isBxgy) {
      // Buy X Get Y (e.g. 3+1): buy `buy_quantity`, get `get_quantity` free.
      pr.target_type = 'line_item';
      pr.target_selection = collectionId ? 'entitled' : 'all';
      pr.allocation_method = 'each';
      pr.value_type = 'percentage';
      pr.value = '-100.0'; // the "get" items are 100% off
      pr.prerequisite_to_entitlement_quantity_ratio = {
        prerequisite_quantity: parseInt(opts.buy_quantity) || 3,
        entitled_quantity: parseInt(opts.get_quantity) || 1
      };
      pr.allocation_limit = parseInt(opts.get_quantity) || 1;
      if (collectionId) {
        pr.entitled_collection_ids = [Number(collectionId)];
        pr.prerequisite_collection_ids = [Number(collectionId)];
      }
    } else {
      // Standard percentage or fixed-amount discount.
      pr.target_type = 'line_item';
      pr.allocation_method = 'across';
      pr.value_type = isFixed ? 'fixed_amount' : 'percentage';
      pr.value = isFixed ? `-${fixedAmount}.0` : `-${percentage}.0`;
      if (collectionId) {
        // Limit the discount to one collection/category.
        pr.target_selection = 'entitled';
        pr.entitled_collection_ids = [Number(collectionId)];
      } else {
        pr.target_selection = 'all';
      }
    }

    // Minimum purchase requirement (e.g. "valid over 300₪").
    if (minSubtotal && minSubtotal > 0) {
      pr.prerequisite_subtotal_range = { greater_than_or_equal_to: String(minSubtotal) };
    }

    const prBody = { price_rule: pr };
    const prRes = await fetch(`${base}/price_rules.json`, {
      method: 'POST', headers, body: JSON.stringify(prBody)
    });
    if (prRes.status !== 201) {
      const txt = await prRes.text();
      return { ok: false, error: `price_rule failed (${prRes.status}): ${txt.substring(0, 150)}`,
               needs_scope: prRes.status === 403 };
    }
    const prData = await prRes.json();
    priceRuleId = prData.price_rule.id;

    // Step 2: attach the actual code to the price rule
    const dcRes = await fetch(`${base}/price_rules/${priceRuleId}/discount_codes.json`, {
      method: 'POST', headers, body: JSON.stringify({ discount_code: { code } })
    });
    if (dcRes.status !== 201) {
      const txt = await dcRes.text();
      try { await fetch(`${base}/price_rules/${priceRuleId}.json`, { method: 'DELETE', headers }); } catch (e) {}
      return { ok: false, error: `discount_code failed (${dcRes.status}): ${txt.substring(0, 150)}` };
    }
    const dcData = await dcRes.json();

    console.log(`🎟️  [Coupon] Created ${code} (${isFixed ? fixedAmount + '₪' : percentage + '%'} off, ${daysValid}d, combine=${allowCombine}) for ${shopDomain}`);
    return {
      ok: true,
      code,
      percentage: isFixed ? null : percentage,
      amount_ils: isFixed ? fixedAmount : null,
      discount_type: isFixed ? 'fixed' : 'percentage',
      days_valid: daysValid,
      combines: allowCombine,
      ends_at: endsAt.toISOString(),
      price_rule_id: priceRuleId,
      discount_code_id: dcData.discount_code.id
    };
  } catch (err) {
    if (priceRuleId) {
      try { await fetch(`${base}/price_rules/${priceRuleId}.json`, { method: 'DELETE', headers }); } catch (e) {}
    }
    console.error(`❌ [Coupon] createDiscountCode failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Create a draft order (a pre-built cart) and get a direct payment/invoice link.
 */
async function createDraftOrder(shopDomain, opts = {}) {
  if (!hasTokenForShop(shopDomain)) return { ok: false, error: 'no_token' };
  const token = await getFreshToken(shopDomain);
  const base = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    const lineItems = (opts.items || []).map(it => {
      if (it.variant_id) {
        return { variant_id: it.variant_id, quantity: it.quantity || 1 };
      }
      return { title: it.title || 'מוצר', price: it.price || '0.00', quantity: it.quantity || 1 };
    });
    if (lineItems.length === 0) return { ok: false, error: 'no items' };

    const body = {
      draft_order: {
        line_items: lineItems,
        note: opts.note || 'הוכן על ידי היועץ החכם',
        tags: 'advisor',
        use_customer_default_address: true
      }
    };
    if (opts.email) body.draft_order.email = opts.email;
    if (opts.discount_percentage) {
      body.draft_order.applied_discount = {
        description: 'הנחת היועץ',
        value_type: 'percentage',
        value: String(opts.discount_percentage),
        title: 'הנחה אישית'
      };
    }

    const r = await fetch(`${base}/draft_orders.json`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    if (r.status !== 201) {
      const txt = await r.text();
      return { ok: false, error: `draft_order failed (${r.status}): ${txt.substring(0,150)}`,
               needs_scope: r.status === 403 };
    }
    const data = await r.json();
    const draft = data.draft_order;

    let invoiceUrl = draft.invoice_url;
    return {
      ok: true,
      draft_order_id: draft.id,
      invoice_url: invoiceUrl,
      total: draft.total_price,
      currency: draft.currency
    };
  } catch (err) {
    console.error('❌ [DraftOrder] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  shopifyGet,
  getFreshToken,
  saveTokens,
  upgradeShopToken,
  hasTokenForShop,
  getTokenForShop,
  loadStores,
  upsertStore,
  getStore,
  listStores,
  hasAcceptedTerms,
  acceptTerms,
  setWhatsAppConfig,
  setAdvisorPassword,
  setStoreLogo,
  setOwnerEmail,
  getWhatsAppConfig,
  ensureStoreTable,
  deactivateStore,
  purgeStore,
  migrateSecretsToVault,
  findCustomerByEmail,
  findCustomerByPhone,
  getCustomerById,
  getCustomerOrders,
  saveStoreCustomer,
  saveStoreOrder,
  addTryFitConsent,
  backfillCustomerData,
  verifyConnection,
  getAllCustomers,
  getAllOrders,
  backfillEntireShop,
  ensureShopRow,
  getAllProducts,
  saveStoreProduct,
  syncProducts,
  getAllAbandonedCheckouts,
  saveAbandonedCheckout,
  syncAbandonedCheckouts,
  createDiscountCode,
  getCollections,
  deleteDiscountCode,
  getPublicDomain,
  createDraftOrder
};