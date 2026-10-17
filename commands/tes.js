// commands/tes.js
// Kartu preview besar (judul + subjudul + domain) lalu teks menu di bawahnya.
// Preview di-setup dari commands.js (objek PREVIEW), file ini cuma logikanya.

const Jimp = require('jimp'); // jimp 0.22.12

const thumbCache = new Map(); // url -> Buffer
let counter = 0;              // untuk mode 'urut'

// Ambil gambar -> kecilkan jadi JPEG ringan. Thumbnail WAJIB berupa buffer
// supaya kartu muncul juga di HP orang lain, bukan cuma di HP bot.
async function buildThumb(url) {
  if (thumbCache.has(url)) return thumbCache.get(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal ambil gambar (${res.status}): ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());

  const img = await Jimp.read(raw);
  img.scaleToFit(300, 300).quality(50);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);

  thumbCache.set(url, buf);
  return buf;
}


// Gambar ukuran layak (bukan thumbnail kecil) untuk kartu besar
async function buildFull(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal ambil gambar (${res.status}): ${url}`);
  const img = await Jimp.read(Buffer.from(await res.arrayBuffer()));
  img.scaleToFit(1000, 1000).quality(80);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  return { buf, width: img.bitmap.width, height: img.bitmap.height };
}

// Upload gambar ke server WhatsApp sebagai "thumbnail-link".
// Ini yang bikin kartu besar + link otomatis tersembunyi, sama seperti
// saat kamu paste link manual dan preview-nya terload sempurna.
async function uploadPreviewImage(sock, url) {
  // Baileys 7 itu ESM-only, project ini CommonJS -> dimuat lewat import()
  const { prepareWAMessageMedia } = await import('@whiskeysockets/baileys');
  const full = await buildFull(url);
  const thumb = await buildThumb(url);
  const { imageMessage } = await prepareWAMessageMedia(
    { image: full.buf },
    { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
  );
  // Baileys 7 di Termux sering tidak mengisi ukuran & thumbnail (tidak ada
  // sharp/jimp bawaan) -> kita isi sendiri dari Jimp.
  imageMessage.width = imageMessage.width || full.width;
  imageMessage.height = imageMessage.height || full.height;
  if (!imageMessage.jpegThumbnail || !imageMessage.jpegThumbnail.length) {
    imageMessage.jpegThumbnail = thumb;
  }
  return imageMessage;
}

// Pilih gambar: nomor dari user > mode di config
function pickImage(images, mode, arg) {
  const n = parseInt(arg);
  if (n >= 1 && n <= images.length) return images[n - 1];
  if (mode === 'urut') return images[counter++ % images.length];
  if (typeof mode === 'number') return images[(mode - 1) % images.length];
  return images[Math.floor(Math.random() * images.length)]; // 'random'
}

function formatRuntime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}j` : `${m}m`;
}

function buildMenuText(m, totalCmd) {
  const user = m.pushName || 'User';
  return [
    '┌ 〔 smbot 〕',
    `│ User: ${user}`,
    `│ Runtime: ${formatRuntime(process.uptime())}`,
    `│ Total Cmd: ${totalCmd}`,
    '└──────────',
    '',
    '┌ 〔 STICKER 〕',
    '│ .s',
    '│ .s full',
    '│ .smeme',
    '└──────────',
    '',
    '┌ 〔 CONVERTER 〕',
    '│ .toimage',
    '│ .tomp3',
    '└──────────',
    '',
    '┌ 〔 DOWNLOADER 〕',
    '│ .x',
    '│ .ins',
    '│ .instagram',
    '└──────────',
  ].join('\n');
}

/**
 * @param sock    socket Baileys
 * @param m       pesan masuk
 * @param args    argumen command (args[0] = nomor gambar, opsional)
 * @param preview objek PREVIEW dari commands.js
 */
async function tes(sock, m, args = [], preview) {
  const jid = m.key.remoteJid;
  const url = pickImage(preview.images, preview.mode, args[0]);

  const link = preview.sourceUrl;
  console.log('[tes] mulai | gambar:', url);

  // 1) Kartu preview: teks HANYA link, jadi link-nya tersembunyi
  let hq, thumbnail;
  try {
    hq = await uploadPreviewImage(sock, url);
    console.log('[tes] upload OK | directPath:', !!hq?.directPath,
      '| mediaKey:', !!hq?.mediaKey,
      '| jpegThumb:', hq?.jpegThumbnail ? Math.round(hq.jpegThumbnail.length / 1024) + 'KB' : 'kosong',
      '| size:', hq?.width, 'x', hq?.height);
  } catch (e) {
    console.error('[tes] upload preview gagal:', e.message);
    try { thumbnail = await buildThumb(url); } catch {}
  }

  console.log('[tes] siap kirim | mode:', hq ? 'HQ' : 'thumbnail kecil');
  const menuText = buildMenuText(m, preview.totalCmd ?? 0);
  const linkPreview = {
    'canonical-url': link,
    'matched-text': link,
    title: preview.title,
    description: preview.body,
    jpegThumbnail: hq?.jpegThumbnail || thumbnail,
    highQualityThumbnail: hq,
  };

  if (preview.tampilan === 'ad') {
    // TES: 1 bubble, link tidak kelihatan (gaya Shiroine) lewat externalAdReply.
    // Thumbnail dikirim sebagai buffer JPEG kecil yang sudah kita buat sendiri.
    let adThumb = thumbnail;
    if (!adThumb) { try { adThumb = await buildThumb(url); } catch {} }
    console.log('[tes] mode ad | thumb:', adThumb ? Math.round(adThumb.length / 1024) + 'KB' : 'kosong');
    await sock.sendMessage(
      jid,
      {
        text: menuText,
        contextInfo: {
          externalAdReply: {
            title: preview.title,
            body: preview.body,
            mediaType: 1,
            renderLargerThumbnail: true,
            showAdAttribution: false,
            thumbnail: adThumb,
            thumbnailUrl: url,
            sourceUrl: link,
          },
        },
      },
      { quoted: m }
    );
  } else if (preview.satuPesan) {
    // TES: kartu + menu dalam 1 pesan. Konsekuensi: link ikut kelihatan
    // karena teks tidak lagi cuma berisi link.
    await sock.sendMessage(jid, { text: menuText + '\n\n' + link, linkPreview }, { quoted: m });
  } else {
    // Default: kartu dulu (teks cuma link -> tersembunyi), menu di pesan kedua
    await sock.sendMessage(jid, { text: link, linkPreview }, { quoted: m });
    await sock.sendMessage(jid, { text: menuText });
  }
  console.log('[tes] terkirim | satuPesan:', !!preview.satuPesan);
}

module.exports = tes;
