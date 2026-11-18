// commands/downloader/play.js
// .play <judul lagu | link YouTube>  -> kirim thumbnail + info, lirik, lalu file audio
//
// Butuh  : yt-dlp dan ffmpeg (sudah dipakai commands/ytmp4.js), cookies.txt opsional
//          utils/process.js, utils/react.js, utils/sendMedia.js, utils/segdl.js
// Lirik  : dari lrclib.net (gratis, tanpa key)
// Alur   : 1) coba unduh audio m4a langsung (segdl, progres MB asli)
//          2) kalau gagal, cadangan: yt-dlp -> mp3 (progres MB asli juga)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
try { process.loadEnvFile(path.join(__dirname, '../../.env')); } catch {}

const { createProcess } = require('../../utils/process');
const { withProcessReact } = require('../../utils/react');
const { sendMediaFile } = require('../../utils/sendMedia');

// ---------- SETTING (dibaca .settings) ----------
// Tampilkan pesan proses (bar progres) saat menunggu.
// Opsi: true | false
const SETTING_Tampilkan_Proses = true;

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp'; // lokasi yt-dlp
const COOKIES_PATH = path.join(__dirname, '..', '..', 'cookies.txt'); // opsional, dipakai jika ada
const MAX_DURASI = 10 * 60; // batas durasi lagu (detik)
const MAX_MB = 30; // batas ukuran unduhan
const MAX_INPUT = 150; // batas panjang judul
const MAX_LIRIK = 4000; // batas panjang lirik yang dikirim
const COOLDOWN_MS = 15 * 1000; // jeda per pengirim
const BATAS_UNDUH_MS = 3 * 60 * 1000; // batas waktu jalur utama sebelum pindah ke cadangan
const KONEKSI = 4; // koneksi paralel segdl (turunkan ke 2 atau 1 jika sering HTTP 403)

const YT_REGEX = /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]{6,}/i;

const cooldown = new Map(); // pengirim -> waktu terakhir
let sibuk = false; // hanya satu lagu diproses dalam satu waktu (hemat RAM HP)

// Error dengan pesan siap kirim ke WhatsApp
function galat(pesan, detail) {
  const err = new Error(detail || pesan);
  err.pesan = pesan;
  return err;
}

function getQuotedText(m) {
  const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  return q?.conversation || q?.extendedTextMessage?.text || '';
}

function jalankan(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    // execFile (bukan exec) agar input pengguna tidak dijalankan sebagai perintah shell
    execFile(cmd, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(-300)));
      resolve(String(stdout));
    });
  });
}

// Batas waktu untuk sebuah proses (promise)
function batas(p, ms) {
  let t;
  const habis = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('unduhan terlalu lama')), ms);
  });
  return Promise.race([p, habis]).finally(() => clearTimeout(t));
}

function cookieArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

function pesanYtdlp(msg) {
  if (/ENOENT/.test(msg)) return '❌ yt-dlp belum terpasang di server.';
  if (/sign in|confirm you|cookies|bot/i.test(msg)) return '❌ YouTube meminta verifikasi. Taruh cookies.txt di folder bot (seperti untuk .ytmp4).';
  if (/unavailable|private|removed|not available/i.test(msg)) return '❌ Video tidak tersedia.';
  return '❌ Gagal memproses lagu, coba lagi nanti.';
}

function fmtDurasi(detik) {
  const m = Math.floor(detik / 60);
  const s = Math.floor(detik % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Ambil info lagu dari link atau hasil pencarian teratas
async function ambilInfo(target) {
  const out = await jalankan(YTDLP_BIN, ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), '--', target], 90000);
  let info = JSON.parse(out);
  if (info.entries) info = info.entries.find(Boolean);
  if (!info || !info.id) throw galat('❌ Lagu tidak ditemukan. Coba judul lain.', 'tidak ada hasil');
  if (info.duration && info.duration > MAX_DURASI) {
    throw galat(`❌ Lagu terlalu panjang (maks ${MAX_DURASI / 60} menit).`, 'terlalu panjang');
  }
  return info;
}

// Pilih audio m4a langsung (tanpa konversi), bitrate tertinggi
function pilihAudio(info) {
  return (info.formats || [])
    .filter((x) => x.url && x.protocol === 'https' && x.ext === 'm4a'
      && x.vcodec === 'none' && x.acodec !== 'none'
      && (!x.filesize || x.filesize <= MAX_MB * 1048576))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;
}

// Jalankan yt-dlp dengan spawn, baca progres "DL:diunduh/total" per baris
function unduhDenganProgres(args, onProgres) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP_BIN, args);
    let err = '';
    let sisa = '';
    p.stdout.on('data', (d) => {
      sisa += String(d);
      const baris = sisa.split('\n');
      sisa = baris.pop(); // potongan terakhir belum lengkap
      for (const b of baris) {
        const mt = b.match(/^DL:(\d+)\/(\d+)/);
        if (mt) onProgres(Number(mt[1]), Number(mt[2]));
      }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (kode) =>
      kode === 0 ? resolve() : reject(new Error(err.slice(-300))));
  });
}

// Cadangan: unduh audio jadi mp3 ke folder sementara
async function unduhMp3(id, dir, onProgres) {
  const dasar = path.join(dir, 'lagu');
  await unduhDenganProgres([
    '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
    '--no-playlist', '--no-warnings', '--max-filesize', `${MAX_MB}M`,
    '--newline',
    '--progress-template',
    'download:DL:%(progress.downloaded_bytes)s/%(progress.total_bytes,progress.total_bytes_estimate)s',
    ...cookieArgs(),
    '-o', dasar + '.%(ext)s',
    '--', `https://www.youtube.com/watch?v=${id}`,
  ], onProgres);
  const file = dasar + '.mp3';
  if (!fs.existsSync(file)) throw galat(`❌ Gagal mengunduh audio (mungkin lebih dari ${MAX_MB} MB).`, 'file tidak ada');
  return file;
}

async function ambilThumb(id) {
  for (const q of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  return null;
}

function bersihkanJudul(t) {
  return String(t || '')
    .replace(/[(\[【].*?[)\]】]/g, ' ')
    .replace(/\b(official|video|music|lyric|lyrics|lirik|audio|mv|hd|hq|4k|clip|ft|feat)\b\.?/gi, ' ')
    .replace(/[-–—|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cari lirik di lrclib.net, kalau gagal cukup return null (lirik tidak wajib)
async function ambilLirik(info) {
  try {
    const q = info.artist && info.track ? `${info.artist} ${info.track}` : bersihkanJudul(info.title);
    if (!q) return null;
    const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'smbot (bot WhatsApp)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const hasil = await r.json();
    const dur = info.duration || 0;
    const cocok = (Array.isArray(hasil) ? hasil : [])
      .filter((x) => x && x.plainLyrics && !x.instrumental)
      .map((x) => ({ x, selisih: Math.abs((x.duration || 0) - dur) }))
      .filter((o) => !dur || o.selisih <= 30) // durasi harus mirip supaya tidak salah lagu
      .sort((a, b) => a.selisih - b.selisih)[0];
    return cocok ? cocok.x.plainLyrics.trim() : null;
  } catch {
    return null;
  }
}

module.exports = async (sock, m, args) => {
  const jid = m.key.remoteJid;
  const input = ((args || []).join(' ').trim() || getQuotedText(m).trim());
  const balas = (text) => sock.sendMessage(jid, { text }, { quoted: m });

  // ---------- validasi input (cukup balas pesan biasa) ----------
  if (!input) {
    await balas('Cara pakai: .play <judul lagu atau link YouTube>\nContoh: .play nama lagu - penyanyi');
    return false;
  }
  const link = input.match(/https?:\/\/\S+/)?.[0];
  if (link && !YT_REGEX.test(link)) {
    await balas('Link yang didukung hanya link YouTube. Atau ketik judul lagunya saja.');
    return false;
  }
  if (!link && input.length > MAX_INPUT) {
    await balas(`Judul terlalu panjang (maks ${MAX_INPUT} karakter).`);
    return false;
  }
  if (sibuk) {
    await balas('Masih ada lagu yang sedang diproses, tunggu sebentar ya.');
    return false;
  }
  const pengirim = m.key.fromMe ? 'me' : m.key.participant || jid;
  const sisaTunggu = COOLDOWN_MS - (Date.now() - (cooldown.get(pengirim) || 0));
  if (sisaTunggu > 0) {
    await balas(`Tunggu ${Math.ceil(sisaTunggu / 1000)} detik lagi ya.`);
    return false;
  }
  cooldown.set(pengirim, Date.now());

  // ---------- pesan proses ----------
  const proc = withProcessReact(
    createProcess(sock, m, SETTING_Tampilkan_Proses),
    sock,
    m
  );
  const gagal = async (teks) =>
    SETTING_Tampilkan_Proses
      ? proc.fail(teks)
      : sock.sendMessage(jid, { text: teks }, { quoted: m });

  sibuk = true;
  let dir = null;
  try {
    await proc.update('🔎 Mencari lagu...', 10, true);
    const info = await ambilInfo(link || `ytsearch1:${input}`);
    const judul = info.track || info.title || 'Lagu';

    await proc.update('📝 Mengambil thumbnail dan lirik...', 30, true);
    const [thumb, lirik] = await Promise.all([ambilThumb(info.id), ambilLirik(info)]);

    // 1) thumbnail + info
    let caption = `🎵 *${judul}*\n`;
    const penyanyi = info.artist || info.channel || info.uploader;
    if (penyanyi) caption += `👤 ${penyanyi}\n`;
    if (info.duration) caption += `⏱️ ${fmtDurasi(info.duration)}\n`;
    caption += `🔗 https://youtu.be/${info.id}`;
    if (!lirik) caption += '\n\n_Lirik tidak ditemukan._';
    if (thumb) await sock.sendMessage(jid, { image: thumb, caption }, { quoted: m });
    else await balas(caption);

    // 2) lirik
    if (lirik) {
      let teks = lirik;
      if (teks.length > MAX_LIRIK) {
        teks = teks.slice(0, MAX_LIRIK);
        teks = teks.slice(0, teks.lastIndexOf('\n') > 0 ? teks.lastIndexOf('\n') : MAX_LIRIK) + '\n...(lirik terpotong)';
      }
      await balas(`📜 *Lirik*\n\n${teks}`);
    }

    // 3) audio
    await proc.update('⬇️ Mengunduh audio...', 45, true);
    const fmt = pilihAudio(info);
    let terkirim = false;

    // jalur utama: m4a langsung lewat segdl (progres MB asli)
    if (fmt) {
      try {
        await batas(
          sendMediaFile(sock, m, fmt.url, {
            headers: fmt.http_headers,
            connections: KONEKSI,
            onProgress: ({ loaded, total, done }) => {
              if (done) proc.update('📤 Mengirim hasil...', 90, true).catch(() => {});
              else proc.download('⬇️ Mengunduh audio...', loaded, total, 45, 85);
            },
          }),
          BATAS_UNDUH_MS
        );
        terkirim = true;
      } catch (e) {
        console.log('[play] segdl gagal, pakai yt-dlp:', e && e.message);
      }
    }

    // cadangan: yt-dlp -> mp3
    if (!terkirim) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
      await proc.update('⬇️ Mengunduh audio (cadangan)...', 50, true);
      const file = await unduhMp3(info.id, dir, (dl, total) =>
        proc.download('⬇️ Mengunduh audio (cadangan)...', dl, total, 50, 85));
      await proc.update('📤 Mengirim hasil...', 90, true);
      const namaFile = judul.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'lagu';
      await sock.sendMessage(
        jid,
        { audio: { url: file }, mimetype: 'audio/mpeg', fileName: `${namaFile}.mp3` },
        { quoted: m }
      );
    }

    await proc.done();
    return true;
  } catch (e) {
    console.log('[play] error:', e && e.message);
    await gagal(e.pesan || pesanYtdlp(String(e && e.message)));
    return false; // dibaca withReaction -> reaksi akhir ❌
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    sibuk = false;
  }
};
