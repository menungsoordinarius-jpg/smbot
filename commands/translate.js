const translate = require('translate-google');

module.exports = async (sock, from, m, text) => {
    const args = text.slice(4).trim().split(' ');
    let targetLang = args.shift()?.toLowerCase();
    if (targetLang === 'in') targetLang = 'id';

    let textToTranslate = '';
    const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMsg) {
        textToTranslate = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '';
    } else {
        textToTranslate = args.join(' ');
    }

    if (!targetLang || !textToTranslate) {
        await sock.sendMessage(from, { 
            text: ' Format terjemahan salah!\n\n• `.tr en Selamat Pagi`\n• Balas pesan dengan `.tr en` atau `.tr in`' 
        }, { quoted: m });
        return;
    }

    try {
        const result = await translate(textToTranslate, { to: targetLang });
        await sock.sendMessage(from, { 
            text: `*Hasil Terjemahan (${targetLang}):*\n\n${result}` 
        }, { quoted: m });
    } catch (err) {
        await sock.sendMessage(from, { 
            text: ' Gagal menerjemahkan. Pastikan kode bahasa benar (misal: en, id, in, ja).' 
        }, { quoted: m });
    }
};
