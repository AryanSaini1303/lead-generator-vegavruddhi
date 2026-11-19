// Usage:
//   node scripts/send-batch.js --limit 500                 (plan only, nothing sent)
//   node scripts/send-batch.js --limit 500 --send          (really sends)
//   node scripts/send-batch.js --only 9198xxxxxxxx,9199xxxxxxxx --send   (test numbers; re-sends allowed)
// Options: --delay 200 (ms between messages), --retry-failed,
//          --force (override the 24h cooldown after a refused send / 15 min test-number cooldown / daily cap)
const config = require('../src/config');
const { LeadStore, backend } = require('../src/sheets');
const { normalizePhone, isValidPhone, fmtTime } = require('../src/phone');
const wa = require('../src/whatsapp');

const isYes = (v) => ['yes', 'true', 'y', '1'].includes(String(v || '').trim().toLowerCase());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// "15/11/2026, 21:46:03" (IST, as written by fmtTime) -> epoch ms
function parseIst(text) {
  const m = String(text || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi, sec] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, sec) - 5.5 * 3600 * 1000;
}

const HOUR = 3600 * 1000;
const FATAL_CODES = new Set([130429, 131048, 131056, 131049, 131047, 190]); // rate limit, spam limit, bad token...

function pickLeads(rows, { limit, only, retryFailed, force }, now = Date.now()) {
  const onlySet = only ? new Set(only.map(normalizePhone)) : null;
  const picked = [];
  const skipped = { invalid: 0, optedOut: 0, alreadySent: 0, failed: 0, cooldown: 0 };
  for (const row of rows) {
    const phone = normalizePhone(row.data.phone);
    if (onlySet && !onlySet.has(phone)) continue;
    if (!isValidPhone(phone)) { skipped.invalid += 1; continue; }
    if (isYes(row.data.do_not_contact) || row.data.status === 'opted_out') { skipped.optedOut += 1; continue; }
    // Protect the number: never re-message someone Meta capped (error 131049 = per-user marketing
    // cap, wait 24h), and never double-send a test number within 15 minutes. Other failures
    // (e.g. 131042 payment) are ours to fix, so those can be retried after the 15 min window.
    const lastSent = parseIst(row.data.sent_at);
    if (!force && lastSent) {
      const age = now - lastSent;
      const refused = String(row.data.error).startsWith('131049');
      if ((refused && age < 24 * HOUR) || (onlySet && age < 15 * 60 * 1000)) { skipped.cooldown += 1; continue; }
    }
    if (!onlySet) {
      if (row.data.sent_at) { skipped.alreadySent += 1; continue; }
      if (row.data.status === 'failed' && !retryFailed) { skipped.failed += 1; continue; }
    }
    picked.push({ row, phone });
    if (picked.length >= limit) break;
  }
  return { picked, skipped };
}

// How many more business-initiated sends fit in Meta's rolling-24h limit (counts every send, to be safe).
function remainingCapacity(rows, cap, now = Date.now()) {
  const used = rows.filter((r) => {
    const t = parseIst(r.data.sent_at);
    return t && now - t < 24 * HOUR;
  }).length;
  return { used, remaining: Math.max(0, cap - used) };
}

async function runBatch(opts, store = new LeadStore(backend)) {
  await store.load();
  const capacity = remainingCapacity(store.rows, config.dailySendCap);
  const effectiveLimit = opts.force ? opts.limit : Math.min(opts.limit, capacity.remaining);
  console.log(`Daily cap ${config.dailySendCap}: ${capacity.used} already sent in the last 24h, ${capacity.remaining} left.`);
  const { picked, skipped } = pickLeads(store.rows, { ...opts, limit: effectiveLimit });
  const batchId = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Eligible this run: ${picked.length} (limit ${effectiveLimit}). Skipped:`, skipped);
  const summary = { planned: picked.length, sent: 0, failed: 0, stopped: false, skipped };
  if (!opts.send) {
    console.log('Plan only. Add --send to actually send.');
    return summary;
  }

  let consecutiveFailures = 0;
  for (const { row, phone } of picked) {
    try {
      const res = await wa.sendTemplate(phone, row.data.name);
      store.update(row, { sent_at: fmtTime(), wamid: res.messages?.[0]?.id || '', batch_id: batchId, error: '' });
      store.log('out', phone, 'template', res.messages?.[0]?.id, config.templateName);
      summary.sent += 1;
      consecutiveFailures = 0;
    } catch (err) {
      summary.failed += 1;
      consecutiveFailures += 1;
      store.update(row, { status: 'failed', error: `${err.details?.code || ''} ${err.message}`.trim(), batch_id: batchId });
      console.warn(`  failed ${phone}: ${err.message}`);
      if (FATAL_CODES.has(err.details?.code) || consecutiveFailures >= 3) {
        console.error('Stopping batch early to protect the number (rate limit / repeated failures).');
        summary.stopped = true;
        break;
      }
    }
    if ((summary.sent + summary.failed) % 20 === 0) await store.flush().catch(() => {});
    await sleep(opts.delay);
  }
  await store.drain();
  console.log(`Done. sent=${summary.sent} failed=${summary.failed} batch="${batchId}"`);
  return summary;
}

function parseArgs(argv) {
  const opts = { limit: 500, send: false, delay: 200, only: null, retryFailed: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--send') opts.send = true;
    else if (a === '--retry-failed') opts.retryFailed = true;
    else if (a === '--force') opts.force = true;
  }
  return opts;
}

if (require.main === module) {
  if (!backend) { console.error('Set SHEET_ID in .env first'); process.exit(1); }
  runBatch(parseArgs(process.argv.slice(2))).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { runBatch, pickLeads, remainingCapacity };
