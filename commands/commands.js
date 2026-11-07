
// commands/commands.js
// Router semua perintah smbot. index.js hanya untuk login/koneksi.
// utils
const settings = require('../utils/settings');
const { handleSetGroup } = require('../utils/alert');
const { withReaction } = require('../utils/react');
// admin
const { handleDev, handleAdmin } = require('./devSettings');
//general
const handleMenu = require('./menu');
const tes = require('./tes');
const status = require('./status');
// sticker
const { handleSticker } = require('./sticker');
const { handleSmeme } = require('./sticker/smeme');
const { handleAlbum } = require('./sticker/stickerpack');
//converter
const handleTomp3 = require('./converter/tomp3');
const toimage = require('./converter/toimage');
//downloader
const { handleYtmp4, handleYtReply } = require('./downloader/ytmp4');
const xDownloader = require('./downloader/x/x')
const instagram = require('./downloader/instagram');
// search
const { handlePin } = require('./pin');
const instagramSearch = require('./search/instagram-search');
const { pixivCommand } = require('./search/pixiv');
// ai
const gemini = require('./ai/gemini')
const pixai = require('./ai/pixai')
const flux = require('./ai/flux');
const { setkey, delkey, donor } = require('./ai/pixai-key');

const handleTranslate = require('./translate');
const handleViewOnce = require('./viewonce');
const autoSaveViewOnce = require('./autosave');
const ocr = require('./ocr');

module.exports = async function handleCommands(sock, m) {
    // === DEBUG SEMENTARA (hapus kalau sudah tidak perlu) ===
    // (.setkey/.donor dikecualikan supaya API key tidak masuk log)
    if (!m.key.fromMe && !/^\.(setkey|donor)(\s|$)/i.test(m.message?.conversation || m.message?.extendedTextMessage?.text || '')) {
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

    if (await settings.handleReply(sock, m, text)) return;

    // ROUTER COMMANDS
    const cmdArgs = text.split(/\s+/).slice(1);
    const run = (task, emoji) => withReaction(sock, m, task, emoji);

    // menu
    if (text.startsWith('.menu 2') || text.startsWith('.help')) {
        await run(() => handleMenu(sock, from, m));
    }
    // pengaturan & admin
    else if (/^\.setgroup(\s|$)/i.test(text)) {
        await handleSetGroup(sock, m, from, text);
    }
    else if (/^\.(settings|setting)(\s|$)/i.test(text)) {
        await settings.show(sock, m);
    }
    else if (/^\.dev(\s|$)/i.test(text)) {
        await handleDev(sock, from, m, text);
    }
    else if (/^\.(addadmin|deladmin|adminlist|ownerlist)(\s|$)/i.test(text)) {
        await handleAdmin(sock, from, m, text);
    }
    else if (/^\.status(\s|$)/i.test(text)) {
        return status.run(sock, m);
    }
    // ai
    else if (/^\.ai(\s|$)/i.test(text)) {
        await run(() => gemini.command(sock, m, cmdArgs), '🤖');
    }
    else if (/^\.pixai(\s|$)/i.test(text)) {
        await pixai.command(sock, m, cmdArgs);
    }
    else if (/^\.flux(\s|$)/i.test(text)) {
        await run(() => flux(sock, m, cmdArgs), '🎨');
    }
    // key (donor & pribadi)
    else if (/^\.setkey(\s|$)/i.test(text)) {
        await setkey(sock, m, cmdArgs);
    }
    else if (/^\.delkey(\s|$)/i.test(text)) {
        await delkey(sock, m, cmdArgs);
    }
    else if (/^\.donor(\s|$)/i.test(text)) {
        await donor(sock, m, cmdArgs);
    }
    // alat
    else if (text.startsWith('.tr ')) {
        await run(() => handleTranslate(sock, from, m, text));
    }
    else if (/^\.(toimg|tomp4|tvideo|gif|togif)(\s|$)/i.test(text)) {
        await run(() => handleViewOnce(sock, from, m, text));
    }
    else if (/^\.toimage(\s|$)/i.test(text)) {
        await run(() => toimage(sock, m, cmdArgs));
    }
    else if (/^\.(tomp3|mp3)(\s|$)/i.test(text)) {
        await run(() => handleTomp3(sock, m, cmdArgs));
    }
    else if (/^\.ocr(\s|$)/i.test(text)) {
        await run(() => ocr(sock, m, cmdArgs), '🔍');
    }
    // stiker
    else if (/^\.s(\s|$)/i.test(text)) {
        await run(() => handleSticker(sock, m));
    }
    else if (/^\.smeme(\s|$)/i.test(text)) {
        await run(() => handleSmeme(sock, m));
    }
    // downloader
    else if (text.startsWith('.ytmp4')) {
        await run(() => handleYtmp4(sock, m, cmdArgs));
    }
    else if (/^\.(x|𝕏|twitter)(\s|$)/i.test(text)) {
        const isDetail = /^\.(𝕏|twitter)/i.test(text);
        await run(() => xDownloader(sock, m, cmdArgs, isDetail), '🔎');
    }
    // pencarian
    else if (/^\.pin(\s|$)/i.test(text)) {
        await run(() => handlePin(sock, m, text), '🔍');
    }
    else if (/^\.pixiv(\s|$)/i.test(text)) {
        const query = text.replace(/^\.pixiv\s*/i, '');
        await run(() => pixivCommand(sock, m, from, query), '🔎');
    }
    else if (/^\.(instagram|ins|ig)(\s|$)/i.test(text)) {
        const cmd = text.match(/^\.(instagram|ins|ig)(?=\s|$)/i)[1].toLowerCase();
        const mode = cmd === 'instagram' ? 'full' : 'short';
        const isLink = /instagram\.com|instagr\.am/i.test(cmdArgs.join(' '));
        const useSearch = cmd !== 'ins' && cmdArgs.length > 0 && !isLink;
        await run(() => useSearch
            ? instagramSearch(sock, m, cmdArgs, mode)
            : instagram(sock, m, cmdArgs, mode));
    }
    // tes
    else if (/^\.tes(\s|$)/i.test(text)) {
        await run(() => tes(sock, m, cmdArgs, PREVIEW), '🔎');
    }
    else {
        await handleYtReply(sock, m, text);
    }
};

