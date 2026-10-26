// Builds DepthMotion into a ready-to-ship folder: the launcher exe + uv + engine + UI. No Python or models inside —
// DepthMotion.exe sets those up on the PC it runs on.
// Usage: node build.js [outDir]       (default: dist/DepthMotion). superpack's build.js calls stage() directly.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = __dirname;
const UV = path.join(process.env.USERPROFILE, '.local', 'bin', 'uv.exe');

function stage(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, ['/nologo', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+', `/out:${path.join(out, 'DepthMotion.exe')}`,
    `/win32manifest:${path.join(SRC, 'launcher', 'app.manifest')}`, `/win32icon:${path.join(SRC, 'assets', 'icon.ico')}`,
    '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', path.join(SRC, 'launcher', 'DepthMotion.cs')], { stdio: 'inherit' });
  const skip = (p) => !/__pycache__|\.pyc$/.test(p);
  fs.cpSync(path.join(SRC, 'engine'), path.join(out, 'engine'), { recursive: true, filter: skip });
  fs.cpSync(path.join(SRC, 'ui'), path.join(out, 'ui'), { recursive: true });
  for (const f of ['requirements.txt', 'THIRD-PARTY.txt', 'LICENSE']) fs.copyFileSync(path.join(SRC, f), path.join(out, f));
  fs.copyFileSync(UV, path.join(out, 'uv.exe'));
  return out;
}

module.exports = { stage };
if (require.main === module) console.log('DepthMotion →', stage(path.resolve(process.argv[2] || path.join(SRC, 'dist', 'DepthMotion'))));
