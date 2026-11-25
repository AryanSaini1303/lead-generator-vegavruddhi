const express = require('express');
const config = require('./config');
const { LeadStore, backend } = require('./sheets');
const { normalizePhone, fmtTime } = require('./phone');
const { verifySignature, sendText } = require('./whatsapp');
const { classify } = require('./classifier');
const admin = require('./admin');

const store = new LeadStore(backend);

// Status only moves forward, so a late "delivered" never overwrites "interested".
const RANK = {
  '': 0, pending: 0, failed: 1, sent: 1, delivered: 2, read: 3,
  replied: 4, not_interested: 5, interested: 5, opted_out: 6,
};
const canSet = (current, next) => (RANK[next] ?? 0) >= (RANK[current] ?? 0);

const processed = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  if (processed.size > 5000) processed.delete(processed.values().next().value);
  return false;
}

function appendLine(existing, line) {
  return `${existing ? `${existing}\n` : ''}${line}`.slice(-4000);
}

async function handleStatus(s) {
  const phone = normalizePhone(s.recipient_id);
  store.log('status', phone, s.status, s.id, s.errors ? JSON.stringify(s.errors) : '');
  const row = await store.find(phone);
  if (!row) return;
  const when = fmtTime(Number(s.timestamp) * 1000);
  const fields = {};
  if (s.status === 'sent' && canSet(row.data.status, 'sent')) fields.status = 'sent';
  if (s.status === 'delivered') {
    if (!row.data.delivered_at) fields.delivered_at = when;
    if (canSet(row.data.status, 'delivered')) fields.status = 'delivered';
  }
  if (s.status === 'read') {
    if (!row.data.read_at) fields.read_at = when;
    if (!row.data.delivered_at) fields.delivered_at = when;
    if (canSet(row.data.status, 'read')) fields.status = 'read';
  }
  if (s.status === 'failed') {
    const err = s.errors?.[0];
    fields.error = err ? `${err.code}: ${err.title || err.message || ''}` : 'delivery failed';
    if (canSet(row.data.status, 'failed')) fields.status = 'failed';
  }
  if (Object.keys(fields).length) store.update(row, fields);
}

async function handleMessage(m) {
  if (alreadySeen(m.id)) return;
  const phone = normalizePhone(m.from);

  let replyType = 'text';
  let text = '';
  let payload = '';
  if (m.type === 'button') {
    replyType = 'button';
    text = m.button?.text || '';
    payload = String(m.button?.payload || '').toUpperCase();
  } else if (m.type === 'interactive') {
    const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
    replyType = 'button';
    text = r.title || '';
    payload = String(r.id || '').toUpperCase();
  } else if (m.type === 'text') {
    text = m.text?.body || '';
  } else {
    replyType = m.type;
    text = `[${m.type}]`;
  }

  // Admin commands (send N / confirm / status / stop) are consumed here; anything else falls through as a normal reply.
  if (m.type === 'text' && await admin.handle({ phone, text, store })) return;

  store.log('in', phone, m.type, m.id, text);
  const row = await store.find(phone);
  if (!row) {
    console.warn(`[webhook] reply from number not in sheet: ${phone}`);
    return;
  }

  let decision;
  if (['YES', 'NO', 'STOP'].includes(payload)) {
    const intent = { YES: 'interested', NO: 'not_interested', STOP: 'stop' }[payload];
    decision = { intent, source: 'button' };
  } else if (m.type === 'text' || m.type === 'button' || m.type === 'interactive') {
    decision = await classify(text);
  } else {
    decision = { intent: 'needs_review', source: 'rule', summary: `Sent a ${m.type} message` };
  }

  const fields = {
    reply_type: replyType,
    reply_text: appendLine(row.data.reply_text, `[${fmtTime(Number(m.timestamp) * 1000)}] ${text}`),
    intent: decision.intent,
  };
  if (decision.summary) fields.ai_summary = decision.summary;
  if (decision.pincode) fields.pincode = decision.pincode;

  let nextStatus = 'replied';
  if (decision.source === 'button' && decision.intent === 'interested') {
    fields.interested = 'yes';
    nextStatus = 'interested';
  } else if (decision.source === 'button' && decision.intent === 'not_interested') {
    fields.interested = 'no';
    nextStatus = 'not_interested';
  }
  if (decision.intent === 'stop') {
    fields.do_not_contact = 'yes';
    nextStatus = 'opted_out';
  }
  if (canSet(row.data.status, nextStatus)) fields.status = nextStatus;
  store.update(row, fields);

  if (config.ackReplies) {
    const ack = decision.intent === 'stop' ? config.ackStop
      : decision.source === 'button' && decision.intent === 'interested' ? config.ackYes
      : decision.source === 'button' && decision.intent === 'not_interested' ? config.ackNo
      : '';
    if (ack) await sendText(phone, ack).catch((err) => console.warn('[ack] failed:', err.message));
  }
}

async function processPayload(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const fromId = value.metadata?.phone_number_id;
      if (config.acceptedPhoneNumberIds.length && !config.acceptedPhoneNumberIds.includes(fromId)) {
        // never drop silently: this is how a wrong/stale WA_PHONE_NUMBER_ID shows up
        const detail = `ignored event for phone_number_id=${fromId} (${value.metadata?.display_phone_number}); accepted: ${config.acceptedPhoneNumberIds.join(', ')}`;
        console.warn(`[webhook] ${detail}`);
        store.log('ignored', '', 'wrong_number_id', '', detail);
        continue;
      }
      for (const s of value.statuses || []) await handleStatus(s);
      for (const m of value.messages || []) await handleMessage(m);
    }
  }
}

// Events are processed one at a time, in arrival order.
let queue = Promise.resolve();
function enqueue(body) {
  queue = queue.then(() => processPayload(body)).catch((err) => console.error('[webhook] processing error:', err));
  return queue;
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ ok: true, rows: store.rows.length }));

  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // answer Meta immediately, work afterwards
    enqueue(req.body);
    return undefined;
  });
  return app;
}

async function start() {
  if (!backend) throw new Error('SHEET_ID is not set (or set MOCK_SHEETS=true for a dry run)');
  await store.load();
  console.log(`[startup] loaded ${store.rows.length} leads from "${config.leadsTab}"`);
  console.log(`[startup] admin numbers: ${config.adminPhones.length ? config.adminPhones.map((p) => p.replace(/\d(?=\d{4})/g, '*')).join(', ') : 'none (admin commands disabled)'}`);
  console.log(`[startup] accepting webhook events for phone_number_id: ${config.acceptedPhoneNumberIds.join(', ') || 'ANY'}`);
  setInterval(() => store.load().catch((err) => console.warn('[reload] failed:', err.message)), 120000).unref();

  const server = createApp().listen(config.port, () => console.log(`[startup] listening on :${config.port}`));
  const shutdown = async () => {
    console.log('[shutdown] flushing pending writes');
    server.close();
    await store.drain().catch((err) => console.error(err.message));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { createApp, processPayload, enqueue, store };
