// File-type icons (option B, 2026-10-14): video = black tile, white frame, red play · audio = white tile, black
// waveform, one red bar. Small sizes (≤ 32 px) get a bolder, simpler drawing so they still read in Explorer lists.
// Renders every size with headless Edge and packs .ico files (PNG entries). Usage: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const RED = '#e3262d', INK = '#f2f0ec', BLACK = '#0a0a0a';

function tile(px, bg, edge) {
  const r = px <= 24 ? 44 : 54; // a touch squarer when tiny
  // the outline stays ~1 px at every size, so a white tile never melts into a white Explorer (nor black into dark)
  const sw = Math.max(3, 256 / px);
  return `<rect x="${8 + sw / 2}" y="${8 + sw / 2}" width="${240 - sw}" height="${240 - sw}" rx="${r}" fill="${bg}" stroke="${edge}" stroke-width="${sw}"/>`;
}
function video(px) {
  const small = px <= 32;
  const sw = small ? 22 : 12;
  const [x, y, w, h] = small ? [40, 64, 176, 128] : [50, 78, 156, 100];
  const s = small ? 64 : 40, cx = x + w / 2 + s * 0.08, cy = y + h / 2;
  const tri = `<path d="M${cx - s * .42} ${cy - s * .5} L${cx + s * .58} ${cy} L${cx - s * .42} ${cy + s * .5} Z" fill="${RED}" stroke="${RED}" stroke-width="${s * .12}" stroke-linejoin="round"/>`;
  return tile(px, BLACK, '#3a3a3a') + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${small ? 20 : 16}" fill="none" stroke="${INK}" stroke-width="${sw}"/>` + tri;
}
function audio(px) {
  const small = px <= 32;
  const bars = small ? [[-64, 56], [-32, 100], [0, 150], [32, 84], [64, 44]] : [[-75, 22], [-50, 52], [-25, 34], [0, 84], [25, 46], [50, 64], [75, 26]];
  const bw = small ? 22 : 14;
  return tile(px, INK, '#b9b4ab') + bars.map(([dx, h]) => `<rect x="${128 + dx - bw / 2}" y="${128 - h / 2}" width="${bw}" height="${h}" rx="${bw / 2}" fill="${dx === 0 ? RED : BLACK}"/>`).join('');
}
// the app itself (option B, 2026-10-14): red play button with the waveform behind it — video and audio in one mark
function app(px) {
  const small = px <= 32;
  const bars = small ? [[-80, 56], [80, 56]] : [[-84, 30], [-62, 64], [62, 64], [84, 30]];
  const bw = small ? 22 : 14, r = small ? 58 : 48, s = small ? 48 : 40, cx = 131;
  const tri = `<path d="M${cx - s * .42} ${128 - s * .5} L${cx + s * .58} 128 L${cx - s * .42} ${128 + s * .5} Z" fill="${INK}" stroke="${INK}" stroke-width="${s * .12}" stroke-linejoin="round"/>`;
  return tile(px, BLACK, '#3a3a3a') + bars.map(([dx, h]) => `<rect x="${128 + dx - bw / 2}" y="${128 - h / 2}" width="${bw}" height="${h}" rx="${bw / 2}" fill="${INK}" opacity=".85"/>`).join('') +
    `<circle cx="128" cy="128" r="${r}" fill="${RED}"/>` + tri;
}
const svg = (inner, px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 256 256">${inner}</svg>`;

// .ico with PNG-compressed entries (Vista+): header, directory, then the PNGs
function packIco(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ px, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(px >= 256 ? 0 : px, o); dir.writeUInt8(px >= 256 ? 0 : px, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (markup, px) => {
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
  };
  for (const [name, draw] of [['video', video], ['audio', audio]]) {
    const pngs = [];
    for (const px of SIZES) pngs.push({ px, buf: await render(svg(draw(px), px), px) });
    fs.writeFileSync(path.join(OUT, `${name}.ico`), packIco(pngs));
    fs.writeFileSync(path.join(OUT, `${name}-256.png`), pngs[pngs.length - 1].buf);
    console.log(`${name}.ico: ${SIZES.join(', ')} px`);
  }
  // the app icon: .ico for the exe + window, a 1024 PNG for the tray and the installer
  const appPngs = [];
  for (const px of SIZES) appPngs.push({ px, buf: await render(svg(app(px), px), px) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), packIco(appPngs));
  fs.writeFileSync(path.join(OUT, 'icon-256.png'), appPngs[appPngs.length - 1].buf);
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(svg(app(1024), 1024), 1024));
  console.log('icon.ico + icon.png: the app');
  // preview sheet: every size of both, on dark and light, like Explorer
  const row = (bg, fg) => `<div style="display:flex;gap:18px;align-items:flex-end;padding:18px;background:${bg};color:${fg};font:12px Segoe UI">${
    ['video', 'audio'].map((n) => SIZES.slice().reverse().map((px) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, `${n}-256.png`)).toString('base64')}" style="display:none">`).join('') +
      SIZES.slice(0, 8).reverse().map((px) => svg((n === 'video' ? video : audio)(px), px)).join('')).join('<span style="width:30px"></span>')}</div>`;
  await page.setViewportSize({ width: 1100, height: 300 });
  await page.setContent(`<html><body style="margin:0">${row('#1f1f1f', '#eee')}${row('#f3f3f3', '#111')}</body></html>`);
  await page.screenshot({ path: path.join(OUT, 'file-icons-preview.png'), fullPage: true });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
