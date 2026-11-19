// Usage:
//   node scripts/send-batch.js --limit 500                 (plan only, nothing sent)
//   node scripts/send-batch.js --limit 500 --send          (really sends)
//   node scripts/send-batch.js --only 9198xxxxxxxx,9199xxxxxxxx --send   (test numbers; re-sends allowed)
// Options: --delay 200 (ms between messages), --retry-failed,
//          --force (override the 24h cooldown after a refused send / 15 min test-number cooldown / daily cap)
const { backend } = require('../src/sheets');
const { runBatch, pickLeads, remainingCapacity } = require('../src/batch');

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
