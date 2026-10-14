// Small helpers shared by every screen: time formats, names, icons.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmt(s) {
  s = Math.max(0, Number(s) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
export function timecode(s, fps) {
  const r = Math.round(fps || 30);
  const total = Math.floor((Math.max(0, s) + 1e-6) * (fps || 30));
  const f = total % r, sec = Math.floor(total / r);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}:${p(f)}`;
}
export function bytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
export const rate = (bps) => (bps ? (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mb/s` : `${Math.round(bps / 1e3)} kb/s`) : '');
export const fpsLabel = (f) => (f ? (Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : f.toFixed(3).replace(/0+$/, '')) : '');
export const baseName = (p) => String(p).split(/[\\/]/).pop();
export const stem = (n) => String(n).replace(/\.[^.]+$/, '');

// Folder name → project title. ALL CAPS folders read better in title case ("THE BENCH" → "The Bench").
export function projectTitle(dir) {
  const name = String(dir).split(/[\\/]/).filter(Boolean).pop() || '';
  if (name === name.toUpperCase() && /[A-Z]/.test(name)) {
    return name.toLowerCase().replace(/(^|[\s\-_(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  return name;
}
// The big title for a file: its project folder — unless it sits loose in a catch-all folder like Downloads,
// where the folder says nothing and the file's own name is the better title.
const GENERIC = new Set(['downloads', 'descargas', 'desktop', 'escritorio', 'videos', 'vídeos', 'music', 'música', 'musica', 'documents', 'documentos', 'pictures', 'imágenes', 'temp', 'tmp']);
export function titleFor(item) {
  const folder = String(item.dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return GENERIC.has(folder.toLowerCase()) || !folder || /^[a-z]:$/i.test(folder) ? stem(item.name) : projectTitle(item.dir);
}
// "3 h ago", "yesterday", "4 Mar"
export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  if (s < 35 * 86400) return `${Math.floor(s / 604800)} wk ago`;
  const d = new Date(ms), now = new Date();
  return d.toLocaleDateString('en-GB', d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
export function crumbs(dir) {
  const parts = String(dir).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).map((p) => p.toLowerCase());
}

export function aspectKey(info) {
  const a = info && info.video && info.video.aspect;
  return a === '4:3' || a === '16:9' || a === '9:16' ? a : 'other';
}

// icons: 24-unit strokes unless noted
const I = {
  play: '<path class="f" d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<path class="f" d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/>',
  back: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  fwd: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  prevFrame: '<path d="M19 5L9 12l10 7V5z"/><path d="M5 5v14"/>',
  nextFrame: '<path d="M5 5l10 7-10 7V5z"/><path d="M19 5v14"/>',
  prevFile: '<path d="M18 6l-8 6 8 6V6z"/><path d="M6 6v12"/>',
  nextFile: '<path d="M6 6l8 6-8 6V6z"/><path d="M18 6v12"/>',
  vol: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  fit: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7" y="7.5" width="10" height="9" rx="1"/>',
  fill: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18" opacity=".45"/><path d="M8 5v14M16 5v14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  home: '<path d="M15 6l-6 6 6 6"/>',
  chevL: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  autoplay: '<path d="M4 12a8 8 0 0 1 13.66-5.66"/><path d="M18 2.5v4h-4"/><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path class="f" d="M10 9v6l5-3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.2"/>',
  arrowL: '<path d="M15 6l-6 6 6 6"/>',
  arrowR: '<path d="M9 6l6 6-6 6"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
export const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name] || ''}</svg>`;

// Window buttons drawn by every look (frameless window). Thin 12-unit glyphs like Windows 11.
export const winButtons = () => `<div class="wc">
  <button data-act="win-min" aria-label="Minimise"><svg viewBox="0 0 12 12"><path d="M1.5 6h9"/></svg></button>
  <button data-act="win-max" aria-label="Maximise"><svg viewBox="0 0 12 12"><rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.2"/></svg></button>
  <button data-act="win-close" class="x" aria-label="Close"><svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>
</div>`;
