// commands/devSettings.js
// Pengaturan menu2 yang bisa diubah dari WhatsApp (.dev), tanpa restart bot.
// Berlaku global (semua chat pribadi & grup) dan disimpan ke data/settings.json,
// jadi tetap tersimpan walau bot di-restart.
//
// Peran:
//   OWNER = pemilik bot. Ditulis di kode (OWNERS di bawah), tidak bisa diubah dari WhatsApp.
//           Boleh: .dev, .addAdmin, .delAdmin, .adminList
//   ADMIN = orang yang ditambahkan owner lewat .addAdmin (disimpan di settings.json).
//           Boleh: .dev, .adminList  (tidak boleh menambah/menghapus admin)

const fs = require("fs");
const path = require("path");

// File ini ada di commands/, jadi ".." = folder utama bot (smbot/).
// Kalau dipindah ke commands/owner/, ganti jadi "..", ".."
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

// Owner = pemilik bot. Hanya angka; boleh nomor HP dan/atau ID @lid.
// Ganti "ID-AKUN-PRIBADIMU" dengan ID dari `.dev id` yang kamu kirim dari akun pribadimu.
const OWNERS = ["6281456040766", "142254064808164", "ID-AKUN-PRIBADIMU"];

const DEFAULTS = {
  SATU_PESAN: true,
  SEMBUNYIKAN_LINK: true,
  PAKAI_READ_MORE: true,
  ADMINS: [], // diatur lewat .addAdmin / .delAdmin
};

let settings = { ...DEFAULTS };

// Simpan ke file (folder data/ dibuat otomatis kalau belum ada)
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("[dev] gagal simpan pengaturan:", e.message);
  }
}

// Baca saat bot menyala; kalau filenya belum ada, buat dari nilai default
try {
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  // Migrasi dari versi lama: kunci OWNERS (owner tambahan) -> ADMINS
  if (saved.OWNERS && !saved.ADMINS) saved.ADMINS = saved.OWNERS;
  delete saved.OWNERS;
  settings = { ...DEFAULTS, ...saved };
  save();
  console.log("[dev] pengaturan dimuat dari", FILE);
} catch {
  save();
  console.log("[dev] settings.json belum ada, dibuat dengan nilai default");
}

const getSettings = () => settings;

const digits = (jid) => String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
const idList = (arr) => (arr || []).map(digits).filter(Boolean);

function senderIds(m) {
  const k = m.key || {};
  return [k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt, m.participant]
    .map(digits)
    .filter(Boolean);
}

function isOwner(m) {
  if (m.key?.fromMe) return true;
  const owners = idList(OWNERS);
  return senderIds(m).some((id) => owners.includes(id));
}

function isAdmin(m) {
  if (isOwner(m)) return true;
  const admins = idList(settings.ADMINS);
  return senderIds(m).some((id) => admins.includes(id));
}

function statusText() {
  return Object.entries(settings)
    .filter(([, v]) => typeof v === "boolean")
    .map(([k, v]) => `${v ? "✅" : "❌"} ${k} = ${v}`)
    .join("\n");
}

// .dev  -> lihat / ubah pengaturan (owner & admin)
async function handleDev(sock, from, m, text) {
  const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: m });
  const body = text.replace(/^\.dev/i, "").trim();

  // Siapa saja boleh cek ID-nya sendiri (buat diisi ke OWNERS / .addAdmin)
  if (/^id$/i.test(body)) {
    const role = isOwner(m) ? "owner" : isAdmin(m) ? "admin" : "bukan owner/admin";
    return reply(`ID kamu: ${senderIds(m).join(", ") || "-"}\nPeran: ${role}`);
  }

  if (!isAdmin(m)) return reply("Perintah ini khusus owner/admin.");

  if (/^reset$/i.test(body)) {
    settings = { ...DEFAULTS, ADMINS: settings.ADMINS }; // daftar admin tidak ikut direset
    save();
    return reply("Pengaturan dikembalikan ke default.\n\n" + statusText());
  }

  // Terima format "NAMA = true", "NAMA: false", atau "NAMA false"
  const re = /\b(SATU_PESAN|SEMBUNYIKAN_LINK|PAKAI_READ_MORE)\b\s*[=:]?\s*(true|false)\b/gi;
  let match;
  let changed = 0;
  while ((match = re.exec(body))) {
    settings[match[1].toUpperCase()] = match[2].toLowerCase() === "true";
    changed++;
  }
  if (changed) save();

  return reply(
    (changed ? "Pengaturan diperbarui:" : "Pengaturan saat ini:") +
      "\n\n" + statusText() +
      "\n\nContoh: .dev PAKAI_READ_MORE = false"
  );
}

// Ambil target dari: nomor/ID yang diketik, @mention, atau pesan yang di-reply
function targetIds(m, body) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || {};
  const ids = [];
  (ctx.mentionedJid || []).forEach((j) => ids.push(digits(j)));
  if (ctx.participant) ids.push(digits(ctx.participant));
  (body.match(/\d{5,}/g) || []).forEach((d) => ids.push(d));
  return [...new Set(ids.filter(Boolean))];
}

// .addAdmin / .delAdmin / .adminList (alias: .ownerList)
async function handleAdmin(sock, from, m, text) {
  const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: m });
  let cmd = (text.match(/^\.(addadmin|deladmin|adminlist|ownerlist)/i) || [])[1]?.toLowerCase();
  if (cmd === "ownerlist") cmd = "adminlist";
  const body = text.replace(/^\.\w+/, "").trim();

  if (cmd === "adminlist") {
    if (!isAdmin(m)) return reply("Perintah ini khusus owner/admin.");
    const owners = idList(OWNERS).map((id) => `• ${id}`);
    const admins = idList(settings.ADMINS).map((id) => `• ${id}`);
    return reply(
      "👑 Owner:\n" + (owners.join("\n") || "-") +
      "\n\n🛡️ Admin:\n" + (admins.join("\n") || "-")
    );
  }

  // Menambah/menghapus admin hanya boleh owner
  if (!isOwner(m)) return reply("Hanya owner yang boleh mengubah daftar admin.");

  const targets = targetIds(m, body);
  const nama = cmd === "addadmin" ? "addAdmin" : "delAdmin";
  if (!targets.length) {
    return reply(
      `Cara pakai:\n• Reply pesan orangnya lalu ketik .${nama}\n• atau .${nama} @tag\n• atau .${nama} 628123456789\n\n(ID orang itu juga bisa dilihat dari .dev id yang dia kirim sendiri)`
    );
  }

  const list = idList(settings.ADMINS);
  const owners = idList(OWNERS);
  const done = [];
  const skipped = [];

  for (const id of targets) {
    if (owners.includes(id)) {
      skipped.push(`${id} (owner, tidak perlu jadi admin)`);
    } else if (cmd === "addadmin") {
      if (list.includes(id)) skipped.push(`${id} (sudah admin)`);
      else { list.push(id); done.push(id); }
    } else {
      if (!list.includes(id)) skipped.push(`${id} (bukan admin)`);
      else { list.splice(list.indexOf(id), 1); done.push(id); }
    }
  }

  if (done.length) { settings.ADMINS = list; save(); }

  return reply(
    (done.length ? `${cmd === "addadmin" ? "Admin ditambahkan" : "Admin dihapus"}: ${done.join(", ")}\n` : "") +
      (skipped.length ? `Dilewati: ${skipped.join(", ")}` : "")
  );
}

module.exports = { handleDev, handleAdmin, getSettings };
