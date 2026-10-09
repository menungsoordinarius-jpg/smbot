#!/usr/bin/env bash

echo "Menginstall dependensi bot..."
if ! npm install; then
    echo "Gagal menginstall dependensi. Instalasi dibatalkan."
    exit 1
fi

echo ""
read -p "Apakah kamu ingin mengaktifkan Auto Update? (Y/N): " jawaban

case "$jawaban" in
    [yY][eE][sS]|[yY])
        if [ ! -f autopush.sh ]; then
            echo "File autopush.sh tidak ditemukan, Auto Update dilewati."
        elif pgrep -f autopush.sh > /dev/null; then
            echo "Auto Update sudah berjalan, tidak dijalankan ulang."
        else
            echo "Mengaktifkan Auto Update..."
            chmod +x autopush.sh
            nohup ./autopush.sh > autopush.log 2>&1 &
            sleep 1
            if pgrep -f autopush.sh > /dev/null; then
                echo "Auto Update berhasil diaktifkan di background!"
            else
                echo "Auto Update gagal jalan, cek autopush.log"
            fi
        fi
        ;;
    *)
        echo "Auto Update dilewati. Kamu bisa menyalakannya secara manual nanti."
        ;;
esac

echo ""
echo "Instalasi selesai!"
