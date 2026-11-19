// WhatsApp admin commands: lets 1-2 trusted numbers run batches by texting the business number.
//   send 50   -> plan only (nothing is sent), bot replies with what it would do
//   confirm   -> actually sends that planned batch (must be within ADMIN_CONFIRM_TTL_MIN minutes)
//   status    -> counts + capacity + whether a batch is running
//   stop      -> aborts a running batch (or cancels a pending plan)
//   cancel    -> drops a pending plan
//   help
// Only numbers in ADMIN_PHONES are listened to. Anything that is not a recognised command is ignored here and
// continues through the normal lead pipeline (so an admin who is also a test lead can still test replies).
const config = require('./config');
const { normalizePhone } = require('./phone');
const wa = require('./whatsapp');
const { runBatch, pickLeads, remainingCapacity } = require('./batch');

const state = {
  plan: null, // { by, count, requested, expiresAt }
  running: false,
  stop: false,
  progress: null, // { done, total }
  startedBy: '',
};

const adminSet = () => new Set(config.adminPhones.map(normalizePhone).filter(Boolean));
const isAdmin = (phone) => adminSet().has(phone);

// "send 50", "Send --50", "send message 50", "initiate process —50" -> { cmd: 'send', n: 50 }
function parseCommand(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[‐-―−-]+/g, ' ') // hyphens, en/em dashes (chat apps turn "--" into "—")
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const send = t.match(/^(?:send|initiate|start)(?: (?:messages?|process|batch))?(?: (\d+))?$/);
  if (send) return { cmd: 'send', n: send[1] === undefined ? NaN : Number(send[1]) };
  if (t === 'confirm') return { cmd: 'confirm' };
  if (t === 'status') return { cmd: 'status' };
  if (['stop', 'stop batch', 'abort'].includes(t)) return { cmd: 'stop' };
  if (t === 'cancel') return { cmd: 'cancel' };
  if (['help', 'commands'].includes(t)) return { cmd: 'help' };
  return null;
}

const HELP = [
  'Commands:',
  '• send 50 – plan a batch of up to 50 (nothing is sent yet)',
  '• confirm – start the planned batch',
  '• status – numbers, capacity, batch progress',
  '• stop – abort a running batch',
  '• cancel – drop the pending plan',
].join('\n');

const progressLine = () => (state.progress ? `${state.progress.done}/${state.progress.total}` : 'starting');

function skippedLine(skipped) {
  const parts = [
    [skipped.optedOut, 'opted out'], [skipped.alreadySent, 'already sent'], [skipped.invalid, 'invalid number'],
    [skipped.failed, 'failed before'], [skipped.cooldown, 'cooling down'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length ? `Skipped while picking: ${parts.join(', ')}` : '';
}

function doneText(s) {
  const errs = Object.entries(s.errors || {}).map(([code, n]) => `${code} ×${n}`).join(', ');
  const lines = [`✅ Done. Sent ${s.sent}, failed ${s.failed}${errs ? ` (${errs})` : ''}.`];
  if (s.stopReason === 'user') lines[0] = `🛑 Stopped. Sent ${s.sent}, failed ${s.failed}${errs ? ` (${errs})` : ''}. Rest not sent.`;
  if (s.stopReason === 'protect') {
    lines[0] = `⚠️ Stopped early to protect the number. Sent ${s.sent}, failed ${s.failed}${errs ? ` (${errs})` : ''}.`;
    lines.push('Check the Log tab before sending more.');
  }
  return lines.join('\n');
}

async function statusText(store) {
  if (Date.now() - store.lastLoad > 15000) await store.load();
  const rows = store.rows.map((r) => r.data);
  const count = (fn) => rows.filter(fn).length;
  const cap = remainingCapacity(store.rows, config.dailySendCap);
  const waiting = pickLeads(store.rows, { limit: Infinity }).picked.length;
  return [
    '📊 Status',
    `Sent: ${count((d) => d.sent_at)} total, ${cap.used} in last 24h (${cap.remaining} of ${config.dailySendCap} left today)`,
    `Delivered: ${count((d) => d.delivered_at)} · Read: ${count((d) => d.read_at)} · Failed: ${count((d) => d.status === 'failed')}`,
    `Replies: ${count((d) => d.reply_type)} (interested ${count((d) => d.interested === 'yes')}, not interested ${count((d) => d.interested === 'no')}, opted out ${count((d) => String(d.do_not_contact).toLowerCase() === 'yes')})`,
    `Waiting to be sent: ${waiting}`,
    `Batch: ${state.running ? `running ${progressLine()}` : 'idle'}`,
  ].join('\n');
}

async function runInBackground(phone, plan, store, reply) {
  try {
    const summary = await runBatch({
      limit: plan.count,
      send: true,
      delay: config.adminSendDelayMs,
      progressEvery: config.adminProgressEvery,
      shouldStop: () => state.stop,
      onProgress: (s) => {
        state.progress = { done: s.sent + s.failed, total: s.planned };
        reply(`⏳ ${state.progress.done}/${state.progress.total} done (${s.failed} failed)`);
      },
    }, store);
    await reply(doneText(summary));
  } catch (err) {
    console.error('[admin] batch crashed:', err);
    await reply(`❌ Batch crashed: ${err.message}\nSome messages may already be out - check the Sheet before sending again.`);
  } finally {
    state.running = false;
    state.stop = false;
    state.progress = null;
    state.startedBy = '';
  }
}

// Returns true when the message was an admin command (and has been handled), false to let the normal pipeline run.
async function handle({ phone, text, store }) {
  if (!isAdmin(phone)) return false;
  const c = parseCommand(text);
  if (!c) return false;
  store.log('admin', phone, c.cmd, '', text);
  const reply = (body) => wa.sendText(phone, body).catch((err) => console.warn('[admin] reply failed:', err.message));

  if (c.cmd === 'help') { await reply(HELP); return true; }

  if (c.cmd === 'status') { await reply(await statusText(store)); return true; }

  if (c.cmd === 'stop') {
    if (state.running) {
      state.stop = true;
      await reply('🛑 Stopping after the current message...');
    } else if (state.plan) {
      state.plan = null;
      await reply('Pending plan cancelled.');
    } else {
      await reply('Nothing is running.');
    }
    return true;
  }

  if (c.cmd === 'cancel') {
    if (state.plan) { state.plan = null; await reply('Pending plan cancelled.'); }
    else if (state.running) await reply('A batch is running. Send STOP to abort it.');
    else await reply('No pending plan.');
    return true;
  }

  if (c.cmd === 'send') {
    if (!(c.n >= 1)) { await reply('Tell me how many, e.g. "send 50".'); return true; }
    if (state.running) {
      await reply(`A batch is already running (${progressLine()}). STATUS for progress, STOP to abort.`);
      return true;
    }
    const requested = Math.min(c.n, config.adminMaxBatch);
    let plan;
    try {
      plan = await runBatch({ limit: requested, send: false, delay: 0 }, store);
    } catch (err) {
      await reply(`❌ Could not read the sheet: ${err.message}`);
      return true;
    }
    const skipped = skippedLine(plan.skipped);
    if (plan.planned === 0) {
      const why = plan.capacity.remaining === 0
        ? `Daily limit reached (${config.dailySendCap} per rolling 24h).`
        : 'No eligible customers left.';
      await reply(['Nothing to send. ' + why, skipped].filter(Boolean).join('\n'));
      return true;
    }
    state.plan = { by: phone, count: plan.planned, requested: c.n, expiresAt: Date.now() + config.adminConfirmTtlMin * 60 * 1000 };
    const lines = [`📋 Plan: send the offer to ${plan.planned} customers.`];
    if (c.n > config.adminMaxBatch) lines.push(`(Max per command is ${config.adminMaxBatch}.)`);
    if (plan.planned < requested) {
      lines.push(plan.capacity.remaining < requested
        ? `(You asked for ${requested}; only ${plan.capacity.remaining} fit in today's limit.)`
        : `(You asked for ${requested}; only ${plan.planned} eligible.)`);
    }
    if (skipped) lines.push(skipped);
    lines.push(`Daily capacity: ${plan.capacity.remaining} left of ${config.dailySendCap}. Template: ${config.templateName}`);
    lines.push(`Reply CONFIRM within ${config.adminConfirmTtlMin} min to start, or CANCEL.`);
    await reply(lines.join('\n'));
    return true;
  }

  if (c.cmd === 'confirm') {
    if (state.running) {
      await reply(`A batch is already running (${progressLine()}).`);
      return true;
    }
    const plan = state.plan;
    if (!plan) { await reply('No pending plan. Send e.g. "send 50" first.'); return true; }
    if (plan.by !== phone) {
      await reply('The pending plan was made by another admin. Send your own "send N" first.');
      return true;
    }
    if (Date.now() > plan.expiresAt) {
      state.plan = null;
      await reply('That plan expired. Send "send N" again.');
      return true;
    }
    state.plan = null;
    state.running = true;
    state.stop = false;
    state.progress = { done: 0, total: plan.count };
    state.startedBy = phone;
    await reply(`🚀 Sending to ${plan.count} customers. I'll update you every ${config.adminProgressEvery}. STOP to abort.`);
    runInBackground(phone, plan, store, reply); // intentionally not awaited: webhook queue must keep moving
    return true;
  }

  return false;
}

module.exports = { handle, isAdmin, parseCommand, state };
