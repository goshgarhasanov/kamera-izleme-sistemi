// Kamera İzləmə Sistemi - çox kameralı (təmiz Node.js, xarici asılılıq yoxdur)
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_ROOT = path.join(ROOT, 'media');
const SOUNDS_DIR = path.join(ROOT, 'sesler');
const CAMS_FILE = path.join(ROOT, 'cameras.json');
const ENV_FILE = path.join(ROOT, '.env');
const SRV_LOG = path.join(__dirname, 'server.log');
const PORT = process.env.PORT || 8088;
const START = Date.now();
const KINDS = ['videolar', 'hareket', 'hareket_video', 'resimler'];
try { fs.mkdirSync(MEDIA_ROOT, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); } catch (e) {}
function safeSound(name) { if (!name || !/^[\w\-. ]+$/.test(name) || name.includes('..')) return null; const p = path.join(SOUNDS_DIR, name); return p.startsWith(SOUNDS_DIR) ? p : null; }
function log(msg) { try { fs.appendFileSync(SRV_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {} }

// ---------- KAMERALAR (konfiq + miqrasiya) ----------
function loadEnv() {
  const env = {};
  try { for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) { if (line.trim().startsWith('#')) continue; const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].trim(); } } catch (e) {}
  return env;
}
let CAMS = [];
function saveCameras() { try { fs.writeFileSync(CAMS_FILE, JSON.stringify(CAMS, null, 2)); } catch (e) { log('cameras.json yazılmadı: ' + e.message); } }
function dirOf(cam, kind) { return path.join(MEDIA_ROOT, cam.id, kind); }
function ensureCamDirs(cam) { for (const k of KINDS) { try { fs.mkdirSync(dirOf(cam, k), { recursive: true }); } catch (e) {} } }
function normCam(c) { return { id: c.id, name: c.name || c.id, ip: c.ip, user: c.user || 'admin', pass: c.pass || '', motionSens: c.motionSens || '0.04', segTime: c.segTime || '3600', motionShots: c.motionShots || '1', recMode: c.recMode || 'continuous', motionMinSize: c.motionMinSize || 'medium' }; }
const MIN_AREA = { small: 2, medium: 10, large: 26 }; // 32x18 grid-də sərhəd qutusu hüceyrə sahəsi
function loadCameras() {
  if (fs.existsSync(CAMS_FILE)) { try { return JSON.parse(fs.readFileSync(CAMS_FILE, 'utf8')).map(normCam); } catch (e) { log('cameras.json pozuq: ' + e.message); } }
  // .env-dən miqrasiya + köhnə düz qovluqları media/cam1-ə köçür
  const e = loadEnv();
  const cam = normCam({ id: 'cam1', name: 'Kamera 1', ip: e.CAM_IP || '192.168.100.152', user: e.CAM_USER || 'admin', pass: e.CAM_PASS || '', motionSens: e.MOTION_SENS, segTime: e.SEG_TIME, motionShots: e.MOTION_SHOTS });
  ensureCamDirs(cam);
  for (const kind of KINDS) {
    const oldDir = path.join(ROOT, kind), newDir = dirOf(cam, kind);
    try { for (const f of fs.readdirSync(oldDir)) { try { const o = path.join(oldDir, f); if (fs.statSync(o).isFile()) fs.renameSync(o, path.join(newDir, f)); } catch (e) {} } } catch (e) {}
  }
  CAMS = [cam]; saveCameras(); log('cam1 .env-dən miqrasiya edildi'); return CAMS;
}
CAMS = loadCameras();
CAMS.forEach(ensureCamDirs);
function getCam(id) { return CAMS.find(c => c.id === id) || CAMS[0]; }
function newCamId() { let n = 1; while (CAMS.find(c => c.id === 'cam' + n)) n++; return 'cam' + n; }
const enc = s => encodeURIComponent(s || '');
const mainUrl = cam => `rtsp://${cam.user}:${enc(cam.pass)}@${cam.ip}:554/media/video1`;
const subUrl = cam => `rtsp://${cam.user}:${enc(cam.pass)}@${cam.ip}:554/media/video2`;

// ---------- KÖMƏKÇİLƏR ----------
function json(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) d = d.slice(0, 1e6); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); }); }
function safeName(cam, kind, ext, name) { if (!name || !new RegExp(`^[\\w\\-.]+\\.${ext}$`).test(name)) return null; const base = dirOf(cam, kind); const p = path.join(base, name); return p.startsWith(base) ? p : null; }
function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`; }
function parseDate(f, fb) { const m = f.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime() : fb; }
function listDir(cam, kind, ext, withReady) {
  const dir = dirOf(cam, kind);
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.' + ext)).map(f => {
      const st = fs.statSync(path.join(dir, f)); const o = { name: f, size: st.size, date: parseDate(f, st.mtimeMs) };
      if (withReady) o.ready = (Date.now() - st.mtimeMs) > 7000; return o;
    }).sort((a, b) => b.date - a.date);
  } catch (e) { return []; }
}
const durCache = {};
function probeDur(file) { return new Promise(r => { const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file]); let o = ''; ff.stdout.on('data', d => o += d); ff.on('close', () => r(parseFloat(o) || 0)); ff.on('error', () => r(0)); }); }
async function videosWithDur(cam, kind) {
  const list = listDir(cam, kind, 'mp4', true), toProbe = [];
  for (const r of list) { if (!r.ready) { r.dur = Math.max(0, (Date.now() - r.date) / 1000); r.live = true; continue; } const ck = cam.id + '/' + r.name + ':' + r.size; if (durCache[ck] != null) r.dur = durCache[ck]; else toProbe.push(r); }
  let i = 0; const worker = async () => { while (i < toProbe.length) { const r = toProbe[i++]; const ck = cam.id + '/' + r.name + ':' + r.size; durCache[ck] = await probeDur(path.join(dirOf(cam, kind), r.name)); r.dur = durCache[ck]; } };
  await Promise.all([worker(), worker(), worker(), worker()]); return list;
}
function batchDelete(cam, kind, ext, names, all, protect) {
  const dir = dirOf(cam, kind); let deleted = 0, failed = 0;
  const valid = n => safeName(cam, kind, ext, n);
  const targets = all ? (() => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.' + ext)); } catch (e) { return []; } })() : (names || []);
  for (const n of targets) { const p = valid(n); if (!p || !fs.existsSync(p)) { failed++; continue; } if (protect) { try { if (Date.now() - fs.statSync(p).mtimeMs < 8000) { failed++; continue; } } catch (e) {} } try { fs.unlinkSync(p); deleted++; } catch (e) { failed++; } }
  return { deleted, failed };
}
function camOnline(cam) { return new Promise(r => { const s = net.connect({ host: cam.ip, port: 554, timeout: 2000 }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); }); }

// ---------- YAZILMA (hər kamera) ----------
const recProcs = {}, recState = {}; // recState[id]={enabled,since}
function startRec(cam) {
  if (recProcs[cam.id]) return;
  recState[cam.id] = { enabled: true, since: Date.now() };
  const out = path.join(dirOf(cam, 'videolar'), 'kamera_%Y-%m-%d_%H-%M-%S.mp4');
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam),
    '-c:v', 'copy', '-c:a', 'aac', '-f', 'segment', '-segment_time', cam.segTime, '-reset_timestamps', '1', '-strftime', '1', out], { stdio: ['ignore', 'ignore', 'ignore'] });
  recProcs[cam.id] = ff;
  ff.on('exit', () => { recProcs[cam.id] = null; if (recState[cam.id] && recState[cam.id].enabled) setTimeout(() => { const c = getCam(cam.id); if (c) startRec(c); }, 5000); });
  ff.on('error', e => log(`[${cam.id}] yazılma xətası: ` + e.message));
  log(`[${cam.id}] yazılma başladı`);
}
function stopRec(cam) { recState[cam.id] = { enabled: false, since: null }; const ff = recProcs[cam.id]; if (ff) { try { ff.kill('SIGTERM'); } catch (e) {} recProcs[cam.id] = null; } log(`[${cam.id}] yazılma dayandırıldı`); }

// ---------- HƏRƏKƏT (hər kamera) ----------
const motionProcs = {}, clipProcs = {}, ringProcs = {}, mState = {}; // mState[id]={lastCapture,capturing,lastClip,prev}
const MW = 128, MH = 72, MGW = 32, MGH = 18, MCW = 4, MCH = 4, MOTION_COOLDOWN = 6000, CLIP_GAP = 30000, PRE_MS = 5000, POST_MS = 60000;
// ---------- PRE-RECORD RING (davamlı son ~40s bufer, gecikməsiz klip üçün) ----------
function ringDir(cam) { return path.join(dirOf(cam, 'hareket_video'), '.ring'); }
function startRing(cam) {
  if (ringProcs[cam.id]) return; const rd = ringDir(cam); try { fs.mkdirSync(rd, { recursive: true }); } catch (e) {}
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam),
    '-c:v', 'copy', '-c:a', 'aac', '-f', 'segment', '-segment_time', '2', '-segment_wrap', '20', '-reset_timestamps', '1', path.join(rd, 'r%03d.ts')], { stdio: ['ignore', 'ignore', 'ignore'] });
  ringProcs[cam.id] = ff;
  ff.on('exit', () => { ringProcs[cam.id] = null; const c = getCam(cam.id); if (c && c.recMode !== 'off') setTimeout(() => startRing(c), 5000); });
  ff.on('error', () => {});
}
function motionThresh(cam) { return Math.max(6, Math.min(60, Math.round((parseFloat(cam.motionSens) || 0.04) * 200))); }
function startMotion(cam) {
  if (motionProcs[cam.id]) return;
  const S = mState[cam.id] = mState[cam.id] || { lastCapture: 0, capturing: false, lastClip: 0 }; S.prev = null;
  const rd = ringDir(cam); try { fs.mkdirSync(rd, { recursive: true }); } catch (e) {}
  // TƏK bağlantı, iki çıxış: (1) hərəkət üçün gray kadrlar (2) pre-record ring segmentləri
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', subUrl(cam),
    '-map', '0:v', '-vf', `scale=${MW}:${MH},format=gray`, '-r', '5', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-f', 'segment', '-segment_time', '2', '-segment_wrap', '32', '-reset_timestamps', '1', path.join(rd, 'r%03d.ts')], { stdio: ['ignore', 'pipe', 'ignore'] });
  motionProcs[cam.id] = ff; let acc = Buffer.alloc(0); const FS = MW * MH; S.lastFrame = Date.now();
  ff.stdout.on('data', chunk => { S.lastFrame = Date.now(); acc = acc.length ? Buffer.concat([acc, chunk]) : chunk; while (acc.length >= FS) { const frame = Buffer.from(acc.subarray(0, FS)); acc = acc.subarray(FS); analyzeFrame(cam, frame); } });
  ff.on('exit', () => { motionProcs[cam.id] = null; setTimeout(() => { const c = getCam(cam.id); if (c) startMotion(c); }, 5000); });
  ff.on('error', e => log(`[${cam.id}] hərəkət xətası: ` + e.message));
}
function analyzeFrame(cam, frame) {
  const S = mState[cam.id];
  if (S.prev) {
    const th = motionThresh(cam), act = new Set();
    for (let cy = 0; cy < MGH; cy++) for (let cx = 0; cx < MGW; cx++) { let d = 0; for (let y = 0; y < MCH; y++) for (let x = 0; x < MCW; x++) { const idx = (cy * MCH + y) * MW + (cx * MCW + x); d += Math.abs(frame[idx] - S.prev[idx]); } if (d / (MCW * MCH) > th) act.add(cy * MGW + cx); }
    if (act.size >= 5) {
      const minA = MIN_AREA[cam.motionMinSize] || 10;
      const comps = motionComponents(act).filter(c => (c[2] - c[0]) * (c[3] - c[1]) >= minA); // kiçik cisimləri (yarpaq) at
      if (comps.length && comps.length <= 10) {
        const now = Date.now(), dyn = cam.motionShots === 'dynamic', cooldown = dyn ? 2500 : MOTION_COOLDOWN, shots = dyn ? 1 : Math.max(1, Math.min(20, parseInt(cam.motionShots) || 1));
        if (now - S.lastCapture > cooldown && !S.capturing) { S.lastCapture = now; captureMotion(cam, comps, shots); }
        recordMotionClip(cam);
      }
    }
  }
  S.prev = frame;
}
function motionComponents(act) {
  const comp = [], seen = new Set(), key = (x, y) => y * MGW + x;
  for (let y = 0; y < MGH; y++) for (let x = 0; x < MGW; x++) {
    if (!act.has(key(x, y)) || seen.has(key(x, y))) continue;
    const st = [[x, y]]; seen.add(key(x, y)); let x0 = x, y0 = y, x1 = x, y1 = y, n = 0;
    while (st.length) { const [cx, cy] = st.pop(); n++; x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < MGW && ny < MGH && act.has(key(nx, ny)) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); st.push([nx, ny]); } }); }
    if (n >= 3) comp.push([x0, y0, x1 + 1, y1 + 1]);
  }
  return comp;
}
function captureMotion(cam, comps, count = 1) {
  const S = mState[cam.id]; S.capturing = true;
  const SW = 2880, SH = 1620, sx = SW / MGW, sy = SH / MGH;
  const boxes = comps.slice(0, 10).map(([x0, y0, x1, y1]) => `drawbox=x=${Math.round(x0*sx)}:y=${Math.round(y0*sy)}:w=${Math.round((x1-x0)*sx)}:h=${Math.round((y1-y0)*sy)}:color=lime:t=8`).join(',');
  const n = Math.max(1, Math.min(20, count)); const dur = n <= 1 ? 1 : 5; const fps = n / dur; // bir keçiddə n kadr (bir bağlantı)
  const vf = (boxes ? boxes + ',' : '') + `fps=${fps}`;
  const base = `hr_${stamp()}`;
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam), '-t', String(dur), '-vf', vf, '-q:v', '2', path.join(dirOf(cam, 'hareket'), base + '-%02d.jpg')], { stdio: ['ignore', 'ignore', 'ignore'] });
  const done = () => { S.capturing = false; }; ff.on('exit', done); ff.on('error', done); setTimeout(done, (dur + 8) * 1000);
}
// hərəkət anında: ring-buferdən PRE + POST saniyələri birləşdir (gecikməsiz, hadisədən əvvəlki anlar daxil)
function recordMotionClip(cam) {
  const S = mState[cam.id];
  if (S.clipPending) return; // artıq klip yazılır (onsuz da bu dövrü əhatə edir) — yoxsa HƏR hərəkətdə yaz
  S.lastClip = Date.now(); S.clipPending = true;
  const T = Date.now(), fn = `hv_${stamp()}.mp4`, out = path.join(dirOf(cam, 'hareket_video'), fn);
  // birbaşa yazma fallback (ring boş/xarab olsa belə klip HƏMİŞƏ yaransın)
  const directRecord = () => {
    const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam), '-t', '30', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'ignore'] });
    ff.on('error', () => {});
  };
  setTimeout(() => {
    S.clipPending = false; const rd = ringDir(cam);
    let segs = [];
    try { segs = fs.readdirSync(rd).filter(f => f.endsWith('.ts')).map(f => ({ fp: path.join(rd, f), m: fs.statSync(path.join(rd, f)).mtimeMs })).filter(x => x.m >= T - PRE_MS && x.m <= Date.now() - 1500).sort((a, b) => a.m - b.m); } catch (e) {}
    if (segs.length < 2) { log(`[${cam.id}] ring boş — birbaşa yazma`); return directRecord(); } // fallback
    const list = path.join(os.tmpdir(), 'cc_' + cam.id + '_' + Date.now() + '.txt');
    try { fs.writeFileSync(list, segs.map(s => `file '${s.fp.replace(/'/g, "'\\''")}'`).join('\n')); } catch (e) { return directRecord(); }
    const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'ignore'] });
    const done = (code) => { try { fs.unlinkSync(list); } catch (e) {} try { if ((code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 10000)) directRecord(); } catch (e) {} };
    ff.on('exit', done); ff.on('error', () => done(1));
  }, POST_MS);
}
function startCam(cam) { ensureCamDirs(cam); if (cam.recMode !== 'off') startMotion(cam); if (cam.recMode === 'continuous') startRec(cam); }
// WATCHDOG: kamera axını donanda (ffmpeg çıxmır, sadəcə kilidlənir) prosesi öldür → exit handler yenidən qoşur.
// Həmçinin olmalı olan proses yoxdursa onu da bərpa edir. Hər 10s-də yoxlayır.
const FREEZE_MS = 25000;
function watchdog() {
  for (const cam of CAMS) {
    const c = getCam(cam.id); if (!c) continue;
    if (c.recMode === 'off') continue;
    const S = mState[cam.id], ff = motionProcs[cam.id];
    if (ff) {
      // proses var — kadr axını donubsa öldür (exit → avtomatik yenidən qoşulma)
      if (S && S.lastFrame && Date.now() - S.lastFrame > FREEZE_MS) {
        log(`[${cam.id}] axın dondu (${Math.round((Date.now() - S.lastFrame) / 1000)}s) — yenidən qoşulur`);
        try { ff.kill('SIGKILL'); } catch (e) {}
      }
    } else {
      // proses yoxdur, amma olmalıdır — bərpa et
      log(`[${cam.id}] hərəkət prosesi yoxdur — başladılır`);
      startMotion(c);
    }
    // davamlı rejim yazması qopmuşsa bərpa et
    if (c.recMode === 'continuous' && recState[cam.id] && recState[cam.id].enabled && !recProcs[cam.id]) {
      log(`[${cam.id}] davamlı yazma qopdu — yenidən başladılır`); startRec(c);
    }
  }
}
function stopCam(cam) { recState[cam.id] = { enabled: false, since: null }; for (const m of [recProcs, motionProcs, clipProcs, ringProcs]) { const ff = m[cam.id]; if (ff) { try { ff.kill('SIGKILL'); } catch (e) {} m[cam.id] = null; } } }
function restartCam(cam) { stopCam(cam); setTimeout(() => startCam(cam), 1500); }

// ---------- CANLI ----------
function liveVideo(req, res, cam, hd) {
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-cache', 'Connection': 'close' });
  const args = hd ? ['-nostdin', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam), '-f', 'mpjpeg', '-q:v', '4', '-r', '12', '-vf', 'scale=1280:-2', '-an', '-']
                  : ['-nostdin', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', subUrl(cam), '-f', 'mpjpeg', '-q:v', '6', '-r', '12', '-an', '-'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res); const k = () => { try { ff.kill('SIGKILL'); } catch (e) {} }; req.on('close', k); res.on('close', k); ff.on('error', () => { try { res.end(); } catch (e) {} });
}
function liveAudio(req, res, cam, g) {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', 'Connection': 'close' });
  const ff = spawn('ffmpeg', ['-nostdin', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', subUrl(cam), '-vn', '-af', `highpass=f=150,loudnorm=I=-11,volume=${g},alimiter=limit=0.97`, '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res); const k = () => { try { ff.kill('SIGKILL'); } catch (e) {} }; req.on('close', k); res.on('close', k); ff.on('error', () => { try { res.end(); } catch (e) {} });
}
function liveSnapshot(req, res, cam) {
  const ff = spawn('ffmpeg', ['-nostdin', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', subUrl(cam), '-frames:v', '1', '-f', 'mjpeg', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' }); ff.stdout.pipe(res); ff.on('error', () => { try { res.end(); } catch (e) {} });
}
function savePhoto(req, res, cam) {
  const fn = `foto_${stamp()}.jpg`;
  const ff = spawn('ffmpeg', ['-nostdin', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-i', mainUrl(cam), '-frames:v', '1', '-q:v', '2', path.join(dirOf(cam, 'resimler'), fn)], { stdio: ['ignore', 'ignore', 'ignore'] });
  ff.on('exit', c => json(res, { ok: c === 0, name: fn })); ff.on('error', () => json(res, { ok: false }, 500));
}

// ---------- SƏS GÖNDƏRMƏ (RTSP backchannel) ----------
function rtspDigest(cam, method, uri, realm, nonce) {
  const h1 = crypto.createHash('md5').update(`${cam.user}:${realm}:${cam.pass}`).digest('hex');
  const h2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
  const r = crypto.createHash('md5').update(`${h1}:${nonce}:${h2}`).digest('hex');
  return `Digest username="${cam.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${r}"`;
}
// davamlı backchannel sessiyası — real-time səs axını üçün (.write(pcmu), .close())
function openBackchannel(cam, onReady, onFail, opts = {}) {
  const base = `rtsp://${cam.ip}/media/video1`, bc = `rtsp://${cam.ip}/media/video1/backchannel`;
  const sock = net.connect(554, cam.ip); let cseq = 1, realm = null, nonce = null, session = null, stage = '', authed = false, closed = false, buf = '';
  let queue = Buffer.alloc(0), seq = Math.floor(Math.random() * 60000), ts = 0, ssrc = Math.floor(Math.random() * 1e9) >>> 0, timer = null, draining = false, drainCb = null;
  const authH = (m, u) => (realm && nonce) ? `Authorization: ${rtspDigest(cam, m, u, realm, nonce)}\r\n` : '';
  const wr = s => { try { sock.write(s); } catch (e) {} };
  const describe = () => { stage = 'describe'; wr(`DESCRIBE ${base} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${authH('DESCRIBE', base)}Require: www.onvif.org/ver20/backchannel\r\nAccept: application/sdp\r\n\r\n`); };
  const setup = () => { stage = 'setup'; wr(`SETUP ${bc} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${authH('SETUP', bc)}Require: www.onvif.org/ver20/backchannel\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`); };
  const play = () => { stage = 'play'; wr(`PLAY ${base} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${authH('PLAY', base)}Session: ${session}\r\nRequire: www.onvif.org/ver20/backchannel\r\n\r\n`); };
  sock.on('connect', describe);
  sock.on('data', d => {
    buf += d.toString('latin1'); if (!buf.includes('\r\n\r\n')) return; const s = buf; buf = '';
    if (s.includes(' 401') && !authed) { realm = (s.match(/realm="([^"]+)"/) || [])[1]; nonce = (s.match(/nonce="([^"]+)"/) || [])[1]; authed = true; return describe(); }
    if (!s.includes(' 200')) { if (stage !== 'streaming') { closed = true; try { sock.end(); } catch (e) {} if (onFail) onFail(); } return; }
    if (stage === 'describe') return setup();
    if (stage === 'setup') { session = (s.match(/Session:\s*([^;\r\n]+)/) || [])[1]; return play(); }
    if (stage === 'play') { stage = 'streaming'; startTimer(); if (onReady) onReady(); }
  });
  function startTimer() {
    timer = setInterval(() => {
      if (queue.length < 160) { if (draining) { clearInterval(timer); timer = null; const cb = drainCb; drainCb = null; close(); if (cb) cb(); } return; } // boşdursa: drenaj bitibsə bağla
      const chunk = queue.subarray(0, 160); queue = queue.subarray(160);
      const rtp = Buffer.alloc(172); rtp[0] = 0x80; rtp[1] = 0x00; rtp.writeUInt16BE(seq++ & 0xffff, 2); rtp.writeUInt32BE(ts >>> 0, 4); ts += 160; rtp.writeUInt32BE(ssrc, 8); chunk.copy(rtp, 12);
      const it = Buffer.alloc(176); it[0] = 0x24; it[1] = 0; it.writeUInt16BE(172, 2); rtp.copy(it, 4); wr(it);
    }, 20);
  }
  sock.on('error', () => { if (stage !== 'streaming' && onFail) onFail(); });
  const close = () => { if (closed) return; closed = true; if (timer) clearInterval(timer); try { wr(`TEARDOWN ${base} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${authH('TEARDOWN', base)}Session: ${session}\r\n\r\n`); } catch (e) {} setTimeout(() => { try { sock.end(); } catch (e) {} }, 150); };
  return { write: b => { queue = Buffer.concat([queue, b]); if (opts.live && queue.length > 16000) queue = queue.subarray(queue.length - 8000); }, finish: cb => { draining = true; drainCb = cb; }, close };
}
// səsi N dəfə təkrarla (aralarında ~0.4s a-law susqunluq)
function repeatAudio(buf, n) {
  n = Math.min(10, Math.max(1, parseInt(n) || 1)); if (n === 1) return buf;
  const gap = Buffer.alloc(Math.floor(8000 * 0.4), 0xD5); const parts = [];
  for (let i = 0; i < n; i++) { parts.push(buf); if (i < n - 1) parts.push(gap); }
  return Buffer.concat(parts);
}
// hazır audio buferini göndər (fayl/mesaj) — tam drenaj edib bağla
function sendPcmuToCamera(cam, pcmu, cb) {
  const s = openBackchannel(cam, () => { s.write(pcmu); s.finish(() => { if (cb) cb(true); }); }, () => { if (cb) cb(false); });
}

// ---------- OYNATMA / YÜKLƏMƏ ----------
function duration(req, res, cam, kind, name) {
  const p = safeName(cam, kind, 'mp4', name); if (!p || !fs.existsSync(p)) return json(res, {}, 404);
  const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', p]);
  let o = ''; ff.stdout.on('data', d => o += d); ff.on('close', () => json(res, { duration: parseFloat(o) || 0 })); ff.on('error', () => json(res, {}, 500));
}
function playRec(req, res, cam, kind, name, t) {
  const p = safeName(cam, kind, 'mp4', name); if (!p || !fs.existsSync(p)) { res.writeHead(404); return res.end('yoxdur'); }
  const a = ['-nostdin']; if (t > 0) a.push('-ss', String(t));
  a.push('-i', p, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '24', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-ac', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-');
  const ff = spawn('ffmpeg', a, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache' }); ff.stdout.pipe(res);
  const k = () => { try { ff.kill('SIGKILL'); } catch (e) {} }; req.on('close', k); ff.on('error', () => { try { res.end(); } catch (e) {} });
}
// seekable player — ilk dəfə H.264 faststart-a çevirib keşlə, sonra range ilə ver (müddət + irəli/geri işləsin)
function serveVPlay(req, res, cam, kind, name) {
  const src = safeName(cam, kind, 'mp4', name); if (!src || !fs.existsSync(src)) { res.writeHead(404); return res.end('yoxdur'); }
  const cdir = path.join(dirOf(cam, kind), '.h264'); try { fs.mkdirSync(cdir, { recursive: true }); } catch (e) {}
  const cp = path.join(cdir, name);
  const serveRange = () => {
    const st = fs.statSync(cp), range = req.headers.range;
    if (range) { const m = range.match(/bytes=(\d+)-(\d*)/); const s = +m[1], e = m[2] ? +m[2] : st.size - 1; res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Type': 'video/mp4' }); fs.createReadStream(cp, { start: s, end: e }).pipe(res); }
    else { res.writeHead(200, { 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' }); fs.createReadStream(cp).pipe(res); }
  };
  try { if (fs.existsSync(cp) && fs.statSync(cp).size > 2000) return serveRange(); } catch (e) {}
  const tmp = cp + '.' + Date.now() + '.part.mp4';
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-ac', '1', '-movflags', '+faststart', '-f', 'mp4', tmp, '-y'], { stdio: ['ignore', 'ignore', 'ignore'] });
  ff.on('exit', c => { if (c === 0 && fs.existsSync(tmp)) { try { fs.renameSync(tmp, cp); } catch (e) {} try { serveRange(); } catch (e) { res.writeHead(500); res.end(); } } else { try { fs.unlinkSync(tmp); } catch (e) {} res.writeHead(500); res.end('çevrilmə xətası'); } });
  ff.on('error', () => { try { res.writeHead(500); res.end(); } catch (e) {} });
}
function download(req, res, cam, kind, ext, name, type) {
  const p = safeName(cam, kind, ext, name); if (!p || !fs.existsSync(p)) { res.writeHead(404); return res.end('yoxdur'); }
  const st = fs.statSync(p), range = req.headers.range;
  if (range && type === 'video/mp4') { const m = range.match(/bytes=(\d+)-(\d*)/); const s = +m[1], e = m[2] ? +m[2] : st.size - 1; res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Type': type }); fs.createReadStream(p, { start: s, end: e }).pipe(res); }
  else { res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` }); fs.createReadStream(p).pipe(res); }
}
// WhatsApp/paylaşım üçün H.264 + faststart mp4 (H.265 dəstəklənmir)
function shareVideo(req, res, cam, kind, name) {
  const src = safeName(cam, kind, 'mp4', name); if (!src || !fs.existsSync(src)) { res.writeHead(404); return res.end('yox'); }
  const tmp = path.join(os.tmpdir(), 'share_' + Date.now() + '.mp4');
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-movflags', '+faststart', tmp, '-y'], { stdio: ['ignore', 'ignore', 'ignore'] });
  ff.on('exit', c => {
    if (c !== 0 || !fs.existsSync(tmp)) { res.writeHead(500); return res.end('xəta'); }
    const st = fs.statSync(tmp); res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name.replace(/\.mp4$/, '')}.mp4"` });
    const rs = fs.createReadStream(tmp); rs.pipe(res); rs.on('close', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
  });
  ff.on('error', () => { res.writeHead(500); res.end(); });
}
// Videonu yerində adlandır (.mp4 + .h264 keş + .thumbs eyni vaxtda)
function renameVideo(cam, kind, from, to) {
  const src = safeName(cam, kind, 'mp4', from); if (!src || !fs.existsSync(src)) return { ok: false, err: 'yoxdur' };
  let base = (to || '').replace(/\.mp4$/i, '').replace(/[^\w\- ]/g, '_').trim(); if (!base) return { ok: false, err: 'ad yanlış' };
  const toName = base + '.mp4';
  const dst = safeName(cam, kind, 'mp4', toName); if (!dst) return { ok: false, err: 'ad yanlış' };
  if (fs.existsSync(dst)) return { ok: false, err: 'bu ad mövcuddur' };
  try { fs.renameSync(src, dst); } catch (e) { return { ok: false, err: 'alınmadı' }; }
  const d = dirOf(cam, kind);
  const mv = (a, b) => { try { if (fs.existsSync(a)) fs.renameSync(a, b); } catch (e) {} };
  mv(path.join(d, '.h264', from), path.join(d, '.h264', toName));              // oynatma keşi
  mv(path.join(d, '.thumbs', from + '.jpg'), path.join(d, '.thumbs', toName + '.jpg')); // kiçik şəkil
  return { ok: true, name: toName };
}
// Seçilmiş [start,end] aralığını kəsib WhatsApp üçün H.264 mp4 endirir
function cutVideo(req, res, cam, kind, name, q) {
  const src = safeName(cam, kind, 'mp4', name); if (!src || !fs.existsSync(src)) { res.writeHead(404); return res.end('yox'); }
  const start = Math.max(0, parseFloat(q.get('start')) || 0);
  const end = parseFloat(q.get('end')) || 0;
  const dur = end - start;
  if (!(dur > 0.2)) { res.writeHead(400); return res.end('aralıq yanlış'); }
  const tmp = path.join(os.tmpdir(), 'cut_' + Date.now() + '.mp4');
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', String(start), '-i', src, '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1280,iw)':-2",
    '-c:a', 'aac', '-movflags', '+faststart', tmp, '-y'], { stdio: ['ignore', 'ignore', 'ignore'] });
  ff.on('exit', c => {
    if (c !== 0 || !fs.existsSync(tmp)) { res.writeHead(500); return res.end('xəta'); }
    const st = fs.statSync(tmp); const base = name.replace(/\.mp4$/, '');
    const fn = `${base}_kesim_${Math.round(start)}-${Math.round(end)}s.mp4`;
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${fn}"` });
    const rs = fs.createReadStream(tmp); rs.pipe(res); rs.on('close', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
  });
  ff.on('error', () => { try { res.writeHead(500); res.end(); } catch (e) {} });
}
function serveImg(req, res, cam, kind, name) { const p = safeName(cam, kind, 'jpg', name); if (!p || !fs.existsSync(p)) { res.writeHead(404); return res.end('yoxdur'); } res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }); fs.createReadStream(p).pipe(res); }
// video kadrı (thumbnail) — önbelleklə
function serveThumb(req, res, cam, kind, name) {
  const vid = safeName(cam, kind, 'mp4', name); if (!vid || !fs.existsSync(vid)) { res.writeHead(404); return res.end('yox'); }
  const tdir = path.join(dirOf(cam, kind), '.thumbs'); try { fs.mkdirSync(tdir, { recursive: true }); } catch (e) {}
  const tp = path.join(tdir, name + '.jpg');
  const send = () => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }); fs.createReadStream(tp).pipe(res); };
  if (fs.existsSync(tp)) return send();
  const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', '1', '-i', vid, '-frames:v', '1', '-update', '1', '-vf', 'scale=320:-2', '-y', tp], { stdio: ['ignore', 'ignore', 'ignore'] });
  ff.on('exit', () => { if (fs.existsSync(tp)) send(); else { res.writeHead(404); res.end(); } });
  ff.on('error', () => { res.writeHead(500); res.end(); });
}

// ---------- ONVIF PTZ / LAPI (hər kamera) ----------
const ptzTok = {}, imgTok = {};
function wsSec(cam) {
  const created = new Date().toISOString(), nonce = crypto.randomBytes(16);
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(cam.pass)])).digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${cam.user}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
}
function onvif(cam, path_, body) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${wsSec(cam)}<s:Body xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">${body}</s:Body></s:Envelope>`;
    const r = http.request({ host: cam.ip, port: 80, path: path_, method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) }, timeout: 5000 }, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ code: resp.statusCode, body: d })); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.write(xml); r.end();
  });
}
async function getPtzToken(cam) { if (ptzTok[cam.id]) return ptzTok[cam.id]; const r = await onvif(cam, '/onvif/media_service', '<trt:GetProfiles/>'); const m = r.body.match(/token="([^"]+)"/); return ptzTok[cam.id] = (m ? m[1] : 'media_profile1'); }
const DIRS = { up: [0, 0.6], down: [0, -0.6], left: [-0.6, 0], right: [0.6, 0], upleft: [-0.5, 0.5], upright: [0.5, 0.5], downleft: [-0.5, -0.5], downright: [0.5, -0.5] };
async function ptzMove(cam, dir, speed) {
  const tok = await getPtzToken(cam), sp = (speed || 50) / 100;
  if (dir === 'zoomin' || dir === 'zoomout') { const z = dir === 'zoomin' ? sp : -sp; return onvif(cam, '/onvif/ptz_service', `<tptz:ContinuousMove><tptz:ProfileToken>${tok}</tptz:ProfileToken><tptz:Velocity><tt:Zoom x="${z}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Velocity></tptz:ContinuousMove>`); }
  const d = DIRS[dir]; if (!d) return; return onvif(cam, '/onvif/ptz_service', `<tptz:ContinuousMove><tptz:ProfileToken>${tok}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${d[0]*sp}" y="${d[1]*sp}" xmlns:tt="http://www.onvif.org/ver10/schema"/></tptz:Velocity></tptz:ContinuousMove>`);
}
async function ptzStop(cam) { const tok = await getPtzToken(cam); return onvif(cam, '/onvif/ptz_service', `<tptz:Stop><tptz:ProfileToken>${tok}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`); }
function lapi(cam, method, ep, body) {
  return new Promise((resolve) => {
    const auth = (u, realm, nonce, qop, nc, cnonce) => { const ha1 = crypto.createHash('md5').update(`${cam.user}:${realm}:${cam.pass}`).digest('hex'); const ha2 = crypto.createHash('md5').update(`${method}:${u}`).digest('hex'); const resp = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex'); return `Digest username="${cam.user}", realm="${realm}", nonce="${nonce}", uri="${u}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${resp}"`; };
    const uri = `/LAPI/V1.0/${ep}`, data = body ? JSON.stringify(body) : '';
    const doReq = (hdr) => { const r = http.request({ host: cam.ip, port: 80, path: uri, method, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, hdr), timeout: 5000 }, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ code: resp.statusCode, body: d })); }); r.on('error', () => resolve({ code: 0, body: '' })); r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: '' }); }); if (data) r.write(data); r.end(); };
    const first = http.request({ host: cam.ip, port: 80, path: uri, method, headers: { 'Content-Length': 0 }, timeout: 5000 }, resp => {
      if (resp.statusCode === 401) { const h = resp.headers['www-authenticate'] || ''; const realm = (h.match(/realm="([^"]+)"/) || [])[1], nonce = (h.match(/nonce="([^"]+)"/) || [])[1], qop = (h.match(/qop="?([^",]+)"?/) || [])[1] || 'auth', cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001'; doReq({ Authorization: auth(uri, realm, nonce, qop, nc, cnonce) }); }
      else { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ code: resp.statusCode, body: d })); }
    }); first.on('error', () => resolve({ code: 0, body: '' })); first.on('timeout', () => { first.destroy(); resolve({ code: 0, body: '' }); }); first.end();
  });
}
async function getPresets(cam) { const r = await lapi(cam, 'GET', 'Channels/0/PTZ/Presets'); try { return (JSON.parse(r.body).Response.Data.PresetInfos || []).map(p => ({ id: p.ID, name: p.Name })); } catch (e) { return []; } }
async function getImgToken(cam) { if (imgTok[cam.id]) return imgTok[cam.id]; const r = await onvif(cam, '/onvif/media_service', '<trt:GetVideoSources/>'); return imgTok[cam.id] = ((r.body.match(/token="([^"]+)"/) || [])[1] || 'video_source'); }
async function getImaging(cam) { const tok = await getImgToken(cam); const r = await onvif(cam, '/onvif/imaging_service', `<timg:GetImagingSettings><timg:VideoSourceToken>${tok}</timg:VideoSourceToken></timg:GetImagingSettings>`); const num = re => { const m = r.body.match(re); return m ? Math.round(parseFloat(m[1])) : 128; }; return { brightness: num(/Brightness>([^<]+)/), contrast: num(/Contrast>([^<]+)/), saturation: num(/ColorSaturation>([^<]+)/), sharpness: num(/Sharpness>([^<]+)/) }; }
async function setImaging(cam, v) { const tok = await getImgToken(cam), cur = await getImaging(cam), m = Object.assign(cur, v); const body = `<timg:SetImagingSettings><timg:VideoSourceToken>${tok}</timg:VideoSourceToken><timg:ImagingSettings><tt:Brightness>${m.brightness}</tt:Brightness><tt:ColorSaturation>${m.saturation}</tt:ColorSaturation><tt:Contrast>${m.contrast}</tt:Contrast><tt:Sharpness>${m.sharpness}</tt:Sharpness></timg:ImagingSettings><timg:ForcePersistence>true</timg:ForcePersistence></timg:SetImagingSettings>`; const r = await onvif(cam, '/onvif/imaging_service', body); return /SetImagingSettingsResponse/.test(r.body); }
async function cameraInfo(cam) { const r = await lapi(cam, 'GET', 'System/DeviceBasicInfo'); try { const d = JSON.parse(r.body).Response.Data; return { manufacturer: d.Manufacturer, model: d.DeviceModel, serial: d.SerialNumber, mac: d.MAC, firmware: d.FirmwareVersion, address: d.Address, netmask: d.Netmask, gateway: d.Gateway }; } catch (e) { return {}; } }
// kameranın şəbəkə/WiFi vəziyyəti
async function cameraNet(cam) {
  const info = await cameraInfo(cam); let wifi = null;
  for (const ep of ['System/NetworkInterface', 'System/Wifi', 'Network/WiFi', 'System/WifiInfo']) {
    const r = await lapi(cam, 'GET', ep); try { const j = JSON.parse(r.body); if (j.Response && j.Response.ResponseString === 'Succeed' && j.Response.Data) { const d = j.Response.Data; const sig = d.SignalStrength || d.Signal || d.RSSI || (d.WifiInfo && d.WifiInfo.SignalStrength); if (sig != null || d.SSID) { wifi = { ssid: d.SSID || (d.WifiInfo && d.WifiInfo.SSID), signal: sig }; break; } } } catch (e) {}
  }
  const online = await camOnline(cam);
  return { ip: cam.ip, mac: info.mac, netmask: info.netmask, gateway: info.gateway, online, wifi };
}
// internet ping + download sürəti (server tərəfi)
function measurePing(cb) { const ff = spawn('ping', ['-c', '4', '-w', '6', '8.8.8.8'], { stdio: ['ignore', 'pipe', 'ignore'] }); let o = ''; ff.stdout.on('data', d => o += d); ff.on('close', () => { const m = o.match(/=\s*[\d.]+\/([\d.]+)\//); const loss = (o.match(/(\d+)% packet loss/) || [])[1]; cb({ ping: m ? Math.round(parseFloat(m[1])) : null, loss: loss != null ? +loss : null }); }); ff.on('error', () => cb({ ping: null, loss: null })); }
// kameraya ping ilə WiFi/siqnal gücü (telefon kimi 0-3 dalğa) — firmware siqnal vermədiyi üçün gecikmə/itki ilə ölçülür
function camSignal(ip, cb) {
  const ff = spawn('ping', ['-c', '3', '-w', '4', ip], { stdio: ['ignore', 'pipe', 'ignore'] }); let o = '';
  ff.stdout.on('data', d => o += d);
  ff.on('close', () => {
    const m = o.match(/=\s*[\d.]+\/([\d.]+)\//); const lm = (o.match(/(\d+)% packet loss/) || [])[1];
    const ping = m ? Math.round(parseFloat(m[1])) : null; const loss = lm != null ? +lm : 100;
    let bars = 0, online = false;
    if (ping != null && loss < 100) { online = true; if (loss >= 40) bars = 1; else if (ping <= 20) bars = 3; else if (ping <= 60) bars = 2; else bars = 1; }
    cb({ online, ping, loss, bars });
  });
  ff.on('error', () => cb({ online: false, ping: null, loss: 100, bars: 0 }));
}
function measureDownload(cb) {
  const start = Date.now(); let bytes = 0; let done = false;
  const fin = () => { if (done) return; done = true; const sec = (Date.now() - start) / 1000; cb(sec > 0.1 && bytes > 0 ? +((bytes * 8 / 1e6) / sec).toFixed(1) : null); };
  const r = https.get('https://proof.ovh.net/files/10Mb.dat', { headers: { 'User-Agent': 'curl/8' } }, res => { res.on('data', c => bytes += c.length); res.on('end', fin); res.on('error', fin); });
  r.on('error', fin); r.setTimeout(12000, () => { try { r.destroy(); } catch (e) {} fin(); });
}

// ---------- STATUS ----------
async function status(req, res, cam) {
  const recs = listDir(cam, 'videolar', 'mp4', true), mot = listDir(cam, 'hareket', 'jpg'), pho = listDir(cam, 'resimler', 'jpg'), mvid = listDir(cam, 'hareket_video', 'mp4');
  let disk = {}; try { const st = fs.statfsSync(MEDIA_ROOT); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize, used: (st.blocks - st.bavail) * st.bsize }; } catch (e) {}
  const rs = recState[cam.id] || {};
  json(res, {
    camera: { id: cam.id, name: cam.name, ip: cam.ip, user: cam.user, online: await camOnline(cam), model: 'Uniview', resolution: '2880x1620 H.265', fps: 15 },
    recording: { active: !!recProcs[cam.id] && rs.enabled, since: rs.since || null, mode: cam.recMode },
    recordings: { count: recs.length, totalSize: recs.reduce((s, r) => s + r.size, 0), newest: recs[0] ? recs[0].date : null },
    motion: { count: mot.length }, photos: { count: pho.length }, motionVideos: { count: mvid.length },
    disk, server: { uptime: Date.now() - START, port: PORT, node: process.version, host: os.hostname(), platform: os.platform() },
  });
}
function tail(f, n) { try { return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n); } catch (e) { return []; } }

// ---------- AVTOMATİK DİSK TƏMİZLİYİ ----------
const MIN_FREE_GB = 15, MAX_AGE_DAYS = 14;
function diskFreeBytes() { try { const st = fs.statfsSync(MEDIA_ROOT); return st.bavail * st.bsize; } catch (e) { return Infinity; } }
function allMedia() { const files = []; for (const cam of CAMS) for (const [kind, ext] of [['videolar', 'mp4'], ['hareket_video', 'mp4'], ['hareket', 'jpg'], ['resimler', 'jpg']]) { const d = dirOf(cam, kind); try { for (const f of fs.readdirSync(d)) { if (!f.endsWith('.' + ext)) continue; try { const st = fs.statSync(path.join(d, f)); files.push({ fp: path.join(d, f), mtime: st.mtimeMs, size: st.size }); } catch (e) {} } } catch (e) {} } return files.sort((a, b) => a.mtime - b.mtime); }
function cleanup() {
  try {
    const now = Date.now(); let ra = 0, rs = 0;
    for (const f of allMedia()) if (now - f.mtime > MAX_AGE_DAYS * 864e5 && now - f.mtime > 8000) { try { fs.unlinkSync(f.fp); ra++; } catch (e) {} }
    let free = diskFreeBytes();
    if (free < MIN_FREE_GB * 1e9) for (const f of allMedia()) { if (free >= MIN_FREE_GB * 1e9) break; if (now - f.mtime < 8000) continue; try { fs.unlinkSync(f.fp); free += f.size; rs++; } catch (e) {} }
    if (ra || rs) log(`təmizlik: ${ra} köhnə, ${rs} yer üçün silindi, boş: ${(free / 1e9).toFixed(0)}GB`);
  } catch (e) { log('təmizlik xətası: ' + e.message); }
}

// ---------- ROUTER ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`), p = decodeURIComponent(u.pathname), q = u.searchParams;
  const cam = getCam(q.get('cam'));
  try {
    if (p === '/' || p === '/index.html') { fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => { if (e) { res.writeHead(500); return res.end('index.html yox'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); }); }
    // kameralar
    else if (p === '/api/cameras' && req.method === 'GET') json(res, CAMS.map(c => ({ id: c.id, name: c.name, ip: c.ip, user: c.user })));
    else if (p === '/api/cameras' && req.method === 'POST') {
      const b = await readBody(req); if (!b.ip) return json(res, { ok: false, err: 'IP lazımdır' }, 400);
      const c = normCam({ id: newCamId(), name: b.name || ('Kamera ' + (CAMS.length + 1)), ip: b.ip, user: b.user, pass: b.pass, motionSens: b.motionSens, segTime: b.segTime, motionShots: b.motionShots });
      CAMS.push(c); saveCameras(); startCam(c); log('kamera əlavə olundu: ' + c.id); json(res, { ok: true, id: c.id });
    }
    else if (p.startsWith('/api/cameras/') && req.method === 'POST') { // redaktə
      const id = p.replace('/api/cameras/', ''); const c = CAMS.find(x => x.id === id); if (!c) return json(res, { ok: false }, 404);
      const b = await readBody(req);
      const needRestart = (b.ip && b.ip !== c.ip) || (b.user && b.user !== c.user) || !!b.pass || (b.segTime && b.segTime !== c.segTime) || (b.motionSens && b.motionSens !== c.motionSens) || (b.motionShots && b.motionShots !== c.motionShots);
      ['name', 'ip', 'user', 'motionSens', 'segTime', 'motionShots'].forEach(k => { if (b[k] != null && b[k] !== '') c[k] = b[k]; }); if (b.pass) c.pass = b.pass;
      saveCameras(); if (needRestart) { ptzTok[id] = null; imgTok[id] = null; restartCam(c); } log('kamera redaktə: ' + id); json(res, { ok: true });
    }
    else if (p.startsWith('/api/cameras/') && req.method === 'DELETE') {
      const id = p.replace('/api/cameras/', ''); const c = CAMS.find(x => x.id === id); if (!c) return json(res, { ok: false }, 404);
      if (CAMS.length <= 1) return json(res, { ok: false, err: 'Son kamera silinə bilməz' }, 400);
      stopCam(c); CAMS = CAMS.filter(x => x.id !== id); saveCameras(); log('kamera silindi: ' + id); json(res, { ok: true });
    }
    // canlı
    else if (p === '/live.mjpeg') liveVideo(req, res, cam, q.get('hd') === '1');
    else if (p === '/live.mp3') liveAudio(req, res, cam, Math.min(10, Math.max(1, parseFloat(q.get('gain')) || 2)));
    else if (p === '/snapshot.jpg') liveSnapshot(req, res, cam);
    else if (p === '/api/photo/save' && req.method === 'POST') savePhoto(req, res, cam);
    // yazılar
    else if (p === '/api/recordings' && req.method === 'GET') json(res, await videosWithDur(cam, 'videolar'));
    else if (p === '/api/recordings/batch-delete' && req.method === 'POST') { const b = await readBody(req); json(res, batchDelete(cam, 'videolar', 'mp4', b.names, b.all, true)); }
    else if (p.startsWith('/api/recordings/') && req.method === 'DELETE') json(res, batchDelete(cam, 'videolar', 'mp4', [p.replace('/api/recordings/', '')], false, true));
    else if (p.startsWith('/api/duration/')) duration(req, res, cam, 'videolar', p.replace('/api/duration/', ''));
    else if (p.startsWith('/vplay/rec/')) serveVPlay(req, res, cam, 'videolar', p.replace('/vplay/rec/', ''));
    else if (p.startsWith('/vplay/mv/')) serveVPlay(req, res, cam, 'hareket_video', p.replace('/vplay/mv/', ''));
    else if (p.startsWith('/play/')) playRec(req, res, cam, 'videolar', p.replace('/play/', ''), parseFloat(q.get('t')) || 0);
    else if (p.startsWith('/download/')) download(req, res, cam, 'videolar', 'mp4', p.replace('/download/', ''), 'video/mp4');
    // hərəkət şəkilləri
    else if (p === '/api/motion' && req.method === 'GET') json(res, listDir(cam, 'hareket', 'jpg'));
    else if (p === '/api/motion/batch-delete' && req.method === 'POST') { const b = await readBody(req); json(res, batchDelete(cam, 'hareket', 'jpg', b.names, b.all)); }
    else if (p.startsWith('/api/motion/') && req.method === 'DELETE') json(res, batchDelete(cam, 'hareket', 'jpg', [p.replace('/api/motion/', '')]));
    else if (p.startsWith('/motion/')) serveImg(req, res, cam, 'hareket', p.replace('/motion/', ''));
    // hərəkət videoları
    else if (p === '/api/motionvideos' && req.method === 'GET') json(res, await videosWithDur(cam, 'hareket_video'));
    else if (p === '/api/motionvideos/batch-delete' && req.method === 'POST') { const b = await readBody(req); json(res, batchDelete(cam, 'hareket_video', 'mp4', b.names, b.all, true)); }
    else if (p.startsWith('/api/motionvideos/') && req.method === 'DELETE') json(res, batchDelete(cam, 'hareket_video', 'mp4', [p.replace('/api/motionvideos/', '')], false, true));
    else if (p.startsWith('/mv-duration/')) duration(req, res, cam, 'hareket_video', p.replace('/mv-duration/', ''));
    else if (p.startsWith('/mv-play/')) playRec(req, res, cam, 'hareket_video', p.replace('/mv-play/', ''), parseFloat(q.get('t')) || 0);
    else if (p.startsWith('/mv-download/')) download(req, res, cam, 'hareket_video', 'mp4', p.replace('/mv-download/', ''), 'video/mp4');
    // şəkillər
    else if (p === '/api/photos' && req.method === 'GET') json(res, listDir(cam, 'resimler', 'jpg'));
    else if (p === '/api/photos/batch-delete' && req.method === 'POST') { const b = await readBody(req); json(res, batchDelete(cam, 'resimler', 'jpg', b.names, b.all)); }
    else if (p.startsWith('/api/photos/') && req.method === 'DELETE') json(res, batchDelete(cam, 'resimler', 'jpg', [p.replace('/api/photos/', '')]));
    else if (p.startsWith('/photo/')) serveImg(req, res, cam, 'resimler', p.replace('/photo/', ''));
    // yazılma idarə
    else if (p === '/api/recording/start' && req.method === 'POST') { startRec(cam); json(res, { ok: true, active: true }); }
    else if (p === '/api/recording/stop' && req.method === 'POST') { stopRec(cam); json(res, { ok: true, active: false }); }
    // PTZ
    else if (p === '/api/ptz/move' && req.method === 'POST') { const b = await readBody(req); try { await ptzMove(cam, b.dir, b.speed); json(res, { ok: true }); } catch (e) { json(res, { ok: false }, 500); } }
    else if (p === '/api/ptz/stop' && req.method === 'POST') { try { await ptzStop(cam); json(res, { ok: true }); } catch (e) { json(res, { ok: false }, 500); } }
    else if (p === '/api/ptz/presets' && req.method === 'GET') json(res, await getPresets(cam));
    else if (p === '/api/ptz/preset/goto' && req.method === 'POST') { const b = await readBody(req); const r = await lapi(cam, 'PUT', `Channels/0/PTZ/Presets/${+b.id}/Goto`, { ID: +b.id, Speed: 40 }); json(res, { ok: /Succeed/.test(r.body) }); }
    else if (p === '/api/ptz/preset/save' && req.method === 'POST') { const b = await readBody(req); const used = new Set((await getPresets(cam)).map(x => x.id)); let id = 1; while (used.has(id) && id <= 20) id++; const r = await lapi(cam, 'POST', 'Channels/0/PTZ/Presets', { ID: id, Name: (b.name || 'Preset').slice(0, 20) }); json(res, { ok: /Succeed/.test(r.body), id }); }
    else if (p === '/api/ptz/preset/delete' && req.method === 'POST') { const b = await readBody(req); const r = await lapi(cam, 'DELETE', `Channels/0/PTZ/Presets/${+b.id}`); json(res, { ok: /Succeed/.test(r.body) }); }
    // görüntü / kamera idarə
    else if (p === '/api/image' && req.method === 'GET') { try { json(res, await getImaging(cam)); } catch (e) { json(res, {}, 500); } }
    else if (p === '/api/image' && req.method === 'POST') { const b = await readBody(req); try { json(res, { ok: await setImaging(cam, b) }); } catch (e) { json(res, { ok: false }, 500); } }
    else if (p === '/api/camera/info' && req.method === 'GET') { try { json(res, await cameraInfo(cam)); } catch (e) { json(res, {}, 500); } }
    else if (p === '/api/camera/net' && req.method === 'GET') { try { json(res, await cameraNet(cam)); } catch (e) { json(res, {}, 500); } }
    else if (p === '/api/camera/signal' && req.method === 'GET') { camSignal(cam.ip, s => json(res, s)); }
    else if (p === '/api/net' && req.method === 'GET') { measurePing(pr => measureDownload(dl => json(res, { ping: pr.ping, loss: pr.loss, download: dl }))); }
    else if (p.startsWith('/thumb/rec/')) serveThumb(req, res, cam, 'videolar', p.replace('/thumb/rec/', ''));
    else if (p.startsWith('/thumb/mv/')) serveThumb(req, res, cam, 'hareket_video', p.replace('/thumb/mv/', ''));
    else if (p.startsWith('/share/rec/')) shareVideo(req, res, cam, 'videolar', p.replace('/share/rec/', ''));
    else if (p.startsWith('/share/mv/')) shareVideo(req, res, cam, 'hareket_video', p.replace('/share/mv/', ''));
    else if (p.startsWith('/cut/rec/')) cutVideo(req, res, cam, 'videolar', p.replace('/cut/rec/', ''), q);
    else if (p.startsWith('/cut/mv/')) cutVideo(req, res, cam, 'hareket_video', p.replace('/cut/mv/', ''), q);
    else if (p === '/api/rename/rec' && req.method === 'POST') { const b = await readBody(req); json(res, renameVideo(cam, 'videolar', b.from, b.to)); }
    else if (p === '/api/rename/mv' && req.method === 'POST') { const b = await readBody(req); json(res, renameVideo(cam, 'hareket_video', b.from, b.to)); }
    else if (p === '/api/camera/reboot' && req.method === 'POST') { try { const r = await lapi(cam, 'PUT', 'System/Reboot', { Delay: 0 }); json(res, { ok: /Succeed/.test(r.body) }); } catch (e) { json(res, { ok: false }, 500); } }
    else if (p === '/api/camera/synctime' && req.method === 'POST') { try { const r = await lapi(cam, 'PUT', 'System/Time', { TimeZone: 'GMT+04:00', DeviceTime: Math.floor(Date.now() / 1000) }); json(res, { ok: /Succeed/.test(r.body) }); } catch (e) { json(res, { ok: false }, 500); } }
    // ayarlar (seçili kameranın parametrləri)
    else if (p === '/api/settings' && req.method === 'GET') json(res, { id: cam.id, name: cam.name, CAM_IP: cam.ip, CAM_USER: cam.user, CAM_PASS: '', MOTION_SENS: cam.motionSens, SEG_TIME: cam.segTime, MOTION_SHOTS: cam.motionShots, REC_MODE: cam.recMode, MOTION_MINSIZE: cam.motionMinSize });
    else if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.name) cam.name = b.name.trim(); if (b.CAM_IP) cam.ip = b.CAM_IP.trim(); if (b.CAM_USER) cam.user = b.CAM_USER.trim();
      if (b.CAM_PASS) cam.pass = b.CAM_PASS; if (b.MOTION_SENS) cam.motionSens = b.MOTION_SENS; if (b.SEG_TIME) cam.segTime = b.SEG_TIME; if (b.MOTION_SHOTS) cam.motionShots = b.MOTION_SHOTS;
      if (b.REC_MODE) cam.recMode = b.REC_MODE; if (b.MOTION_MINSIZE) cam.motionMinSize = b.MOTION_MINSIZE;
      saveCameras(); ptzTok[cam.id] = null; imgTok[cam.id] = null; restartCam(cam); log('ayarlar yeniləndi: ' + cam.id); json(res, { ok: true });
    }
    // kameraya səs göndər (backchannel) — hazır səs (preset) və ya yüklənmiş audio
    else if (p === '/api/playsound' && req.method === 'POST') {
      const preset = q.get('preset');
      const PRESETS = {
        siren: ['-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*t*(750+450*sin(2*PI*t)))':d=6:s=8000"],
        alarm: ['-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*t*1100)*lt(mod(t,0.6),0.3)':d=6:s=8000"],
        bip: ['-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*t*1000)*lt(mod(t,0.5),0.18)':d=3:s=8000"],
      };
      let args;
      if (preset && PRESETS[preset]) args = ['-nostdin', ...PRESETS[preset], '-ar', '8000', '-ac', '1', '-f', 'alaw', 'pipe:1'];
      else args = ['-nostdin', '-i', 'pipe:0', '-ar', '8000', '-ac', '1', '-f', 'alaw', 'pipe:1'];
      const ff = spawn('ffmpeg', args, { stdio: [preset ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
      const out = []; ff.stdout.on('data', c => out.push(c)); if (!preset) { ff.stdin.on('error', () => {}); req.pipe(ff.stdin); }
      ff.on('close', () => { const pcmu = Buffer.concat(out); if (!pcmu.length) return json(res, { ok: false, err: 'audio alınmadı' }, 400); sendPcmuToCamera(cam, repeatAudio(pcmu, q.get('repeat')), ok => json(res, { ok })); });
      ff.on('error', () => json(res, { ok: false }, 500));
    }
    // öz səslər (qeyd/upload) — list/upload/çal/sil
    else if (p === '/api/sounds' && req.method === 'GET') { let l = []; try { l = fs.readdirSync(SOUNDS_DIR).map(f => { const st = fs.statSync(path.join(SOUNDS_DIR, f)); return { name: f, size: st.size, date: st.mtimeMs }; }).sort((a, b) => b.date - a.date); } catch (e) {} json(res, l); }
    else if (p === '/api/sounds/upload' && req.method === 'POST') {
      const nm = (q.get('name') || ('ses_' + stamp())).replace(/[^\w\-. ]/g, '_'); const fp = safeSound(nm); if (!fp) return json(res, { ok: false }, 400);
      const ws = fs.createWriteStream(fp); req.pipe(ws); ws.on('finish', () => json(res, { ok: true, name: nm })); ws.on('error', () => json(res, { ok: false }, 500));
    }
    else if (p === '/api/sounds/play' && req.method === 'POST') {
      const fp = safeSound(q.get('name')); if (!fp || !fs.existsSync(fp)) return json(res, { ok: false, err: 'yoxdur' }, 404);
      const ff = spawn('ffmpeg', ['-nostdin', '-i', fp, '-ar', '8000', '-ac', '1', '-f', 'alaw', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out = []; ff.stdout.on('data', c => out.push(c)); ff.on('close', () => { const pcmu = Buffer.concat(out); if (!pcmu.length) return json(res, { ok: false }, 400); sendPcmuToCamera(cam, repeatAudio(pcmu, q.get('repeat')), ok => json(res, { ok })); }); ff.on('error', () => json(res, { ok: false }, 500));
    }
    else if (p === '/api/sounds/rename' && req.method === 'POST') {
      const b = await readBody(req); const fromP = safeSound(b.from); if (!fromP || !fs.existsSync(fromP)) return json(res, { ok: false, err: 'yoxdur' }, 400);
      let toName = (b.to || '').replace(/[^\w\-. ]/g, '_').trim(); if (!toName) return json(res, { ok: false }, 400);
      const ext = path.extname(b.from); if (ext && !toName.toLowerCase().endsWith(ext.toLowerCase())) toName += ext;
      const toP = safeSound(toName); if (!toP) return json(res, { ok: false }, 400);
      try { fs.renameSync(fromP, toP); json(res, { ok: true, name: toName }); } catch (e) { json(res, { ok: false }, 500); }
    }
    else if (p.startsWith('/api/sounds/') && req.method === 'DELETE') { const fp = safeSound(decodeURIComponent(p.replace('/api/sounds/', ''))); if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} } json(res, { ok: true }); }
    // YouTube-dan səs endir → 6 saniyəyə kəs → mp3 (kameraya uyğun)
    else if (p === '/api/sounds/youtube' && req.method === 'POST') {
      const b = await readBody(req); const url = (b.url || '').trim();
      if (!/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url)) return json(res, { ok: false, err: 'Düzgün YouTube linki deyil' }, 400);
      const start = Math.max(0, parseFloat(b.start) || 0), dur = Math.min(6, Math.max(1, parseFloat(b.dur) || 6));
      let name = (b.name || ('yt_' + stamp())).replace(/[^\w\-. ]/g, '_'); if (!/\.(mp3|wav|webm|ogg|m4a)$/i.test(name)) name += '.mp3';
      const fp = safeSound(name); if (!fp) return json(res, { ok: false }, 400);
      const tmp = path.join(os.tmpdir(), 'ytdl_' + Date.now());
      const yt = spawn('/home/gg/.local/bin/yt-dlp', ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--no-playlist', '--no-warnings', '--ffmpeg-location', '/usr/bin', '-o', tmp + '.%(ext)s', url], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; yt.stderr.on('data', d => err += d); yt.on('error', () => json(res, { ok: false, err: 'yt-dlp tapılmadı' }, 500));
      yt.on('close', code => {
        const dl = tmp + '.mp3'; if (code !== 0 || !fs.existsSync(dl)) return json(res, { ok: false, err: ('endirilmədi: ' + err).slice(0, 150) }, 500);
        const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', dl, '-c:a', 'libmp3lame', '-ar', '44100', fp, '-y'], { stdio: ['ignore', 'ignore', 'ignore'] });
        ff.on('close', c => { try { fs.unlinkSync(dl); } catch (e) {} if (c === 0 && fs.existsSync(fp)) { log('youtube səs endirildi: ' + name); json(res, { ok: true, name }); } else json(res, { ok: false, err: 'çevrilmədi' }, 500); });
        ff.on('error', () => json(res, { ok: false }, 500));
      });
    }
    else if (p.startsWith('/sound/')) { const fp = safeSound(decodeURIComponent(p.replace('/sound/', ''))); if (!fp || !fs.existsSync(fp)) { res.writeHead(404); return res.end('yox'); } const ext = path.extname(fp).toLowerCase(); const ct = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' }[ext] || 'audio/mpeg'; res.writeHead(200, { 'Content-Type': ct }); fs.createReadStream(fp).pipe(res); }
    else if (p === '/api/status') await status(req, res, cam);
    else if (p === '/api/logs') json(res, { server: tail(SRV_LOG, 200) });
    else { res.writeHead(404); res.end('404'); }
  } catch (e) { log('xəta: ' + e.message); try { res.writeHead(500); res.end('xəta'); } catch (_) {} }
});
// WebSocket — real-time danışıq (mikrofon → backchannel)
server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x'); if (u.pathname !== '/talk') { sock.destroy(); return; }
  const cam = getCam(u.searchParams.get('cam')); const key = req.headers['sec-websocket-key']; if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const bch = openBackchannel(cam, () => {}, () => { try { sock.end(); } catch (e) {} }, { live: true });
  log(`[${cam.id}] danışıq başladı`);
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len; if (buf.length < need) break;
      let mask = null; if (masked) { mask = buf.subarray(off, off + 4); off += 4; }
      let pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
      if (masked) { const p = Buffer.from(pl); for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3]; pl = p; }
      if (op === 8) { bch.close(); try { sock.end(); } catch (e) {} return; }
      if (op === 1 || op === 2) bch.write(pl);
    }
  });
  const stop = () => { bch.close(); };
  sock.on('close', stop); sock.on('error', stop);
});
function shutdown() { log('server bağlanır'); for (const cam of CAMS) { if (recState[cam.id]) recState[cam.id].enabled = false; } for (const m of [recProcs, motionProcs, clipProcs, ringProcs]) for (const id in m) { try { if (m[id]) m[id].kill('SIGTERM'); } catch (e) {} } setTimeout(() => process.exit(0), 1500); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(PORT, () => { log(`dashboard başladı, port ${PORT}, ${CAMS.length} kamera`); console.log(`Kamera dashboard: http://localhost:${PORT}`); CAMS.forEach(startCam); cleanup(); setInterval(cleanup, 15 * 60 * 1000); setInterval(watchdog, 10 * 1000); });
