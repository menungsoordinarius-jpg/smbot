'use strict'
// Command: .daily  .claim  (file: donor-claim.js, bukan utils/claim.js milik kunci pesan)
// .daily            -> daftar donor + status + jatah klaim kamu
// .claim <donor>    -> klaim jatah donor (berlaku 24 jam, klaim ulang manual setelahnya)

const km = require('../../utils/keyManager')

// WhatsApp tidak bisa mewarnai teks, jadi warna merah dipakai lewat emoji 🔴
const IKON = { siap: '🟢', limit: '🔴', istirahat: '⚫', nonaktif: '⚪' }

function durasi(ms) {
  const menit = Math.max(1, Math.ceil(ms / 60000))
  const jam = Math.floor(menit / 60)
  const sisa = menit % 60
  return jam ? `${jam} jam ${sisa} menit` : `${sisa} menit`
}

async function daily(ctx) {
  const { sock, msg, from, sender, botNumber } = ctx
  const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
  const internal = km.isInternal(sender, botNumber)

  const daftar = km.statusDonor(sender, internal)
  if (!daftar.length) {
    await reply('Belum ada donor yang tersedia.')
    return true
  }

  const bagian = daftar.map(({ service, donors }) => {
    const baris = donors.map((d) => {
      let info
      if (internal) info = `bebas klaim${d.publik ? '' : ', privat'}`
      else if (d.diklaim && d.sisa > 0) info = `jatahmu ${d.sisa}/${d.batas}, klaim lagi ${durasi(d.lagiMs)} lagi`
      else if (d.diklaim) info = `jatahmu habis, klaim lagi ${durasi(d.lagiMs)} lagi`
      else info = `belum diklaim (${d.batas}x per 24 jam)`

      let catatan = ''
      if (d.status === 'limit') catatan = '\n   ↳ kena limit (terlalu banyak permintaan), coba lagi nanti'
      else if (d.status === 'istirahat') catatan = '\n   ↳ key/kredit bermasalah, diistirahatkan sementara'
      else if (d.status === 'nonaktif') catatan = '\n   ↳ nonaktif'

      return `${IKON[d.status]} *${d.id}* — ${info}${catatan}`
    })
    return `*${service}*\n${baris.join('\n')}`
  })

  await reply(
    '📅 *Jatah Donor*\n\n' +
      bagian.join('\n\n') +
      '\n\nKlaim: *.claim <nama donor>*\n' +
      '🟢 siap  🔴 kena limit  ⚫ key/kredit bermasalah'
  )
  return true
}

async function claim(ctx) {
  const { sock, msg, from, sender, args, botNumber } = ctx
  const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
  const internal = km.isInternal(sender, botNumber)

  const nama = (args || [])[0]
  if (!nama) {
    await reply('Cara pakai: .claim <nama donor>\nLihat daftar donor: .daily')
    return false
  }

  const h = km.klaimDonor(nama, sender, internal)
  if (h.ok) {
    await reply(
      `✅ Klaim *${h.id}* berhasil!\n` +
        `Kamu bisa memakainya ${h.batas}x dalam 24 jam ke depan.\n` +
        'Setelah 24 jam, klaim lagi secara manual dengan .claim.'
    )
    return true
  }

  switch (h.kode) {
    case 'internal':
      await reply('Kamu pemilik bot, bebas memakai donor tanpa klaim.')
      return true
    case 'masih-aktif':
      await reply(
        `Klaim *${h.id}* masih berlaku. Sisa jatahmu ${h.sisa}/${h.batas}.\n` +
          `Klaim lagi dalam ${durasi(h.lagiMs)}.`
      )
      return false
    case 'limit':
      await reply(`🔴 Donor *${h.id}* sedang kena limit (terlalu banyak permintaan). Coba donor lain atau tunggu sebentar.`)
      return false
    case 'istirahat':
      await reply(`⚫ Key donor *${h.id}* sedang bermasalah dan diistirahatkan. Coba donor lain atau tunggu sebentar.`)
      return false
    default:
      await reply(`Donor *${nama}* tidak ditemukan. Lihat daftar dengan .daily`)
      return false
  }
}

const bungkus = (fn) => (sock, m, cmdArgs) => fn(km.buatCtx(sock, m, cmdArgs))

module.exports = {
  daily: bungkus(daily),
  claim: bungkus(claim),
}
