// Floating image viewer window. Windows Photos only browses a folder when Explorer itself launches it, so
// Foldernator has its own: ← → / wheel walk the folder's images in view order, Esc closes, Enter opens the
// default app. Photos-style tools: zoom (wheel with Ctrl, +/−, fit, 1:1, drag to pan), rotate/flip (saved to
// the file), copy, delete, info, wallpaper. Dragging the picture (when it fits the window) drags the FILE out
// to any app or folder, like dragging it from Explorer.
import { fileUrl, fmtSize, fmtDate } from './util.js';

const api = window.api;
const $ = (s) => document.querySelector(s);
const img = $('.stage img'), stage = $('.stage'), nameEl = $('.name'), countEl = $('.count');
const prev = $('.prev'), next = $('.next'), zoomv = $('.zoomv'), info = $('.info'), toastEl = $('.toast'), menu = $('.menu');
let list = [], i = 0, bust = 0;
let scale = 1, fit = 1, tx = 0, ty = 0; // zoom + pan (image px → screen)
const preload = new Map();

function toast(t) { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('on'), 1600); }
const cur = () => list[i];
const src = (it) => fileUrl(it.p) + (bust ? `?v=${bust}` : '');

function warm(k) {
  const it = list[k];
  if (!it || preload.has(it.p)) return;
  const im = new Image(); im.src = src(it); preload.set(it.p, im);
  if (preload.size > 12) preload.delete(preload.keys().next().value);
}

function apply() {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  if (typeof mark !== 'undefined' && mark) { mk.style.transform = mk2.style.transform = img.style.transform; }
  zoomv.textContent = Math.round(scale * 100) + '%';
}
function fitNow() {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return;
  const sw = stage.clientWidth - 96, sh = stage.clientHeight - 24;
  fit = Math.min(1, sw / w, sh / h);
  scale = fit; tx = -w * scale / 2; ty = -h * scale / 2;
  apply();
}
function zoomAt(f, cx, cy) {
  const r = stage.getBoundingClientRect();
  const ox = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2), oy = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
  const ns = Math.max(0.05, Math.min(16, scale * f));
  tx = ox - (ox - tx) * (ns / scale); ty = oy - (oy - ty) * (ns / scale);
  scale = ns; apply();
}
const zoomed = () => scale > fit * 1.01;

function renderInfo() {
  const it = cur();
  if (!it || !info.classList.contains('on')) return;
  info.innerHTML = `<div><b>Name</b>${it.n.replace(/</g, '&lt;')}</div><div><b>Dimensions</b>${img.naturalWidth} × ${img.naturalHeight}</div>`
    + (it.s ? `<div><b>Size</b>${fmtSize(it.s)}</div>` : '') + (it.m ? `<div><b>Modified</b>${fmtDate(it.m)}</div>` : '')
    + `<div><b>Folder</b>${it.p.slice(0, it.p.length - it.n.length).replace(/\\$/, '').replace(/</g, '&lt;')}</div>`;
}

function show() {
  const it = cur();
  if (!it) return;
  img.onload = () => { fitNow(); renderInfo(); };
  img.onerror = () => { img.onerror = null; img.src = `thumb://t/?p=${encodeURIComponent(it.p)}&s=512&m=${it.m}`; }; // HEIC/TIFF: Windows' preview
  img.src = src(it);
  nameEl.textContent = it.n;
  countEl.textContent = `${i + 1} / ${list.length}`;
  document.title = `${it.n} — Foldernator`;
  prev.disabled = i === 0;
  next.disabled = i === list.length - 1;
  warm(i + 1); warm(i - 1);
  api.viewerShown(it.p); // the folder window selects it, so you land on it when you go back
}
function go(d) { const n = i + d; if (n < 0 || n >= list.length) return; i = n; show(); }

function load(data) {
  if (!data || !data.list || !data.list.length) return;
  list = data.list;
  i = Math.max(0, Math.min(data.index || 0, list.length - 1));
  show();
}

// ---------- tools ----------
async function transform(op) {
  const it = cur(); if (!it) return;
  try {
    await api.imageRotate({ path: it.p, op });
    bust = Date.now(); preload.clear();
    show();
    toast(op === 'left' ? 'Rotated left' : op === 'right' ? 'Rotated right' : 'Flipped');
  } catch (e) { toast('Can’t edit this image: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}
async function del() {
  const it = cur(); if (!it) return;
  const r = await api.fileOp({ op: 'recycle', paths: [it.p] }).catch(() => null);
  if (r && r.aborted) return;
  list.splice(i, 1);
  if (!list.length) { window.close(); return; }
  if (i >= list.length) i = list.length - 1;
  toast('Moved to the Recycle Bin');
  show();
}
const actions = {
  zoomin: () => zoomAt(1.25), zoomout: () => zoomAt(0.8), fit: fitNow,
  actual: () => { scale = 1; tx = -img.naturalWidth / 2; ty = -img.naturalHeight / 2; apply(); },
  left: () => transform('left'), right: () => transform('right'), flipH: () => transform('flipH'), flipV: () => transform('flipV'),
  copy: async () => { try { await api.copyImage(cur().p); toast('Image copied'); } catch { toast('Can’t copy this image'); } },
  delete: del,
  info: () => { info.classList.toggle('on'); renderInfo(); },
  more: () => menu.classList.toggle('on'),
  crop: () => (document.body.classList.contains('cropping') ? cropEnd() : cropStart()),
  markup: () => (mark ? markEnd() : markStart()),
  wallpaper: async () => { menu.classList.remove('on'); try { await api.setWallpaper(cur().p); toast('Set as desktop background'); } catch { toast('Couldn’t set the background'); } },
  explorer: () => { menu.classList.remove('on'); api.reveal(cur().p); },
  openwith: () => { menu.classList.remove('on'); api.open(cur().p); },
};
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); actions[b.dataset.act](); }));
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('on'); });

// ---------- input ----------
document.addEventListener('keydown', (e) => {
  const k = e.key, ctrl = e.ctrlKey;
  if (mark) {
    if (k === 'Escape') { e.preventDefault(); markEnd(); }
    else if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); markUndo(); }
    else if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); markSave(false); }
    else if (!ctrl) { const t = { p: 'pen', h: 'hl', x: 'erase', z: 'pixel', b: 'blur' }[k.toLowerCase()]; if (t) { e.preventDefault(); setTool(t); } }
    return;
  }
  if (document.body.classList.contains('cropping')) { if (k === 'Escape') { e.preventDefault(); cropEnd(); } else if (k === 'Enter') { e.preventDefault(); cropApply(); } return; }
  if (k === 'Escape') { e.preventDefault(); if (menu.classList.contains('on')) menu.classList.remove('on'); else if (zoomed()) fitNow(); else window.close(); }
  else if (k === ' ') { e.preventDefault(); window.close(); }
  else if (ctrl && (k === 'r' || k === 'R')) { e.preventDefault(); transform('right'); }
  else if (ctrl && (k === 'l' || k === 'L')) { e.preventDefault(); transform('left'); }
  else if (ctrl && (k === 'c' || k === 'C')) { e.preventDefault(); actions.copy(); }
  else if (k === 'Delete') { e.preventDefault(); del(); }
  else if (k === '+' || k === '=') { e.preventDefault(); zoomAt(1.25); }
  else if (k === '-') { e.preventDefault(); zoomAt(0.8); }
  else if (k === '0') { e.preventDefault(); fitNow(); }
  else if (k === '1') { e.preventDefault(); actions.actual(); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); actions.info(); }
  else if (k === 'c' || k === 'C') { e.preventDefault(); actions.crop(); }
  else if (k === 'e' || k === 'E') { e.preventDefault(); actions.markup(); }
  else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); go(1); }
  else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(-1); }
  else if (k === 'Home') { e.preventDefault(); i = 0; show(); }
  else if (k === 'End') { e.preventDefault(); i = list.length - 1; show(); }
  else if (k === 'Enter') { e.preventDefault(); api.open(cur().p); }
});
let wheelAt = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (document.body.classList.contains('cropping') || mark) return;
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); // the wheel zooms at the cursor (like Photos); ← → change image
  if (scale < fit) fitNow(); // never smaller than "fit"
}, { passive: false });
img.addEventListener('dblclick', () => (zoomed() ? fitNow() : zoomAt(2 / scale * fit)));

// Press on the picture: zoomed in → drag pans; fitted → dragging takes the FILE out to other apps/folders.
img.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY, tx0 = tx, ty0 = ty, pan = zoomed();
  let done = false;
  const move = (ev) => {
    if (done) return;
    if (pan) { stage.classList.add('panning'); tx = tx0 + ev.clientX - x0; ty = ty0 + ev.clientY - y0; apply(); return; }
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) { done = true; end(); api.startDrag([cur().p]); }
  };
  const end = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end); stage.classList.remove('panning'); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
});
window.addEventListener('resize', () => { if (!zoomed()) fitNow(); if (crop) placeBox(); });

// ---------- crop ----------
// The box lives in image pixels (crop.x/y/w/h); it is drawn over the fitted picture and saved with the helper.
const cropEl = $('.crop'), box = $('.crop .box'), dims = $('.crop .dims');
let crop = null, ratio = null;
function imgRect() { const r = stage.getBoundingClientRect(); return { left: r.left + r.width / 2 + tx, top: r.top + r.height / 2 + ty, s: scale, sr: r }; }
function placeBox() {
  const R = imgRect();
  box.style.left = (R.left - R.sr.left + crop.x * R.s) + 'px'; box.style.top = (R.top - R.sr.top + crop.y * R.s) + 'px';
  box.style.width = crop.w * R.s + 'px'; box.style.height = crop.h * R.s + 'px';
  dims.textContent = `${Math.round(crop.w)} × ${Math.round(crop.h)}`;
}
function setRatio(ar) {
  document.querySelectorAll('.cropbar [data-ar]').forEach((b) => b.classList.toggle('on', b.dataset.ar === ar));
  const W = img.naturalWidth, H = img.naturalHeight;
  ratio = ar === 'free' ? null : ar === 'orig' ? W / H : Number(ar);
  if (ratio) { // biggest box of that shape, centred
    let w = W, h = w / ratio; if (h > H) { h = H; w = h * ratio; }
    crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  placeBox();
}
function cropStart() {
  if (!img.naturalWidth) return;
  info.classList.remove('on'); menu.classList.remove('on');
  fitNow();
  crop = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  document.body.classList.add('cropping');
  setRatio('free');
}
function cropEnd() { document.body.classList.remove('cropping'); crop = null; }
async function cropApply() {
  const it = cur(); if (!it || !crop) return;
  const c = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) };
  if (c.w >= img.naturalWidth && c.h >= img.naturalHeight) { cropEnd(); return; }
  try {
    await api.imageCrop({ path: it.p, ...c });
    cropEnd(); bust = Date.now(); preload.clear(); show(); toast(`Cropped to ${c.w} × ${c.h}`);
  } catch (e) { toast('Can’t crop this image: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}
document.querySelectorAll('.cropbar [data-ar]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setRatio(b.dataset.ar); }));
$('.cropbar .cancel').addEventListener('click', (e) => { e.stopPropagation(); cropEnd(); });
$('.cropbar .apply').addEventListener('click', (e) => { e.stopPropagation(); cropApply(); });
cropEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !crop) return;
  e.preventDefault();
  const h = e.target.dataset.h || (e.target === box || box.contains(e.target) ? 'move' : null);
  if (!h) return;
  const s = scale, W = img.naturalWidth, H = img.naturalHeight, x0 = e.clientX, y0 = e.clientY, c0 = { ...crop };
  const move = (ev) => {
    const dx = (ev.clientX - x0) / s, dy = (ev.clientY - y0) / s;
    let { x, y, w, h: hh } = c0;
    if (h === 'move') { x = Math.max(0, Math.min(W - w, x + dx)); y = Math.max(0, Math.min(H - hh, y + dy)); }
    else {
      if (h.includes('w')) { const nx = Math.max(0, Math.min(x + w - 16, x + dx)); w += x - nx; x = nx; }
      if (h.includes('e')) w = Math.max(16, Math.min(W - x, w + dx));
      if (h.includes('n')) { const ny = Math.max(0, Math.min(y + hh - 16, y + dy)); hh += y - ny; y = ny; }
      if (h.includes('s')) hh = Math.max(16, Math.min(H - y, hh + dy));
      if (ratio) { // keep the shape: width leads, height follows (clamped inside the picture)
        if (h === 'n' || h === 's') w = hh * ratio; else hh = w / ratio;
        if (h.includes('n')) y = c0.y + c0.h - hh;
        if (h.includes('w')) x = c0.x + c0.w - w;
        if (x < 0 || y < 0 || x + w > W || y + hh > H) return;
      }
    }
    crop = { x, y, w, h: hh }; placeBox();
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
});
prev.addEventListener('click', () => go(-1));
next.addEventListener('click', () => go(1));

api.onViewerLoad(load);
api.viewerData().then(load);
// ---------- markup: draw / highlight / erase / pixelate / blur, saved over the file or as a copy ----------
// Works on a full-resolution canvas built from the file's bytes (not the <img>, which would taint the canvas).
// Pen and highlighter strokes are drawn on a second canvas and merged on release, so a highlighter stroke has
// one even tint; the eraser paints the ORIGINAL pixels back; pixelate / blur act on a dragged box.
const mk = $('.stage canvas.mk'), mk2 = $('.stage canvas.mk2'), mkrect = $('.mkrect'), sizeIn = $('.markbar .size');
var mark = null; // var: apply() (defined above) checks it
const EDITABLE = /\.(png|jpe?g|jfif|webp|bmp|gif)$/i;
function setTool(t) { if (!mark) return; mark.tool = t; document.querySelectorAll('.markbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); }
function setColor(c) { if (!mark) return; mark.color = c; document.querySelectorAll('.markbar .sw').forEach((s) => s.classList.toggle('on', s.dataset.color === c)); }
const brush = () => Math.max(1, (Number(sizeIn.value) || 6) * Math.max(mk.width, mk.height) / 900);
function copyCanvas(src) { const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0); return c; }
async function markStart() {
  const it = cur(); if (!it) return;
  if (!EDITABLE.test(it.n)) { toast('This format can’t be edited here (PNG, JPG, WebP, BMP, GIF can)'); return; }
  let bmp;
  try { const buf = await api.readImage(it.p); bmp = await createImageBitmap(new Blob([buf])); }
  catch { toast('Can’t open this image for editing'); return; }
  info.classList.remove('on'); menu.classList.remove('on'); if (document.body.classList.contains('cropping')) cropEnd();
  for (const c of [mk, mk2]) { c.width = bmp.width; c.height = bmp.height; c.style.width = bmp.width + 'px'; c.style.height = bmp.height + 'px'; }
  const ctx = mk.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  mark = { ctx, base: copyCanvas(mk), undo: [], tool: 'pen', color: '#e3150f', dirty: false };
  document.body.classList.add('marking');
  fitNow();
  setTool('pen'); setColor('#e3150f');
}
function markEnd() { mark = null; document.body.classList.remove('marking'); mkrect.style.display = 'none'; mk2.getContext('2d').clearRect(0, 0, mk2.width, mk2.height); }
function pushUndo() { mark.undo.push(copyCanvas(mk)); if (mark.undo.length > 20) mark.undo.shift(); mark.dirty = true; }
function markUndo() { if (!mark || !mark.undo.length) return; const c = mark.undo.pop(); mark.ctx.clearRect(0, 0, mk.width, mk.height); mark.ctx.drawImage(c, 0, 0); mark.dirty = mark.undo.length > 0; }
function toImg(e) { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left - r.width / 2 - tx) / scale, y: (e.clientY - r.top - r.height / 2 - ty) / scale }; }
function pixelate(x, y, w, h) {
  const b = Math.max(4, Math.round(Math.max(mk.width, mk.height) / 90 * (Number(sizeIn.value) || 6) / 6));
  const sw = Math.max(1, Math.ceil(w / b)), sh = Math.max(1, Math.ceil(h / b));
  const t = document.createElement('canvas'); t.width = sw; t.height = sh;
  const tc = t.getContext('2d'); tc.imageSmoothingEnabled = true; tc.drawImage(mk, x, y, w, h, 0, 0, sw, sh);
  mark.ctx.save(); mark.ctx.imageSmoothingEnabled = false; mark.ctx.drawImage(t, 0, 0, sw, sh, x, y, w, h); mark.ctx.restore();
}
function blurBox(x, y, w, h) {
  const r = Math.max(2, Math.round(Math.max(mk.width, mk.height) / 160 * (Number(sizeIn.value) || 6) / 6));
  const m = r * 3, sx = Math.max(0, x - m), sy = Math.max(0, y - m), ex = Math.min(mk.width, x + w + m), ey = Math.min(mk.height, y + h + m);
  const t = document.createElement('canvas'); t.width = ex - sx; t.height = ey - sy;
  t.getContext('2d').drawImage(mk, sx, sy, t.width, t.height, 0, 0, t.width, t.height);
  const c = mark.ctx; c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.filter = `blur(${r}px)`; c.drawImage(t, sx, sy); c.restore();
}
mk.addEventListener('pointerdown', (e) => {
  if (!mark || e.button !== 0) return;
  e.preventDefault(); mk.setPointerCapture(e.pointerId);
  const t = mark.tool, p0 = toImg(e);
  pushUndo();
  if (t === 'pixel' || t === 'blur') {
    const sr = stage.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => { Object.assign(mkrect.style, { display: 'block', left: Math.min(x0, ev.clientX) - sr.left + 'px', top: Math.min(y0, ev.clientY) - sr.top + 'px', width: Math.abs(ev.clientX - x0) + 'px', height: Math.abs(ev.clientY - y0) + 'px' }); };
    const up = (ev) => {
      mk.removeEventListener('pointermove', move); mk.removeEventListener('pointerup', up); mkrect.style.display = 'none';
      const p1 = toImg(ev);
      const x = Math.max(0, Math.round(Math.min(p0.x, p1.x))), y = Math.max(0, Math.round(Math.min(p0.y, p1.y)));
      const w = Math.min(mk.width - x, Math.round(Math.abs(p1.x - p0.x))), h = Math.min(mk.height - y, Math.round(Math.abs(p1.y - p0.y)));
      if (w < 3 || h < 3) { mark.undo.pop(); return; }
      if (t === 'pixel') pixelate(x, y, w, h); else blurBox(x, y, w, h);
    };
    mk.addEventListener('pointermove', move); mk.addEventListener('pointerup', up);
    return;
  }
  const size = brush() * (t === 'hl' ? 3 : t === 'erase' ? 2 : 1);
  const pts = [p0];
  const o = mk2.getContext('2d');
  const style = (c) => { c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = size; };
  if (t === 'erase') { mark.ctx.save(); style(mark.ctx); mark.ctx.strokeStyle = mark.ctx.createPattern(mark.base, 'no-repeat'); }
  const draw = () => {
    if (t === 'erase') { const a = pts[pts.length - 2] || pts[0], b = pts[pts.length - 1]; mark.ctx.beginPath(); mark.ctx.moveTo(a.x, a.y); mark.ctx.lineTo(b.x + 0.01, b.y); mark.ctx.stroke(); return; }
    o.clearRect(0, 0, mk2.width, mk2.height); style(o); o.strokeStyle = mark.color; o.beginPath(); o.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) o.lineTo(p.x + 0.01, p.y); o.stroke();
  };
  mk2.style.opacity = t === 'hl' ? '0.4' : '1';
  draw();
  const move = (ev) => { pts.push(toImg(ev)); draw(); };
  const up = () => {
    mk.removeEventListener('pointermove', move); mk.removeEventListener('pointerup', up);
    if (t === 'erase') { mark.ctx.restore(); return; }
    mark.ctx.save(); mark.ctx.globalAlpha = t === 'hl' ? 0.4 : 1; mark.ctx.drawImage(mk2, 0, 0); mark.ctx.restore();
    o.clearRect(0, 0, mk2.width, mk2.height);
  };
  mk.addEventListener('pointermove', move); mk.addEventListener('pointerup', up);
});
async function markSave(asCopy) {
  const it = cur(); if (!it || !mark) return;
  if (!mark.dirty) { markEnd(); return; }
  let ext = (it.n.match(/\.([^.]+)$/) || [, 'png'])[1].toLowerCase();
  const keepType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp' }[ext];
  if (!keepType) { asCopy = true; ext = 'png'; } // BMP / GIF edits are saved as a PNG copy
  const blob = await new Promise((res) => mk.toBlob(res, keepType || 'image/png', 0.95));
  try {
    const out = await api.writeImage({ path: it.p, data: new Uint8Array(await blob.arrayBuffer()), copy: asCopy, ext });
    markEnd();
    if (asCopy) toast('Saved as ' + out.split('\\').pop());
    else { bust = Date.now(); preload.clear(); show(); toast('Saved'); }
  } catch (e) { toast('Couldn’t save: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}
document.querySelectorAll('.markbar [data-tool]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setTool(b.dataset.tool); }));
document.querySelectorAll('.markbar .sw').forEach((s) => s.addEventListener('click', (e) => { e.stopPropagation(); setColor(s.dataset.color); if (mark && (mark.tool === 'erase' || mark.tool === 'pixel' || mark.tool === 'blur')) setTool('pen'); }));
$('.markbar .undo').addEventListener('click', (e) => { e.stopPropagation(); markUndo(); });
$('.markbar .mcancel').addEventListener('click', (e) => { e.stopPropagation(); markEnd(); });
$('.markbar .mcopy').addEventListener('click', (e) => { e.stopPropagation(); markSave(true); });
$('.markbar .save').addEventListener('click', (e) => { e.stopPropagation(); markSave(false); });

window.__viewer = { state: () => ({ i, n: list.length, name: cur() && cur().n, scale, fit, w: img.naturalWidth, h: img.naturalHeight, crop }), act: (a) => actions[a](), ratio: setRatio, applyCrop: cropApply, markStart, markSave, markUndo, setTool, mark: () => mark && { tool: mark.tool, undo: mark.undo.length, w: mk.width, h: mk.height, dirty: mark.dirty },
  stroke: (pts) => { const r = stage.getBoundingClientRect(); const ev = (type, p) => new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: r.left + r.width / 2 + tx + p[0] * scale, clientY: r.top + r.height / 2 + ty + p[1] * scale }); mk.dispatchEvent(ev('pointerdown', pts[0])); for (const p of pts.slice(1)) mk.dispatchEvent(ev('pointermove', p)); mk.dispatchEvent(ev('pointerup', pts[pts.length - 1])); },
  pixelAt: (x, y) => Array.from(mk.getContext('2d').getImageData(x, y, 1, 1).data), wheel: (dy) => stage.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: stage.getBoundingClientRect().left + 200, clientY: stage.getBoundingClientRect().top + 200, bubbles: true, cancelable: true })) };
