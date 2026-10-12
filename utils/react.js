// commands/react.js - reaksi status di pesan perintah user
// ⏳ saat diproses -> ✅ kalau berhasil (❌ kalau gagal) -> hilang setelah 5 detik

console.log('[react.js] dimuat')
const CLEAR_AFTER_MS = 5000

async function react(sock, m, emoji) {
  try {
    await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } })
  } catch (e) {
    console.error('[react] gagal kirim', emoji, '->', e.message)
  }
}

// task: fungsi async yang menjalankan handler.
// Dianggap gagal kalau melempar error atau mengembalikan false.
async function withReaction(sock, m, task) {
  await react(sock, m, '⏳')
  let ok = true
  try {
    const result = await task()
    if (result === false) ok = false
  } catch (e) {
    ok = false
    console.error('[command]', e)
  }
  await react(sock, m, ok ? '✅' : '❌')
  setTimeout(() => react(sock, m, ''), CLEAR_AFTER_MS) // '' = hapus reaksi
}

module.exports = { withReaction }
