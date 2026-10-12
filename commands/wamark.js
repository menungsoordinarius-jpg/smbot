// Function Handler untuk dipanggil dari router di index.js
async function handleWamark(sock, mek) {
    try {
        const text = mek.message?.conversation ||
                     mek.message?.extendedTextMessage?.text || '';
        const cmd = text.trim().toLowerCase();
        if (cmd !== '.w' && cmd !== '.m') return;

        const contextInfo = mek.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.quotedMessage) {
            console.log('⚠️ .w/.m diketik tapi tidak me-reply pesan apa pun.');
            return;
        }

        // Teks selalu diambil dari pesan yang di-reply (lapisan luar)
        const outer = contextInfo.quotedMessage;
        const messageText = outer.conversation ||
            outer.extendedTextMessage?.text ||
            outer.imageMessage?.caption ||
            outer.videoMessage?.caption || null;

        if (!messageText) {
            console.log('⚠️ Teks pada pesan yang di-reply tidak ditemukan.');
            return;
        }

        // Target quoted: lompat ke stiker/media asli hanya jika datanya lengkap
        let quotedMsg = outer;
        let targetStanzaId = contextInfo.stanzaId;
        let targetParticipant = contextInfo.participant;

        const inner = outer.extendedTextMessage?.contextInfo;
        if (inner?.stanzaId && inner.quotedMessage) {
            targetStanzaId = inner.stanzaId;
            targetParticipant = inner.participant || targetParticipant;
            quotedMsg = inner.quotedMessage;
        }

        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const targetQuoted = {
            key: {
                remoteJid: mek.key.remoteJid,
                fromMe: targetParticipant === botJid,
                id: targetStanzaId,
                participant: targetParticipant
            },
            message: quotedMsg
        };

        const finalCommand = processWatermarkLogic(messageText);
        if (finalCommand) {
            await sock.sendMessage(mek.key.remoteJid, { text: finalCommand }, { quoted: targetQuoted });
        } else {
            console.log('⚠️ Format pesan reply tidak cocok.');
        }
    } catch (err) {
        console.error('❌ Error handling .w/.m command:', err);
    }
}
// --- HELPER: Logika Inti Watermark ---
function processWatermarkLogic(messageText) {
    // --- SKENARIO 1: Perintah .s manual (.s ... | ...) ---
    const regexStiker = /^\.s\s+(.*?)\s*\|.*/i;
    const matchStiker = messageText.match(regexStiker);

    if (matchStiker) {
        const title = matchStiker[1].trim(); 
        return `.s ${title} | powered by BY SHIRONE BOT`;
    } 
    // --- SKENARIO 2: Caption sosmed dengan ciri khas "👤" dan "@" ---
  else if (messageText.includes('👤') && messageText.includes('@')) {
    const idx = messageText.indexOf('👤');
    const title  = messageText.slice(0, idx).replace(/\s+/g, ' ').trim();
    const credit = messageText.slice(idx).replace(/\s+/g, ' ').trim();
    return `.s ${title} | BY: ${credit}`;
}
    return null;
}

module.exports = { handleWamark, processWatermarkLogic };
