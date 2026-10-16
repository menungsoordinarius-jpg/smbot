// commands/status.js
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');

const sh = (cmd) =>
  new Promise((res) =>
    exec(cmd, { timeout: 8000, maxBuffer: 1024 * 1024 }, (e, out) => res(e ? '' : out))
  );

const size = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};

const dur = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'h ' : ''}${h}j ${m}m`;
};

const bar = (pct) => {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
};

async function getPm2() {
  const raw = await sh('pm2 jlist');
  const i = raw.indexOf('[');
  if (i < 0) return null;
  try { return JSON.parse(raw.slice(i)); } catch { return null; }
}

module.exports = {
  name: 'status',
  async run(sock, msg) {
    const jid = msg.key.remoteJid;

    // Memori sistem
    const total = os.totalmem();
    const used = total - os.freemem();
    const memPct = (used / total) * 100;

    // Penyimpanan (folder home Termux)
    let storage = 'tidak tersedia';
    try {
      const st = fs.statfsSync(process.env.HOME || '/');
      const tot = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const pct = ((tot - free) / tot) * 100;
      storage = `${bar(pct)} ${pct.toFixed(0)}%\n   ${size(tot - free)} / ${size(tot)} (sisa ${size(free)})`;
    } catch {}

    // pm2
    const list = await getPm2();
    let pm2Text = '   pm2 tidak terbaca';
    if (list && list.length) {
      pm2Text = list
        .map((p) => {
          const e = p.pm2_env || {};
          const ok = e.status === 'online';
          return (
            `${ok ? '🟢' : '🔴'} *${p.name}* (id ${p.pm_id})\n` +
            `   status: ${e.status}\n` +
            `   cpu: ${p.monit?.cpu ?? 0}%  |  ram: ${size(p.monit?.memory || 0)}\n` +
            `   uptime: ${ok ? dur(Date.now() - e.pm_uptime) : '-'}  |  restart: ${e.restart_time}`
          );
        })
        .join('\n\n');
    }

    const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');

    const text =
`*📊 STATUS SMBOT*

*PM2*
${pm2Text}

*Memori*
${bar(memPct)} ${memPct.toFixed(0)}%
   ${size(used)} / ${size(total)}

*Penyimpanan*
${storage}

*CPU*
   load avg: ${load}
   core: ${os.cpus().length || '-'}

*Node* ${process.version}  |  *Uptime proses* ${dur(process.uptime() * 1000)}`;

    await sock.sendMessage(jid, { text }, { quoted: msg });
  },
};
