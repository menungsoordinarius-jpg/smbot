const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_DIR = path.join(os.tmpdir(), 'smbot-locks');
fs.mkdirSync(LOCK_DIR, { recursive: true });

const fileOf = (m) =>
    path.join(LOCK_DIR, `${m.key.remoteJid}_${m.key.id}`.replace(/[^\w.@-]/g, '_'));

// true = bot ini boleh menjawab
function claim(m, botId, claimOn = true) {
    const file = fileOf(m);

    if (claimOn) {
        try {
            fs.writeFileSync(file, botId, { flag: 'wx' });
            return true;                       // pertama = menang
        } catch (e) {
            if (e.code !== 'EEXIST') return true;
            try { return fs.readFileSync(file, 'utf8') === botId; }
            catch { return false; }
        }
    }

    // claim OFF: tidak mengklaim, tapi menghormati klaim bot lain
    try {
        const owner = fs.readFileSync(file, 'utf8');
        return owner === botId;
    } catch {
        return true;                           // belum ada klaim
    }
}

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
