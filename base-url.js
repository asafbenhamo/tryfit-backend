// ============================================================================
// THE PUBLIC ADDRESS OF THIS APP — one place, so moving it is one change.
//
// This URL is not an internal detail. It is printed in front of people who have
// never heard of us and have no reason to trust a strange domain:
//
//   - the unsubscribe link at the bottom of every marketing email, which lands
//     in the inbox of the MERCHANT'S customer, not the merchant
//   - the src of the popup script, sitting in the page source of the
//     merchant's storefront for anyone who views it
//   - the OAuth consent screen at install
//   - Shopify's own webhook delivery targets
//
// A shopper on a fashion boutique clicks "unsubscribe" and arrives at something
// called tryfit-backend-production.up.railway.app. That reads as a phishing
// link, and the honest response to a phishing link is to report it.
//
// It was also read eleven different ways: most callers checked
// PUBLIC_BASE_URL and fell back to the literal, two ignored the variable
// entirely and hard-coded the host, so setting PUBLIC_BASE_URL moved some
// links and left others behind. That is worse than not supporting it at all —
// half-migrated links are the ones nobody notices.
//
// TO MOVE TO A REAL DOMAIN: point the domain at Railway, set PUBLIC_BASE_URL,
// update application_url / redirect_urls / the webhook URLs in
// shopify.app.smart-advisor2.toml, and run `shopify app deploy`. Nothing else
// in the code needs to change.
// ============================================================================

// The address this app has always answered on. Kept as the last resort so a
// missing variable degrades to "ugly but working" rather than to broken links,
// and warned about loudly at boot because it should not be what ships.
const LEGACY_FALLBACK = 'https://tryfit-backend-production.up.railway.app';

function clean(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  // Must be absolute and https. A bare host ("smartadvisor.co.il") produces
  // links that resolve against our own origin and silently 404, and http
  // downgrades a link we are asking a stranger to click.
  if (!/^https:\/\/[^\/\s]+/i.test(s)) return null;
  return s;
}

let warned = false;

/**
 * The public origin, with no trailing slash. Always returns something usable.
 */
function baseUrl() {
  const explicit = clean(process.env.PUBLIC_BASE_URL);
  if (explicit) return explicit;

  // Railway sets this itself, so a fresh deploy is correct before anyone
  // remembers to configure anything.
  const railway = clean(process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  if (railway) return railway;

  if (!warned) {
    warned = true;
    console.warn('⚠️  PUBLIC_BASE_URL is not set — falling back to ' + LEGACY_FALLBACK);
  }
  return LEGACY_FALLBACK;
}

/** Join a path onto the public origin. url('/unsubscribe') -> https://.../unsubscribe */
function url(path) {
  const p = String(path || '');
  return baseUrl() + (p && !p.startsWith('/') ? '/' + p : p);
}

/**
 * Say, once, at boot, what the outside world is going to see. Silence here is
 * how the old hostname stayed in customers' inboxes for months.
 */
function report() {
  const b = baseUrl();
  console.log(`🌐 Public address: ${b}`);
  if (b === LEGACY_FALLBACK || /railway\.app$/i.test(new URL(b).hostname)) {
    console.warn('⚠️  That hostname is visible to the merchant\'s CUSTOMERS — it is in every');
    console.warn('    unsubscribe link and in the popup script tag on the storefront.');
    console.warn('    Set PUBLIC_BASE_URL to a real domain before onboarding a merchant.');
  }
  return b;
}

module.exports = { baseUrl, url, report, LEGACY_FALLBACK };
