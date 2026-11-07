// commands/ai/flux.js
// .flux <deskripsi>  -> bot membuat gambar dengan FLUX.1 schnell lewat Cloudflare Workers AI
//
// Key  : tidak lagi di .env. Pakai sistem yang sama dengan PixAI (utils/keyManager.js):
//        donor    -> .donor add cloudflare <id> | <ACCOUNT_ID:API_TOKEN> | <batas> | <publik/privat>
//        pribadi  -> .setkey cloudflare ACCOUNT_ID:API_TOKEN   (chat pribadi ke bot)
// Urutan: donor yang layak dulu -> kalau habis/ditolak, key pribadi pengirim -> kalau tidak ada, pesan kuota habis.
// Jatah : gratis 10.000 neuron per hari per akun Cloudflare, reset otomatis jam 07:00 WIB (00:00 UTC)
// Paket : tidak perlu install apa pun (pakai fetch bawaan Node).

const { createProcess } = require('../../utils/process');
const { withProcessReact } = require('../../utils/react');
const km = require('../../utils/keyManager');

// ---------- SETTING (dibaca .settings) ----------
// Tampilkan pesan proses (bar progres) saat menunggu.
// Opsi: true | false
const SETTING_Tampilkan_Proses = true;

const SERVICE = 'cloudflare';
const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const STEPS = 4; // 1-8, makin besar makin bagus tapi makin boros jatah
const MAKS_PROMPT = 1000;
const COOLDOWN_MS = 10 * 1000; // jeda per pengirim (menjaga jatah harian)
const TIMEOUT_MS = 90 * 1000;

const cooldown = new Map(); // pengirim -> waktu terakhir

// Error dengan pesan siap kirim ke WhatsApp
function galat(pesan, detail) {
  const err = new Error(detail || pesan);
  err.pesan = pesan;
  return err;
}

function pesanError(status, kode, detail) {
  const d = String(detail || '').toLowerCase();
  if (kode === 4006 || /daily free allocation|neurons/.test(d)) return '❌ Jatah gratis harian Cloudflare habis. Reset otomatis jam 07:00 WIB, coba lagi nanti.';
  if (kode === 3030) return '❌ Deskripsi ditolak filter konten. Coba tulis lebih jelas atau ganti kata-katanya.';
  if (status === 401 || status === 403 || kode === 10000) return '❌ Token Cloudflare ditolak. Kalau memakai key sendiri, pasang ulang lewat chat pribadi: .setkey cloudflare ACCOUNT_ID:API_TOKEN';
  if (status === 404) return '❌ Account ID Cloudflare tidak ditemukan. Kalau memakai key sendiri, cek lagi: .setkey cloudflare ACCOUNT_ID:API_TOKEN';
  if (status === 429) return '❌ Terlalu banyak permintaan, tunggu sebentar lalu coba lagi.';
  return '❌ Cloudflare error, coba lagi nanti.';
}

// "ACCOUNT_ID:TOKEN" -> { accountId, token }
function pecahKey(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  return { accountId: s.slice(0, i), token: s.slice(i + 1) };
}

// Minta gambar ke Cloudflare, hasilnya { buffer, mime }
async function buatGambar(prompt, kred) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  let data;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${kred.accountId}/ai/run/${MODEL}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${kred.token}`,
        },
        body: JSON.stringify({ prompt, steps: STEPS }),
        signal: ctrl.signal,
      }
    );
    data = await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || data.success === false) {
    const e0 = data.errors && data.errors[0];
    const kode = e0 && e0.code;
    const detail = (e0 && e0.message) || 'HTTP ' + res.status;
    console.log('[flux]', res.status, kode, detail);
    const err = galat(pesanError(res.status, kode, detail), detail);
    // penanda untuk memilih donor berikutnya
    err.habis = kode === 4006 || /daily free allocation|neurons/i.test(detail);
    err.ditolak = res.status === 401 || res.status === 403 || res.status === 404 || kode === 10000;
    throw err;
  }

  const b64 = data.result && data.result.image;
  if (!b64) {
    console.log('[flux] respons tanpa gambar');
    throw galat('❌ Cloudflare tidak mengirim gambar. Coba lagi.', 'tanpa gambar');
  }
  const buffer = Buffer.from(b64, 'base64');
  const png = buffer[0] === 0x89 && buffer[1] === 0x50; // tanda file PNG
  return { buffer, mime: png ? 'image/png' : 'image/jpeg' };
}

// Donor dulu (jatah per akun bot dipesan sebelum generate, dikembalikan kalau gagal),
// lalu key pribadi pengirim.
async function buatDenganKunci(ctx, prompt) {
  const internal = km.isInternal(ctx.sender, ctx.botNumber);
  const donors = km.kandidatDonor(SERVICE, ctx.botNumber, internal);

  for (const d of donors) {
    km.pakaiJatah(d.id, ctx.botNumber);
    try {
      return await buatGambar(prompt, pecahKey(d.key));
    } catch (e) {
      km.kembalikanJatah(d.id, ctx.botNumber);
      if (e.habis || e.ditolak) {
        console.log('[flux] donor diistirahatkan:', d.id, e.habis ? '(jatah habis)' : '(key ditolak)');
        km.tandaiHabis(d.id);
        continue; // coba donor berikutnya
      }
      throw e;
    }
  }

  const milik = km.keyPengguna(SERVICE, ctx.sender);
  if (milik) return buatGambar(prompt, pecahKey(milik));

  throw galat(
    '❌ Jatah gambar gratis sedang habis.\n' +
      'Kamu bisa pasang key Cloudflare sendiri lewat *chat pribadi* ke bot:\n' +
      '.setkey cloudflare ACCOUNT_ID:API_TOKEN'
  );
}

module.exports = async (sock, m, args) => {
  const ctx = km.buatCtx(sock, m, args);
  const jid = ctx.from;
  const prompt = (args || []).join(' ').trim();
  const balas = (text) => sock.sendMessage(jid, { text }, { quoted: m });

  // ---------- validasi input (cukup balas pesan biasa) ----------
  if (!prompt) {
    await balas('Cara pakai: .flux <deskripsi gambar>\nContoh: .flux kucing oren memakai topi koki, gaya kartun');
    return false;
  }
  if (prompt.length > MAKS_PROMPT) {
    await balas(`Deskripsi terlalu panjang (maks ${MAKS_PROMPT} karakter).`);
    return false;
  }
  const pengirim = ctx.sender;
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

  let ticker = null;
  try {
    await proc.update('🎨 Menyiapkan permintaan...', 15, true);
    await proc.update('⚡ FLUX sedang membuat gambar...', 40, true);

    // bar naik pelan selama menunggu supaya tidak terlihat macet
    let pers = 40;
    ticker = setInterval(() => {
      pers = Math.min(pers + 5, 80);
      proc.update('⚡ FLUX sedang membuat gambar...', pers).catch(() => {});
    }, 3000);

    const hasil = await buatDenganKunci(ctx, prompt);
    clearInterval(ticker);
    ticker = null;

    await proc.update('⚙️ Memproses hasil...', 85, true);
    await proc.update('📤 Mengirim gambar...', 92, true);
    await sock.sendMessage(
      jid,
      { image: hasil.buffer, mimetype: hasil.mime, caption: `🎨 ${prompt}\n\n✦ ᴬᴵ FLUX` },
      { quoted: m }
    );

    await proc.done();
    return true;
  } catch (e) {
    console.log('[flux] error:', e && e.message);
    await gagal(
      e.pesan ||
        (e.name === 'AbortError'
          ? '❌ Waktu habis saat membuat gambar, coba lagi.'
          : '❌ Gagal membuat gambar, coba lagi nanti.')
    );
    return false; // dibaca withReaction -> reaksi akhir ❌
  } finally {
    if (ticker) clearInterval(ticker);
  }
};
