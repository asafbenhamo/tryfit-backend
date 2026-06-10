// wa-templates.js - Registry of APPROVED WhatsApp templates, per shop.
//
// Templates themselves are created & approved on the 360dialog/Meta side. This
// table is our MIRROR of them: for each approved template we store its exact
// name, language, the action type it serves, a human sample (what the merchant
// previews), and the variable mapping so the advisor fills {{1}},{{2}},... and
// the dynamic button URL suffix correctly.
//
// Structure of a template row:
//   shop_domain     - which store this approved template belongs to
//   action_type     - 'win_back' | 'abandoned_cart' | 'personalized_cart' | 'product_rec'
//   template_name   - EXACT name as approved in 360dialog
//   language        - e.g. 'he'
//   sample_text     - Hebrew preview the merchant sees (with {שם},{קוד} placeholders)
//   body_vars       - ordered list naming each body {{n}}, e.g. ['name','coupon']
//   url_button_base - fixed part of the dynamic button URL (suffix is the variable)
//   url_button_label- label of the dynamic button, e.g. 'לעגלה שלי'
//   site_url        - the always-present "to the store" button URL
//
// Sending uses template_name + the filled body_vars + the URL suffix. The advisor
// never invents free text for these — Meta requires the approved structure.

const db = require('./database');

const ACTION_TYPES = ['win_back', 'abandoned_cart', 'personalized_cart', 'product_rec'];

async function ensureTemplatesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS wa_templates (
        id              SERIAL PRIMARY KEY,
        shop_domain     TEXT NOT NULL,
        action_type     TEXT NOT NULL,
        template_name   TEXT NOT NULL,
        language        TEXT DEFAULT 'he',
        sample_text     TEXT,
        body_vars       JSONB DEFAULT '[]'::jsonb,
        url_button_base TEXT,
        url_button_label TEXT,
        site_url        TEXT,
        active          BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (shop_domain, template_name)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_templates_shop ON wa_templates(shop_domain, action_type)`).catch(()=>{});
  } catch (err) {
    console.error('⚠️  [wa-templates] ensureTemplatesTable failed:', err.message);
  }
}

// Add or update a template (admin/master defines these).
async function upsertTemplate(t) {
  const {
    shop_domain, action_type, template_name, language = 'he',
    sample_text = '', body_vars = [], url_button_base = null,
    url_button_label = null, site_url = null
  } = t;
  if (!shop_domain || !action_type || !template_name) {
    return { ok: false, error: 'shop_domain, action_type, template_name required' };
  }
  if (!ACTION_TYPES.includes(action_type)) {
    return { ok: false, error: 'invalid action_type' };
  }
  try {
    await ensureTemplatesTable();
    await db.query(
      `INSERT INTO wa_templates
         (shop_domain, action_type, template_name, language, sample_text, body_vars, url_button_base, url_button_label, site_url, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
       ON CONFLICT (shop_domain, template_name) DO UPDATE SET
         action_type = EXCLUDED.action_type,
         language = EXCLUDED.language,
         sample_text = EXCLUDED.sample_text,
         body_vars = EXCLUDED.body_vars,
         url_button_base = EXCLUDED.url_button_base,
         url_button_label = EXCLUDED.url_button_label,
         site_url = EXCLUDED.site_url,
         active = TRUE`,
      [shop_domain.toLowerCase().trim(), action_type, template_name, language,
       sample_text, JSON.stringify(body_vars || []), url_button_base, url_button_label, site_url]
    );
    return { ok: true };
  } catch (err) {
    console.error('⚠️  [wa-templates] upsertTemplate failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// List templates for a shop, optionally filtered by action_type.
async function listTemplates(shop, actionType = null) {
  try {
    await ensureTemplatesTable();
    const params = [shop.toLowerCase().trim()];
    let sql = `SELECT id, action_type, template_name, language, sample_text, body_vars,
                      url_button_base, url_button_label, site_url, active
               FROM wa_templates WHERE shop_domain = $1 AND active = TRUE`;
    if (actionType) { sql += ` AND action_type = $2`; params.push(actionType); }
    sql += ` ORDER BY action_type, template_name`;
    const r = await db.query(sql, params);
    return r.rows.map(row => ({
      ...row,
      body_vars: Array.isArray(row.body_vars) ? row.body_vars : []
    }));
  } catch (err) {
    console.error('⚠️  [wa-templates] listTemplates failed:', err.message);
    return [];
  }
}

// Get one template by name for a shop.
async function getTemplate(shop, templateName) {
  try {
    const r = await db.query(
      `SELECT id, action_type, template_name, language, sample_text, body_vars,
              url_button_base, url_button_label, site_url
       FROM wa_templates WHERE shop_domain = $1 AND template_name = $2 AND active = TRUE`,
      [shop.toLowerCase().trim(), templateName]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    row.body_vars = Array.isArray(row.body_vars) ? row.body_vars : [];
    return row;
  } catch (err) {
    return null;
  }
}

// Soft-delete a template.
async function removeTemplate(shop, templateName) {
  try {
    await db.query(
      `UPDATE wa_templates SET active = FALSE WHERE shop_domain = $1 AND template_name = $2`,
      [shop.toLowerCase().trim(), templateName]
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ACTION_TYPES,
  ensureTemplatesTable,
  upsertTemplate,
  listTemplates,
  getTemplate,
  removeTemplate
};