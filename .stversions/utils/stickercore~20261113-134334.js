// utils/stickercore.js - bagian bersama untuk .s (commands/sticker.js) dan .smeme (commands/smeme.js)
// Baileys + ffmpeg + libwebp (dwebp), tanpa sharp.
// Font teks meme: <folder bot>/assets/font/fontmeme.ttf (cadangan kalau smeme.js tidak mengirim font)
// Opsi font per teks dari smeme.js: topFont, bottomFont (path .ttf), topScale, bottomScale (1 = normal)
// Butuh: pkg install ffmpeg libwebp   dan   npm i node-webpmux

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
const MAX_VIDEO_SEC = 7 // fokus kualitas: durasi dibatasi 7 detik
const MAX_BYTES = 900 * 1024 // batas aman stiker animasi WhatsApp

// Butuh: npm i node-webpmux  (pure JS, aman di Termux)
const Webpmux = require('node-webpmux')
const { dumpWebpFrames, isAnimatedWebp } = require('./webpframes')

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

// path font untuk filter ffmpeg (titik dua perlu di-escape)
function fontOpt(fontPath) {
  const p = fontPath || FONT
  return p ? `fontfile=${String(p).replace(/:/g, '\\:')}:` : ''
}

function drawText(file, position, size, margin = 16, fontPath = null) {
  const y = position === 'top' ? String(margin) : `h-text_h-${margin}`
  return (
    `drawtext=${fontOpt(fontPath)}textfile=${file}:expansion=none:fontsize=${size}:` +
    `fontcolor=white:borderw=2:bordercolor=black:line_spacing=4:` +
    `x=(w-text_w)/2:y=${y}`
  )
}

// Ukuran teks stiker, diukur dari stiker Shirone bot (canvas 512x512):
//   tinggi huruf besar ~37px, jarak teks bawah ke tepi ~44px.
// Dengan font Changa One itu setara fontsize ~60. Font lain punya tinggi huruf
// berbeda, jadi sesuaikan dengan persen (mis. --anton -10%).
const STICKER_FONT_SIZE = 60
const STICKER_MARGIN_BOTTOM = 44
const STICKER_MARGIN_TOP = 44 // belum diukur dari Shirone, ubah kalau perlu
const STICKER_TEXT_WIDTH = 470 // lebar area teks (px)

// jumlah huruf per baris supaya teks tidak melebihi lebar stiker
const charsPerLine = (size) => Math.max(5, Math.floor(STICKER_TEXT_WIDTH / (size * 0.62)))

function buildFilter({
  full,
  top,
  bottom,
  tmpFiles,
  animated,
  alpha,
  fps,
  topFont,
  bottomFont,
  topScale = 1,
  bottomScale = 1
}) {
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
  const items = [
    ['top', top, topFont, topScale],
    ['bottom', bottom, bottomFont, bottomScale]
  ]
  for (const [pos, text, fontPath, scale] of items) {
    if (!text) continue
    const sc = scale || 1
    // ukuran dasar disamakan dengan Shirone; persen dari user mengalikan ukuran ini
    let size = Math.max(8, Math.round(STICKER_FONT_SIZE * sc))
    let wrapped = wrap(text, charsPerLine(size))
    // lebih dari 2 baris -> kecilkan sedikit supaya tidak menutupi gambar
    if (wrapped.split('\n').length > 2) {
      size = Math.max(8, Math.round(size * 0.77))
      wrapped = wrap(text, charsPerLine(size))
    }
    const tf = path.join(os.tmpdir(), `smeme_${Date.now()}_${pos}.txt`)
    fs.writeFileSync(tf, wrapped)
    tmpFiles.push(tf)
    const margin = pos === 'top' ? STICKER_MARGIN_TOP : STICKER_MARGIN_BOTTOM
    f.push(drawText(tf, pos, size, margin, fontPath))
  }
  return f.join(',')
}

async function toWebp(
  input,
  {
    animated,
    full,
    top,
    bottom,
    alpha,
    fps,
    inputArgs = [],
    topFont,
    bottomFont,
    topScale,
    bottomScale
  }
) {
  const out = path.join(os.tmpdir(), `stk_${Date.now()}.webp`)
  const tmpFiles = [out]
  try {
    const vf = buildFilter({
      full,
      top,
      bottom,
      tmpFiles,
      animated,
      alpha,
      fps,
      topFont,
      bottomFont,
      topScale,
      bottomScale
    })
    const base = fps || 15
    // kalau file terlalu besar: turunkan kualitas bertahap (fps tetap)
    const tiers = animated
      ? [
          { q: 45, f: base },
          { q: 30, f: base },
          { q: 20, f: base }
        ]
      : [{ q: 75, f: base }]
    let buf
    for (const t of tiers) {
      const args = ['-y', ...inputArgs, '-i', input]
      if (animated) args.push('-t', String(MAX_VIDEO_SEC))
      args.push(
        '-vf', animated ? `${vf},fps=${t.f}` : vf,
        '-an', '-vcodec', 'libwebp', '-q:v', String(t.q), '-loop', '0'
      )
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

// ukuran video/gambar (untuk menentukan besar font)
function probeSize(file) {
  return new Promise((resolve) =>
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      (err, out) => {
        if (err) return resolve({ w: 720, h: 720 })
        const [w, h] = String(out).trim().split('x').map(Number)
        resolve({ w: w || 720, h: h || 720 })
      }
    )
  )
}

// .smeme pada gambar/video/GIF: teks ditempel, hasilnya tetap berupa gambar/video (bukan stiker)
async function memeMedia(
  input,
  { type, top, bottom, topFont, bottomFont, topScale = 1, bottomScale = 1 }
) {
  const isVideo = type === 'video'
  const out = path.join(os.tmpdir(), `meme_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`)
  const tmpFiles = [out]
  try {
    const { w, h } = await probeSize(input)
    const sw = Math.min(w, 720)
    const sh = Math.round((h * sw) / w)
    const baseSize = Math.max(18, Math.round(Math.min(sw, sh) / 12))

    const f = ['scale=trunc(min(iw\\,720)/2)*2:-2']
    const items = [
      ['top', top, topFont, topScale],
      ['bottom', bottom, bottomFont, bottomScale]
    ]
    for (const [pos, text, fontPath, scale] of items) {
      if (!text) continue
      const size = Math.max(8, Math.round(baseSize * (scale || 1)))
      const margin = Math.round(size * 0.35)
      const maxChars = Math.max(6, Math.floor(sw / (size * 0.68)))
      const tf = path.join(os.tmpdir(), `smemem_${Date.now()}_${pos}.txt`)
      fs.writeFileSync(tf, wrap(text, maxChars))
      tmpFiles.push(tf)
      f.push(drawText(tf, pos, size, margin, fontPath))
    }

    const args = ['-y', '-i', input, '-vf', f.join(',')]
    if (isVideo) {
      args.push(
        '-t', '60',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'
      )
    } else {
      args.push('-frames:v', '1', '-q:v', '3')
    }
    args.push(out)
    await run(args)
    return { kind: isVideo ? 'video' : 'image', buffer: fs.readFileSync(out) }
  } finally {
    for (const t of tmpFiles) fs.existsSync(t) && fs.unlinkSync(t)
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

// dokumen (file) yang isinya gambar/video/GIF
function docType(message) {
  const d =
    message?.documentMessage ||
    message?.documentWithCaptionMessage?.message?.documentMessage
  const mime = d?.mimetype || ''
  if (/^image\/gif$/i.test(mime)) return { type: 'video', gif: true }
  if (/^video\//i.test(mime)) return { type: 'video', gif: false }
  if (/^image\/webp$/i.test(mime)) return null
  if (/^image\//i.test(mime)) return { type: 'image', gif: false }
  return null
}

// cari media: dari pesan yang di-reply, atau dari pesan itu sendiri (caption)
function findMedia(msg) {
  const m = msg.message || {}
  const ctx = m.extendedTextMessage?.contextInfo
  const q = ctx?.quotedMessage
  if (q) {
    const target = {
      key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
      message: q
    }
    if (q.imageMessage) return { type: 'image', animated: false, gif: false, target }
    if (q.videoMessage)
      return { type: 'video', animated: true, gif: !!q.videoMessage.gifPlayback, target }
    if (q.stickerMessage)
      return { type: 'sticker', animated: !!q.stickerMessage.isAnimated, gif: false, target }
    const qd = docType(q)
    if (qd) return { type: qd.type, animated: qd.type === 'video', gif: qd.gif, target }
  }
  if (m.imageMessage) return { type: 'image', animated: false, gif: false, target: msg }
  if (m.videoMessage)
    return { type: 'video', animated: true, gif: !!m.videoMessage.gifPlayback, target: msg }
  const d = docType(m)
  if (d) return { type: d.type, animated: d.type === 'video', gif: d.gif, target: msg }
  return null
}

function getBody(msg) {
  const m = msg.message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim()
}

// dipakai stickerpack.js: bikin satu stiker dari satu pesan media (gambar/video)
async function createSticker({
  target,
  type,
  full = false,
  pack = DEFAULT_PACK,
  author = DEFAULT_AUTHOR
}) {
  const rand = Math.random().toString(36).slice(2, 7)
  const input = path.join(os.tmpdir(), `in_${Date.now()}_${rand}.${type === 'video' ? 'mp4' : 'jpg'}`)
  try {
    const buffer = await downloadMediaMessage(target, 'buffer', {})
    fs.writeFileSync(input, buffer)
    const webp = await toWebp(input, {
      animated: type === 'video',
      full,
      top: '',
      bottom: '',
      alpha: false
    })
    return await addExif(webp, pack, author)
  } finally {
    if (fs.existsSync(input)) fs.unlinkSync(input)
  }
}

module.exports = {
  findMedia,
  getBody,
  addExif,
  toWebp,
  stickerToWebp,
  memeMedia,
  createSticker,
  DEFAULT_PACK,
  DEFAULT_AUTHOR
}
