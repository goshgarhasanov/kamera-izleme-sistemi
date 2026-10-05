#!/usr/bin/env bash
# Kamera İzləmə Sistemini dayandır (servis + qalan ffmpeg prosesləri)
echo "Kamera sistemi dayandırılır..."
sudo systemctl stop kamera.service
sleep 2
# servisdən qopmuş ola biləcək ffmpeg proseslərini təmizlə
for pid in $(pgrep -f "rtsp://.*@.*:554" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
if systemctl is-active --quiet kamera.service; then
  echo "✗ Hələ işləyir — yenidən cəhd: sudo systemctl stop kamera.service"
else
  echo "✓ Dayandırıldı (qalan ffmpeg: $(pgrep -x ffmpeg | wc -l))"
fi
