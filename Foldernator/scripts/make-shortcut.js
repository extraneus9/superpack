// Creates Start menu + Desktop shortcuts for Foldernator (and removes the old "alva explorer" ones).
// Run with Electron (needs shell.writeShortcutLink): npx electron scripts/make-shortcut.js
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const appDir = path.join(__dirname, '..');
const startMenu = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const opts = {
  target: process.execPath, // electron.exe from node_modules
  args: `"${appDir}"`,
  cwd: appDir,
  icon: path.join(appDir, 'assets', 'app-v3.ico'),
  iconIndex: 0,
  appUserModelId: 'foldernator.app',
  description: 'Foldernator - file explorer with status colors',
};
app.whenReady().then(() => {
  for (const dir of [startMenu, app.getPath('desktop')]) {
    const old = path.join(dir, 'alva explorer.lnk');
    if (fs.existsSync(old)) { fs.unlinkSync(old); console.log('removed', old); }
    const lnk = path.join(dir, 'Foldernator.lnk');
    console.log(shell.writeShortcutLink(lnk, 'create', opts) ? 'wrote' : 'FAILED', lnk);
  }
  app.quit();
});
