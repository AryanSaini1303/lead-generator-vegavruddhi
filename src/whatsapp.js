const crypto = require('crypto');
const config = require('./config');
const { firstName } = require('./phone');

let mockCounter = 0;

async function graphPost(path, body) {
  if (config.mockWhatsapp) {
    mockCounter += 1;
    console.log(`[mock-whatsapp] ${path}`, JSON.stringify(body).slice(0, 200));
    return { messages: [{ id: `wamid.MOCK${mockCounter}` }] };
  }
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.details = json?.error;
    throw err;
  }
  return json;
}

function buildTemplatePayload(to, name) {
  const components = [];
  const headerType = config.templateHeaderType;
  if (headerType !== 'none') {
    if (!['video', 'image', 'document'].includes(headerType)) {
      throw new Error(`TEMPLATE_HEADER_TYPE must be none, video, image or document (got "${headerType}")`);
    }
    const ref = config.templateHeaderMediaId
      ? { id: config.templateHeaderMediaId }
      : config.templateHeaderUrl ? { link: config.templateHeaderUrl } : null;
    if (!ref) {
      throw new Error('Template has a media header: set TEMPLATE_HEADER_MEDIA_ID (npm run upload-media) or TEMPLATE_HEADER_URL');
    }
    components.push({ type: 'header', parameters: [{ type: headerType, [headerType]: ref }] });
  }
  if (config.templateUsesName) {
    components.push({ type: 'body', parameters: [{ type: 'text', text: firstName(name) }] });
  }
  // Template must have 3 quick-reply buttons in this order: Yes, No, Stop.
  // Their payloads (YES / NO / STOP) come back in the webhook, so the wording of the
  // button labels can be changed freely without touching the code.
  ['YES', 'NO', 'STOP'].forEach((payload, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }],
    });
  });
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: config.templateName, language: { code: config.templateLang }, components },
  };
}

async function sendTemplate(to, name) {
  return graphPost(`${config.phoneNumberId}/messages`, buildTemplatePayload(to, name));
}

async function sendText(to, body) {
  return graphPost(`${config.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

function verifySignature(rawBody, header) {
  if (config.skipSignatureCheck) return true;
  if (!config.appSecret || !header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sendTemplate, sendText, verifySignature, buildTemplatePayload };
