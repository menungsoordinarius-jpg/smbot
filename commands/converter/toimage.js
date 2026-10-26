// commands/converter/toimage.js
// .toimage            -> frame detik 0, kirim sebagai gambar
// .toimage 5          -> frame detik 5
// .toimage 5 dokumen  -> kirim sebagai dokumen
// Angka melebihi durasi -> otomatis frame terakhir
//
// Termux: pkg install ffmpeg libwebp imagemagick
// (stiker animasi butuh imagemagick, atau webpmux + anim_dump)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const run = promisify(execFile);
const EPS = 0.1; // jarak aman dari ujung durasi (detik)

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

// ---------- ambil pesan target (reply, atau pesan itu sendiri) ----------
function getTarget(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.quotedMessage) {
    return {
      key: {
        remoteJid: msg.key.remoteJid,
        id: ctx.stanzaId,
        participant: ctx.participant,
      },
      message: ctx.quotedMessage,
    };
  }
  return msg; // media yang dikirim dengan caption .toimage
}

// ---------- frame dari video / GIF (mp4) ----------
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
  await run('ffmpeg', [
    '-y', '-ss', String(target), '-i', input,
    '-frames:v', '1', '-pix_fmt', 'rgba', out,
  ]);
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

  const target = getTarget(msg);
  const m = target.message || {};
  const sticker = m.stickerMessage;
  const video = m.videoMessage; // GIF dari WhatsApp juga videoMessage (gifPlayback)

  if (!sticker && !video) {
    return reply('Reply stiker, GIF, atau video dulu.\nContoh: .toimage 5');
  }

  const { sec, asDoc } = parseArgs(args);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toimage-'));
  const out = path.join(dir, 'result.png');

  try {
    const buffer = await downloadMediaMessage(
      target,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    );

    if (sticker) {
      const input = path.join(dir, 'in.webp');
      fs.writeFileSync(input, buffer);
      try {
        await stickerFrame(input, dir, out, sec, !!sticker.isAnimated);
      } catch (e) {
        if (sticker.isAnimated) throw e; // ffmpeg tak bisa baca webp animasi
        console.error('[toimage] dwebp gagal, coba ffmpeg:', e.message);
        await videoFrame(input, out, sec);
      }
    } else {
      const input = path.join(dir, 'in.mp4');
      fs.writeFileSync(input, buffer);
      await videoFrame(input, out, sec);
    }

    if (!fs.existsSync(out)) throw new Error('output kosong');
    const png = fs.readFileSync(out);

    if (asDoc) {
      await sock.sendMessage(
        jid,
        { document: png, mimetype: 'image/png', fileName: 'image.png' },
        { quoted: msg }
      );
    } else {
      await sock.sendMessage(jid, { image: png }, { quoted: msg });
    }
  } catch (err) {
    console.error('[toimage]', err);
    if (err.message === 'NO_ANIM_TOOL') {
      await reply('Stiker animasi butuh ImageMagick di Termux:\npkg install imagemagick');
    } else {
      await reply('Gagal mengubah ke gambar.');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
