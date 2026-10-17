// Draws each notification in the chosen design (Bloom, Island, Glass, Edge Light, Signal):
// in (s1) → open (s2) → hold → close → collapse slot. The shapes live in overlay.css (.v-<design>).
const stack = document.getElementById('stack');
const MAX = 3;
const BRAND = '#e0312b';
let pos = 'br', design = 'bloom', accent = 'auto', look = { shape: 'auto', bg: 'dark', size: 'm' }, longText = 'grow';
const OPEN_AT = { bloom: 420, island: 420, rise: 620, spin: 640, ribbon: 620 }; // ms the icon plays alone before the shape opens
const pills = new Map(); // id -> { slot, el, timer, closing }

window.bloom.on('settings', (s) => {
  pos = s.position; design = s.design || 'bloom'; accent = s.accent || 'auto'; look = s.icon || look; longText = s.longText || 'grow';
  stack.className = (pos[0] === 't' ? 'top' : 'bottom') + ' pos-' + pos;
  stack.dataset.design = design;
});

window.bloom.on('notify', (n) => {
  if (pills.has(n.id)) return;
  const open = [...pills.entries()].filter(([, p]) => !p.closing);
  if (open.length >= MAX) dismiss(open[0][0]);
  add(n);
});

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function add(n) {
  const slot = el('div', 'slot');
  const pill = el('div', `n v-${design} is-${look.shape} ib-${look.bg} iz-${look.size}`);
  const fixed = accent !== 'auto' ? accent : null; // his chosen colour beats the app's own
  if (fixed) Brand.apply(pill, [fixed]);
  if (n.seconds) pill.style.setProperty('--life', n.seconds + 's'); // Signal's countdown bar
  const card = el('div', 'card');
  const icon = el('div', 'icon');
  const txt = el('div', 'txt');
  let title = n.title || n.body, body = n.title ? n.body : '';
  if (longText === 'essentials') { body = LongText.essentials(body); if (!n.title) title = LongText.essentials(title); }
  txt.append(el('small', '', `${n.app} · now`), el('b', '', title), el('span', '', body));
  const x = el('div', 'x', '×');
  card.append(el('div', 'bar'), icon, txt, x, el('div', 'prog'));
  pill.append(el('div', 'halo'), el('div', 'ring'), card);
  slot.append(pill);
  if (pos[0] === 't') stack.prepend(slot); else stack.append(slot);
  LongText.fit(pill, slot, txt, design, longText); // long text: the pill grows instead of cutting it

  if (n.icon) {
    const img = new Image();
    img.onload = () => { const cols = Brand.apply(pill, fixed ? [fixed] : Brand.colors(img)); if (design === 'edge') window.bloom.edge(cols); };
    img.onerror = () => { mono(icon, n.app); if (design === 'edge') window.bloom.edge([fixed || BRAND]); };
    img.src = n.icon;
    icon.append(img);
    if (n.iconRound) icon.classList.add('round');
  } else { mono(icon, n.app); if (design === 'edge') window.bloom.edge([fixed || BRAND]); }

  const p = { slot, el: pill, timer: null, closing: false };
  pills.set(n.id, p);

  pill.addEventListener('mouseenter', () => { window.bloom.mouse(false); clearTimeout(p.timer); });
  // n.seconds = Windows' own banner time for this toast (0 = it stays until dismissed, like reminders/calls)
  pill.addEventListener('mouseleave', () => { window.bloom.mouse(true); if (!p.closing && n.seconds) p.timer = setTimeout(() => dismiss(n.id), 2500); });
  pill.addEventListener('click', () => { window.bloom.open(n.id); dismiss(n.id, true); });
  x.addEventListener('click', (e) => { e.stopPropagation(); dismiss(n.id); });

  requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add('s1')));
  setTimeout(() => pill.classList.add('s2'), OPEN_AT[design] ?? 140); // icon first, then the shape opens
  if (n.seconds && longText === 'grow') n.seconds += LongText.extraSeconds((title + body).length); // time to read it
  if (n.seconds) p.timer = setTimeout(() => dismiss(n.id), n.seconds * 1000); // starts folding when Windows' would leave
}

function mono(icon, name) {
  icon.textContent = (name || '?').trim().charAt(0).toUpperCase();
  icon.classList.add('mono');
}

function dismiss(id, opened) {
  const p = pills.get(id);
  if (!p || p.closing) return;
  p.closing = true;
  clearTimeout(p.timer);
  p.el.classList.remove('s2');
  setTimeout(() => p.el.classList.remove('s1'), opened ? 200 : 450);
  setTimeout(() => p.slot.classList.add('gone'), opened ? 550 : 850);
  setTimeout(() => {
    p.slot.remove(); pills.delete(id);
    if (!opened) window.bloom.dismissed(id);
    if (p.el.matches(':hover')) window.bloom.mouse(true);
    if (!pills.size) window.bloom.idle();
  }, opened ? 950 : 1250);
}

// The glow takes the sender's colour: the most saturated common hue of its icon, lifted to a vivid tone.
function dominant(img) {
  try {
    const s = 24, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, s, s);
    const d = g.getImageData(0, 0, s, s).data;
    const bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255; if (a < 0.5) continue;
      const [h, sat, l] = hsl(d[i], d[i + 1], d[i + 2]);
      if (sat < 0.3 || l < 0.15 || l > 0.9) continue;
      const k = Math.round(h * 24) % 24;
      const b = bins.get(k) || { w: 0, h: 0 };
      const w = sat * a; b.w += w; b.h += h * w; bins.set(k, b);
    }
    let best = null; for (const b of bins.values()) if (!best || b.w > best.w) best = b;
    if (!best || best.w < 6) return BRAND;
    return `hsl(${Math.round((best.h / best.w) * 360)} 85% 58%)`;
  } catch { return BRAND; }
}

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

// ---- sound (absorbed from the old Notification Sounds app) ----
// main sends the active file's bytes once; it is decoded here and replayed through a gain node, so 25 % or 150 % both work.
const audio = { ctx: null, buf: null, volume: 1, last: 0 };
function ctx() { if (!audio.ctx) audio.ctx = new AudioContext({ latencyHint: 'interactive' }); return audio.ctx; }
async function decode(bytes) {
  if (!bytes) return null;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try { return await ctx().decodeAudioData(ab); } catch { return null; }
}
function playBuffer(buf, volume) {
  if (!buf) { window.bloom.played({ skipped: 'no decoded sound' }); return; }
  const c = ctx();
  if (c.state === 'suspended') c.resume();
  const src = c.createBufferSource(); src.buffer = buf;
  const g = c.createGain(); g.gain.value = volume;
  src.connect(g).connect(c.destination);
  src.start();
  window.bloom.played({ duration: buf.duration, volume, at: Date.now(), ctx: c.state, sinkRate: c.sampleRate });
}
window.bloom.on('sound', async (s) => {
  audio.volume = s.volume; audio.buf = await decode(s.bytes);
  window.bloom.loaded({ name: s.name, bytes: s.bytes ? s.bytes.byteLength : 0, decoded: !!audio.buf, duration: audio.buf ? +audio.buf.duration.toFixed(2) : 0, volume: s.volume, ctx: audio.ctx ? audio.ctx.state : 'none' });
});
window.bloom.on('sound:play', async (s) => { playBuffer(s.bytes ? await decode(s.bytes) : audio.buf, s.volume ?? audio.volume); });
// one sound per burst: several toasts landing together play it once
window.bloom.on('notify', (n) => { if (n.sound && Date.now() - audio.last > 700) { audio.last = Date.now(); playBuffer(audio.buf, audio.volume); } });
