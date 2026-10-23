const path = require('path')
try { process.loadEnvFile(path.join(__dirname, '../../.env')) } catch {}

const MODEL = 'gemini-2.5-flash'
const MAX_HISTORY = 20
const SYSTEM = 'Kamu asisten WhatsApp yang ramah. Jawab singkat dan jelas, dengan bahasa yang dipakai pengguna.'

const sessions = new Map()   // key -> riwayat percakapan
const botMsgIds = new Set()  // id pesan yang dikirim bot (cegah loop)

const keyOf = (m) => {
  const jid = m.key.remoteJid
  const sender = m.key.fromMe ? 'me' : (m.key.participant || jid)
  return `${jid}|${sender}`
}

async function say(sock, jid, text) {
  const sent = await sock.sendMessage(jid, { text })
  if (sent?.key?.id) {
    botMsgIds.add(sent.key.id)
    if (botMsgIds.size > 200) botMsgIds.delete(botMsgIds.values().next().value)
  }
}

function isActive(m) {
  return sessions.has(keyOf(m))
}

// .ai gemini  /  .ai gemini end
async function command(sock, m, args) {
  console.log('[gemini] command', args)
  const jid = m.key.remoteJid
  const key = keyOf(m)
  const sub = (args[0] || '').toLowerCase()
  const isEnd = (args[1] || '').toLowerCase() === 'end'

  if (sub !== 'gemini') {
    return say(sock, jid, 'Pakai:\n.ai gemini → mulai mode AI\n.ai gemini end → akhiri')
  }
  if (isEnd) {
    const was = sessions.delete(key)
    return say(sock, jid, was ? 'Mode Gemini diakhiri ✅' : 'Mode Gemini memang belum aktif.')
  }
  if (!process.env.GEMINI_KEY) {
    return say(sock, jid, 'GEMINI_KEY belum diatur di file .env')
  }
  sessions.set(key, [])
  await say(sock, jid, 'Mode Gemini aktif ✅\nChat saja langsung. Ketik .ai gemini end untuk berhenti.')
}

// pesan biasa saat mode AI aktif
async function chat(sock, m, text) {
  console.log('[gemini] chat', text, '| aktif:', sessions.has(keyOf(m)), '| bot:', botMsgIds.has(m.key.id))
  if (botMsgIds.has(m.key.id)) return
  const history = sessions.get(keyOf(m))
  if (!history || !text?.trim()) return
  const jid = m.key.remoteJid

  history.push({ role: 'user', parts: [{ text }] })
  await sock.sendPresenceUpdate('composing', jid)

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: history
        })
      }
    )
    const data = await res.json()

    if (!res.ok) {
      console.log('[gemini]', res.status, JSON.stringify(data))
      history.pop()
      return say(sock, jid, res.status === 429
        ? 'Jatah Gemini sedang habis, coba lagi nanti.'
        : 'Gemini error, coba lagi.')
    }

    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim()
    if (!reply) {
      history.pop()
      return say(sock, jid, 'Gemini tidak memberi jawaban.')
    }

    history.push({ role: 'model', parts: [{ text: reply }] })
    while (history.length > MAX_HISTORY) history.splice(0, 2)
    await say(sock, jid, `${reply.slice(0, 4000)}\n✦ ᴬᴵ`)
  } catch (e) {
    console.log('[gemini]', e)
    history.pop()
    say(sock, jid, 'Gagal menghubungi Gemini.')
  } finally {
    sock.sendPresenceUpdate('paused', jid).catch(() => {})
  }
}

module.exports = { command, chat, isActive }
