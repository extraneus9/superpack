// Renders the bloom mark (black disc, red glowing orbit, white core) to assets/icon.png + assets/icon.ico.
// Run: npx electron scripts/make-icons.js   (offscreen, nothing appears on screen)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs>
<circle cx="128" cy="128" r="124" fill="#0b0b0d"/>
<g transform="rotate(-110 128 128)" fill="none" stroke-linecap="round">
  <circle cx="128" cy="128" r="88" stroke="#e0312b" stroke-width="22" stroke-dasharray="330 600" filter="url(#g)"/>
  <circle cx="128" cy="128" r="88" stroke="#e0312b" stroke-width="16" stroke-dasharray="330 600"/>
  <circle cx="128" cy="128" r="88" stroke="#fff" stroke-width="6" stroke-dasharray="70 600" stroke-dashoffset="-250"/>
</g>
<circle cx="128" cy="128" r="36" fill="#fff"/>
</svg>`;

function ico(pngs) { // PNG-compressed ICO
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = 6 + 16 * pngs.length; const dir = [];
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(off, 12);
    dir.push(e); off += buf.length;
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const full = img.resize({ width: 256, height: 256, quality: 'best' });
  const out = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), full.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, buf: full.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(sizes));
  console.log('icons written to', out);
  app.quit();
});
