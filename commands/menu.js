// commands/menu2.js
// Kartu preview besar dengan gambar ACAK + menu.
// Tidak lagi pakai getUrlInfo: judul, deskripsi, dan gambar diatur dari sini,
// jadi tidak perlu link-preview-js dan tidak perlu tag og: di halaman.

const Jimp = require("jimp"); // 0.22.12
const { getSettings } = require("./devSettings"); // SATU_PESAN, SEMBUNYIKAN_LINK, PAKAI_READ_MORE (diubah lewat .dev)

const LINK = "https://menungsoordinarius-jpg.github.io/smbot/"; // domain yang tampil di kartu

// Trik "Read more" WhatsApp: ribuan karakter tak terlihat
const READ_MORE = String.fromCharCode(8206).repeat(4001);

// ---- Gambar otomatis dari folder images di GitHub ----
// Bot membaca isi folder lewat GitHub API, jadi tinggal upload gambar baru
// ke folder itu tanpa mengedit kode. Hasilnya di-cache 10 menit.
const GH_OWNER = "menungsoordinarius-jpg";
const GH_REPO = "smbot";
const GH_PATH = "images"; // kalau Pages kamu dari folder docs -> "docs/images"
const CACHE_MS = 10 * 60 * 1000;

// Cadangan kalau GitHub API gagal / kena limit dan cache masih kosong
const FALLBACK_IMAGES = [LINK + "images/2.jpg"];

// Judul + deskripsi diacak terpisah dari gambar. Tambah/ubah sesukamu.
const TEXTS = [
  { title: "Another Day",   body: "Sedikit cerita dari hari ini." },
  { title: "Simple Moment", body: "A calm moment in a busy day." },
  { title: "One Fine Day",  body: "Just enjoying the little things." },
];

let cache = { time: 0, list: [] };
let lastUrl = "";

async function listImages() {
  if (cache.list.length && Date.now() - cache.time < CACHE_MS) return cache.list;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`,
      { headers: { "User-Agent": "smbot", Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error("GitHub API " + res.status);
    const files = await res.json();
    const list = files
      .filter((f) => f.type === "file" && /\.(jpe?g|png)$/i.test(f.name))
      .map((f) => f.download_url);
    if (!list.length) throw new Error("folder kosong / tidak ada jpg/png");
    cache = { time: Date.now(), list };
    console.log("[menu2] daftar gambar diperbarui:", list.length, "file");
    return list;
  } catch (e) {
    console.error("[menu2] gagal baca folder gambar:", e.message);
    return cache.list.length ? cache.list : FALLBACK_IMAGES; // pakai cache lama kalau ada
  }
}

// "Kantong acak": semua gambar keluar sekali dulu (urutan diacak),
// baru diacak ulang. Jadi tidak ada gambar yang berulang sebelum semuanya tampil.
let bag = [];
function nextFromBag(list) {
  bag = bag.filter((u) => list.includes(u)); // buang gambar yang sudah dihapus dari folder
  if (!bag.length) {
    bag = [...list].sort(() => Math.random() - 0.5);
    // jangan sampai gambar pertama putaran baru sama dengan yang terakhir tampil
    if (bag.length > 1 && bag[0] === lastUrl) bag.push(bag.shift());
  }
  return bag.shift();
}

async function pickRandom() {
  const list = await listImages();
  const url = nextFromBag(list);
  lastUrl = url;
  const t = TEXTS[Math.floor(Math.random() * TEXTS.length)];
  return { url, title: t.title, body: t.body };
}

function formatRuntime(sec) {
  const d = Math.floor(sec / 86400);
  const j = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} hari ${j}j ${m}m`;
  if (j > 0) return `${j}j ${m}m`;
  return `${m}m ${Math.floor(sec % 60)}d`;
}

function buildMenu(m, pakaiReadMore) {
  const user = m?.pushName || "User";
  return `*MENU 2*
╭─〔 INFO 〕
│  User: ${user}
│  Runtime: ${formatRuntime(process.uptime())}
╰─────────────────${pakaiReadMore ? READ_MORE : ""}
╭─〔 TRANSLATE 〕
│  .tr in/id  → Indonesia
│  .tr en     → English
│  .tr ja     → Japanese
│  .tr ar     → Arabic
╰─────────────────
╭─〔 CONVERTER 〕
│  .toimg
│  .tomp4
│  .tomp3
│  .toimg dcm
│  .tomp4 dcm
│  .tomp3 dcm
╰─────────────────
╭─〔 DOWNLOADER 〕
│  .twitter (𝕏)
│  .instagram (ig)
│  .youtube (yt)
╰─────────────────
╭─〔 SEARCH 〕
│  .pinterest
╰─────────────────
╭─〔 SCANNER 〕
│  .ocr
╰─────────────────
╭─〔 GENERAL 〕
│  .menu
╰─────────────────
╭─〔 STIKER 〕
│  .s
│  .smeme
╰─────────────────

> ╭─〔 UPCOMING 〕
> │  .pixiv
> │  .youtube shorts
> │  .pinterest video
> │  .aichara
> │  .aichat> gemini, chatgpt, claude, DeepSeek, DLL
> ╰────────────────`;
}

// Unduh gambar -> perkecil -> unggah ke server WhatsApp sebagai "thumbnail-link".
// Ukuran & thumbnail kecil diisi sendiri dari Jimp, karena Baileys 7 di Termux
// tidak mengisinya (tidak ada sharp/jimp bawaan).
async function buildPreview(sock, item) {
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`gambar gagal (${res.status}): ${item.url}`);
  const img = await Jimp.read(Buffer.from(await res.arrayBuffer()));

  const big = img.clone().scaleToFit(1000, 1000).quality(80);
  const bigBuf = await big.getBufferAsync(Jimp.MIME_JPEG);
  const thumb = await img.clone().scaleToFit(300, 300).quality(50).getBufferAsync(Jimp.MIME_JPEG);

  const preview = {
    "canonical-url": LINK,
    "matched-text": LINK,
    title: item.title,
    description: item.body,
    jpegThumbnail: thumb,
  };

  try {
    // Baileys 7 ESM-only, project ini CommonJS -> dimuat lewat import()
    const { prepareWAMessageMedia } = await import("@whiskeysockets/baileys");
    const { imageMessage } = await prepareWAMessageMedia(
      { image: bigBuf },
      { upload: sock.waUploadToServer, mediaTypeOverride: "thumbnail-link" }
    );
    imageMessage.width = imageMessage.width || big.bitmap.width;
    imageMessage.height = imageMessage.height || big.bitmap.height;
    if (!imageMessage.jpegThumbnail?.length) imageMessage.jpegThumbnail = thumb;
    preview.highQualityThumbnail = imageMessage;
    console.log("[menu2] upload OK |", big.bitmap.width + "x" + big.bitmap.height);
  } catch (e) {
    console.error("[menu2] upload gagal, pakai thumbnail kecil:", e.message);
  }
  return preview;
}

module.exports = async (sock, from, m) => {
  // dibaca tiap pesan -> perubahan lewat .dev langsung berlaku tanpa restart
  const { SATU_PESAN, SEMBUNYIKAN_LINK, PAKAI_READ_MORE } = getSettings();
  const item = await pickRandom();
  console.log("[menu2] gambar:", item.url);

  let linkPreview;
  try {
    linkPreview = await buildPreview(sock, item);
  } catch (e) {
    console.error("[menu2] gagal bikin preview:", e.message);
  }

  if (SATU_PESAN) {
    const text = SEMBUNYIKAN_LINK ? buildMenu(m, PAKAI_READ_MORE) : buildMenu(m, PAKAI_READ_MORE) + "\n\n" + LINK;
    await sock.sendMessage(from, { text, linkPreview }, { quoted: m });
  } else {
    await sock.sendMessage(from, { text: LINK, linkPreview }, { quoted: m });
    await sock.sendMessage(from, { text: buildMenu(m, PAKAI_READ_MORE) });
  }
  console.log("[menu2] terkirim | satuPesan:", SATU_PESAN, "| linkTersembunyi:", SEMBUNYIKAN_LINK, "| readMore:", PAKAI_READ_MORE);
};
