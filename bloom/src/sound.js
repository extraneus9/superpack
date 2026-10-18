// bloom's sound library (absorbed from the old "Notification Sounds" app): files live in %APPDATA%\bloom\sounds.
// Chromium decodes wav/mp3/ogg/m4a/flac/opus itself, so a dropped file is copied as is, no conversion step.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const EXT = new Set(['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);
const MAX_BYTES = 20 * 1024 * 1024;

const dir = () => path.join(app.getPath('userData'), 'sounds');

// Built-in sounds ship inside the app, so they're there on every install with nothing to copy or seed.
// assets/sounds = made for bloom, free to share. assets/sounds-private = the author's own (his GTA sound): only in his
// local build, never in the public pack or source. Listed first, in this order; the first one present is the default.
const ORDER = ['GTA notification.wav', 'bloom chime.wav', 'glass.wav', 'pop.wav', 'rise.wav'];
const BUILTIN_DIRS = ['sounds-private', 'sounds'].map((d) => path.join(__dirname, '..', 'assets', d));
let builtinCache = null;
function builtins() {
  if (builtinCache) return builtinCache;
  const m = new Map();
  for (const d of BUILTIN_DIRS) {
    try { for (const f of fs.readdirSync(d)) if (EXT.has(path.extname(f).toLowerCase()) && !m.has(f)) m.set(f, path.join(d, f)); } catch {}
  }
  const rank = (f) => (ORDER.includes(f) ? ORDER.indexOf(f) : ORDER.length);
  builtinCache = new Map([...m].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])));
  return builtinCache;
}
const isBuiltin = (name) => builtins().has(safeName(name));

function userList() {
  try { return fs.readdirSync(dir()).filter((f) => EXT.has(path.extname(f).toLowerCase())).sort((a, b) => a.localeCompare(b)); } catch { return []; }
}
function list() {
  const b = [...builtins().keys()];
  return [...b, ...userList().filter((f) => !b.includes(f))];
}

function safeName(name) { return path.basename(String(name || '')); }

function bytes(name) {
  const n = safeName(name);
  try { return fs.readFileSync(path.join(dir(), n)); } catch {}
  try { return builtins().has(n) ? fs.readFileSync(builtins().get(n)) : null; } catch { return null; }
}

// Copy a dropped file into the library; returns the stored file name or throws a readable error.
function add(src) {
  const ext = path.extname(src).toLowerCase();
  if (!EXT.has(ext)) throw new Error('That file type is not a sound bloom can play (use wav, mp3, ogg, m4a, flac or opus).');
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error('Not a file.');
  if (st.size > MAX_BYTES) throw new Error('That sound is over 20 MB. Notification sounds should be a few seconds.');
  fs.mkdirSync(dir(), { recursive: true });
  const base = path.basename(src, ext).replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'sound';
  let name = base + ext, i = 2;
  while (fs.existsSync(path.join(dir(), name)) || isBuiltin(name)) {
    if (isBuiltin(name) && !fs.existsSync(path.join(dir(), name))) { name = `${base} (${i++})${ext}`; continue; }
    if (fs.statSync(path.join(dir(), name)).size === st.size) return name; // same file dropped again
    name = `${base} (${i++})${ext}`;
  }
  fs.copyFileSync(src, path.join(dir(), name));
  return name;
}

function remove(name) {
  if (isBuiltin(name)) return; // built-ins stay
  try { fs.rmSync(path.join(dir(), safeName(name)), { force: true }); } catch {}
}

const label = (name) => (name ? path.basename(name, path.extname(name)) : '');

module.exports = { list, bytes, add, remove, label, dir, isBuiltin };
