// Compiles native/ShellHelper.cs with the .NET Framework compiler that ships with Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'ShellHelper.cs');
const outDir = path.join(root, 'bin');
const out = path.join(outDir, 'ShellHelper.exe');
const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(fw, 'csc.exe');

if (!fs.existsSync(csc)) {
  console.error('csc.exe not found at', csc);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const args = [
  '/nologo', '/optimize+', '/platform:x64', '/target:winexe',
  `/out:${out}`,
  `/r:${path.join(fw, 'System.Windows.Forms.dll')}`,
  `/r:${path.join(fw, 'System.Drawing.dll')}`,
  `/r:${path.join(fw, 'System.Web.Extensions.dll')}`,
  `/r:${path.join(fw, 'System.Drawing.dll')}`,
  `/r:${path.join(fw, 'System.Core.dll')}`,
  `/r:${path.join(fw, 'Microsoft.CSharp.dll')}`,
  src,
];
function build(target) {
  const res = execFileSync(csc, args.map((a) => (a === `/out:${out}` ? `/out:${target}` : a)), { encoding: 'utf8' });
  if (res.trim()) console.log(res);
  console.log('built', target);
}
try {
  build(out);
} catch (e) {
  const msg = String(e.stdout || e.message);
  if (/CS0016|being used by another process/.test(msg)) {
    // Foldernator is running and holds the exe: build beside it; the app starts the newest build next launch.
    try { build(path.join(outDir, `ShellHelper-${Date.now()}.exe`)); } catch (e2) { console.error(e2.stdout || e2.message); process.exit(1); }
  } else {
    console.error(msg);
    process.exit(1);
  }
}
