
// commands/commands.js
// Router semua perintah smbot. index.js hanya untuk login/koneksi.

const handleMenu = require('./menu');
const handleTranslate = require('./translate');
const handleViewOnce = require('./viewonce');
const autoSaveViewOnce = require('./autosave');
// const handleGet = require('./get');
const { handleYtmp4, handleYtReply } = require('./ytmp4');
// const { handleWamark } = require('./wamark');
// sticker
const { handleSticker } = require('./sticker');
const { handleSmeme } = require('./sticker/smeme');
const { handlePin } = require('./pin');
const toimage = require('./converter/toimage');
const { withReaction } = require('../utils/react');
const status = require('./status');
const handleTomp3 = require('./converter/tomp3');
const { handleAlbum } = require('./sticker/stickerpack');
const ocr = require('./ocr');
const xDownloader = require('./downloader/x/x')
const instagram = require('./downloader/instagram');
const tes = require('./tes');
const { handleDev, handleAdmin } = require('./devSettings');
const { pixivCommand } = require('./search/pixiv');
// ai
const gemini = require('./ai/gemini')
const BASE = 'https://menungsoordinarius-jpg.github.io/smbot/images/';

const PREVIEW = {
  title: 'Another Day',
  body: 'Sedikit cerita dari hari ini.',
  sourceUrl: 'https://menungsoordinarius-jpg.github.io/smbot/', // domain yang tampil di kartu
  images: [
    BASE + '1.jpg',
    BASE + '2.jpg',
    BASE + '3.jpg',
  ],
  mode: 'random', // 'random' | 'urut' | angka tetap (mis. 2 = selalu gambar ke-2)
  totalCmd: 322,
  tampilan: 'link',
  satuPesan: true,
};

module.exports = async function handleCommands(sock, m) {
    // === DEBUG SEMENTARA (hapus kalau sudah tidak perlu) ===
    if (!m.key.fromMe) {
        console.log('MSG-DEBUG:', JSON.stringify(m.message, (k, v) => {
            if (v instanceof Uint8Array || v?.type === 'Buffer') return '[binary]';
            if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '...';
            return v;
        }, 1));
    }
    // === akhir debug ===

    // Auto-save view once (jalan di setiap pesan masuk)
    await autoSaveViewOnce(sock, m);

    const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        m.message.documentMessage?.caption ||
        m.message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        '';
    const from = m.key.remoteJid;

    // ROUTER COMMANDS
    if (text.startsWith('.menu 2') || text.startsWith('.help')) {
        await withReaction(sock, m, () => handleMenu(sock, from, m));
   }
// ai
    else if (/^\.ai(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => gemini.command(sock, m, text.split(/\s+/).slice(1)), '🤖');
    }
    else if (/^\.dev(\s|$)/i.test(text)) {
    await handleDev(sock, from, m, text);
    }
    else if (/^\.(addadmin|deladmin|adminlist|ownerlist)(\s|$)/i.test(text)) {
        await handleAdmin(sock, from, m, text);
    }
    else if (text.startsWith('.tr ')) {
        await withReaction(sock, m, () => handleTranslate(sock, from, m, text));
    }
    else if (/^\.(toimg|tomp4|tvideo|gif|togif)(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => handleViewOnce(sock, from, m, text));
    }
    else if (/^\.toimage(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => toimage(sock, m, text.split(/\s+/).slice(1)));
    }
// downloader
    else if (text.startsWith('.ytmp4')) {
        await withReaction(sock, m, () => handleYtmp4(sock, m, text.split(/\s+/).slice(1)));
    }
// sticker
    else if (/^\.s(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => handleSticker(sock, m));
    }
    else if (/^\.smeme(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => handleSmeme(sock, m));
    }
// search
    else if (/^\.pin(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => handlePin(sock, m, text), '🔍');
    }
       else if (/^\.pixiv(\s|$)/i.test(text)) {
        const query = text.replace(/^\.pixiv\s*/i, '');
        await withReaction(sock, m, () => pixivCommand(sock, m, from, query), '🔎');
    }
    else if (/^\.status(\s|$)/i.test(text)) {
        return status.run(sock, m);
    }
    else if (/^\.(tomp3|mp3)(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => handleTomp3(sock, m, text.split(/\s+/).slice(1)));
    }
    else if (/^\.ocr(\s|$)/i.test(text)) {
        await withReaction(sock, m, () => ocr(sock, m, text.split(/\s+/).slice(1)), '🔍');
    }
    else if (/^\.(x|𝕏|twitter)(\s|$)/i.test(text)) {
        const isDetail = /^\.(𝕏|twitter)/i.test(text);
        await withReaction(sock, m, () => xDownloader(sock, m, text.split(/\s+/).slice(1), isDetail), '🔎');
    }
    else if (/^\.(ins|instagram)(\s|$)/i.test(text)) {
        const isDetail = /^\.instagram/i.test(text);
        await withReaction(
            sock, m,
            () => instagram(sock, m, text.split(/\s+/).slice(1), isDetail ? 'full' : 'short'),
            '🔎'
        );
    }
   else if (/^\.tes(\s|$)/i.test(text)) {
    await withReaction(sock, m, () => tes(sock, m, text.split(/\s+/).slice(1), PREVIEW), '🔎');
}
    else {
        await handleYtReply(sock, m, text);
    }
    // else if (text.startsWith('.get ')) {
    //     await handleGet(sock, from, m, text);
    // }
};

