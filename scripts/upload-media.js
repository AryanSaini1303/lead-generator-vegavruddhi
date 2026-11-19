// Uploads a local video/image/pdf to WhatsApp and prints the media id for TEMPLATE_HEADER_MEDIA_ID.
//   npm run upload-media -- ./solar-offer.mp4
// Video must be MP4 (H.264 + AAC), max 16 MB. Uploaded media is kept by Meta for about 30 days.
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const MIME = { '.mp4': 'video/mp4', '.3gp': 'video/3gpp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error('Usage: npm run upload-media -- <path-to-file>');
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`Unsupported file type. Use one of: ${Object.keys(MIME).join(' ')}`);
  if (!config.waToken || !config.phoneNumberId) throw new Error('Set WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID in .env first');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', await fs.openAsBlob(file, { type: mime }), path.basename(file));
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.waToken}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  console.log(`Uploaded. Put this in .env:\nTEMPLATE_HEADER_MEDIA_ID=${json.id}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
