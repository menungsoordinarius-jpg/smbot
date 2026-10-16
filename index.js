const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Semua perintah ada di commands/commands.js
const handleCommands = require('./commands/commands');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    // Jeda 1.5 detik sebelum pesan terkirim (reaksi tidak ditunda)
    const originalSendMessage = sock.sendMessage;
    sock.sendMessage = async (...args) => {
        if (!args[1]?.react) await new Promise(resolve => setTimeout(resolve, 1500));
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

    // Pesan masuk diteruskan ke router
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m?.message) return;
        try {
            await handleCommands(sock, m);
        } catch (e) {
            console.error('[commands]', e);
        }
    });
}

startBot();
