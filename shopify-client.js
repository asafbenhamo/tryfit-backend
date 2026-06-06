// shopify-client.js - Shopify Admin API client for data platform
// Used to fetch customer and order data when a customer uses TryFit with consent.
// Only operates for shops that have a configured token (currently only seven770).

const db = require('./database');

const SHOPIFY_API_VERSION = '2026-01';

// Map shop domain -> environment variable name for its token
const SHOP_TOKEN_MAP = {
  'seven770.myshopify.com': 'SHOPIFY_770_TOKEN'
};

/**
 * Get the access token for a specific shop.
 * Returns null if no token is configured for this shop.
 */
function getTokenForShop(shopDomain) {
  if (!shopDomain) return null;
  const normalized = shopDomain.toLowerCase().trim();
  const envVar = SHOP_TOKEN_MAP[normalized];
  if (!envVar) return null;
  return process.env[envVar] || null;
}

/**
 * Check if we have a working token for a shop
 */
function hasTokenForShop(shopDomain) {
  return getTokenForShop(shopDomain) !== null;
}

/**
 * Generic Shopify Admin API GET request.
 * Handles rate limiting, retries, and pagination.
 */
async function shopifyGet(shopDomain, endpoint, retries = 3) {
  const token = getTokenForShop(shopDomain);
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
      shopifyCustomer.phone || (shopifyCustomer.default_address?.phone) || null,
      shopifyCustomer.default_address?.city || null,
      shopifyCustomer.default_address?.province || null,
      shopifyCustomer.default_address?.country || null,
      shopifyCustomer.created_at || null,
      shopifyCustomer.updated_at || null,
      parseFloat(shopifyCustomer.total_spent || '0'),
      shopifyCustomer.orders_count || 0,
      shopifyCustomer.last_order_date || null,
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
  const token = getTokenForShop(shopDomain);
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
  const token = getTokenForShop(shopDomain);
  if (!token) throw new Error(`No token for ${shopDomain}`);

  while (true) {
    try {
      // Use since_id pagination (reliable, not dependent on the Link header).
      // Order ascending by id so since_id walks forward through ALL orders.
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
      if (pageOrders.length === 0) break; // no more orders

      orders.push(...pageOrders);

      // Advance the cursor to the highest id we just received.
      sinceId = pageOrders[pageOrders.length - 1].id;

      console.log(`📦 [Backfill] Orders page ${page}: ${pageOrders.length} (total: ${orders.length})`);
      if (onProgress) onProgress({ phase: 'orders', page, count: orders.length });

      if (pageOrders.length < 250) break; // last (partial) page reached

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
 * Pulls ALL customers + ALL orders (last 60 days) and saves to Tier 1 tables.
 */
async function backfillEntireShop(shopDomain, onProgress = null) {
  if (!hasTokenForShop(shopDomain)) {
    return { success: false, reason: 'no_token' };
  }

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

    // Phase 1: Fetch all customers
    console.log(`📥 [Backfill] Phase 1: Fetching all customers...`);
    const customers = await getAllCustomers(shopDomain, onProgress);
    stats.customers_fetched = customers.length;
    console.log(`✅ [Backfill] Fetched ${customers.length} customers from Shopify`);

    // Phase 2: Save customers to Tier 1
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

    // Phase 3: Fetch all orders
    console.log(`📥 [Backfill] Phase 3: Fetching all orders...`);
    const orders = await getAllOrders(shopDomain, onProgress);
    stats.orders_fetched = orders.length;
    console.log(`✅ [Backfill] Fetched ${orders.length} orders from Shopify`);

    // Phase 4: Save orders + line items to Tier 1
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
    stats.success = true;
    stats.completed_at = new Date().toISOString();

    // Log audit trail
    try {
      await db.query(`
        INSERT INTO data_access_log (
          shop_domain, action_type, action_details, performed_by, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `, [
        shopDomain,
        'full_backfill',
        JSON.stringify(stats),
        'admin_endpoint'
      ]);
    } catch (e) {
      console.log('⚠️  Could not log to data_access_log:', e.message);
    }

    console.log(`\n🎉 [Backfill] COMPLETE in ${stats.duration_seconds}s`);
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
  const token = getTokenForShop(shopDomain);
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
 * Abandoned checkouts = carts that were started but not completed.
 */
async function getAllAbandonedCheckouts(shopDomain, onProgress = null) {
  const checkouts = [];
  let sinceId = 0;
  let page = 1;
  const token = getTokenForShop(shopDomain);
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

module.exports = {
  hasTokenForShop,
  getTokenForShop,
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
  getAllProducts,
  saveStoreProduct,
  syncProducts,
  getAllAbandonedCheckouts,
  saveAbandonedCheckout,
  syncAbandonedCheckouts
};