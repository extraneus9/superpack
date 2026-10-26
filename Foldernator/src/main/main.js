// Foldernator — Electron main process.
const {
  app, BrowserWindow, ipcMain, protocol, shell, nativeImage, nativeTheme, screen, clipboard, session, desktopCapturer,
} = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Helper, defaultExe } = require('./helper');
const MAC = process.platform === 'darwin';
// on a Mac the C# ShellHelper is replaced by mac-helper.js (same calls, same replies)
const { MacHelper } = MAC ? require('./mac-helper') : {};
const { Settings } = require('./settings');
const { DriveSync, PALETTE } = require('./drive');
const { IconStore } = require('./icons');
const mediaInfo = require('./media-info');

// Electron's dev-only security-warning scanner throws "Invalid URL" on our custom protocols; we ship a strict CSP anyway.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
if (process.platform === 'win32') app.setAppUserModelId('foldernator.app');
if (process.env.ALVA_USER_DATA && !app.isPackaged) app.setPath('userData', process.env.ALVA_USER_DATA); // QA sandbox (dev only)
// test runs are silent: the author works on the same machine (media still loads and plays, just never heard)
if (process.env.ALVA_QA) app.commandLine.appendSwitch('mute-audio');

// The app was called "alva explorer" before: bring its settings along on the first Foldernator launch.
// Its icons folder stays where it is — colored folders' desktop.ini files point at those .ico files.
const LEGACY_DIR = path.join(app.getPath('appData'), 'alva explorer');
function migrateLegacy() {
  if (process.env.ALVA_USER_DATA || app.isPackaged) return; // only the author's dev copy ever had an "alva explorer"
  const dst = path.join(app.getPath('userData'), 'settings.json');
  const src = path.join(LEGACY_DIR, 'settings.json');
  try {
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  } catch (e) { console.error('legacy settings migration failed', e); }
}
function iconsDir() {
  const legacy = path.join(LEGACY_DIR, 'icons');
  return !process.env.ALVA_USER_DATA && fs.existsSync(legacy) ? legacy : path.join(app.getPath('userData'), 'icons');
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'ficon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;
let liveGlass = false; // Liquid Glass: the window shows a live capture of what is behind it
let snipFrozen = false, snipAck = null; // screenshot guard state

// Small diagnostics log (userData/foldernator.log) for the screenshot guard and updates.
function log(...parts) {
  try {
    const f = path.join(app.getPath('userData'), 'foldernator.log');
    try { if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old'); } catch {}
    fs.appendFileSync(f, `${new Date().toISOString()}  ${parts.join(' ')}\n`);
  } catch {}
}

// When Foldernator's own code changes on disk, offer a restart (clicking the shortcut only focuses
// the running window, so an update would otherwise never load).
function watchForUpdates() {
  if (process.env.ALVA_QA || app.isPackaged) return; // the installed app is updated by its installer
  const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'bin')];
  let timer = null;
  for (const dir of roots) {
    try {
      fs.watch(dir, { recursive: true, persistent: false }, (ev, file) => {
        if (!file || !/\.(js|css|html|exe)$/i.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => { log('update detected:', file); send('app:update-ready', file); }, 1500);
      });
    } catch {}
  }
}
let settings, helper, drive, icons, dragIcon;

// ---------- instant search index (worker thread, see index-worker.js) ----------
let indexer = null, ixSeq = 0;
const ixWait = new Map();
function startIndexer() {
  const { Worker } = require('worker_threads');
  indexer = new Worker(path.join(__dirname, 'index-worker.js'), { workerData: { dir: path.join(app.getPath('userData'), 'index') } });
  indexer.on('message', (m) => {
    if (m.id && ixWait.has(m.id)) { const w = ixWait.get(m.id); ixWait.delete(m.id); if (m.error) w.rej(new Error(m.error)); else w.res(m.result !== undefined ? m.result : m.ok); }
    else if (m.event) { log('index', m.event, m.root, m.n, m.ms ? m.ms + 'ms' : ''); send('index:event', m); }
  });
  indexer.on('error', (e) => log('index worker error', e.message));
}
const ix = (cmd, args = {}) => new Promise((res, rej) => {
  if (!indexer) return rej(new Error('index not running'));
  const id = ++ixSeq; ixWait.set(id, { res, rej }); indexer.postMessage({ id, cmd, ...args });
});
// What gets indexed: every ready fixed/removable drive except C:, plus the user folder (C:\Users\<you>,
// without AppData). C:'s system folders stay out — slow to walk, and never what you look for.
async function indexRoots() {
  if (process.env.ALVA_QA) return;
  try {
    const ds = await helper.call('drives');
    const roots = ds.filter((d) => d.ready && ['Fixed', 'Removable'].includes(d.type) && !/^c:/i.test(d.path)).map((d) => d.path);
    roots.push(app.getPath('home'));
    await ix('roots', { roots });
  } catch (e) { log('index roots failed', e.message); }
}

// New devices (USB sticks, SD cards, phones in storage mode, mounted ISOs) show up within ~2 s, with a toast.
// Phones (portable devices) are a slower shell enumeration on the helper's one queue, which icons wait
// behind, so they are checked every third tick.
function watchDevices() {
  let known = null, n = 0, portable = [];
  const tick = async () => {
    try {
      const drivesNow = await helper.call('drives');
      if (n++ % 3 === 0) try { portable = (await helper.call('portable')).map((d) => ({ path: d.path, label: d.name, type: 'Portable', portable: true, ready: true })); } catch {}
      const list = [...drivesNow, ...portable];
      const now = new Map(list.map((d) => [d.path.toLowerCase(), d]));
      if (known) {
        const added = list.filter((d) => !known.has(d.path.toLowerCase()));
        const removed = [...known.values()].filter((d) => !now.has(d.path.toLowerCase()));
        if (added.length || removed.length) { send('drives:changed', { drives: drivesNow, portable, added, removed }); indexRoots(); }
      }
      known = now;
    } catch {}
  };
  tick();
  setInterval(tick, 2000);
}
let shellIconPng = async () => { throw new Error('not ready'); };
const watchers = new Map(); // dir(lower) -> { watcher, dir, timer }

// ---------- helpers ----------
function argvPaths(argv) {
  const appPath = app.getAppPath().toLowerCase();
  return argv.slice(1).filter((a) => !a.startsWith('-')).map((a) => {
    try { return fs.statSync(a).isDirectory() ? path.resolve(a) : null; } catch { return null; }
  }).filter((p) => p && p.toLowerCase() !== appPath);
}

function semaphore(n) {
  let active = 0;
  const q = [];
  const next = () => {
    while (active < n && q.length) {
      const job = q.shift();
      if (job.signal && job.signal.aborted) { job.res(new Response(null, { status: 499 })); continue; }
      active++;
      job.fn().then(job.res, job.rej).finally(() => { active--; next(); });
    }
  };
  return (fn, signal) => new Promise((res, rej) => { q.push({ fn, res, rej, signal }); next(); });
}

async function uniqueName(dir, base, ext = '') {
  let name = base + ext;
  for (let i = 2; i < 10000; i++) {
    try { await fsp.access(path.join(dir, name)); } catch { return name; }
    name = `${base} (${i})${ext}`;
  }
  throw new Error('no free name');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function makeDragIcon() {
  const s = 48, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const inside = x >= 10 && x < 38 && y >= 6 && y < 42 && !(x > 30 && y < 14 && x - 30 > y - 6);
      const edge = inside && (x === 10 || x === 37 || y === 6 || y === 41);
      const i = (y * s + x) * 4;
      if (inside) { buf[i] = edge ? 90 : 245; buf[i + 1] = edge ? 90 : 245; buf[i + 2] = edge ? 90 : 245; buf[i + 3] = 235; }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function isDriveRoot(p) { return MAC ? p === '/' || /^\/Volumes\/[^/]+\/?$/.test(p) : /^[a-z]:\\?$/i.test(p); }

// ---------- floating image viewer ----------
// Its own window (move it to another monitor, keep it beside the folder). Reused while open.
let viewerWin = null, viewerData = null;
function openViewerWindow(data) {
  viewerData = data;
  if (viewerWin && !viewerWin.isDestroyed()) { viewerWin.webContents.send('viewer:load', data); viewerWin.show(); viewerWin.focus(); return; }
  const disp = screen.getDisplayMatching(win ? win.getBounds() : { x: 0, y: 0, width: 1, height: 1 });
  const wa = disp.workArea;
  const w = Math.round(wa.width * 0.62), h = Math.round(wa.height * 0.82);
  viewerWin = new BrowserWindow({
    width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2),
    minWidth: 320, minHeight: 240, show: false, title: 'Foldernator viewer',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-v3.ico'),
    backgroundColor: '#0b0b0b', titleBarStyle: 'hidden',
    ...(MAC ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: '#0b0b0b', symbolColor: '#e6e6e6', height: 40 } }),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  viewerWin.setMenu(null);
  viewerWin.loadFile(path.join(__dirname, '..', 'renderer', 'viewer.html'));
  viewerWin.once('ready-to-show', () => { if (process.env.ALVA_QA) viewerWin.showInactive(); else viewerWin.show(); });
  viewerWin.on('closed', () => { viewerWin = null; });
}

// ---------- window ----------
function createWindow(startPaths = []) {
  const s = settings.get();
  const w = s.window || {};
  win = new BrowserWindow({
    width: w.width || 1280,
    height: w.height || 800,
    x: w.x, y: w.y,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'Foldernator',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-v3.ico'),
    backgroundColor: '#00000000',
    ...(MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 }, vibrancy: 'under-window', visualEffectState: 'followWindow', transparent: false }
      : { backgroundMaterial: 'mica', titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#e6e6e6', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      plugins: true,
    },
  });
  if (w.maximized && !process.env.ALVA_QA) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: {
      ...(startPaths.length ? { open: JSON.stringify(startPaths) } : {}),
      ...(process.env.ALVA_QA ? { qa: '1' } : {}),
      ...(process.argv.includes('--restore-session') ? { restore: '1' } : {}),
    },
  });
  if (process.env.ALVA_QA) {
    // QA runs park the window outside every monitor and never take focus.
    const all = screen.getAllDisplays().map((d) => d.bounds);
    const right = Math.max(...all.map((b) => b.x + b.width));
    win.setSkipTaskbar(true);
    win.setBounds({ x: right + 400, y: 0, width: 1280, height: 800 });
    win.once('ready-to-show', () => win.showInactive());
  } else {
    win.once('ready-to-show', () => win.show());
  }
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? (settings.get().window || {}) : win.getNormalBounds();
    settings.patch({ window: { ...settings.get().window, ...(maximized ? {} : b), maximized } });
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', () => { saveBounds(); settings.flush(); });
  win.on('closed', () => { win = null; if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close(); });
  const sendGlass = () => { if (liveGlass && win && !win.isDestroyed()) send('glass:bounds', glassInfo()); };
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'moved']) win.on(ev, sendGlass);
  win.on('swipe', (e, dir) => { if (dir === 'right') send('nav', 'back'); if (dir === 'left') send('nav', 'forward'); });
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') send('nav', 'back');
    if (cmd === 'browser-forward') send('nav', 'forward');
  });
}

// ---------- live glass ----------
// Where the window's content sits on its monitor (DIP). QA parks the window off-screen, so it pretends
// to sit at the monitor's corner to still exercise the real capture.
function glassInfo() {
  const cb = win.getContentBounds();
  const disp = screen.getDisplayMatching(win.getBounds());
  const content = process.env.ALVA_QA ? { ...cb, x: disp.bounds.x, y: disp.bounds.y } : cb;
  return { content, display: disp.bounds, displayId: String(disp.id), scale: disp.scaleFactor };
}

// Keeps the thumbnail cache bounded: past 30k files, the least recently written half goes (in the background).
function pruneThumbCache(dir) {
  setTimeout(async () => {
    try {
      const names = await fsp.readdir(dir);
      if (names.length < 30000) return;
      const st = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
      st.sort((a, b) => a.t - b.t);
      for (const x of st.slice(0, st.length / 2)) await fsp.unlink(path.join(dir, x.n)).catch(() => {});
    } catch {}
  }, 15000);
}

// ---------- protocols ----------
function registerProtocols() {
  // Thumbnails: Windows' extractor is mostly I/O-bound, so run several at once. Every result is also kept in a
  // disk cache (userData/thumbcache, keyed by path + mtime + size): folders seen before show their thumbnails
  // instantly, even after a restart.
  const thumbs = semaphore(Math.max(6, Math.min(12, require('os').cpus().length)));
  const cacheDir = path.join(app.getPath('userData'), 'thumbcache');
  fs.mkdirSync(cacheDir, { recursive: true });
  pruneThumbCache(cacheDir);
  const png = (buf) => new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' } });
  protocol.handle('thumb', async (req) => {
    const u = new URL(req.url);
    const p = u.searchParams.get('p');
    const s = Math.max(16, Math.min(512, parseInt(u.searchParams.get('s'), 10) || 96));
    let key = null;
    try {
      const st = await fsp.stat(p);
      key = path.join(cacheDir, require('crypto').createHash('sha1').update(`${p.toLowerCase()}|${st.mtimeMs}|${st.size}|${s}`).digest('hex') + '.png');
      return png(await fsp.readFile(key));
    } catch {}
    return thumbs(async () => {
      let img = null;
      try { img = await nativeImage.createThumbnailFromPath(p, { width: s, height: s }); } catch {}
      if (!img || img.isEmpty()) {
        // No thumbnail (codec missing, audio without art…): fall back to the big shell icon.
        try { return new Response(await shellIconPng(p, 256, false), { headers: { 'content-type': 'image/png' } }); } catch { return new Response(null, { status: 404 }); }
      }
      const buf = img.toPNG();
      if (key) fsp.writeFile(key, buf).catch(() => {});
      return png(buf);
    }, req.signal);
  });

  // Real shell icons from the helper (Electron's getFileIcon caches by extension, so every folder looked the same).
  const iconCache = new Map();
  const SIZES = { small: 16, normal: 32, large: 48, jumbo: 256 };
  shellIconPng = async (p, px, isDir) => {
    const ext = path.extname(p).toLowerCase();
    const perFile = isDir || ['.exe', '.lnk', '.ico', '.url', '.msi', '.scr', '.cpl', '.appref-ms', ''].includes(ext);
    const key = (perFile ? p.toLowerCase() : ext) + '|' + px;
    let png = iconCache.get(key);
    if (!png) {
      png = Buffer.from(await helper.call('shellIcon', { path: p, size: px }), 'base64');
      if (iconCache.size > 3000) iconCache.clear();
      iconCache.set(key, png);
    }
    return png;
  };
  protocol.handle('ficon', async (req) => {
    const u = new URL(req.url);
    const p = u.searchParams.get('p');
    const px = SIZES[u.searchParams.get('s')] || 48;
    try {
      const png = await shellIconPng(p, px, u.searchParams.get('d') === '1');
      return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600' } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

// ---------- watchers ----------
function setWatched(dirs) {
  const want = new Map(dirs.filter(Boolean).map((d) => [d.toLowerCase(), d]));
  for (const [k, w] of watchers) {
    if (!want.has(k)) { try { w.watcher.close(); } catch {} clearTimeout(w.timer); watchers.delete(k); }
  }
  for (const [k, d] of want) {
    if (watchers.has(k)) continue;
    try {
      const entry = { dir: d, timer: null, watcher: null };
      const drop = () => { try { entry.watcher.close(); } catch {} clearTimeout(entry.timer); watchers.delete(k); };
      entry.watcher = fs.watch(d, { persistent: false }, (ev, file) => {
        // Deleting/renaming the watched folder itself reports its own absolute path, then repeats that event
        // non-stop (busy loop, and the debounce below would never fire): drop the watcher and reload once so
        // the tab shows "doesn't exist" instead of a stale listing.
        if (file && /^(\\\\\?\\|[a-z]:\\)/i.test(String(file))) { drop(); send('fs:changed', d); return; }
        // one refresh 350 ms after the first change, then one per 350 ms while changes keep coming
        // (resetting the timer on every event meant a folder being written to never refreshed)
        if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = null; send('fs:changed', d); }, 350);
      });
      entry.watcher.on('error', () => { drop(); send('fs:changed', d); });
      watchers.set(k, entry);
    } catch {}
  }
}

// ---------- status ----------
function indexStatus(p, status, color) {
  const idx = { ...(settings.get().statusIndex || {}) };
  const k = p.toLowerCase();
  if (status || color) idx[k] = { path: p, status: status || null, color: color || null, t: Date.now() };
  else delete idx[k];
  settings.set('statusIndex', idx);
}

async function setStatus({ paths, status, color, skipDrive, iconStyle }) {
  const results = [];
  const driveJobs = [];
  for (const p of paths) {
    if (isDriveRoot(p)) { results.push({ path: p, ok: false, error: 'Drive roots can’t take a color' }); continue; }
    try {
      // (the .ico is for Windows Explorer; a Mac shows the colour as a Finder tag instead)
      const icon = color && !MAC ? icons.file(color, iconStyle) : null;
      if (icon && !fs.existsSync(icon)) throw new Error('icon missing for ' + color);
      await helper.call('setFolderStatus', { folder: p, icon, status: status || null, color: color || null });
      indexStatus(p, status, color);
      results.push({ path: p, ok: true });
      if (!skipDrive && settings.get().drive.enabled && drive.mapPath(p)) driveJobs.push(drive.setColor(p, color));
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message });
    }
  }
  if (driveJobs.length) {
    send('toast', { id: 'drive', kind: 'busy', text: `Syncing ${driveJobs.length} folder color${driveJobs.length > 1 ? 's' : ''} to Google Drive…` });
    Promise.all(driveJobs).then((res) => {
      const ok = res.filter((r) => r.ok).length;
      const missing = res.filter((r) => r.skipped).length;
      const failed = res.filter((r) => !r.ok && !r.skipped);
      const parts = [];
      if (ok) parts.push(`${ok} synced to Drive`);
      if (missing) parts.push(`${missing} not on Drive`);
      if (failed.length) parts.push(`${failed.length} failed (${failed[0].reason})`);
      send('toast', { id: 'drive', kind: failed.length ? 'err' : missing && !ok ? 'warn' : 'ok', text: parts.join(' · ') });
    });
  }
  return results;
}

// ---------- Folder previews ----------
// Up to 2 images/videos a folder holds (like Windows 11's folder thumbnails). Direct children first; if the
// folder only has subfolders, the first few subfolders are looked into. Bounded scans, cached by mtime.
const PEEK_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'pdf']);
const peekCache = new Map();
async function scanMedia(dir, limit, cap = 600) {
  const files = [], dirs = [];
  let d;
  try { d = await fsp.opendir(dir); } catch { return { files, dirs }; }
  let n = 0;
  try {
    for await (const e of d) {
      if (++n > cap) break;
      if (e.name.startsWith('.') || e.name === 'desktop.ini') continue;
      if (e.isDirectory()) { if (dirs.length < 40) dirs.push(path.join(dir, e.name)); continue; }
      const ext = e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase();
      if (PEEK_EXT.has(ext)) files.push(path.join(dir, e.name));
    }
  } catch {} finally { try { await d.close(); } catch {} }
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return { files: files.slice(0, limit), dirs: dirs.slice(0, 16), n };
}
async function folderPeek(dir) {
  let m = 0;
  try { m = (await fsp.stat(dir)).mtimeMs; } catch { return []; }
  const c = peekCache.get(dir);
  if (c && c.m === m) return c.files;
  // Breadth-first down to 4 levels (project folders keep their media deep: X/PROJECT FILES/renders/...),
  // bounded by folders visited, entries read and time, so a huge tree never stalls the view.
  let files = [];
  const queue = [{ d: dir, depth: 0 }];
  let visited = 0, budget = 20000;
  const t0 = Date.now();
  const gen = peekGen;
  while (gen === peekGen && queue.length && files.length < 2 && visited < 150 && budget > 0 && Date.now() - t0 < 1500) {
    const { d, depth } = queue.shift();
    visited++;
    const r = await scanMedia(d, 2 - files.length, Math.min(600, budget));
    budget -= Math.max(r.n || 0, 1);
    files = files.concat(r.files);
    if (depth < 4) for (const sub of r.dirs) if (!/[\\/](node_modules|\.git|\$RECYCLE\.BIN|System Volume Information)$/i.test(sub)) queue.push({ d: sub, depth: depth + 1 });
  }
  if (gen !== peekGen && files.length < 2) return null; // interrupted: not cached, asked again next time
  peekCache.set(dir, { m, files });
  return files;
}
const peekLimit = semaphore(2);
let peekGen = 0; // bumped by the renderer on every folder change; older scans stop so the disk serves the new folder first

// ---------- IPC ----------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...args) => fn(...args));

  h('fs:peekReset', () => { peekGen++; });
  h('viewer:open', (data) => { openViewerWindow(data); return true; });
  h('viewer:data', () => viewerData);
  h('image:rotate', ({ path: p, op }) => helper.call('imageRotate', { path: p, op }));
  h('image:crop', ({ path: p, x, y, w, h: hh }) => helper.call('imageCrop', { path: p, x, y, w, h: hh }));
  h('image:wallpaper', (p) => helper.call('setWallpaper', { path: p }));
  h('image:read', (p) => fsp.readFile(p));
  // WinRAR / 7-Zip drops hand over RELATIVE names ("Shabbat Dinner\\0001.jpg", size 0) and extract only
  // after the drop, into %TEMP%\\Rar$DRa….rartemp (7-Zip: 7zO…). Wait for that extraction to finish (sizes
  // stable over two looks) and return the real paths.
  h('drop:resolveRelative', async ({ rels, since }) => {
    const tmp = app.getPath('temp');
    const t0 = Date.now();
    let lastKey = null;
    while (Date.now() - t0 < 180000) {
      let names = [];
      try { names = (await fsp.readdir(tmp)).filter((n) => /^Rar\$DR/i.test(n) || /^7zO/i.test(n)); } catch {}
      const dirs = (await Promise.all(names.map(async (n) => { try { return { n, m: (await fsp.stat(path.join(tmp, n))).mtimeMs }; } catch { return null; } })))
        .filter((d) => d && d.m >= since - 300000).sort((a, b) => b.m - a.m).slice(0, 6);
      let found = false;
      for (const d of dirs) {
        const abs = rels.map((r) => path.join(tmp, d.n, r));
        const sizes = await Promise.all(abs.map((a) => fsp.stat(a).then((s) => s.size).catch(() => -1)));
        if (sizes.every((s) => s >= 0)) {
          found = true;
          const key = d.n + '|' + sizes.join(',');
          if (key === lastKey) return abs;
          lastKey = key;
          break;
        }
      }
      if (!found) lastKey = null;
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error('The archive app didn’t finish extracting in time');
  });
  // A file dropped as data (no path on disk): written into the folder under a free name.
  h('fs:writeDropped', async ({ dir, name, data }) => {
    const safe = String(name || 'dropped file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const ext = path.extname(safe), base = path.basename(safe, ext);
    const n = await uniqueName(dir, base, ext);
    await fsp.writeFile(path.join(dir, n), Buffer.from(data));
    return n;
  });
  // Markup save: overwrite, or "name (edited).ext" next to it. Returns the path written.
  h('image:write', async ({ path: p, data, copy, ext }) => {
    let out = p;
    if (copy) {
      const dir = path.dirname(p), e = '.' + (ext || path.extname(p).slice(1));
      const base = path.basename(p, path.extname(p)) + ' (edited)';
      out = path.join(dir, await uniqueName(dir, base, e));
    }
    await fsp.writeFile(out, Buffer.from(data));
    return out;
  });
  h('image:copy', (p) => { const img = nativeImage.createFromPath(p); if (img.isEmpty()) throw new Error('Can’t read this image'); clipboard.writeImage(img); return true; });
  h('viewer:close', () => { if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close(); });
  ipcMain.on('viewer:shown', (e, p) => send('viewer:shown', p));
  ipcMain.on('log', (e, ...parts) => log('[ui]', ...parts));
  h('fs:peek', async (dirs) => {
    const out = {};
    const g = peekGen;
    await Promise.all((dirs || []).slice(0, 200).map((d) => peekLimit(async () => { out[d] = g === peekGen ? await folderPeek(d) : null; })));
    return out;
  });
  h('app:init', async () => ({
    settings: settings.get(),
    palette: PALETTE,
    paths: {
      home: app.getPath('home'),
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents'),
      pictures: app.getPath('pictures'),
      videos: app.getPath('videos'),
      music: app.getPath('music'),
    },
    version: app.getVersion(),
  }));
  h('settings:patch', (partial) => settings.patch(partial));
  h('settings:set', (key, value) => { settings.set(key, value); return settings.get(); });
  h('settings:reset', () => settings.reset());

  h('window:chrome', ({ color, symbolColor, material, mode }) => {
    if (!win) return;
    if (mode === 'light' || mode === 'dark') nativeTheme.themeSource = mode; // Mica tint + frame follow the theme
    if (MAC) { try { win.setVibrancy(material && material !== 'none' ? 'under-window' : null); } catch {} return; }
    try { win.setTitleBarOverlay({ color, symbolColor, height: 40 }); } catch {}
    try { win.setBackgroundMaterial(material || 'none'); } catch {}
  });
  h('window:devtools', () => win && win.webContents.toggleDevTools());

  h('fs:list', async (dir) => {
    try { return await helper.call('list', { dir }); } catch (e) {
      // The helper (.NET) stops at MAX_PATH; Node reads long paths natively, so fall back for those.
      if (!/too long/i.test(e.message)) throw e;
      const items = [];
      for (const de of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, de.name);
        try { const st = await fsp.stat(p); items.push({ n: de.name, p, d: st.isDirectory(), s: st.isDirectory() ? 0 : st.size, m: st.mtimeMs, c: st.birthtimeMs }); } catch {}
      }
      return { dir, items };
    }
  });
  h('fs:drives', () => helper.call('drives'));
  h('portable:list', () => helper.call('portable'));
  h('index:search', (a) => ix('search', a));
  h('index:status', () => ix('status'));
  h('index:roots', (roots) => ix('roots', { roots }));
  h('index:rebuild', () => ix('rebuild'));
  h('shell:explorerOpen', (p) => { spawn(MAC ? '/usr/bin/open' : 'explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref(); return true; });
  h('shell:list', (p) => helper.call('shellList', { path: p }));
  h('shell:invoke', (p) => helper.call('shellInvoke', { path: p }));
  h('shell:copy', ({ paths, to }) => helper.call('shellCopy', { paths, to }));
  // Disk images: mount an ISO/IMG/VHD(X) like Explorer's "Mount" and return its new drive letter; eject drives.
  const ps = (cmd) => new Promise((res, rej) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error((err || out).trim().split(/\r?\n/)[0] || 'failed'))));
  });
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  h('disk:mount', async (file) => {
    if (MAC) {
      // hdiutil mounts the image and tells where (plist), like Explorer's "Mount" gives a drive letter
      const out = await new Promise((res, rej) => require('child_process').execFile('/usr/bin/hdiutil', ['attach', '-plist', '-nobrowse', file], (e, so) => (e ? rej(e) : res(String(so)))));
      const m = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(out);
      return m ? m[1] : null;
    }
    const letter = await ps(`$img = Mount-DiskImage -ImagePath ${q(file)} -PassThru; Start-Sleep -Milliseconds 400; ($img | Get-Volume | Select-Object -First 1).DriveLetter`);
    return letter ? letter[0] + ':\\' : null;
  });
  h('disk:eject', async (root) => {
    if (MAC) { await new Promise((res, rej) => require('child_process').execFile('/usr/sbin/diskutil', ['eject', String(root)], (e) => (e ? rej(e) : res()))); return true; }
    const L = String(root)[0];
    // a mounted image is dismounted; a USB stick / disc goes through the shell's own Eject (safe removal)
    await ps(`$v = Get-Volume -DriveLetter ${L} -ErrorAction SilentlyContinue; $img = $null; if ($v) { $img = $v | Get-DiskImage -ErrorAction SilentlyContinue }; if ($img) { $img | Dismount-DiskImage | Out-Null } else { (New-Object -ComObject Shell.Application).Namespace(17).ParseName(${q(L + ':\\')}).InvokeVerb('Eject') }`);
    return true;
  });
  h('fs:exists', async (p) => { try { await fsp.access(p); return true; } catch { return false; } });
  h('fs:stat', async (p) => {
    const st = await fsp.stat(p);
    return { size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, isDir: st.isDirectory() };
  });
  h('fs:readText', async (p, max = 256 * 1024) => {
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      const slice = buf.subarray(0, bytesRead);
      const binary = slice.subarray(0, 4096).includes(0);
      return { text: binary ? null : slice.toString('utf8'), truncated: bytesRead === max, binary };
    } finally { await fh.close(); }
  });
  h('fs:mkdir', async (dir, base = 'New folder') => {
    const name = await uniqueName(dir, base);
    await fsp.mkdir(path.join(dir, name));
    return path.join(dir, name);
  });
  h('fs:newFile', async (dir, base = 'New Text Document', ext = '.txt') => {
    const name = await uniqueName(dir, base, ext);
    await fsp.writeFile(path.join(dir, name), '', { flag: 'wx' });
    return path.join(dir, name);
  });
  h('fs:rename', async (from, newName) => {
    newName = newName.trim();
    if (MAC ? !newName || /[/:]/.test(newName) : !newName || /[<>:"/\\|?*\x00-\x1f]/.test(newName) || /[. ]$/.test(newName)) {
      if (MAC) throw new Error('A name can’t contain / or :.');
      throw new Error('A name can’t contain < > : " / \\ | ? * or end with a dot or space.');
    }
    if (!MAC && /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(newName)) throw new Error('That name is reserved by Windows.');
    const to = path.join(path.dirname(from), newName);
    if (to.toLowerCase() !== from.toLowerCase()) {
      try { await fsp.access(to); throw new Error(`“${newName}” already exists here.`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await fsp.rename(from, to);
    return to;
  });
  h('fs:op', async ({ op, paths, to }) => {
    if (!paths || !paths.length) return { aborted: false };
    const renameOnCollision = !!to && paths.every((p) => path.dirname(p).toLowerCase() === to.replace(/\\$/, '').toLowerCase());
    if (op === 'move' && renameOnCollision) return { aborted: false, noop: true };
    return helper.call('fileOp', { op, paths, to: to || null, renameOnCollision });
  });

  h('search:start', (args) => helper.call('search', args));
  h('quickaccess:get', () => helper.call('quickAccess'));
  h('gallery:start', ({ sid, roots }) => helper.call('scan', {
    sid,
    roots: roots && roots.length ? roots : [app.getPath('pictures')],
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff', 'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'],
    max: 6000,
  }));
  h('search:cancel', (sid) => helper.call('searchCancel', { sid }));

  h('shell:open', (p) => shell.openPath(p));
  h('shell:openWith', (p) => helper.call('openWith', { path: p }));
  h('media:details', (p) => mediaInfo.details(String(p)));
  h('shell:properties', (paths) => helper.call('properties', { paths, hwnd: win && !win.isDestroyed() ? Number(win.getNativeWindowHandle().readBigUInt64LE()) : 0 }));
  h('shell:reveal', (p) => shell.showItemInFolder(p));
  h('shell:readLink', async (p) => {
    if (MAC) { try { const t = fs.realpathSync(p); return t === p ? null : { path: t, isDir: fs.statSync(t).isDirectory() }; } catch { return null; } }
    const link = shell.readShortcutLink(p);
    if (!link || !link.target) return null;
    try { return { path: link.target, isDir: fs.statSync(link.target).isDirectory() }; } catch { return { path: link.target, isDir: false }; }
  });
  h('shell:terminal', (dir) => {
    if (MAC) { spawn('/usr/bin/open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref(); return; }
    const child = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dir, detached: true, stdio: 'ignore' }).unref());
    child.unref();
  });
  h('shell:contextMenu', ({ paths, x, y, extended }) => {
    if (MAC) return macMenu(paths, x, y);
    const b = win.getContentBounds();
    const z = win.webContents.getZoomFactor();
    const pt = screen.dipToScreenPoint({ x: Math.round(b.x + x * z), y: Math.round(b.y + y * z) });
    return helper.call('contextMenu', { paths, x: pt.x, y: pt.y, extended: !!extended });
  });

  h('clipboard:setFiles', ({ paths, cut }) => helper.call('clipboardSet', { paths, cut: !!cut }));
  h('clipboard:getFiles', () => helper.call('clipboardGet'));
  h('clipboard:text', (t) => clipboard.writeText(t));

  let lastDrag = null;
  h('drag:last', () => lastDrag);
  ipcMain.on('drag:start', (e, paths) => {
    if (!paths || !paths.length) return;
    lastDrag = { paths, t: Date.now() };
    // Windows' own drag from the helper (works in every app, thumbnail drag image). Electron's startDrag only works
    // inside an HTML drag, which our pointer drag never is — kept as a fallback if the helper fails.
    helper.call('dragOut', { paths }).then((r) => { log('dragOut', JSON.stringify(r)); if (r && r.hr < 0) { try { e.sender.startDrag({ file: paths[0], files: paths, icon: dragIcon }); } catch {} } send('drag:done', r); })
      .catch((err) => { log('dragOut failed', err.message); try { e.sender.startDrag({ file: paths[0], files: paths, icon: dragIcon }); } catch {} });
  });

  h('icons:has', (hex, style) => icons.has(hex, style));
  h('icons:write', ({ hex, images, style }) => icons.write(hex, images, style));

  h('status:set', async (args) => ({ results: await setStatus(args), statusIndex: settings.get().statusIndex }));
  h('status:seen', ({ dir, statuses }) => {
    const idx = { ...(settings.get().statusIndex || {}) };
    const parentKey = dir.replace(/\\$/, '').toLowerCase();
    const present = new Set(statuses.map((s) => s.path.toLowerCase()));
    let changed = false;
    for (const k of Object.keys(idx)) {
      if (path.dirname(k) === parentKey && !present.has(k)) { delete idx[k]; changed = true; }
    }
    for (const s of statuses) {
      const k = s.path.toLowerCase();
      const cur = idx[k];
      if (!cur || cur.status !== s.status || cur.color !== s.color || cur.path !== s.path) {
        idx[k] = { path: s.path, status: s.status || null, color: s.color || null, t: (cur && cur.t) || Date.now() };
        changed = true;
      }
    }
    if (changed) settings.set('statusIndex', idx);
    return changed;
  });
  h('status:board', async (filter) => {
    const idx = { ...(settings.get().statusIndex || {}) };
    const out = [];
    let pruned = false;
    for (const [k, v] of Object.entries(idx)) {
      if (filter && filter !== '*' && v.status !== filter) continue;
      try {
        const st = await fsp.stat(v.path);
        out.push({ n: path.basename(v.path), p: v.path, d: true, s: 0, m: st.mtimeMs, c: st.birthtimeMs, st: v.status, col: v.color });
      } catch {
        delete idx[k];
        pruned = true;
      }
    }
    if (pruned) settings.set('statusIndex', idx);
    return out;
  });

  // Full Google Drive comparison of a folder: every file at every depth, nothing skipped except the
  // desktop.ini Foldernator writes for colors and Windows' Thumbs.db. Results stream per item so badges fill in.
  const deepCache = new Map(); // dir(lower) -> { t, items: {name: info}, summary }
  const deepRunning = new Map();
  const SKIP = new Set(['desktop.ini', 'thumbs.db']);
  const fileName = (rel) => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  h('drive:deep', async (dir, force) => {
    const key = dir.toLowerCase();
    if (!settings.get().drive.enabled || !drive.mapPath(dir)) return { mapped: false };
    const hit = deepCache.get(key);
    if (!force && hit && Date.now() - hit.t < 600000) return { mapped: true, cached: true, items: hit.items, summary: hit.summary };
    if (deepRunning.has(key)) return { mapped: true, running: true };
    const job = (async () => {
      const items = {};
      const emit = (name, info) => { items[name] = info; send('drive:item', { dir, name, info }); };
      try {
        const [top, tree] = await Promise.all([drive.topLevel(dir), helper.call('tree', { dir })]);
        const localFiles = tree.files.filter(([rel]) => !SKIP.has(fileName(rel)));
        const byChild = new Map();
        for (const [rel, size] of localFiles) {
          const i = rel.indexOf('/');
          const child = (i < 0 ? rel : rel.slice(0, i));
          if (!byChild.has(child)) byChild.set(child, []);
          if (i >= 0) byChild.get(child).push([rel.slice(i + 1), size]);
        }
        for (const d of tree.dirs) { const c = d.split('/')[0]; if (!byChild.has(c)) byChild.set(c, []); }
        const topFiles = new Map(localFiles.filter(([rel]) => !rel.includes('/')).map(([rel, size]) => [rel, size]));
        const folders = [...byChild.keys()].filter((c) => !topFiles.has(c));
        send('drive:progress', { dir, done: 0, total: folders.length, remote: top.remote, exists: !!top.exists });
        for (const [name, size] of topFiles) {
          const d = top.exists && top.items.get(name.toLowerCase());
          emit(name, !d ? { state: 'missing' } : d.size == null || d.size === size ? { state: 'ok' } : { state: 'differs' });
        }
        let done = 0;
        const queue = [...folders];
        await Promise.all([0, 1].map(async () => {
          while (queue.length) {
            const name = queue.shift();
            const local = byChild.get(name);
            const d = top.exists && top.items.get(name.toLowerCase());
            if (!d || !d.folder) emit(name, { state: 'missing', total: local.length });
            else {
              let remote;
              try { remote = await drive.subtreeFiles(d.id, top.m.remoteName); } catch (e) { emit(name, { state: 'error', error: e.message }); done++; continue; }
              const miss = local.filter(([rel, size]) => { const s = remote.get(rel.toLowerCase()); return s === undefined || (s != null && s !== size); });
              emit(name, miss.length ? { state: 'partial', missing: miss.length, total: local.length, names: miss.slice(0, 8).map(([rel]) => rel) } : { state: 'ok', total: local.length });
            }
            done++;
            send('drive:progress', { dir, done, total: folders.length, remote: top.remote, exists: !!top.exists });
          }
        }));
        const states = Object.values(items);
        const summary = { remote: top.remote, exists: !!top.exists, ok: states.filter((s) => s.state === 'ok').length, partial: states.filter((s) => s.state === 'partial' || s.state === 'differs').length, missing: states.filter((s) => s.state === 'missing').length, files: localFiles.length };
        deepCache.set(key, { t: Date.now(), items, summary });
        send('drive:done', { dir, summary });
      } catch (e) {
        send('drive:done', { dir, error: e.message });
      } finally {
        deepRunning.delete(key);
      }
    })();
    deepRunning.set(key, job);
    return { mapped: true, started: true };
  });
  h('drive:childColors', async (dir) => {
    try { return await drive.childColors(dir); } catch (e) { return { error: e.message, items: [] }; }
  });
  h('drive:check', async (p) => {
    const m = drive.mapPath(p);
    if (!m) return { mapped: false };
    try { return { mapped: true, remote: m.remote, id: await drive.folderId(m.remote) }; }
    catch (e) { return { mapped: true, remote: m.remote, error: e.message }; }
  });

  h('watch:set', (dirs) => setWatched(dirs));
  h('glass:snip-frozen', () => { if (snipAck) { snipAck(); snipAck = null; } });
  h('glass:snip-test', () => (process.env.ALVA_QA ? helper.call('snipSimulate') : false));
  // Update restarts come back with the same tabs; a normal close starts fresh at Home.
  h('app:relaunch', () => {
    settings.flush();
    helper.stop();
    const args = process.argv.slice(1).filter((a) => a !== '--restore-session');
    app.relaunch({ args: [...args, '--restore-session'] });
    app.exit(0);
  });

  // Live glass: exclude our window from screen capture (so we see what is BEHIND it), then hand the
  // renderer the screen source of the monitor the window is on.
  h('glass:start', async () => {
    liveGlass = true;
    win.setContentProtection(true);
    // Screenshot guard (the author approved): only real runs listen for Win+Shift+S / PrintScreen; QA simulates.
    if (!process.env.ALVA_QA) helper.call('snipGuard', { on: true }).then((r) => log('snip guard on:', JSON.stringify(r))).catch((e) => log('snip guard failed:', e.message));
    const info = glassInfo();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.display_id === info.displayId) || sources[0];
    return { ...info, sourceId: src ? src.id : null };
  });
  h('glass:protect', (on) => { if (win && !win.isDestroyed()) win.setContentProtection(!!on); });
  h('glass:stop', () => {
    liveGlass = false;
    if (!process.env.ALVA_QA) helper.call('snipGuard', { on: false }).catch(() => {});
    if (win && !win.isDestroyed()) win.setContentProtection(false);
  });
}

// ---------- boot ----------
app.whenReady().then(() => {
  migrateLegacy();
  settings = new Settings(app.getPath('userData'));
  icons = new IconStore(iconsDir());
  helper = MAC ? new MacHelper() : new Helper(defaultExe);
  drive = new DriveSync(() => settings.get().drive, (m) => send('toast', m));
  dragIcon = makeDragIcon();
  helper.on('search', (m) => send('search:batch', m));
  // Win+Shift+S / PrintScreen while live glass is on: freeze the glass (same look), let the window be
  // captured, hand the key back to Windows; go live again when the snip UI closes.
  helper.on('snip', async (m) => {
    const t0 = Date.now();
    log('snip key:', m.key, 'live:', liveGlass);
    try {
      if (liveGlass && win && !win.isDestroyed()) {
        snipFrozen = true;
        let acked = false;
        await new Promise((res) => { snipAck = () => { acked = true; res(); }; send('glass:snip-freeze'); setTimeout(res, 150); });
        win.setContentProtection(false);
        log('frozen, ack:', acked, 'protected now:', win.isContentProtected(), `+${Date.now() - t0}ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      helper.call('snipReplay', { dry: !!process.env.ALVA_QA }).then(() => log('key replayed', `+${Date.now() - t0}ms`)).catch((e) => log('replay failed:', e.message));
    }
  });
  helper.on('snipDone', () => { log('snip closed, going live again'); if (snipFrozen) { snipFrozen = false; send('glass:snip-unfreeze'); } });
  helper.on('searchDone', (m) => send('search:done', m));

  const allowed = ['local-fonts', 'clipboard-sanitized-write', 'media'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.includes(perm));

  registerProtocols();
  registerIpc();
  watchForUpdates();
  watchDevices();
  if (process.platform === 'win32') startIndexer(); // the index is Windows-path based; the Mac build keeps the classic search
  setTimeout(indexRoots, 8000); // after startup settles
  log('started, helper:', MAC ? 'mac-helper' : path.basename(defaultExe));
  createWindow(argvPaths(process.argv));
});

app.on('second-instance', (e, argv) => {
  const paths = argvPaths(argv);
  if (!win) return createWindow(paths);
  if (win.isMinimized()) win.restore();
  win.focus();
  send('open-tabs', paths.length ? paths : [app.getPath('home')]);
});

app.on('window-all-closed', () => {
  setWatched([]);
  if (settings) settings.flush();
  if (helper) helper.stop();
  app.quit();
});

// ---------- macOS: Finder-style "More options" menu (Windows shows its own shell menu instead) ----------
function macMenu(paths, x, y) {
  const { Menu } = require('electron');
  const one = paths.length === 1 ? paths[0] : null;
  return new Promise((resolve) => {
    let chosen = null;
    const pick = (action, fn) => () => { chosen = action; if (fn) fn(); };
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: pick('open', () => paths.forEach((p) => shell.openPath(p))) },
      ...(one ? [{ label: 'Open With…', click: pick('openWith', () => helper.call('openWith', { path: one }).catch(() => {})) }] : []),
      { label: 'Quick Look', click: pick('quicklook', () => spawn('/usr/bin/qlmanage', ['-p', ...paths], { detached: true, stdio: 'ignore' }).unref()) },
      { type: 'separator' },
      { label: 'Get Info', click: pick('info', () => helper.call('properties', { paths }).catch(() => {})) },
      ...(one ? [{ label: 'Rename', click: pick('rename') }] : []),
      { label: 'Compress', click: pick('compress', () => macCompress(paths)) },
      { label: 'Show in Finder', click: pick('reveal', () => shell.showItemInFolder(paths[0])) },
      { type: 'separator' },
      { label: 'Copy', click: pick('copy') },
      { label: 'Cut', click: pick('cut') },
      { label: 'Paste', click: pick('paste') },
      { type: 'separator' },
      { label: 'Move to Trash', click: pick('delete') },
    ]);
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y), callback: () => setTimeout(() => resolve({ chosen: !!chosen, action: chosen }), 0) });
  });
}
// Finder's "Compress": one item → "<name>.zip", several → "Archive.zip"
function macCompress(paths) {
  const dir = path.dirname(paths[0]);
  let name = paths.length === 1 ? path.basename(paths[0]) + '.zip' : 'Archive.zip';
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = (paths.length === 1 ? path.basename(paths[0]) : 'Archive') + ' ' + i + '.zip';
  const args = paths.length === 1 ? ['-c', '-k', '--sequesterRsrc', '--keepParent', paths[0], path.join(dir, name)] : null;
  if (args) spawn('/usr/bin/ditto', args, { stdio: 'ignore' });
  else spawn('/usr/bin/zip', ['-r', '-q', path.join(dir, name), ...paths.map((p) => path.basename(p))], { cwd: dir, stdio: 'ignore' });
}

