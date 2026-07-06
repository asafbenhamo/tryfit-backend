// ============================================================================
// MESSAGE QUEUE — DB-backed scheduled sending. The backbone of:
//   1. SMART TIMING: send each customer at her personal best hour.
//   2. SEQUENCES (follow-ups): automatic reminder N days after a campaign to
//      whoever didn't convert, with a fresh coupon — the single biggest
//      conversion lever (sequences convert 2-3x one-shot sends).
//   3. RELIABILITY: queued messages live in Postgres, so a Railway redeploy
//      never loses them (unlike in-RAM campaign state).
//
// Safety at SEND time (not enqueue time):
//   - Skip if opted out (covers Flashy sync + local removals).
//   - Skip follow-ups if the customer CONVERTED since (no nagging buyers).
//   - Quiet hours: only send 09:00–20:30 Israel time (spam law: 08:00–21:00).
// ============================================================================

const db = require('./database');
const compliance = require('./compliance');
const smsSender = require('./sms-sender');
const mailer = require('./mailer');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id BIGSERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      channel TEXT NOT NULL,               -- 'sms' | 'email'
      phone TEXT, email TEXT, name TEXT,
      subject TEXT, message TEXT NOT NULL,
      send_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending',       -- pending|sent|failed|skipped|cancelled
      kind TEXT DEFAULT 'timed',           -- 'timed' (smart timing) | 'followup'
      campaign_id TEXT, segment TEXT, step INT DEFAULT 1,
      coupon_pct INT, coupon_days INT DEFAULT 2,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ, error TEXT
    )`).catch(e => console.error('[queue] table:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sched_due
    ON scheduled_messages (status, send_at)`).catch(() => {});
  tableReady = true;
}

// Israel local hour right now (handles DST via tz database).
function israelNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
}

// Compute a legal send time: the next occurrence of `hour` (Israel time) that is
// at least 10 minutes from now, clamped into 09:00–20:30. Returns a JS Date (UTC).
function computeSendAt(hour, daysFromNow = 0) {
  const ilNow = israelNow();
  let h = parseInt(hour);
  if (isNaN(h) || h < 9) h = 10;
  if (h > 20) h = 19;
  const target = new Date(ilNow);
  target.setDate(target.getDate() + daysFromNow);
  target.setHours(h, Math.floor(Math.random() * 30), 0, 0); // spread within half hour
  if (target.getTime() - ilNow.getTime() < 10 * 60 * 1000) {
    target.setDate(target.getDate() + 1); // too soon -> tomorrow same hour
  }
  // Convert "Israel wall clock" back to real UTC instant.
  const diff = new Date().getTime() - ilNow.getTime();
  return new Date(target.getTime() + diff);
}

// Best hour per customer, from their own order history (mode of order hour).
// One batched query; returns { emailLower -> hour }.
async function preferredHours(shop, emails) {
  const map = {};
  const clean = (emails || []).filter(Boolean).map(e => String(e).toLowerCase());
  if (clean.length === 0) return map;
  try {
    const r = await db.query(
      `SELECT LOWER(c.email) AS email,
              MODE() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM o.ordered_at AT TIME ZONE 'Asia/Jerusalem'))::int AS hour
       FROM store_customers c
       JOIN store_orders o ON o.shop_domain = c.shop_domain
        AND o.shopify_customer_id = c.shopify_customer_id
       WHERE c.shop_domain = $1 AND LOWER(c.email) = ANY($2) AND o.ordered_at IS NOT NULL
       GROUP BY LOWER(c.email)`,
      [shop, clean]
    );
    for (const row of r.rows) map[row.email] = row.hour;
  } catch (e) { console.error('[queue] preferredHours:', e.message); }
  return map;
}

async function enqueue(shop, msg) {
  await ensureTable();
  const r = await db.query(
    `INSERT INTO scheduled_messages
       (shop_domain, channel, phone, email, name, subject, message, send_at, kind,
        campaign_id, segment, step, coupon_pct, coupon_days, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [shop, msg.channel, msg.phone || null, msg.email || null, msg.name || null,
     msg.subject || null, msg.message, msg.send_at, msg.kind || 'timed',
     msg.campaign_id || null, msg.segment || null, msg.step || 1,
     msg.coupon_pct || null, msg.coupon_days || 2, JSON.stringify(msg.meta || {})]
  );
  return r.rows[0] && r.rows[0].id;
}

// Did this person convert (attributed purchase) since the message was enqueued?
async function convertedSince(shop, { email, phone }, since) {
  try {
    const r = await db.query(
      `SELECT 1 FROM advisor_actions
       WHERE shop_domain=$1 AND outcome='converted' AND closed_at >= $2
         AND ((target_email IS NOT NULL AND LOWER(target_email)=LOWER($3))
           OR (target_phone IS NOT NULL AND target_phone=$4))
       LIMIT 1`,
      [shop, since, email || '', phone || '']
    );
    return r.rows.length > 0;
  } catch (e) { return false; }
}

// Process all due messages. Runs every few minutes from server-dual.
async function processDue(limit = 60) {
  await ensureTable();
  const due = await db.query(
    `SELECT * FROM scheduled_messages
     WHERE status='pending' AND send_at <= NOW()
     ORDER BY send_at ASC
     FETCH FIRST ${parseInt(limit)} ROWS ONLY`
  ).catch(e => { console.error('[queue] fetch due:', e.message); return { rows: [] }; });

  let sent = 0, skipped = 0, failed = 0, deferred = 0;
  const storeSettings = require('./store-settings');
  const capCache = {}; // shop -> remaining today (fetched once per tick)

  for (const m of due.rows) {
    try {
      // DAILY CAP: queued messages also count against the shop's daily budget.
      // When exhausted, push the message to tomorrow morning instead of sending.
      if (capCache[m.shop_domain] === undefined) {
        try { capCache[m.shop_domain] = (await storeSettings.remainingToday(m.shop_domain)).remaining; }
        catch (e) { capCache[m.shop_domain] = Infinity; }
      }
      if (capCache[m.shop_domain] <= 0) {
        await db.query(`UPDATE scheduled_messages SET send_at = $2 WHERE id=$1`,
          [m.id, computeSendAt(10, 1)]).catch(() => {});
        deferred++;
        continue;
      }

      // 1. Opt-out gate (Flashy-synced + local) — always.
      if (await compliance.isOptedOut(m.shop_domain, { email: m.email, phone: m.phone })) {
        await mark(m.id, 'skipped', null, 'opted_out'); skipped++; continue;
      }
      // 2. Follow-ups only: skip if she already bought (never nag a buyer).
      if (m.kind === 'followup' && await convertedSince(m.shop_domain, m, m.created_at)) {
        await mark(m.id, 'skipped', null, 'already_converted'); skipped++; continue;
      }

      let body = m.message;

      // 3. Follow-ups get a FRESH coupon + tracking link, created at send time
      //    (the original 48h code has expired by day 3).
      if (m.kind === 'followup' && m.coupon_pct) {
        const shopify = require('./shopify-client');
        const namePart = (m.name || 'VIP').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8) || 'VIP';
        const c = await shopify.createDiscountCode(m.shop_domain, {
          percentage: m.coupon_pct,
          code: `${namePart}${m.coupon_pct}${Math.floor(Math.random() * 900 + 100)}`,
          days_valid: m.coupon_days || 2,
          title: `רצף המשך: ${m.name || m.email || m.phone}`
        });
        if (c.ok) {
          let actionId = null;
          try {
            const ins = await db.query(
              `INSERT INTO advisor_actions (shop_domain, action_type, target_email, target_phone, details, coupon_code)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [m.shop_domain, 'followup', m.email, m.phone,
               JSON.stringify({ channel: m.channel, followup: true, segment: m.segment, campaign_id: m.campaign_id, step: m.step }),
               c.code]
            );
            actionId = ins.rows[0] && ins.rows[0].id;
          } catch (e) { /* log-only */ }
          let link = shopify.getPublicDomain(m.shop_domain);
          try {
            const clickTracker = require('./click-tracker');
            const token = await clickTracker.createLink(m.shop_domain,
              { actionId, email: m.email, phone: m.phone, couponCode: c.code });
            let BASE = process.env.PUBLIC_BASE_URL || 'https://tryfit-backend-production.up.railway.app';
            BASE = String(BASE).replace(/^[^=]*=\s*/, '').replace(/['"\s]/g, '').replace(/\/+$/, '');
            if (!/^https?:\/\//.test(BASE)) BASE = 'https://tryfit-backend-production.up.railway.app';
            link = `${BASE}/go/${token}`;
          } catch (e) { /* plain store link */ }
          body = body.replace(/\{COUPON\}/g, c.code).replace(/\{LINK\}/g, link);
        } else {
          // No coupon -> send a soft reminder without a code rather than a broken one.
          body = body.replace(/\{COUPON\}/g, '').replace(/\{LINK\}/g, require('./shopify-client').getPublicDomain(m.shop_domain));
        }
      }

      // 4. Send on the right channel.
      let ok = false, err = null;
      if (m.channel === 'sms' && m.phone && smsSender.isConfigured()) {
        const r = await smsSender.sendOne(m.shop_domain, { phone: m.phone, message: body });
        ok = r.ok; err = r.error || null;
      } else if (m.channel === 'email' && m.email) {
        const qset = await storeSettings.getSettings(m.shop_domain).catch(() => ({}));
        const brand = qset.brand || '770';
        const html = mailer.buildHtmlEmail(body, { brand, language: qset.language, to: m.email });
        const r = await mailer.sendEmail({ to: m.email, subject: m.subject || ('הודעה מ-' + brand), html, text: body, fromName: brand });
        ok = r.ok; err = r.error || null;
      } else {
        await mark(m.id, 'skipped', null, 'no_channel'); skipped++; continue;
      }

      if (ok) { await mark(m.id, 'sent', new Date(), null); sent++; capCache[m.shop_domain]--; }
      else { await mark(m.id, 'failed', null, err); failed++; }

      await new Promise(r => setTimeout(r, 400)); // pace
    } catch (e) {
      await mark(m.id, 'failed', null, e.message).catch(() => {});
      failed++;
    }
  }

  if (sent + skipped + failed + deferred > 0) {
    console.log(`📬 [queue] processed: sent=${sent} skipped=${skipped} failed=${failed} deferred=${deferred}`);
  }
  return { sent, skipped, failed, deferred };
}

async function mark(id, status, sentAt, error) {
  await db.query(
    `UPDATE scheduled_messages SET status=$2, sent_at=$3, error=$4 WHERE id=$1`,
    [id, status, sentAt, error ? String(error).slice(0, 300) : null]
  ).catch(e => console.error('[queue] mark:', e.message));
}

// Quick stats for reporting ("what's waiting to go out").
async function pendingStats(shop) {
  await ensureTable();
  try {
    const r = await db.query(
      `SELECT kind, COUNT(*)::int AS n, MIN(send_at) AS next_at
       FROM scheduled_messages WHERE shop_domain=$1 AND status='pending'
       GROUP BY kind`, [shop]);
    return { ok: true, pending: r.rows };
  } catch (e) { return { ok: false, error: e.message }; }
}

function startScheduler() {
  ensureTable().then(() => {
    setInterval(() => { processDue().catch(e => console.error('[queue] tick:', e.message)); },
      3 * 60 * 1000); // every 3 minutes
    console.log('📬 [queue] scheduler started (every 3 min)');
  });
}

module.exports = { ensureTable, enqueue, processDue, preferredHours, computeSendAt, pendingStats, startScheduler };