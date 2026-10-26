// utils/segdl.js
// Unduh file dengan beberapa koneksi paralel (HTTP Range), gaya IDM.
// Segmen yang putus dilanjutkan dari byte terakhir. Hasil: path file sementara.

const fs = require('fs');
const os = require('os');
const path = require('path');

const UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A065F) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// Cek ukuran file & apakah server mendukung Range
async function probe(url, headers) {
  const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' } });
  let size = 0, ranges = false;
  const cr = res.headers.get('content-range'); // "bytes 0-0/12345"
  if (res.status === 206 && cr) {
    size = parseInt(cr.split('/')[1], 10) || 0;
    ranges = size > 0;
  } else {
    size = parseInt(res.headers.get('content-length') || '0', 10);
  }
  await res.body?.cancel().catch(() => {});
  return { size, ranges };
}

// Unduh satu segmen, kalau putus lanjut dari posisi terakhir (resume)
async function getPart(url, headers, start, end, fd, retries = 4) {
  let pos = start;
  for (let t = 0; t <= retries; t++) {
    try {
      const res = await fetch(url, { headers: { ...headers, Range: `bytes=${pos}-${end}` } });
      if (res.status !== 206) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await fd.write(value, 0, value.length, pos);
        pos += value.length;
      }
      if (pos > end) return;
      throw new Error('koneksi terputus');
    } catch (e) {
      console.log(`[segdl] segmen ${start}-${end} gagal (${t + 1}):`, e.message);
      if (t === retries) throw e;
    }
  }
}

// Unduhan biasa (server tidak support Range / file kecil)
async function single(url, headers, fd) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  let pos = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await fd.write(value, 0, value.length, pos);
    pos += value.length;
  }
}

// Return: path file sementara (hapus sendiri setelah dipakai)
async function segDownload(url, { headers = {}, connections = 4, minSegment = 1024 * 1024 } = {}) {
  headers = { 'User-Agent': UA, ...headers };
  const file = path.join(os.tmpdir(), `smbot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = await fs.promises.open(file, 'w+');
  try {
    const { size, ranges } = await probe(url, headers);
    console.log('[segdl]', { size, ranges });

    if (!ranges || size < minSegment * 2) {
      await single(url, headers, fd);
    } else {
      const n = Math.min(connections, Math.floor(size / minSegment));
      const chunk = Math.ceil(size / n);
      await fd.truncate(size);
      await Promise.all(
        Array.from({ length: n }, (_, i) =>
          getPart(url, headers, i * chunk, Math.min(size - 1, (i + 1) * chunk - 1), fd)
        )
      );
    }
    await fd.close();
    return file;
  } catch (e) {
    await fd.close().catch(() => {});
    await fs.promises.unlink(file).catch(() => {});
    throw e;
  }
}

module.exports = { segDownload };
