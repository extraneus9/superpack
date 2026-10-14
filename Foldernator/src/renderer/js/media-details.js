// Media details (Ctrl+I · right-click → Media details · preview pane button): everything about a video or audio
// file, MediaInfo-style — the same report as the player's File details (shared details-core.js).
// A dialog on the app's own material (themes, Liquid Glass); click any value to copy it.
import { el, extOf } from './util.js';
import { icon } from './icons.js';
import { toast } from './dialogs.js';
import { detailSections, detailsText } from './details-core.js';

// every video/audio format the player plays (wider than the preview's list: AVI, MXF, WMV, …)
export const MEDIA_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'mxf', '3gp', 'ogv', 'vob', 'f4v', 'divx', 'asf',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'alac', 'ac3', 'dts', 'mka', 'weba']);
// .ts / .mts are also TypeScript sources: those count as video only when big (camera clips), and main checks the bytes too
const AMBIGUOUS = new Set(['ts', 'mts']);
export const isMediaFile = (item) => {
  if (!item || item.d || item.drive || item.virt) return false;
  const ext = extOf(item.n || item.p || '');
  if (!MEDIA_EXT.has(ext)) return false;
  return !AMBIGUOUS.has(ext) || (item.s || 0) >= 512 * 1024;
};

let openFor = null; // the path whose dialog is open (one at a time)
let returnFocus = null; // where the keyboard goes back to when it closes
// while open: Esc or Ctrl+I closes it, and no other shortcut reaches the file view behind
function onKey(e) {
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I'))) { e.preventDefault(); e.stopPropagation(); closeMediaDetails(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) return; // let Ctrl+C copy selected text
  e.stopPropagation();
}

export async function openMediaDetails(app, path) {
  if (!path) return;
  closeMediaDetails();
  returnFocus = document.activeElement;
  openFor = path;
  const rootEl = document.getElementById('modal-root');
  const body = el('div', { class: 'md-body' }, el('div', { class: 'md-loading' }, el('div', { class: 'spinner' }), el('span', { text: 'Reading the file…' })));
  const closeBtn = el('button', { class: 'icon-btn md-x', title: 'Close (Esc)', html: icon('close', 16), onclick: () => closeMediaDetails() });
  const dlg = el('div', { class: 'dialog media-details', role: 'dialog', 'aria-label': 'Media details' },
    el('div', { class: 'md-head' }, el('h3', { text: 'Media details' }), closeBtn), body);
  const back = el('div', { class: 'modal-backdrop md-backdrop', onmousedown: (e) => { if (e.target === back) closeMediaDetails(); } }, dlg);
  rootEl.append(back);
  const appEl = document.getElementById('app'); if (appEl) appEl.inert = true; // Tab, clicks and typing stay in the dialog
  document.addEventListener('keydown', onKey, true);
  closeBtn.focus();

  let d;
  try { d = await app.api.mediaDetails(path); } catch (e) {
    if (openFor !== path) return;
    body.replaceChildren(el('p', { class: 'md-error', text: `Can’t read the details: ${String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` }));
    return;
  }
  if (openFor !== path || !back.isConnected) return; // closed or replaced meanwhile
  const secs = detailSections(d, null);
  const text = detailsText(d, secs);
  const copy = async (value, label) => {
    await app.api.copyText(value);
    toast(label || `Copied: ${value.length > 60 ? value.slice(0, 60) + '…' : value}`, 'ok', { ms: 1600 });
  };
  const file = el('div', { class: 'md-file' },
    el('b', { text: d.name }),
    el('span', { class: 'md-path', text: d.dir, title: d.path }),
    el('div', { class: 'md-actions' },
      el('button', { class: 'btn', html: `${icon('external', 14)}<span>Open</span>`, onclick: () => app.openItems([{ p: d.path, n: d.name }]) }),
      el('button', { class: 'btn', html: `${icon('link', 14)}<span>Copy path</span>`, onclick: () => copy(d.path, 'Path copied') }),
      el('button', { class: 'btn', html: `${icon('copy', 14)}<span>Copy all</span>`, onclick: () => copy(text, 'All details copied') })));
  body.replaceChildren(file, ...secs.map((s) => el('section', { class: 'md-sec' },
    el('h4', { text: s.title }),
    el('dl', { class: 'md-rows' }, ...s.rows.flatMap(([k, v]) => [
      el('dt', { text: k }),
      el('dd', {}, el('button', { class: 'md-val', text: String(v), title: 'Click to copy', onclick: () => copy(String(v)) })),
    ])))), el('p', { class: 'md-hint', text: 'Click any value to copy it.' }));
}

export function closeMediaDetails() {
  openFor = null;
  document.removeEventListener('keydown', onKey, true);
  const open = document.querySelectorAll('.md-backdrop');
  for (const b of open) b.remove();
  if (!open.length) return; // nothing was open: leave focus alone
  const appEl = document.getElementById('app'); if (appEl) appEl.inert = false;
  const f = returnFocus; returnFocus = null;
  const target = f && f.isConnected && f !== document.body ? f : document.getElementById('view');
  if (target) target.focus({ preventScroll: true });
}
export const mediaDetailsOpen = () => !!document.querySelector('.md-backdrop');
