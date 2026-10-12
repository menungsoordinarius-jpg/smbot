// sticker.js - fitur stiker untuk smbot (Baileys + ffmpeg, tanpa sharp)
// Command:
//   .s            -> stiker 1:1 (crop tengah)
//   .s full       -> seluruh gambar masuk, sisa transparan
//   .s anime | by: sanny        -> pack "anime", author "by: sanny"
//   .s full anime | by: sanny   -> mode full + watermark pack/author
//   .smeme a | b  -> teks atas | teks bawah (crop tengah)
//   .smeme full a | b -> sama, tapi seluruh gambar masuk (tanpa crop)
//   (reply STIKER) .s anime | by: sanny -> ganti pack/author saja, gambar tidak diubah
//   (reply STIKER) .smeme a | b          -> teks ditambahkan di atas stiker itu
// Bisa dari gambar, video, GIF, atau stiker (reply media, atau kirim media dengan caption command)
// Butuh: pkg install ffmpeg
// Font teks meme: <folder bot>/assets/font/fontmeme.ttf (file ini ada di commands/, jadi path-nya ../assets/font)

const VERSION = '2026-10-12-r5'
console.log('[sticker.js] dimuat, versi', VERSION)

const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Font: pakai assets/font/fontmeme.ttf kalau ada, kalau tidak pakai font sistem Android
function findFont() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'font', 'fontmeme.ttf'),
    path.join(__dirname, 'font.ttf')
  ]
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c)
  try {
    const dir = '/system/fonts'
    const files = fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]+\.(ttf|otf)$/.test(f))
    const bad = /italic|mono|condensed|serif|emoji|symbol|light|thin/i
    const pick =
      files.find((f) => /roboto/i.test(f) && /bold/i.test(f) && !bad.test(f.replace(/bold/i, ''))) ||
      files.find((f) => /roboto/i.test(f) && !bad.test(f)) ||
      files.find((f) => !bad.test(f))
    if (pick) return path.join(dir, pick)
  } catch (_) {}
  return null
}
const FONT = findFont()
const MAX_VIDEO_SEC = 7
const MAX_BYTES = 900 * 1024 // batas aman stiker animasi WhatsApp

// Butuh: npm i node-webpmux  (pure JS, aman di Termux)
const Webpmux = require('node-webpmux')
const { dumpWebpFrames, isAnimatedWebp } = require('../utils/webpframes')

// Watermark default (nama pack & author) kalau user tidak mengisi
const DEFAULT_PACK = 'smbot'
const DEFAULT_AUTHOR = '@SannySebastianX'

// tempel metadata pack/author ke file WebP (yang tampil di WhatsApp)
async function addExif(buffer, pack, author) {
  const json = {
    'sticker-pack-id': require('crypto').randomBytes(16).toString('hex'),
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: ['']
  }
  const head = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ])
  const body = Buffer.from(JSON.stringify(json), 'utf-8')
  const exif = Buffer.concat([head, body])
  exif.writeUIntLE(body.length, 14, 4)

  const img = new Webpmux.Image()
  await img.load(buffer)
  img.exif = exif
  return await img.save(null)
}

const run = (args) =>
  new Promise((resolve, reject) =>
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 10 }, (err, _o, stderr) =>
      err ? reject(new Error(stderr ? stderr.slice(-300) : err.message)) : resolve()
    )
  )

// bungkus teks per baris supaya muat di 512px
function wrap(text, max = 18) {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) {
      if (line) lines.push(line)
      line = w
    } else line = (line + ' ' + w).trim()
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

function drawText(file, position, lineCount) {
  const size = lineCount > 2 ? 34 : 44
  const y = position === 'top' ? '16' : 'h-text_h-16'
  const font = FONT ? `fontfile=${FONT}:` : ''
  return (
    `drawtext=${font}textfile=${file}:expansion=none:fontsize=${size}:` +
    `fontcolor=white:borderw=2:bordercolor=black:line_spacing=4:` +
    `x=(w-text_w)/2:y=${y}`
  )
}

function buildFilter({ full, top, bottom, tmpFiles, animated, alpha, fps }) {
  const f = []
  if (alpha) f.push('format=rgba') // input stiker: jaga transparansi
  if (full) {
    f.push('scale=512:512:force_original_aspect_ratio=decrease')
    f.push('format=rgba')
    f.push('pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000')
  } else {
    f.push('crop=min(iw\\,ih):min(iw\\,ih)')
    f.push('scale=512:512')
  }
  for (const [pos, text] of [['top', top], ['bottom', bottom]]) {
    if (!text) continue
    const wrapped = wrap(text)
    const tf = path.join(os.tmpdir(), `smeme_${Date.now()}_${pos}.txt`)
    fs.writeFileSync(tf, wrapped)
    tmpFiles.push(tf)
    f.push(drawText(tf, pos, wrapped.split('\n').length))
  }
  if (animated) f.push(`fps=${fps || 15}`)
  return f.join(',')
}

async function toWebp(input, { animated, full, top, bottom, alpha, fps, inputArgs = [] }) {
  const out = path.join(os.tmpdir(), `stk_${Date.now()}.webp`)
  const tmpFiles = [out]
  try {
    const vf = buildFilter({ full, top, bottom, tmpFiles, animated, alpha, fps })
    const qualities = animated ? [45, 30, 20] : [75]
    let buf
    for (const q of qualities) {
      const args = ['-y', ...inputArgs, '-i', input]
      if (animated) args.push('-t', String(MAX_VIDEO_SEC))
      args.push('-vf', vf, '-an', '-vcodec', 'libwebp', '-q:v', String(q), '-loop', '0')
      if (!animated) args.push('-frames:v', '1')
      args.push(out)
      await run(args)
      buf = fs.readFileSync(out)
      if (!animated || buf.length <= MAX_BYTES) break
    }
    return buf
  } finally {
    for (const f of tmpFiles) fs.existsSync(f) && fs.unlinkSync(f)
  }
}

// baca durasi tiap frame dari WebP animasi (chunk ANMF), dalam ms
function webpFrameDelays(buf) {
  const delays = []
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'ANMF' && pos + 8 + 15 <= buf.length) delays.push(buf.readUIntLE(pos + 8 + 12, 3))
    pos += 8 + size + (size % 2)
  }
  return delays
}

// Stiker (statis & animasi) tidak dibaca langsung oleh decoder WebP ffmpeg, karena
// di Termux gagal. Frame dipecah dulu oleh utils/webpframes.js (butuh dwebp dari
// `pkg install libwebp`), lalu dirakit ulang dengan ffmpeg.
async function stickerToWebp(buffer, input, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk_'))
  const errors = []
  try {
    try {
      const info = await dumpWebpFrames(buffer, dir)
      // keanimasian ditentukan dari isi file (bukan flag isAnimated dari WhatsApp)
      if (!info.animated) {
        return await toWebp(path.join(dir, 'f_0000.pam'), { ...opts, animated: false })
      }
      const avg = info.delays.reduce((a, b) => a + b, 0) / info.delays.length
      const fps = Math.min(20, Math.max(5, Math.round(1000 / (avg || 66))))
      return await toWebp(path.join(dir, 'f_%04d.pam'), {
        ...opts,
        animated: true,
        fps,
        inputArgs: ['-framerate', String(fps), '-start_number', '0']
      })
    } catch (e) {
      errors.push('frames: ' + e.message)
    }

    // cadangan terakhir: ffmpeg membaca WebP langsung
    try {
      fs.writeFileSync(input, buffer)
      return await toWebp(input, { ...opts, animated: isAnimatedWebp(buffer) })
    } catch (e) {
      errors.push('ffmpeg(webp): ' + e.message)
    }
    throw new Error(errors.join(' | '))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// cari media: dari pesan yang di-reply, atau dari pesan itu sendiri (caption)
function findMedia(msg) {
  const m = msg.message || {}
  const ctx = m.extendedTextMessage?.contextInfo
  const q = ctx?.quotedMessage
  if (q) {
    const type = q.imageMessage
      ? 'image'
      : q.videoMessage
      ? 'video'
      : q.stickerMessage
      ? 'sticker'
      : null
    if (type) {
      return {
        type,
        animated: type === 'sticker' ? !!q.stickerMessage.isAnimated : type === 'video',
        target: {
          key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
          message: q
        }
      }
    }
  }
  if (m.imageMessage) return { type: 'image', animated: false, target: msg }
  if (m.videoMessage) return { type: 'video', animated: true, target: msg }
  return null
}

function getBody(msg) {
  const m = msg.message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim()
}

// return false kalau bukan command stiker ATAU gagal/salah pakai; true kalau berhasil (dipakai untuk reaksi ✅/❌)
async function handleSticker(sock, msg) {
  const body = getBody(msg)
  const match = body.match(/^[.!#\/](s|smeme)(?:\s+([\s\S]*))?$/i)
  if (!match) return false

  const cmd = match[1].toLowerCase()
  const arg = (match[2] || '').trim()
  const from = msg.key.remoteJid
  const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })

  const media = findMedia(msg)
  if (!media) {
    console.log(
      '[sticker] media tidak ketemu. pesan:',
      Object.keys(msg.message || {}),
      'quoted:',
      Object.keys(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || {})
    )
    await reply(
      cmd === 's'
        ? 'Reply gambar/video dengan *.s* (atau *.s full*). Reply stiker dengan *.s pack | author* untuk ganti watermark.'
        : 'Reply gambar/video/stiker dengan *.smeme teks atas | teks bawah*.'
    )
    return false
  }

  let full = false
  let top = ''
  let bottom = ''
  let pack = DEFAULT_PACK
  let author = DEFAULT_AUTHOR
  if (cmd === 's') {
    // format: .s [full] [nama pack] | [author]
    let rest = arg
    if (/^full(\s|$)/i.test(rest)) {
      full = true
      rest = rest.replace(/^full\s*/i, '')
    }
    if (rest) {
      const parts = rest.split('|')
      const p = (parts[0] || '').trim()
      const a = parts.slice(1).join('|').trim()
      if (p) pack = p.slice(0, 40)
      if (a) author = a.slice(0, 40)
    }
  } else {
    // format: .smeme [full] teks | teks
    let rest = arg
    if (/^full(\s|$)/i.test(rest)) {
      full = true
      rest = rest.replace(/^full\s*/i, '')
    }
    if (!rest) {
      await reply('Contoh: *.smeme halo | dunia* atau *.smeme full halo | dunia*')
      return false
    }
    if (!rest.includes('|')) {
      bottom = rest // tanpa | -> teks di bawah
    } else {
      const parts = rest.split('|')
      top = (parts[0] || '').trim()
      bottom = parts.slice(1).join('|').trim()
    }
    if (!top && !bottom) {
      await reply('Contoh: *.smeme halo | dunia*')
      return false
    }
  }

  console.log(`[sticker] cmd=${cmd} media=${media.type} animated=${media.animated} full=${full} atas=${!!top} bawah=${!!bottom}`)
  let ok = true
  const isSticker = media.type === 'sticker'
  const ext = media.type === 'video' ? 'mp4' : isSticker ? 'webp' : 'jpg'
  const input = path.join(os.tmpdir(), `in_${Date.now()}.${ext}`)
  try {
    const buffer = await downloadMediaMessage(media.target, 'buffer', {})
    let finalSticker
    if (isSticker && cmd === 's') {
      // reply stiker + .s -> hanya ganti watermark (pack/author), gambar tetap
      finalSticker = await addExif(buffer, pack, author)
    } else {
      const opts = { animated: media.animated, full, top, bottom, alpha: isSticker }
      let webp
      if (isSticker) {
        webp = await stickerToWebp(buffer, input, opts)
      } else {
        fs.writeFileSync(input, buffer)
        webp = await toWebp(input, opts)
      }
      finalSticker = await addExif(webp, pack, author)
    }
    await sock.sendMessage(from, { sticker: finalSticker }, { quoted: msg })
  } catch (e) {
    console.error('[sticker] GAGAL:', e.message)
    ok = false
    await reply(
      isSticker
        ? 'Gagal memproses stiker. Pastikan terpasang: pkg install ffmpeg libwebp'
        : 'Gagal membuat stiker. Pastikan ffmpeg terpasang (pkg install ffmpeg).'
    )
  } finally {
    if (fs.existsSync(input)) fs.unlinkSync(input)
  }
  return ok
}

module.exports = { handleSticker }
