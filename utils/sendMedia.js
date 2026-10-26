// utils/sendMedia.js
// sendMediaFile(sock, m, url, opts): unduh -> deteksi tipe -> kirim -> hapus file sementara
// Butuh: utils/segdl.js

const fs = require('fs');
const { segDownload } = require('./segdl');

// Deteksi tipe dari byte awal file
function sniffBuf(b) {
  if (b.length < 12) return null;
  const s = (a, z) => b.subarray(a, z).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (s(1, 4) === 'PNG') return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (s(0, 4) === 'GIF8') return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (['avif', 'heic', 'heix', 'mif1'].includes(brand)) return null;
    if (brand.startsWith('M4A')) return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
    return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
  }
  if (b.subarray(0, 4).toString('hex') === '1a45dfa3') return { kind: 'video', ext: 'webm', mime: 'video/webm' };
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
    return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  if (s(0, 4) === 'OggS') return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg; codecs=opus' };
  return null;
}

async function sniffFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);
    return sniffBuf(buf);
  } finally {
    await fh.close();
  }
}

/**
 * opts:
 *   caption         teks caption
 *   headers         header tambahan (mis. Referer Pixiv)
 *   connections     jumlah koneksi paralel (default 4)
 *   asDocument      paksa kirim sebagai dokumen
 *   fileName        nama file untuk dokumen
 *   maxVideoMB      video lebih besar dari ini dikirim sebagai dokumen (default 60)
 *   unknownAsDoc    tipe tidak dikenal -> kirim sebagai dokumen (default: lempar error)
 *   quoted          pesan yang di-reply (default m)
 *   jid             tujuan (default m.key.remoteJid)
 * return: { kind, size }
 */
async function sendMediaFile(sock, m, url, opts = {}) {
  const {
    caption, headers, connections,
    asDocument = false, fileName = 'file',
    maxVideoMB = 60, unknownAsDoc = false,
    quoted = m, jid = m.key.remoteJid,
  } = opts;

  const file = await segDownload(url, { headers, connections });
  try {
    const info = await sniffFile(file);
    const size = (await fs.promises.stat(file)).size;
    console.log('[sendMedia]', { kind: info?.kind, size, url: String(url).slice(0, 100) });

    if (!info && !unknownAsDoc) throw new Error('hasil unduhan bukan media yang valid');

    const bigVideo = info?.kind === 'video' && size > maxVideoMB * 1024 * 1024;
    let content;

    if (!info || asDocument || bigVideo) {
      const ext = info?.ext || 'bin';
      const name = /\.\w{2,4}$/.test(fileName) ? fileName : `${fileName}.${ext}`;
      content = { document: { url: file }, mimetype: info?.mime || 'application/octet-stream', fileName: name };
    } else if (info.kind === 'video') {
      content = { video: { url: file }, mimetype: info.mime };
    } else if (info.kind === 'audio') {
      content = { audio: { url: file }, mimetype: info.mime };
    } else {
      content = { image: { url: file } };
    }

    // audio tidak mendukung caption
    if (caption && !content.audio) content.caption = caption;

    await sock.sendMessage(jid, content, { quoted });
    return { kind: info?.kind || 'document', size };
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

module.exports = { sendMediaFile, sniffBuf };
