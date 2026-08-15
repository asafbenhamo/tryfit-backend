# Security & Data Protection — Smart Advisor

This document is the written basis for the answers given on Shopify's
protected-customer-data questionnaire. Every claim in it points at the code
that makes it true; if the code changes, this document must change with it.

## What personal data the app processes, and why

| Data | Purpose |
|---|---|
| Customer name | Personalizing messages sent on the merchant's behalf |
| Customer email | Primary marketing channel; unsubscribe handling |
| Customer phone | SMS / WhatsApp marketing where the customer consented |
| Customer address (city/region) | Regional segmentation of campaigns |
| Order history | RFM segmentation and sale attribution |

Processing is limited to these purposes. Data is never sold, never pooled
across merchants, and never used to train models. Cross-tenant isolation is
enforced per shop domain on every query and covered by `test-tenancy.js`.

The public statement of this is served at `/privacy`, and forms part of the
terms served at `/terms`, which the merchant accepts in-app
(`advisor_stores.terms_accepted_at`).

## Consent

- A customer whose Shopify record says they **declined marketing** is
  hard-blocked from every send path (`compliance.hasDeclinedMarketing`).
- Opt-outs (unsubscribe link, SMS STOP) are honoured on every channel and are
  never overridable (`compliance.isOptedOut`; `test-webhooks-unsub.js`,
  `test-unsubscribe-live.js`).
- Popup signups store the full consent record: IP, user agent, page, and the
  exact consent wording shown (`popup_subscribers`).
- Automated decisions here select marketing audiences and offer sizes. They
  have no legal or similarly significant effect on customers; a customer can
  exit all of it by unsubscribing.

## Storage

- **In transit**: TLS on every connection (Railway HTTPS, Shopify HTTPS).
- **At rest**: the database runs on Railway's managed Postgres (encrypted
  volumes, encrypted backups). Credentials — Shopify access tokens, refresh
  tokens, merchant passwords, WhatsApp API keys — are additionally encrypted
  at the application layer with AES-256-GCM (`crypto-vault.js`), verified
  live via `/api/health/security`.
- **Retention**: on uninstall the store's access token is cleared immediately
  (`deactivateStore`) and Shopify's `shop/redact` webhook (sent ~48h later)
  deletes the shop's data across all tables. `customers/redact` deletes an
  individual customer on request. Session tokens expire after 14 days; login
  codes after 10 minutes.
- **Test vs production data**: testing uses synthetic customers only, created
  by `seed-demo-store.js` into development stores. The seeder refuses
  non-development stores and tags everything it makes `seeded-demo`.

## Access

- Staff access: one operator. Platform-level access requires the master
  password (timing-safe comparison) plus an emailed one-time code
  (`login-2fa.js`). Merchant access requires their own credentials or a
  Shopify-signed session token (`shopify-session-token.js`).
- Password policy: minimum 12 characters is warned on at boot; operator
  passwords are long random strings, rotated when exposure is suspected.
- **Access logging**: reads of customer personal data are recorded in
  `pcd_access_log` (shop, actor, purpose, row count, time) via `pcd-log.js`,
  wrapped over every customer-reading tool and the autopilot's RFM scoring.
  Outbound messages are separately recorded in `advisor_actions`; sign-ins in
  `advisor_sessions` with IP and user agent.

## Incident response policy

On suspicion or confirmation of a security incident (leaked credential,
unauthorized access, data exposure):

1. **Contain** — immediately rotate the affected credential(s): Railway env
   vars for platform secrets, `revokeAllForShop` for merchant sessions,
   Shopify app secret rotation in the Dev Dashboard for app credentials.
   `SHOPIFY_API_SECRET_PREVIOUS` support exists so webhook verification
   survives an emergency secret rotation.
2. **Assess** — use `pcd_access_log`, `advisor_sessions` and Railway request
   logs to establish what was accessed, for which shops, over what window.
3. **Notify** — inform affected merchants with what was accessed and when.
   Where customer personal data was exposed, tell the merchant so they can
   meet their own notification duties, and cooperate with Shopify's
   requirements for the app.
4. **Remediate** — fix the root cause before restoring any disabled surface;
   add a regression test that fails on the vulnerable behaviour.
5. **Record** — write the incident down: timeline, scope, cause, fix.

## Third-party processors

| Processor | Role |
|---|---|
| Railway | Hosting and managed Postgres |
| Anthropic | Message drafting and the in-app agent (no data retained for training) |
| Resend | Email delivery |
| TextMe | SMS delivery (Israel) |
| 360dialog | WhatsApp delivery, only where the merchant configured it |

## Audits and certifications

None yet. This section must be updated when one exists, and must not be
claimed on any form until it does.
