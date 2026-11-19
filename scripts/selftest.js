// End-to-end check with no credentials: fake sheet in memory + fake WhatsApp.
//   npm run selftest
process.env.MOCK_SHEETS = 'true';
process.env.MOCK_WHATSAPP = 'true';
process.env.FLUSH_INTERVAL_MS = '50';
process.env.SKIP_SIGNATURE_CHECK = 'true';
process.env.OPENAI_API_KEY = '';
process.env.WA_PHONE_NUMBER_ID = '111';
process.env.TEMPLATE_HEADER_TYPE = 'video';
process.env.TEMPLATE_HEADER_MEDIA_ID = ''; // selftest must not depend on the real .env
process.env.TEMPLATE_HEADER_URL = 'https://example.com/offer.mp4';

const assert = require('assert');
const { backend, setupSheet } = require('../src/sheets');
const { runBatch } = require('./send-batch');
const { processPayload, store } = require('../src/server');
const { ruleClassify } = require('../src/classifier');
const { normalizePhone } = require('../src/phone');
const { buildTemplatePayload } = require('../src/whatsapp');

const status = (phone, st, ts = 1700000000) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, statuses: [{ id: 'x', status: st, timestamp: String(ts), recipient_id: phone }] } }] }],
});
const message = (id, from, msg) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, messages: [{ id, from, timestamp: '1700000100', ...msg }] } }] }],
});
const rowOf = (phone) => store.byPhone.get(phone).data;

(async () => {
  // phones + rules
  assert.strictEqual(normalizePhone('+91 98765-43210'), '919876543210');
  assert.strictEqual(normalizePhone('09876543210'), '919876543210');
  assert.strictEqual(ruleClassify('Haan!').intent, 'interested');
  assert.strictEqual(ruleClassify('abhi nahi').intent, 'not_interested');
  assert.strictEqual(ruleClassify('please band karo ye messages').intent, 'stop');
  assert.strictEqual(ruleClassify('subsidy kitni milegi?'), null);

  // media header is attached, in the order WhatsApp expects: header, body, 3 buttons
  const payload = buildTemplatePayload('919876543210', 'Rahul Sharma');
  const comps = payload.template.components;
  assert.deepStrictEqual(comps.map((c) => c.type), ['header', 'body', 'button', 'button', 'button']);
  assert.deepStrictEqual(comps[0].parameters[0], { type: 'video', video: { link: 'https://example.com/offer.mp4' } });
  assert.strictEqual(comps[1].parameters[0].text, 'Rahul');
  assert.deepStrictEqual(comps.slice(2).map((c) => c.parameters[0].payload), ['YES', 'NO', 'STOP']);

  // daily cap: sends in the last 24h use up the allowance
  const { remainingCapacity } = require('./send-batch');
  const rows = [{ data: { sent_at: '17/11/2026, 10:00:00' } }, { data: { sent_at: '10/11/2026, 10:00:00' } }, { data: {} }];
  const nowMs = Date.UTC(2026, 10, 17, 6, 0, 0); // 11:30 IST on the 17th
  assert.deepStrictEqual(remainingCapacity(rows, 250, nowMs), { used: 1, remaining: 249 });

  // sheet setup keeps the user's own columns and adds the missing ones
  backend.seed('Leads', [
    ['phone', 'name', 'city'],
    ['9876543210', 'Rahul Sharma', 'Delhi'],
    ['9123456780', 'priya verma', 'Pune'],
    ['9000000001', 'Amit Kumar', 'Agra'],
    ['abc', 'Bad Number', 'X'],
  ]);
  const setup = await setupSheet(backend);
  assert(setup.addedLeadColumns.includes('do_not_contact'));
  const header = backend.tabs.Leads[0];
  assert.deepStrictEqual(header.slice(0, 3), ['phone', 'name', 'city']);
  backend.tabs.Leads[3][header.indexOf('do_not_contact')] = 'yes'; // Amit already opted out

  // plan only sends nothing; real run sends 2 (skips opted-out + invalid)
  const plan = await runBatch({ limit: 10, send: false, delay: 0 }, store);
  assert.strictEqual(plan.planned, 2);
  assert.strictEqual(plan.sent, 0);
  const run = await runBatch({ limit: 10, send: true, delay: 0 }, store);
  assert.strictEqual(run.sent, 2);
  await store.load();
  assert(rowOf('919876543210').wamid.startsWith('wamid.MOCK'));
  const again = await runBatch({ limit: 10, send: true, delay: 0 }, store);
  assert.strictEqual(again.planned, 0, 'second run must not message anyone twice');

  // cooldown: a number just messaged cannot be re-sent in test mode without --force
  const blocked = await runBatch({ limit: 10, send: false, delay: 0, only: ['9876543210'] }, store);
  assert.strictEqual(blocked.planned, 0);
  const forced = await runBatch({ limit: 10, send: false, delay: 0, only: ['9876543210'], force: true }, store);
  assert.strictEqual(forced.planned, 1);
  // ...and a number Meta refused (131049) stays blocked for 24h even after the 15 min window
  const refusedRow = store.byPhone.get('919123456780');
  store.update(refusedRow, { status: 'failed', error: '131049: not delivered', sent_at: '15/11/2020, 10:00:00' });
  const { pickLeads } = require('./send-batch');
  const recent = pickLeads(store.rows, { limit: 10, only: ['9123456780'] }, Date.UTC(2020, 10, 15, 5, 0, 0) + 3600e3);
  assert.strictEqual(recent.picked.length, 0, 'refused number must wait 24h');
  const later = pickLeads(store.rows, { limit: 10, only: ['9123456780'] }, Date.UTC(2020, 10, 17));
  assert.strictEqual(later.picked.length, 1, 'allowed again after 24h');
  // a payment failure (131042) is not a recipient cap: retry allowed once the 15 min window has passed
  store.update(refusedRow, { status: 'failed', error: '131042: Business eligibility payment issue' });
  const payFail = pickLeads(store.rows, { limit: 10, only: ['9123456780'] }, Date.UTC(2020, 10, 15, 5, 0, 0) + 3600e3);
  assert.strictEqual(payFail.picked.length, 1, 'payment failures can be retried');
  store.update(refusedRow, { status: 'sent', error: '' });

  // status webhooks, including out-of-order delivery
  await processPayload(status('919876543210', 'sent'));
  await processPayload(status('919876543210', 'delivered'));
  await processPayload(status('919876543210', 'read'));
  await processPayload(status('919876543210', 'delivered')); // late duplicate must not downgrade
  assert.strictEqual(rowOf('919876543210').status, 'read');

  // button YES
  const yes = message('m1', '919876543210', { type: 'button', button: { payload: 'YES', text: 'Haan, bataiye' } });
  await processPayload(yes);
  await processPayload(yes); // webhook retry
  assert.strictEqual(rowOf('919876543210').interested, 'yes');
  assert.strictEqual(rowOf('919876543210').status, 'interested');
  assert.strictEqual(rowOf('919876543210').reply_text.split('\n').length, 1, 'duplicate event ignored');
  await processPayload(status('919876543210', 'delivered')); // ack delivery after YES
  assert.strictEqual(rowOf('919876543210').status, 'interested');

  // free text with no LLM key -> needs_review, STOP by text -> opted out
  await processPayload(message('m2', '919123456780', { type: 'text', text: { body: 'subsidy kitni milegi?' } }));
  assert.strictEqual(rowOf('919123456780').intent, 'needs_review');
  assert.strictEqual(rowOf('919123456780').status, 'replied');
  await processPayload(message('m3', '919123456780', { type: 'text', text: { body: 'band karo plz' } }));
  assert.strictEqual(rowOf('919123456780').do_not_contact, 'yes');
  assert.strictEqual(rowOf('919123456780').status, 'opted_out');

  // events for a different phone number are not silently lost: they land in the Log tab
  const foreign = message('m9', '919876543210', { type: 'text', text: { body: 'haan' } });
  foreign.entry[0].changes[0].value.metadata = { phone_number_id: '999', display_phone_number: '911234' };
  await processPayload(foreign);
  await store.drain();
  assert(backend.tabs.Log.some((r) => r[1] === 'ignored' && r[5].includes('999')), 'ignored event must be logged');

  // everything reaches the (fake) sheet
  await store.drain();
  const sheet = backend.tabs.Leads;
  const col = (name) => sheet[0].indexOf(name);
  assert.strictEqual(sheet[1][col('interested')], 'yes');
  assert.strictEqual(sheet[2][col('do_not_contact')], 'yes');
  assert(backend.tabs.Log.length > 5);

  // opted-out customer is never picked again
  const final = await runBatch({ limit: 10, send: false, delay: 0 }, store);
  assert.strictEqual(final.planned, 0);

  console.log('\nselftest passed ✔');
  process.exit(0);
})().catch((err) => { console.error('\nselftest FAILED:', err); process.exit(1); });
