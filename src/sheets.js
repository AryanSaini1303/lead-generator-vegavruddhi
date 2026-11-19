const config = require('./config');
const { normalizePhone, fmtTime } = require('./phone');

const LEAD_COLUMNS = [
  'phone', 'name', 'status', 'sent_at', 'wamid', 'batch_id', 'delivered_at', 'read_at',
  'reply_type', 'reply_text', 'intent', 'ai_summary', 'interested', 'do_not_contact',
  'error', 'reviewer_notes', 'verified', 'handed_over', 'business_feedback', 'last_updated',
];
const LOG_COLUMNS = ['time', 'direction', 'phone', 'type', 'wamid', 'payload'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseRange(range) {
  const m = range.match(/^'?(.*?)'?!([A-Z]+)(\d+)$/);
  let col = 0;
  for (const ch of m[2]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { tab: m[1], col: col - 1, row: Number(m[3]) };
}

async function withRetry(fn, label = 'sheets call') {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || err.response?.status;
      const retryable = code === 429 || (typeof code === 'number' && code >= 500);
      if (!retryable || attempt === 6) throw err;
      console.warn(`[sheets] ${label} failed (${code}), retry ${attempt} in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
  return undefined;
}

// ---------- backends: Google (real) and memory (tests) ----------

function googleBackend() {
  const { google } = require('googleapis');
  let client;
  const sheets = () => {
    if (client) return client;
    const credentials = config.googleKeyJson ? JSON.parse(config.googleKeyJson) : undefined;
    const auth = new google.auth.GoogleAuth({
      credentials,
      keyFile: credentials ? undefined : config.googleKeyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    client = google.sheets({ version: 'v4', auth });
    return client;
  };
  const spreadsheetId = config.sheetId;

  return {
    async getValues(tab) {
      const res = await withRetry(
        () => sheets().spreadsheets.values.get({ spreadsheetId, range: `'${tab}'` }),
        'get',
      );
      return res.data.values || [];
    },
    async batchUpdate(data) {
      await withRetry(
        () => sheets().spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data },
        }),
        'batchUpdate',
      );
    },
    async append(tab, rows) {
      await withRetry(
        () => sheets().spreadsheets.values.append({
          spreadsheetId,
          range: `'${tab}'!A1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rows },
        }),
        'append',
      );
    },
    async ensureTab(tab) {
      const meta = await withRetry(
        () => sheets().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }),
        'meta',
      );
      const titles = meta.data.sheets.map((s) => s.properties.title);
      if (titles.includes(tab)) return;
      await withRetry(
        () => sheets().spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
        }),
        'addSheet',
      );
    },
  };
}

function memoryBackend() {
  const tabs = {};
  return {
    tabs,
    seed(tab, rows) { tabs[tab] = rows.map((r) => [...r]); },
    async getValues(tab) { return (tabs[tab] || []).map((r) => [...r]); },
    async batchUpdate(data) {
      for (const { range, values } of data) {
        const { tab, col, row } = parseRange(range);
        tabs[tab] = tabs[tab] || [];
        while (tabs[tab].length < row) tabs[tab].push([]);
        const line = tabs[tab][row - 1];
        values[0].forEach((value, i) => { line[col + i] = value; });
      }
    },
    async append(tab, rows) {
      tabs[tab] = tabs[tab] || [];
      rows.forEach((r) => tabs[tab].push([...r]));
    },
    async ensureTab(tab) { tabs[tab] = tabs[tab] || []; },
  };
}

// ---------- lead store: in-memory cache + coalesced writes ----------
// Sheets allows roughly 60 write requests/minute, so cell updates are buffered and
// flushed together every few seconds instead of one request per webhook event.

class LeadStore {
  constructor(backend) {
    this.backend = backend;
    this.headers = [];
    this.rows = [];
    this.byPhone = new Map();
    this.pending = new Map(); // rowNumber -> { column: value }
    this.logBuffer = [];
    this.lastLoad = 0;
    this.timer = null;
    this.flushPromise = null;
    this.warnedColumns = new Set();
  }

  async load() {
    if (this.flushPromise) await this.flushPromise.catch(() => {});
    const values = await this.backend.getValues(config.leadsTab);
    if (!values.length) throw new Error(`Tab "${config.leadsTab}" is empty. Run: npm run setup-sheet`);
    this.headers = values[0].map((h) => String(h).trim().toLowerCase());
    if (!this.headers.includes('phone')) throw new Error('Leads tab needs a "phone" column');
    this.rows = [];
    this.byPhone = new Map();
    values.slice(1).forEach((line, i) => {
      const data = {};
      this.headers.forEach((h, idx) => { data[h] = line[idx] === undefined ? '' : String(line[idx]); });
      const row = { rowNumber: i + 2, data };
      const overlay = this.pending.get(row.rowNumber);
      if (overlay) Object.assign(row.data, overlay);
      this.rows.push(row);
      const phone = normalizePhone(data.phone);
      if (phone && !this.byPhone.has(phone)) this.byPhone.set(phone, row);
    });
    this.lastLoad = Date.now();
    return this.rows;
  }

  async find(phone) {
    let row = this.byPhone.get(phone);
    if (!row && Date.now() - this.lastLoad > 15000) {
      await this.load();
      row = this.byPhone.get(phone);
    }
    return row || null;
  }

  update(row, fields) {
    const clean = {};
    for (const [key, value] of Object.entries({ ...fields, last_updated: fmtTime() })) {
      if (!this.headers.includes(key)) {
        if (!this.warnedColumns.has(key)) {
          console.warn(`[sheets] column "${key}" missing in ${config.leadsTab}; run npm run setup-sheet`);
          this.warnedColumns.add(key);
        }
        continue;
      }
      clean[key] = value === undefined || value === null ? '' : String(value);
    }
    Object.assign(row.data, clean);
    this.pending.set(row.rowNumber, { ...(this.pending.get(row.rowNumber) || {}), ...clean });
    this.scheduleFlush();
  }

  log(direction, phone, type, wamid, payload) {
    this.logBuffer.push([fmtTime(), direction, phone, type, wamid || '', String(payload || '').slice(0, 2000)]);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.error('[sheets] flush failed, will retry:', err.message));
    }, config.flushIntervalMs);
  }

  flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOnce().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async flushOnce() {
    const pending = this.pending;
    const logs = this.logBuffer;
    if (!pending.size && !logs.length) return;
    this.pending = new Map();
    this.logBuffer = [];
    try {
      const data = [];
      for (const [rowNumber, fields] of pending) {
        for (const [key, value] of Object.entries(fields)) {
          data.push({
            range: `'${config.leadsTab}'!${colLetter(this.headers.indexOf(key))}${rowNumber}`,
            values: [[value]],
          });
        }
      }
      if (data.length) await this.backend.batchUpdate(data);
      if (logs.length) await this.backend.append(config.logTab, logs);
    } catch (err) {
      for (const [rowNumber, fields] of pending) {
        this.pending.set(rowNumber, { ...fields, ...(this.pending.get(rowNumber) || {}) });
      }
      this.logBuffer = [...logs, ...this.logBuffer];
      this.scheduleFlush();
      throw err;
    }
  }

  async drain() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.pending.size || this.logBuffer.length || this.flushPromise) {
      await this.flush();
    }
  }
}

// Creates tabs/headers, and appends any required column your sheet is still missing.
async function setupSheet(backend) {
  await backend.ensureTab(config.leadsTab);
  await backend.ensureTab(config.logTab);

  const leads = await backend.getValues(config.leadsTab);
  const existing = (leads[0] || []).map((h) => String(h).trim().toLowerCase());
  const added = [];
  const updates = [];
  let next = existing.length;
  for (const column of LEAD_COLUMNS) {
    if (!existing.includes(column)) {
      updates.push({ range: `'${config.leadsTab}'!${colLetter(next)}1`, values: [[column]] });
      added.push(column);
      next += 1;
    }
  }
  const log = await backend.getValues(config.logTab);
  if (!log.length) {
    LOG_COLUMNS.forEach((column, i) => {
      updates.push({ range: `'${config.logTab}'!${colLetter(i)}1`, values: [[column]] });
    });
  }
  if (updates.length) await backend.batchUpdate(updates);
  return { addedLeadColumns: added, createdLogHeader: !log.length };
}

const backend = config.mockSheets ? memoryBackend() : (config.sheetId ? googleBackend() : null);

module.exports = { LeadStore, setupSheet, backend, memoryBackend, googleBackend, LEAD_COLUMNS, LOG_COLUMNS };
