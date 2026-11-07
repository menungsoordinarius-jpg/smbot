'use strict'
// Pengelola key (donor + pribadi) dan jatah harian per akun bot.
// File data: data/keys.json, data/pemakaian.json, data/owner.json

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const KEYS_FILE = path.join(DATA_DIR, 'keys.json')
const USAGE_FILE = path.join(DATA_DIR, 'pemakaian.json')
const OWNER_FILE = path.join(DATA_DIR, 'owner.json')

// Donor yang kreditnya habis/key ditolak "diistirahatkan" selama ini
const DONOR_MATI_MS = 30 * 60 * 1000
const donorMati = new Map() // idDonor -> waktu ditandai

const hariIni = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) // YYYY-MM-DD (WIB)

// "628123:5@s.whatsapp.net" -> "628123"
const nomorDari = (jid) => String(jid || '').split('@')[0].split(':')[0]

// Menyusun ctx dari argumen gaya smbot: (sock, m, cmdArgs)
function buatCtx(sock, m, args) {
  const from = m.key.remoteJid
  const botNumber = nomorDari(sock.user && sock.user.id)
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
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch (e) {}
}

// ---------- keys.json ----------
function muatKeys() {
  const k = baca(KEYS_FILE, {})
  if (!k.pengguna) k.pengguna = {}
  donorsDari(k, 'pixai')
  return k
}
const simpanKeys = (k) => tulis(KEYS_FILE, k)

function donorsDari(k, service) {
  if (!k[service]) k[service] = { donors: [] }
  if (!Array.isArray(k[service].donors)) k[service].donors = []
  return k[service].donors
}

const daftarLayanan = (k) =>
  Object.keys(k).filter((s) => s !== 'pengguna' && k[s] && Array.isArray(k[s].donors))

const semuaDonor = (k) => daftarLayanan(k).flatMap((s) => k[s].donors)

// ---------- pemakaian.json (reset otomatis tiap hari WIB) ----------
function muatPemakaian() {
  const p = baca(USAGE_FILE, null)
  const t = hariIni()
  if (!p || p.tanggal !== t || typeof p.pemakaian !== 'object' || !p.pemakaian) {
    return { tanggal: t, pemakaian: {} }
  }
  return p
}

function terpakai(p, idDonor, botNumber) {
  return (p.pemakaian[idDonor] && p.pemakaian[idDonor][botNumber]) || 0
}

// ---------- owner / pengguna internal ----------
function muatOwner() {
  const o = baca(OWNER_FILE, { nomor: [] })
  return (o.nomor || []).map(String)
}

// Pengguna internal = nomor di owner.json, atau akun bot itu sendiri
function isInternal(sender, botNumber) {
  if (sender && botNumber && sender === botNumber) return true
  return muatOwner().includes(sender)
}

// ---------- logika donor ----------
function donorHidup(id) {
  const t = donorMati.get(id)
  if (!t) return true
  if (Date.now() - t > DONOR_MATI_MS) {
    donorMati.delete(id)
    return true
  }
  return false
}

const layak = (d, internal) => d.aktif && d.key && (internal || d.publik)

// Donor yang boleh dipakai sekarang, berurutan sesuai isi file
function kandidatDonor(service, botNumber, internal) {
  const k = muatKeys()
  const p = muatPemakaian()
  return donorsDari(k, service).filter(
    (d) =>
      layak(d, internal) &&
      donorHidup(d.id) &&
      terpakai(p, d.id, botNumber) < (d.batasPerAkunBot || 0)
  )
}

// Sisa jatah gratis untuk ditampilkan: { sisa, total }
function sisaJatah(service, botNumber, internal) {
  const k = muatKeys()
  const p = muatPemakaian()
  let sisa = 0
  let total = 0
  for (const d of donorsDari(k, service)) {
    if (!layak(d, internal) || !donorHidup(d.id)) continue
    const batas = d.batasPerAkunBot || 0
    total += batas
    sisa += Math.max(0, batas - terpakai(p, d.id, botNumber))
  }
  return { sisa, total }
}

// Jatah dipesan sebelum generate, dikembalikan kalau gagal
function pakaiJatah(idDonor, botNumber) {
  const p = muatPemakaian()
  if (!p.pemakaian[idDonor]) p.pemakaian[idDonor] = {}
  p.pemakaian[idDonor][botNumber] = (p.pemakaian[idDonor][botNumber] || 0) + 1
  tulis(USAGE_FILE, p)
}

function kembalikanJatah(idDonor, botNumber) {
  const p = muatPemakaian()
  if (terpakai(p, idDonor, botNumber) > 0) {
    p.pemakaian[idDonor][botNumber] -= 1
    tulis(USAGE_FILE, p)
  }
}

const tandaiHabis = (idDonor) => donorMati.set(idDonor, Date.now())
const resetMati = (idDonor) => donorMati.delete(idDonor)

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
    batasPerAkunBot: batas,
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
  if (ada) simpanKeys(k)
  return ada
}

function maskKey(key) {
  const s = String(key || '')
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '****' + s.slice(-4)
}

function daftarDonor(service) {
  const k = muatKeys()
  const p = muatPemakaian()
  return donorsDari(k, service).map((d) => ({
    id: d.id,
    key: maskKey(d.key),
    batasPerAkunBot: d.batasPerAkunBot,
    aktif: !!d.aktif,
    publik: !!d.publik,
    istirahat: !donorHidup(d.id),
    terpakaiHariIni: p.pemakaian[d.id] || {},
  }))
}

module.exports = {
  nomorDari,
  buatCtx,
  isInternal,
  kandidatDonor,
  sisaJatah,
  pakaiJatah,
  kembalikanJatah,
  tandaiHabis,
  resetMati,
  keyPengguna,
  setKeyPengguna,
  hapusKeyPengguna,
  tambahDonor,
  ubahDonor,
  hapusDonor,
  daftarDonor,
}
