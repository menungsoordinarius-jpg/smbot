// commands/converter/toimage.js
// .toimage            -> frame detik 0, kirim sebagai gambar
// .toimage 5          -> frame detik 5
// .toimage 5 dokumen  -> kirim sebagai dokumen
// Angka melebihi durasi -> otomatis frame terakhir
// Bisa untuk: stiker, GIF, video, gambar (reply, atau kirim dengan caption .toimage)
//
// Termux: pkg install ffmpeg libwebp imagemagick
// (stiker animasi butuh imagemagick, atau webpmux + anim_dump)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const { createProcess } = require('../../utils/process');
const { withProcessReact } = require('../../utils/react');

// Tampilkan pesan proses (bar progres) saat menunggu.
// Opsi: true | false
const SETTING_Tampilkan_Proses = true;

const execFileP = promisify(execFile);
// semua perintah luar diberi batas waktu supaya tidak menggantung
const run = (bin, args) => execFileP(bin, args, { timeout: 60 * 1000, maxBuffer: 10 * 1024 * 1024 });

const EPS = 0.1; // jarak aman dari ujung durasi (detik)
const MB = 1024 * 1024;
const MAX_VIDEO_MB = 40; // batas ukuran video/GIF yang diunduh (hemat RAM HP)
const MAX_GAMBAR_MB = 20; // batas ukuran stiker/gambar
const MAX_PARALEL = 2; // jumlah media yang boleh diproses bersamaan
const TIMEOUT_UNDUH_MS = 90 * 1000;
const BATAS_KIRIM_GAMBAR = 15 * MB; // di atas ini otomatis dikirim sebagai dokumen

let aktif = 0;
const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

// Error dengan pesan siap kirim ke WhatsApp
function galat(pesan, detail) {
  const err = new Error(detail || pesan);
  err.pesan = pesan;
  return err;
}

// ---------- baca argumen ----------
function parseArgs(args) {
  let sec = 0;
  let asDoc = false;
  for (const a of args) {
    const t = String(a).toLowerCase();
    if (/^(dokumen|document|doc)$/.test(t)) asDoc = true;
    else if (/^\d+([.,]\d+)?$/.test(t)) sec = parseFloat(t.replace(',', '.'));
  }
  return { sec, asDoc };
}

// ---------- buka pembungkus pesan (chat sementara, view once, dll) ----------
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

function unwrap(message) {
  let cur = message || {};
  for (let i = 0; i < 5; i++) {
    const key = WRAPPERS.find((k) => cur[k] && cur[k].message);
    if (!key) break;
    cur = cur[key].message;
  }
  return cur;
}

// contextInfo bisa ada di teks biasa ATAU di media yang dikirim dengan caption (balasan + media)
function getContext(message) {
  const m = unwrap(message);
  for (const v of Object.values(m)) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return null;
}

// ---------- kenali jenis media ----------
function detectMedia(message) {
  const m = unwrap(message);
  if (m.stickerMessage) return { kind: 'sticker', node: m.stickerMessage };
  if (m.videoMessage) return { kind: 'video', node: m.videoMessage }; // GIF WhatsApp juga videoMessage (gifPlayback)
  if (m.ptvMessage) return { kind: 'video', node: m.ptvMessage }; // video bulat
  if (m.imageMessage) return { kind: 'image', node: m.imageMessage };
  const d = m.documentMessage;
  if (d) {
    const mt = String(d.mimetype || '');
    if (/^video\//i.test(mt)) return { kind: 'video', node: d };
    if (/^image\//i.test(mt)) return { kind: 'image', node: d };
  }
  return null;
}

// ---------- ambil pesan target (reply, atau pesan itu sendiri) ----------
function getTarget(msg) {
  const ctx = getContext(msg.message);
  if (ctx && ctx.quotedMessage) {
    const media = detectMedia(ctx.quotedMessage);
    if (media) {
      return {
        ...media,
        target: {
          key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
          message: unwrap(ctx.quotedMessage),
        },
      };
    }
  }
  // media yang dikirim langsung dengan caption .toimage
  const media = detectMedia(msg.message);
  if (media) return { ...media, target: { key: msg.key, message: unwrap(msg.message) } };
  return null;
}

// ukuran file dari metadata pesan (bisa berupa angka, string, atau objek Long)
function ukuranBytes(node) {
  const n = Number(String((node && node.fileLength) || 0));
  return Number.isFinite(n) ? n : 0;
}

// ---------- unduh media: ada batas waktu + ulang otomatis kalau jaringan putus ----------
const PERMANEN = /404|410|not found|expired|media key|empty media|gone|forbidden|403/i;

async function unduh(sock, target) {
  let terakhir;
  for (let i = 1; i <= 3; i++) {
    try {
      let timer;
      const batas = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('TIMEOUT_UNDUH')), TIMEOUT_UNDUH_MS);
      });
      const buf = await Promise.race([
        downloadMediaMessage(target, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }),
        batas,
      ]).finally(() => clearTimeout(timer));
      if (!buf || !buf.length) throw new Error('EMPTY_MEDIA');
      return buf;
    } catch (e) {
      terakhir = e;
      console.error(`[toimage] unduh gagal (percobaan ${i}/3):`, e && e.message);
      if (PERMANEN.test(String(e && e.message))) break; // media hilang/kedaluwarsa, percuma diulang
      if (i < 3) await tidur(1500 * i);
    }
  }
  const pesan = String((terakhir && terakhir.message) || '');
  if (PERMANEN.test(pesan) || pesan === 'EMPTY_MEDIA') {
    throw galat('❌ Media sudah kedaluwarsa atau tidak bisa diunduh. Kirim ulang medianya, lalu reply lagi dengan .toimage', pesan);
  }
  throw galat('❌ Gagal mengunduh media (jaringan bermasalah). Coba lagi sebentar lagi.', pesan);
}

// ffmpeg menebak format gambar dari nama file, jadi ekstensinya harus benar (dilihat dari isi file)
function extGambar(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return 'jpg';
}

// ---------- frame dari video / GIF (mp4) / gambar ----------
async function videoFrame(input, out, sec) {
  let dur = 0;
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      input,
    ]);
    dur = parseFloat(stdout.trim()) || 0;
  } catch (_) {}

  const target = dur > 0 ? Math.max(0, Math.min(sec, dur - EPS)) : 0;
  const coba = target > 0 ? [target, 0] : [0]; // kalau lompat ke detik itu gagal, ulangi dari awal
  for (const t of coba) {
    try {
      // detik 0 tidak perlu lompat (-ss), dan untuk gambar diam -ss justru membuat hasil kosong
      await run('ffmpeg', [
        '-y', ...(t > 0 ? ['-ss', String(t)] : []), '-i', input,
        '-an', '-sn', '-frames:v', '1', '-pix_fmt', 'rgba', out,
      ]);
    } catch (e) {
      console.error('[toimage] ffmpeg gagal pada detik', t, '->', String(e.stderr || e.message).trim().slice(-200));
    }
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  }
  throw galat('❌ File tidak bisa diproses (rusak atau formatnya tidak didukung).', 'ffmpeg tidak menghasilkan frame');
}

// ---------- pilih frame berdasarkan detik ----------
// durs = durasi tiap frame (ms), count = jumlah file frame
function pickIndex(durs, count, sec) {
  if (!durs.length) return sec > 0 ? count - 1 : 0;
  const total = durs.reduce((a, b) => a + b, 0);
  const t = Math.max(0, Math.min(sec * 1000, total - 1));
  let acc = 0;
  let idx = durs.length - 1;
  for (let i = 0; i < durs.length; i++) {
    acc += durs[i];
    if (t < acc) { idx = i; break; }
  }
  return Math.min(idx, count - 1);
}

function listFrames(dir) {
  return fs.readdirSync(dir).filter((f) => /^f_.*\.png$/.test(f)).sort();
}

function clearFrames(dir) {
  for (const f of listFrames(dir)) fs.unlinkSync(path.join(dir, f));
}

// cek tool terpasang tanpa `which` (Termux tidak punya `which` secara bawaan)
async function exists(bin) {
  try {
    await run(bin, ['-version']);
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

// ---------- stiker animasi: cara 1 = ImageMagick ----------
async function viaImageMagick(input, dir, out, sec) {
  let bin = null;
  for (const b of ['magick', 'convert']) {
    if (await exists(b)) { bin = b; break; }
  }
  if (!bin) throw new Error('ImageMagick tidak terpasang');

  const [idBin, idPre] = bin === 'magick' ? ['magick', ['identify']] : ['identify', []];
  const { stdout } = await run(idBin, [...idPre, '-format', '%T\n', input]);
  // %T = delay per frame dalam centisecond
  const durs = stdout
    .split('\n')
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n))
    .map((n) => (n || 10) * 10);

  // -coalesce: gabungkan tiap frame jadi gambar utuh (alpha tetap ada)
  await run(bin, [input, '-coalesce', path.join(dir, 'f_%04d.png')]);
  const files = listFrames(dir);
  if (!files.length) throw new Error('tidak ada frame');

  const idx = pickIndex(durs, files.length, sec);
  fs.copyFileSync(path.join(dir, files[idx]), out);
}

// ---------- stiker animasi: cara 2 = webpmux + anim_dump ----------
async function viaWebpTools(input, dir, out, sec) {
  const { stdout } = await run('webpmux', ['-info', input]);
  const durs = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+):\s+\d+\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)/);
    if (m) durs.push(parseInt(m[2], 10) || 0);
  }

  await run('anim_dump', ['-folder', dir, '-prefix', 'f_', input]);
  const files = listFrames(dir);
  if (!files.length) throw new Error('tidak ada frame');

  const idx = pickIndex(durs, files.length, sec);
  fs.copyFileSync(path.join(dir, files[idx]), out);
}

// ---------- frame dari stiker webp ----------
async function stickerFrame(input, dir, out, sec, animated) {
  // stiker statis: dwebp menjaga alpha
  if (!animated) {
    await run('dwebp', [input, '-o', out]);
    return;
  }

  // stiker animasi: ffmpeg TIDAK bisa membaca webp animasi (chunk ANIM/ANMF)
  const errors = [];
  for (const fn of [viaImageMagick, viaWebpTools]) {
    try {
      await fn(input, dir, out, sec);
      return;
    } catch (e) {
      const why = String(e.stderr || e.message).trim().replace(/\s+/g, ' ').slice(0, 300);
      errors.push(`${fn.name}: ${why}`);
      clearFrames(dir);
    }
  }
  console.error('[toimage] stiker animasi gagal ->', errors.join(' | '));
  throw new Error('NO_ANIM_TOOL');
}

// ---------- handler utama ----------
module.exports = async function toimage(sock, msg, args = []) {
  const jid = msg.key.remoteJid;
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  // ---------- validasi input (cukup balas pesan biasa) ----------
  const found = getTarget(msg);
  if (!found) {
    await reply('Reply stiker, GIF, video, atau gambar dulu.\nContoh: .toimage 5');
    return false;
  }
  const { kind, node, target } = found;

  const batasMB = kind === 'video' ? MAX_VIDEO_MB : MAX_GAMBAR_MB;
  if (ukuranBytes(node) > batasMB * MB) {
    await reply(`File terlalu besar (maks ${batasMB} MB).`);
    return false;
  }
  if (aktif >= MAX_PARALEL) {
    await reply('Masih ada media lain yang sedang diproses, tunggu sebentar ya.');
    return false;
  }

  let { sec, asDoc } = parseArgs(args);

  // ---------- pesan proses ----------
  const proc = withProcessReact(
    createProcess(sock, msg, SETTING_Tampilkan_Proses),
    sock,
    msg
  );
  const gagal = async (teks) =>
    SETTING_Tampilkan_Proses
      ? proc.fail(teks)
      : sock.sendMessage(jid, { text: teks }, { quoted: msg });

  aktif++;
  let dir = null;
  try {
    await proc.update('🔎 Memeriksa media...', 10, true);
    if (kind !== 'sticker' && !(await exists('ffmpeg'))) {
      throw galat('❌ ffmpeg belum terpasang. Jalankan di Termux: pkg install ffmpeg', 'ffmpeg tidak ada');
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toimage-'));
    const out = path.join(dir, 'result.png');

    await proc.update('⬇️ Mengunduh media...', 25, true);
    const buffer = await unduh(sock, target);

    await proc.update('⚙️ Mengubah ke gambar...', 60, true);
    if (kind === 'sticker') {
      const input = path.join(dir, 'in.webp');
      fs.writeFileSync(input, buffer);
      try {
        await stickerFrame(input, dir, out, sec, !!node.isAnimated);
      } catch (e) {
        if (node.isAnimated) throw e; // ffmpeg tak bisa baca webp animasi
        console.error('[toimage] dwebp gagal, coba ffmpeg:', e.message);
        await videoFrame(input, out, sec);
      }
    } else {
      const input = path.join(dir, kind === 'video' ? 'in.mp4' : 'in.' + extGambar(buffer));
      fs.writeFileSync(input, buffer);
      await videoFrame(input, out, sec);
    }

    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw galat('❌ Hasil konversi kosong, medianya mungkin rusak.', 'output kosong');
    }
    const png = fs.readFileSync(out);
    if (png.length > BATAS_KIRIM_GAMBAR) asDoc = true; // terlalu besar untuk dikirim sebagai gambar

    await proc.update('📤 Mengirim gambar...', 90, true);
    if (asDoc) {
      await sock.sendMessage(
        jid,
        { document: png, mimetype: 'image/png', fileName: 'image.png' },
        { quoted: msg }
      );
    } else {
      await sock.sendMessage(jid, { image: png }, { quoted: msg });
    }

    await proc.done();
    return true;
  } catch (err) {
    console.error('[toimage]', err);
    if (err.message === 'NO_ANIM_TOOL') {
      await gagal('❌ Stiker animasi butuh ImageMagick di Termux:\npkg install imagemagick');
    } else {
      await gagal(err.pesan || '❌ Gagal mengubah ke gambar.');
    }
    return false; // dibaca withReaction -> reaksi akhir ❌
  } finally {
    aktif--;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
};
