// Writes multi-size .ico files from RGBA pixels rendered by the UI (same SVG as the app's folders).
// Sizes < 256 are stored as 32-bit DIBs (what every Windows API reads), 256 as PNG.
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

function dibEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  const andRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andRow * size); // all zero: alpha channel decides
  return Buffer.concat([header, xor, and]);
}

function buildIco(images) {
  // images: [{ size, rgba: Buffer }]
  const entries = images.sort((a, b) => a.size - b.size).map((img) => {
    if (img.size >= 256) {
      const png = nativeImage.createFromBitmap(bgraFromRgba(img.rgba), { width: img.size, height: img.size }).toPNG();
      return { size: img.size, data: png };
    }
    return { size: img.size, data: dibEntry(img.size, img.rgba) };
  });
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

// nativeImage.createFromBitmap expects BGRA on Windows.
function bgraFromRgba(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) { const r = out[i]; out[i] = out[i + 2]; out[i + 2] = r; }
  return out;
}

class IconStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  // Version in the name: Explorer caches icons by path, so a redesigned icon needs a new file.
  file(hex, style = 'windows') {
    const s = !style || style === 'windows' ? '' : style + '-';
    return path.join(this.dir, `folder-v${IconStore.VERSION}-${s}` + hex.replace('#', '').toLowerCase() + '.ico');
  }
  has(hex, style) { return fs.existsSync(this.file(hex, style)); }
  write(hex, images, style) {
    const f = this.file(hex, style);
    fs.writeFileSync(f, buildIco(images.map((i) => ({ size: i.size, rgba: Buffer.from(i.rgba) }))));
    return f;
  }
}

IconStore.VERSION = 1;

module.exports = { IconStore, bgraFromRgba };
