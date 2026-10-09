const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const VO_DIR = path.join(__dirname, 'temp_vo');
if (!fs.existsSync(VO_DIR)) fs.mkdirSync(VO_DIR, { recursive: true });

module.exports = async (sock, msg) => {
    const voMsg =
        msg.message?.viewOnceMessage?.message ||
        msg.message?.viewOnceMessageV2?.message ||
        msg.message?.viewOnceMessageV2Extension?.message;
    if (!voMsg) return;

    const isImage = !!voMsg.imageMessage;
    const mediaMsg = voMsg.imageMessage || voMsg.videoMessage;
    if (!mediaMsg) return;

    try {
        const rawSender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = rawSender.split('@')[0].replace(/\D/g, '');

        let group = 'pribadi';
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us')) {
            try {
                group = (await sock.groupMetadata(jid)).subject;
            } catch {
                group = 'grup';
            }
        }

        const ts = Number(msg.messageTimestamp || Date.now() / 1000) * 1000;
        const d = new Date(ts);
        const timeStr = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

        const stream = await downloadContentFromMessage(mediaMsg, isImage ? 'image' : 'video');
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        const fileName = `${senderNumber}_${Date.now()}.${isImage ? 'jpg' : 'mp4'}`;
        fs.writeFileSync(path.join(VO_DIR, fileName), buffer);

        const logPath = path.join(VO_DIR, 'logs.json');
        const logs = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath)) : [];
        logs.push({ fileName, sender: senderNumber, type: isImage ? 'img' : 'mp4', timeStr });
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));

        console.log(`[VO AUTO-SAVE] Tersimpan dari ${senderNumber} (${timeStr})`);
    } catch (err) {
        console.error('Gagal menyimpan View Once otomatis:', err);
    }
};
