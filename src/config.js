require('dotenv').config({ quiet: true });

const env = (key, fallback = '') =>
  process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : fallback;
const bool = (value) => ['true', '1', 'yes'].includes(String(value).toLowerCase());

module.exports = {
  port: Number(env('PORT', 3000)),
  verifyToken: env('WEBHOOK_VERIFY_TOKEN'),
  appSecret: env('META_APP_SECRET'),
  skipSignatureCheck: bool(env('SKIP_SIGNATURE_CHECK', 'false')),

  graphVersion: env('GRAPH_VERSION', 'v23.0'),
  waToken: env('WA_ACCESS_TOKEN'),
  phoneNumberId: env('WA_PHONE_NUMBER_ID'),
  // Extra phone number ids whose webhook events should also be accepted (comma separated).
  acceptedPhoneNumberIds: [env('WA_PHONE_NUMBER_ID'), ...env('WA_ACCEPT_PHONE_NUMBER_IDS').split(',')]
    .map((id) => id.trim()).filter(Boolean),
  templateName: env('TEMPLATE_NAME', 'solar_offer_v1'),
  templateLang: env('TEMPLATE_LANG', 'en'),
  templateUsesName: bool(env('TEMPLATE_USES_NAME', 'true')),
  // If the approved template has a media header (video/image/document) every send must carry the media.
  templateHeaderType: env('TEMPLATE_HEADER_TYPE', 'none').toLowerCase(),
  templateHeaderMediaId: env('TEMPLATE_HEADER_MEDIA_ID'),
  templateHeaderUrl: env('TEMPLATE_HEADER_URL'),

  sheetId: env('SHEET_ID'),
  leadsTab: env('LEADS_TAB', 'Leads'),
  logTab: env('LOG_TAB', 'Log'),
  googleKeyFile: env('GOOGLE_KEY_FILE', './service-account.json'),
  googleKeyJson: env('GOOGLE_KEY_JSON'),
  // Meta's business-initiated limit per rolling 24h (250 until upgraded to 2000/10000...). Raise when your tier does.
  dailySendCap: Number(env('DAILY_SEND_CAP', 250)),
  flushIntervalMs: Number(env('FLUSH_INTERVAL_MS', 3000)),

  openaiKey: env('OPENAI_API_KEY'),
  classifierModel: env('CLASSIFIER_MODEL', 'gpt-4o-mini'),

  ackReplies: bool(env('ACK_REPLIES', 'true')),
  ackYes: env('ACK_YES', 'Dhanyavaad! Hamare partner ki team jald hi aapko call karegi. ☀️'),
  ackNo: env('ACK_NO', 'Koi baat nahi, aapke time ke liye shukriya! 🙏'),
  ackStop: env('ACK_STOP', 'Theek hai, ab aapko hamari taraf se koi message nahi bheja jayega. Dhanyavaad.'),

  // test switches (used by scripts/selftest.js)
  mockSheets: bool(env('MOCK_SHEETS', 'false')),
  mockWhatsapp: bool(env('MOCK_WHATSAPP', 'false')),
};
