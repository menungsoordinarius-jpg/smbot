// utils/process.js
// Pesan progres yang diedit. Kalau edit gagal, pesan lama dihapus
// lalu pesan baru dikirim (selalu hanya 1 pesan proses di chat).
//
// const proc = createProcess(sock, m, true);
// await proc.update('Label tahap', 40, true);
// proc.download('Mengunduh', loaded, total, 50, 90);   // dengan ukuran file
// await proc.done();
// await proc.fail('Gagal');

function bar(p) {
  const f = Math.round(p / 10);
  return '▰'.repeat(f) + '▱'.repeat(10 - f) + ' ' + p + '%';
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function createProcess(sock, m, enabled = true) {
  const jid = m.key.remoteJid;
  let msg = null;
  let canEdit = true;
  let last = 0;
  let lastText = '';
  let pct = 0;
  let chain = Promise.resolve();

  async function send(text, force) {
    if (!enabled) return;
    if (text === lastText) return;

    const now = Date.now();
    if (!force && now - last < 1500) return;
    if (!force && !canEdit) return;

    last = now;
    lastText = text;

    if (msg && canEdit) {
      try {
        await sock.sendMessage(jid, { text, edit: msg.key });
        return;
      } catch (e) {
        console.log('[process] edit gagal:', e && e.message);
        canEdit = false;
      }
    }

    if (msg) {
      try {
        await sock.sendMessage(jid, { delete: msg.key });
      } catch (e) {
        console.log('[process] hapus gagal:', e && e.message);
      }
    }

    try {
      msg = await sock.sendMessage(jid, { text }, { quoted: m });
    } catch (e) {
      console.log('[process] kirim gagal:', e && e.message);
    }
  }

  // antrean: update yang datang berdekatan dikirim berurutan,
  // jadi edit lama tidak bisa menimpa edit yang lebih baru
  function push(text, force) {
    chain = chain.then(() => send(text, force)).catch(() => {});
    return chain;
  }

  function render(label, p, extra) {
    pct = Math.max(pct, Math.min(100, Math.round(p)));
    return label + '\n' + bar(pct) + (extra ? '\n' + extra : '');
  }

  return {
    update(label, p, force = false, extra = '') {
      return push(render(label, p, extra), force);
    },
    // progres unduhan: persen dihitung dari loaded/total di rentang from..to
    download(label, loaded, total, from = 50, to = 90) {
      const p = total > 0 ? from + (to - from) * Math.min(1, loaded / total) : from;
      const size = total > 0 ? fmtSize(loaded) + ' / ' + fmtSize(total) : fmtSize(loaded);
      return push(render(label, p, size), false);
    },
    done() {
      return push('✅ Selesai\n' + bar(100), true);
    },
    fail(text = '❌ Gagal') {
      return push(text, true);
    },
  };
}

module.exports = { createProcess, fmtSize };
