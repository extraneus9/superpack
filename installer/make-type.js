// The titles are set in Ogg Text, which may not be shipped inside an app — so every Ogg line is rendered here once
// as a transparent PNG (at 3x) and the window shows the picture. Inter (open licence) ships as a font.
// Every line is rendered in the same line box, so all the pictures share one baseline and scale together.
// Usage: node ui/make-type.js   → ui/assets/type/<id>.png + type.json { id: width/height }
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', '..', 'media-player', 'app', 'node_modules', 'playwright-core'));

const OUT = path.join(__dirname, 'assets', 'type');
const OGG = 'file:///' + path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts', 'oggtext-medium.otf').replace(/\\/g, '/');
const INK = '#111111', RED = '#e3262d';
const dot = `<span style="color:${RED}">.</span>`;
const LINES = {
  superpack: `superpack${dot}`,
  thanks: `Thank you${dot}`,
  'all-set': `All set${dot}`,
  'not-done': `Not finished${dot}`,
  'n-player': 'the player', 'n-foldernator': 'Foldernator', 'n-prompterinator': 'The Prompterinator', 'n-nomorewriting': 'No More Writing', 'n-bloom': 'bloom', 'n-framehud': 'FrameHUD', 'n-depthmotion': 'DepthMotion',
  't-player': `the player${dot}`, 't-foldernator': `Foldernator${dot}`, 't-prompterinator': `The Prompterinator${dot}`, 't-nomorewriting': `No More Writing${dot}`, 't-bloom': `bloom${dot}`, 't-framehud': `FrameHUD${dot}`, 't-depthmotion': `DepthMotion${dot}`,
};
const FS = 120, LH = 1.25; // font size and line box of the master renders

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 3000, height: 400 } });
  const ratios = {};
  for (const [id, html] of Object.entries(LINES)) {
    await page.setContent(`<html><head><style>@font-face{font-family:Ogg;src:url("${OGG}")}
      body{margin:0;background:transparent}
      #t{display:inline-block;font:500 ${FS}px/${LH} Ogg;color:${INK};letter-spacing:-0.015em;padding:0 6px;white-space:nowrap}</style></head>
      <body><span id="t">${html}</span></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const box = await page.locator('#t').boundingBox();
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) } });
    fs.writeFileSync(path.join(OUT, `${id}.png`), buf);
    ratios[id] = +(Math.ceil(box.width) / Math.ceil(box.height)).toFixed(4);
  }
  fs.writeFileSync(path.join(OUT, 'type.json'), JSON.stringify({ lineHeight: LH, ratios }, null, 2));
  await browser.close();
  console.log('type →', OUT, Object.keys(LINES).length, 'lines');
})().catch((e) => { console.error(e); process.exit(1); });
