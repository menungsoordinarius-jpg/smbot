// commands/menu2.js
// Kartu preview besar dengan gambar ACAK dari folder lokal + menu.

const fs = require("fs");
const path = require("path");
const Jimp = require("jimp"); // 0.22.12
const { getSettings } = require("./devSettings"); // SATU_PESAN, SEMBUNYIKAN_LINK, PAKAI_READ_MORE (diubah lewat .dev)
const { createProcess } = require("../utils/process");
const { withProcessReact } = require("../utils/react");

// Tampilkan pesan proses (bar progres) saat menunggu.
// Opsi: true | false
const SETTING_Tampilkan_Proses = true;

const LINK = "https://menungsoordinarius-jpg.github.io/smbot/"; // domain yang tampil di kartu

// Trik "Read more" WhatsApp: ribuan karakter tak terlihat
const READ_MORE = String.fromCharCode(8206).repeat(4001);

// ---- Pembacaan folder lokal ../images ----
const LOCAL_IMAGES_DIR = path.join(__dirname, "../images");

// Cadangan kalau folder lokal kosong / gagal dibaca
const FALLBACK_IMAGES = [LINK + "images/2.jpg"];

// Judul + deskripsi diacak terpisah dari gambar. Tambah/ubah sesukamu.
const TEXTS = [
  { title: "Another Day",   body: "Sedikit cerita dari hari ini." },
  { title: "Simple Moment", body: "A calm moment in a busy day." },
  { title: "One Fine Day",  body: "Just enjoying the little things." },
];

let lastUrl = "";

async function listImages() {
  try {
    if (!fs.existsSync(LOCAL_IMAGES_DIR)) {
      throw new Error("Folder tidak ditemukan: " + LOCAL_IMAGES_DIR);
    }
    const list = fs.readdirSync(LOCAL_IMAGES_DIR)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .map((f) => path.join(LOCAL_IMAGES_DIR, f));

    if (!list.length) throw new Error("tidak ada jpg/png di folder");
    return list;
  } catch (e) {
    console.error("[menu2] gagal baca folder lokal:", e.message);
    return FALLBACK_IMAGES;
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
  const teks = `*MENU 2*
╭─〔 SM-BOT〕
╰─────────────────
╭─〔 INFO 〕
│  User: ${user}
│  Runtime: ${formatRuntime(process.uptime())}
│  Total cmd: {{TOTAL}}
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
│  .pixiv
╰─────────────────
╭─〔 SCANNER 〕
│  .ocr
╰─────────────────
╭─〔 AI 〕
│  .flux
│  .pixai  upcoming
╰─────────────────
╭─〔 GENERAL 〕
│  .menu
╰─────────────────
╭─〔 STIKER 〕
│  .s
│  .smeme
╰─────────────────

> ╭─〔 UPCOMING 〕
> │  .youtube shorts
> │  .pinterest video
> │  .aichara
> │  .aichat> gemini, chatgpt, DeepSeek, DLL
> ╰────────────────`;

  // hitung otomatis: perintah unik di daftar menu (baris "│  .perintah"), kecuali yang bertanda upcoming
  const daftar = new Set();
  for (const baris of teks.split("\n")) {
    const mt = baris.match(/^│  (\.\S+)/);
    if (mt && !/upcoming/i.test(baris)) daftar.add(mt[1].toLowerCase());
  }
  return teks.replace("{{TOTAL}}", daftar.size);
}

// Unduh gambar -> perkecil -> unggah ke server WhatsApp sebagai "thumbnail-link".
// Ukuran & thumbnail kecil diisi sendiri dari Jimp, karena Baileys 7 di Termux
// tidak mengisinya (tidak ada sharp/jimp bawaan).
async function buildPreview(sock, item) {
let img;
if (/^https?:\/\//i.test(item.url)) {
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`gambar gagal (${res.status}): ${item.url}`);
  img = await Jimp.read(Buffer.from(await res.arrayBuffer()));
} else {
  img = await Jimp.read(fs.readFileSync(item.url));
}

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

  // ---------- pesan proses ----------
  const proc = withProcessReact(
    createProcess(sock, m, SETTING_Tampilkan_Proses),
    sock,
    m
  );
  const gagal = async (teks) =>
    SETTING_Tampilkan_Proses
      ? proc.fail(teks)
      : sock.sendMessage(from, { text: teks }, { quoted: m });

  try {
    await proc.update("📋 Menyiapkan menu...", 15, true);
    const item = await pickRandom();
    console.log("[menu2] gambar:", item.url);

    await proc.update("🖼️ Membuat preview gambar...", 50, true);
    let linkPreview;
    try {
      linkPreview = await buildPreview(sock, item);
    } catch (e) {
      console.error("[menu2] gagal bikin preview:", e.message); // menu tetap dikirim tanpa preview
    }

    await proc.update("📤 Mengirim menu...", 90, true);
    if (SATU_PESAN) {
      const text = SEMBUNYIKAN_LINK ? buildMenu(m, PAKAI_READ_MORE) : buildMenu(m, PAKAI_READ_MORE) + "\n\n" + LINK;
      await sock.sendMessage(from, { text, linkPreview }, { quoted: m });
    } else {
      await sock.sendMessage(from, { text: LINK, linkPreview }, { quoted: m });
      await sock.sendMessage(from, { text: buildMenu(m, PAKAI_READ_MORE) });
    }
    console.log("[menu2] terkirim | satuPesan:", SATU_PESAN, "| linkTersembunyi:", SEMBUNYIKAN_LINK, "| readMore:", PAKAI_READ_MORE);

    await proc.done();
    return true;
  } catch (e) {
    console.error("[menu2] error:", e.message);
    await gagal("❌ Gagal menampilkan menu, coba lagi.");
    return false; // dibaca withReaction -> reaksi akhir ❌
  }
};