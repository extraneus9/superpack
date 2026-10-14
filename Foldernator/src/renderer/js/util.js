// Small shared helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString()} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit' });
export function fmtDate(ms) {
  if (!ms) return '';
  return dateFmt.format(new Date(ms));
}

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

// Windows paths (C:\…, \\server\…) or macOS paths (/…; disks are "/" and /Volumes/<name>)
export const IS_MAC = typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent);
export const SEP = IS_MAC ? '/' : '\\';
const MAC_ROOT = /^\/Volumes\/[^/]+\/?$/;

export const isRoot = (p) => (IS_MAC ? p === '/' || MAC_ROOT.test(p) : /^[a-zA-Z]:\\?$/.test(p));
export const isFsPath = (loc) => (IS_MAC ? typeof loc === 'string' && loc.startsWith('/') : /^[a-zA-Z]:\\/.test(loc) || /^\\\\/.test(loc));
// a path without its trailing separator (a disk root keeps what it needs)
export const trimSep = (p) => (IS_MAC ? (p === '/' ? p : p.replace(/\/+$/, '')) : p.replace(/\\+$/, ''));

export function normDir(p) {
  if (IS_MAC) return p === '/' ? '/' : p.replace(/\/+$/, '') || '/';
  if (/^[a-zA-Z]:$/.test(p)) return p + '\\';
  if (isRoot(p)) return p[0].toUpperCase() + ':\\';
  return p.replace(/[\\/]+$/, '').replace(/\//g, '\\');
}

export function baseName(p) {
  if (IS_MAC) {
    if (p === '/') return 'Macintosh HD';
    const t = p.replace(/\/+$/, '');
    return t.slice(t.lastIndexOf('/') + 1);
  }
  if (isRoot(p)) return p.slice(0, 2);
  const t = p.replace(/\\+$/, '');
  return t.slice(t.lastIndexOf('\\') + 1);
}

export function parentOf(p) {
  if (!isFsPath(p) || isRoot(p)) return 'thispc';
  if (IS_MAC) {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  }
  const t = p.replace(/\\+$/, '');
  const i = t.lastIndexOf('\\');
  if (i < 0) return 'thispc';
  return normDir(t.slice(0, i));
}

export function joinPath(dir, name) {
  return dir.endsWith(SEP) ? dir + name : dir + SEP + name;
}

// the disk a path lives on: C: / \\server\share on Windows, "/" or /Volumes/<name> on a Mac
export function diskOf(p) {
  if (IS_MAC) { const m = /^\/Volumes\/[^/]+/.exec(p); return m ? m[0].toLowerCase() : '/'; }
  return /^[a-zA-Z]:/.test(p) ? p[0].toLowerCase() : p.split('\\').slice(0, 4).join('\\').toLowerCase();
}

export function fileUrl(p) {
  if (IS_MAC) return 'file://' + p.split('/').map((s) => encodeURIComponent(s)).join('/');
  const fwd = p.replace(/\\/g, '/');
  if (fwd.startsWith('//')) return 'file:' + fwd.split('/').map((s, i) => (i < 2 ? s : encodeURIComponent(s))).join('/');
  return 'file:///' + fwd.split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

const TYPES = {
  mp4: 'MP4 Video', mov: 'QuickTime Movie', mkv: 'Matroska Video', webm: 'WebM Video', avi: 'AVI Video', m4v: 'MP4 Video', wmv: 'Windows Media Video', mts: 'AVCHD Video',
  jpg: 'JPEG Image', jpeg: 'JPEG Image', png: 'PNG Image', gif: 'GIF Image', webp: 'WebP Image', bmp: 'Bitmap Image', tif: 'TIFF Image', tiff: 'TIFF Image', heic: 'HEIC Image', avif: 'AVIF Image', svg: 'SVG Image', psd: 'Photoshop Document', ico: 'Icon',
  mp3: 'MP3 Audio', wav: 'WAV Audio', flac: 'FLAC Audio', m4a: 'MPEG-4 Audio', aac: 'AAC Audio', ogg: 'OGG Audio', aif: 'AIFF Audio', aiff: 'AIFF Audio',
  pdf: 'PDF Document', doc: 'Word Document', docx: 'Word Document', xls: 'Excel Sheet', xlsx: 'Excel Sheet', ppt: 'PowerPoint', pptx: 'PowerPoint', txt: 'Text Document', md: 'Markdown', rtf: 'Rich Text',
  zip: 'ZIP Archive', rar: 'RAR Archive', '7z': '7-Zip Archive', exe: 'Application', msi: 'Installer', lnk: 'Shortcut', url: 'Internet Shortcut',
  js: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript JSX', jsx: 'JavaScript JSX', json: 'JSON', html: 'HTML Document', css: 'Stylesheet', py: 'Python', cs: 'C# Source', bat: 'Batch File', ps1: 'PowerShell Script',
  blend: 'Blender File', drp: 'Resolve Project', prproj: 'Premiere Project', aep: 'After Effects Project', srt: 'Subtitles', ttf: 'TrueType Font', otf: 'OpenType Font', woff2: 'Web Font',
};
export function typeLabel(item) {
  if (item.drive) return item.typeLabel || 'Local Disk';
  if (item.d) return 'File folder';
  const e = extOf(item.n);
  return TYPES[e] || (e ? `${e.toUpperCase()} File` : 'File');
}

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'jfif']);
export const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ogv']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus']);
export const TEXT_EXT = new Set(['txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'log', 'csv', 'py', 'cs', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'bat', 'cmd', 'ps1', 'sh', 'srt', 'vtt', 'toml', 'env', 'gitignore']);

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function withAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
