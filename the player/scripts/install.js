// Builds "the player.exe" and installs it to %LOCALAPPDATA%\Programs\the player (outside OneDrive, so a
// double-clicked video never waits on a cloud-only file). Then the installed exe registers itself with Windows
// (Open with + Default apps) and points the Start menu / desktop shortcuts at itself.
// Usage: node scripts/install.js [--no-register]
const packager = require('@electron/packager');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, '..');
const target = path.join(process.env.LOCALAPPDATA, 'Programs', 'the player');
const exe = path.join(target, 'the player.exe');
const register = !process.argv.includes('--no-register');

function installedIsRunning() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='the player.exe'" | ForEach-Object { $_.ExecutablePath }`], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).some((p) => p && path.resolve(p).toLowerCase() === exe.toLowerCase());
  } catch { return false; }
}

(async () => {
  if (installedIsRunning()) { console.error('the player is open: close it, then run the install again.'); process.exit(2); }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'the-player-build-'));
  console.log('building…');
  const [built] = await packager({
    dir: appDir, out: stage, overwrite: true, platform: 'win32', arch: 'x64',
    name: 'the player', executableName: 'the player', icon: path.join(appDir, 'assets', 'icon.ico'),
    asar: true, prune: true, quiet: true,
    extraResource: [path.join(appDir, 'assets', 'audio.ico')], // the audio file icon Explorer reads
    ignore: [/^\/scripts($|\/)/, /^\/qa-out($|\/)/, /^\/package-lock\.json$/],
    appCopyright: 'alva',
    win32metadata: { CompanyName: 'alva', FileDescription: 'the player', ProductName: 'the player', InternalName: 'the player', OriginalFilename: 'the player.exe' },
  });
  // swap the new build in: the old one moves aside first, so a failed copy never leaves a half-installed app
  const old = target + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, old);
  try { fs.cpSync(built, target, { recursive: true }); }
  catch (e) { fs.rmSync(target, { recursive: true, force: true }); if (fs.existsSync(old)) fs.renameSync(old, target); throw e; }
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('installed:', exe);
  if (!register) return;
  const r = spawnSync(exe, ['--register-default'], { stdio: 'inherit' }); // no timeout: it may wait on his Yes in the permission prompt
  if (r.status !== 0) { console.error('registration failed'); process.exit(1); }
  console.log('registered with Windows; shortcuts point at the installed app');
})().catch((e) => { console.error(e); process.exit(1); });
