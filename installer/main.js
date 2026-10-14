// superpack setup window. The Inno installer (superpack-setup.exe) extracts this app to its temp folder and starts it:
//   superpack setup.exe --setup=<the installer exe> --manifest=<installer.json>
// Picking apps happens here; installing is the SAME installer run again silently ("engine"), which writes its progress
// to a small JSON file this window reads. Exit code 0 = closed, 42 = person asked for the classic installer.
// QA: SUPERPACK_QA=1 keeps the window off-screen, installs for the current user (no admin prompt) and quits when done;
//     --fake simulates an install (screenshots), --shots=<dir> saves every screen.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).replace(/^"|"$/g, '') : ''; };
const SETUP = arg('setup');
const QA = process.env.SUPERPACK_QA === '1';
const FAKE = process.argv.includes('--fake');
const MAC = process.platform === 'darwin';
// the app list: given by the Windows installer, inside the Mac app's Resources, or the dev list
const MAC_LIST = MAC && app.isPackaged ? path.join(process.resourcesPath, 'installer.json') : '';
const manifest = JSON.parse(fs.readFileSync(arg('manifest') || MAC_LIST || path.join(__dirname, 'dev-manifest.json'), 'utf8'));
manifest.platform = process.platform;
// each app's words (description + the "More info" page) live in apps.json, next to this file
const INFO = JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.json'), 'utf8'));
manifest.apps = manifest.apps.map((a) => ({ ...a, ...(INFO[a.key] || {}) }));

let win = null;
let busy = false;
let exitCode = 0;

app.disableHardwareAcceleration(); // a setup window doesn't need the GPU, and starts faster without it
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 860, height: 580, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false,
    backgroundColor: '#f6f5f2', title: manifest.title, icon: path.join(__dirname, 'assets', manifest.windowIcon),
    ...(QA ? { x: -4000, y: -4000, skipTaskbar: true } : { center: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { if (QA) win.showInactive(); else win.show(); });
  win.on('close', (e) => { if (busy) e.preventDefault(); }); // never half-install by closing the window
});
app.on('window-all-closed', () => app.exit(exitCode));

ipcMain.handle('manifest', () => ({ ...manifest, qa: QA, fake: FAKE }));
ipcMain.on('minimize', () => win.minimize());
// the "Open source" tag on the welcome page opens the public code (fixed address, nothing else can be opened)
ipcMain.on('repo', () => { if (!QA) shell.openExternal('https://github.com/extraneus9/superpack'); });
ipcMain.on('close', () => { if (!busy) win.close(); });
ipcMain.on('classic', () => { exitCode = 42; busy = false; win.close(); });
ipcMain.on('open', (_e, exe) => {
  if (!lastDir) return;
  if (MAC) {
    const a = manifest.apps.find((x) => x.exe === exe);
    const bundle = a && path.join(lastDir, a.bundle);
    if (bundle && fs.existsSync(bundle)) spawn('/usr/bin/open', [bundle], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const p = path.join(lastDir, exe);
  if (fs.existsSync(p)) spawn(p, [], { detached: true, stdio: 'ignore', cwd: path.dirname(p) }).unref();
});
ipcMain.handle('shot', async (_e, name) => {
  const dir = arg('shots') || (QA && process.env.SUPERPACK_SHOTS);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
});
ipcMain.on('quit', () => { busy = false; app.exit(0); });

// ---------- installing ----------
let lastDir = '';
ipcMain.handle('install', (e, { apps, tasks }) => {
  busy = true;
  const send = (msg) => { if (!win.isDestroyed()) win.webContents.send('progress', msg); };
  if (FAKE) return fakeEngine(apps, send);
  if (MAC) {
    return require('./mac-install.js').macInstall(manifest, apps, tasks, send, { qaDir: QA ? process.env.SUPERPACK_QA_DIR : '' })
      .then((r) => { busy = false; if (r.ok) lastDir = r.dir; return r; })
      .catch((err) => { busy = false; return { ok: false, why: String(err.message || err) }; });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpack-'));
  const prog = path.join(dir, 'progress.json');
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', QA ? '/CURRENTUSER' : '/ALLUSERS',
    `/COMPONENTS=${apps.join(',')}`, `/TASKS=${tasks.join(',')}`, `/progress=${prog}`, `/LOG=${path.join(dir, 'setup.log')}`];
  if (QA && process.env.SUPERPACK_QA_DIR) args.push(`/DIR=${process.env.SUPERPACK_QA_DIR}`);
  const trail = QA && process.env.SUPERPACK_QA_TRAIL; // QA: every progress message, in order
  let last = '';
  let done = null;
  const read = () => {
    let txt = '';
    try { txt = fs.readFileSync(prog, 'utf8'); } catch { return; }
    if (txt === last) return;
    let msg;
    try { msg = JSON.parse(txt); } catch { return; } // caught mid-write: the next read gets it
    last = txt;
    // `ollama pull` writes its own progress bar to a log: the last "NN%" in it is how far the model is
    if (msg.step === 'model') {
      try {
        const all = fs.readFileSync(path.join(dir, 'ollama-pull.log'), 'latin1').match(/(\d{1,3})%/g);
        if (all) msg.p = Number(all[all.length - 1].slice(0, -1)) * 10;
        last = '';
      } catch { /* not started yet */ }
    }
    if (msg.step === 'done') { done = msg; lastDir = msg.note; }
    if (trail) fs.appendFileSync(trail, JSON.stringify(msg) + '\n');
    send(msg);
  };
  const timer = setInterval(read, 120);
  return new Promise((resolve) => {
    let child;
    try { child = spawn(SETUP, args, { windowsHide: true }); } catch (err) { clearInterval(timer); busy = false; resolve({ ok: false, why: String(err.message || err) }); return; }
    child.on('error', (err) => { clearInterval(timer); busy = false; resolve({ ok: false, why: String(err.message || err) }); });
    child.on('exit', (code) => {
      read();
      clearInterval(timer);
      busy = false;
      if (done) resolve({ ok: true, dir: done.note });
      else resolve({ ok: false, code, why: code === 5 || code === 1223 ? 'cancelled' : `setup exited with code ${code}` });
    });
  });
});

// a believable install, for screenshots and UI QA — nothing is written anywhere
function fakeEngine(apps, send) {
  const sizes = apps.map((k) => manifest.apps.find((a) => a.key === k).bytes);
  const total = sizes.reduce((a, b) => a + b, 0);
  const steps = [];
  let acc = 0;
  apps.forEach((k, i) => {
    for (let s = 0; s <= 20; s++) steps.push({ step: 'files', app: k, p: Math.round(((acc + (sizes[i] * s) / 20) / total) * 1000) });
    acc += sizes[i];
  });
  if (apps.includes('player')) steps.push({ step: 'register', app: 'player', p: 1000 });
  if (apps.includes('nomorewriting')) {
    for (let s = 0; s <= 10; s++) steps.push({ step: 'ollama-download', app: 'nomorewriting', p: s * 100 });
    steps.push({ step: 'ollama-install', app: 'nomorewriting', p: 0 });
    for (let s = 0; s <= 10; s++) steps.push({ step: 'model', app: 'nomorewriting', p: s * 100 });
    steps.push({ step: 'speech', app: 'nomorewriting', p: 0 });
  }
  steps.push({ step: 'done', app: '', p: 1000, note: 'C:\\Program Files\\superpack' });
  const hold = Number(arg('hold') || 0); // --hold=N stops at step N (screenshots of a moment mid-install)
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      send(steps[i]);
      if (hold && i === hold) return; // stays here
      if (++i < steps.length) setTimeout(tick, 90);
      else { busy = false; resolve({ ok: true, dir: 'C:\\Program Files\\superpack' }); }
    };
    tick();
  });
}
