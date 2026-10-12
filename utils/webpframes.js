// utils/webpframes.js
// Memecah stiker WebP (statis / animasi) menjadi frame penuh berformat PAM (RGBA),
// supaya bisa dibaca ffmpeg walaupun decoder WebP ffmpeg bermasalah.
// Hanya butuh `dwebp` (pkg install libwebp). Penyusunan frame (blend/dispose) dilakukan di sini.

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const MAX_MS = 7500 // frame setelah ~7,5 detik dibuang
const MAX_FRAMES = 150

function chunksOf(buf) {
  const list = []
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    list.push({ id, start: pos + 8, size })
    pos += 8 + size + (size & 1)
  }
  return list
}

function isWebp(buf) {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
}

function isAnimatedWebp(buf) {
  return isWebp(buf) && chunksOf(buf).some((c) => c.id === 'ANMF')
}

function chunk(id, data) {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'ascii')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

// satu frame ANMF -> file WebP berdiri sendiri
function frameFile(buf, anmf, outPath) {
  const p = anmf.start
  const info = {
    x: buf.readUIntLE(p, 3) * 2,
    y: buf.readUIntLE(p + 3, 3) * 2,
    w: buf.readUIntLE(p + 6, 3) + 1,
    h: buf.readUIntLE(p + 9, 3) + 1,
    duration: buf.readUIntLE(p + 12, 3),
    dispose: buf[p + 15] & 1, // 1 = hapus ke transparan setelah tampil
    noBlend: (buf[p + 15] >> 1) & 1 // 1 = timpa, bukan blend
  }
  const subs = []
  let pos = p + 16
  const end = p + anmf.size
  while (pos + 8 <= end) {
    const id = buf.toString('ascii', pos, pos + 4)
    const sz = buf.readUInt32LE(pos + 4)
    subs.push({ id, data: buf.subarray(pos + 8, pos + 8 + sz) })
    pos += 8 + sz + (sz & 1)
  }
  const bits = subs.find((c) => c.id === 'VP8 ' || c.id === 'VP8L')
  if (!bits) throw new Error('frame WebP tidak punya data gambar')
  const alph = subs.find((c) => c.id === 'ALPH')

  let body
  if (bits.id === 'VP8L') {
    body = chunk('VP8L', bits.data)
  } else {
    const vp8x = Buffer.alloc(10)
    vp8x[0] = alph ? 0x10 : 0
    vp8x.writeUIntLE(info.w - 1, 4, 3)
    vp8x.writeUIntLE(info.h - 1, 7, 3)
    body = Buffer.concat([
      chunk('VP8X', vp8x),
      alph ? chunk('ALPH', alph.data) : Buffer.alloc(0),
      chunk('VP8 ', bits.data)
    ])
  }
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(4 + body.length, 4)
  riff.write('WEBP', 8, 'ascii')
  fs.writeFileSync(outPath, Buffer.concat([riff, body]))
  return info
}

function readPam(file) {
  const b = fs.readFileSync(file)
  const marker = b.indexOf('ENDHDR\n')
  if (marker < 0) throw new Error('PAM tidak valid')
  const hdr = b.toString('latin1', 0, marker)
  const w = +hdr.match(/WIDTH (\d+)/)[1]
  const h = +hdr.match(/HEIGHT (\d+)/)[1]
  const depth = +hdr.match(/DEPTH (\d+)/)[1]
  const raw = b.subarray(marker + 7)
  if (depth === 4) return { w, h, data: raw }
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    data[i * 4] = raw[j]
    data[i * 4 + 1] = raw[j + 1]
    data[i * 4 + 2] = raw[j + 2]
    data[i * 4 + 3] = 255
  }
  return { w, h, data }
}

function writePam(file, w, h, data) {
  const hdr = `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`
  fs.writeFileSync(file, Buffer.concat([Buffer.from(hdr, 'latin1'), Buffer.from(data)]))
}

// decoder bawaan: dwebp -> PAM
function dwebpDecode(inFile, outPam) {
  return new Promise((resolve, reject) =>
    execFile('dwebp', [inFile, '-pam', '-o', outPam], (err, _o, se) =>
      err ? reject(new Error('dwebp: ' + (se ? se.slice(-160) : err.message))) : resolve()
    )
  )
}

// tulis frame penuh ke dir sebagai f_0000.pam, f_0001.pam, ...
// return { animated, count, delays }
async function dumpWebpFrames(buf, dir, opts = {}) {
  const decode = opts.decode || dwebpDecode
  if (!isWebp(buf)) throw new Error('bukan file WebP')

  // statis: decode langsung
  if (!isAnimatedWebp(buf)) {
    const src = path.join(dir, 'src.webp')
    fs.writeFileSync(src, buf)
    await decode(src, path.join(dir, 'f_0000.pam'))
    return { animated: false, count: 1, delays: [] }
  }

  const chunks = chunksOf(buf)
  const vp8x = chunks.find((c) => c.id === 'VP8X')
  if (!vp8x) throw new Error('WebP animasi tanpa VP8X')
  const cw = buf.readUIntLE(vp8x.start + 4, 3) + 1
  const ch = buf.readUIntLE(vp8x.start + 7, 3) + 1

  const canvas = Buffer.alloc(cw * ch * 4) // mulai transparan
  const delays = []
  let prev = null
  let elapsed = 0
  let n = 0

  for (const anmf of chunks.filter((c) => c.id === 'ANMF')) {
    if (n >= MAX_FRAMES || elapsed >= MAX_MS) break

    // aturan dispose dari frame sebelumnya
    if (prev && prev.dispose) {
      for (let yy = prev.y; yy < Math.min(prev.y + prev.h, ch); yy++) {
        canvas.fill(0, (yy * cw + prev.x) * 4, (yy * cw + Math.min(prev.x + prev.w, cw)) * 4)
      }
    }

    const tmp = path.join(dir, `fr_${n}.webp`)
    const info = frameFile(buf, anmf, tmp)
    const outPam = path.join(dir, `fd_${n}.pam`)
    await decode(tmp, outPam)
    const img = readPam(outPam)
    fs.unlinkSync(tmp)
    fs.unlinkSync(outPam)

    for (let fy = 0; fy < img.h; fy++) {
      const cy = info.y + fy
      if (cy >= ch) break
      for (let fx = 0; fx < img.w; fx++) {
        const cx = info.x + fx
        if (cx >= cw) break
        const s = (fy * img.w + fx) * 4
        const d = (cy * cw + cx) * 4
        const sa = img.data[s + 3]
        if (info.noBlend || sa === 255) {
          canvas[d] = img.data[s]
          canvas[d + 1] = img.data[s + 1]
          canvas[d + 2] = img.data[s + 2]
          canvas[d + 3] = sa
        } else if (sa > 0) {
          const a = sa / 255
          const da = canvas[d + 3] / 255
          const oa = a + da * (1 - a)
          for (let k = 0; k < 3; k++) {
            canvas[d + k] = Math.round((img.data[s + k] * a + canvas[d + k] * da * (1 - a)) / oa)
          }
          canvas[d + 3] = Math.round(oa * 255)
        }
      }
    }

    writePam(path.join(dir, `f_${String(n).padStart(4, '0')}.pam`), cw, ch, canvas)
    const delay = info.duration || 66
    delays.push(delay)
    elapsed += delay
    prev = info
    n++
  }

  if (!n) throw new Error('tidak ada frame')
  return { animated: true, count: n, delays }
}

module.exports = { dumpWebpFrames, isAnimatedWebp }
