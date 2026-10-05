# Kamera İzləmə Sistemi (NVR)

Multi-camera NVR / surveillance web application for Uniview / Uniarch (ONVIF) IP cameras.
Pure Node.js backend (no external runtime deps except Express), vanilla JS single-page frontend, fully in Azerbaijani.

## Features

- **Multi-camera** — add/edit/remove cameras from the UI, each runs independently 24/7
- **Multi-view** — all cameras at once, click a tile to open full-size; auto-reconnect on drop
- **Live view** — low-latency MJPEG, HD toggle, real-time connection status, snapshot
- **Recording** — modes: continuous / motion-only / off (per camera), auto-segmented
- **Motion detection** — region-based (ignores small objects like leaves), configurable sensitivity & min object size
- **Pre-record ring buffer** — motion clips include ~5s *before* the event (no startup delay) + 30s after
- **AI object recognition** — DETR (transformers.js) in the browser: person / cat / dog / car … with labeled boxes
- **Events timeline** — unified chronological feed of all motion photos + clips, with thumbnails
- **DVR** — hour-by-hour past playback with real timestamps
- **PTZ** — pan / tilt / zoom (ONVIF ContinuousMove) + presets (LAPI)
- **Two-way audio** — real-time push-to-talk to the camera speaker (RTSP backchannel, G.711)
- **Sounds** — upload / record / download from YouTube (auto-trim to ≤6s), play on PC or camera, repeat N times
- **Image settings** — brightness / contrast / saturation / sharpness (ONVIF Imaging)
- **Camera tools** — device info, time sync, reboot, network info
- **Auto cleanup** — deletes old media (age / free-space based)
- **WhatsApp share** — on-the-fly H.264 conversion for compatibility
- **Hash routing**, orange/gold dark theme, fully responsive, collapsible sidebar

## Run

```bash
cd web
npm install          # express
node server.js       # http://localhost:8088
```

### 24/7 (systemd)

`start_all_service.sh` / `stop_all_service.sh` manage the `kamera.service` unit (auto-start on boot, auto-restart on crash).

## Configuration

Cameras are stored in `cameras.json` (git-ignored, contains credentials). Add cameras from **Settings → Cameras** in the UI. Media is stored under `media/<cameraId>/`.

Requires `ffmpeg`, `ffprobe` and (for YouTube) `yt-dlp` on the host.

## Developed by

Goshgar Hasanzadeh — https://facebook.com/hasnaov
