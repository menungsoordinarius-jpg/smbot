const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { prepareWAMessageMedia } = require('@whiskeysockets/baileys');

// ===== KONFIGURASI =====
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';             // lokasi yt-dlp
const COOKIES_PATH = path.join(__dirname, '..', 'cookies.txt');  // opsional, dipakai jika ada
const MAX_HEIGHT = 1080;          // kualitas tertinggi
const MAX_MB = 200;               // batas ukuran file
const MAX_DURATION = 20 * 60;     // batas durasi video (detik)
const SESSION_TTL = 10 * 60 * 1000;

const YT_REGEX = /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]{6,}/i;

// id pesan info -> { url, title, formats, userJid }
const ytSessions = new Map();

// ===== UTIL =====
function getQuotedText(m) {
  const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  return q?.conversation || q?.extendedTextMessage?.text || '';
}

function fmtSize(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function run(cmd, args, timeout = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    // execFile (bukan exec) agar link dari pengguna tidak dijalankan sebagai perintah shell
    execFile(cmd, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(-300)));
      resolve(String(stdout));
    });
  });
}

function cookieArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

async function getThumb(id) {
  for (const q of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  return null;
}
async function uploadThumb(sock, buf) {
  if (!buf) return undefined;
  try {
    const { imageMessage } = await prepareWAMessageMedia(
      { image: buf },
      { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
    );
    return imageMessage;
  } catch (e) {
    console.error('uploadThumb gagal:', e.message);
    return undefined;
  }
}

// Antrean: hanya satu unduhan diproses dalam satu waktu
let queue = Promise.resolve();
let pending = 0;
function enqueue(task) {
  pending++;
  const job = queue.then(task);
  queue = job.catch(() => {}).then(() => { pending--; });
  return job;
}

// ===== AMBIL INFO =====
async function fetchInfo(link) {
  const out = await run(YTDLP_BIN, ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), '--', link], 60000);
  const info = JSON.parse(out);

  if (info.duration && info.duration > MAX_DURATION) {
    throw new Error(`Video terlalu panjang (maks ${MAX_DURATION / 60} menit)`);
  }

  const fl = info.formats || [];
  const sz = f => f.filesize || f.filesize_approx || 0;
  const hasVideo = f => f.vcodec && f.vcodec !== 'none';
  const audioSize = Math.max(0, ...fl.filter(f => !hasVideo(f) && f.acodec && f.acodec !== 'none').map(sz));

  const heights = [...new Set(
    fl.filter(f => hasVideo(f) && f.height && f.height <= MAX_HEIGHT).map(f => f.height)
  )].sort((a, b) => a - b);
  if (!heights.length) throw new Error('Tidak ada kualitas yang tersedia');

  return {
    title: info.title,
    id: info.id, 
    channel: info.channel || info.uploader,
    duration: info.duration,
    thumbnail: info.thumbnail,
    formats: heights.map((h, i) => {
      const v = Math.max(0, ...fl.filter(f => hasVideo(f) && f.height === h).map(sz));
      return { num: i + 1, quality: `${h}p`, size: v ? fmtSize(v + audioSize) : '?', height: h };
    })
  };
}

// ===== PERINTAH: .ytmp4 =====
async function handleYtmp4(sock, m, args) {
  const jid = m.key.remoteJid;
  const input = args[0] || getQuotedText(m);
  const link = input.match(/https?:\/\/\S+/)?.[0];

  if (!link || !YT_REGEX.test(link)) {
    const errorMsg =
      `*Link YouTube Tidak Ditemukan*\n\n` +
      `Masukkan atau balas pesan yang berisi link YouTube untuk diunduh.\n\n` +
      `*Contoh penggunaan:*\n` +
      `\`.ytmp4 https://youtu.be/xxxxxx\`\n` +
      `\`.ytmp4 https://www.youtube.com/watch?v=xxxxxx\``;
    return await sock.sendMessage(jid, { text: errorMsg }, { quoted: m });
  }

  try {
    const res = await fetchInfo(link);
    const thumb = await getThumb(res.id);

    let caption = `*INFO:*\n`;
    caption += `  •Channel: ${res.channel}\n`;
    caption += `  •Duration: ${res.duration} seconds\n\n`;
    caption += `📋 *Kualitas yang Dapat Diunduh:*\n\n`;
    res.formats.forEach(f => { caption += `${f.num}. ${f.quality} — ${f.size}\n`; });
    caption += `\n👉 *Pilih Kualitas:*\n`;
    caption += `Balas pesan ini dengan *nomor* pilihan (contoh: \`1\`).`;

    const hq = await uploadThumb(sock, thumb);

    const sentMsg = await sock.sendMessage(jid, {
      text: `${link}\n\n${caption}`,
      linkPreview: {
        'canonical-url': link,
        'matched-text': link,
        title: res.title || 'YouTube',
        description: `by ${res.channel}`,
        jpegThumbnail: thumb || undefined,
        highQualityThumbnail: hq
      }
    }, { quoted: m });

    const id = sentMsg.key.id;
    ytSessions.set(id, {
      url: link,
      title: res.title || 'video',
      formats: res.formats,
      userJid: m.key.participant || m.key.remoteJid
    });
    setTimeout(() => ytSessions.delete(id), SESSION_TTL);

  } catch (err) {
    console.error('Error YTMP4:', err.message);
    const hint = /ENOENT/.test(err.message) ? '\nyt-dlp belum terpasang di server.' : '';
    await sock.sendMessage(jid, { text: `❌ Gagal memproses link.\n${err.message.split('\n')[0]}${hint}` }, { quoted: m });
  }
}
// ===== UNDUH & KIRIM =====
async function ensureCompatible(file) {
  const codec = (await run('ffprobe', ['-v','error','-select_streams','v:0',
    '-show_entries','stream=codec_name','-of','csv=p=0', file])).trim();
  if (codec === 'h264') return file;
  const out = file.replace('.mp4', '_h264.mp4');
  await run('ffmpeg', ['-y','-i',file,'-c:v','libx264','-preset','veryfast',
    '-c:a','aac','-movflags','+faststart', out], 30 * 60 * 1000);
  return out;
}
async function downloadVideo(link, height) {
  const dir = path.join(__dirname, '..');
  const base = `temp_${Date.now()}`;
  const file = path.join(dir, `${base}.mp4`);
  const h = Number(height);
  const selector =
    `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][vcodec^=avc1]/bv*[height<=${h}]+ba/b[height<=${h}]`;

  const cleanup = () => {
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith(base)) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
    }
  };

  try {
    await run(YTDLP_BIN, [
      '-f', selector,
      '--merge-output-format', 'mp4', '--remux-video', 'mp4',
      '--no-playlist', '--no-warnings', '--max-filesize', `${MAX_MB}M`,
      ...cookieArgs(),
      '-o', path.join(dir, `${base}.%(ext)s`),
      '--', link
    ]);
    if (!fs.existsSync(file)) throw new Error(`Ukuran file melebihi ${MAX_MB} MB, pilih kualitas lebih rendah`);
    finalFile = await ensureCompatible(file);
    if (fs.statSync(file).size > MAX_MB * 1048576) throw new Error(`Ukuran file melebihi ${MAX_MB} MB`);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { file, cleanup };
}

async function sendVideo(sock, jid, m, file, caption, fileName) {
  const size = fs.statSync(file).size;
  // File besar langsung dikirim sebagai dokumen agar tidak gagal / dikompres WhatsApp
  if (size > 64 * 1048576) {
    return sock.sendMessage(jid, { document: { url: file }, mimetype: 'video/mp4', fileName, caption }, { quoted: m });
  }
  try {
    await sock.sendMessage(jid, { video: { url: file }, mimetype: 'video/mp4', caption }, { quoted: m });
  } catch {
    await sock.sendMessage(jid, { document: { url: file }, mimetype: 'video/mp4', fileName, caption }, { quoted: m });
  }
}

// ===== BALASAN NOMOR PILIHAN =====
// Mengembalikan true jika pesan ditangani
async function handleYtReply(sock, m, text) {
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const session = ctx?.stanzaId && ytSessions.get(ctx.stanzaId);
  if (!session) return false;

  const jid = m.key.remoteJid;
  if ((m.key.participant || jid) !== session.userJid) return false; // hanya peminta yang boleh memilih

  const pick = session.formats.find(f => f.num === parseInt(text.trim(), 10));
  if (!pick) {
    await sock.sendMessage(jid, { text: `Nomor tidak valid. Pilih 1 sampai ${session.formats.length}.` }, { quoted: m });
    return true;
  }

  const caption = `${session.title}\n${pick.quality}`;
  const fileName = `${session.title}.mp4`.replace(/[\\/:*?"<>|]/g, '');
  const waiting = pending > 0 ? `⏳ Masuk antrean (${pending} di depan)...` : `⏳ Mengunduh ${pick.quality}...`;

  try {
    await sock.sendMessage(jid, { text: waiting }, { quoted: m });
    await enqueue(async () => {
      const { file, cleanup } = await downloadVideo(session.url, pick.height);
      try {
        await sendVideo(sock, jid, m, file, caption, fileName);
      } finally {
        cleanup();
      }
    });
  } catch (err) {
    console.error('Gagal kirim video:', err.message);
    await sock.sendMessage(jid, { text: `❌ ${err.message.split('\n')[0]}` }, { quoted: m });
  }
  return true;
}

module.exports = { handleYtmp4, handleYtReply, ytSessions };
			
