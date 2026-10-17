// commands/search/pixiv.js — fitur .pixiv untuk smbot (Baileys)
// Butuh Node 18+ (fetch bawaan). Tanpa dependency tambahan.

const { react } = require('../../utils/react');

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A065F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.pixiv.net/',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ===== Pengaturan =====
const SAFE_MAX_SL = 2;          // sanity level maksimal (0-2 = aman)
const MAX_PAGES = 10;           // batas halaman per postingan
const SHOW_WARNING = false;     // true = tambah teks peringatan di caption
const WARNING =
  '⚠️ Hasil dari Pixiv, bisa saja ada gambar yang kurang pas meski sudah difilter.';

const BLACKLIST_TAGS = [
  'r-18', 'r18', 'r-18g', 'nsfw', 'nude', 'naked', 'lingerie', 'swimsuit',
  'bikini', 'ecchi', 'gore', 'guro', 'underwear', 'bondage', 'sex', 'hentai',
  'cleavage', 'nipples', 'panties', 'pantsu', 'bloody', 'blood', 'death',
  'suggestive', '水着', '下着', 'エロ', '裸', 'おっぱい', 'パンツ', 'グロ',
];

// ===== Helper =====
async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.message || 'Pixiv API error');
  return json.body;
}

function hasBadTag(tags = []) {
  const list = tags.map((t) => String(t).toLowerCase());
  return list.some((t) => BLACKLIST_TAGS.some((b) => t.includes(b)));
}

function isSafe(item, tags) {
  if (Number(item.xRestrict) !== 0) return false;
  if (item.sl !== undefined && Number(item.sl) > SAFE_MAX_SL) return false;
  if (hasBadTag(tags)) return false;
  return true;
}

function parseInput(text) {
  const t = text.trim();
  const link = t.match(/pixiv\.net\/(?:\w+\/)?artworks\/(\d+)/i) || t.match(/illust_id=(\d+)/i);
  if (link) return { type: 'id', value: link[1] };
  if (/^\d{4,}$/.test(t)) return { type: 'id', value: t };
  return { type: 'search', value: t };
}

async function getDetail(id) {
  const b = await getJSON(`https://www.pixiv.net/ajax/illust/${id}`);
  const tags = (b.tags?.tags || []).map((x) => x.tag);
  return {
    id: b.illustId || id,
    title: b.illustTitle || b.title || 'Untitled',
    artist: b.userName || 'Unknown',
    tags,
    xRestrict: b.xRestrict,
    sl: b.sl,
    pageCount: b.pageCount || 1,
    url: b.urls?.regular || b.urls?.original || b.urls?.small,
  };
}

async function getPageUrls(id) {
  const body = await getJSON(`https://www.pixiv.net/ajax/illust/${id}/pages`);
  return body.map((p) => p.urls?.regular || p.urls?.original).filter(Boolean);
}

async function downloadImage(url, id) {
  const tryUrls = [url, `https://pixiv.re/${id}.jpg`].filter(Boolean);
  for (const u of tryUrls) {
    try {
      const res = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000) return buf;
    } catch {}
  }
  throw new Error('Gagal mengunduh gambar');
}

function buildCaption(d) {
  const tags = d.tags.slice(0, 8).join(', ') || '-';
  let cap = `🎨 *${d.title}*\n👤 ${d.artist}\n🆔 ${d.id}\n📝 ${tags}`;
  if (SHOW_WARNING) cap += `\n\n${WARNING}`;
  return cap;
}

function notFoundText(query) {
  return `
*Gagal Mencari di Pixiv*
Pencarian tidak menemukan hasil atau terjadi kesalahan pada server.
‎
> ‎                                           🔎‎‎ 
> ‎                           No results found
> Try searching in "Tags, Title, Captions" instead.

_Detail: No illustrations found for query:\`${query}\`_`;

}

const USAGE_TEXT = `*Pencarian atau ID Pixiv Tidak Ditemukan*

Silakan masukkan kata kunci pencarian, ID artwork, atau link Pixiv.

*Contoh penggunaan:*
\`.pixiv elaina\` (mencari gambar)
\`.pixiv 12345678\` (berdasarkan ID)`;

// ===== Pencarian =====
async function searchSafe(keyword) {
  const q = encodeURIComponent(keyword);
  const url =
    `https://www.pixiv.net/ajax/search/illustrations/${q}` +
    `?word=${q}&order=date_d&mode=safe&p=1&s_mode=s_tag&type=illust_and_ugoira`;
  const body = await getJSON(url);
  const items = body?.illust?.data || body?.illustManga?.data || [];

  const candidates = items.filter((it) => it.id && isSafe(it, it.tags || []));
  // acak urutan biar hasil tidak itu-itu saja
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, 6);
}

// ===== Kirim (1 gambar atau banyak halaman) =====
async function sendIllust(sock, m, jid, d) {
  const caption = buildCaption(d);
  let urls = [d.url];

  if (d.pageCount > 1) {
    try {
      urls = (await getPageUrls(d.id)).slice(0, MAX_PAGES);
    } catch (e) {
      console.error('[pixiv] gagal ambil halaman:', e.message);
    }
  }

  const buffers = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const fallbackId = urls.length > 1 ? `${d.id}-${i + 1}` : d.id;
      buffers.push(await downloadImage(urls[i], fallbackId));
    } catch {}
  }
  if (!buffers.length) throw new Error('Gagal mengunduh gambar');

  // 1 gambar: kirim biasa
  if (buffers.length === 1) {
    return sock.sendMessage(jid, { image: buffers[0], caption }, { quoted: m });
  }

  // banyak gambar: coba album, kalau gagal kirim satu-satu
  try {
    await sock.sendMessage(
      jid,
      { album: buffers.map((b, i) => ({ image: b, caption: i === 0 ? caption : undefined })) },
      { quoted: m }
    );
  } catch (e) {
    console.error('[pixiv] album gagal, kirim satu-satu:', e.message);
    for (let i = 0; i < buffers.length; i++) {
      await sock.sendMessage(
        jid,
        { image: buffers[i], caption: i === 0 ? caption : undefined },
        { quoted: m }
      );
    }
  }
}

// ===== Fungsi utama =====
async function pixivCommand(sock, m, jid, text) {
  const input = (text || '').trim();

  if (!input) {
    await sock.sendMessage(jid, { text: USAGE_TEXT }, { quoted: m });
    return false;
  }

  const parsed = parseInput(input);

  try {
    // ---- Berdasarkan ID / link ----
    if (parsed.type === 'id') {
      const d = await getDetail(parsed.value);
      if (!isSafe(d, d.tags)) {
        await sock.sendMessage(
          jid,
          { text: '🚫 Artwork ini tidak diizinkan karena kontennya tidak aman untuk ditampilkan.' },
          { quoted: m }
        );
        return false;
      }
      await react(sock, m, '⏳');
      await sendIllust(sock, m, jid, d);
      return true;
    }

    // ---- Pencarian kata kunci ----
    if (hasBadTag([parsed.value])) {
      await sock.sendMessage(
        jid,
        { text: '🚫 Keyword tersebut tidak diizinkan. Coba keyword lain ya.' },
        { quoted: m }
      );
      return false;
    }

    const candidates = await searchSafe(parsed.value);
    if (!candidates.length) {
      await sock.sendMessage(jid, { text: notFoundText(parsed.value) }, { quoted: m });
      return false;
    }

    await react(sock, m, '⏳'); // hasil ketemu, mulai proses gambar

    for (const c of candidates) {
      try {
        const d = await getDetail(c.id);
        if (!isSafe(d, d.tags)) continue;
        await sendIllust(sock, m, jid, d);
        return true;
      } catch (e) {
        console.error('[pixiv] kandidat gagal:', c.id, e.message);
      }
    }

    await sock.sendMessage(jid, { text: notFoundText(parsed.value) }, { quoted: m });
    return false;
  } catch (err) {
    console.error('[pixiv]', err);
    await sock.sendMessage(jid, { text: notFoundText(parsed.value) }, { quoted: m });
    return false;
  }
}

module.exports = { pixivCommand };
