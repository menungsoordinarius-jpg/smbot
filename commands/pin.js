const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
let session = { cookie: '', csrf: '', at: 0 }

async function getSession() {
  if (session.cookie && Date.now() - session.at < 30 * 60 * 1000) return session
  const res = await fetch('https://www.pinterest.com/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
  })
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const cookie = set.map(c => c.split(';')[0]).join('; ')
  const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || ''
  session = { cookie, csrf, at: Date.now() }
  return session
}

async function searchPinterest(query, retry = true) {
  const s = await getSession()
  const srcUrl = '/search/pins/?q=' + encodeURIComponent(query)
  const data = JSON.stringify({ options: { query, scope: 'pins', page_size: 25 }, context: {} })
  const url = 'https://www.pinterest.com/resource/BaseSearchResource/get/'
    + '?source_url=' + encodeURIComponent(srcUrl)
    + '&data=' + encodeURIComponent(data)

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*, q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.pinterest.com/',
      'X-Requested-With': 'XMLHttpRequest',
      'X-APP-VERSION': 'a1b2c3d',
      'X-Pinterest-AppState': 'active',
      'X-Pinterest-Source-Url': srcUrl,
      'X-Pinterest-PWS-Handler': 'www/search/[scope].js',
      'X-CSRFToken': s.csrf,
      'Cookie': s.cookie
    }
  })

  if (!res.ok) {
    if (retry) {
      session = { cookie: '', csrf: '', at: 0 } // paksa ambil cookie baru
      return searchPinterest(query, false)
    }
    throw new Error('Pinterest HTTP ' + res.status)
  }

  const json = await res.json()
  const results = json?.resource_response?.data?.results || []

  return results
    .map(r => {
      const img = r?.images?.orig?.url || r?.images?.['736x']?.url
      if (!img) return null
      const caption = (r.grid_title || r.title || r.description || '')
        .replace(/\s+/g, ' ').trim().slice(0, 200)
      const author = r.pinner?.username || r.pinner?.full_name || 'unknown'
      return { img, caption: caption || 'Tanpa caption', author }
    })
    .filter(Boolean)
}

async function handlePin(sock, m, text) {
  const jid = m.key.remoteJid
  const query = text.replace(/^\.pin\s*/i, '').trim()

  if (!query) {
    await sock.sendMessage(jid, { text: 'Contoh: .pin Naruto' }, { quoted: m })
    return false
  }

  const pins = await searchPinterest(query)
  if (!pins.length) {
    await sock.sendMessage(jid, { text: `Tidak ketemu hasil untuk "${query}".` }, { quoted: m })
    return false
  }

  const pin = pins[Math.floor(Math.random() * pins.length)]
  const caption = `📌 ${pin.caption}\n\n👤 @${pin.author}`
  await sock.sendMessage(jid, { image: { url: pin.img }, caption }, { quoted: m })
}

module.exports = { handlePin }
