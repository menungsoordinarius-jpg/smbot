const { execFile } = require('child_process');
const settings = require('./settings');

const BATTERY_LIMIT = 15;
const SLOW_MS = 2500;
const COOLDOWN = 30 * 60 * 1000;

const getBattery = () => new Promise(res => {
  execFile('termux-battery-status', (e, out) => {
    if (e) return res(null);
    try { res(JSON.parse(out)); } catch { res(null); }
  });
});

const ping = async () => {
  const t = Date.now();
  try {
    await fetch('https://www.google.com/generate_204',
      { signal: AbortSignal.timeout(5000) });
    return Date.now() - t;
  } catch { return null; }
};

const timers = new Map(); // nomor bot -> interval

function startAlerts(sock) {
  const id = String(sock.user?.id || 'bot').split('@')[0].split(':')[0];
  clearInterval(timers.get(id)); // reconnect: ganti dengan sock baru
  let lastBat = 0, lastNet = 0, badCount = 0;

  const send = async (text) => {
    for (const jid of settings.getAlertGroups(sock)) {
      try { await sock.sendMessage(jid, { text }); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  timers.set(id, setInterval(async () => {
    const now = Date.now();

    const b = await getBattery();
    if (b) {
      const low = b.percentage <= BATTERY_LIMIT && b.status !== 'CHARGING';
      if (low && now - lastBat > COOLDOWN) {
        lastBat = now;
        await send(`⚠️ Baterai server ${b.percentage}% (tidak mengisi daya). Bot bisa mati sebentar lagi.`);
      }
      if (b.percentage > 20 || b.status === 'CHARGING') lastBat = 0;
    }

    const ms = await ping();
    badCount = (ms === null || ms > SLOW_MS) ? badCount + 1 : 0;
    if (badCount >= 3 && now - lastNet > COOLDOWN) {
      lastNet = now;
      const info = ms === null ? 'hampir putus' : `lambat (${ms} ms)`;
      await send(`📶 Koneksi server ${info}. Bot mungkin offline sebentar.`);
    }
  }, 60 * 1000));
}

// ---------- .setgroup on / off ----------
async function handleSetGroup(sock, m, from, text) {
  console.log('[alert] setgroup dipanggil', from, text);
  const arg = (text.split(/\s+/)[1] || '').toLowerCase();
  const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: m });

  const role = await settings.getRole(sock, m);
  if (!settings.canManage(role)) {
    if (!role.otherBot) await settings.flash(sock, m, '⛔');
    return;
  }

  if (arg === 'on') {
    if (!from.endsWith('@g.us'))
      return reply('Ketik `.setgroup on` di dalam grup yang ingin menerima peringatan.');
    if (settings.getAlertGroups(sock).includes(from))
      return reply('Grup ini sudah ada di daftar.');
    settings.addAlertGroup(sock, from);
    return reply(`✅ Grup ditambahkan. Total: ${settings.getAlertGroups(sock).length} grup.`);
  }

  if (arg === 'off') {
    const all = (text.split(/\s+/)[2] || '').toLowerCase() === 'all';
    if (all) {
      settings.removeAlertGroup(sock, null);
      return reply('🔕 Semua grup alert dihapus.');
    }
    if (!settings.getAlertGroups(sock).includes(from))
      return reply('Grup ini tidak ada di daftar.');
    settings.removeAlertGroup(sock, from);
    return reply('🔕 Grup ini dihapus dari daftar alert.');
  }

  const n = settings.getAlertGroups(sock).length;
  return reply(`Grup alert: ${n}\n\n.setgroup on (tambah grup ini)\n.setgroup off (hapus grup ini)\n.setgroup off all (hapus semua)`);
}

module.exports = { startAlerts, handleSetGroup };
