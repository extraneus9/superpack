// Theater: a video takes over the file area (not the whole screen). Opened by double-clicking the preview
// player, its full-view button, or Space on a selected video. Esc / ✕ goes back to the folder; the preview
// player picks up where the theater left off. Space plays/pauses, ← → skip 5 s, F = real full screen.
import { el, fileUrl } from './util.js';
import { icon } from './icons.js';

let open = null;
export const theaterOpen = () => !!open;

export function openTheater(path, { time = 0, playing = true, name = '', from = null } = {}) {
  closeTheater();
  const area = document.querySelector('#view');
  if (!area) return;
  const v = el('video', { src: fileUrl(path), controls: true, autoplay: playing, disablePictureInPicture: true });
  v.currentTime = time;
  const x = el('button', { class: 'th-x', title: 'Back to the folder (Esc)', html: icon('close', 14) + '<span>Back to folder</span>' });
  const title = el('div', { class: 'th-name', text: name });
  const root = el('div', { id: 'theater', role: 'dialog', 'aria-label': 'Video' }, v, title, x);
  const place = () => { const r = area.getBoundingClientRect(); Object.assign(root.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
  place();
  const key = (e) => {
    if (document.querySelector('#modal-root .modal-backdrop')) return; // a dialog is on top: its own keys win
    e.stopPropagation();
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen(); else closeTheater(); }
    else if (k === ' ') { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
    else if (k === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
    else if (k === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); }
    else if (k === 'f' || k === 'F') { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen().catch(() => {}); }
  };
  x.addEventListener('click', () => closeTheater());
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeTheater(); }); // click the dark area = back
  window.addEventListener('keydown', key, true);
  window.addEventListener('resize', place);
  document.body.append(root);
  open = { root, v, key, place, from };
  if (playing) v.play().catch(() => {});
  return v;
}

export function closeTheater() {
  if (!open) return;
  const { root, v, key, place, from } = open;
  open = null;
  window.removeEventListener('keydown', key, true);
  window.removeEventListener('resize', place);
  // hand the position back to the preview player it came from
  if (from && from.isConnected) { try { from.currentTime = v.currentTime; } catch {} }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  root.remove();
  document.querySelector('#view')?.focus();
}
