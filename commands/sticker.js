// commands/sticker.js - perintah .s (stiker + watermark)
//   .s                          -> stiker 1:1 (crop tengah)
//   .s full                     -> seluruh gambar masuk, sisa transparan
//   .s anime | by: sanny        -> pack "anime", author "by: sanny"
//   .s full anime | by: sanny   -> mode full + watermark
//   (reply STIKER) .s pack | author -> ganti pack/author saja, gambar tidak diubah
// Bisa dari gambar, video, GIF, dokumen gambar/video (reply, atau kirim media dengan caption command)

const VERSION = '2026-10-21-r10'
console.log('[sticker.js] dimuat, versi', VERSION)

const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  findMedia,
  getBody,
  addExif,
  toWebp,
  stickerToWebp,
  createSticker,
  DEFAULT_PACK,
  DEFAULT_AUTHOR
} = require('../utils/stickercore')

// return true kalau stiker berhasil dikirim, false kalau gagal / salah format
async function handleSticker(sock, msg) {
  const match = getBody(msg).match(/^[.!#\/]s(?:\s+([\s\S]*))?$/i)
  if (!match) return false

  const arg = (match[1] || '').trim()
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
      'Reply gambar/video dengan *.s* (atau *.s full*). Reply stiker dengan *.s pack | author* untuk ganti watermark.'
    )
    return false
  }

  // format: .s [full] [nama pack] | [author]
  let full = false
  let pack = DEFAULT_PACK
  let author = DEFAULT_AUTHOR
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

  console.log(`[sticker] .s media=${media.type} animated=${media.animated} full=${full}`)
  const isSticker = media.type === 'sticker'
  const ext = media.type === 'video' ? 'mp4' : isSticker ? 'webp' : 'jpg'
  const input = path.join(os.tmpdir(), `in_${Date.now()}.${ext}`)
  let ok = false
  try {
    const buffer = await downloadMediaMessage(media.target, 'buffer', {})
    let finalSticker
    if (isSticker) {
      // reply stiker + .s -> hanya ganti watermark (pack/author), gambar tetap
      finalSticker = await addExif(buffer, pack, author)
    } else {
      fs.writeFileSync(input, buffer)
      const webp = await toWebp(input, {
        animated: media.animated,
        full,
        top: '',
        bottom: '',
        alpha: false
      })
      finalSticker = await addExif(webp, pack, author)
    }
    await sock.sendMessage(from, { sticker: finalSticker }, { quoted: msg })
    ok = true
  } catch (e) {
    console.error('[sticker] GAGAL:', e.message)
    await reply('Gagal membuat stiker. Pastikan terpasang: pkg install ffmpeg libwebp')
  } finally {
    if (fs.existsSync(input)) fs.unlinkSync(input)
  }
  return ok
}

// createSticker & default watermark dipakai juga oleh commands/sticker/stickerpack.js
module.exports = { handleSticker, createSticker, DEFAULT_PACK, DEFAULT_AUTHOR }
