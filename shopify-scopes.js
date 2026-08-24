// ============================================================================
// WHAT THIS APP ASKS SHOPIFY FOR — the single source of truth.
//
// This list was written down in two places that did not agree: OAUTH_SCOPES in
// server-dual.js, and access_scopes in shopify.app.smart-advisor2.toml. Both
// were missing write_price_rules, so the app installed cleanly, showed a green
// "Connected" badge, wrote a campaign, asked the merchant which channels to
// send on — and then, at the last step, produced
//
//   ❌ יצירת הקופון נכשלה: price_rule failed (403):
//      {"errors":"[API] This action requires merchant approval for
//       write_price_rules scope."}
//
// A permission problem must surface at install, when granting it is one click,
// not in the middle of the one action the merchant came to perform. Nothing
// about that failure was recoverable from inside the app, and the message was
// Shopify's raw API error in two languages.
//
// Every scope here carries the reason it is asked for. If a scope has no reason
// it does not belong in the list: an app that asks for more than it uses is
// asking a merchant to trust it with data it never touches, and Shopify's
// reviewers ask about exactly this.
// ============================================================================

const SCOPES = [
  // --- Customers: the audience the whole product operates on -----------------
  { scope: 'read_customers',      why: 'RFM segmentation, and knowing who to contact at all' },
  { scope: 'write_customers',     why: 'recording marketing consent and opt-outs back onto the customer' },

  // --- Orders: what the segmentation and attribution are built from ----------
  { scope: 'read_orders',         why: 'purchase history for segmentation, and attributing sales to a campaign' },
  { scope: 'read_checkouts',      why: 'abandoned carts — the highest-value message the agent sends' },
  { scope: 'read_fulfillments',   why: 'fulfilment state on an order, so a message is not sent about a cancelled one' },

  // --- Catalogue: what the agent talks about --------------------------------
  { scope: 'read_products',       why: 'product names and prices in the copy the agent writes' },
  { scope: 'read_inventory',      why: 'stock levels — the agent will not push a product that is out of stock' },

  // --- Discounts: the offer attached to a campaign --------------------------
  //
  // write_price_rules is the one that was missing. The coupon is created over
  // REST at price_rules.json, and REST price rules are gated on
  // write_price_rules — NOT on write_discounts, which covers the newer GraphQL
  // discount mutations this app does not use.
  { scope: 'read_price_rules',    why: 'reading back a coupon the app created' },
  { scope: 'write_price_rules',   why: 'creating the coupon a campaign offers (POST price_rules.json)' },
  { scope: 'read_discounts',      why: 'checking whether a discount code is still live before sending it' },
  { scope: 'write_discounts',     why: 'attaching the generated code to the price rule' },

  // --- Draft orders ---------------------------------------------------------
  { scope: 'write_draft_orders',  why: 'building the pre-filled cart a recovery link opens' }
];

// Sorted, so the string is stable no matter what order the list is edited in —
// a reordered scope string reads as a scope CHANGE to Shopify tooling and
// prompts every merchant to re-approve for nothing.
const list = () => SCOPES.map(s => s.scope).sort();

/** Comma-separated, exactly as the OAuth URL and the .toml both want it. */
const asString = () => list().join(',');

/**
 * Which of the scopes we need are missing from what a shop actually granted?
 *
 * Shopify returns granted scopes from GET /admin/oauth/access_scopes.json.
 * A scope granted as `write_x` implies `read_x`, which is why the read
 * counterpart is treated as satisfied by the write.
 */
function missingFrom(granted) {
  const have = new Set((granted || []).map(g => String(g && g.handle ? g.handle : g).trim()).filter(Boolean));
  const satisfied = (scope) => {
    if (have.has(scope)) return true;
    const m = /^read_(.+)$/.exec(scope);
    return !!(m && have.has('write_' + m[1]));
  };
  return list().filter(s => !satisfied(s));
}

module.exports = { SCOPES, list, asString, missingFrom };
