// Media details for a video/audio file: a full ffprobe (format, every stream, chapters) plus the file's dates.
// Same data the player's File details drawer uses; the renderer turns it into sections with details-core.js.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffprobe; // resolved once: PATH first, then the WinGet FFmpeg package folder
function findFfprobe() {
  if (ffprobe !== undefined) return ffprobe;
  ffprobe = null;
  if (process.platform === 'darwin') {
    // the player's own copy (superpack), then Homebrew / MacPorts / PATH (Finder-launched apps get no shell PATH)
    const cands = [process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg', 'ffprobe'), '/Applications/the player.app/Contents/Resources/ffmpeg/ffprobe',
      '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/opt/local/bin/ffprobe', ...(process.env.PATH || '').split(':').map((d) => d && path.join(d, 'ffprobe'))];
    return (ffprobe = cands.find((p) => p && fs.existsSync(p)) || null);
  }
  // installed by superpack: use the FFmpeg that ships with the player (or one of our own), never needing a separate install
  const exeDir = path.dirname(process.execPath);
  for (const p of [process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'), path.join(exeDir, '..', 'the player', 'resources', 'ffmpeg', 'ffprobe.exe')]) {
    if (p && fs.existsSync(p)) return (ffprobe = p);
  }
  try {
    const out = execFileSync('where', ['ffprobe.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
    if (out[0]) return (ffprobe = out[0]);
  } catch {}
  const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(root).filter((d) => /ffmpeg/i.test(d))) {
      for (const sub of fs.readdirSync(path.join(root, pkg))) {
        const p = path.join(root, pkg, sub, 'bin', 'ffprobe.exe');
        if (fs.existsSync(p)) return (ffprobe = p);
      }
    }
  } catch {}
  return ffprobe;
}

// .ts / .mts can be TypeScript: a transport stream has the 0x47 sync byte every 188 (or 192) bytes
function looksLikeTransportStream(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(400);
    const n = fs.readSync(fd, b, 0, 400, 0);
    fs.closeSync(fd);
    return (n > 189 && b[0] === 0x47 && b[188] === 0x47) || (n > 197 && b[4] === 0x47 && b[196] === 0x47);
  } catch { return false; }
}

function details(file) {
  return new Promise((resolve, reject) => {
    if (/\.(ts|mts)$/i.test(file) && !looksLikeTransportStream(file)) return reject(new Error('Not a video file (this looks like a TypeScript source)'));
    const bin = findFfprobe();
    if (!bin) return reject(new Error('FFprobe isn’t installed'));
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err) return reject(new Error('Can’t read this file'));
        let j; try { j = JSON.parse(stdout); } catch { return reject(new Error('Can’t read this file')); }
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

module.exports = { details };
