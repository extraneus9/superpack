// Ogg Text may not ship inside an app, so the title is rendered once as a transparent PNG (3x) — same method as superpack/ui/make-type.js.
// Usage: node make-type.js   → ui/assets/title.png
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'media-player', 'app', 'node_modules', 'playwright-core'));
const OGG = 'file:///' + path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts', 'oggtext-medium.otf').split(path.sep).join('/');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 2000, height: 400 } });
  await page.setContent(`<html><head><style>@font-face{font-family:Ogg;src:url("${OGG}")}body{margin:0;background:transparent}
    #t{display:inline-block;font:500 120px/1.25 Ogg;color:#111;letter-spacing:-0.015em;padding:0 6px;white-space:nowrap}</style></head>
    <body><span id="t">DepthMotion<span style="color:#e3262d">.</span></span></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.locator('#t').boundingBox();
  fs.writeFileSync(path.join(__dirname, 'ui', 'assets', 'title.png'), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) } }));
  await browser.close();
  console.log('title.png', Math.ceil(box.width), 'x', Math.ceil(box.height));
})().catch((e) => { console.error(e); process.exit(1); });
