#!/usr/bin/env bash
# Uniview/Uniarch kameradan yerel RTSP ile surekli kayit.
# Saatlik parcalara boler, yeniden kodlamaz (CPU dostu), baglanti koparsa otomatik yeniden dener.
set -euo pipefail

cd "$(dirname "$0")"
set -a; source ./.env; set +a

# Paroladaki ozel karakterleri (# @ : / vb.) URL icin kodla
urlencode() {
  local s="$1" out="" c
  for ((i=0;i<${#s};i++)); do
    c="${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v h '%%%02X' "'$c"; out+="$h" ;;
    esac
  done
  printf '%s' "$out"
}

PASS_ENC="$(urlencode "$CAM_PASS")"
URL="rtsp://${CAM_USER}:${PASS_ENC}@${CAM_IP}:554/${CAM_PATH}"
OUT="videolar"
LOG="kayit.log"

ts(){ date '+%Y-%m-%d %H:%M:%S'; }
logline(){ echo "[$(ts)] $*" | tee -a "$LOG"; }

logline "Kayit basladi -> $OUT/ (kamera ${CAM_IP})"
while true; do
  logline "Kameraya baglaniliyor..."
  ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$URL" \
    -c:v copy -c:a aac -f segment -segment_time 300 -reset_timestamps 1 \
    -strftime 1 "$OUT/kamera_%Y-%m-%d_%H-%M-%S.mp4" 2>>"$LOG" \
    && logline "ffmpeg normal sonlandi" \
    || logline "Baglanti koptu, 5 sn sonra yeniden deneniyor..."
  sleep 5
done
