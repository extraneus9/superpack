// Motion system — one set of curves for the whole player.
//   out  (expo.out)     things arriving: reveals, panels, the picture settling
//   ui   (quart.out)    buttons and small feedback
//   move (power2.inOut) anything travelling from A to B: morphs, window glides
//   in   (quart.in)     things leaving — always faster than they arrived
//   soft (power1.out)   crossfades
export const EASE = {
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  ui: 'cubic-bezier(0.25, 1, 0.5, 1)',
  move: 'cubic-bezier(0.65, 0, 0.35, 1)',
  in: 'cubic-bezier(0.5, 0, 0.75, 0)',
  soft: 'cubic-bezier(0.33, 1, 0.68, 1)',
};

export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let busy = null;
// Run a DOM change as a view transition: elements that share a view-transition-name glide between
// their old and new places (the video between home and player, between looks); everything else crossfades.
export function morph(update, kind = 'swap') {
  let ran = false;
  const run = async () => { ran = true; await update(); };
  // no transition when there's nothing to watch (hidden / minimised window) or motion is reduced
  if (!document.startViewTransition || reduced() || document.visibilityState !== 'visible') return run().catch((e) => console.error(e));
  const root = document.documentElement;
  if (busy) { try { busy.skipTransition(); } catch {} }
  root.dataset.vt = kind;
  let vt;
  try { vt = document.startViewTransition(run); } catch { delete root.dataset.vt; return run().catch((e) => console.error(e)); }
  busy = vt;
  // Chromium can abort a transition (window resized or hidden mid-way); the change itself still applies
  vt.ready.catch(() => {});
  vt.updateCallbackDone.catch((e) => console.error(e));
  return vt.finished.catch(() => {}).then(async () => {
    if (!ran) await run().catch((e) => console.error(e));
  }).finally(() => {
    if (busy === vt) { busy = null; delete root.dataset.vt; }
  });
}

// Fit ↔ Fill: the picture zooms between the two framings instead of jumping.
export function zoomFit(video, toFill, apply) {
  const box = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  apply();
  if (!vw || !vh || !box.width || !box.height || reduced()) return;
  const k = Math.max(box.width / vw, box.height / vh) / Math.min(box.width / vw, box.height / vh);
  if (k < 1.003) return;
  video.getAnimations().forEach((a) => a.cancel());
  video.animate([{ transform: `scale(${toFill ? 1 / k : k})` }, { transform: 'scale(1)' }], { duration: 640, easing: EASE.out });
}

// A swapped icon pops in rather than blinking.
export function pop(el) {
  if (!el || reduced()) return;
  el.animate([{ transform: 'scale(.55) rotate(-12deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: EASE.out });
}

// Big centre glyph when the picture is clicked (play / pause feedback over the video).
export function flash(host, svg) {
  if (!host || reduced()) return;
  const el = document.createElement('div');
  el.className = 'flash';
  el.innerHTML = svg;
  host.appendChild(el);
  el.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) scale(.7)' },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.28 },
    { opacity: 0, transform: 'translate(-50%, -50%) scale(1.18)' },
  ], { duration: 620, easing: EASE.out }).finished.then(() => el.remove(), () => el.remove());
}

// Words of a title rise out of a mask, one after another.
export function revealWords(container, html, { delay = 0 } = {}) {
  container.innerHTML = html;
  if (reduced()) return;
  [...container.querySelectorAll('.w')].forEach((w, i) => {
    w.animate([{ transform: 'translateY(108%)' }, { transform: 'translateY(0)' }], { duration: 980, delay: delay + i * 70, easing: EASE.out, fill: 'backwards' });
  });
  const em = container.querySelector('em');
  if (em) em.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 620, delay: delay + 260, easing: EASE.out, fill: 'backwards' });
}
export function hideWords(container) {
  const words = [...container.querySelectorAll('.w, em')];
  if (!words.length || reduced()) return Promise.resolve();
  return Promise.all(words.map((w, i) => w.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-108%)', opacity: 0 }],
    { duration: 360, delay: i * 30, easing: EASE.in, fill: 'forwards' }).finished.catch(() => {})));
}

// Elements fade up into place with a stagger (rows on the home page, settings sections).
export function rise(els, { delay = 0, step = 70, y = 26, duration = 820 } = {}) {
  if (reduced()) return;
  els.forEach((el, i) => el.animate([{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration, delay: delay + i * step, easing: EASE.out, fill: 'backwards' }));
}
