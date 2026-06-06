-- =====================================================
-- TryFit Data Platform Schema
-- Tier 1: Store Insights (all customers)
-- Tier 2: TryFit Verified Pool (consented customers)
-- =====================================================

-- ============ INFRASTRUCTURE ============

CREATE TABLE IF NOT EXISTS shops (
  shop_domain VARCHAR(255) PRIMARY KEY,
  display_name VARCHAR(255),
  data_collection_enabled BOOLEAN DEFAULT FALSE,
  contract_signed_at TIMESTAMP,
  shopify_access_token TEXT,
  installed_at TIMESTAMP DEFAULT NOW(),
  last_sync_at TIMESTAMP,
  total_customers INTEGER DEFAULT 0,
  total_consenting_customers INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- ============ TIER 1: STORE INSIGHTS POOL ============

CREATE TABLE IF NOT EXISTS store_customers (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL REFERENCES shops(shop_domain),
  shopify_customer_id BIGINT NOT NULL,
  email VARCHAR(255),
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  phone VARCHAR(50),
  city VARCHAR(255),
  province VARCHAR(255),
  country VARCHAR(255),
  shopify_created_at TIMESTAMP,
  shopify_updated_at TIMESTAMP,
  total_spent NUMERIC(12,2) DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  last_order_date TIMESTAMP,
  shopify_tags TEXT[],
  marketing_consent BOOLEAN DEFAULT FALSE,
  marketing_consent_updated_at TIMESTAMP,
  raw_data JSONB,
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_domain, shopify_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_store_customers_shop ON store_customers(shop_domain);
CREATE INDEX IF NOT EXISTS idx_store_customers_email ON store_customers(email);
CREATE INDEX IF NOT EXISTS idx_store_customers_total_spent ON store_customers(total_spent DESC);

CREATE TABLE IF NOT EXISTS store_orders (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL REFERENCES shops(shop_domain),
  shopify_order_id BIGINT NOT NULL,
  shopify_customer_id BIGINT,
  order_number VARCHAR(50),
  total_price NUMERIC(12,2),
  subtotal_price NUMERIC(12,2),
  total_discounts NUMERIC(12,2) DEFAULT 0,
  currency VARCHAR(10),
  financial_status VARCHAR(50),
  fulfillment_status VARCHAR(50),
  discount_codes TEXT[],
  source_name VARCHAR(100),
  ordered_at TIMESTAMP,
  raw_data JSONB,
  synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_domain, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS idx_store_orders_customer ON store_orders(shop_domain, shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_store_orders_date ON store_orders(ordered_at DESC);

CREATE TABLE IF NOT EXISTS store_order_items (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  shopify_order_id BIGINT NOT NULL,
  shopify_product_id BIGINT,
  shopify_variant_id BIGINT,
  title TEXT,
  variant_title TEXT,
  vendor VARCHAR(255),
  product_type VARCHAR(255),
  quantity INTEGER,
  price NUMERIC(12,2),
  total_discount NUMERIC(12,2) DEFAULT 0,
  sku VARCHAR(255),
  tags TEXT[],
  raw_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON store_order_items(shop_domain, shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON store_order_items(shopify_product_id);

-- ============ TIER 2: TRYFIT VERIFIED POOL ============

CREATE TABLE IF NOT EXISTS tryfit_consenting_customers (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL REFERENCES shops(shop_domain),
  shopify_customer_id BIGINT,
  store_customer_id BIGINT REFERENCES store_customers(id),
  identifier VARCHAR(255),
  email VARCHAR(255),
  first_consent_at TIMESTAMP DEFAULT NOW(),
  latest_consent_at TIMESTAMP DEFAULT NOW(),
  consent_active BOOLEAN DEFAULT TRUE,
  revoked_at TIMESTAMP,
  total_tryons INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  UNIQUE(shop_domain, identifier)
);

CREATE INDEX IF NOT EXISTS idx_tryfit_customers_shop ON tryfit_consenting_customers(shop_domain);
CREATE INDEX IF NOT EXISTS idx_tryfit_customers_email ON tryfit_consenting_customers(email);
CREATE INDEX IF NOT EXISTS idx_tryfit_customers_active ON tryfit_consenting_customers(consent_active);

CREATE TABLE IF NOT EXISTS consent_records (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  tryfit_customer_id BIGINT REFERENCES tryfit_consenting_customers(id),
  identifier VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  consent_text_version VARCHAR(50),
  consent_text TEXT,
  ip_address INET,
  user_agent TEXT,
  shopify_customer_id BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_records_customer ON consent_records(tryfit_customer_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_shop ON consent_records(shop_domain);

CREATE TABLE IF NOT EXISTS tryon_events (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  tryfit_customer_id BIGINT REFERENCES tryfit_consenting_customers(id),
  shopify_customer_id BIGINT,
  identifier VARCHAR(255),
  session_id VARCHAR(255),
  product_id VARCHAR(255),
  product_title TEXT,
  product_category VARCHAR(100),
  product_price NUMERIC(12,2),
  garment_url TEXT,
  result_url TEXT,
  backend_mode VARCHAR(50),
  category_detected VARCHAR(100),
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  ip_address INET,
  user_agent TEXT,
  added_to_cart BOOLEAN DEFAULT FALSE,
  resulted_in_purchase BOOLEAN DEFAULT FALSE,
  resulting_order_id BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tryon_events_shop ON tryon_events(shop_domain);
CREATE INDEX IF NOT EXISTS idx_tryon_events_customer ON tryon_events(tryfit_customer_id);
CREATE INDEX IF NOT EXISTS idx_tryon_events_session ON tryon_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tryon_events_date ON tryon_events(created_at DESC);

-- ============ TIER 3: AI PROFILES ============

CREATE TABLE IF NOT EXISTS customer_profiles (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  store_customer_id BIGINT REFERENCES store_customers(id),
  tryfit_customer_id BIGINT REFERENCES tryfit_consenting_customers(id),
  style_preference VARCHAR(100),
  estimated_budget_range VARCHAR(50),
  price_sensitivity NUMERIC(3,2),
  loyalty_score NUMERIC(3,2),
  trendsetter_score NUMERIC(3,2),
  return_risk_score NUMERIC(3,2),
  favorite_categories TEXT[],
  seasonal_pattern VARCHAR(100),
  ai_description TEXT,
  ai_description_en TEXT,
  brand_match_scores JSONB,
  generated_by VARCHAR(50),
  model_version VARCHAR(50),
  generated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_profiles_shop ON customer_profiles(shop_domain);
CREATE INDEX IF NOT EXISTS idx_profiles_store_customer ON customer_profiles(store_customer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_tryfit_customer ON customer_profiles(tryfit_customer_id);

-- ============ AUDIT & GOVERNANCE ============

CREATE TABLE IF NOT EXISTS data_access_log (
  id BIGSERIAL PRIMARY KEY,
  endpoint VARCHAR(255),
  shop_domain VARCHAR(255),
  accessor_type VARCHAR(50),
  accessor_id VARCHAR(255),
  purpose VARCHAR(255),
  records_accessed INTEGER,
  filters JSONB,
  ip_address INET,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_log_shop ON data_access_log(shop_domain);
CREATE INDEX IF NOT EXISTS idx_access_log_date ON data_access_log(created_at DESC);

-- ============ STORE PRODUCTS (live catalog, synced periodically) ============

CREATE TABLE IF NOT EXISTS store_products (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  shopify_product_id BIGINT NOT NULL,
  title TEXT,
  product_type VARCHAR(255),
  vendor VARCHAR(255),
  status VARCHAR(50),
  tags TEXT[],
  min_price NUMERIC(12,2),
  max_price NUMERIC(12,2),
  total_inventory INTEGER,
  available BOOLEAN DEFAULT TRUE,
  image_url TEXT,
  handle VARCHAR(255),
  shopify_created_at TIMESTAMP,
  shopify_updated_at TIMESTAMP,
  raw_data JSONB,
  last_synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_domain, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS idx_store_products_shop ON store_products(shop_domain);
CREATE INDEX IF NOT EXISTS idx_store_products_type ON store_products(product_type);
CREATE INDEX IF NOT EXISTS idx_store_products_available ON store_products(available);

-- ============ CHAT CONVERSATIONS (advisor chat history) ============

CREATE TABLE IF NOT EXISTS chat_conversations (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  title VARCHAR(255),
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_shop ON chat_conversations(shop_domain, updated_at DESC);

-- ============ INITIAL DATA ============

-- ============ ABANDONED CHECKOUTS (carts not completed) ============

CREATE TABLE IF NOT EXISTS abandoned_checkouts (
  id BIGSERIAL PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  shopify_checkout_id BIGINT NOT NULL,
  token VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(100),
  shopify_customer_id BIGINT,
  total_price NUMERIC(12,2),
  subtotal_price NUMERIC(12,2),
  currency VARCHAR(10),
  item_count INTEGER DEFAULT 0,
  line_items JSONB DEFAULT '[]'::jsonb,
  abandoned_checkout_url TEXT,
  completed_at TIMESTAMP,
  shopify_created_at TIMESTAMP,
  shopify_updated_at TIMESTAMP,
  raw_data JSONB,
  last_synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (shop_domain, shopify_checkout_id)
);

CREATE INDEX IF NOT EXISTS idx_abandoned_shop ON abandoned_checkouts(shop_domain);
CREATE INDEX IF NOT EXISTS idx_abandoned_date ON abandoned_checkouts(shopify_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abandoned_completed ON abandoned_checkouts(completed_at);

INSERT INTO shops (shop_domain, display_name, data_collection_enabled, installed_at)
VALUES ('seven770.myshopify.com', 'Seven770 (Demo)', TRUE, NOW())
ON CONFLICT (shop_domain) DO UPDATE
SET data_collection_enabled = TRUE;