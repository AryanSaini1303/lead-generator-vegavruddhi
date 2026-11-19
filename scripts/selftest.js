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
process.env.ADMIN_PHONES = '9000000009,9000000020'; // 9000000020 is also a lead row (admin who tests replies)
process.env.ADMIN_SEND_DELAY_MS = '120';
process.env.ADMIN_PROGRESS_EVERY = '2';
process.env.ADMIN_MAX_BATCH = '500';
process.env.ADMIN_CONFIRM_TTL_MIN = '5';

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

  // ---- admin WhatsApp commands ----
  const wa = require('../src/whatsapp');
  const admin = require('../src/admin');
  const texts = [];
  wa.sendText = async (to, body) => { texts.push({ to, body }); return { messages: [{ id: 'wamid.TEXT' }] }; };
  const last = () => texts[texts.length - 1];
  let msgNo = 0;
  const say = (from, body) => processPayload(message(`adm${msgNo += 1}`, from, { type: 'text', text: { body } }));
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const A = '919000000009'; // admin who is not in the sheet
  const B = '919000000020'; // admin who is also a lead
  for (let i = 11; i <= 20; i += 1) backend.tabs.Leads.push([`90000000${i}`, `Lead ${i}`, 'City']);
  await store.drain();
  await store.load();
  const sentCount = () => store.rows.filter((r) => r.data.phone.startsWith('90000000') && r.data.sent_at).length;

  // a non-admin texting "send 3" is just a customer reply
  await say('919000000011', 'send 3');
  assert.strictEqual(texts.length, 0, 'non-admin gets no admin reply');
  assert.strictEqual(admin.state.plan, null);
  assert.strictEqual(rowOf('919000000011').intent, 'needs_review');

  // plan sends nothing
  await say(A, 'send --3');
  assert(/Plan: send the offer to 3 customers/.test(last().body), last().body);
  assert.strictEqual(last().to, A);
  assert.strictEqual(sentCount(), 0);

  // confirm sends exactly the planned batch, with progress + completion messages
  await say(A, 'confirm');
  assert(/Sending to 3 customers/.test(last().body), last().body);
  await waitFor(() => !admin.state.running);
  assert.strictEqual(sentCount(), 3);
  assert(/Done\. Sent 3, failed 0/.test(last().body), last().body);
  assert(texts.some((t) => /2\/3 done/.test(t.body)), 'progress update after 2 sends');
  await say(A, 'confirm');
  assert(/No pending plan/.test(last().body));

  // plan expires; cancel works; only the planner can confirm
  await say(A, 'send 2');
  admin.state.plan.expiresAt = 0;
  await say(A, 'confirm');
  assert(/expired/.test(last().body));
  assert.strictEqual(sentCount(), 3);
  await say(A, 'send 2');
  await say(A, 'cancel');
  assert(/cancelled/.test(last().body));
  assert.strictEqual(admin.state.plan, null);
  await say(A, 'send 2');
  await say(B, 'confirm');
  assert(/another admin/.test(last().body));
  await say(A, 'cancel');

  // one batch at a time, and STOP aborts it
  await say(A, 'send 4');
  await say(A, 'confirm');
  await say(A, 'send 1');
  assert(/already running/.test(last().body), last().body);
  await say(A, 'status');
  assert(/Batch: running/.test(last().body), last().body);
  await say(A, 'stop');
  await waitFor(() => !admin.state.running);
  assert(/Stopped\. Sent \d, failed 0/.test(last().body), last().body);
  assert(sentCount() < 7, 'stop must prevent part of the batch');

  // status numbers; bad counts; max per command
  await say(A, 'status');
  const waiting = Number(last().body.match(/Waiting to be sent: (\d+)/)[1]);
  assert.strictEqual(waiting, 10 - sentCount());
  await say(A, 'send 0');
  assert(/how many/.test(last().body));
  await say(A, 'send 9999');
  assert(/Max per command is 500/.test(last().body), last().body);
  assert.strictEqual(admin.state.plan.count, 10 - sentCount());
  await say(A, 'cancel');

  // an admin who is also a lead: commands are consumed, everything else is a normal reply
  const before = texts.length;
  await say(B, 'subsidy kitni milegi?');
  assert.strictEqual(texts.length, before, 'non-command from an admin gets no admin reply');
  assert.strictEqual(rowOf(B).intent, 'needs_review');
  await say(B, 'stop');
  assert(/Nothing is running/.test(last().body));
  assert.notStrictEqual(rowOf(B).do_not_contact, 'yes', 'admin STOP command must not opt the lead out');
  assert(!rowOf(B).reply_text.includes('stop'));
  await say(B, 'band karo');
  assert.strictEqual(rowOf(B).do_not_contact, 'yes', 'Hindi opt-out text still works for an admin lead');

  await store.drain();
  assert(backend.tabs.Log.some((r) => r[1] === 'admin'), 'admin commands are logged');
  assert.strictEqual(admin.state.running, false);

  console.log('\nselftest passed ✔');
  process.exit(0);
})().catch((err) => { console.error('\nselftest FAILED:', err); process.exit(1); });
