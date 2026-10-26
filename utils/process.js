const bar = (p) => { const f = Math.round(p / 10); return '▰'.repeat(f) + '▱'.repeat(10 - f) + ` ${p}%`;
};
function createProcess(sock, m, enabled = true) { const jid = m.key.remoteJid; let msg = null, canEdit = true, 
  last = 0, lastText = '', pct = 0; async function push(text, force) {
    if (!enabled || text === lastText) return; const now = Date.now(); if (!force && now - last < 1500) 
    return; // throttle edit if (!canEdit && !force) return; // tidak bisa edit: kirim baru hanya saat ganti 
    tahap last = now; lastText = text; if (msg && canEdit) {
      try { await sock.sendMessage(jid, { text, edit: msg.key }); return;
      } catch { canEdit = false; } // gagal edit -> fallback kirim baru
    }
    try { msg = await sock.sendMessage(jid, { text }, { quoted: m }); } catch {}
  }
  return {
    // force = true saat pindah tahap
    update(label, p, force = false) { pct = Math.max(pct, Math.min(100, Math.round(p))); return 
      push(`${label}\n${bar(pct)}`, force);
    },
    done() { return push(`✅ Selesai\n${bar(100)}`, true); }, fail(text = '❌ Gagal') { return push(text, 
    true); },
  };
}
module.exports = { createProcess };
