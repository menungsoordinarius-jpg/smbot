#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
NAMA="$1"
[ -z "$NAMA" ] && { echo "Pemakaian: bash tambah-akun.sh NAMA"; exit 1; }

DIR="session_$NAMA"
PM2NAME="smbot-$NAMA"
pm2 describe "$PM2NAME" >/dev/null 2>&1 && { echo "$PM2NAME sudah ada."; exit 1; }

if [ ! -f "$DIR/creds.json" ]; then
  echo "Scan QR dengan WhatsApp akun ini. Setelah terhubung, tekan Ctrl+C."
  trap : INT
  SESSION_DIR="$DIR" node index.js
  trap - INT
fi

SESSION_DIR="$DIR" pm2 start index.js --name "$PM2NAME" --watch \
  --ignore-watch="session session_* data node_modules .git *.log temp_*"
pm2 save
echo "Selesai: $PM2NAME aktif."
