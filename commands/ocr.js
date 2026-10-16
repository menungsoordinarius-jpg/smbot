const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { createWorker } = require('tesseract.js');
const Jimp = require('jimp');

let worker;
const getWorker = async () =>
  (worker ||= await createWorker('ind+eng', 1, { cachePath: './assets/tessdata' }));

const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

module.exports = async (sock, m, args) => {
  const jid = m.key.remoteJid;

  const raw = [...args];
  let count = 1;
  if (raw.length > 1 && /^\d+$/.test(raw[raw.length - 1]))
    count = Math.min(parseInt(raw.pop()), 10);
  const query = raw.map(norm).filter(Boolean);
  if (!query.length)
    return sock.sendMessage(jid, { text: 'Contoh: reply gambar lalu ketik .ocr 67 5' }, { quoted: m });

  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const target = ctx?.quotedMessage?.imageMessage
    ? { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage }
    : m.message?.imageMessage ? m : null;
  if (!target)
    return sock.sendMessage(jid, { text: 'Reply/kirim gambar dulu.' }, { quoted: m });

  const buf = await downloadMediaMessage(target, 'buffer', {});
const img = await Jimp.read(buf);
const { width: W, height: H } = img.bitmap;

// perbesar (maks 3x, sisi terpanjang maks 4000px biar HP tidak kehabisan RAM)
const scale = Math.max(1, Math.min(3, 4000 / Math.max(W, H)));
const pre = img.clone().greyscale().contrast(0.3).normalize();
if (scale > 1)
  pre.resize(Math.round(W * scale), Math.round(H * scale), Jimp.RESIZE_BICUBIC);
const preBuf = await pre.getBufferAsync(Jimp.MIME_PNG);

const wk = await getWorker();
const numeric = query.every(q => /^\d+$/.test(q));
await wk.setParameters({
  tessedit_pageseg_mode: '11', // sparse text: cari teks di mana saja
  tessedit_char_whitelist: numeric ? '0123456789' : '',
});
const { data } = await wk.recognize(preBuf);

// kembalikan koordinat ke ukuran gambar asli
const words = data.words
  .filter(w => norm(w.text))
  .map(w => ({
    text: w.text,
    bbox: { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale },
  }));

  const hits = [];
  for (let i = 0; i + query.length <= words.length; i++) {
    const slice = words.slice(i, i + query.length);
    if (slice.every((w, k) => norm(w.text).includes(query[k]))) hits.push(slice);
  }
  if (!hits.length)
    return sock.sendMessage(jid, { text: 'Tidak ditemukan di gambar.' }, { quoted: m });

  const found = hits.slice(0, count);

  for (const hit of found) {
    const x0 = Math.min(...hit.map(w => w.bbox.x0)), y0 = Math.min(...hit.map(w => w.bbox.y0));
    const x1 = Math.max(...hit.map(w => w.bbox.x1)), y1 = Math.max(...hit.map(w => w.bbox.y1));
    let side = Math.max(x1 - x0, y1 - y0) * 1.6;
    side = Math.round(Math.min(Math.max(side, 300), W, H));
    const x = Math.round(Math.min(Math.max((x0 + x1) / 2 - side / 2, 0), W - side));
    const y = Math.round(Math.min(Math.max((y0 + y1) / 2 - side / 2, 0), H - side));

    const out = await img.clone().crop(x, y, side, side).getBufferAsync(Jimp.MIME_JPEG);
    await sock.sendMessage(jid, { image: out }, { quoted: m });
  }

  if (found.length < count)
    await sock.sendMessage(jid, { text: `Cuma ketemu ${found.length} dari ${count}.` }, { quoted: m });
};
