const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_DIR = path.join(os.tmpdir(), 'smbot-locks');
fs.mkdirSync(LOCK_DIR, { recursive: true });

// true = bot ini yang menang dan boleh menjawab
function claim(m) {
    const id = `${m.key.remoteJid}_${m.key.id}`.replace(/[^\w.@-]/g, '_');
    try {
        fs.closeSync(fs.openSync(path.join(LOCK_DIR, id), 'wx'));
        return true;
    } catch (e) {
        return e.code !== 'EEXIST';
    }
}

// bersihkan kunci yang sudah lebih dari 1 menit
setInterval(() => {
    const now = Date.now();
    for (const f of fs.readdirSync(LOCK_DIR)) {
        try {
            const p = path.join(LOCK_DIR, f);
            if (now - fs.statSync(p).mtimeMs > 60000) fs.unlinkSync(p);
        } catch {}
    }
}, 60000).unref();

module.exports = { claim };
