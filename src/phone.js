// WhatsApp ids look like 919876543210 (country code + number, no plus sign).
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return '';
  let digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10) digits = `91${digits}`;
  return digits;
}

function isValidPhone(raw) {
  const p = normalizePhone(raw);
  return p.length >= 11 && p.length <= 15;
}

function firstName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  if (!first) return process.env.NAME_FALLBACK || 'ग्राहक';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Human-readable timestamp for the sheet (IST).
function fmtTime(ms = Date.now()) {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

module.exports = { normalizePhone, isValidPhone, firstName, fmtTime };
