#!/usr/bin/env bash
echo "Memasang paket Termux..."
pkg install -y git ffmpeg || exit 1
command -v pm2 >/dev/null || npm i -g pm2
npm install || { echo "Gagal install dependensi."; exit 1; }

echo ""
read -p "Aktifkan Auto Update dari GitHub? (Y/N): " jawaban
case "$jawaban" in
  [yY]*)
    chmod +x autoupdate.sh
    if pm2 describe autoupdate >/dev/null 2>&1; then
      echo "Auto Update sudah aktif."
    else
      pm2 start autoupdate.sh --name autoupdate --interpreter bash && pm2 save
      echo "Auto Update aktif."
    fi ;;
  *) echo "Auto Update dilewati." ;;
esac

echo ""
echo "Selesai! Lanjut: node index.js (scan QR, Ctrl+C), lalu pm2 start index.js --name smbot && pm2 save"
