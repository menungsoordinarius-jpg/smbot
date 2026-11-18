// commands/ai/song.js
// .song [detik] <deskripsi lagu>  -> bot membuat lagu AI lewat Free.ai, dikirim sebagai audio mp3
//
// Key  : memakai sistem keyManager (layanan "freeai"), urutan sama seperti pixai:
//        donor -> key pribadi pengirim -> pesan jatah habis
//        - key pribadi : .setkey freeai sk-free-xxxx   (chat pribadi)
//        - key donor   : .donor add freeai <id> | <key> | <batas per orang> | <publik/privat>
//                        pengguna klaim dulu: .daily lalu .claim <nama donor>
// Jatah: akun gratis Free.ai 30.000 token/hari (kira-kira 6 lagu) per key,
//        jadi batas donor sebaiknya kecil (mis. 2-3 per orang)
// Paket: tidak perlu install; ffmpeg (sudah terpasang) dipakai untuk mengubah hasil ke mp3

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { createProcess } = require('../../utils/process');
const { withProcessReact } = require('../../utils/react');
const km = require('../../utils/keyManager');

// Tampilkan pesan proses (bar progres) saat menunggu.
// Opsi: true | false
const SETTING_Tampilkan_Proses = true;

const SERVICE = 'freeai'; // harus sama dengan nama di pixai-key.js
const BASE = 'https://api.free.ai';
const DURASI_DEFAULT = 30; // detik
const DURASI_MIN = 10;
const DURASI_MAX = 60; // dibatasi supaya jatah harian tidak cepat habis
const MAKS_PROMPT = 300;
const COOLDOWN_MS = 30 * 1000; // jeda per pengirim
const POLL_MS = 3000; // cek status tiap 3 detik
const MAKS_TUNGGU_MS = 3 * 60 * 1000; // batas menunggu lagu jadi

const PESAN_HABIS =
  '😔 Belum ada jatah donor yang bisa dipakai.\n' +
  'Cek *.daily* lalu klaim dengan *.claim <nama donor>*, ' +
  'atau pasang key sendiri di chat pribadi: *.setkey freeai sk-free-xxxxxxxx*';

const cooldown = new Map(); // pengirim -> waktu terakhir
let sibuk = false; // hanya satu lagu diproses dalam satu waktu (hemat RAM HP)

// Error dengan pesan siap kirim ke WhatsApp (+ status HTTP kalau ada)
function galat(pesan, detail, status) {
  const err = new Error(detail || pesan);
  err.pesan = pesan;
  err.status = status;
  return err;
}

const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

function getQuotedText(m) {
  const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  return q?.conversation || q?.extendedTextMessage?.text || '';
}

function pesanError(status, detail) {
  const d = String(detail || '').toLowerCase();
  if (status === 402 || /token|quota|limit/.test(d)) return '❌ Jatah token harian Free.ai habis. Reset otomatis tiap hari, coba lagi nanti.';
  if (status === 401 || status === 403) return '❌ Key Free.ai ditolak. Cek key dengan .setkey freeai atau .donor list freeai.';
  if (status === 429) return '❌ Terlalu banyak permintaan ke Free.ai, tunggu sebentar lalu coba lagi.';
  if (status === 400 || status === 422) return '❌ Free.ai menolak permintaannya (format tidak cocok). Kirim pesan ini ke Sora supaya dicek.';
  return '❌ Free.ai sedang bermasalah, coba lagi nanti.';
}

// Satu panggilan ke API Free.ai (JSON), selalu ada batas waktu
async function panggil(alamat, method, body, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60 * 1000);
  try {
    const res = await fetch(BASE + alamat, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

// Nama field hasil dari Free.ai belum pasti, jadi alamat audio / base64 dicari otomatis
function kumpulkanUrl(obj, hasil = [], dalam = 0) {
  if (!obj || typeof obj !== 'object' || dalam > 4) return hasil;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && !/status|poll|callback|webhook|docs|image|cover|thumb/i.test(k)) {
      hasil.push({ k, v });
    } else if (v && typeof v === 'object') {
      kumpulkanUrl(v, hasil, dalam + 1);
    }
  }
  return hasil;
}

function cariUrl(data) {
  const semua = kumpulkanUrl(data);
  const pilih =
    semua.find((x) => /\.(mp3|wav|flac|ogg|m4a)(\?|$)/i.test(x.v)) ||
    semua.find((x) => /audio/i.test(x.k)) ||
    semua.find((x) => /url/i.test(x.k));
  return pilih ? pilih.v : null;
}

function cariBase64(obj, dalam = 0) {
  if (!obj || typeof obj !== 'object' || dalam > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > 1000 && /b64|base64|audio/i.test(k) && !/^https?:/i.test(v)) return v;
    if (v && typeof v === 'object') {
      const h = cariBase64(v, dalam + 1);
      if (h) return h;
    }
  }
  return null;
}

const jobIdDari = (data) => data.job_id || data.id || data.task_id || (data.result && data.result.job_id) || null;
const statusSelesai = (s) => /^(completed|complete|succeeded|success|done|finished)$/i.test(s);
const statusGagal = (s) => /^(failed|error|cancelled|canceled)$/i.test(s);

// Minta lagu ke Free.ai memakai satu key, hasilnya { url } atau { b64 }
async function buatLagu(prompt, durasi, key) {
  const { res, data } = await panggil('/v1/music/generate/', 'POST', { prompt, duration: durasi }, key);
  if (!res.ok) {
    const detail = (data && (data.error && (data.error.message || data.error) || data.detail || data.message)) || 'HTTP ' + res.status;
    console.log('[song]', res.status, JSON.stringify(detail).slice(0, 200));
    throw galat(pesanError(res.status, JSON.stringify(detail)), 'HTTP ' + res.status, res.status);
  }

  let url = cariUrl(data);
  let b64 = cariBase64(data);
  console.log('[song] respons awal:', res.status, JSON.stringify(data).slice(0, 400)); // DEBUG

  // Kalau hasilnya belum jadi, Free.ai memberi job_id -> cek statusnya berkala
  if (!url && !b64) {
    const id = jobIdDari(data);
    if (!id) {
      console.log('[song] respons tidak dikenali:', JSON.stringify(data).slice(0, 300));
      throw galat('❌ Respons Free.ai tidak dikenali, coba lagi nanti.', 'respons tidak dikenali');
    }
    const batas = Date.now() + MAKS_TUNGGU_MS;
    let tidakDikenal = 0; // berapa kali berturut-turut status "unknown"
    while (Date.now() < batas) {
      await tidur(POLL_MS);
      const st = await panggil(`/v1/status/${encodeURIComponent(id)}/`, 'GET', undefined, key);
      console.log('[song] poll', st.res.status, JSON.stringify(st.data).slice(0, 300)); // DEBUG
      if (!st.res.ok && st.res.status < 500) {
        throw galat(pesanError(st.res.status, ''), 'status HTTP ' + st.res.status, st.res.status);
      }
      if (!st.res.ok) continue; // server error sesaat, coba lagi
      const s = String(st.data.status || '');
      if (/^unknown$/i.test(s)) {
        tidakDikenal += 1;
        if (tidakDikenal >= 15) { // ±45 detik tanpa dikenali: berhenti, jangan menunggu 3 menit
          console.log('[song] status job tidak dikenal, berhenti menunggu');
          throw galat('❌ Free.ai tidak mengenali job lagunya (status unknown). Coba lagi nanti.', 'status unknown');
        }
      } else {
        tidakDikenal = 0;
      }
      if (statusGagal(s)) {
        console.log('[song] job gagal:', JSON.stringify(st.data).slice(0, 300));
        throw galat('❌ Free.ai gagal membuat lagunya, coba deskripsi lain.', 'job gagal');
      }
      url = cariUrl(st.data);
      b64 = cariBase64(st.data);
      if (url || b64 || statusSelesai(s)) break;
    }
  }
  if (!url && !b64) throw galat('❌ Lagu belum jadi setelah menunggu lama, coba lagi nanti.', 'timeout');
  return { url, b64 };
}

// Masalah key/kredit (bukan error biasa): key ditolak atau jatah Free.ai habis
const isMasalahKey = (e) => !!e && [401, 402, 403].includes(e.status);

// Urutan sama seperti pixai: donor (sesuai klaim) -> key pribadi pengirim.
// Jatah donor dipesan sebelum generate dan dikembalikan kalau gagal.
async function buatDenganKey(prompt, durasi, keyPribadi, donors, pengirimNomor) {
  // 1) Key donor
  for (const d of donors) {
    km.pakaiJatah(d.id, pengirimNomor);
    try {
      return { ...(await buatLagu(prompt, durasi, d.key)), key: d.key, sumber: 'donor' };
    } catch (e) {
      km.kembalikanJatah(d.id, pengirimNomor);
      if (e.status === 429) {
        console.error(`[song] donor ${d.id} kena limit:`, e.message);
        km.tandaiLimit(d.id); // merah di .daily
        continue; // coba donor berikutnya
      }
      if (isMasalahKey(e)) {
        console.error(`[song] donor ${d.id} bermasalah:`, e.message);
        km.tandaiHabis(d.id);
        continue; // coba donor berikutnya
      }
      throw e;
    }
  }

  // 2) Key pribadi pengirim
  if (!keyPribadi) {
    throw galat(PESAN_HABIS);
  }
  try {
    return { ...(await buatLagu(prompt, durasi, keyPribadi)), key: keyPribadi, sumber: 'sendiri' };
  } catch (e) {
    if (isMasalahKey(e)) {
      throw galat(
        '❌ Key pribadimu ditolak atau jatah Free.ai-mu habis. Cek akun Free.ai kamu, lalu atur ulang dengan .setkey freeai.',
        e.message
      );
    }
    throw e;
  }
}

// Simpan audio ke folder sementara, lalu ubah ke mp3 supaya pasti bisa diputar di WhatsApp
async function simpanAudio(hasil, dir) {
  let ext = '.wav';
  let buffer;
  if (hasil.url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90 * 1000);
    try {
      const headers = hasil.url.startsWith(BASE) ? { Authorization: `Bearer ${hasil.key}` } : {};
      const r = await fetch(hasil.url, { headers, signal: ctrl.signal });
      if (!r.ok) throw galat('❌ Gagal mengunduh hasil lagu dari Free.ai.', 'unduh HTTP ' + r.status);
      buffer = Buffer.from(await r.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    const m = hasil.url.match(/\.(mp3|wav|flac|ogg|m4a)(\?|$)/i);
    if (m) ext = '.' + m[1].toLowerCase();
  } else {
    buffer = Buffer.from(hasil.b64.replace(/^data:[^,]*,/, ''), 'base64');
  }

  const asal = path.join(dir, 'asal' + ext);
  fs.writeFileSync(asal, buffer);
  if (ext === '.mp3') return asal;

  const mp3 = path.join(dir, 'lagu.mp3');
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', asal, '-codec:a', 'libmp3lame', '-q:a', '4', mp3], { timeout: 120 * 1000 }, (err) =>
        err ? reject(err) : resolve()
      );
    });
    return mp3;
  } catch (e) {
    console.log('[song] ffmpeg gagal, kirim file asli:', e && e.message);
    return asal; // file asli tetap dikirim
  }
}

module.exports = async (sock, m, args) => {
  const jid = m.key.remoteJid;
  const balas = (text) => sock.sendMessage(jid, { text }, { quoted: m });

  // angka di depan = durasi (detik), sisanya deskripsi lagu
  const kata = [...(args || [])];
  let durasi = DURASI_DEFAULT;
  if (/^\d+$/.test(kata[0] || '')) {
    durasi = Math.min(DURASI_MAX, Math.max(DURASI_MIN, Number(kata.shift())));
  }
  const prompt = (kata.join(' ').trim() || getQuotedText(m).trim());

  const ctx = km.buatCtx(sock, m, args);
  const internal = km.isInternal(ctx.sender, ctx.botNumber);

  // ---------- validasi input (cukup balas pesan biasa) ----------
  if (!prompt) {
    const j = km.sisaJatah(SERVICE, ctx.sender, internal);
    const punya = !!km.keyPengguna(SERVICE, ctx.sender);
    await balas(
      'Cara pakai: .song [detik] <deskripsi lagu>\nContoh: .song lagu pop ceria tentang pagi hari\nContoh: .song 15 beat lo-fi santai\n\n' +
        `Jatah donor kamu: ${j.sisa}/${j.total} (klaim lewat .daily)\n` +
        `Key pribadi: ${punya ? 'sudah diatur' : 'belum (kirim .setkey freeai KEY di chat pribadi)'}`
    );
    return false;
  }
  if (prompt.length > MAKS_PROMPT) {
    await balas(`Deskripsi terlalu panjang (maks ${MAKS_PROMPT} karakter).`);
    return false;
  }
  if (sibuk) {
    await balas('Masih ada lagu yang sedang dibuat, tunggu sebentar ya.');
    return false;
  }

  // ---------- cek key tersedia (donor atau pribadi) ----------
  const keyPribadi = km.keyPengguna(SERVICE, ctx.sender);
  const donors = km.kandidatDonor(SERVICE, ctx.sender, internal);
  if (!donors.length && !keyPribadi) {
    await balas(PESAN_HABIS);
    return false;
  }

  const pengirim = m.key.fromMe ? 'me' : m.key.participant || jid;
  const sisaTunggu = COOLDOWN_MS - (Date.now() - (cooldown.get(pengirim) || 0));
  if (sisaTunggu > 0) {
    await balas(`Tunggu ${Math.ceil(sisaTunggu / 1000)} detik lagi ya.`);
    return false;
  }
  cooldown.set(pengirim, Date.now());

  // ---------- pesan proses ----------
  const proc = withProcessReact(
    createProcess(sock, m, SETTING_Tampilkan_Proses),
    sock,
    m
  );
  const gagal = async (teks) =>
    SETTING_Tampilkan_Proses
      ? proc.fail(teks)
      : sock.sendMessage(jid, { text: teks }, { quoted: m });

  sibuk = true;
  let dir = null;
  let ticker = null;
  try {
    await proc.update('🎵 Menyiapkan lagu...', 10, true);
    await proc.update('🎹 AI sedang membuat lagu...', 30, true);

    // bar naik pelan selama menunggu supaya tidak terlihat macet
    let pers = 30;
    ticker = setInterval(() => {
      pers = Math.min(pers + 3, 80);
      proc.update('🎹 AI sedang membuat lagu...', pers).catch(() => {});
    }, 4000);

    const hasil = await buatDenganKey(prompt, durasi, keyPribadi, donors, ctx.sender);
    clearInterval(ticker);
    ticker = null;

    await proc.update('⚙️ Memproses audio...', 85, true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'song-'));
    const file = await simpanAudio(hasil, dir);

    await proc.update('📤 Mengirim lagu...', 92, true);
    const j = km.sisaJatah(SERVICE, ctx.sender, internal);
    const info = hasil.sumber === 'donor' ? `Jatah donor tersisa: ${j.sisa}/${j.total}` : 'Memakai key pribadi kamu';
    await balas(`🎵 *${prompt}*\n⏱️ ±${durasi} detik\n${info}\n\n✦ ᴬᴵ Free.ai`);
    const mp3 = file.endsWith('.mp3');
    await sock.sendMessage(
      jid,
      { audio: { url: file }, mimetype: mp3 ? 'audio/mpeg' : 'audio/wav', fileName: mp3 ? 'lagu.mp3' : 'lagu.wav' },
      { quoted: m }
    );

    await proc.done();
    return true;
  } catch (e) {
    console.log('[song] error:', e && e.message);
    await gagal(
      e.pesan ||
        (e.name === 'AbortError'
          ? '❌ Waktu habis menunggu Free.ai, coba lagi.'
          : '❌ Gagal membuat lagu, coba lagi nanti.')
    );
    return false; // dibaca withReaction -> reaksi akhir ❌
  } finally {
    if (ticker) clearInterval(ticker);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    sibuk = false;
  }
};
