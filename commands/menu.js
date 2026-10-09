const { getUrlInfo } = require("@whiskeysockets/baileys");

module.exports = async (sock, from, m) => {
    const link = "https://menungsoordinarius-jpg.github.io/smbot/";

    const menuText = ` *MENU 2*
╭─〔 TRANSLATE 〕
│  .tr in/id  → Indonesia
│  .tr en     → English
│  .tr ja     → Japanese
│  .tr ar     → Arabic
╰─────────────────
╭─〔 LOCAL DOWNLOADER 〕
│  .toimg
│  .tomp4
│  .toimg dcm
│  .tomp4 dcm
╰─────────────────
${link}`;

    let linkPreviewData = null;
    try {
        // Ambil info link preview resmi dari Baileys & unggah gambar ke server WhatsApp
        linkPreviewData = await getUrlInfo(link, {
            thumbnailWidth: 1024,              // Memaksa resolusi besar (lanskap 16:9)
            fetchOpts: { timeout: 4000 },       // Batas waktu proses fetch
            uploadImage: sock.waUploadToServer // Wajib: mengunggah gambar ke CDN WhatsApp
        });
    } catch (e) {
        console.log("Gagal mengambil link preview:", e.message);
    }

    await sock.sendMessage(from, {
        text: menuText,
        linkPreview: linkPreviewData || undefined
    }, { quoted: m });
};
