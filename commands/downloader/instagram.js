// commands/downloader/instagram.js
// .ins LINK        -> media + caption + 👤 @username
// .instagram LINK  -> media + caption + deskripsi + 👤 *Nama* @username
//
// Unduhan memakai sistem segmen paralel ala IDM (utils/segdl.js lewat
// utils/sendMedia.js): file ditulis ke disk, bukan ke RAM, dan segmen
// yang putus dilanjutkan dari byte terakhir.
//
// Install: npm i btch-downloader   (.npmrc legacy-peer-deps sudah ada)
// Butuh  : utils/segdl.js dan utils/sendMedia.js

const { igdl } = require('btch-downloader');
const { sendMediaFile } = require('../../utils/sendMedia');

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
    console.log('[instagram] embed:', res.status, html.length, 'bytes');

    const user =
      html.match(/class="CaptionUsername"[^>]*>([^<]+)</) ||
      html.match(/class="UsernameText"[^>]*>([^<]+)</);
    if (user) meta.username = decodeEntities(user[1]).trim();

    const nameMatch = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
    if (nameMatch) {
      try { meta.name = JSON.parse(`"${nameMatch[1]}"`).trim(); } catch {}
    }

    meta.authors = parseAuthors(html);

    const block = html.match(/<div class="Caption">([\s\S]*?)(?:<div class="CaptionComments"|<\/div>)/);
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
  if (!meta.caption || !meta.username) {
    const og = await fetchOg(shortcode);
    meta.caption = meta.caption || og.caption;
    meta.username = meta.username || og.username;
    meta.name = meta.name || og.name;
  }
  if (!meta.authors.length && meta.username) {
    meta.authors.push({ username: meta.username, name: meta.name });
  }
  if (!meta.username && meta.authors[0]) meta.username = meta.authors[0].username;
  return meta;
}

function ogContent(html, prop) {
  const a = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content="([^"]*)"`, 'i'));
  const b = html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property=["']${prop}["']`, 'i'));
  const v = (a || b || [])[1];
  return v ? decodeEntities(v).trim() : '';
}

// Cadangan: ambil judul/username dari tag og: (seperti preview link)
async function fetchOg(shortcode) {
  const out = { caption: '', username: '', name: '' };
  try {
    const res = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    const title = ogContent(html, 'og:title');
    const desc = ogContent(html, 'og:description');
    console.log('[instagram] og:', res.status, JSON.stringify({ title: title.slice(0, 120), desc: desc.slice(0, 120) }));

    const t = title.match(/^(.*?)\s*\(@([\w.]+)\)\s+on Instagram:?\s*["“]?([\s\S]*?)["”]?$/);
    if (t) {
      out.name = t[1].trim();
      out.username = t[2];
      out.caption = t[3].trim();
    } else {
      const t2 = title.match(/^([\w.]+)\s+on Instagram:?\s*["“]?([\s\S]*?)["”]?$/);
      if (t2) { out.username = t2[1]; out.caption = t2[2].trim(); }
    }
    if (!out.caption) {
      const d = desc.match(/:\s*["“]([\s\S]*?)["”]\.?\s*$/);
      if (d) out.caption = d[1].trim();
    }
    if (!out.username) {
      const u = desc.match(/ - ([\w.]+) on /);
      if (u) out.username = u[1];
    }
  } catch (e) {
    console.log('[instagram] og gagal:', e.message);
  }
  return out;
}

// Ambil daftar URL media (foto/video, termasuk carousel).
// Link tanpa "/" di ujung dicoba dulu (dengan "/" igdl sering memberi hasil kosong).
async function fetchMedia(url) {
  for (const u of [url.replace(/\/$/, ''), url.replace(/\/?$/, '/')]) {
    try {
      const r = await igdl(u);
      const list = Array.isArray(r) ? r : r?.result || [];
      const urls = [...new Set(list.map((x) => x.url).filter(Boolean))].slice(0, MAX_MEDIA);
      console.log('[instagram] igdl:', u, '->', urls.length,
        urls.length ? '' : '| respons: ' + JSON.stringify(r).slice(0, 300));
      if (urls.length) return urls;
    } catch (e) {
      console.log('[instagram] igdl gagal:', u, e.message);
    }
  }
  return [];
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
      try {
        // caption hanya di media pertama
        await sendMediaFile(sock, m, urls[i], { caption: i === 0 ? text : undefined });
      } catch (e) {
        // gagal di media pertama = gagal total; di media berikutnya = dilewati
        if (i === 0) throw e;
        console.log(`[instagram] media ${i + 1} gagal, dilewati:`, e.message);
      }
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
