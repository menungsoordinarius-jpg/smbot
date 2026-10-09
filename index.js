const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Import handler dari folder commands
const handleMenu = require('./commands/menu');
const handleTranslate = require('./commands/translate');
const handleViewOnce = require('./commands/viewonce');
const autoSaveViewOnce = require('./commands/autosave');
const handleGet = require('./commands/get');
const { handleYtmp4, handleYtReply } = require('./commands/ytmp4');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

// Tambahkan kode ini di index.js tepat setelah pembentukan variabel 'sock'
const originalSendMessage = sock.sendMessage;
sock.sendMessage = async (...args) => {
    // Memberi jeda 1.5 detik (1500 milidetik) sebelum pesan terkirim
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    return originalSendMessage.apply(sock, args);
};

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Menampilkan QR Code di terminal
        if (qr) {
            console.log('\nScan QR Code ini menggunakan WhatsApp kamu:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba menghubungkan ulang...');
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log(' Bot Berhasil Terhubung dan Siap Digunakan!');
        }
    });

sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const m = messages[0];
    if (!m.message) return;
    // === DEBUG SEMENTARA ===
    if (!m.key.fromMe) {
        console.log("MSG-DEBUG:", JSON.stringify(m.message, (k, v) => {
            if (v instanceof Uint8Array || v?.type === "Buffer") return "[binary]";
            if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "...";
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
        '';
    const from = m.key.remoteJid;

    // ROUTER COMMANDS
    if (text.startsWith('.menu 2') || text.startsWith('.help')) {
        await handleMenu(sock, from, m);
    }
    else if (text.startsWith('.tr ')) {
        await handleTranslate(sock, from, m, text);
    }
    else if (/^\.(toimg|tomp4|tvideo|gif|togif)(\s|$)/i.test(text)) {
        await handleViewOnce(sock, from, m, text);
    }
    else if (text.startsWith('.ytmp4')) {
        await handleYtmp4(sock, m, text.split(/\s+/).slice(1));
    }
else {
    await handleYtReply(sock, m, text);
}
//    else if (text.startsWith('.get ')) {
//        await handleGet(sock, from, m, text);
//    }
});

}

startBot();
