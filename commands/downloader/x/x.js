const { execFile } = require('child_process')
const { promisify } = require('util')
const { react } = require('../../../utils/react')
const run = promisify(execFile)

const X_REGEX = /(?:twitter|x)\.com\/[^\/]+\/status\/(\d+)/i
const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const num = (n) => fmt.format(n || 0)
const check = (a = {}) => (a.verified || a.is_blue_verified ? ' ✓' : '')
const quote = (s) => s.split('\n').map(l => '> ' + l).join('\n')

// Komentar teratas = balasan langsung dengan like terbanyak (best-effort)
async function getTopComment(url, mainId) {
  try {
    const { stdout } = await run(
      'gallery-dl',
      ['-j', '-o', 'conversations=true', '-o', 'text-tweets=true', url],
      { maxBuffer: 30 * 1024 * 1024, timeout: 30000 }
    )
    const replies = JSON.parse(stdout)
      .filter(x => x[0] === 3)
      .map(x => x[2])
      .filter(md => String(md.reply_id) === mainId && String(md.tweet_id) !== mainId)
    if (!replies.length) return null
    return replies.sort((a, b) => (b.favorite_count || 0) - (a.favorite_count || 0))[0]
  } catch {
    return null
  }
}

async function xDownloader(sock, m, args, detail = false) {
  const from = m.key.remoteJid
  const match = (args[0] || '').match(X_REGEX)

  if (!match) {
    await sock.sendMessage(from, { text: 'Contoh: .x https://x.com/user/status/123' }, { quoted: m })
    return false
  }

  const mainId = match[1]
  const url = 'https://' + match[0]

  try {
    const { stdout } = await run('gallery-dl', ['-j', url], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000
    })

    await react(sock, m, '⏳️')
    const items = JSON.parse(stdout).filter(x => x[0] === 3)
    if (!items.length) throw new Error('Tidak ada media')

    const meta = items[0][2]
    const author = meta.author || {}
    const text = (meta.content || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim()

    let caption
    if (detail) {
      const stats = [`♡ ${num(meta.favorite_count)}`]
      if (meta.view_count != null) stats.push(`➣ ${num(meta.view_count)}`)
      stats.push(`⌨︎ ${num(meta.reply_count)}`)

      let top = ''
      const c = await getTopComment(url, mainId)
      if (c) {
        const cText = (c.content || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim().slice(0, 200)
        const cAuthor = c.author || {}
        top =
          quote(
            `*Top Komentar*\n` +
            `*${cAuthor.nick || cAuthor.name}${check(cAuthor)}* @${cAuthor.name}\n` +
            cText
          ) + '\n'
      }

      caption =
        `𝕏 ${text}\n` +
        `\`${stats.join('    ')}\`\n` +
        top +
        `\n👤 *${author.nick || author.name}${check(author)}*  @${author.name}  • ${num(author.followers_count)} pengikut`
    } else {
      caption = `𝕏 ${text}\n\n👤 @${author.name}`
    }

    for (let i = 0; i < items.length; i++) {
      const [, mediaUrl, md] = items[i]
      const cap = i === 0 ? caption : ''
      const isGif = md.type === 'animated_gif'
      const isVideo = isGif || ['mp4', 'webm', 'm4v'].includes(md.extension)

      let content
      if (isGif) content = { video: { url: mediaUrl }, gifPlayback: true, mimetype: 'video/mp4', caption: cap }
      else if (isVideo) content = { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: cap }
      else content = { image: { url: mediaUrl }, caption: cap }

      await sock.sendMessage(from, content, { quoted: m })
    }
  } catch (e) {
    console.error(e)
    await sock.sendMessage(from, { text: 'Gagal mengambil media. Pastikan link valid dan tweet tidak private.' }, { quoted: m })
    return false
  }
}

module.exports = xDownloader
