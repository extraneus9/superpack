// macOS stand-in for bin/ShellHelper.exe. Same calls, same replies, same events ('search', 'searchDone'), so main.js
// talks to it exactly like the Windows helper. Built from Node + Electron + the tools every Mac has (osascript/JXA,
// sips, hdiutil): nothing to compile.
//   Status colours: the folder keeps its status in a hidden `.foldernator` file (like desktop.ini on Windows, so it
//   travels with the folder) and gets the matching Finder tag + colour label, so Finder shows it too.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const electron = (() => { try { return require('electron'); } catch { return {}; } })();
const STATUS_FILE = '.foldernator';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
});
// JavaScript for Automation with the Objective-C bridge (Finder tags, NSWorkspace, …); argv arrives as strings
const jxa = (body, args = []) => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `function run(argv) { ${body} }`, ...args.map(String)]);
const osa = (script, args = []) => run('/usr/bin/osascript', ['-e', script, ...args.map(String)]);

function entry(p, name, st, lst) {
  const d = st.isDirectory();
  const e = { n: name, p, d, s: d ? 0 : st.size, m: st.mtimeMs, c: st.birthtimeMs };
  if (name.startsWith('.')) e.h = true;
  if (lst && lst.isSymbolicLink()) e.l = true;
  return e;
}
async function statusOf(dir) {
  try { const j = JSON.parse(await fsp.readFile(path.join(dir, STATUS_FILE), 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}
// a few at a time: listing a folder with thousands of entries mustn't open thousands of files at once
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Finder's seven colour labels (NSURLLabelNumberKey): 1 Gray 2 Green 3 Purple 4 Blue 5 Yellow 6 Red 7 Orange
const FINDER = [[1, 'Gray', 0, 0], [2, 'Green', 120, 1], [3, 'Purple', 280, 1], [4, 'Blue', 215, 1], [5, 'Yellow', 55, 1], [6, 'Red', 0, 1], [7, 'Orange', 30, 1]];
function finderLabel(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  if (c < 0.12) return 1; // greys
  let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h = (h * 60 + 360) % 360;
  let best = 6, bd = 999;
  for (const [num, , hue, chroma] of FINDER) {
    if (!chroma) continue;
    const dist = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (dist < bd) { bd = dist; best = num; }
  }
  return best;
}

class MacHelper extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // sid → { cancel }
    this.cut = null;       // the paths last put on the clipboard with Cut (macOS has no "cut" for files)
  }

  async call(cmd, a = {}) {
    switch (cmd) {
      case 'ping': return 'pong';
      case 'exit': return true;
      case 'list': return this.list(a.dir);
      case 'drives': return this.drives();
      case 'portable': return [];
      case 'quickAccess': return this.quickAccess();
      case 'search': return this.walk(a.sid, [a.root], { query: a.query, hidden: !!a.hidden, max: 5000 });
      case 'scan': return this.walk(a.sid, a.roots || [], { exts: a.exts || [], max: a.max || 5000 });
      case 'searchCancel': { const j = this.jobs.get(a.sid); if (j) j.cancel = true; return true; }
      case 'tree': return this.tree(a.dir);
      case 'fileOp': return this.fileOp(a.op, a.paths || [], a.to, !!a.renameOnCollision);
      case 'setFolderStatus': return this.setFolderStatus(a.folder, a.status, a.color);
      case 'clipboardSet': return this.clipboardSet(a.paths || [], !!a.cut);
      case 'clipboardGet': return this.clipboardGet();
      case 'shellIcon': return this.icon(a.path, a.size || 32);
      case 'properties': return this.getInfo(a.paths || []);
      case 'openWith': return this.openWith(a.path);
      case 'dragOut': return { hr: -1 }; // main.js falls back to Electron's own drag, which is native on a Mac
      case 'imageRotate': return this.rotate(a.path, a.op);
      case 'imageCrop': return run('/usr/bin/sips', ['-c', String(a.h), String(a.w), '--cropOffset', String(a.y), String(a.x), a.path]).then(() => true);
      case 'setWallpaper': return osa('on run argv\ntell application "System Events" to tell every desktop to set picture to (item 1 of argv)\nend run', [a.path]).then(() => true);
      case 'notify': case 'snipGuard': case 'snipReplay': case 'snipSimulate': return true; // Windows-only extras
      default: throw new Error(`${cmd} isn't available on macOS`);
    }
  }

  stop() { for (const j of this.jobs.values()) j.cancel = true; }

  // ---------- folders ----------
  async list(dir) {
    const names = await fsp.readdir(dir);
    const items = (await mapLimit(names, 64, async (name) => {
      if (name === STATUS_FILE || name === '.DS_Store' || name === 'Icon\r') return null;
      const p = path.join(dir, name);
      try {
        const lst = await fsp.lstat(p);
        const st = lst.isSymbolicLink() ? await fsp.stat(p).catch(() => lst) : lst;
        const e = entry(p, name, st, lst);
        if (e.d) { const s = await statusOf(p); if (s) { if (s.status) e.st = s.status; if (s.color) e.col = s.color; } }
        return e;
      } catch { return null; }
    })).filter(Boolean);
    return { dir: path.resolve(dir), items };
  }

  async drives() {
    const out = [];
    const add = async (p, label, type) => {
      try {
        const s = await fsp.statfs(p);
        out.push({ path: p, type, ready: true, label, total: s.blocks * s.bsize, free: s.bavail * s.bsize, format: '' });
      } catch { out.push({ path: p, type, ready: false, label }); }
    };
    await add('/', 'Macintosh HD', 'Fixed');
    let vols = [];
    try { vols = await fsp.readdir('/Volumes'); } catch {}
    for (const v of vols) {
      const p = path.join('/Volumes', v);
      try { if ((await fsp.realpath(p)) === '/') continue; } catch { continue; } // the start-up disk's own alias
      await add(p, v, 'Removable');
    }
    return out;
  }

  // Finder-style places for the sidebar's pinned list (Home's recents stay empty: macOS keeps those private)
  async quickAccess() {
    const home = os.homedir();
    const places = [['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Downloads', 'Downloads'], ['Movies', 'Movies'], ['Music', 'Music'], ['Pictures', 'Pictures']]
      .map(([name, sub]) => ({ name, path: path.join(home, sub) }));
    places.push({ name: 'Applications', path: '/Applications' });
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    if (fs.existsSync(icloud)) places.push({ name: 'iCloud Drive', path: icloud });
    return places.filter((x) => fs.existsSync(x.path)).map((x) => ({ ...x, pinned: true, folder: true }));
  }

  // search (name contains / wildcard) and gallery scan (by extension): streamed in batches like the Windows helper
  walk(sid, roots, { query, hidden, exts, max }) {
    const job = { cancel: false };
    this.jobs.set(sid, job);
    const q = (query || '').toLowerCase();
    const rx = /[*?]/.test(q) ? new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const extSet = exts ? new Set(exts.map((e) => '.' + String(e).replace(/^\./, '').toLowerCase())) : null;
    (async () => {
      let batch = [], total = 0, scanned = 0, last = Date.now();
      const flush = () => { if (batch.length) { this.emit('search', { sid, items: batch, scanned }); batch = []; last = Date.now(); } };
      const stack = [...roots].reverse();
      try {
        while (stack.length && !job.cancel && total < max) {
          const cur = stack.pop();
          let ents;
          try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
          for (const de of ents) {
            if (job.cancel || total >= max) break;
            scanned++;
            const hid = de.name.startsWith('.');
            if (hid && !hidden) continue;
            const p = path.join(cur, de.name);
            if (de.isDirectory()) stack.push(p);
            const name = de.name.toLowerCase();
            const hit = extSet ? !de.isDirectory() && extSet.has(path.extname(name)) : rx ? rx.test(name) : name.includes(q);
            if (!hit) continue;
            try { const st = await fsp.stat(p); batch.push(entry(p, de.name, st)); total++; } catch {}
            if (batch.length >= 200 || Date.now() - last > 150) flush();
          }
        }
      } finally {
        flush();
        this.emit('searchDone', { sid, total, scanned, canceled: job.cancel, capped: total >= max });
        this.jobs.delete(sid);
      }
    })();
    return Promise.resolve(true);
  }

  async tree(root) {
    const files = [], dirs = [];
    const stack = [[root.replace(/\/+$/, ''), '']];
    while (stack.length) {
      const [cur, rel] = stack.pop();
      let ents;
      try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
      for (const de of ents) {
        if (de.name === STATUS_FILE || de.name === '.DS_Store') continue;
        const r = rel ? `${rel}/${de.name}` : de.name;
        if (de.isDirectory()) { dirs.push(r); stack.push([path.join(cur, de.name), r]); }
        else if (de.isFile()) { try { files.push([r, (await fsp.stat(path.join(cur, de.name))).size]); } catch {} }
      }
    }
    return { files, dirs };
  }

  // ---------- copy / move / trash / delete ----------
  async fileOp(op, paths, to, renameOnCollision) {
    const { shell, dialog, BrowserWindow } = electron;
    const owner = BrowserWindow && BrowserWindow.getFocusedWindow();
    if (op === 'recycle') {
      for (const p of paths) await shell.trashItem(p);
      return { hr: 0, aborted: false };
    }
    if (op === 'delete') {
      const what = paths.length === 1 ? `“${path.basename(paths[0])}”` : `these ${paths.length} items`;
      const r = await dialog.showMessageBox(owner, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Delete ${what} immediately?`, detail: 'You can’t undo this action.' });
      if (r.response !== 0) return { hr: 0, aborted: true };
      for (const p of paths) await fsp.rm(p, { recursive: true, force: true });
      return { hr: 0, aborted: false };
    }
    if (op !== 'copy' && op !== 'move') throw new Error('bad op ' + op);
    let aborted = false, all = null; // all = 'replace' | 'keep' | 'skip' once "Apply to all" is ticked
    for (const src of paths) {
      let dest = path.join(to, path.basename(src));
      if (fs.existsSync(dest)) {
        let choice = renameOnCollision || dest === src ? 'keep' : all;
        if (!choice) {
          const r = await dialog.showMessageBox(owner, {
            type: 'question', buttons: ['Keep Both', 'Stop', 'Replace', 'Skip'], defaultId: 0, cancelId: 1, checkboxLabel: 'Apply to all',
            message: `An item named “${path.basename(src)}” already exists in this location.`,
            detail: 'Do you want to replace it with the one you’re ' + (op === 'move' ? 'moving?' : 'copying?'),
          });
          if (r.response === 1) { aborted = true; break; }
          choice = ['keep', null, 'replace', 'skip'][r.response];
          if (r.checkboxChecked) all = choice;
        }
        if (choice === 'skip') continue;
        if (choice === 'keep') dest = freeName(dest);
        else await fsp.rm(dest, { recursive: true, force: true });
      }
      if (op === 'copy') await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      else {
        try { await fsp.rename(src, dest); } catch (e) {
          if (e.code !== 'EXDEV') throw e; // another disk: copy, then remove the original
          await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
          await fsp.rm(src, { recursive: true, force: true });
        }
      }
    }
    return { hr: 0, aborted };
  }

  // ---------- status colours ----------
  async setFolderStatus(folder, status, color) {
    const file = path.join(folder, STATUS_FILE);
    const prev = await statusOf(folder);
    if (status || color) await fsp.writeFile(file, JSON.stringify({ status: status || null, color: color || null }) + '\n');
    else await fsp.rm(file, { force: true });
    // Finder: the status as a tag (replacing the previous status tag, keeping the person's own tags) + the colour label
    try {
      await jxa(`ObjC.import('Foundation');
        const url = $.NSURL.fileURLWithPath(argv[0]);
        const cur = $(); const ok = url.getResourceValueForKeyError(cur, $.NSURLTagNamesKey, null);
        let tags = []; try { tags = ObjC.deepUnwrap(cur) || []; } catch (e) {}
        tags = (Array.isArray(tags) ? tags : []).filter((t) => t !== argv[1]);
        if (argv[2]) tags.push(argv[2]);
        url.setResourceValueForKeyError($(tags), $.NSURLTagNamesKey, null);
        url.setResourceValueForKeyError($(Number(argv[3])), $.NSURLLabelNumberKey, null);
        return 'ok';`, [folder, (prev && prev.status) || '', status || '', finderLabel(color)]);
    } catch (e) { console.error('[mac-helper] Finder tag:', e.message); } // the colour still shows in Foldernator
    return true;
  }

  // ---------- clipboard: real file copies Finder can paste ----------
  clipboardSet(paths, cut) {
    const { clipboard } = electron;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><array>${paths.map((p) => `<string>${esc(p)}</string>`).join('')}</array></plist>`;
    clipboard.clear();
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plist, 'utf8'));
    if (paths.length) clipboard.writeBuffer('public.file-url', Buffer.from(require('url').pathToFileURL(paths[0]).href, 'utf8'));
    this.cut = cut ? paths.slice() : null;
    return true;
  }
  clipboardGet() {
    const { clipboard } = electron;
    let paths = [];
    try {
      const xml = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
      paths = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
    } catch {}
    if (!paths.length) {
      try { const u = clipboard.read('public.file-url'); if (u) paths = [require('url').fileURLToPath(u)]; } catch {}
    }
    const cut = !!this.cut && paths.length === this.cut.length && paths.every((p, i) => p === this.cut[i]);
    return { paths, cut };
  }

  // ---------- icons: Finder's own (Quick Look renders the big ones) ----------
  async icon(p, size) {
    const { app, nativeImage } = electron;
    if (size > 32 && fs.existsSync(p)) {
      try { const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size }); if (!img.isEmpty()) return img.toPNG().toString('base64'); } catch {}
    }
    const img = await app.getFileIcon(p, { size: size > 16 ? 'normal' : 'small' });
    return img.toPNG().toString('base64');
  }

  // ---------- Finder windows and dialogs ----------
  async getInfo(paths) {
    for (const p of paths.slice(0, 10)) {
      await osa('on run argv\ntell application "Finder" to open information window of (POSIX file (item 1 of argv) as alias)\nend run', [p]).catch(() => {});
    }
    await osa('tell application "Finder" to activate').catch(() => {});
    return true;
  }
  async openWith(p) {
    // macOS's own "Choose Application" sheet, then open the file with the pick
    let app = '';
    try { app = (await osa('POSIX path of (choose application with prompt "Open with:" as alias)')).trim(); } catch { return { chosen: false }; }
    if (app) await run('/usr/bin/open', ['-a', app, p]);
    return { chosen: !!app };
  }

  async rotate(p, op) {
    // same ops as the Windows helper: left, flipH, flipV, anything else = a quarter turn right
    const args = { left: ['-r', '-90'], flipH: ['-f', 'horizontal'], flipV: ['-f', 'vertical'] }[op] || ['-r', '90'];
    await run('/usr/bin/sips', [...args, p]);
    return true;
  }
}

// "name 2.ext", "name 3.ext" … the way Finder names copies
function freeName(dest) {
  const dir = path.dirname(dest), ext = path.extname(dest), stem = path.basename(dest, ext);
  for (let i = 2; ; i++) { const c = path.join(dir, `${stem} ${i}${ext}`); if (!fs.existsSync(c)) return c; }
}

module.exports = { MacHelper, finderLabel, freeName, STATUS_FILE };
