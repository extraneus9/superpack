// Vector icons. The folder shape is shared by the UI and the .ico files written for native Explorer.
// Styles (Settings → Icons): folder style, app icon style, sidebar icons, file icons.
import { mix } from './util.js';

let folderStyle = 'windows';
let uiStyle = 'regular';
export const iconStyles = { folder: 'windows', ui: 'regular', sidebar: 'windows', files: 'windows' };
export function setIconStyles(s = {}) {
  Object.assign(iconStyles, Object.fromEntries(Object.entries(s).filter(([, v]) => v)));
  folderStyle = iconStyles.folder;
  uiStyle = iconStyles.ui;
}
export const FOLDER_STYLES = [['windows', 'Windows'], ['flat', 'Flat'], ['outline', 'Outline'], ['rounded', 'Rounded'], ['glass', 'Glass'], ['minimal', 'Minimal']];
export const UI_STYLES = [['thin', 'Thin'], ['regular', 'Regular'], ['bold', 'Bold'], ['sharp', 'Sharp'], ['duotone', 'Duotone']];

let gid = 0;
const BACK = 'M3 11.5A3.5 3.5 0 0 1 6.5 8h11.1a3.5 3.5 0 0 1 2.47 1.03L23 12h18.5a3.5 3.5 0 0 1 3.5 3.5v21A3.5 3.5 0 0 1 41.5 40h-35A3.5 3.5 0 0 1 3 36.5z';
// open: false (closed) | true (drag-over) | 'peek' (lowered so the previews inside show, like Windows 11)
const flapTop = (open) => (open === 'peek' ? 23 : open ? 19 : 17.5);
const front = (open) => `M3 ${flapTop(open)}A3.5 3.5 0 0 1 6.5 ${flapTop(open) - 3.5}h35a3.5 3.5 0 0 1 3.5 3.5v${36.5 - flapTop(open)}a3.5 3.5 0 0 1-3.5 3.5h-35A3.5 3.5 0 0 1 3 36.5z`;

// Folder previews: up to 2 thumbnails standing inside the folder, between the back and the front flap.
function peekLayer(urls, id) {
  const card = (url, x, y, w, h, rot, k) => `<g transform="rotate(${rot} ${x + w / 2} ${y + h / 2})">
      <clipPath id="${id}c${k}"><rect x="${x + 0.7}" y="${y + 0.7}" width="${w - 1.4}" height="${h - 1.4}" rx="1.2"/></clipPath>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.8" fill="#ffffff" fill-opacity=".92"/>
      <image href="${url}" x="${x + 0.7}" y="${y + 0.7}" width="${w - 1.4}" height="${h - 1.4}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}c${k})"/></g>`;
  const [a, b] = urls;
  return (b ? card(b, 12, 5.5, 28, 21, 6, 1) : '') + card(a, 8, 8.5, 30, 22, b ? -4 : 0, 0);
}

export function folderSvg(color, { size = 48, open = false, style, peek = null } = {}) {
  const st = style || folderStyle;
  const id = 'f' + (++gid);
  if (peek && peek.length) open = 'peek';
  const svg = (inner) => {
    if (peek && peek.length) {
      const at = inner.search(/<(path|rect) class="ff"/);
      if (at >= 0) inner = inner.slice(0, at) + peekLayer(peek, id) + inner.slice(at);
    }
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" data-style="${st}"${peek && peek.length ? ' class="peek"' : ''}>${inner}</svg>`;
  };
  switch (st) {
    case 'flat':
      return svg(`<path d="${BACK}" fill="${mix(color, '#000000', 0.14)}"/><path class="ff" d="${front(open)}" fill="${color}"/>`);
    case 'outline':
      return svg(`<path d="${BACK}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2.6" stroke-linejoin="round"/>
        <path class="ff" d="${front(open)}" fill="${color}" fill-opacity=".22" stroke="${color}" stroke-width="2.6" stroke-linejoin="round"/>`);
    case 'rounded':
      return svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(color, '#ffffff', 0.18)}"/><stop offset="1" stop-color="${mix(color, '#000000', 0.06)}"/></linearGradient></defs>
        <rect x="4" y="8" width="18" height="12" rx="5" fill="${mix(color, '#000000', 0.2)}"/>
        <rect x="4" y="11" width="40" height="29" rx="8" fill="${mix(color, '#000000', 0.2)}"/>
        <rect class="ff" x="4" y="${open === 'peek' ? 22 : 16}" width="40" height="${open === 'peek' ? 19 : 25}" rx="8" fill="url(#${id})"/>
        <rect x="9" y="20" width="14" height="3" rx="1.5" fill="#ffffff" fill-opacity=".35"/>`);
    case 'glass':
      return svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".75"/><stop offset=".45" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity=".85"/></linearGradient></defs>
        <path d="${BACK}" fill="${color}" fill-opacity=".7"/>
        <path class="ff" d="${front(open)}" fill="url(#${id})" stroke="#ffffff" stroke-opacity=".7" stroke-width="1"/>
        <path d="M7 ${flapTop(open) + 1}h34" stroke="#ffffff" stroke-opacity=".85" stroke-width="1.2" stroke-linecap="round"/>`);
    case 'minimal':
      return svg(`<path d="${BACK}" fill="${mix(color, '#ffffff', 0.35)}"/>
        <path class="ff" d="${front(open)}" fill="${color}"/>
        <rect x="3" y="${flapTop(open)}" width="42" height="2" fill="#ffffff" fill-opacity=".28"/>
        <rect x="3" y="37.5" width="42" height="2.5" rx="1" fill="#000000" fill-opacity=".12"/>`);
    default: {
      const hi = mix(color, '#ffffff', 0.28);
      return svg(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="0.35" stop-color="${color}"/><stop offset="1" stop-color="${mix(color, '#000000', 0.08)}"/></linearGradient></defs>
        <path d="${BACK}" fill="${mix(color, '#000000', 0.22)}"/><path class="ff" d="${front(open)}" fill="url(#${id})"/>`);
    }
  }
}

// Minimal file icon: a clean page with a colored tag showing the extension.
const FILE_COLORS = [
  [/^(mp4|mov|m4v|mkv|webm|avi|wmv|mts|m2ts|mpg|flv|3gp)$/, '#8b5cf6'],
  [/^(jpg|jpeg|jfif|png|gif|webp|bmp|tif|tiff|heic|heif|avif|ico|svg|raw|cr2|cr3|nef|arw|dng)$/, '#3b82f6'],
  [/^(mp3|wav|flac|m4a|aac|ogg|opus|aif|aiff)$/, '#ec4899'],
  [/^(pdf)$/, '#ef4444'],
  [/^(doc|docx|txt|md|rtf|odt|xls|xlsx|csv|ppt|pptx)$/, '#64748b'],
  [/^(js|mjs|ts|tsx|jsx|json|html|css|py|cs|c|cpp|h|java|rs|go|bat|ps1|sh|yml|yaml|xml)$/, '#10b981'],
  [/^(zip|rar|7z|tar|gz)$/, '#f59e0b'],
  [/^(blend|psd|ai|aep|prproj|drp|fig|c4d|obj|fbx|glb)$/, '#f97316'],
];
export function fileSvg(ext, size = 20) {
  const e = (ext || '').toLowerCase();
  const color = (FILE_COLORS.find(([re]) => re.test(e)) || [null, '#94a3b8'])[1];
  const label = e.slice(0, 4).toUpperCase();
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" data-file="minimal">
    <path d="M12 4h17l11 11v27a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#f4f5f7" stroke="#c9ccd2" stroke-width="1"/>
    <path d="M29 4v9a2 2 0 0 0 2 2h9" fill="#dfe2e7"/>
    ${label ? `<rect x="5" y="26" width="31" height="12" rx="3" fill="${color}"/><text x="20.5" y="35" text-anchor="middle" font-family="Segoe UI, Inter, sans-serif" font-size="${label.length > 3 ? 7.4 : 8.6}" font-weight="700" fill="#fff">${label}</text>` : `<rect x="16" y="24" width="16" height="3" rx="1.5" fill="${color}"/><rect x="16" y="30" width="12" height="3" rx="1.5" fill="${color}" fill-opacity=".6"/>`}
  </svg>`;
}

export function driveSvg(accent = '#4cc2ff', size = 48) {
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
    <rect x="5" y="14" width="38" height="20" rx="4" fill="#8a8f98"/>
    <rect x="5" y="14" width="38" height="13" rx="4" fill="#c9ced6"/>
    <rect x="9" y="29" width="18" height="2" rx="1" fill="#5c6068"/>
    <circle cx="37" cy="30" r="1.6" fill="${accent}"/>
  </svg>`;
}

// Renders the folder at the sizes Windows asks for; returns raw RGBA for the .ico writer.
export async function folderImages(color, style) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const svg = folderSvg(color, { size: 256, style }).replace(/width="256" height="256"/, 'width="256" height="256" xmlns="http://www.w3.org/2000/svg"');
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  return sizes.map((s) => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, s, s);
    return { size: s, rgba: new Uint8Array(ctx.getImageData(0, 0, s, s).data.buffer) };
  });
}

const P = {
  back: '<path d="M10 3 5 8l5 5M5.5 8H14"/>',
  forward: '<path d="M6 3l5 5-5 5M10.5 8H2"/>',
  up: '<path d="M3 10l5-5 5 5M8 5.5V14"/>',
  refresh: '<path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.9M13.5 2.5v3.2h-3.2"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  chevronDown: '<path d="m4 6 4 4 4-4"/>',
  maximize: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  cut: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.8 10 12 2.5M10.2 10 4 2.5"/>',
  copy: '<rect x="5" y="5" width="8.5" height="9" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/>',
  paste: '<rect x="3" y="3" width="10" height="11.5" rx="1.5"/><path d="M6 3V2h4v1"/><path d="M6 7.5h4M6 10h3"/>',
  rename: '<path d="M2.5 13.5h3l7.6-7.6a1.4 1.4 0 0 0-3-3L2.5 10.5z"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.2a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3L12 4"/>',
  sort: '<path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5"/>',
  view: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  details: '<path d="M2 3.5h12M2 8h12M2 12.5h12"/>',
  preview: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M9.5 2.5v11"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  pin: '<path d="M9.5 2 14 6.5l-2.2.8-2.6 2.6-.4 3.1L2.9 7.1 6 6.7l2.6-2.6z"/><path d="M5 11l-3 3"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5V13a1 1 0 0 1-1 1h-3v-4h-3v4h-3a1 1 0 0 1-1-1z"/>',
  pc: '<rect x="2" y="2.5" width="12" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
  desktop: '<rect x="2" y="2.5" width="12" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
  download: '<path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  doc: '<path d="M4 1.8h5.2L12.5 5v8.7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5z"/><path d="M9 2v3.3h3.3"/>',
  image: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.3" r="1.3"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/>',
  video: '<rect x="1.8" y="3.5" width="9" height="9" rx="1.5"/><path d="m10.8 7 3.4-2v6l-3.4-2"/>',
  music: '<path d="M6 12.2V3.3l7-1.3v8.6"/><circle cx="4.5" cy="12.3" r="1.6"/><circle cx="11.5" cy="10.7" r="1.6"/>',
  folder: '<path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.4 1.5h5.2A1.2 1.2 0 0 1 14 5.7v6.6a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12.3z"/>',
  newFolder: '<path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.4 1.5h5.2A1.2 1.2 0 0 1 14 5.7v6.6a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12.3z"/><path d="M8 7v4M6 9h4"/>',
  terminal: '<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8 10.5h3.5"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.1"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  open: '<path d="M2 12.5V4.2A1.2 1.2 0 0 1 3.2 3h3l1.4 1.5h4.2A1.2 1.2 0 0 1 13 5.7V7"/><path d="M2 12.5 4 7.6a1 1 0 0 1 .9-.6H14l-2.2 5.6a1 1 0 0 1-.9.6H2z"/>',
  link: '<path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  dot: '<circle cx="8" cy="8" r="4" fill="currentColor" stroke="none"/>',
  palette: '<path d="M8 2a6 6 0 1 0 0 12c1 0 1.5-.6 1.5-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.3-1.2H12a2 2 0 0 0 2-2C14 4.4 11.3 2 8 2z"/><circle cx="5" cy="7" r=".9"/><circle cx="7.5" cy="4.8" r=".9"/><circle cx="10.6" cy="5.4" r=".9"/>',
  cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4.2 4.2 0 0 1 8 .9 2.6 2.6 0 0 1-.6 5.1z"/>',
  undo: '<path d="M5 6H10a3.5 3.5 0 0 1 0 7H6M5 6l2.5-2.5M5 6l2.5 2.5"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  drive: '<rect x="1.8" y="4.5" width="12.4" height="7" rx="1.6"/><path d="M4.2 9h4"/><circle cx="11.6" cy="9" r=".6" fill="currentColor"/>',
  star: '<path d="m8 2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2l-3.6 1.9.7-4L2.2 6.3l4-.6z"/>',
};

// 24-unit icons (Lucide, ISC) where a 16-unit drawing reads poorly.
const P24 = {
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  dockLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="7" height="16" rx="2" fill="currentColor" fill-opacity=".35"/>',
  dockRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2" fill="currentColor" fill-opacity=".35"/>',
  dockBottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2" fill="currentColor" fill-opacity=".35"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};

// Icons whose shapes are closed enough to take the soft duotone fill.
const DUO = new Set(['folder', 'newFolder', 'open', 'doc', 'image', 'video', 'pc', 'desktop', 'preview', 'view', 'terminal', 'home', 'info', 'cloud', 'palette', 'star', 'eye', 'pin', 'copy', 'paste', 'rename', 'search', 'music', 'trash', 'gear', 'sidebar', 'drive', 'link']);
const UI = {
  thin: { w16: 1.05, w24: 1.5, cap: 'round' },
  regular: { w16: 1.35, w24: 1.9, cap: 'round' },
  bold: { w16: 1.85, w24: 2.5, cap: 'round' },
  sharp: { w16: 1.35, w24: 1.9, cap: 'square', join: 'miter' },
  duotone: { w16: 1.35, w24: 1.9, cap: 'round', duo: true },
};

export function icon(name, size = 16, style) {
  const st = UI[style || uiStyle] || UI.regular;
  const big = !!P24[name];
  const body = big ? P24[name] : (P[name] || '');
  const fill = st.duo && DUO.has(name) ? `<g fill="currentColor" fill-opacity=".34" stroke="none">${body}</g>` : '';
  return `<svg class="i" viewBox="0 0 ${big ? 24 : 16} ${big ? 24 : 16}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${big ? st.w24 : st.w16}" stroke-linecap="${st.cap}" stroke-linejoin="${st.join || 'round'}" aria-hidden="true">${fill}${body}</svg>`;
}

// Colored nav icons in the style of Windows 11 Explorer's Home and Gallery.
export function homeIcon(size = 18) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">
    <path d="M10 2.2 2.6 8.3c-.4.3-.6.8-.6 1.3V16a1.8 1.8 0 0 0 1.8 1.8H8v-5h4v5h4.2A1.8 1.8 0 0 0 18 16V9.6c0-.5-.2-1-.6-1.3z" fill="#f7a738"/>
    <path d="M10 2.2 2.6 8.3c-.4.3-.6.8-.6 1.3V10l8-6.6 8 6.6v-.4c0-.5-.2-1-.6-1.3z" fill="#e8742a"/>
    <rect x="8" y="12.4" width="4" height="5.4" rx=".6" fill="#9c4a1a"/></svg>`;
}
export function galleryIcon(size = 18) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">
    <rect x="2" y="3" width="16" height="14" rx="2.6" fill="#2f8cf0"/>
    <circle cx="7" cy="7.6" r="1.8" fill="#bfe2ff"/>
    <path d="M2 14.2 7.4 9.6l3.2 2.8 2.6-2.2L18 14v.4A2.6 2.6 0 0 1 15.4 17H4.6A2.6 2.6 0 0 1 2 14.4z" fill="#8fd0ff"/></svg>`;
}
