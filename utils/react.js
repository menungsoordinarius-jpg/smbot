// utils/react.js - reaksi status di pesan perintah user
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
// (Command yang menangani errornya sendiri harus return false saat gagal,
// kalau tidak reaksi akhirnya tetap ✅.)
async function withReaction(sock, m, task, startEmoji = '⏳') {
  await react(sock, m, startEmoji)
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

// ---------- reaksi mengikuti proc.update ----------
// Bungkus objek proses dari createProcess (utils/process.js):
//   const proc = withProcessReact(createProcess(sock, m, true), sock, m)
// Setiap proc.update('⚙️ Memproses...', 50, true) otomatis memasang
// reaksi dari emoji pertama di label. Emoji yang sama berturut-turut
// tidak dikirim ulang.
//
// Reaksi AKHIR (✅ / ❌ / hapus setelah 5 detik) tetap milik withReaction,
// supaya tidak ada dua pihak yang saling menimpa. Karena itu command harus
// mengembalikan false kalau gagal (lihat catatan di withReaction).
// Kalau command TIDAK dibungkus withReaction, pakai final = true agar
// done() -> ✅ dan fail() -> ❌ dipasang di sini.

const EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?/u

function withProcessReact(proc, sock, m, final = false) {
  let last = ''

  async function set(emoji) {
    if (!emoji || emoji === last) return
    last = emoji
    await react(sock, m, emoji)
  }

  async function finish(emoji) {
    if (!final) return
    await set(emoji)
    setTimeout(() => react(sock, m, ''), CLEAR_AFTER_MS)
  }

  return {
    async update(label, p, force) {
      const hit = String(label).match(EMOJI_RE)
      await set(hit ? hit[0] : '')
      return proc.update(label, p, force)
    },
    download(...args) {
      return proc.download ? proc.download(...args) : undefined
    },
    async done() {
      await finish('✅')
      return proc.done()
    },
    async fail(text) {
      await finish('❌')
      return proc.fail(text)
    },
  }
}

module.exports = { withReaction, react, withProcessReact }
