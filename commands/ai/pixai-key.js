'use strict'
// Command: .setkey  .delkey  .donor
// Mendukung beberapa layanan: pixai (bawaan) dan cloudflare.
// Layanan boleh ditulis di depan; kalau tidak ditulis, dianggap pixai.
// Semuanya hanya boleh di chat pribadi supaya key tidak terlihat orang lain.

const km = require('../../utils/keyManager')

const DEFAULT_SERVICE = 'pixai'
const SERVICES = ['pixai', 'cloudflare']

// Cara cek format key tiap layanan
const FORMAT = {
  pixai: (k) => k.length >= 10 && k.length <= 200,
  cloudflare: (k) => /^[a-f0-9]{32}:\S{20,150}$/i.test(k),
}
const CONTOH = {
  pixai: 'API_KEY_PIXAI_KAMU',
  cloudflare: 'ACCOUNT_ID:API_TOKEN',
}

// Ambil nama layanan kalau kata pertama adalah layanan yang dikenal
function ambilService(arr) {
  const a = [...(arr || [])]
  const s = a[0] && String(a[0]).toLowerCase()
  if (SERVICES.includes(s)) {
    a.shift()
    return { service: s, sisa: a, eksplisit: true }
  }
  return { service: DEFAULT_SERVICE, sisa: a, eksplisit: false }
}

// pixai: gabung tanpa spasi. cloudflare: "ID TOKEN" atau "ID:TOKEN" -> "ID:TOKEN"
function rakitKey(service, sisa) {
  if (service === 'cloudflare') return sisa.join(':').replace(/:{2,}/g, ':').trim()
  return sisa.join('').trim()
}

function bantu(ctx) {
  const { sock, msg, from } = ctx
  return {
    reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
    // di grup: hapus pesan yang berisi key (butuh bot jadi admin), lalu peringatkan
    async tolakDiGrup() {
      try {
        await sock.sendMessage(from, { delete: msg.key })
      } catch (e) {}
      await sock.sendMessage(from, {
        text:
          '⚠️ Perintah ini hanya lewat *chat pribadi* ke bot.\n' +
          'Kalau key sudah terlanjur terkirim di grup, sebaiknya buat ulang key itu di layanannya.',
      })
    },
  }
}

async function setkey(ctx) {
  const { sender, args, isGroup } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()

  const { service, sisa } = ambilService(args)
  const key = rakitKey(service, sisa)
  if (!key) {
    return b.reply(
      'Cara pakai:\n' +
        '.setkey API_KEY_PIXAI_KAMU\n' +
        '.setkey cloudflare ACCOUNT_ID:API_TOKEN'
    )
  }
  if (!FORMAT[service](key)) {
    return b.reply(`Format key tidak valid. Contoh: .setkey ${service} ${CONTOH[service]}`)
  }

  km.setKeyPengguna(service, sender, key)
  return b.reply(
    `✅ Key ${service} tersimpan. Hapus pesan yang berisi key itu dari chat kamu supaya aman.\n` +
      `Untuk menghapus key dari bot: .delkey${service === DEFAULT_SERVICE ? '' : ' ' + service}`
  )
}

async function delkey(ctx) {
  const { sender, args, isGroup } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()
  const { service } = ambilService(args)
  const ada = km.hapusKeyPengguna(service, sender)
  return b.reply(ada ? `🗑️ Key ${service} kamu sudah dihapus.` : `Kamu belum punya key ${service} tersimpan.`)
}

const BANTUAN_DONOR =
  '*Pengaturan donor* (khusus pemilik)\n' +
  'Layanan: pixai (bawaan) atau cloudflare\n' +
  '.donor list [layanan]\n' +
  '.donor add [layanan] <id> | <key> | <batas per akun bot> | <publik/privat>\n' +
  '.donor on <id>\n' +
  '.donor off <id>\n' +
  '.donor batas <id> <angka>\n' +
  '.donor del <id>\n\n' +
  'Contoh cloudflare:\n' +
  '.donor add cloudflare sanny | ACCOUNT_ID:API_TOKEN | 5 | publik'

async function donor(ctx) {
  const { sender, args, isGroup, botNumber } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()
  if (!km.isInternal(sender, botNumber)) return b.reply('Perintah ini khusus pemilik bot.')

  const [sub, ...rest] = args || []
  const { service, sisa, eksplisit } = ambilService(rest)
  const isi = sisa.join(' ').trim()

  switch ((sub || '').toLowerCase()) {
    case 'list': {
      const layanan = eksplisit ? [service] : SERVICES
      const bagian = []
      for (const s of layanan) {
        const daftar = km.daftarDonor(s)
        if (!daftar.length) {
          if (eksplisit) bagian.push(`Belum ada donor ${s}.`)
          continue
        }
        const teks = daftar
          .map((d) => {
            const status = !d.aktif ? 'nonaktif' : d.istirahat ? 'istirahat (key/kredit bermasalah)' : 'aktif'
            const pakai =
              Object.entries(d.terpakaiHariIni)
                .map(([bot, n]) => `${bot}: ${n}`)
                .join(', ') || '-'
            return (
              `• *${d.id}* — ${d.publik ? 'publik' : 'privat'}, batas ${d.batasPerAkunBot}/akun bot, ${status}\n` +
              `  key: ${d.key}\n  terpakai hari ini: ${pakai}`
            )
          })
          .join('\n')
        bagian.push(`*${s}*\n${teks}`)
      }
      return b.reply(bagian.length ? bagian.join('\n\n') : 'Belum ada donor.')
    }

    case 'add': {
      const [id, key, batasStr, mode] = isi.split('|').map((s) => s.trim())
      const batas = parseInt(batasStr, 10)
      if (!id || !key || !mode) return b.reply(BANTUAN_DONOR)
      if (!/^[a-z0-9_-]{2,30}$/i.test(id)) return b.reply('ID hanya huruf/angka/_/-, 2-30 karakter.')
      if (!FORMAT[service](key)) return b.reply(`Format key tidak valid. Contoh: ${CONTOH[service]}`)
      if (!Number.isInteger(batas) || batas < 1 || batas > 100) return b.reply('Batas harus angka 1-100.')
      if (!['publik', 'privat'].includes(mode.toLowerCase())) return b.reply('Mode: publik atau privat.')
      try {
        km.tambahDonor(service, { id, key, batas, publik: mode.toLowerCase() === 'publik' })
      } catch (e) {
        return b.reply(e.message)
      }
      return b.reply(`✅ Donor ${service} *${id}* ditambahkan (${mode.toLowerCase()}, batas ${batas}/akun bot).`)
    }

    case 'on':
    case 'off': {
      const aktif = sub.toLowerCase() === 'on'
      const ok = km.ubahDonor(isi, (d) => {
        d.aktif = aktif
      })
      if (ok && aktif) km.resetMati(isi)
      return b.reply(ok ? `Donor *${isi}* ${aktif ? 'diaktifkan' : 'dinonaktifkan'}.` : 'ID donor tidak ditemukan.')
    }

    case 'batas': {
      const [id, n] = isi.split(/\s+/)
      const batas = parseInt(n, 10)
      if (!id || !Number.isInteger(batas) || batas < 1 || batas > 100) return b.reply('Cara pakai: .donor batas <id> <1-100>')
      const ok = km.ubahDonor(id, (d) => {
        d.batasPerAkunBot = batas
      })
      return b.reply(ok ? `Batas donor *${id}* jadi ${batas}/akun bot.` : 'ID donor tidak ditemukan.')
    }

    case 'del': {
      const ok = km.hapusDonor(isi)
      return b.reply(ok ? `Donor *${isi}* dihapus.` : 'ID donor tidak ditemukan.')
    }

    default:
      return b.reply(BANTUAN_DONOR)
  }
}

const bungkus = (fn) => (sock, m, cmdArgs) => fn(km.buatCtx(sock, m, cmdArgs))

module.exports = {
  setkey: bungkus(setkey),
  delkey: bungkus(delkey),
  donor: bungkus(donor),
}
