// Creates Start menu + Desktop shortcuts for the player (and removes the old "alva player" ones).
// Run with Electron: npx electron scripts/make-shortcut.js
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
const opts = {
  target: process.execPath, // electron.exe from node_modules
  args: `"${appDir}"`,
  cwd: appDir,
  icon: path.join(appDir, 'assets', 'icon.ico'),
  iconIndex: 0,
  appUserModelId: 'alva.player',
  description: 'the player - plays every video and audio format',
};
app.whenReady().then(() => {
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  for (const dir of [startMenu, app.getPath('desktop')]) {
    const old = path.join(dir, 'alva player.lnk');
    let ours = false;
    try { const l = shell.readShortcutLink(old); ours = String(l.args || '').includes(appDir) || path.resolve(l.target || '') === path.resolve(process.execPath); } catch {}
    if (fs.existsSync(old) && ours) { fs.unlinkSync(old); console.log('removed', old); }
    const lnk = path.join(dir, 'the player.lnk');
    console.log(shell.writeShortcutLink(lnk, 'create', opts) ? 'wrote' : 'FAILED', lnk);
  }
  app.quit();
});
