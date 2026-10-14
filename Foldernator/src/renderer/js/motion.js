// Fluidity (Settings → Motion): 0 = Off (instant), 1 = Smooth (short eased transitions),
// 2 = Liquid (spring physics everywhere). Springs are real: a damped-spring ODE is sampled into a CSS
// linear() easing, so the overshoot and settle come from physics, not a bezier guess.
// Everything animates transform/opacity only (GPU-composited), so 5k-item folders stay fast.

let level = 2;
export const motionLevel = () => level;

// Sample a spring (from 0 to 1) into { easing: 'linear(...)', duration } for CSS / Web Animations.
function spring({ stiffness = 210, damping = 20, mass = 1 } = {}) {
  const dt = 1 / 1000;
  let x = 0, v = 0, t = 0;
  const pts = [];
  while (t < 3) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (Math.round(t * 1000) % 8 === 0) pts.push(x);
    if (Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.002 && t > 0.08) break;
  }
  pts.push(1);
  // thin to ~48 points, keep 4 decimals
  const step = Math.max(1, Math.floor(pts.length / 48));
  const out = [0];
  for (let i = step; i < pts.length - 1; i += step) out.push(+pts[i].toFixed(4));
  out.push(1);
  return { easing: `linear(${out.join(', ')})`, duration: Math.round(t * 1000) };
}

const SPRINGS = {
  liquid: spring({ stiffness: 230, damping: 19 }),   // water: visible overshoot, quick settle
  soft: spring({ stiffness: 170, damping: 24 }),     // calm, barely overshoots
  snappy: spring({ stiffness: 420, damping: 32 }),   // small UI moves
};
const EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';

// Easing/duration for a role at the current level.
export function m(role = 'move') {
  if (level === 0) return { duration: 0, easing: 'linear' };
  if (level === 1) return { duration: { move: 170, enter: 160, exit: 120, pop: 160, hover: 110 }[role] || 150, easing: EXPO };
  const s = { move: SPRINGS.liquid, enter: SPRINGS.soft, exit: { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)' }, pop: SPRINGS.liquid, hover: SPRINGS.snappy }[role] || SPRINGS.liquid;
  return { duration: s.duration, easing: s.easing };
}

export function setMotionLevel(n) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  level = reduce ? 0 : Math.max(0, Math.min(2, n | 0));
  const r = document.documentElement;
  r.dataset.motion = String(level);
  const fast = m('hover'), med = m('move'), enter = m('enter');
  r.style.setProperty('--t-fast', fast.duration + 'ms');
  r.style.setProperty('--t-med', (level === 2 ? Math.round(med.duration * 0.8) : med.duration) + 'ms');
  r.style.setProperty('--ease', level === 2 ? SPRINGS.soft.easing : EXPO);
  r.style.setProperty('--ease-spring', level === 2 ? SPRINGS.liquid.easing : EXPO);
  r.style.setProperty('--t-spring', (level === 2 ? SPRINGS.liquid.duration : med.duration) + 'ms');
  r.style.setProperty('--t-enter', enter.duration + 'ms');
  return level;
}

// Web Animations wrapper: no-op when motion is off.
export function animate(el, keyframes, opts = {}, role = 'move') {
  if (!el || level === 0) return null;
  const t = m(role);
  try { return el.animate(keyframes, { duration: t.duration, easing: t.easing, fill: 'none', ...opts }); } catch { return null; }
}

// Items appear when a folder opens. Smooth: one quick fade. Liquid: staggered rise, direction-aware.
export function enter(nodes, dir = 'forward') {
  if (level === 0 || !nodes.length) return;
  // Files are fully visible from the first frame (no fade): opening a folder must feel instant. Liquid only
  // adds a tiny settle so the change of folder still reads as a movement.
  if (level === 1) return;
  const dx = dir === 'back' ? -6 : dir === 'forward' ? 6 : 0;
  nodes.slice(0, 48).forEach((n, i) => {
    try { n.animate([{ transform: `translate(${dx}px, 3px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(0.16,1,0.3,1)', delay: Math.min(i * 3, 45), fill: 'backwards' }); } catch {}
  });
}

// FLIP: things that changed place glide from where they were; new things pop in.
export function flip(nodes, before) {
  if (level === 0 || !before || !before.size) return;
  for (const [key, node] of nodes) {
    const from = before.get(key);
    const to = { top: parseFloat(node.style.top) || 0, left: parseFloat(node.style.left) || 0 };
    if (!from) {
      animate(node, [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], {}, 'pop');
      continue;
    }
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (Math.abs(dy) > 2000) continue; // far jumps: no glide across the whole list
    animate(node, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {}, 'move');
  }
}

// Items leaving (delete / move away): shrink + fade, then resolve.
export function exit(nodes) {
  if (level === 0 || !nodes.length) return Promise.resolve();
  const kf = level === 2
    ? [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(.86)', filter: 'blur(3px)' }]
    : [{ opacity: 1 }, { opacity: 0 }];
  const anims = nodes.map((n) => animate(n, kf, { fill: 'forwards' }, 'exit')).filter(Boolean);
  return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {});
}

// Little bounce (status color set, item landed in a folder…).
export function bounce(el, strength = 1) {
  if (!el || level === 0) return;
  if (level === 1) { animate(el, [{ transform: 'scale(.94)' }, { transform: 'none' }], {}, 'pop'); return; }
  animate(el, [{ transform: `scale(${1 - 0.18 * strength})` }, { transform: 'none' }], {}, 'pop');
}

// Liquid: ghost copies of the dragged items fly into the folder they were dropped on.
export function flyInto(sourceNodes, targetEl) {
  if (level < 2 || !targetEl || !sourceNodes.length) return;
  const tr = targetEl.getBoundingClientRect();
  const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
  sourceNodes.slice(0, 6).forEach((n, i) => {
    const r = n.getBoundingClientRect();
    const ghost = n.cloneNode(true);
    Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0, zIndex: 999, pointerEvents: 'none' });
    ghost.classList.add('fly-ghost');
    document.body.append(ghost);
    const dx = tx - (r.left + r.width / 2), dy = ty - (r.top + r.height / 2);
    const a = ghost.animate([{ transform: 'none', opacity: 0.95 }, { transform: `translate(${dx}px, ${dy}px) scale(.18)`, opacity: 0 }], { duration: 420 + i * 40, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'forwards' });
    a.finished.catch(() => {}).then(() => ghost.remove());
  });
  setTimeout(() => bounce(targetEl, 0.6), 380);
}

// Ripple where something was dropped from outside the app.
export function ripple(x, y, host = document.body) {
  if (level < 2) return;
  const d = document.createElement('div');
  d.className = 'drop-ripple';
  Object.assign(d.style, { left: x + 'px', top: y + 'px' });
  host.append(d);
  d.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 0.55 }, { transform: 'translate(-50%,-50%) scale(3.2)', opacity: 0 }], { duration: 650, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).finished.catch(() => {}).then(() => d.remove());
}

// A single highlight that glides between hovered items (Liquid only).
export class HoverPill {
  constructor(host, selector) {
    this.host = host;
    this.selector = selector;
    this.el = document.createElement('div');
    this.el.className = 'hover-pill';
    host.prepend(this.el);
    this.cur = null;
    host.addEventListener('mouseover', (e) => this.over(e));
    host.addEventListener('mouseleave', () => this.hide());
  }
  ensure() { if (!this.el.isConnected) this.host.prepend(this.el); }
  over(e) {
    if (level < 2) return;
    const n = e.target.closest(this.selector);
    if (!n || !this.host.contains(n)) { if (!e.target.closest('.hover-pill')) this.hide(); return; }
    if (n === this.cur) return;
    this.cur = n;
    this.ensure();
    const hr = this.host.getBoundingClientRect(), r = n.getBoundingClientRect();
    const x = r.left - hr.left + this.host.scrollLeft, y = r.top - hr.top + this.host.scrollTop;
    const first = this.el.style.opacity !== '1';
    if (first) this.el.style.transition = 'none';
    Object.assign(this.el.style, { width: r.width + 'px', height: r.height + 'px', transform: `translate(${x}px, ${y}px)`, opacity: '1' });
    if (first) { void this.el.offsetWidth; this.el.style.transition = ''; }
  }
  hide() { this.cur = null; this.el.style.opacity = '0'; }
}
