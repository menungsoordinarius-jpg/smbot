// commands/smeme.js - perintah .smeme (teks meme)
//   .smeme teks                       -> teks di bawah
//   .smeme atas | bawah               -> teks atas dan bawah
//   .smeme atas |                     -> teks atas saja
//   .smeme --anton HALO | --impact DUNIA
//   .smeme --anton --10 HALO | --impact DUNIA --20   -> ukuran +10% / +20%
//   .smeme --anton --10- HALO         -> ukuran mengecil 10%
//   .smeme --20 HALO                  -> font default, ukuran +20%
// Font default diatur lewat DEFAULT_FONT_NAME di bawah.
// Hasil mengikuti jenis medianya: gambar -> gambar, video/GIF -> video/GIF, stiker -> stiker.
// Bisa dari gambar, video, GIF, stiker, dokumen gambar/video (reply, atau media dengan caption command)

const VERSION = '2026-10-29-r12-size-flag'
console.log('[smeme.js] dimuat, versi', VERSION)

const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  findMedia,
  getBody,
  addExif,
  stickerToWebp,
  memeMedia,
  DEFAULT_PACK,
  DEFAULT_AUTHOR
} = require('../../utils/stickercore')

// ---------- font ----------
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts')
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function listFonts() {
  try {
    return fs.readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf)$/i.test(f))
  } catch {
    return []
  }
}

// cocokkan nama tanpa huruf besar & simbol: "anton" cocok dengan Anton-Regular.ttf
function findFont(name) {
  const n = norm(name)
  const files = listFonts()
  // prioritas: nama persis dulu, baru yang diawali nama
  const f =
    files.find((x) => norm(path.parse(x).name) === n) ||
    files.find((x) => norm(path.parse(x).name).startsWith(n))
  return f ? path.join(FONT_DIR, f) : null
}

// ===== FONT DEFAULT =====
// Isi dengan nama font di assets/fonts/ (tanpa .ttf, huruf besar/kecil bebas).
// Contoh: 'anton' -> assets/fonts/Anton-Regular.ttf
// Kosongkan ('') untuk memakai font lama bawaan stickercore.
const DEFAULT_FONT_NAME = 'changaone'

function defaultFontPath() {
  return DEFAULT_FONT_NAME ? findFont(DEFAULT_FONT_NAME) : null
}

// "--anton --20 TEKS" / "--anton TEKS --20-" -> { text, fontPath, scale, missing }
//   --20  = ukuran +20%      --20-  = ukuran -20%
//   --default --20 TEKS -> pakai font default, hanya ubah ukuran
function parseSegment(seg) {
  let s = (seg || '').trim()
  let fontPath = null
  let missing = null
  let scale = 1

  // ukuran dibaca dulu: "--20" (besar) atau "--20-" (kecil), di posisi mana saja
  const sm = s.match(/(^|\s)--(\d+(?:\.\d+)?)(-?)(?=\s|$)/)
  if (sm) {
    const pct = parseFloat(sm[2]) * (sm[3] ? -1 : 1)
    scale = Math.min(3, Math.max(0.3, 1 + pct / 100))
    s = s.replace(sm[0], ' ').trim()
  }

  // lalu nama font: "--anton" / "--default"
  const fm = s.match(/(^|\s)--([A-Za-z][\w-]*)(?=\s|$)/)
  if (fm) {
    if (norm(fm[2]) === 'default') {
      fontPath = defaultFontPath() // boleh null -> font lama stickercore
    } else {
      fontPath = findFont(fm[2])
      if (!fontPath) missing = fm[2]
    }
    s = s.replace(fm[0], ' ').trim()
  }
  return { text: s, fontPath, scale, missing }
}

// pesan bantuan; daftar font dibaca langsung dari folder font
function buildHelp(title) {
  const fonts = listFonts().map((f) => '`--' + norm(path.parse(f).name) + '`')
  const fontLine = fonts.length ? fonts.join(', ') : '_(belum ada font di folder)_'
  return [
    `*${title}*`,
    '',
    'Kirim atau balas (reply) gambar, video, GIF, atau stiker dengan teks meme.',
    '',
    '*Format Teks:*',
    '`.smeme teks atas|teks bawah`',
    '> Gunakan tanda pemisah `|` untuk membedakan teks bagian atas dan bawah.',
    '> Jika tanpa pemisah, teks akan diletakkan di bagian bawah.',
    '> Untuk teks atas saja: `.smeme teks atas|`',
    '',
    '*Opsi Tambahan:*',
    '',
    '--namafont',
    '> Mengganti font teks. Tulis di depan teks yang ingin diubah.',
    '> Font tersedia: ' + fontLine,
    '> `--default` memakai font bawaan bot.',
    '> Teks atas dan bawah boleh memakai font berbeda.',
    '',
    '--20 atau --20-',
    '> Mengubah ukuran font. `--20` memperbesar 20%, `--20-` mengecilkan 20%.',
    '> Bebas ditaruh di depan atau di belakang teks, dengan atau tanpa `--namafont`.',
    '> Batas ukuran: -70% sampai +200%.',
    '',
    '*Hasil:*',
    '• Gambar → tetap gambar',
    '• Video / GIF → tetap video / GIF',
    '• Stiker → tetap stiker',
    '',
    '*Contoh Penggunaan:*',
    '`.smeme teks atas|teks bawah`',
    '`.smeme --anton halo dunia`',
    '`.smeme --20 aaduh`',
    '`.smeme --kanit --20 halo|--default dunia --10-`'
  ].join('\n')
}

// return true kalau berhasil, false kalau gagal / salah format
async function handleSmeme(sock, msg) {
  const match = getBody(msg).match(/^[.!#\/]smeme(?:\s+([\s\S]*))?$/i)
  if (!match) return false

  const arg = (match[1] || '').trim()
  const from = msg.key.remoteJid
  const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })

  const media = findMedia(msg)
  if (!media) {
    console.log(
      '[smeme] media tidak ketemu. pesan:',
      Object.keys(msg.message || {}),
      'quoted:',
      Object.keys(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {})
    )
    await reply(buildHelp('Media Belum Ditemukan'))
    return false
  }

  // format: .smeme teks | teks   (tanpa | -> teks di bawah)
  let T = { text: '', fontPath: null, scale: 1, missing: null }
  let B = { text: '', fontPath: null, scale: 1, missing: null }
  if (!arg.includes('|')) {
    B = parseSegment(arg)
  } else {
    const parts = arg.split('|')
    T = parseSegment(parts[0] || '')
    B = parseSegment(parts.slice(1).join('|'))
  }

  const bad = T.missing || B.missing
  if (bad) {
    const names = listFonts().map((f) => path.parse(f).name).join(', ') || '(kosong)'
    await reply(`Font *${bad}* tidak ditemukan.\nTersedia: ${names}`)
    return false
  }

  const top = T.text
  const bottom = B.text
  if (!top && !bottom) {
    await reply(buildHelp('Teks Belum Diisi'))
    return false
  }

  const fontOpts = {
    topFont: T.fontPath || defaultFontPath(),
    bottomFont: B.fontPath || defaultFontPath(),
    topScale: T.scale,
    bottomScale: B.scale
  }

  console.log(
    `[smeme] media=${media.type} animated=${media.animated} atas=${!!top} bawah=${!!bottom}`,
    `fontAtas=${fontOpts.topFont ? path.basename(fontOpts.topFont) : '-'} x${fontOpts.topScale}`,
    `fontBawah=${fontOpts.bottomFont ? path.basename(fontOpts.bottomFont) : '-'} x${fontOpts.bottomScale}`
  )

  const isSticker = media.type === 'sticker'
  const ext = media.type === 'video' ? 'mp4' : isSticker ? 'webp' : 'jpg'
  const input = path.join(os.tmpdir(), `in_${Date.now()}.${ext}`)
  let ok = false
  try {
    const buffer = await downloadMediaMessage(media.target, 'buffer', {})
    if (isSticker) {
      // stiker + .smeme -> tetap stiker, teks ditumpuk di atas gambar yang ada
      const webp = await stickerToWebp(buffer, input, {
        animated: media.animated,
        full: false,
        top,
        bottom,
        alpha: true,
        ...fontOpts
      })
      const finalSticker = await addExif(webp, DEFAULT_PACK, DEFAULT_AUTHOR)
      await sock.sendMessage(from, { sticker: finalSticker }, { quoted: msg })
    } else {
      // gambar/video/GIF/dokumen -> hasil tetap gambar/video, bukan stiker
      fs.writeFileSync(input, buffer)
      const r = await memeMedia(input, { type: media.type, top, bottom, ...fontOpts })
      await sock.sendMessage(
        from,
        r.kind === 'video' ? { video: r.buffer, gifPlayback: !!media.gif } : { image: r.buffer },
        { quoted: msg }
      )
    }
    ok = true
  } catch (e) {
    console.error('[smeme] GAGAL:', e.message)
    await reply(
      isSticker
        ? 'Gagal memproses stiker. Pastikan terpasang: pkg install ffmpeg libwebp'
        : 'Gagal menambahkan teks. Pastikan ffmpeg terpasang (pkg install ffmpeg).'
    )
  } finally {
    if (fs.existsSync(input)) fs.unlinkSync(input)
  }
  return ok
}

module.exports = { handleSmeme }
