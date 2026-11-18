const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { claim, owns } = require('./utils/claim');
const settings = require('./utils/settings');
const { startAlerts } = require('./utils/alert');
settings.install();
const CLAIM_FILE = path.join(__dirname, 'commands', 'claim.js');

// Semua perintah ada di commands/commands.js
const handleCommands = require('./commands/commands');

async function startBot() {
    const SESSION = process.env.SESSION_DIR || 'session';
    const { state, saveCreds } = await useMultiFileAuthState(SESSION);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    // Jeda 1.5 detik sebelum pesan terkirim (reaksi tidak ditunda)
    // + status mengetik + cek ulang klaim sebelum kirim
    const originalSendMessage = sock.sendMessage;
    sock.sendMessage = async (...args) => {
        const opt = args[1] || {};
        if (opt.react) return originalSendMessage.apply(sock, args);

        const jid = args[0];
        const q = args[2]?.quoted;
        const myId = (sock.user?.id || '').split(':')[0].split('@')[0];
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const lost = () => q?.key && !owns(q, myId);

        // edit (bar progres): cukup jeda, tanpa presence
        if (opt.edit) {
            await sleep(1500);
            return originalSendMessage.apply(sock, args);
        }

        await sleep(300);
        if (lost()) return; // kalah klaim: diam

        try { await sock.sendPresenceUpdate('composing', jid); } catch {}
        await sleep(1200);
        if (lost()) {
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}
            return;
        }

        const res = await originalSendMessage.apply(sock, args);
        try { await sock.sendPresenceUpdate('paused', jid); } catch {}
        return res;
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
            startAlerts(sock);
        }
    });

    // Pesan masuk diteruskan ke router
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log('[upsert]', type, 'fromMe=' + messages[0]?.key?.fromMe, messages[0]?.key?.remoteJid);
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m?.message) return;
        const msg = m.message;
        const text = msg.conversation || msg.extendedTextMessage?.text
            || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
        const isSettingsCmd = /^\.(settings|setting|setgroup)(\s|$)/i.test(text.trim());

        if (text.trim().startsWith('.') && !isSettingsCmd) {
            const botId = (sock.user?.id || '').split(':')[0].split('@')[0];
            const claimOn = settings.option(sock, CLAIM_FILE, 'claim', true);
            const selfOn = settings.option(sock, CLAIM_FILE, 'self', false);

            if (m.key.fromMe) {
                if (selfOn) {
                    claim(m, botId, true, true);   // Self ON: paksa menang
                } else if (!claimOn) {
                    return;                        // Self OFF + claim OFF: diam
                } else if (!claim(m, botId, claimOn)) {
                    return;                        // Self OFF + claim ON: balapan biasa
                }
            } else {
                if (!claim(m, botId, claimOn)) return;
            }
        }

        try {
            await handleCommands(sock, m);
        } catch (e) {
            console.error('[commands]', e);
        }
    });
}

startBot();
