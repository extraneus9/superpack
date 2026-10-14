// Media layer: ffprobe metadata, a local HTTP server for on-the-fly conversion, frame grabs and waveforms.
// Files Chromium can decode play straight from disk (file://). Everything else (ProRes, AVI, WMV, AC3, DTS…)
// is converted live by FFmpeg into fragmented MP4 and streamed from 127.0.0.1 — seeking restarts the stream.
const { spawn, execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'mxf', '3gp', 'ogv', 'vob', 'f4v', 'divx', 'asf'];
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'alac', 'ac3', 'dts', 'mka', 'weba'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

// What Chromium (Electron) decodes natively. HEVC goes through the GPU decoder.
const DIRECT_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'weba']);
const DIRECT_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);

const extOf = (f) => path.extname(f).slice(1).toLowerCase();
const isMedia = (f) => MEDIA_EXT.has(extOf(f));

// ---------- binaries ----------
// Startup speed: where FFmpeg lives and which encoder works are remembered in a small file, so launching the player
// never waits on `where` or on a test encode. A path that has gone missing is looked up again.
const BIN_CACHE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'the player', 'bins.json');
let binCache = {};
try { binCache = JSON.parse(fs.readFileSync(BIN_CACHE, 'utf8')) || {}; } catch {}
const saveBinCache = () => { try { fs.mkdirSync(path.dirname(BIN_CACHE), { recursive: true }); fs.writeFileSync(BIN_CACHE, JSON.stringify(binCache)); } catch {} };

function findBin(name) {
  // the installed app may carry its own FFmpeg (superpack: resources/ffmpeg) — that one always wins
  const bundled = process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', name + '.exe') : null;
  if (bundled && fs.existsSync(bundled)) return bundled;
  if (binCache[name] && fs.existsSync(binCache[name])) return binCache[name];
  let found = null;
  try {
    // System32's where, and only PATH ($PATH:) — never a same-named exe sitting in the opened video's folder
    const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    const out = execFileSync(where, ['$PATH:' + name + '.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
    if (out[0]) found = out[0];
  } catch {}
  if (!found) {
    const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      outer: for (const pkg of fs.readdirSync(root).filter((d) => /ffmpeg/i.test(d))) {
        for (const sub of fs.readdirSync(path.join(root, pkg))) {
          const p = path.join(root, pkg, sub, 'bin', name + '.exe');
          if (fs.existsSync(p)) { found = p; break outer; }
        }
      }
    } catch {}
  }
  if (!found) for (const p of [`C:\\ffmpeg\\bin\\${name}.exe`, `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`]) if (fs.existsSync(p)) { found = p; break; }
  if (found && binCache[name] !== found) { binCache[name] = found; saveBinCache(); }
  return found;
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

// 'h264_nvenc' (his RTX) or 'libx264'. Tested once per FFmpeg install, in the background — never before the window shows.
let encoder = binCache.encoderFor === FFMPEG && binCache.encoder ? binCache.encoder : null;
let encoderJob = null;
const encoderNow = () => encoder || 'libx264';
function detectEncoder() {
  if (encoder || !FFMPEG) return Promise.resolve(encoderNow());
  if (!encoderJob) {
    encoderJob = new Promise((resolve) => execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      { windowsHide: true, timeout: 15000 }, (err) => {
        encoder = err ? 'libx264' : 'h264_nvenc';
        binCache.encoder = encoder; binCache.encoderFor = FFMPEG; saveBinCache();
        resolve(encoder);
      }));
  }
  return encoderJob;
}

// ---------- probe ----------
const probeCache = new Map();
function ratio(s) { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a || 0; }
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function aspectLabel(w, h) {
  if (!w || !h) return '';
  const r = w / h;
  const known = [[4 / 3, '4:3'], [16 / 9, '16:9'], [9 / 16, '9:16'], [3 / 4, '3:4'], [1, '1:1'], [4 / 5, '4:5'], [21 / 9, '21:9'], [2.39, '2.39:1'], [1.85, '1.85:1'], [2, '2:1'], [3 / 2, '3:2']];
  for (const [v, l] of known) if (Math.abs(r - v) / v < 0.012) return l;
  const g = gcd(w, h);
  return w / g <= 32 ? `${w / g}:${h / g}` : `${r.toFixed(2)}:1`;
}
const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', wmv3: 'WMV', wmv2: 'WMV', vc1: 'VC-1', dnxhd: 'DNxHD', mjpeg: 'MJPEG', flv1: 'FLV', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', alac: 'ALAC', wmav2: 'WMA' };
const codecName = (c) => CODEC_NAMES[c] || (c && c.startsWith('pcm_') ? 'PCM' : String(c || '').toUpperCase());

function probe(file) {
  let st;
  try { st = fs.statSync(file); } catch { return Promise.reject(new Error('File not found: ' + file)); }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);
  if (diskProbe[key]) { const p = Promise.resolve(diskProbe[key]); probeCache.set(key, p); return p; }
  const p = new Promise((resolve, reject) => {
    if (!FFPROBE) return reject(new Error('FFprobe not found'));
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Could not read this file'));
      let j; try { j = JSON.parse(stdout); } catch { return reject(new Error('Could not read this file')); }
      const streams = j.streams || [];
      const vs = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const as = streams.find((s) => s.codec_type === 'audio');
      const ext = extOf(file);
      let video = null;
      if (vs) {
        let w = vs.width, h = vs.height;
        const rot = Math.abs(Number((vs.side_data_list || []).find((d) => d.rotation != null)?.rotation || vs.tags?.rotate || 0));
        if (rot === 90 || rot === 270) [w, h] = [h, w];
        const sar = ratio(vs.sample_aspect_ratio && vs.sample_aspect_ratio !== '0:1' ? vs.sample_aspect_ratio.replace(':', '/') : '1/1') || 1;
        const dispW = Math.round(w * (rot === 90 || rot === 270 ? 1 : sar)), dispH = h;
        const fpsNum = vs.r_frame_rate && vs.r_frame_rate !== '0/0' ? vs.r_frame_rate : vs.avg_frame_rate;
        const fps = ratio(fpsNum) || 30;
        video = {
          codec: vs.codec_name, codecName: codecName(vs.codec_name), profile: vs.profile || '',
          width: w, height: h, dispW, dispH, aspect: aspectLabel(dispW, dispH),
          fps, fpsRational: fpsNum, pixFmt: vs.pix_fmt || '',
          bitDepth: Number(vs.bits_per_raw_sample) || (/10|p010/.test(vs.pix_fmt || '') ? 10 : 8),
          bitrate: Number(vs.bit_rate) || 0,
        };
      }
      const audio = as ? {
        codec: as.codec_name, codecName: codecName(as.codec_name), sampleRate: Number(as.sample_rate) || 0,
        channels: as.channels || 0, layout: as.channel_layout || '', bitrate: Number(as.bit_rate) || 0,
      } : null;
      const duration = Number(j.format?.duration) || Number(vs?.duration) || Number(as?.duration) || 0;
      const kind = video ? 'video' : 'audio';
      const direct = DIRECT_EXT.has(ext)
        && (!video || DIRECT_VIDEO.has(video.codec))
        && (!audio || DIRECT_AUDIO.has(audio.codec))
        && (video || audio);
      resolve({
        path: file, name: path.basename(file), dir: path.dirname(file), ext, container: ext.toUpperCase(),
        size: st.size, mtime: st.mtimeMs, duration, bitrate: Number(j.format?.bit_rate) || 0,
        kind, video, audio, mode: direct ? 'direct' : 'transcode', url: pathToFileURL(file).href,
      });
    });
  });
  probeCache.set(key, p);
  p.then((info) => { diskProbe[key] = info; saveDiskProbe(); }, () => probeCache.delete(key));
  return p;
}

// What ffprobe said about each file, kept on disk between launches (keyed by path + size + modified time, so a
// re-exported file is read again): the home page and its showreel open without probing anything twice.
// PROBE_V changes whenever probe()'s output changes, which drops the old file.
const PROBE_V = 1;
let diskProbe = {}, diskProbeFile = null, diskProbeTimer = null;
function loadDiskProbe(dir) {
  diskProbeFile = path.join(dir, 'probe.json');
  try { const j = JSON.parse(fs.readFileSync(diskProbeFile, 'utf8')); diskProbe = j.v === PROBE_V && j.items ? j.items : {}; } catch { diskProbe = {}; }
}
function saveDiskProbe(now = false) {
  if (!diskProbeFile) return;
  if (now) { clearTimeout(diskProbeTimer); diskProbeTimer = null; return writeDiskProbe(); }
  if (!diskProbeTimer) diskProbeTimer = setTimeout(() => { diskProbeTimer = null; writeDiskProbe(); }, 1500);
}
function writeDiskProbe() {
  {
    const keys = Object.keys(diskProbe);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete diskProbe[k]; // oldest first out
    try { fs.mkdirSync(path.dirname(diskProbeFile), { recursive: true }); fs.writeFileSync(diskProbeFile + '.tmp', JSON.stringify({ v: PROBE_V, items: diskProbe })); fs.renameSync(diskProbeFile + '.tmp', diskProbeFile); } catch {}
  }
}

// Everything ffprobe knows (format, every stream, chapters) plus the file's dates on disk — for the details drawer.
function details(file) {
  return new Promise((resolve, reject) => {
    if (!FFPROBE) return reject(new Error('FFprobe not found'));
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Could not read this file'));
      let j; try { j = JSON.parse(stdout); } catch { return reject(new Error('Could not read this file')); }
      let st = null; try { st = fs.statSync(file); } catch {}
      resolve({
        path: file, name: path.basename(file), dir: path.dirname(file),
        size: st ? st.size : Number(j.format && j.format.size) || 0,
        created: st ? st.birthtimeMs : 0, modified: st ? st.mtimeMs : 0,
        format: j.format || {}, streams: j.streams || [], chapters: j.chapters || [],
      });
    });
  });
}

function siblings(file) {
  const dir = path.dirname(file);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && isMedia(d.name)).map((d) => d.name); } catch {}
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return names.sort(coll.compare).map((n) => {
    const p = path.join(dir, n);
    let size = 0, mtime = 0;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch {}
    return { path: p, name: n, ext: extOf(n), kind: AUDIO_EXT.includes(extOf(n)) ? 'audio' : 'video', size, mtime };
  });
}

// ---------- local server ----------
let server = null, port = 0;
const token = crypto.randomBytes(12).toString('hex');
let cacheDir = path.join(os.tmpdir(), 'the-player-cache');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');

function cacheKey(...parts) { return crypto.createHash('sha1').update(parts.join('|')).digest('hex'); }

// one ffmpeg job per output file; concurrent requests for the same file wait on the same promise
const jobs = new Map();
let running = 0; const queue = [];
function runFF(args, out) {
  if (jobs.has(out)) return jobs.get(out);
  const p = new Promise((resolve, reject) => {
    const go = () => {
      running++;
      const tmp = out + '.part' + path.extname(out);
      execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, tmp], { windowsHide: true, timeout: 120000 }, (err) => {
        running--; if (queue.length) queue.shift()();
        if (err || !fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} return reject(err || new Error('ffmpeg failed')); }
        try { fs.renameSync(tmp, out); } catch {}
        resolve(out);
      });
    };
    running < 4 ? go() : queue.push(go);
  });
  jobs.set(out, p);
  p.finally(() => jobs.delete(out)).catch(() => {});
  return p;
}

async function frameFile(file, { t, p, w = 320 }) {
  const info = await probe(file);
  let at = t != null && t !== '' ? Number(t) : (Number(p || 0.3) * (info.duration || 0));
  at = Math.max(0, Math.min(at, Math.max(0, (info.duration || 0) - 0.05)));
  w = Math.max(32, Math.min(1920, Math.round(Number(w) || 320)));
  const out = path.join(cacheDir, cacheKey('frame', file, info.size, info.mtime, at.toFixed(2), w) + '.jpg');
  if (fs.existsSync(out)) return out;
  if (!info.video) throw new Error('no video');
  return runFF(['-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '4'], out);
}

async function waveFile(file, { w = 1800, h = 120, c = 'b9bec7' }) {
  const info = await probe(file);
  if (!info.audio) throw new Error('no audio');
  w = Math.max(100, Math.min(4000, Math.round(Number(w) || 1800)));
  h = Math.max(16, Math.min(600, Math.round(Number(h) || 120)));
  c = String(c).replace(/[^0-9a-f]/gi, '').slice(0, 6) || 'b9bec7';
  const out = path.join(cacheDir, cacheKey('wave', file, info.size, info.mtime, w, h, c) + '.png');
  if (fs.existsSync(out)) return out;
  return runFF(['-i', file, '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${w}x${h}:colors=0x${c}:scale=sqrt`, '-frames:v', '1'], out);
}

function streamArgs(file, info, t) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (t > 0) args.push('-ss', t.toFixed(3));
  args.push('-i', file);
  if (info.video) {
    const enc = encoderNow();
    const g = String(Math.max(12, Math.round(info.video.fps || 30)));
    args.push('-map', '0:v:0', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p');
    if (enc === 'h264_nvenc') args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-g', g);
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', g);
  } else args.push('-vn');
  if (info.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k', '-ac', '2');
  args.push('-sn', '-dn', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  return args;
}

const live = new Set();
function startServer() {
  if (server) return Promise.resolve(port);
  fs.mkdirSync(cacheDir, { recursive: true });
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== token) { res.writeHead(403); return res.end(); }
    const route = parts[1];
    const file = unb64(u.searchParams.get('f'));
    const q = Object.fromEntries(u.searchParams);
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      if (route === 'frame' || route === 'wave') {
        const out = route === 'frame' ? await frameFile(file, q) : await waveFile(file, q);
        res.writeHead(200, { 'Content-Type': route === 'frame' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'max-age=31536000' });
        return fs.createReadStream(out).pipe(res);
      }
      if (route === 'stream') {
        const info = await probe(file);
        if (info.video) await detectEncoder(); // instant after the first time (cached on disk)
        const t = Math.max(0, Number(q.t) || 0);
        const ff = spawn(FFMPEG, streamArgs(file, info, t), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        live.add(ff);
        let errText = '';
        ff.stderr.on('data', (d) => { errText += d; if (errText.length > 4000) errText = errText.slice(-4000); });
        res.writeHead(200, { 'Content-Type': info.video ? 'video/mp4' : 'audio/mp4', 'Cache-Control': 'no-store' });
        ff.stdout.pipe(res);
        const kill = () => { try { ff.kill('SIGKILL'); } catch {} live.delete(ff); };
        req.on('close', kill);
        ff.on('close', (code) => { live.delete(ff); if (code && errText) console.error('[stream]', errText.trim().split('\n').slice(-2).join(' | ')); res.end(); });
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e && e.message || e));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); }));
}

function stopAll() { if (diskProbeTimer) saveDiskProbe(true); for (const ff of live) { try { ff.kill('SIGKILL'); } catch {} } live.clear(); try { server && server.close(); } catch {} }

module.exports = {
  VIDEO_EXT, AUDIO_EXT, MEDIA_EXT, isMedia, extOf,
  FFMPEG, FFPROBE, detectEncoder, encoderNow, probe, details, siblings, startServer, stopAll,
  base: () => `http://127.0.0.1:${port}/${token}`, b64,
  setCacheDir: (d) => { cacheDir = d; loadDiskProbe(d); },
};
