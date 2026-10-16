const { downloadMediaMessage } = require('@whiskeysockets/baileys')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const isMedia = (msg) => {
  if (!msg) return false
  if (msg.videoMessage || msg.audioMessage) return true
  const mt = msg.documentMessage?.mimetype || ''
  return mt.startsWith('video/') || mt.startsWith('audio/')
}

function ffmpegToMp3(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-i', input, '-vn',
      '-acodec', 'libmp3lame', '-b:a', '128k', output
    ])
    p.on('error', reject)
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg exit ' + c))))
  })
}

module.exports = async function tomp3(sock, m, args = []) {
  const jid = m.key.remoteJid
  const ctx = m.message?.extendedTextMessage?.contextInfo

  // target: pesan yang di-reply, atau pesan itu sendiri (media + caption .tomp3)
  let target = null
  if (ctx?.quotedMessage && isMedia(ctx.quotedMessage)) {
    target = {
      key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant },
      message: ctx.quotedMessage
    }
  } else if (isMedia(m.message)) {
    target = m
  }

  if (!target) {
    return sock.sendMessage(jid, {
      text: 'Reply video / VN / audio dengan *.tomp3*\nTambah *dokumen* untuk kirim sebagai file.'
    }, { quoted: m })
  }

  const asDoc = args.join(' ').toLowerCase().includes('dokumen')
  const tmp = path.join(os.tmpdir(), 'tomp3_' + Date.now())
  const inFile = tmp + '.in'
  const outFile = tmp + '.mp3'

  try {
    const buf = await downloadMediaMessage(target, 'buffer', {})
    fs.writeFileSync(inFile, buf)
    await ffmpegToMp3(inFile, outFile)
    const mp3 = fs.readFileSync(outFile)

    if (asDoc) {
      await sock.sendMessage(jid, {
        document: mp3, mimetype: 'audio/mpeg', fileName: 'audio.mp3'
      }, { quoted: m })
    } else {
      await sock.sendMessage(jid, {
        audio: mp3, mimetype: 'audio/mpeg', ptt: false
      }, { quoted: m })
    }
  } catch (e) {
    console.error('[tomp3]', e)
    await sock.sendMessage(jid, { text: 'Gagal konversi ke MP3.' }, { quoted: m })
  } finally {
    for (const f of [inFile, outFile]) fs.existsSync(f) && fs.unlinkSync(f)
  }
}
