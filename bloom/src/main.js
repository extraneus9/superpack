// bloom — replaces Windows' notification popups with the alva Bloom pill.
// Reads every toast Windows stores, draws it in a transparent click-through overlay, hides when idle.
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Watcher } = require('./watcher');
const { parseToast } = require('./toast');
const apps = require('./apps');
const sound = require('./sound');
const winpopups = require('./winpopups');

const QA = process.argv.includes('--qa'); // offscreen run driven by scripts/qa.js; never appears on screen
const QA_ONLY = ['{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}', 'WindowsPowerShell', 'v1.0', 'powershell.exe'].join('\\'); // the one app QA may switch
if (QA) {
  app.setPath('userData', path.join(app.getPath('temp'), 'bloom-qa'));
  // every QA run starts like a fresh install: no settings or sounds left over from the last run
  for (const f of ['settings.json', 'sounds', 'history.json']) require('fs').rmSync(path.join(app.getPath('userData'), f), { recursive: true, force: true });
}
if (!QA && !process.argv.includes('--uninstall') && !app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('alva.bloom');

const DESIGNS = ['bloom', 'island', 'glass', 'edge', 'signal', 'rise', 'spin', 'ribbon'];
const HEX = /^#[0-9a-f]{6}$/i;
const ICON = { shape: ['auto', 'circle', 'rounded', 'square'], bg: ['dark', 'colour', 'light', 'none'], size: ['s', 'm', 'l'] };
const DEFAULTS = { position: 'br', design: 'bloom', paused: false, startWithWindows: true, seconds: 'windows', // br = where Windows shows its own
  sound: { on: true, active: null, volume: 100 }, // volume in % (up to 150)
  accent: 'auto', customColors: [], // 'auto' = each app's own colour
  icon: { shape: 'auto', bg: 'dark', size: 'm' },
  hideWindows: false, longText: 'grow' }; // long messages: 'grow' to fit, or 'essentials' only // one-click: Windows' own popup off for every app (undo restores the backup)
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { const j = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); settings = { ...DEFAULTS, ...j, sound: { ...DEFAULTS.sound, ...(j.sound || {}) }, icon: { ...DEFAULTS.icon, ...(j.icon || {}) } }; } catch {}
  if (!settings.sound.active || !sound.list().includes(settings.sound.active)) settings.sound.active = sound.list()[0] || null;
}
function saveSettings() { try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {} }

const W = 520, H = 470; // room for 3 stacked pills (long ones grow taller) plus their glow
const POSITIONS = { tc: 'Top center', tr: 'Top right', br: 'Bottom right', bc: 'Bottom center' };
let win, tray, watcher, shown = false;
const live = new Map(); // notification id -> what a click should open
// Small diagnostic log (%APPDATA%loomloom.log): sound loaded / notification / sound played, so "no sound" can be traced.
function log(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'bloom.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}
`);
  } catch {}
}

// ---------- overlay window ----------
function place() {
  const wa = screen.getPrimaryDisplay().workArea;
  const p = settings.position;
  const x = p.endsWith('c') ? Math.round(wa.x + (wa.width - W) / 2) : wa.x + wa.width - W;
  const y = p[0] === 't' ? wa.y : wa.y + wa.height - H;
  win.setBounds({ x, y, width: W, height: H });
  win.webContents.send('settings', { position: p, design: settings.design, accent: settings.accent, icon: settings.icon, longText: settings.longText });
}

// Windows' own banner time: Settings › Accessibility › Visual effects › "Dismiss notifications after" (default 5 s).
let winSecs = { v: 5, at: 0 };
function windowsSeconds() {
  if (Date.now() - winSecs.at < 60000) return winSecs.v;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Accessibility', '/v', 'MessageDuration'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/MessageDuration\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) winSecs.v = Math.max(1, parseInt(m[1], 16));
  } catch {}
  winSecs.at = Date.now();
  return winSecs.v;
}

// How long one toast stays, the way Windows decides it. 0 = until dismissed.
function secondsFor(t) {
  if (t && /^(reminder|alarm|incomingCall)$/i.test(t.scenario || '')) return 0;
  const base = settings.seconds === 'windows' ? windowsSeconds() : Number(settings.seconds) || 5;
  return t && /^long$/i.test(t.duration || '') ? Math.max(base, 25) : base;
}

function createWindow() {
  win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: QA, backgroundThrottling: false, sandbox: true, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.webContents.on('did-finish-load', place);
  screen.on('display-metrics-changed', place);
  screen.on('display-added', place);
  screen.on('display-removed', place);
}

// Edge Light design: a full-screen, click-through window that only exists while the edges glow.
let edgeWin = null, edgeTimer = null, edgeFlashes = 0;
function flashEdge(colors) {
  const ok = (x) => /^(#[0-9a-f]{3,8}|hsl\([\d\s.%]+\))$/i.test(String(x));
  const list = [].concat(colors || []).filter(ok).slice(0, 4);
  const c = list.length ? list : ['#e0312b'];
  const b = screen.getPrimaryDisplay().bounds;
  if (!edgeWin || edgeWin.isDestroyed()) {
    edgeWin = new BrowserWindow({
      ...b, show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload-edge.js'), offscreen: QA, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    edgeWin.setIgnoreMouseEvents(true);
    edgeWin.setAlwaysOnTop(true, 'screen-saver');
    edgeWin.loadFile(path.join(__dirname, 'edge.html'));
  }
  edgeWin.setBounds(b);
  const go = () => {
    edgeFlashes++;
    if (!QA) edgeWin.showInactive();
    edgeWin.webContents.send('flash', c);
    clearTimeout(edgeTimer);
    edgeTimer = setTimeout(() => { if (edgeWin && !edgeWin.isDestroyed()) edgeWin.destroy(); edgeWin = null; }, 2900); // gone again: no idle window
  };
  if (edgeWin.webContents.isLoading()) edgeWin.webContents.once('did-finish-load', go); else go();
}
ipcMain.on('edge', (_e, color) => { if (settings.design === 'edge') flashEdge(color); });

function present(n) {
  live.set(n.id, n);
  if (!shown && !QA) { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); shown = true; }
  if (!cursorTimer) trackCursor(true);
  remember(n);
  const seconds = n.seconds != null ? n.seconds : secondsFor(null);
  const withSound = settings.sound.on && !!settings.sound.active;
  log(`notify id=${n.id} app=${n.app} sound=${withSound}`);
  win.webContents.send('notify', { id: n.id, app: n.app, title: n.title, body: n.body, icon: n.icon, iconRound: n.iconRound, seconds, sound: withSound });
}

// Click-through is decided from the REAL cursor: while the overlay is up, its position (in window coordinates) goes to
// the overlay ~16x a second, which hit-tests the pills and answers with 'mouse'. Outside the window = click-through.
let cursorTimer = null;
// The click helper (assets/helper/clickwatch.exe, 4 KB): reads the primary mouse button while pills are up, because
// on the author's PC Chromium never delivered real clicks to this overlay even when it was clickable and on top (diag
// 2026-10-19: WindowFromPoint = bloom, nothing above, still no mousedown). A press on a pill → 'press' to the overlay.
let clickHelper = null;
function helperCmd(cmd) {
  if (QA) return;
  if (!clickHelper) {
    const exe = path.join(__dirname, '..', 'assets', 'helper', 'clickwatch.exe').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    try {
      clickHelper = require('child_process').spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      clickHelper.on('error', (e) => { log(`click helper: ${e.message}`); clickHelper = null; });
      clickHelper.on('exit', () => { clickHelper = null; });
      let buf = '';
      clickHelper.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const [kind, px, py] = buf.slice(0, i).trim().split(' '); buf = buf.slice(i + 1);
          if (kind !== 'down' || !win || win.isDestroyed()) continue;
          const c = screen.screenToDipPoint({ x: +px, y: +py }), b = win.getBounds();
          const x = Math.round(c.x - b.x), y = Math.round(c.y - b.y);
          if (x >= 0 && y >= 0 && x < b.width && y < b.height) win.webContents.send('press', { x, y });
        }
      });
    } catch (e) { log(`click helper: ${e.message}`); clickHelper = null; return; }
  }
  try { clickHelper.stdin.write(cmd + '\n'); } catch {}
}
app.on('will-quit', () => { try { clickHelper && clickHelper.kill(); } catch {} });

function trackCursor(on) {
  clearInterval(cursorTimer); cursorTimer = null;
  helperCmd(on ? 'on' : 'off');
  if (!on || QA) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint(), b = win.getBounds();
    const x = c.x - b.x, y = c.y - b.y;
    if (x < 0 || y < 0 || x >= b.width || y >= b.height) win.webContents.send('cursor', null);
    else win.webContents.send('cursor', { x, y });
  }, 60);
}
ipcMain.on('mouse', (_e, ignore, why) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
  // full-screen always-on-top windows (NVIDIA overlay, Windows' own toast host) can sit above us: get back on top to take the click
  if (!ignore && !QA) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
  log(`overlay ${ignore ? 'click-through' : 'CLICKABLE'} (${why || ''})`);
  if (!ignore) diagAbove();
});
// Diagnostic for "clicks never arrive" (2026-10-19): which windows sit above the overlay at the cursor. Read-only, silent,
// at most every 20 s.
let lastDiag = 0;
function diagAbove() {
  if (QA || Date.now() - lastDiag < 20000) return;
  lastDiag = Date.now();
  const c = screen.getCursorScreenPoint();
  const src = path.join(__dirname, 'diag', 'above.ps1');
  const tmp = path.join(app.getPath('temp'), 'bloom-above.ps1'); // asar files can't be run by powershell directly
  try { fs.writeFileSync(tmp, fs.readFileSync(src)); } catch (e) { log(`diag: ${e.message}`); return; }
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp, hwnd, String(c.x), String(c.y)],
    { windowsHide: true, timeout: 20000 }, (e, so, se) => log(`diag at ${c.x},${c.y}: ${String(so || se || (e && e.message)).trim().slice(0, 1500)}`));
}
ipcMain.on('debug', (_e, msg) => log(`overlay: ${msg}`));
ipcMain.on('idle', () => { if (shown) { win.hide(); shown = false; } trackCursor(false); win.setIgnoreMouseEvents(true, { forward: true }); });
ipcMain.on('dismissed', (_e, id) => { live.delete(id); log(`closed id=${id}`); });
ipcMain.on('open', (_e, id) => { const n = live.get(id); live.delete(id); log(`clicked id=${id}`); if (n) activate(n); });

function activate(n) {
  if (QA) return;
  if (n.launch && n.activationType === 'protocol' && /^[a-z][\w+.-]*:/i.test(n.launch) && !/^(file|javascript|data):/i.test(n.launch)) {
    shell.openExternal(n.launch).catch(() => {});
    return;
  }
  if (n.aumid && !/^NotifyIconGeneratedAumid_/i.test(n.aumid) && !/["\r\n]/.test(n.aumid)) {
    spawn('explorer.exe', [`shell:AppsFolder\\${n.aumid}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

// ---------- images ----------
function bestVariant(file) {
  if (fs.existsSync(file)) return file;
  const dir = path.dirname(file), ext = path.extname(file), base = path.basename(file, ext);
  try {
    const hits = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && f.endsWith(ext) && !/contrast-/.test(f));
    hits.sort((a, b) => (+(b.match(/(?:scale|targetsize)-(\d+)/) || [0, 0])[1]) - (+(a.match(/(?:scale|targetsize)-(\d+)/) || [0, 0])[1]));
    return hits.length ? path.join(dir, hits[0]) : null;
  } catch { return null; }
}

function imageData(src, info, aumid) {
  if (!src) return null;
  try {
    if (/^https?:/i.test(src)) return src;
    let file = null;
    if (/^file:/i.test(src)) file = decodeURIComponent(src.replace(/^file:\/*/i, ''));
    else if (/^ms-appx:/i.test(src) && info && info.install) file = bestVariant(path.join(info.install, decodeURIComponent(src.replace(/^ms-appx:\/*/i, ''))));
    else if (/^ms-appdata:/i.test(src)) {
      const fam = (aumid || '').split('!')[0];
      const m = src.match(/^ms-appdata:\/*(local|roaming|temp)\/(.*)$/i);
      if (m) file = path.join(process.env.LOCALAPPDATA, 'Packages', fam, { local: 'LocalState', roaming: 'RoamingState', temp: 'TempState' }[m[1].toLowerCase()], decodeURIComponent(m[2]));
    } else if (/^[a-z]:\\/i.test(src)) file = src;
    if (!file) return null;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const s = img.getSize();
    return (s.width > 128 ? img.resize({ width: 128, quality: 'best' }) : img).toDataURL();
  } catch { return null; }
}

// ---------- incoming toasts ----------
// New apps start with Windows' own popup on (Windows' default for any new sender). While the switch is on, bloom
// keeps it off for them too: a few seconds after any notification (once things are quiet) and every 30 s, it looks
// for senders whose popup is still on and switches off only those. The very first notification of a brand-new app
// can still show Windows' popup once — Windows registers the app at that moment — every later one is bloom only.
let catchTimer = null;
function catchNewApps(delay = 4000) {
  if (!settings.hideWindows || popupBusy) return;
  clearTimeout(catchTimer);
  catchTimer = setTimeout(async () => {
    if (!settings.hideWindows || popupBusy) return;
    const ids = winpopups.pending().filter((id) => !QA || id === QA_ONLY); // QA never touches his other apps
    if (!ids.length) return;
    popupBusy = true; sendState();
    try { const r = await winpopups.hide(ids); log(`new apps: windows popup off for ${ids.join(', ')} ${JSON.stringify(r)}`); }
    catch (e) { log(`new apps FAILED: ${e.message}`); }
    finally { popupBusy = false; sendState(); }
  }, delay);
}

async function onToast(raw) {
  catchNewApps(); // a new sender? its Windows popup goes off a few seconds later
  if (settings.paused) return;
  const t = parseToast(raw.payload);
  if (!t.title && !t.body) return;
  const info = await apps.resolve(raw.aumid);
  const name = (info && info.name) || raw.displayName || apps.prettyName(raw.aumid) || 'Notification';
  const logo = imageData(t.logo, info, raw.aumid);
  present({
    id: raw.id, aumid: raw.aumid, app: name, title: t.title, body: t.body,
    icon: logo || (info && info.iconData) || null, iconRound: !!logo && t.logoRound,
    launch: t.launch, activationType: t.activationType, seconds: secondsFor(t),
  });
}

let testN = 0;
function testNotification() {
  present({ id: -(++testN), app: 'bloom', title: 'This is bloom', body: 'Every Windows notification now arrives like this.', icon: trayIcon().resize({ width: 96 }).toDataURL() });
}

// ---------- tray ----------
function trayIcon() {
  const p = path.join(__dirname, '..', 'assets', 'icon.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open bloom', click: openSettings },
    { label: 'Show a test notification', click: testNotification },
    { type: 'separator' },
    { label: 'Position', submenu: Object.entries(POSITIONS).map(([k, label]) => ({
      label, type: 'radio', checked: settings.position === k, click: () => { setSetting('position', k); testNotification(); },
    })) },
    { label: 'Time on screen', submenu: ['windows', 4, 7, 10].map((s) => ({
      label: s === 'windows' ? `Same as Windows (${windowsSeconds()} s)` : `${s} seconds`, type: 'radio', checked: settings.seconds === s,
      click: () => setSetting('seconds', s),
    })) },
    { label: 'Pause notifications', type: 'checkbox', checked: settings.paused, click: (i) => setSetting('paused', i.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: settings.startWithWindows, enabled: app.isPackaged, click: (i) => setSetting('startWithWindows', i.checked) },
    { type: 'separator' },
    { label: "Hide Windows' own popups…", click: () => shell.openExternal('ms-settings:notifications') },
    { label: 'Quit bloom', click: () => app.quit() },
  ]);
}

// One way in for every change (settings window or tray): validate, save, apply, tell the window.
function setSetting(key, value) {
  if (key === 'position' && POSITIONS[value]) settings.position = value;
  else if (key === 'seconds' && (value === 'windows' || [4, 5, 7, 10].includes(Number(value)))) settings.seconds = value === 'windows' ? 'windows' : Number(value);
  else if (key === 'design' && DESIGNS.includes(value)) settings.design = value;
  else if (key === 'accent' && (value === 'auto' || HEX.test(value))) settings.accent = value;
  else if (key === 'customColors' && Array.isArray(value)) settings.customColors = [...new Set(value.filter((v) => HEX.test(v)).map((v) => v.toLowerCase()))].slice(0, 10);
  else if (key === 'iconShape' && ICON.shape.includes(value)) settings.icon.shape = value;
  else if (key === 'iconBg' && ICON.bg.includes(value)) settings.icon.bg = value;
  else if (key === 'iconSize' && ICON.size.includes(value)) settings.icon.size = value;
  else if (key === 'longText' && ['grow', 'essentials'].includes(value)) settings.longText = value;
  else if (key === 'paused') settings.paused = !!value;
  else if (key === 'startWithWindows') settings.startWithWindows = !!value;
  else if (key === 'soundOn') settings.sound.on = !!value;
  else if (key === 'soundVolume') settings.sound.volume = Math.max(0, Math.min(150, Math.round(Number(value) || 0)));
  else if (key === 'soundActive' && sound.list().includes(value)) settings.sound.active = value;
  else return;
  saveSettings();
  if (['position', 'design', 'accent', 'iconShape', 'iconBg', 'iconSize', 'longText'].includes(key)) place();
  if (key === 'startWithWindows') applyLogin();
  if (key === 'soundVolume' || key === 'soundActive') pushSound();
  if (tray) tray.setContextMenu(buildMenu());
  sendState();
}

// ---------- settings window ----------
let settingsWin = null;
let lastPlayed = null; // QA reads it: proof the overlay really played a sound

// History: every notification bloom drew, newest first, kept across restarts (the "see all" drawer).
const HISTORY_MAX = 200;
let history = [];
const historyFile = () => path.join(app.getPath('userData'), 'history.json');
function loadHistory() { try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')).slice(0, HISTORY_MAX); } catch { history = []; } }
let saveT = null;
function saveHistory() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(historyFile(), JSON.stringify(history)); } catch {} }, 800); }
function remember(n) {
  history.unshift({ app: n.app, title: n.title, body: n.body, icon: n.icon, iconRound: n.iconRound, time: Date.now() });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistory();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('history:new', history[0]);
}

// The overlay plays the sound; it gets the active file's bytes once and decodes them itself.
function pushSound() {
  if (!win || win.isDestroyed()) return;
  const b = settings.sound.active ? sound.bytes(settings.sound.active) : null;
  win.webContents.send('sound', { bytes: b, volume: QA ? 0 : settings.sound.volume / 100 /* QA is always mute: he must never hear tests */, name: settings.sound.active });
}

function stateForWindow() {
  return {
    settings, windowsSeconds: windowsSeconds(), version: app.getVersion(), packaged: app.isPackaged,
    sounds: sound.list().map((f) => ({ file: f, label: sound.label(f), builtin: sound.isBuiltin(f) })), historyCount: history.length, popupBusy, popupPending: settings.hideWindows ? winpopups.pending().length : 0,
  };
}
function sendState() { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:state', stateForWindow()); }

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 1180, height: 840, minWidth: 960, minHeight: 700, // a bit bigger (his ask), still fits his 1382 px-tall work area show: false, title: 'bloom', backgroundColor: '#000000',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), frame: false, // own, bigger window buttons (his ask)
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js'), offscreen: QA, sandbox: true, contextIsolation: true },
  });
  settingsWin.on('maximize', () => settingsWin.webContents.send('win:max', true));
  settingsWin.on('unmaximize', () => settingsWin.webContents.send('win:max', false));
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  if (!QA) settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; }); // closed = freed; bloom keeps running in the tray
  return settingsWin;
}

ipcMain.handle('settings:get', () => stateForWindow());
ipcMain.on('settings:set', (_e, key, value) => setSetting(key, value));
ipcMain.on('settings:test', () => testNotification());
ipcMain.on('settings:windows', () => shell.openExternal('ms-settings:notifications'));
ipcMain.on('settings:quit', () => app.quit());
// ---- one-click "Hide Windows popups" + undo ----
let popupBusy = false;
async function setHideWindows(on) {
  if (popupBusy) return { busy: true };
  popupBusy = true; sendState();
  let r;
  try {
    log(`windows popups switch -> ${on ? 'on' : 'off'}`);
    if (on) { r = await winpopups.hide(QA ? [QA_ONLY] : undefined); settings.hideWindows = true; } // QA never touches his other apps
    else { r = await winpopups.restore(); settings.hideWindows = false; }
    saveSettings();
    log(`windows popups ${on ? 'off' : 'restored'}: ${JSON.stringify(r)}`);
  } catch (e) {
    r = { error: e.message }; log(`windows popups FAILED: ${e.message}`);
  } finally { popupBusy = false; sendState(); }
  return r;
}
ipcMain.handle('popups:set', (_e, on) => setHideWindows(!!on));
// A REAL Windows notification from bloom: with the switch on, only the bloom pill should appear.
ipcMain.handle('popups:test', () => {
  if (QA) return {};
  const { Notification } = require('electron');
  try { new Notification({ title: 'Windows test notification', body: 'With the switch on, only this bloom version should appear.', silent: true }).show(); } catch {}
  return {};
});
ipcMain.handle('history:get', () => history);
ipcMain.on('history:clear', () => { history = []; saveHistory(); sendState(); });
ipcMain.handle('sound:bytes', (_e, file) => sound.bytes(file || settings.sound.active));
ipcMain.on('sound:play', (_e, file) => {
  if (!win || win.isDestroyed()) return;
  const name = file || settings.sound.active;
  if (!name) return;
  win.webContents.send('sound:play', { bytes: name === settings.sound.active ? null : sound.bytes(name), volume: QA ? 0 : settings.sound.volume / 100 /* QA is always mute: he must never hear tests */ });
});
ipcMain.handle('sound:add', (_e, paths) => {
  const added = [], errors = [];
  for (const p of [].concat(paths || []).slice(0, 10)) {
    try { added.push(sound.add(String(p))); } catch (e) { errors.push(`${path.basename(String(p))}: ${e.message}`); }
  }
  if (added.length) { settings.sound.active = added[added.length - 1]; saveSettings(); pushSound(); }
  sendState();
  return { added, errors };
});
ipcMain.on('sound:remove', (_e, file) => {
  sound.remove(file);
  if (settings.sound.active === file) { settings.sound.active = sound.list()[0] || null; saveSettings(); pushSound(); }
  sendState();
});
ipcMain.on('sound:loaded', (_e, info) => log(`sound loaded ${JSON.stringify(info)}`));
ipcMain.on('sound:played', (_e, info) => { lastPlayed = info; log(`sound played ${JSON.stringify(info)}`); if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('sound:played', info); });
ipcMain.on('win:min', () => settingsWin && settingsWin.minimize());
ipcMain.on('win:max', () => settingsWin && (settingsWin.isMaximized() ? settingsWin.unmaximize() : settingsWin.maximize()));
ipcMain.on('win:close', () => settingsWin && settingsWin.close());

function applyLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, path: process.execPath, args: ['--hidden'] }); // at sign-in: tray only, no window
}

// Installed by superpack: the pack owns the Start-menu shortcut (with bloom's AppUserModelID), so don't add a second one.
const IN_PACK = fs.existsSync(path.join(path.dirname(process.execPath), 'superpack.json'));
function ensureShortcut() {
  if (!app.isPackaged || IN_PACK) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'bloom.lnk');
  try {
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create',
      { target: process.execPath, description: 'bloom: notification popups, alva style', appUserModelId: 'alva.bloom' });
  } catch {}
}

// ---------- QA hooks (scripts/qa.js) ----------
function qaHooks() {
  const run = require(path.join(__dirname, '..', 'scripts', 'qa-run.js'));
  win.webContents.once('did-finish-load', () => run({ present, onToast, setHideWindows, catchNewApps, winpopups, secondsFor, windowsSeconds, openSettings, setSetting, history: () => history, sound, pushSound, lastPlayed: () => lastPlayed, edgeFlashes: () => edgeFlashes, edgeWin: () => edgeWin, apps, parseToast, Watcher, win, live, settings, place, app }));
}

// ---------- boot ----------
app.whenReady().then(async () => {
  // Uninstalling (superpack runs `bloom.exe --uninstall`): give Windows its own popups back, drop the startup entry.
  if (process.argv.includes('--uninstall')) {
    try { await winpopups.restore(); } catch (e) { log(`uninstall restore failed: ${e.message}`); }
    try { app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--hidden'] }); } catch {}
    app.exit(0);
    return;
  }
  loadSettings();
  // Sounds are now built into the app (sound.js). Old installs had only the seeded chime copied into their data
  // folder; move them once to the first built-in (his GTA sound in his build, the chime in the public one).
  if (!settings.soundDefaultsV2) {
    if (!settings.sound.active || settings.sound.active === 'bloom chime.wav') settings.sound.active = sound.list()[0] || null;
    settings.soundDefaultsV2 = true;
    saveSettings();
  }
  loadHistory();
  createWindow();
  win.webContents.on('did-finish-load', pushSound);
  if (QA) { qaHooks(); return; }
  tray = new Tray(trayIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('bloom');
  tray.setContextMenu(buildMenu());
  tray.on('click', openSettings);
  applyLogin();
  ensureShortcut();
  const quiet = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!settings.welcomed || !quiet) { settings.welcomed = true; saveSettings(); openSettings(); }
  watcher = new Watcher(onToast);
  // Just signed in (PC up < 10 min, or launched by the startup entry): show what arrived in the last 90 s too.
  const atSignIn = require('os').uptime() < 600 || app.getLoginItemSettings().wasOpenedAtLogin;
  watcher.start(atSignIn ? 90 : 0);
  { const d = screen.getPrimaryDisplay(); log(`started (sign-in catch-up: ${atSignIn}) display ${d.bounds.width}x${d.bounds.height} scale ${d.scaleFactor}`); }
  setTimeout(() => catchNewApps(0), 20000); // apps that appeared while bloom was off
  setInterval(() => catchNewApps(0), 30000); // apps that register without notifying yet
  // warm the app cache for every sender Windows knows, so the first popup already has its icon
  setTimeout(() => {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(require('./watcher').DB, { readOnly: true });
      const ids = db.prepare("select distinct h.PrimaryId id from NotificationHandler h join Notification n on n.HandlerId = h.RecordId where n.Type = 'toast'").all().map((r) => r.id);
      db.close();
      apps.resolveMany(ids);
    } catch {}
  }, 4000);
});

app.on('second-instance', () => openSettings());
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { if (watcher) watcher.stop(); });
