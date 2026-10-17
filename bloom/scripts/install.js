// Builds bloom.exe, installs it to %LOCALAPPDATA%\Programs\bloom (outside OneDrive) and starts it.
// On first run the app adds itself to startup and to the Start menu.
// Usage: node scripts/install.js [--no-start]
const packager = require('@electron/packager');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, '..');
const target = path.join(process.env.LOCALAPPDATA, 'Programs', 'bloom');
const exe = path.join(target, 'bloom.exe');

function stopInstalled() {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='bloom.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { windowsHide: true });
  } catch {}
}

(async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-build-'));
  console.log('building…');
  const [built] = await packager({
    dir: appDir, out: stage, overwrite: true, platform: 'win32', arch: 'x64',
    name: 'bloom', executableName: 'bloom', icon: path.join(appDir, 'assets', 'icon.ico'),
    asar: true, prune: true, quiet: true,
    ignore: [/^\/scripts($|\/)/, /^\/qa-out($|\/)/, /^\/package-lock\.json$/],
    appCopyright: 'alva',
    win32metadata: { CompanyName: 'alva', FileDescription: 'bloom', ProductName: 'bloom', InternalName: 'bloom', OriginalFilename: 'bloom.exe' },
  });
  stopInstalled();
  await new Promise((r) => setTimeout(r, 600));
  const old = target + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, old);
  try { fs.cpSync(built, target, { recursive: true }); }
  catch (e) { fs.rmSync(target, { recursive: true, force: true }); if (fs.existsSync(old)) fs.renameSync(old, target); throw e; }
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('installed:', exe);
  if (!process.argv.includes('--no-start')) { spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore' }).unref(); console.log('started'); }
})().catch((e) => { console.error(e); process.exit(1); });
