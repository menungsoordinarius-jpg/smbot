// commands/stickerpack.js
// Pengguna kirim banyak foto (album) dengan caption `.s nama pack | author`
// -> bot membuat satu stiker untuk tiap foto, semuanya ber-watermark pack/author.
//
// Catatan: Baileys resmi (WhiskeySockets) belum punya fitur kirim "sticker pack"
// bawaan WhatsApp, jadi stiker dikirim satu per satu.
//
// Di index.js, panggil sebelum router command:
//   if (await handleAlbum(sock, m)) return;

const { normalizeMessageContent } = require('@whiskeysockets/baileys')
const { createSticker, DEFAULT_PACK, DEFAULT_AUTHOR } = require('../sticker')
const { withReaction } = require('../../utils/react')

const MAX_ITEMS = 20 // batas stiker per album
const IDLE_MS = 5000 // tunggu foto berikutnya (album opener tidak terbaca)
const IDLE_EXPECTED_MS = 15000 // tunggu maksimal kalau jumlah foto diketahui
const CMD = /^[.!#\/]s(?:\s+([\s\S]*))?$/i

const albums = new Map() // key: chat|parentId

function unwrap(msg) {
  try {
    return normalizeMessageContent(msg.message) || msg.message
  } catch (_) {
    return msg.message
  }
}

function parseArgs(arg) {
  let rest = (arg || '').trim()
  let full = false
  if (/^full(\s|$)/i.test(rest)) {
    full = true
    rest = rest.replace(/^full\s*/i, '')
  }
  let pack = DEFAULT_PACK
  let author = DEFAULT_AUTHOR
  if (rest) {
    const parts = rest.split('|')
    const p = (parts[0] || '').trim()
    const a = parts.slice(1).join('|').trim()
    if (p) pack = p.slice(0, 40)
    if (a) author = a.slice(0, 40)
  }
  return { full, pack, author }
}

function getEntry(from, parentId) {
  const key = `${from}|${parentId}`
  let e = albums.get(key)
  if (!e) {
    e = { key, from, items: [], expected: 0, cmd: undefined, trigger: null, timer: null }
    albums.set(key, e)
  }
  return e
}

function schedule(sock, entry) {
  clearTimeout(entry.timer)
  const complete = entry.expected > 0 && entry.items.length >= entry.expected
  const wait = complete ? 800 : entry.expected > 0 ? IDLE_EXPECTED_MS : IDLE_MS
  entry.timer = setTimeout(() => finalize(sock, entry.key), wait)
}

async function finalize(sock, key) {
  const entry = albums.get(key)
  if (!entry) return
  albums.delete(key)
  clearTimeout(entry.timer)
  if (entry.cmd === undefined || !entry.trigger || !entry.items.length) return // tidak ada perintah .s

  const { full, pack, author } = parseArgs(entry.cmd)
  const items = entry.items.slice(0, MAX_ITEMS)
  const from = entry.from

  await withReaction(sock, entry.trigger, async () => {
    const note = entry.items.length > MAX_ITEMS ? ` (dibatasi ${MAX_ITEMS})` : ''
    await sock.sendMessage(
      from,
      { text: `Membuat stiker pack *${pack}*, ${items.length} stiker${note}...` },
      { quoted: entry.trigger }
    )
    let ok = 0
    let fail = 0
    for (const it of items) {
      try {
        const buf = await createSticker({ target: it.msg, type: it.type, full, pack, author })
        await sock.sendMessage(from, { sticker: buf })
        ok++
      } catch (e) {
        fail++
        console.error('[stickerpack]', e.message)
      }
    }
    await sock.sendMessage(from, {
      text: fail
        ? `Selesai: ${ok} stiker terkirim, ${fail} gagal.`
        : `Selesai: ${ok} stiker pack *${pack}*.`
    })
    return ok > 0
  })
}

// return true kalau pesan ini bagian dari album dan sudah ditangani di sini
async function handleAlbum(sock, msg) {
  const content = unwrap(msg)
  if (!content) return false
  const from = msg.key.remoteJid

  // pembuka album: memberi tahu jumlah foto/video yang akan datang
  if (content.albumMessage) {
    const entry = getEntry(from, msg.key.id)
    entry.expected =
      (content.albumMessage.expectedImageCount || 0) + (content.albumMessage.expectedVideoCount || 0)
    schedule(sock, entry)
    return true
  }

  const type = content.imageMessage ? 'image' : content.videoMessage ? 'video' : null
  const parentId = content.messageContextInfo?.messageAssociation?.parentMessageKey?.id
  if (!type || !parentId) return false

  const entry = getEntry(from, parentId)
  entry.items.push({ msg, type })

  const caption = (content.imageMessage?.caption || content.videoMessage?.caption || '').trim()
  const match = caption.match(CMD)
  if (match) {
    entry.cmd = match[1] || ''
    entry.trigger = msg
  }
  schedule(sock, entry)

  // caption command lain (bukan .s) dibiarkan ke router biasa
  return !caption || !!match
}

module.exports = { handleAlbum }
