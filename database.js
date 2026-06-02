// database.js - PostgreSQL connection layer
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Connection pool - Railway provides DATABASE_URL automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Test connection on startup
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected at', result.rows[0].now);
    client.release();
    return true;
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    return false;
  }
}

// Initialize schema (creates tables if not exist)
async function initializeSchema() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.log('⚠️  schema.sql not found, skipping initialization');
      return;
    }
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
    console.log('✅ Schema initialized');
  } catch (err) {
    console.error('❌ Schema initialization failed:', err.message);
  }
}

// Generic query helper
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log('Slow query:', { text: text.substring(0, 100), duration, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    console.error('Query error:', err.message, 'Query:', text.substring(0, 200));
    throw err;
  }
}

// Transaction helper
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  transaction,
  testConnection,
  initializeSchema
};