// the player — main process. One window, frameless (every look draws its own title bar).
// The window takes the shape of the video it plays, so a 16:9 film fills it edge to edge.
// bare program names (where, reg…) must never resolve to a file in the current folder — the opened video's folder
process.env.NoDefaultCurrentDirectoryInExePath = '1';
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('./media');
const winreg = require('./winreg');
const library = require('./library');
const settingsStore = require('./settings');

const QA = process.env.ALVA_QA === '1';
// test runs are silent: the author is working on the same machine (playback is still tested, just never heard)
if (QA) app.commandLine.appendSwitch('mute-audio');
const APP_NAME = 'the player';
const OLD_NAME = 'alva player'; // the name before 2026-10-13: settings and shortcuts carry over from it
if (process.env.ALVA_USER_DATA) app.setPath('userData', process.env.ALVA_USER_DATA);
app.setAppUserModelId('alva.player');

const APP_DIR = path.join(__dirname, '..', '..');
const ICON = path.join(APP_DIR, 'assets', 'icon.ico');
const MIN_W = 480, MIN_H = 300;
// space each look puts around the video (used only to size the very first window; the page measures the rest)
const LOOK_EXTRA = { glass: [0, 0], editbay: [328, 278], alva: [0, 272] };

function fileFromArgs(argv) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    try { if (media.isMedia(a) && fs.statSync(a).isFile()) return path.resolve(a); } catch {}
  }
  return null;
}

// `the player.exe --register-default` (run by the installer) writes the Windows registration (+ shortcuts unless --quiet),
// then quits.
// `--uninstall` (Installed apps › Uninstall) removes it; `--quiet` = no Settings page / no message box.
const REGISTER_ONLY = process.argv.includes('--register-default');
const UNINSTALL_ONLY = process.argv.includes('--uninstall');
const QUIET = process.argv.includes('--quiet');
// QA skips the lock (several test windows at once) unless it is testing the hand-off itself
const gotLock = REGISTER_ONLY || (QA && process.env.ALVA_QA_LOCK !== '1') || app.requestSingleInstanceLock();
if (!gotLock && !UNINSTALL_ONLY) app.quit(); // the uninstaller stays to say "close the player first"

let win = null, settings = null, view = 'home', lastExtras = [0, 0];
let pendingFile = fileFromArgs(process.argv);
// --background: started with Windows — load everything, show nothing, wait for the first file
const BACKGROUND = process.argv.includes('--background');
let quitting = false, tray = null, closingAnimated = false;
// "stay ready": closing the window hides it and keeps the player loaded, so the next file opens almost instantly
const stayReady = () => !!settings && settings.get().stayReady !== false && (!QA || process.env.ALVA_QA_STAY === '1');

// ---------- window geometry ----------
const centeredAt = (cx, cy, w, h) => ({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) });
function workAreaFor(b) { try { return screen.getDisplayMatching(b).workArea; } catch { return screen.getPrimaryDisplay().workArea; } }
function keepInside(b, wa) {
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
  return { width, height, x: Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width), y: Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height) };
}
// QA never puts a window on a screen: everything is computed the same way, then parked off to the left
const place = (b) => (QA ? { ...b, x: -b.width - 200, y: 0 } : keepInside(b, workAreaFor(b)));

function wrapTarget(aspect, extraW, extraH, from) {
  const area = settings.get().playerArea || 1280 * 720;
  let vw = Math.sqrt(area * aspect), vh = vw / aspect;
  const wa = workAreaFor(from);
  const k = Math.min(1, (wa.width * 0.94 - extraW) / vw, (wa.height * 0.94 - extraH) / vh);
  vw *= k; vh *= k;
  if (vw + extraW < MIN_W) { vw = MIN_W - extraW; vh = vw / aspect; }
  if (vh + extraH < MIN_H) { vh = MIN_H - extraH; vw = vh * aspect; }
  return place(centeredAt(from.x + from.width / 2, from.y + from.height / 2, vw + extraW, vh + extraH));
}

// smooth resize: the window glides to its new shape (quart-out), instead of jumping
let tweenTimer = null, tweening = false;
function animateTo(to, ms) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  clearInterval(tweenTimer); tweenTimer = null;
  const from = win.getBounds();
  if (['x', 'y', 'width', 'height'].every((k) => Math.abs(from[k] - to[k]) < 1)) return Promise.resolve();
  win.setAspectRatio(0);
  tweening = true;
  const done = () => setTimeout(() => { tweening = false; }, 60);
  if (!ms) { win.setBounds(to); done(); return Promise.resolve(); }
  const t0 = Date.now();
  return new Promise((resolve) => {
    tweenTimer = setInterval(() => {
      if (!win || win.isDestroyed()) { clearInterval(tweenTimer); return resolve(); }
      const k = Math.min(1, (Date.now() - t0) / ms), e = 1 - Math.pow(1 - k, 4);
      const lerp = (a, b) => Math.round(a + (b - a) * e);
      win.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) });
      if (k >= 1) { clearInterval(tweenTimer); tweenTimer = null; done(); resolve(); }
    }, 8);
  });
}

async function initialBounds() {
  const s = settings.get();
  const prev = s.window || {};
  const primary = screen.getPrimaryDisplay().workArea;
  let cx = primary.x + primary.width / 2, cy = primary.y + primary.height / 2;
  if (prev.x != null && prev.width) {
    const c = { x: Math.round(prev.x + prev.width / 2), y: Math.round(prev.y + prev.height / 2) };
    const wa = screen.getDisplayNearestPoint(c).workArea;
    if (c.x >= wa.x && c.x <= wa.x + wa.width && c.y >= wa.y && c.y <= wa.y + wa.height) { cx = c.x; cy = c.y; }
  }
  // the size he left it at (wrapping, when on, then reshapes it around the video)
  let last = s.window && s.window.width ? s.window : (s.homeWindow || { width: 1280, height: 800 });
  // with wrapping on, the saved size may be the last video's shape: the home page gets his home size back
  if (s.wrapWindow && (!pendingFile || s.startOn === 'home') && last.width / last.height < 1.25) last = s.homeWindow || { width: 1280, height: 800 };
  let b = centeredAt(cx, cy, last.width, last.height);
  if (pendingFile && s.startOn !== 'home' && s.wrapWindow) {
    try {
      const info = await media.probe(pendingFile);
      if (info.video) {
        const [ew, eh] = LOOK_EXTRA[s.look] || [0, 0];
        b = wrapTarget(info.video.dispW / info.video.dispH, ew, eh, b);
      }
    } catch {}
  }
  return place(b);
}

let revealed = false;
// Window motion (Settings › Window): instant | smooth | cinematic. The window fades in on a quart-out curve while the
// page grows into place (and blurs into focus on cinematic); closing plays it backwards. Opacity is always left at 1.
const MOTION_MS = { instant: 0, smooth: 210, cinematic: 360 };
const motionMs = () => (settings ? MOTION_MS[settings.get().windowMotion] ?? MOTION_MS.smooth : 0);
let fadeTimer = null;
function fadeWindow(from, to, ms) {
  return new Promise((resolve) => {
    clearInterval(fadeTimer);
    if (!win || win.isDestroyed()) return resolve();
    const t0 = Date.now();
    win.setOpacity(from);
    fadeTimer = setInterval(() => {
      if (!win || win.isDestroyed()) { clearInterval(fadeTimer); fadeTimer = null; return resolve(); }
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = to > from ? 1 - Math.pow(1 - k, 4) : k * k * k; // in: quart-out · out: cubic-in
      win.setOpacity(from + (to - from) * e);
      if (k >= 1) { clearInterval(fadeTimer); fadeTimer = null; resolve(); }
    }, 7);
  });
}
// The page shows the window itself once its first picture is ready; this timer is only a safety net for a page that
// never does. It belongs to ONE showing: revealing or hiding cancels it, so a close that comes before it fires can
// never bring the window back as a half-built "ghost" (bug 2026-10-14: short audio files, closed within 2.5 s).
let revealTimer = null;
function revealLater(ms) { clearTimeout(revealTimer); revealTimer = setTimeout(reveal, ms); }
function reveal() {
  clearTimeout(revealTimer); revealTimer = null;
  if (revealed || !win || win.isDestroyed()) return;
  revealed = true;
  const ms = motionMs();
  // always tell the page: 'in' with 0 ms just clears what a closing fade left behind
  win.webContents.send('win:motion', { dir: 'in', level: settings.get().windowMotion, ms });
  win.setOpacity(ms ? 0 : 1);
  if (QA) win.showInactive(); else { win.show(); win.focus(); }
  if (ms) fadeWindow(0, 1, ms);
}
// the same motion backwards, before the window hides or closes
async function animateOut() {
  const ms = motionMs();
  if (!ms || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  win.webContents.send('win:motion', { dir: 'out', level: settings.get().windowMotion, ms: Math.round(ms * 0.8) });
  await fadeWindow(1, 0, Math.round(ms * 0.8));
}
// closed while staying ready: hidden, video released, waiting for the next file
async function toBackground() {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  else await animateOut();
  if (!win || win.isDestroyed()) return;
  clearTimeout(revealTimer); revealTimer = null;
  win.hide();
  revealed = false; // opacity stays 0 while hidden; reveal() sets it again
  win.webContents.send('win:background');
  ensureTray();
}
// back from the background: the page loads the file (or the home page) and reveals the window itself
function wake(file) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('win:wake', file || null);
  revealLater(2500); // safety net: the page normally reveals itself on its first picture
}
function ensureTray() {
  if (tray || QA) return;
  const img = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME + ' · ready');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open the player', click: () => (win && win.isVisible() ? win.focus() : wake(null)) },
    { type: 'separator' },
    { label: 'Quit the player', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win && win.isVisible() ? win.focus() : wake(null)));
}
// start with Windows (in the background) only while "stay ready" is on, and only for the installed app
function applyLoginItem() {
  if (QA || !app.isPackaged) return;
  const s = settings.get();
  try { app.setLoginItemSettings({ openAtLogin: s.stayReady !== false && s.startWithWindows !== false, path: process.execPath, args: ['--background'] }); } catch {}
}

async function createWindow() {
  const s = settings.get();
  const b = await initialBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: MIN_W, minHeight: MIN_H,
    frame: false, backgroundColor: '#000000', show: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    title: APP_NAME,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  if (s.window && s.window.maximized && !QA && !(pendingFile && s.wrapWindow)) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // the page reveals the window once its first picture is ready (no black flash); this is only a safety net
  if (!BACKGROUND) win.once('ready-to-show', () => revealLater(QA ? 0 : 2500));
  const sendState = () => win && !win.isDestroyed() && win.webContents.send('win:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => {
    if (ev === 'maximize' || ev === 'enter-full-screen') win.setAspectRatio(0);
    sendState();
  });
  let saveTimer = null;
  const saveBounds = () => {
    if (QA || !win || win.isDestroyed() || win.isFullScreen()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isFullScreen()) return;
      const nb = win.getNormalBounds();
      const patch = { window: { width: nb.width, height: nb.height, x: nb.x, y: nb.y, maximized: win.isMaximized() } };
      // his own resizing teaches the player what size he likes, separately for home and for playing
      if (!tweening && !win.isMaximized()) {
        if (view === 'home') patch.homeWindow = { width: nb.width, height: nb.height };
        else if (view === 'player') patch.playerArea = Math.max(200 * 120, (nb.width - lastExtras[0]) * (nb.height - lastExtras[1]));
      }
      settings.set(patch);
    }, 400);
  };
  win.on('resize', () => { if (!tweening) saveBounds(); });
  win.on('move', saveBounds);
  win.on('close', (e) => {
    clearTimeout(saveTimer); settings.flush();
    if (!quitting && stayReady()) { e.preventDefault(); toBackground(); return; }
    // quitting from the window: play the motion out first, then really close
    if (!closingAnimated && motionMs() && win.isVisible() && !win.isMinimized() && !win.isFullScreen()) {
      e.preventDefault(); closingAnimated = true;
      animateOut().then(() => { if (win && !win.isDestroyed()) win.close(); });
    }
  });
  win.on('closed', () => { win = null; });
}

function openInWindow(file) {
  if (win && !win.isDestroyed() && !win.isVisible()) return wake(file); // staying ready in the background
  if (!file) return;
  if (!win) { pendingFile = file; return; }
  if (win.isMinimized()) win.restore();
  if (!QA) win.focus();
  win.webContents.send('open-file', file);
}

app.on('second-instance', (_e, argv) => { if (!argv.includes('--background')) openInWindow(fileFromArgs(argv)); });

// ---------- IPC ----------
ipcMain.handle('init', async () => {
  const port = await media.startServer();
  const f = pendingFile; pendingFile = null;
  return {
    settings: settings.get(), base: media.base(), port, file: f, background: BACKGROUND && !f,
    ffmpeg: !!media.FFMPEG, ffprobe: !!media.FFPROBE, encoder: media.encoderNow(),
    videoExt: media.VIDEO_EXT, audioExt: media.AUDIO_EXT, qa: QA, packaged: app.isPackaged,
  };
});
ipcMain.handle('probe', async (_e, raw) => {
  const file = path.resolve(String(raw));
  const info = await media.probe(file);
  return { ...info, b64: media.b64(file) };
});
// the home page's rows: played history, Downloads, Windows' Recent list (QA points the last two at test folders)
// the home page's lists are read while the window is still loading (the slowest part of opening the app)
function readLibrary() {
  const s = settings.get();
  const dl = process.env.ALVA_DOWNLOADS != null ? process.env.ALVA_DOWNLOADS : app.getPath('downloads');
  const rec = process.env.ALVA_RECENT_DIR != null ? process.env.ALVA_RECENT_DIR : path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');
  const tag = (list) => list.map((x) => ({ ...x, b64: media.b64(x.path) }));
  return Promise.all([library.played(s.recent), library.downloads(dl), library.windowsRecent(rec)])
    .then(([played, downloads, pc]) => ({ played: tag(played), downloads: tag(downloads), pc: tag(pc), downloadsDir: dl }));
}
let libraryEarly = null, libraryEarlyAt = 0; // used once, by the first home page, while still fresh
ipcMain.handle('library', () => {
  const p = Date.now() - libraryEarlyAt < 10000 ? libraryEarly : null;
  libraryEarly = null;
  return p ? p.then((r) => r || readLibrary()) : readLibrary();
});
ipcMain.handle('details', (_e, raw) => media.details(path.resolve(String(raw))));
ipcMain.handle('siblings', (_e, file) => media.siblings(path.resolve(String(file))).map((s) => ({ ...s, b64: media.b64(s.path) })));
ipcMain.handle('b64', (_e, file) => media.b64(file));
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && patch.wrapWindow === false && win && !win.isDestroyed()) win.setAspectRatio(0); // wrapping off releases the shape lock
  const out = settings.set(patch);
  if (patch && ('stayReady' in patch || 'startWithWindows' in patch)) applyLoginItem();
  return out;
});
ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a video or audio file', properties: ['openFile'],
    filters: [{ name: 'Video and audio', extensions: [...media.VIDEO_EXT, ...media.AUDIO_EXT] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Save frames to…', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('exists', (_e, file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
// Save the exact frame at full source resolution. FFmpeg decodes it from the file, so it works for every format.
// `frame` is the frame index; seeking to just before its timestamp makes FFmpeg return that frame and no other.
ipcMain.handle('snapshot', async (_e, { file, frame, fps, name }) => {
  const dir = settings.get().snapshotDir || app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, '_');
  let out = path.join(dir, safe + '.png'), n = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${safe} (${n++}).png`);
  const t = Math.max(0, (Number(frame) - 0.02) / (Number(fps) || 30));
  await new Promise((resolve, reject) => execFile(media.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', file, '-frames:v', '1', '-y', out],
    { windowsHide: true, timeout: 60000 }, (err) => (err || !fs.existsSync(out) ? reject(new Error('Could not save the frame')) : resolve())));
  return out;
});
ipcMain.handle('reveal-file', (_e, file) => shell.showItemInFolder(file));
ipcMain.on('win', (_e, cmd, arg) => {
  if (!win) return;
  if (cmd === 'min') win.minimize();
  else if (cmd === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (cmd === 'close') win.close();
  else if (cmd === 'fullscreen') win.setFullScreen(arg == null ? !win.isFullScreen() : !!arg);
  else if (cmd === 'title') win.setTitle(String(arg || APP_NAME));
});
ipcMain.on('view', (_e, v) => { view = v; if (win && v !== 'player') win.setAspectRatio(0); });
ipcMain.on('reveal', () => reveal());
// take the video's shape; `extra` is the space the look puts around the video
ipcMain.handle('win:wrap', async (_e, { aspect, extraW = 0, extraH = 0, ms = 380 } = {}) => {
  if (!win || !aspect) return { skipped: true };
  if (!settings.get().wrapWindow) { win.setAspectRatio(0); return { skipped: true }; }
  if (win.isMaximized() || win.isFullScreen()) return { skipped: true };
  lastExtras = [Math.round(extraW), Math.round(extraH)];
  await animateTo(wrapTarget(aspect, extraW, extraH, win.getBounds()), ms);
  // keep the shape while he drags the edges (exact only when the video is the whole window)
  if (win && !win.isDestroyed() && extraW < 1 && extraH < 1 && view === 'player') win.setAspectRatio(aspect);
  return { bounds: win.getBounds() };
});
// back on the home page: a tall or square player window goes back to his home size; landscape windows stay
ipcMain.handle('win:home', async (_e, { ms = 380 } = {}) => {
  if (!win) return { skipped: true };
  win.setAspectRatio(0);
  if (!settings.get().wrapWindow) return { skipped: true }; // the window was never reshaped
  if (win.isMaximized() || win.isFullScreen()) return { skipped: true };
  const b = win.getBounds();
  if (b.width / b.height >= 1.25) return { skipped: true };
  const h = settings.get().homeWindow || { width: 1280, height: 800 };
  await animateTo(place(centeredAt(b.x + b.width / 2, b.y + b.height / 2, h.width, h.height)), ms);
  return { bounds: win.getBounds() };
});

// ---------- Windows integration (only when the author presses the buttons in Settings) ----------
// the installed app's exe carries the icon (assets sit inside app.asar, which Windows can't read); the dev build uses assets/icon.ico
const iconFile = () => (!app.isPackaged && fs.existsSync(ICON) ? ICON : process.execPath);
function shortcutOpts() {
  return {
    target: process.execPath, args: app.isPackaged ? '' : `"${APP_DIR}"`, cwd: app.isPackaged ? path.dirname(process.execPath) : APP_DIR,
    icon: iconFile(), iconIndex: 0, appUserModelId: 'alva.player', description: APP_NAME,
  };
}
const shortcutDirs = () => [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), app.getPath('desktop')];
const fileIcon = (kind) => path.join(app.isPackaged ? process.resourcesPath : path.join(APP_DIR, 'assets'), `${kind}.ico`);
// installed by superpack (a superpack.json sits next to the exe): the pack owns the Start-menu shortcut,
// the Installed-apps entry and the uninstall, so the player never writes its own
const MANAGED = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'superpack.json'));
function regOptions() {
  const d = new Date();
  return winreg.options({
    managed: MANAGED,
    appName: APP_NAME, execPath: process.execPath, isPackaged: app.isPackaged, appDir: APP_DIR, iconPath: iconFile(),
    // the audio icon sits OUTSIDE app.asar (packager extraResource) so Explorer can read it
    // video files show their own preview in Explorer; where they can't, they get Windows' standard video icon (his call)
    iconVideo: `${path.join(winreg.SYS32, 'wmploc.dll')},-730`, iconAudio: fileIcon('audio'), audioExts: media.AUDIO_EXT,
    version: app.getVersion(), exts: [...media.VIDEO_EXT, ...media.AUDIO_EXT],
    sizeKB: app.isPackaged ? winreg.dirSizeKB(path.dirname(process.execPath)) : 0,
    date: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
  });
}
// machine-wide entries open with registeredAppMachine; per-user ones (if he declined the prompt) with registeredAppUser
const openDefaultApps = (machine) => shell.openExternal(`ms-settings:defaultapps?${machine ? 'registeredAppMachine' : 'registeredAppUser'}=` + encodeURIComponent(APP_NAME));
// Writes everything. The Default-apps entry must be machine-wide on Windows 11 (see winreg.buildMachineRegister):
// with elevate, a missing or outdated one is written behind ONE Windows permission prompt. Returns true when the
// machine-wide entry is in place; false if he said No (then a per-user entry is written instead: Open with still works).
async function registerAll({ elevate }) {
  if (!app.isPackaged) throw new Error('Open the installed player (Start menu) to do this'); // never point Windows at electron.exe
  const o = regOptions();
  let state = await winreg.machineState(o);
  if (state !== 'current' && elevate) {
    try { await winreg.importRegElevated(winreg.buildMachineRegister(o)); state = 'current'; }
    catch (e) { if (!e.declined) throw e; }
  }
  o.machine = state === 'current';
  await winreg.importReg(winreg.buildRegister(o));
  await winreg.notifyShell();
  return o.machine;
}
async function registerDefault() {
  const machine = await registerAll({ elevate: true });
  await openDefaultApps(machine); // only the author can make it the default: Windows asks him there
  return { ok: true, machine };
}
// Settings › Apps › Installed apps › the player › Uninstall runs `the player.exe --uninstall`: the registration and our
// shortcuts go now; the folder goes after this process has exited (see winreg.deleterScript). History and settings
// (%APPDATA%\the player) stay, so a reinstall picks up where he left off. Returns the folder to delete, or null.
const isInstallDir = (dir) => app.isPackaged && path.basename(dir) === APP_NAME && path.basename(path.dirname(dir)) === 'Programs';
async function uninstall() {
  if (!app.isPackaged) throw new Error('the dev build never unregisters the installed app');
  const o = regOptions(), dir = path.dirname(process.execPath), del = isInstallDir(dir);
  // the machine-wide Default-apps entry goes first (one permission prompt): if he says No, nothing else is removed,
  // so running the uninstall again starts from a whole install
  if ((await winreg.machineState(o)) !== 'none') await winreg.importRegElevated(winreg.buildMachineUnregister(o));
  await winreg.importReg(winreg.buildUnregister(o, await winreg.extState(o.exts), { keepUninstallEntry: del }));
  await winreg.notifyShell();
  for (const d of shortcutDirs()) {
    const lnk = path.join(d, APP_NAME + '.lnk');
    try { if (fs.existsSync(lnk) && isOurShortcut(lnk)) fs.unlinkSync(lnk); } catch {}
  }
  return del ? dir : null;
}
function spawnDeleter(dir) {
  spawn(winreg.POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(winreg.deleterScript(dir, process.pid), 'utf16le').toString('base64')],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref();
}
// Windows 11 keeps his pick in FileExts\<ext>\UserChoiceLatest\ProgId (that key wins when it exists); older builds in
// UserChoice. Picking the exe through "Choose another app" stores Applications\the player.exe instead of our ProgID.
function isDefaultFor(ext) {
  const base = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\`;
  const read = (sub) => new Promise((resolve) => execFile(winreg.REG, ['query', base + sub, '/v', 'ProgId'], { windowsHide: true, cwd: winreg.SYS32 },
    (err, out) => { const m = !err && /ProgId\s+REG_SZ\s+(.+?)\s*$/m.exec(String(out)); resolve(m ? m[1] : null); }));
  const ours = (id) => id === winreg.PROG || id.toLowerCase() === `applications\\${path.basename(process.execPath).toLowerCase()}`;
  return read('UserChoiceLatest\\ProgId').then((latest) => (latest !== null ? ours(latest) : read('UserChoice').then((old) => old !== null && ours(old))));
}
ipcMain.handle('register-default', () => (QA ? { ok: false, qa: true } : registerDefault()));
function makeShortcuts() {
  if (MANAGED) return { ok: true, done: [] };
  const opts = shortcutOpts();
  const done = [];
  for (const dir of shortcutDirs()) {
    const old = path.join(dir, OLD_NAME + '.lnk');
    try { if (fs.existsSync(old) && isOurShortcut(old)) fs.unlinkSync(old); } catch {}
    const lnk = path.join(dir, APP_NAME + '.lnk');
    if (shell.writeShortcutLink(lnk, 'create', opts)) done.push(lnk);
  }
  return { ok: done.length === 2, done };
}
ipcMain.handle('make-shortcuts', () => (QA ? { ok: false, qa: true } : makeShortcuts()));

// The app used to be called "alva player": its settings (history, resume points, looks) move to the new name once.
// If the old app was still open when the new one first ran, it saves its history later — so every launch
// brings across anything newer it wrote (played files, resume points), until he stops using the old one.
function migrateFromOldName() {
  if (QA && !process.env.ALVA_OLD_USER_DATA) return;
  const oldDir = process.env.ALVA_OLD_USER_DATA || path.join(app.getPath('appData'), OLD_NAME);
  const file = path.join(app.getPath('userData'), 'settings.json'), oldFile = path.join(oldDir, 'settings.json');
  try {
    if (!fs.existsSync(oldFile)) return;
    const oldTime = fs.statSync(oldFile).mtimeMs;
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    let cur;
    if (!fs.existsSync(file)) cur = { ...old };
    else {
      cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (oldTime <= (cur.migratedFrom || 0)) return;
      const at = (list) => new Map((list || []).filter((r) => r && r.path).map((r) => [r.path, r.at || 0]));
      const curAt = at(cur.recent), oldAt = at(old.recent);
      const all = new Map(curAt);
      for (const [p, t] of oldAt) if (!all.has(p) || t > all.get(p)) all.set(p, t);
      cur.recent = [...all].map(([p, t]) => ({ path: p, at: t })).sort((a, b) => b.at - a.at).slice(0, 200);
      cur.positions = { ...(cur.positions || {}) };
      // the old file changed since the last merge, so on a tie its resume point is the newer one
      for (const [p, v] of Object.entries(old.positions || {})) if (!(p in cur.positions) || (oldAt.get(p) || 0) >= (curAt.get(p) || 0)) cur.positions[p] = v;
    }
    cur.migratedFrom = oldTime;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(cur, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.error('settings migration failed', e); }
}

// Shortcuts still called "alva player" that point at this app are renamed in place (others are left alone).
function isOurShortcut(lnk) {
  try { const l = shell.readShortcutLink(lnk); return path.resolve(l.target || '') === path.resolve(process.execPath) || String(l.args || '').includes(APP_DIR); } catch { return false; }
}
function renameOldShortcuts() {
  if (QA) return;
  for (const dir of shortcutDirs()) {
    const old = path.join(dir, OLD_NAME + '.lnk');
    try {
      if (!fs.existsSync(old) || !isOurShortcut(old)) continue;
      if (shell.writeShortcutLink(path.join(dir, APP_NAME + '.lnk'), 'create', shortcutOpts())) fs.unlinkSync(old);
    } catch (e) { console.error('shortcut rename failed', e); }
  }
}

app.whenReady().then(async () => {
  if (REGISTER_ONLY) {
    let code = 0;
    try {
      if (QA) {
        // QA never touches the registry: the real builders write their .reg text to files for the checks
        const out = process.env.ALVA_QA_REG_OUT, o = regOptions();
        if (out) {
          fs.writeFileSync(path.join(out, 'register.reg'), winreg.buildRegister({ ...o, machine: false }));
          fs.writeFileSync(path.join(out, 'register-with-machine.reg'), winreg.buildRegister({ ...o, machine: true }));
          fs.writeFileSync(path.join(out, 'register-machine.reg'), winreg.buildMachineRegister(o));
          fs.writeFileSync(path.join(out, 'unregister-machine.reg'), winreg.buildMachineUnregister(o));
        }
      } else if (!app.isPackaged) { console.error('the dev build never registers itself: npm run install-app'); code = 3; }
      else {
        // the installer path (no --quiet) may show the one permission prompt, and points the shortcuts at this exe
        const machine = await registerAll({ elevate: !QUIET });
        if (!QUIET && !makeShortcuts().ok) code = 2;
        if (!QUIET && !(await isDefaultFor('.mp4'))) await openDefaultApps(machine);
      }
    } catch (e) { console.error('registration failed', e); code = 1; }
    app.exit(code);
    return;
  }
  if (UNINSTALL_ONLY) {
    if (!gotLock) {
      if (!QUIET) dialog.showMessageBoxSync({ type: 'info', title: APP_NAME, message: 'the player is open', detail: 'Close it, then uninstall again.' });
      app.exit(1);
      return;
    }
    let code = 0, dir = null, declined = false;
    try {
      if (QA) { if (process.env.ALVA_QA_REG_OUT) { const o = regOptions(); fs.writeFileSync(path.join(process.env.ALVA_QA_REG_OUT, 'unregister.reg'), winreg.buildUnregister(o, await winreg.extState(o.exts), { keepUninstallEntry: isInstallDir(o.installDir) })); } }
      else if (!app.isPackaged) { console.error('the dev build never unregisters: Installed apps › the player › Uninstall'); code = 3; }
      else dir = await uninstall();
    } catch (e) { console.error('uninstall failed', e); code = 1; declined = !!e.declined; }
    if (!QUIET && !QA) dialog.showMessageBoxSync({ type: code ? 'error' : 'info', title: APP_NAME,
      message: code ? (declined ? 'the player was not removed' : 'the player could not be fully removed') : 'the player was removed',
      detail: code ? (declined ? 'Windows needs your permission (Yes) to take it out of Default apps. Run the uninstall again.' : 'Run the uninstall again.') : 'Your history and settings are kept, in case you install it again.' });
    // only now (after the message box) the folder deleter starts: it waits for this process to end
    if (!code && dir) spawnDeleter(dir);
    app.exit(code);
    return;
  }
  if (!gotLock) return;
  migrateFromOldName();
  renameOldShortcuts();
  settings = settingsStore.create(app);
  media.setCacheDir(path.join(app.getPath('userData'), 'cache'));
  // no file to open (or he wants home first): start reading the home lists alongside the window
  if (!pendingFile || settings.get().startOn === 'home') { libraryEarly = readLibrary().catch(() => null); libraryEarlyAt = Date.now(); }
  createWindow();
  applyLoginItem();
  setTimeout(() => media.detectEncoder(), 3000); // background, once per FFmpeg install
});
app.on('window-all-closed', () => { media.stopAll(); app.quit(); });
app.on('before-quit', () => {
  quitting = true; try { settings && settings.flush(); } catch {} media.stopAll(); });
