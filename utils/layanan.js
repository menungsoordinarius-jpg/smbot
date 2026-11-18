'use strict'
// utils/layanan.js
// Daftar layanan yang memakai sistem key + klaim donor.
// Fitur apa pun (AI, downloader, dll.) cukup menambah SATU entri di sini.
//
//  contoh : contoh key yang ditampilkan di pesan bantuan
//  cek    : fungsi pengecek format key (true = valid)
//  gabung : (opsional) kalau key terdiri dari beberapa bagian, mis. "ID:TOKEN"
//
// Setelah menambah entri, perintah ini langsung bisa dipakai untuk layanan itu:
//   .setkey <layanan> <key>              (pengguna, chat pribadi)
//   .donor add <layanan> <id> | <key> | <batas> | <publik/privat>   (owner)
//   .daily / .claim <donor>              (otomatis menampilkan layanan baru)
// Di kode fitur, tinggal panggil km.denganKey('<layanan>', ctx, kerja).

module.exports = {
  pixai: {
    contoh: 'API_KEY_PIXAI_KAMU',
    cek: (k) => k.length >= 10 && k.length <= 200,
  },
  cloudflare: {
    contoh: 'ACCOUNT_ID:API_TOKEN',
    cek: (k) => /^[a-f0-9]{32}:\S{20,150}$/i.test(k),
    gabung: ':',
  },
  freeai: {
    contoh: 'sk-free-xxxxxxxx',
    cek: (k) => /^sk-free-\S{8,}$/i.test(k),
  },

  // Contoh menambah layanan baru (hapus tanda // untuk memakai):
  // downloader: {
  //   contoh: 'KEY_DOWNLOADER_KAMU',
  //   cek: (k) => k.length >= 10,
  // },
}
