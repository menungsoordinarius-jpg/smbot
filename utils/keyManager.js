'use strict'
// Pengelola key (donor + pribadi) dan sistem klaim donor per orang.
// File data: data/keys.json, data/klaim.json, data/owner.json
//
// Aturan klaim:
//  - Orang biasa harus .claim <nama donor> dulu. Satu klaim = jatah "batas" kali pakai
//    dalam 24 jam sejak klaim. Setelah 24 jam, klaim lagi secara manual.
//  - Pemilik/akun bot (internal) bebas, tidak perlu klaim dan tidak dihitung.
//  - Donor yang kena limit (429, terlalu banyak permintaan) ditandai merah sementara.

const fs = require('fs')
const path = require('path')

// Data dipisah per bot: data/<nomor bot>/keys.json, klaim.json, owner.json
// Nomor bot diisi otomatis oleh buatCtx (atau lewat env BOT_ID / pakaiBot).
// Satu proses = satu bot (cocok dengan pm2: smbot-utama dan smbot-kedua).
const DATA_ROOT = path.join(__dirname, '..', 'data')
let botId = process.env.BOT_ID || null

const KLAIM_MS = 24 * 60 * 60 * 1000 // masa satu klaim
// Donor yang kreditnya habis/key ditolak "diistirahatkan" selama ini
const DONOR_MATI_MS = 30 * 60 * 1000
// Donor yang kena limit (terlalu banyak permintaan) ditandai merah selama ini
const DONOR_LIMIT_MS = 10 * 60 * 1000
const donorMati = new Map() // idDonor -> waktu ditandai
const donorLimit = new Map() // idDonor -> waktu ditandai

// Alamat file data milik bot ini. Pertama kali dipakai, keys.json dan owner.json
// lama (data/keys.json, data/owner.json) disalin sekali supaya tidak hilang.
function berkas(nama) {
  if (!botId) return path.join(DATA_ROOT, nama)
  const dir = path.join(DATA_ROOT, botId)
  const file = path.join(dir, nama)
  if (!fs.existsSync(file) && nama !== 'klaim.json') {
    const lama = path.join(DATA_ROOT, nama)
    if (fs.existsSync(lama)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(lama, file)
      } catch (e) {}
    }
  }
  return file
}

function pakaiBot(id) {
  if (id) botId = String(id)
}

// "628123:5@s.whatsapp.net" -> "628123"
const nomorDari = (jid) => String(jid || '').split('@')[0].split(':')[0]

// Menyusun ctx dari argumen gaya smbot: (sock, m, cmdArgs)
function buatCtx(sock, m, args) {
  const from = m.key.remoteJid
  const botNumber = nomorDari(sock.user && sock.user.id)
  if (!botId && botNumber) botId = botNumber // data terpisah per bot
  const sender = m.key.fromMe ? botNumber : nomorDari(m.key.participant || m.key.remoteJid)
  return {
    sock,
    msg: m,
    from,
    sender,
    args: args || [],
    isGroup: String(from).endsWith('@g.us'),
    botNumber,
  }
}

// ---------- baca/tulis file ----------
function baca(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // jangan menimpa file yang rusak, supaya key tidak hilang
    throw new Error('File data rusak: ' + path.basename(file))
  }
}

function tulis(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch (e) {}
}

// ---------- keys.json ----------
function muatKeys() {
  const k = baca(berkas('keys.json'), {})
  if (!k.pengguna) k.pengguna = {}
  donorsDari(k, 'pixai')
  return k
}
const simpanKeys = (k) => tulis(berkas('keys.json'), k)

function donorsDari(k, service) {
  if (!k[service]) k[service] = { donors: [] }
  if (!Array.isArray(k[service].donors)) k[service].donors = []
  return k[service].donors
}

const daftarLayanan = (k) =>
  Object.keys(k).filter((s) => s !== 'pengguna' && k[s] && Array.isArray(k[s].donors))

const semuaDonor = (k) => daftarLayanan(k).flatMap((s) => k[s].donors)

// Batas pakai per orang per klaim. Donor lama masih memakai field batasPerAkunBot.
const batasDonor = (d) => d.batasKlaim || d.batasPerAkunBot || 0

// ---------- klaim.json: { idDonor: { nomor: { sejak, pakai } } } ----------
function muatKlaim() {
  const c = baca(berkas('klaim.json'), {})
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {}
}

// Simpan sambil membuang klaim yang sudah lewat 24 jam
function simpanKlaim(c) {
  const sekarang = Date.now()
  for (const id of Object.keys(c)) {
    for (const u of Object.keys(c[id] || {})) {
      if (sekarang - c[id][u].sejak >= KLAIM_MS) delete c[id][u]
    }
    if (!c[id] || !Object.keys(c[id]).length) delete c[id]
  }
  tulis(berkas('klaim.json'), c)
}

// Klaim yang masih berlaku (belum 24 jam), atau null
function klaimAktif(c, idDonor, pengguna) {
  const r = c[idDonor] && c[idDonor][pengguna]
  if (!r || Date.now() - r.sejak >= KLAIM_MS) return null
  return r
}

// ---------- owner / pengguna internal ----------
function muatOwner() {
  const o = baca(berkas('owner.json'), { nomor: [] })
  return (o.nomor || []).map(String)
}

// Pengguna internal = nomor di owner.json, atau akun bot itu sendiri
function isInternal(sender, botNumber) {
  if (sender && botNumber && sender === botNumber) return true
  return muatOwner().includes(sender)
}

// ---------- status donor ----------
function donorHidup(id) {
  const t = donorMati.get(id)
  if (!t) return true
  if (Date.now() - t > DONOR_MATI_MS) {
    donorMati.delete(id)
    return true
  }
  return false
}

function donorBebasLimit(id) {
  const t = donorLimit.get(id)
  if (!t) return true
  if (Date.now() - t > DONOR_LIMIT_MS) {
    donorLimit.delete(id)
    return true
  }
  return false
}

const layak = (d, internal) => d.aktif && d.key && (internal || d.publik)

// Donor yang boleh dipakai sekarang, berurutan sesuai isi file.
// Orang biasa: harus punya klaim aktif dan masih ada sisa. Internal: semua donor layak.
// CATATAN: parameter kedua sekarang = nomor pengirim (dulu botNumber).
function kandidatDonor(service, pengguna, internal) {
  const k = muatKeys()
  const c = muatKlaim()
  return donorsDari(k, service).filter((d) => {
    if (!layak(d, internal) || !donorHidup(d.id) || !donorBebasLimit(d.id)) return false
    if (internal) return true
    const r = klaimAktif(c, d.id, pengguna)
    return !!r && r.pakai < batasDonor(d)
  })
}

// Sisa jatah klaim untuk ditampilkan: { sisa, total }
function sisaJatah(service, pengguna, internal) {
  if (internal) return { sisa: '∞', total: '∞' }
  const k = muatKeys()
  const c = muatKlaim()
  let sisa = 0
  let total = 0
  for (const d of donorsDari(k, service)) {
    if (!d.aktif || !d.publik || !d.key) continue
    const r = klaimAktif(c, d.id, pengguna)
    if (!r) continue
    const batas = batasDonor(d)
    total += batas
    sisa += Math.max(0, batas - r.pakai)
  }
  return { sisa, total }
}

// Jatah dipesan sebelum generate, dikembalikan kalau gagal.
// Internal tidak punya klaim, jadi otomatis tidak dihitung.
function pakaiJatah(idDonor, pengguna) {
  const c = muatKlaim()
  const r = klaimAktif(c, idDonor, pengguna)
  if (!r) return
  r.pakai += 1
  simpanKlaim(c)
}

function kembalikanJatah(idDonor, pengguna) {
  const c = muatKlaim()
  const r = klaimAktif(c, idDonor, pengguna)
  if (!r || r.pakai <= 0) return
  r.pakai -= 1
  simpanKlaim(c)
}

const tandaiHabis = (idDonor) => donorMati.set(idDonor, Date.now())
const tandaiLimit = (idDonor) => donorLimit.set(idDonor, Date.now())
function resetMati(idDonor) {
  donorMati.delete(idDonor)
  donorLimit.delete(idDonor)
}

// ---------- klaim manual (.claim) ----------
// Hasil: { ok:true, id, batas } atau { ok:false, kode, ... }
// kode: internal | tidak-ada | masih-aktif | istirahat | limit
function klaimDonor(namaDonor, pengguna, internal) {
  if (internal) return { ok: false, kode: 'internal' }
  const k = muatKeys()
  const nama = String(namaDonor || '').toLowerCase()
  const d = semuaDonor(k).find((x) => String(x.id).toLowerCase() === nama)
  if (!d || !d.aktif || !d.publik || !d.key) return { ok: false, kode: 'tidak-ada' }

  const c = muatKlaim()
  const r = klaimAktif(c, d.id, pengguna)
  const batas = batasDonor(d)
  if (r) {
    return {
      ok: false,
      kode: 'masih-aktif',
      id: d.id,
      batas,
      sisa: Math.max(0, batas - r.pakai),
      lagiMs: r.sejak + KLAIM_MS - Date.now(),
    }
  }
  if (!donorHidup(d.id)) return { ok: false, kode: 'istirahat', id: d.id }
  if (!donorBebasLimit(d.id)) return { ok: false, kode: 'limit', id: d.id }

  if (!c[d.id]) c[d.id] = {}
  c[d.id][pengguna] = { sejak: Date.now(), pakai: 0 }
  simpanKlaim(c)
  return { ok: true, id: d.id, batas }
}

// Daftar donor untuk .daily, dikelompokkan per layanan
// status: siap | limit (merah) | istirahat | nonaktif
function statusDonor(pengguna, internal) {
  const k = muatKeys()
  const c = muatKlaim()
  return daftarLayanan(k)
    .map((service) => ({
      service,
      donors: k[service].donors
        .filter((d) => d.key && (internal || (d.aktif && d.publik)))
        .map((d) => {
          const batas = batasDonor(d)
          const r = internal ? null : klaimAktif(c, d.id, pengguna)
          let status = 'siap'
          if (!d.aktif) status = 'nonaktif'
          else if (!donorHidup(d.id)) status = 'istirahat'
          else if (!donorBebasLimit(d.id)) status = 'limit'
          return {
            id: d.id,
            status,
            publik: !!d.publik,
            batas,
            diklaim: !!r,
            sisa: r ? Math.max(0, batas - r.pakai) : 0,
            lagiMs: r ? r.sejak + KLAIM_MS - Date.now() : 0,
          }
        }),
    }))
    .filter((s) => s.donors.length)
}

// ---------- key pribadi pengguna ----------
const keyPengguna = (service, sender) => {
  const k = muatKeys()
  return (k.pengguna[sender] && k.pengguna[sender][service]) || null
}

function setKeyPengguna(service, sender, key) {
  const k = muatKeys()
  if (!k.pengguna[sender]) k.pengguna[sender] = {}
  k.pengguna[sender][service] = key
  simpanKeys(k)
}

function hapusKeyPengguna(service, sender) {
  const k = muatKeys()
  if (!k.pengguna[sender] || !k.pengguna[sender][service]) return false
  delete k.pengguna[sender][service]
  if (Object.keys(k.pengguna[sender]).length === 0) delete k.pengguna[sender]
  simpanKeys(k)
  return true
}

// ---------- admin donor ----------
function tambahDonor(service, { id, key, batas, publik }) {
  const k = muatKeys()
  if (semuaDonor(k).some((d) => d.id === id)) throw new Error('ID donor sudah dipakai')
  donorsDari(k, service).push({
    id,
    key,
    batasKlaim: batas, // jatah per orang per klaim (24 jam)
    aktif: true,
    publik: !!publik,
  })
  simpanKeys(k)
}

function ubahDonor(id, fn) {
  const k = muatKeys()
  const d = semuaDonor(k).find((x) => x.id === id)
  if (!d) return false
  fn(d)
  simpanKeys(k)
  return true
}

function hapusDonor(id) {
  const k = muatKeys()
  let ada = false
  for (const s of daftarLayanan(k)) {
    const arr = k[s].donors
    const i = arr.findIndex((d) => d.id === id)
    if (i >= 0) {
      arr.splice(i, 1)
      ada = true
    }
  }
  if (ada) {
    simpanKeys(k)
    // bersihkan juga klaim milik donor ini
    const c = muatKlaim()
    if (c[id]) {
      delete c[id]
      simpanKlaim(c)
    }
  }
  return ada
}

function maskKey(key) {
  const s = String(key || '')
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '****' + s.slice(-4)
}

// Untuk .donor list (khusus pemilik)
function daftarDonor(service) {
  const k = muatKeys()
  const c = muatKlaim()
  return donorsDari(k, service).map((d) => ({
    id: d.id,
    key: maskKey(d.key),
    batas: batasDonor(d),
    aktif: !!d.aktif,
    publik: !!d.publik,
    istirahat: !donorHidup(d.id),
    limit: !donorBebasLimit(d.id),
    klaimAktif: Object.keys(c[d.id] || {}).filter((u) => klaimAktif(c, d.id, u)).length,
  }))
}

// ---------- helper untuk fitur apa pun (AI atau bukan) ----------
const RE_LIMIT = /\b429\b|rate.?limit|too many requests|terlalu banyak/i
const RE_MASALAH = /\b40[123]\b|unauthorized|forbidden/i
const pesanErr = (e) => String((e && e.message) || e || '')
const isLimit = (e) => !!e && (e.status === 429 || RE_LIMIT.test(pesanErr(e)))
const isMasalahKey = (e) => !!e && ([401, 402, 403].includes(e.status) || RE_MASALAH.test(pesanErr(e)))

const teksTanpaKey = (service) =>
  '😔 Belum ada jatah donor yang bisa dipakai.\n' +
  'Cek *.daily* lalu klaim dengan *.claim <nama donor>*, ' +
  `atau pasang key sendiri di chat pribadi: *.setkey ${service} <key>*`

// Menjalankan kerja(key, sumber) dengan urutan: donor (sesuai klaim) -> key pribadi.
// Jatah donor dipesan sebelum kerja dan dikembalikan kalau gagal.
// kerja HARUS melempar error kalau gagal (lebih baik dengan err.status dari HTTP).
// Mengembalikan { hasil, sumber: 'donor'|'sendiri', donorId? }.
// Error khusus (cek err.kode):
//   TANPA_KEY               -> tidak ada donor/key pribadi yang bisa dipakai
//   KEY_PRIBADI_BERMASALAH  -> key pribadi ditolak / limit
// opsi: { isLimit(err), isMasalahKey(err) } untuk menimpa cara mendeteksi error.
async function denganKey(service, ctx, kerja, opsi = {}) {
  const limit = opsi.isLimit || isLimit
  const masalah = opsi.isMasalahKey || isMasalahKey
  const internal = isInternal(ctx.sender, ctx.botNumber)
  const keyPribadi = keyPengguna(service, ctx.sender)
  const donors = kandidatDonor(service, ctx.sender, internal)

  const tanpaKey = (pesan) => {
    const e = new Error(pesan)
    e.kode = 'TANPA_KEY'
    return e
  }
  if (!donors.length && !keyPribadi) throw tanpaKey('Tidak ada key yang tersedia')

  for (const d of donors) {
    pakaiJatah(d.id, ctx.sender)
    try {
      const hasil = await kerja(d.key, 'donor')
      return { hasil, sumber: 'donor', donorId: d.id }
    } catch (err) {
      kembalikanJatah(d.id, ctx.sender)
      if (limit(err)) { tandaiLimit(d.id); continue } // merah di .daily
      if (masalah(err)) { tandaiHabis(d.id); continue }
      throw err
    }
  }

  if (!keyPribadi) throw tanpaKey('Semua donor sedang tidak bisa dipakai')
  try {
    return { hasil: await kerja(keyPribadi, 'sendiri'), sumber: 'sendiri' }
  } catch (err) {
    if (limit(err) || masalah(err)) err.kode = 'KEY_PRIBADI_BERMASALAH'
    throw err
  }
}

module.exports = {
  nomorDari,
  pakaiBot,
  denganKey,
  teksTanpaKey,
  isLimit,
  isMasalahKey,
  buatCtx,
  isInternal,
  kandidatDonor,
  sisaJatah,
  pakaiJatah,
  kembalikanJatah,
  tandaiHabis,
  tandaiLimit,
  resetMati,
  klaimDonor,
  statusDonor,
  keyPengguna,
  setKeyPengguna,
  hapusKeyPengguna,
  tambahDonor,
  ubahDonor,
  hapusDonor,
  daftarDonor,
}
