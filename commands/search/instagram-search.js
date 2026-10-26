// commands/search/instagram.js
// .ig KATA_KUNCI        -> cari postingan Instagram, kirim 1 hasil
//                          (media + caption + 👤 @username)
// .instagram KATA_KUNCI -> sama, tapi caption + deskripsi +
//                          👤 *Nama* @username (kolaborator digabung *X*)
//
// Mandiri: tidak bergantung pada commands/downloader/instagram.js
// Butuh  : npm i btch-downloader, utils/segdl.js, utils/sendMedia.js

const { igdl } = require('btch-downloader');
const { execFile } = require('child_process');
const { sendMediaFile } = require('../../utils/sendMedia');

// ---------- SETTING (dibaca .settings) ----------
// Jenis media yang ditampilkan.
// Opsi: 'video' (reel/video) | 'image' (foto) | 'random' (campur)
const SETTING_Tampilan_Media = 'video';

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A065F) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const IG_REGEX =
  /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i;
const IG_REGEX_G = new RegExp(IG_REGEX.source, 'gi');

const MAX_MEDIA = 10;
const MAX_CAPTION = 1000;
const MAX_TRY = 5; // jumlah kandidat hasil pencarian yang dicoba

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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
    console.log('[instagram-search] og:', res.status, JSON.stringify({ title: title.slice(0, 120), desc: desc.slice(0, 120) }));

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
    console.log('[instagram-search] og gagal:', e.message);
  }
  return out;
}

// Ambil caption, username, nama dari halaman embed publik Instagram
async function fetchMeta(shortcode) {
  const meta = { caption: '', username: '', name: '', authors: [] };
  try {
    // lewat curl: permintaan fetch Node kadang dijawab halaman kosong oleh Instagram
    const { status, html } = await httpGet(
      `https://www.instagram.com/p/${shortcode}/embed/captioned/`
    );
    console.log('[instagram-search] embed:', status, html.length, 'bytes');

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
    console.log('[instagram-search] meta gagal:', e.message);
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

// Ambil daftar URL media (foto/video, termasuk carousel)
async function fetchMedia(url) {
  for (const u of [url.replace(/\/$/, ''), url.replace(/\/?$/, '/')]) {
    try {
      const r = await igdl(u);
      const list = Array.isArray(r) ? r : r?.result || [];
      const urls = [...new Set(list.map((x) => x.url).filter(Boolean))].slice(0, MAX_MEDIA);
      console.log('[instagram-search] igdl:', u, '->', urls.length,
        urls.length ? '' : '| respons: ' + JSON.stringify(r).slice(0, 300));
      if (urls.length) return urls;
    } catch (e) {
      console.log('[instagram-search] igdl gagal:', u, errInfo(e));
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

// ---------- kirim satu postingan ----------

async function sendPost(sock, m, shortcode, link, mode, requireMeta = false) {
  const meta = await fetchMeta(shortcode);
  if (requireMeta && !meta.username && !meta.caption) {
    const err = new Error('metadata kosong');
    err.noMeta = true;
    throw err;
  }
  const urls = await fetchMedia(link);
  if (!urls.length) throw new Error('media tidak ditemukan');

  console.log('[instagram-search] meta:', JSON.stringify(meta));
  console.log('[instagram-search] media urls:', urls.length);
  const text = buildText(meta, mode);

  for (let i = 0; i < urls.length; i++) {
    try {
      // caption hanya di media pertama
      await sendMediaFile(sock, m, urls[i], { caption: i === 0 ? text : undefined });
    } catch (e) {
      // gagal di media pertama = gagal total (kandidat lain dicoba);
      // gagal di media berikutnya = lewati saja
      if (i === 0) throw e;
      console.log(`[instagram-search] media ${i + 1} gagal, dilewati:`, e.message);
    }
  }
}

// ---------- pencarian ----------
// Instagram tidak punya pencarian publik tanpa login, jadi link dicari
// lewat mesin pencari (Brave Search).

function errInfo(e) {
  const c = e && e.cause;
  return (e && e.message) + (c ? ` (${c.code || c.message})` : '');
}

async function getText(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  return { status: res.status, html: await res.text() };
}

// Kumpulkan semua kemungkinan link Instagram dari HTML hasil pencarian
function extractIgUrls(html) {
  const urls = [];
  // 1) link dibungkus Bing: ...&u=a1<base64>
  for (const mm of html.matchAll(/[?&;]u=a1([A-Za-z0-9_-]+)/g)) {
    try { urls.push(Buffer.from(mm[1], 'base64').toString()); } catch {}
  }
  // 2) link dibungkus DuckDuckGo: uddg=<url-encoded>
  for (const mm of html.matchAll(/uddg=([^"&]+)/g)) {
    try { urls.push(decodeURIComponent(mm[1])); } catch {}
  }
  // 3) link langsung (termasuk versi url-encoded)
  const decoded = html.replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  for (const src of [html, decoded]) {
    for (const mm of src.matchAll(IG_REGEX_G)) urls.push(mm[0]);
  }
  return urls;
}

function collect(urls, tampilan) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const g = u.match(IG_REGEX);
    if (!g || seen.has(g[1])) continue;
    seen.add(g[1]);
    const isVideo = /\/(reel|reels|tv)\//i.test(g[0]);
    if (tampilan === 'video' && !isVideo) continue;
    if (tampilan === 'image' && isVideo) continue;
    out.push({ url: g[0], shortcode: g[1], isVideo });
  }
  return out;
}

// Brave Search: hasilnya memuat link instagram.com/reel langsung di HTML.
// Diakses lewat curl (fetch bawaan Node ditolak Brave dengan 429 dan kadang
// dijawab halaman kosong oleh Instagram, sedangkan curl lolos).
// Kalau curl tidak ada, jatuh ke fetch.
const CURL_UA = 'Mozilla/5.0 (Linux; Android 13)';

function curlText(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-s', '-L', '--max-time', '15', '-A', CURL_UA, '-w', '\n%{http_code}', url],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const i = stdout.lastIndexOf('\n');
        resolve({ status: parseInt(stdout.slice(i + 1), 10) || 0, html: stdout.slice(0, i) });
      }
    );
  });
}

async function httpGet(url) {
  try {
    return await curlText(url);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log('[instagram-search] curl tidak ditemukan, pakai fetch');
    return getText(url, { headers: { 'User-Agent': CURL_UA } });
  }
}

async function searchBrave(q) {
  const { status, html } = await httpGet(
    `https://search.brave.com/search?q=${encodeURIComponent(q)}`
  );
  const urls = extractIgUrls(html);
  console.log('[instagram-search] brave:', status, html.length, 'bytes | link IG:', urls.length);
  if (status === 429) {
    const err = new Error('dibatasi Brave (429)');
    err.rateLimited = true;
    throw err;
  }
  return urls;
}

function buildQueries(keyword, tampilan) {
  if (tampilan === 'video') {
    return [`site:instagram.com/reel ${keyword}`, `instagram reel ${keyword}`, `${keyword} instagram.com/reel`];
  }
  if (tampilan === 'image') {
    return [`site:instagram.com/p ${keyword}`, `instagram post ${keyword}`];
  }
  return [`site:instagram.com ${keyword}`, `instagram ${keyword}`];
}

// cache hasil pencarian (kurangi permintaan ke Brave)
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function searchPosts(keyword, tampilan) {
  const key = `${tampilan}|${keyword.toLowerCase()}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    console.log('[instagram-search] dari cache:', hit.posts.length);
    return hit.posts;
  }

  for (const q of buildQueries(keyword, tampilan)) {
    try {
      console.log('[instagram-search] cari:', q);
      const posts = collect(await searchBrave(q), tampilan);
      console.log('[instagram-search] hasil:', posts.length);
      if (posts.length) {
        CACHE.set(key, { t: Date.now(), posts });
        return posts;
      }
    } catch (e) {
      console.log('[instagram-search] brave gagal:', errInfo(e));
      if (e.rateLimited) throw e; // jangan lanjut menembak kalau sudah dibatasi
    }
  }
  return [];
}

async function searchAndSend(sock, m, keyword, mode) {
  const jid = m.key.remoteJid;
  const tampilan = ['video', 'image', 'random'].includes(SETTING_Tampilan_Media)
    ? SETTING_Tampilan_Media
    : 'random';

  const posts = await searchPosts(keyword, tampilan);
  if (!posts.length) {
    return sock.sendMessage(
      jid,
      { text: `Tidak ada hasil untuk "${keyword}". Coba kata kunci lain.` },
      { quoted: m }
    );
  }

  // Utamakan kandidat yang caption/username-nya terbaca. Kalau semua kosong,
  // kirim satu tanpa caption daripada tidak mengirim apa-apa.
  let noMeta = null;
  for (const p of shuffle(posts).slice(0, MAX_TRY)) {
    try {
      await sendPost(sock, m, p.shortcode, p.url, mode, true);
      return;
    } catch (e) {
      console.log('[instagram-search] kandidat gagal:', p.url, e.message);
      if (e.noMeta && !noMeta) noMeta = p;
    }
  }
  if (noMeta) {
    try {
      await sendPost(sock, m, noMeta.shortcode, noMeta.url, mode, false);
      return;
    } catch (e) {
      console.log('[instagram-search] cadangan tanpa caption gagal:', e.message);
    }
  }

  await sock.sendMessage(
    jid,
    { text: 'Hasil ditemukan tapi gagal diunduh (mungkin privat). Coba kata kunci lain.' },
    { quoted: m }
  );
}

// ---------- handler ----------
// mode: 'short' (.ig) | 'full' (.instagram)

module.exports = async function instagramSearch(sock, m, args, mode = 'short') {
  const jid = m.key.remoteJid;
  const keyword = (args || []).join(' ').trim();

  if (!keyword) {
    const cmd = mode === 'full' ? '.instagram' : '.ig';
    return sock.sendMessage(
      jid,
      { text: `Kirim kata kunci pencarian.\nContoh: ${cmd} kucing lucu` },
      { quoted: m }
    );
  }

  try {
    await searchAndSend(sock, m, keyword, mode);
  } catch (e) {
    console.log('[instagram-search] error:', e);
    await sock.sendMessage(
      jid,
      { text: e.rateLimited
          ? 'Pencarian sedang dibatasi mesin pencari. Coba lagi beberapa menit lagi.'
          : 'Pencarian gagal. Coba lagi nanti.' },
      { quoted: m }
    );
  }
};
