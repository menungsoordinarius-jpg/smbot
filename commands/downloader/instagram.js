// commands/downloader/instagram.js
// .ins LINK        -> media + caption + 👤 @username
// .instagram LINK  -> media + caption + deskripsi + 👤 *Nama* @username
//
// Install: npm i btch-downloader   (.npmrc legacy-peer-deps sudah ada)

const { igdl } = require('btch-downloader');

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A065F) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const IG_REGEX =
  /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i;

const MAX_MEDIA = 10;
const MAX_CAPTION = 1000;

// ---------- helpers ----------

function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cut(str, max) {
  return str.length > max ? str.slice(0, max - 1).trimEnd() + '…' : str;
}

function deepFind(obj, key, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return undefined;
  seen.add(obj);
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key, seen);
    if (r !== undefined) return r;
  }
  return undefined;
}

// Pemilik postingan + semua kolaborator (urut, tanpa duplikat)
function parseAuthors(html) {
  const authors = [];
  const add = (u) => {
    if (!u || !u.username || authors.some((a) => a.username === u.username)) return;
    authors.push({ username: u.username, name: (u.full_name || '').trim() });
  };
  try {
    const m = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
    if (m) {
      const ctx = JSON.parse(JSON.parse(`"${m[1]}"`));
      const media = deepFind(ctx, 'shortcode_media') || ctx;
      add(media.owner || deepFind(media, 'owner'));
      const co = deepFind(media, 'coauthor_producers');
      if (Array.isArray(co)) co.forEach(add);
    }
  } catch {}
  return authors;
}

// Ambil caption, username, nama dari halaman embed publik Instagram
async function fetchMeta(shortcode) {
  const meta = { caption: '', username: '', name: '', authors: [] };
  try {
    const res = await fetch(
      `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    const html = await res.text();

    const user =
      html.match(/class="CaptionUsername"[^>]*>([^<]+)</) ||
      html.match(/class="UsernameText"[^>]*>([^<]+)</);
    if (user) meta.username = decodeEntities(user[1]).trim();

    const nameMatch = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
    if (nameMatch) {
      try { meta.name = JSON.parse(`"${nameMatch[1]}"`).trim(); } catch {}
    }

    meta.authors = parseAuthors(html);

    const block = html.match(/<div class="Caption">([\s\S]*?)<div class="CaptionComments"/);
    if (block) {
      meta.caption = decodeEntities(
        block[1]
          .replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
      ).trim();
    }
  } catch (e) {
    console.log('[instagram] meta gagal:', e.message);
  }
  if (!meta.authors.length && meta.username) {
    meta.authors.push({ username: meta.username, name: meta.name });
  }
  if (!meta.username && meta.authors[0]) meta.username = meta.authors[0].username;
  return meta;
}

// Ambil daftar URL media (foto/video, termasuk carousel)
async function fetchMedia(url) {
  const r = await igdl(url);
  const list = Array.isArray(r) ? r : r?.result || [];
  const urls = list.map((x) => x.url).filter(Boolean);
  return [...new Set(urls)].slice(0, MAX_MEDIA);
}

// Deteksi tipe file dari byte awal (lebih andal daripada content-type)
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image'; // JPEG
  if (buf.subarray(1, 4).toString() === 'PNG') return 'image';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image';
  if (buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (['avif', 'heic', 'heix', 'mif1'].includes(brand)) return null;
    return 'video'; // MP4 / MOV
  }
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return 'video'; // WebM
  return null;
}

// Unduh ke buffer, tentukan tipe dari isi file
async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const kind = sniff(buffer);
  console.log('[instagram] media:', {
    status: res.status,
    contentType: res.headers.get('content-type'),
    size: buffer.length,
    kind,
    head: buffer.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
    url: url.slice(0, 100),
  });
  if (!kind) throw new Error('hasil unduhan bukan foto/video yang valid');
  return { buffer, isVideo: kind === 'video' };
}

function buildText(meta, mode) {
  const handle = meta.username ? `@${meta.username}` : '';

  if (mode === 'short') {
    // judul = baris pertama caption
    const title = meta.caption.split('\n')[0].trim();
    const body = cut(title, MAX_CAPTION);
    const footer = handle ? `👤 ${handle}` : '';
    return [body, footer].filter(Boolean).join('\n\n');
  }

  // mode 'full': caption = baris pertama, deskripsi = sisanya
  const [first = '', ...rest] = meta.caption.split('\n');
  const desc = rest.join('\n').trim();
  const top = [first.trim(), desc].filter(Boolean).join('\n');
  const footer = meta.authors
    .map((a) => `👤 ${a.name ? `*${a.name}* ` : ''}@${a.username}`)
    .join(' *X* ');
  return [cut(top, MAX_CAPTION), footer].filter(Boolean).join('\n\n');
}

// ---------- handler ----------

module.exports = async function instagram(sock, m, args, mode = 'short') {
  const jid = m.key.remoteJid;
  const input = (args || []).join(' ');
  const match = input.match(IG_REGEX);

  if (!match) {
    const cmd = mode === 'full' ? '.instagram' : '.ins';
    return sock.sendMessage(
      jid,
      { text: `Kirim link Instagram yang valid.\nContoh: ${cmd} https://www.instagram.com/reel/xxxx/` },
      { quoted: m }
    );
  }

  const shortcode = match[1];

  try {
    const [meta, urls] = await Promise.all([
      fetchMeta(shortcode),
      fetchMedia(match[0]),
    ]);

    if (!urls.length) throw new Error('media tidak ditemukan');

    console.log('[instagram] meta:', JSON.stringify(meta));
    console.log('[instagram] media urls:', urls.length);
    const text = buildText(meta, mode);

    for (let i = 0; i < urls.length; i++) {
      const { buffer, isVideo } = await download(urls[i]);
      const content = isVideo ? { video: buffer, mimetype: 'video/mp4' } : { image: buffer };
      if (i === 0 && text) content.caption = text; // caption hanya di media pertama
      await sock.sendMessage(jid, content, { quoted: m });
    }
  } catch (e) {
    console.log('[instagram] error:', e);
    await sock.sendMessage(
      jid,
      { text: 'Gagal mengunduh. Pastikan postingan publik dan linknya benar.' },
      { quoted: m }
    );
  }
};
