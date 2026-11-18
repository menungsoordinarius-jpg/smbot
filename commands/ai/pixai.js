'use strict'
// Command .pixai <deskripsi>
// Urutan key: donor (sesuai klaim .claim per orang, internal bebas)
//             -> key pribadi pengirim (.setkey) -> pesan jatah habis

const km = require('../../utils/keyManager')

const SERVICE = 'pixai'
const MODEL_ID = '1648918127446573124'
const MAKS_PROMPT = 300
const COOLDOWN_USER_MS = 15 * 1000
const TIMEOUT_MS = 120 * 1000

const clients = new Map() // apiKey -> client
const cooldown = new Map() // sender -> waktu terakhir

function getClient(apiKey) {
  if (clients.has(apiKey)) return clients.get(apiKey)
  const mod = require('@pixai-art/client')
  const PixAIClient = mod.default || mod
  const client = new PixAIClient({ apiKey, webSocketImpl: require('ws') })
  clients.set(apiKey, client)
  return client
}

function denganTimeout(promise, ms) {
  let t
  const limit = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('Waktu habis saat membuat gambar')), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(t))
}

async function generateGambar(prompts, apiKey) {
  const client = getClient(apiKey)
  const proses = (async () => {
    const task = await client.generateImage({
      prompts,
      modelId: MODEL_ID,
      width: 512,
      height: 512,
    })
    const media = await client.getMediaFromTask(task)
    if (!media || Array.isArray(media)) throw new Error('Gambar tidak ditemukan')
    const buffer = await client.downloadMedia(media)
    return Buffer.from(buffer)
  })()
  return denganTimeout(proses, TIMEOUT_MS)
}

// Perkiraan: error karena key/kredit (bukan error biasa).
// Tes dulu dengan key salah, lihat pesan aslinya di log, lalu sesuaikan pola ini.
function isMasalahKey(err) {
  const teks = String((err && err.message) || err || '')
  return /credit|kredit|quota|insufficient|balance|not enough|unauthor|forbidden|api.?key|invalid.*token|\b40[123]\b/i.test(
    teks
  )
}

// Terlalu banyak permintaan (429): donor ditandai merah sementara, bukan key rusak
function isLimit(err) {
  const teks = String((err && err.message) || err || '')
  return /\b429\b|rate.?limit|too many requests|terlalu banyak/i.test(teks)
}

async function run(ctx) {
  const { sock, msg, from, sender, args, botNumber } = ctx
  const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
  const react = async (emoji) => {
    try {
      await sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
    } catch (e) {}
  }

  const prompt = (args || []).join(' ').trim()
  const internal = km.isInternal(sender, botNumber)

  // Tanpa deskripsi: tampilkan bantuan + sisa jatah
  if (!prompt) {
    const j = km.sisaJatah(SERVICE, sender, internal)
    const punya = !!km.keyPengguna(SERVICE, sender)
    return reply(
      '🎨 *PixAI*\n' +
        'Cara pakai: .pixai <deskripsi>\n' +
        'Contoh: .pixai 1girl, white hair, winter\n\n' +
        `Jatah donor kamu: ${j.sisa}/${j.total} (klaim lewat .daily)\n` +
        `Key pribadi: ${punya ? 'sudah diatur' : 'belum (kirim .setkey KEY di chat pribadi)'}`
    )
  }

  if (prompt.length > MAKS_PROMPT) {
    return reply(`Deskripsi terlalu panjang (maks ${MAKS_PROMPT} karakter).`)
  }

  const terakhir = cooldown.get(sender) || 0
  const sisaTunggu = COOLDOWN_USER_MS - (Date.now() - terakhir)
  if (sisaTunggu > 0) {
    return reply(`Tunggu ${Math.ceil(sisaTunggu / 1000)} detik lagi ya.`)
  }
  cooldown.set(sender, Date.now())

  await react('⏳')

  try {
    let hasil = null
    let sumber = ''

    // 1) Key donor
    for (const d of km.kandidatDonor(SERVICE, sender, internal)) {
      km.pakaiJatah(d.id, sender) // pesan jatah dulu
      try {
        hasil = await generateGambar(prompt, d.key)
        sumber = 'donor'
        break
      } catch (err) {
        km.kembalikanJatah(d.id, sender) // gagal = jatah tidak terpotong
        if (isLimit(err)) {
          console.error(`[pixai] donor ${d.id} kena limit:`, err.message)
          km.tandaiLimit(d.id) // merah di .daily
          continue // coba donor berikutnya
        }
        if (isMasalahKey(err)) {
          console.error(`[pixai] donor ${d.id} bermasalah:`, err.message)
          km.tandaiHabis(d.id)
          continue // coba donor berikutnya
        }
        throw err
      }
    }

    // 2) Key pribadi pengirim
    if (!hasil) {
      const own = km.keyPengguna(SERVICE, sender)
      if (!own) {
        await react('❌')
        return reply(
          '😔 Belum ada jatah donor yang bisa dipakai.\n' +
            'Cek *.daily* lalu klaim dengan *.claim <nama donor>*, ' +
            'atau pasang key sendiri di chat pribadi: *.setkey API_KEY_PIXAI_KAMU*'
        )
      }
      try {
        hasil = await generateGambar(prompt, own)
        sumber = 'sendiri'
      } catch (err) {
        if (isMasalahKey(err)) {
          await react('❌')
          return reply(
            'Key pribadimu ditolak atau kreditnya habis. Cek akun PixAI kamu, lalu atur ulang dengan .setkey.'
          )
        }
        throw err
      }
    }

    const j = km.sisaJatah(SERVICE, sender, internal)
    const info =
      sumber === 'donor'
        ? `Jatah donor tersisa: ${j.sisa}/${j.total}`
        : 'Memakai key pribadi kamu'

    await sock.sendMessage(
      from,
      { image: hasil, caption: `🎨 ${prompt}\n\n${info}` },
      { quoted: msg }
    )
    await react('✅')
  } catch (err) {
    console.error('[pixai] error:', err)
    await react('❌')
    return reply('Gagal membuat gambar, coba lagi nanti.')
  }
}

const command = (sock, m, cmdArgs) => run(km.buatCtx(sock, m, cmdArgs))

module.exports = { command, run, generateGambar }
