// bloom's sound library (absorbed from the old "Notification Sounds" app): files live in %APPDATA%\bloom\sounds.
// Chromium decodes wav/mp3/ogg/m4a/flac/opus itself, so a dropped file is copied as is, no conversion step.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const EXT = new Set(['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);
const MAX_BYTES = 20 * 1024 * 1024;

const dir = () => path.join(app.getPath('userData'), 'sounds');

function list() {
  try {
    return fs.readdirSync(dir()).filter((f) => EXT.has(path.extname(f).toLowerCase())).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

function safeName(name) { return path.basename(String(name || '')); }

function bytes(name) {
  const f = path.join(dir(), safeName(name));
  try { return fs.readFileSync(f); } catch { return null; }
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
  while (fs.existsSync(path.join(dir(), name))) {
    if (fs.statSync(path.join(dir(), name)).size === st.size) return name; // same file dropped again
    name = `${base} (${i++})${ext}`;
  }
  fs.copyFileSync(src, path.join(dir(), name));
  return name;
}

function remove(name) {
  try { fs.rmSync(path.join(dir(), safeName(name)), { force: true }); } catch {}
}

const label = (name) => (name ? path.basename(name, path.extname(name)) : '');

module.exports = { list, bytes, add, remove, label, dir };
