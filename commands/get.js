const fs = require('fs');
const path = require('path');

const VO_DIR = path.join(__dirname, 'temp_vo');
const LOG_PATH = path.join(VO_DIR, 'logs.json');

function normalizeNumber(n) {
    n = String(n).replace(/\D/g, '');
    if (n.startsWith('0')) n = '62' + n.slice(1);
    return n;
}

function normalizeTime(str) {
    const r = str.trim().toLowerCase()
        .match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,2}):(\d{2})\s*(am|pm)?$/);
    if (!r) return null;
    const month = parseInt(r[1]);
    const date = parseInt(r[2]);
    let h = parseInt(r[3]);
    const min = parseInt(r[4]);
    const ap = r[5];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${month}/${date}/${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

module.exports = async (sock, from, m, text) => {
    // Hanya akun kamu sendiri yang boleh memakai perintah ini
    if (!m.key.fromMe) return;

    const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: m });
    const args = text.trim().split(/\s+/);
    const logs = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH)) : [];

    // .get list -> 10 data terakhir
    if ((args[1] || '').toLowerCase() === 'list') {
        if (!logs.length) return reply('Belum ada media tersimpan.');
        const lines = logs.slice(-10).map(l => `${l.type} | ${l.group || '-'} | ${l.sender} | ${l.timeStr}`);
        return reply(lines.join('\n'));
    }

    const type = (args[1] || '').toLowerCase();
    if (!['img', 'mp4'].includes(type)) {
        return reply('Format: .get img [nama grup] 0812345678 8/7/12:00');
    }

    const rest = args.slice(2).join(' ');
    const tm = rest.match(/(\d{1,2}\/\d{1,2}\/\d{1,2}:\d{2}\s*(?:am|pm)?)\s*$/i);
    const timeStr = tm && normalizeTime(tm[1]);
    if (!timeStr) return reply('Format waktu salah. Contoh: 8/7/12:00 atau 8/7/11:00 pm');

    const before = rest.slice(0, tm.index).trim().split(/\s+/);
    const number = normalizeNumber(before.pop() || '');
    const groupName = before.join(' ').toLowerCase();
    if (!number) return reply('Nomor pengirim belum ditulis.');

    const found = logs.filter(l =>
        l.type === type &&
        normalizeNumber(l.sender) === number &&
        l.timeStr === timeStr &&
        (!groupName || (l.group || '').toLowerCase().includes(groupName))
    );
    if (!found.length) return reply('Tidak ditemukan. Cek dengan: .get list');

    for (const l of found) {
        const filePath = path.join(VO_DIR, l.fileName);
        if (!fs.existsSync(filePath)) continue;
        const buffer = fs.readFileSync(filePath);
        const caption = `${l.sender} • ${l.timeStr}`;
        await sock.sendMessage(
            from,
            type === 'img' ? { image: buffer, caption } : { video: buffer, caption },
            { quoted: m }
        );
    }
};
