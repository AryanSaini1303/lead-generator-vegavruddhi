// Creates the Leads/Log tabs and adds any missing columns. Safe to run repeatedly.
const config = require('../src/config');
const { backend, setupSheet } = require('../src/sheets');

(async () => {
  if (!backend) throw new Error('Set SHEET_ID in .env first');
  const result = await setupSheet(backend);
  console.log(`Sheet ready (${config.leadsTab} / ${config.logTab}).`);
  if (result.addedLeadColumns.length) console.log('Added columns:', result.addedLeadColumns.join(', '));
  else console.log('All required columns already present.');
  console.log('Tip: format the "phone" column as Plain text so numbers never turn into 9.87E+11.');
})().catch((err) => { console.error(err.message); process.exit(1); });
