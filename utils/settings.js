// utils/settings.js
// Sistem SETTINGS smbot: on/off + admin only, otomatis baca folder commands/
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ================= KONFIGURASI =================
// Nomor admin bot JANGAN ditulis di sini (kode ini ikut ke GitHub).
// Isi di data/owners.json (folder data/ masuk .gitignore), contoh: ["6281234567890"]
// Akun yang login ke bot (semua sesi) otomatis dianggap admin bot.
const OWNERS = [];
const OWNER_LIDS = [];
const OWNER_FILE = path.join(__dirname, '..', 'data', 'owners.json');
const SCOPE = 'chat';             // 'chat' = tiap chat/grup punya setting sendiri, 'global' = satu untuk semua
// Siapa yang boleh membuka & mengubah menu settings:
//  'self'  = hanya pemilik akun bot itu sendiri (pesan dari akun yang login / fromMe)  <- default
//  'bot'   = akun itu sendiri + nomor di OWNERS / data/owners.json
//  'both'  = 'bot' + admin grup
const MANAGE_BY = 'self';
const NOTIFY_BLOCKED = true;      // kirim pesan kalau fitur mati / khusus admin
const DEBUG = true;               // log debug di console
const CMD_DIR = path.join(__dirname, '..', 'commands');
const DB_DIR = path.join(__dirname, '..', 'data', 'settings'); // satu file per akun bot: data/settings/<nomor>.json
const IGNORE_FILES = ['commands.js', 'devSettings.js']; // file di root commands/ yang tidak ditampilkan
const IGNORE_DIRS = ['node_modules'];
// ===============================================

const log = (...a) => DEBUG && console.log('[settings]', ...a);
const norm = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
let fileOwners = [];
try { fileOwners = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')); } catch { fileOwners = []; }
const OWNER_SET = new Set([...OWNERS, ...OWNER_LIDS, ...fileOwners].map(norm).filter(Boolean));

// ---------- penyimpanan (satu file per akun bot) ----------
const dbs = {}; // botId -> { chat: { fitur: {on, admin} } }
const dbFile = (bot) => path.join(DB_DIR, bot + '.json');
function dbOf(bot) {
  if (!dbs[bot]) {
    try { dbs[bot] = JSON.parse(fs.readFileSync(dbFile(bot), 'utf8')); } catch { dbs[bot] = {}; }
  }
  return dbs[bot];
}
function save(bot) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(dbFile(bot), JSON.stringify(dbs[bot], null, 2));
}
// Setting dipisah PER AKUN BOT (nomor akun yang login) lalu per chat/grup
const botId = (sock) => norm(sock.user?.id) || 'bot';
const scopeKey = (sock, m) => botId(sock) + '|' + (SCOPE === 'global' ? 'global' : m.key.remoteJid);
function get(sk, key) {
  const [bot, chat] = sk.split('|');
  const s = (dbOf(bot)[chat] || {})[key] || {};
  return { on: s.on ?? true, admin: s.admin ?? 'off' }; // admin: off | both | bot | group
}
function set(sk, key, patch) {
  const [bot, chat] = sk.split('|');
  const d = dbOf(bot);
  d[chat] ??= {};
  d[chat][key] = { ...get(sk, key), ...patch };
  save(bot);
}

// ---------- opsi yang dideklarasikan di file command ----------
// Di file command (mis. commands/sticker/smeme.js) tulis penanda komentar:
//   // @setting font = Anton | Font default meme
//   // @setting author = SM Bot | Nama author stiker
// lalu baca nilainya di kode: settings.option(sock, __filename, 'font')
const OPT_RE = /^\s*\/\/\s*@setting\s+([\w-]+)\s*=\s*(.*?)\s*(?:\|\s*(.*))?$/;
// Cara kedua: variabel berawalan SETTING_  ->  const SETTING_font = 'Anton'; // keterangan
const VAR_RE = /^\s*(?:const|let|var)\s+SETTING_(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^;\s]+)\s*;?\s*(?:\/\/\s*(.*))?$/;
const optCache = new Map(); // file -> opsi
function parseOptions(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of src.split('\n')) {
    const mt = line.match(OPT_RE);
    if (mt) { out.push({ key: mt[1].toLowerCase(), def: mt[2], desc: mt[3] || '' }); continue; }
    const mv = line.match(VAR_RE); // const SETTING_font = 'Anton'; // keterangan
    if (mv) {
      let v = mv[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\(['"\\])/g, '$1');
      out.push({ key: mv[1].toLowerCase(), def: v, desc: mv[3] || '' });
    }
  }
  optCache.set(file, out);
  return out;
}
function castValue(v) { // "12" -> 12, "on"/"true" -> true, "off"/"false" -> false
  if (typeof v !== 'string') return v;
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (/^(on|true)$/i.test(v.trim())) return true;
  if (/^(off|false)$/i.test(v.trim())) return false;
  return v;
}
const relOf = (file) => path.relative(CMD_DIR, file).replace(/\\/g, '/').replace(/\.js$/, '');
function optionRaw(bot, rel, opt) { // nilai tersimpan, kalau belum ada pakai default di penanda
  const stored = dbOf(bot).__options?.[rel]?.[opt.key];
  return stored !== undefined ? stored : opt.def;
}
function setOption(bot, rel, key, value) {
  const d = dbOf(bot);
  d.__options ??= {};
  d.__options[rel] ??= {};
  if (value === undefined) delete d.__options[rel][key]; else d.__options[rel][key] = value;
  save(bot);
}
// Dipanggil dari file command: settings.option(sock, __filename, 'font', 'Anton')
function option(sock, file, key, fallback) {
  key = String(key).toLowerCase();
  const opts = optCache.get(file) || parseOptions(file);
  const opt = opts.find((o) => o.key === key);
  const stored = dbOf(botId(sock)).__options?.[relOf(file)]?.[key];
  if (stored !== undefined) return castValue(stored);
  if (opt) return castValue(opt.def);
  return fallback;
}

// ---------- scan folder commands ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const byName = (a, b) => a.name.localeCompare(b.name);

function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      out = out.concat(walk(path.join(dir, e.name), base + '/' + e.name));
    } else if (e.name.endsWith('.js')) {
      out.push(base + '/' + e.name.slice(0, -3));
    }
  }
  return out;
}

function scan() {
  const cats = [], files = [];
  for (const e of fs.readdirSync(CMD_DIR, { withFileTypes: true }).sort(byName)) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      const kids = walk(path.join(CMD_DIR, e.name), e.name);
      if (kids.length) {
        cats.push({
          type: 'category', key: e.name, label: cap(e.name),
          children: kids.map((k) => ({
            key: k, label: k.slice(e.name.length + 1),
            options: parseOptions(path.join(CMD_DIR, k + '.js')),
          })),
        });
      }
    } else if (e.name.endsWith('.js') && !IGNORE_FILES.includes(e.name)) {
      const n = e.name.slice(0, -3);
      files.push({ type: 'file', key: n, label: n, children: [], options: parseOptions(path.join(CMD_DIR, e.name)) });
    }
  }
  return [...cats, ...files].map((it, i) => ({ ...it, num: i + 1 }));
}

// ---------- tampilan ----------
function circled(n) {
  if (n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}
function adminLine(mode, child) {
  if (mode !== 'off') {
    const lbl = mode === 'both' ? 'on' : `on: ${mode}`;
    return child ? `|    \`Admin only (${lbl})\`` : `\`Admin only (${lbl})\``;
  }
  return child ? '> \u200e    Admin only (off)' : '> Admin only (off)';
}
function optLines(bot, target) {
  return (target.options || []).map((o) => `|   ⚙ ${o.key}: ${optionRaw(bot, target.key, o)}\n`).join('');
}
function render(items, sk) {
  const bot = sk.split('|')[0];
  let out = '⚙️ *SETTINGS*\n';
  for (const it of items) {
    const st = get(sk, it.key);
    out += `\n${circled(it.num)} *${it.label}* (${st.on ? 'on' : 'off'})\n`;
    out += adminLine(st.admin, false) + '\n';
    out += optLines(bot, it);
    for (const c of it.children) {
      const cs = get(sk, c.key);
      out += ` |   ${c.label} (${cs.on ? 'on' : 'off'})\n`;
      out += adminLine(cs.admin, true) + '\n';
      out += optLines(bot, c);
    }
  }
  out += '\n_Balas pesan ini:_\n`1 on` / `1 off`\n`1 x on` / `1 x off`\n`1 x admin only on`\n`1 x admin bot on` / `admin group on`\n`1 x set font Anton` (ubah opsi) / `1 x set font default` (reset)';
  return out;
}

// ---------- daftar akun bot yang pernah login (supaya bot lain tidak salah memberi ⛔) ----------
const BOTS_FILE = path.join(__dirname, '..', 'data', 'bots.json');
let knownBots = new Set();
try { knownBots = new Set(JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'))); } catch { knownBots = new Set(); }
function registerBot(sock) {
  let changed = false;
  for (const id of [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm)) {
    if (id && !knownBots.has(id)) { knownBots.add(id); changed = true; }
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(BOTS_FILE), { recursive: true });
      fs.writeFileSync(BOTS_FILE, JSON.stringify([...knownBots]));
    } catch (e) { log('gagal simpan bots.json:', e.message); }
  }
}

// ---------- reaksi ----------
async function react(sock, m, emoji) {
  try { await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } }); }
  catch (e) { log('gagal react:', e.message); }
}
async function flash(sock, m, emoji, ms = 5000) { // reaksi yang hilang sendiri setelah ms
  await react(sock, m, emoji);
  setTimeout(() => react(sock, m, ''), ms);
}

// ---------- cek admin ----------
const metaCache = new Map();
async function groupMeta(sock, jid) {
  const c = metaCache.get(jid);
  if (c && Date.now() - c.t < 30000) return c.meta;
  const meta = await sock.groupMetadata(jid);
  metaCache.set(jid, { t: Date.now(), meta });
  return meta;
}
async function getRole(sock, m) {
  registerBot(sock);
  const k = m.key;
  const jid = k.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const ids = (isGroup ? [k.participant, k.participantAlt] : [jid, k.remoteJidAlt, k.participant])
    .filter(Boolean).map(norm).filter(Boolean);
  // self = pemilik akun bot ini (HANYA akun milik sock ini, bukan akun bot lain)
  const mine = [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm);
  const self = !!k.fromMe || ids.some((i) => mine.includes(i));
  const bot = self || ids.some((i) => OWNER_SET.has(i));
  const otherBot = !self && ids.some((i) => knownBots.has(i)); // pengirim = pemilik akun bot lain
  let group = false;
  if (isGroup) {
    try {
      const meta = await groupMeta(sock, jid);
      group = meta.participants.some((p) =>
        p.admin && [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(norm).some((x) => ids.includes(x)));
    } catch (e) { log('gagal ambil metadata grup:', e.message); }
  }
  log('role', { ids, self, bot, group, otherBot });
  return { self, bot, group, otherBot };
}
function canManage(role) {
  if (MANAGE_BY === 'self') return role.self;
  if (MANAGE_BY === 'bot') return role.bot;
  return role.bot || role.group;
}
function allowed(mode, role) {
  if (mode === 'bot') return role.bot;
  if (mode === 'group') return role.group;
  return role.bot || role.group; // both
}

// ---------- gate ----------
async function check(sock, m, rel) {
  const sk = scopeKey(sock, m);
  const cat = rel.includes('/') ? rel.split('/')[0] : null;
  const states = (cat ? [cat, rel] : [rel]).map((k) => ({ k, ...get(sk, k) }));
  const off = states.find((s) => !s.on);
  if (off) return { ok: false, reason: 'off', key: off.k };
  const adm = states.filter((s) => s.admin !== 'off');
  if (adm.length) {
    const role = await getRole(sock, m);
    const bad = adm.find((s) => !allowed(s.admin, role));
    if (bad) return { ok: false, reason: 'admin', key: bad.k };
  }
  return { ok: true };
}

const textOf = (m) =>
  m.message?.conversation || m.message?.extendedTextMessage?.text ||
  m.message?.imageMessage?.caption || m.message?.videoMessage?.caption ||
  m.message?.documentMessage?.caption || '';

function wrapFn(fn, rel) {
  const w = async function (...args) {
    const sock = args[0];
    // pesan (m) bisa di argumen ke-2 (sock, m, ...) atau ke-3 (sock, from, m, ...)
    const m = [args[1], args[2]].find((a) => a && a.key && a.key.remoteJid);
    if (sock && typeof sock.sendMessage === 'function' && m) {
      const r = await check(sock, m, rel);
      if (!r.ok) {
        log('diblokir', rel, r);
        // beri tahu hanya kalau pesannya memang perintah (diawali titik); pesan biasa diam saja
        if (NOTIFY_BLOCKED && textOf(m).trim().startsWith('.')) {
          const t = r.reason === 'off'
            ? `⛔ Fitur *${r.key}* sedang dimatikan.`
            : `⛔ Fitur *${r.key}* hanya untuk admin.`;
          await sock.sendMessage(m.key.remoteJid, { text: t }, { quoted: m }).catch(() => {});
        }
        return;
      }
    }
    return fn.apply(this, args);
  };
  Object.defineProperty(w, 'name', { value: fn.name });
  Object.assign(w, fn);
  return w;
}
function wrapExports(exp, rel) {
  if (typeof exp === 'function') return wrapFn(exp, rel);
  if (exp && typeof exp === 'object') {
    const out = Object.create(Object.getPrototypeOf(exp));
    for (const k of Object.keys(exp)) {
      out[k] = typeof exp[k] === 'function' ? wrapFn(exp[k], rel) : exp[k];
    }
    return out;
  }
  return exp;
}

// Pasang SEKALI di paling atas index.js (sebelum require commands.js)
function install() {
  if (Module.__smSettings) return;
  Module.__smSettings = true;
  const orig = Module.prototype.require;
  const cache = new Map();
  Module.prototype.require = function (request) {
    const exp = orig.apply(this, arguments);
    try {
      if (typeof request !== 'string' || !(request.startsWith('.') || path.isAbsolute(request))) return exp;
      const file = Module._resolveFilename(request, this);
      if (!file.endsWith('.js') || !file.startsWith(CMD_DIR + path.sep)) return exp;
      const rel = path.relative(CMD_DIR, file).replace(/\\/g, '/').slice(0, -3);
      if (IGNORE_FILES.includes(rel + '.js')) return exp;
      if (cache.has(file)) return cache.get(file);
      const wrapped = wrapExports(exp, rel);
      if (exp && (typeof exp === 'function' || Object.keys(exp).length)) cache.set(file, wrapped);
      return wrapped;
    } catch (e) {
      return exp;
    }
  };
  log('hook terpasang, folder:', CMD_DIR);
}

// ---------- perintah .settings ----------
const pending = new Map(); // id pesan settings -> { chat, items }

async function show(sock, m) {
  const role = await getRole(sock, m);
  if (!canManage(role)) {
    log('show ditolak (bukan pemilik akun ini)');
    if (!role.otherBot) await flash(sock, m, '⛔'); // pemilik akun bot lain: diam saja
    return;
  }
  const items = scan();
  const sk = scopeKey(sock, m);
  const sent = await sock.sendMessage(m.key.remoteJid, { text: render(items, sk) }, { quoted: m });
  if (sent?.key?.id) {
    pending.set(sent.key.id, { chat: m.key.remoteJid, items, sock });
    if (pending.size > 50) pending.delete(pending.keys().next().value);
  }
}

function parseSet(item, raw, t, si) {
  const name = t.slice(1, si).join(' ');
  let target = item;
  if (name) {
    target = item.children.find((c) => c.label.toLowerCase() === name || c.key.toLowerCase() === name);
    if (!target) return { err: `"${name}" tidak ada di ${item.label}` };
  }
  const key = t[si + 1] || '';
  const opt = (target.options || []).find((o) => o.key === key);
  if (!opt) return { err: `Opsi "${key}" tidak ada di ${target.label}` };
  const val = raw.slice(si + 2).join(' ').trim();
  if (!val) return { err: `Isi nilainya: ${key} <nilai>` };
  if (/^(default|reset)$/i.test(val)) {
    return { opt: { rel: target.key, key, value: undefined }, text: `✅ *${target.label}* ${key} → default (${opt.def})` };
  }
  return { opt: { rel: target.key, key, value: val }, text: `✅ *${target.label}* ${key} → ${val}` };
}

function parseLine(line, snap) {
  const raw = line.trim().split(/\s+/);
  const t = raw.map((x) => x.toLowerCase());
  if (!/^\d+$/.test(t[0])) return { err: `Format salah: "${line}"` };
  const item = snap.items[parseInt(t[0], 10) - 1];
  if (!item) return { err: `Nomor ${t[0]} tidak ada` };
  const si = t.indexOf('set', 1);
  if (si !== -1) return parseSet(item, raw, t, si);
  const val = t[t.length - 1];
  if (val !== 'on' && val !== 'off') return { err: `Akhiri dengan on / off: "${line}"` };

  const mid = t.slice(1, -1);
  let mode = null;
  const ai = mid.indexOf('admin');
  if (ai !== -1) {
    const map = { only: 'both', semua: 'both', both: 'both', keduanya: 'both', bot: 'bot', group: 'group', grup: 'group' };
    if (mid[ai + 1] && map[mid[ai + 1]]) { mode = map[mid[ai + 1]]; mid.splice(ai, 2); }
    else { mode = 'both'; mid.splice(ai, 1); }
  }
  const name = mid.join(' ');
  let target = item;
  if (name) {
    target = item.children.find((c) => c.label.toLowerCase() === name || c.key.toLowerCase() === name);
    if (!target) return { err: `"${name}" tidak ada di ${item.label}` };
  }
  const patch = mode ? { admin: val === 'on' ? mode : 'off' } : { on: val === 'on' };
  const what = mode ? `admin only ${val}${val === 'on' && mode !== 'both' ? ` (${mode})` : ''}` : val;
  return { key: target.key, patch, text: `✅ *${target.label}* → ${what}` };
}

// Dipanggil paling awal di router; return true kalau pesan itu balasan settings
async function handleReply(sock, m, body) {
  const id = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
  if (!id) return false;
  const snap = pending.get(id);
  if (!snap || snap.sock !== sock || snap.chat !== m.key.remoteJid) return false; // hanya bot yang mengirim menu yang memproses balasan
  if (!body || !/^\d/.test(body.trim())) return false;

  const role = await getRole(sock, m);
  if (!canManage(role)) {
    await flash(sock, m, '⛔');
    return true;
  }
  const sk = scopeKey(sock, m);
  const res = [];
  for (const line of body.split('\n').filter((l) => l.trim())) {
    const r = parseLine(line, snap);
    if (r.err) { res.push('❌ ' + r.err); continue; }
    if (r.opt) setOption(botId(sock), r.opt.rel, r.opt.key, r.opt.value);
    else set(sk, r.key, r.patch);
    res.push(r.text);
  }
  const errs = res.filter((x) => x.startsWith('❌'));
  if (res.length > errs.length) await flash(sock, m, '✅');
  if (errs.length) await sock.sendMessage(m.key.remoteJid, { text: errs.join('\n') }, { quoted: m });
  return true;
}

module.exports = { install, show, handleReply, check, scan, option };
