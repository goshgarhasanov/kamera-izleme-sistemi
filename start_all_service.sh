#!/usr/bin/env bash
# Kamera İzləmə Sistemini başlat (bütün kameralar + yazılma + hərəkət)
echo "Kamera sistemi başladılır..."
sudo systemctl start kamera.service
sleep 3
if systemctl is-active --quiet kamera.service; then
  IP=$(ip -o -f inet addr show | awk '/scope global/ {print $4}' | cut -d/ -f1 | head -1)
  echo "✓ İşləyir"
  echo "  Bu kompüterdən : http://localhost:8088"
  echo "  Şəbəkədən      : http://${IP}:8088"
  echo "  Kameralar      : $(systemctl show -p MainPID --value kamera.service) (PID)"
else
  echo "✗ Başlamadı — loglar: sudo journalctl -u kamera.service -n 30"
fi
