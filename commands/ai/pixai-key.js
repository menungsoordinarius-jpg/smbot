'use strict'
// Command: .setkey  .delkey  .donor
// Semuanya hanya boleh di chat pribadi supaya key tidak terlihat orang lain.

const km = require('../../utils/keyManager')

const SERVICE = 'pixai'

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
          'Kalau key sudah terlanjur terkirim di grup, sebaiknya buat ulang key itu di PixAI.',
      })
    },
  }
}

async function setkey(ctx) {
  const { sender, args, isGroup } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()

  const key = (args || []).join('').trim()
  if (!key) return b.reply('Cara pakai: .setkey API_KEY_PIXAI_KAMU')
  if (key.length < 10 || key.length > 200) return b.reply('Format key tidak valid.')

  km.setKeyPengguna(SERVICE, sender, key)
  return b.reply(
    '✅ Key tersimpan. Hapus pesan yang berisi key itu dari chat kamu supaya aman.\n' +
      'Untuk menghapus key dari bot: .delkey'
  )
}

async function delkey(ctx) {
  const { sender, isGroup } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()
  const ada = km.hapusKeyPengguna(SERVICE, sender)
  return b.reply(ada ? '🗑️ Key kamu sudah dihapus.' : 'Kamu belum punya key tersimpan.')
}

const BANTUAN_DONOR =
  '*Pengaturan donor PixAI* (khusus pemilik)\n' +
  '.donor list\n' +
  '.donor add <id> | <key> | <batas per akun bot> | <publik/privat>\n' +
  '.donor on <id>\n' +
  '.donor off <id>\n' +
  '.donor batas <id> <angka>\n' +
  '.donor del <id>'

async function donor(ctx) {
  const { sender, args, isGroup, botNumber } = ctx
  const b = bantu(ctx)
  if (isGroup) return b.tolakDiGrup()
  if (!km.isInternal(sender, botNumber)) return b.reply('Perintah ini khusus pemilik bot.')

  const [sub, ...rest] = args || []
  const isi = rest.join(' ').trim()

  switch ((sub || '').toLowerCase()) {
    case 'list': {
      const daftar = km.daftarDonor(SERVICE)
      if (!daftar.length) return b.reply('Belum ada donor.')
      const teks = daftar
        .map((d) => {
          const status = !d.aktif ? 'nonaktif' : d.istirahat ? 'istirahat (key/kredit bermasalah)' : 'aktif'
          const pakai = Object.entries(d.terpakaiHariIni)
            .map(([bot, n]) => `${bot}: ${n}`)
            .join(', ') || '-'
          return (
            `• *${d.id}* — ${d.publik ? 'publik' : 'privat'}, batas ${d.batasPerAkunBot}/akun bot, ${status}\n` +
            `  key: ${d.key}\n  terpakai hari ini: ${pakai}`
          )
        })
        .join('\n')
      return b.reply(teks)
    }

    case 'add': {
      const [id, key, batasStr, mode] = isi.split('|').map((s) => s.trim())
      const batas = parseInt(batasStr, 10)
      if (!id || !key || !mode) return b.reply(BANTUAN_DONOR)
      if (!/^[a-z0-9_-]{2,30}$/i.test(id)) return b.reply('ID hanya huruf/angka/_/-, 2-30 karakter.')
      if (key.length < 10 || key.length > 200) return b.reply('Format key tidak valid.')
      if (!Number.isInteger(batas) || batas < 1 || batas > 100) return b.reply('Batas harus angka 1-100.')
      if (!['publik', 'privat'].includes(mode.toLowerCase())) return b.reply('Mode: publik atau privat.')
      try {
        km.tambahDonor(SERVICE, { id, key, batas, publik: mode.toLowerCase() === 'publik' })
      } catch (e) {
        return b.reply(e.message)
      }
      return b.reply(`✅ Donor *${id}* ditambahkan (${mode.toLowerCase()}, batas ${batas}/akun bot).`)
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
