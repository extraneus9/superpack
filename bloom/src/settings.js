// bloom app window ("Glow"). State lives in main; this page reads it, edits it, and shows the real pill + real sound.
const api = window.bloomSettings;
const $ = (id) => document.getElementById(id);
const POS = { tc: 'Top center', tr: 'Top right', bc: 'Bottom center', br: 'Bottom right' };
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_SPK = '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.6a6 6 0 010 8.8"/></svg>';
const ICON_MUTE = '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 6l4 4M15 6l-4 4"/></svg>';
const DESIGNS = [
  { key: 'bloom', name: 'Bloom', desc: 'The icon pops in first, the pill unfolds and the text slides out, with a glowing stroke orbiting the edge.' },
  { key: 'island', name: 'Island', desc: 'A small black pill morphs open, like a Dynamic Island. A soft glow breathes in the app colour.' },
  { key: 'glass', name: 'Glass', desc: 'A frosted card drops in. One light trace runs around the border once, then it rests.' },
  { key: 'edge', name: 'Edge Light', desc: 'The edges of your whole screen light up in the app colour, with a compact chip. Like Samsung edge lighting.' },
  { key: 'signal', name: 'Signal', desc: 'An editorial wipe-in. An accent line draws down, the message types on, and a bar counts down.' },
  { key: 'rise', name: 'Rise', isNew: true, desc: 'The icon rises from below, then slides left as the pill opens. The text wipes out of the icon, and a line draws underneath.' },
  { key: 'spin', name: 'Spin', isNew: true, desc: 'The icon spins in as a rounded tile, then slides left as the card opens. The lines slide out one after another.' },
  { key: 'ribbon', name: 'Ribbon', isNew: true, desc: 'The icon drops in from above, then slides left as an arrow-tipped ribbon unrolls. Each line is revealed in turn.' },
];
const OPEN_AT = { bloom: 420, island: 420, rise: 620, spin: 640, ribbon: 620 }; // same as the overlay
const PRESETS = [['#ff3b30', 'Red'], ['#ff8a3d', 'Orange'], ['#3d8bff', 'Blue'], ['#a35cff', 'Violet'], ['#2ee6a8', 'Mint']];
const LOOK = {
  shape: [['auto', 'As the design'], ['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square']],
  bg: [['dark', 'Dark'], ['colour', 'Colour'], ['light', 'Light'], ['none', 'No background']],
  size: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']],
};
let state = null, history = [], peaks = null, peaksFor = null, waveTimer = null, shownLook = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function iconEl(n, cls = 'i') {
  const d = el('span', cls + (n.iconRound ? ' round' : ''));
  if (n.icon) { const img = new Image(); img.src = n.icon; img.onerror = () => { d.textContent = (n.app || '?')[0]; }; d.append(img); }
  else d.textContent = (n.app || '?').charAt(0).toUpperCase();
  return d;
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3600); }

// ---------- render ----------
function render(s) {
  state = s;
  const st = s.settings;
  $('enabled').checked = !st.paused;
  $('state-word').textContent = st.paused ? 'Paused' : 'On';
  document.body.classList.toggle('off', st.paused);
  $('where-b').textContent = POS[st.position];
  document.querySelectorAll('#where-mini i').forEach((i) => i.classList.toggle('on', i.dataset.p === st.position));
  document.querySelectorAll('#p-where button').forEach((b) => b.classList.toggle('on', b.dataset.pos === st.position));
  const longOpts = [['windows', `Same as Windows · ${s.windowsSeconds} s`], [4, '4 seconds'], [7, '7 seconds'], [10, '10 seconds']];
  $('long-b').textContent = (longOpts.find(([v]) => String(v) === String(st.seconds)) || longOpts[0])[1];
  $('p-long').replaceChildren(...longOpts.map(([v, label]) => {
    const b = el('button', String(v) === String(st.seconds) ? 'on' : '', label);
    b.onclick = (e) => { e.stopPropagation(); api.set('seconds', v); closePops(); };
    return b;
  }));
  const vol = st.sound.volume;
  $('vol').value = vol; $('vol').style.setProperty('--p', (vol / 150) * 100 + '%');
  $('vol-b').textContent = st.sound.on ? vol + '%' : 'Muted';
  $('mute').innerHTML = st.sound.on ? ICON_SPK : ICON_MUTE;
  $('start-b').textContent = st.startWithWindows ? 'With Windows' : 'Manual';
  $('c-start').classList.toggle('hot', st.startWithWindows);
  const active = s.sounds.find((x) => x.file === st.sound.active);
  $('sname').textContent = active ? active.label : 'No sound yet';
  $('count').textContent = s.historyCount;
  $('hidewin').checked = !!st.hideWindows;
  $('hidewin').closest('.winrow').classList.toggle('busy', !!s.popupBusy);
  $('win-sub').textContent = s.popupBusy ? 'Working… (Windows notifications pause for about 2 seconds)'
    : st.hideWindows ? (s.popupPending ? `${s.popupPending} new app(s) still show Windows' popup: switch off and on to include them.` : "Windows' popup is off for every app: only bloom shows. Turn this off to bring it back.")
    : 'Only bloom shows. Notifications still arrive. Turn it off to undo.';
  $('design-name').textContent = (DESIGNS.find((d) => d.key === st.design) || DESIGNS[0]).name;
  document.querySelectorAll('.dcard').forEach((c) => c.classList.toggle('on', c.dataset.key === st.design));
  const lookKey = JSON.stringify([st.design, st.accent, st.icon, st.customColors, st.longText]);
  if (shownLook !== lookKey) { shownLook = lookKey; pill(); renderRail(); renderLook(); if (document.body.classList.contains('designs-open')) renderCards(); }
  renderLib();
  if (peaksFor !== st.sound.active) loadWave(st.sound.active);
}

// ---------- the pill on stage ----------
function pillEl(n, design, tintPage) {
  const slot = el('div', 'slot');
  const st = state ? state.settings : { accent: 'auto', icon: { shape: 'auto', bg: 'dark', size: 'm' }, longText: 'grow' };
  const p = el('div', `n v-${design} is-${st.icon.shape} ib-${st.icon.bg} iz-${st.icon.size}`);
  const fixed = st.accent !== 'auto' ? st.accent : null;
  if (fixed) { Brand.apply(p, [fixed]); if (tintPage) document.body.style.setProperty('--c', fixed); }
  p.style.setProperty('--life', '4s');
  const card = el('div', 'card');
  const ic = el('div', 'icon' + (n.iconRound ? ' round' : ''));
  if (n.icon) { const img = new Image(); img.src = n.icon; img.onload = () => { const cols = Brand.apply(p, fixed ? [fixed] : Brand.colors(img)); if (tintPage) document.body.style.setProperty('--c', cols[0]); }; ic.append(img); }
  else { ic.classList.add('mono'); ic.textContent = (n.app || '?')[0]; if (tintPage) document.body.style.setProperty('--c', fixed || '#ff3b30'); }
  const txt = el('div', 'txt');
  let title = n.title || n.body, body = n.title ? n.body : '';
  if (st.longText === 'essentials') { body = LongText.essentials(body); if (!n.title) title = LongText.essentials(title); }
  txt.append(el('small', '', `${n.app} · now`), el('b', '', title), el('span', '', body));
  card.append(el('div', 'bar'), ic, txt, el('div', 'prog'));
  p.append(el('div', 'halo'), el('div', 'ring'), card);
  slot.append(p);
  return { slot, p };
}
function play(p, design) {
  p.classList.remove('s1', 's2'); void p.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => p.classList.add('s1')));
  setTimeout(() => p.classList.add('s2'), OPEN_AT[design] ?? 140);
}
const SAMPLE = { app: 'bloom', title: 'Your notifications, redrawn', body: 'Click to preview with your sound.' };
function pill() {
  const design = (state && state.settings.design) || 'bloom';
  const { slot, p } = pillEl(history[0] || SAMPLE, design, true);
  $('holder').replaceChildren(slot);
  LongText.fit(p, slot, p.querySelector('.txt'), design, (state && state.settings.longText) || 'grow');
  play(p, design);
}

// ---------- design gallery: every template loops a live preview ----------
let cardLoop = null;
function renderCards() {
  const n = history[0] || SAMPLE;
  $('cards').replaceChildren(...DESIGNS.map((d) => {
    const c = el('div', 'dcard'); c.dataset.key = d.key;
    const info = el('div'); const h = el('h3', '', d.name);
    if (state && state.settings.design === d.key) h.append(el('span', 'tag', 'In use'));
    else if (d.isNew) h.append(el('span', 'tag new', 'New'));
    info.append(h, el('p', '', d.desc));
    const ms = el('div', 'mstage'); const mh = el('div', 'mh'); const { slot, p } = pillEl(n, d.key);
    mh.append(slot); ms.append(mh);
    if (d.key === 'edge') ms.append(el('div', 'edgefx'));
    c.append(info, ms);
    c.classList.toggle('on', !!state && state.settings.design === d.key);
    c.onclick = () => { api.set('design', d.key); setTimeout(() => api.test(), 300); };
    c._play = () => { play(p, d.key); const fx = ms.querySelector('.edgefx'); if (fx) { ['--c', '--c2', '--c3', '--c4'].forEach((k) => fx.style.setProperty(k, p.style.getPropertyValue(k) || '#ff3b30')); fx.classList.remove('on'); void fx.offsetWidth; fx.classList.add('on'); } };
    return c;
  }));
  const all = () => document.querySelectorAll('.dcard').forEach((c) => c._play && c._play());
  clearInterval(cardLoop); all(); cardLoop = setInterval(all, 4400);
}
// ---------- colour rail (left edge of the design panel): Auto + 5 presets + his own colours + colour map ----------
function swatch(value, label, extra = '') {
  const b = el('button', 'sw ' + extra); b.title = label; b.dataset.v = value;
  if (value !== 'auto' && value !== '+') b.style.setProperty('--s', value);
  b.classList.toggle('on', !!state && state.settings.accent === value);
  return b;
}
function renderRail() {
  if (!state) return;
  const st = state.settings, rail = $('rail');
  const items = [el('small', 'rl', 'Colour')];
  const auto = swatch('auto', 'App colours: each notification uses the colours of the app that sent it (Claude orange, Gmail its four colours)', 'auto'); auto.append(el('span', '', 'App'));
  auto.onclick = () => api.set('accent', 'auto'); items.push(auto, el('small', 'swcap', 'App colours'));
  for (const [v, label] of PRESETS) { const b = swatch(v, label); b.onclick = () => api.set('accent', v); items.push(b); }
  if (st.customColors.length) items.push(el('i', 'rsep'));
  for (const v of st.customColors) {
    const b = swatch(v, 'Your colour ' + v, 'mine'); b.onclick = () => api.set('accent', v);
    const x = el('span', 'del', '×'); x.title = 'Remove this colour';
    x.onclick = (e) => { e.stopPropagation(); api.set('customColors', st.customColors.filter((c) => c !== v)); if (st.accent === v) api.set('accent', 'auto'); };
    b.append(x); items.push(b);
  }
  const add = swatch('+', 'Pick your own colour', 'add'); add.append(el('span', '', '+'));
  add.onclick = (e) => { e.stopPropagation(); openPicker(st.accent !== 'auto' ? st.accent : '#ff3b30', add); };
  items.push(add);
  rail.replaceChildren(...items);
}

// colour map: saturation/brightness square + hue strip + hex box
const pk = { h: 0, s: 1, v: 1 };
const hsv2hex = (h, s, v) => { const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };
function hex2hsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
}
function paintPicker(fromHex) {
  const hex = hsv2hex(pk.h, pk.s, pk.v);
  $('sv').style.setProperty('--h', pk.h);
  $('svdot').style.left = pk.s * 100 + '%'; $('svdot').style.top = (1 - pk.v) * 100 + '%';
  $('hue').value = Math.round(pk.h);
  $('pv').style.background = hex;
  if (!fromHex) $('hex').value = hex;
}
function openPicker(hex, anchor) {
  Object.assign(pk, hex2hsv(hex)); paintPicker();
  const p = $('picker'), r = anchor.getBoundingClientRect(), box = $('designs').getBoundingClientRect();
  p.style.top = Math.max(60, Math.min(r.top - box.top - 40, box.height - 300)) + 'px';
  p.classList.add('open');
}
function closePicker() { $('picker').classList.remove('open'); }
function svDrag(e) {
  const r = $('sv').getBoundingClientRect();
  pk.s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); pk.v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); paintPicker();
}
$('sv').addEventListener('pointerdown', (e) => { $('sv').setPointerCapture(e.pointerId); svDrag(e); $('sv').onpointermove = svDrag; });
$('sv').addEventListener('pointerup', () => { $('sv').onpointermove = null; });
$('hue').oninput = (e) => { pk.h = +e.target.value; paintPicker(); };
$('hex').oninput = (e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { Object.assign(pk, hex2hsv(v[0] === '#' ? v : '#' + v)); paintPicker(true); } };
$('puse').onclick = () => {
  const hex = hsv2hex(pk.h, pk.s, pk.v);
  api.set('customColors', [hex, ...state.settings.customColors.filter((c) => c !== hex)]);
  api.set('accent', hex); closePicker(); setTimeout(() => api.test(), 250);
};
$('pcancel').onclick = closePicker;
$('picker').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => { if (!e.target.closest('#picker') && !e.target.closest('.sw.add')) closePicker(); });

// ---------- icon look: shape · background · logo size, picked by looking ----------
function lookIcon(shape, bg, size) {
  const n = history.find((x) => x.icon && !x.iconRound) || history[0] || SAMPLE;
  const w = el('div', `n is-${shape} ib-${bg} iz-${size}`);
  const st = state.settings; if (st.accent !== 'auto') Brand.apply(w, [st.accent]);
  const ic = el('div', 'icon');
  if (n.icon) { const img = new Image(); img.src = n.icon; img.onload = () => { if (st.accent === 'auto') Brand.apply(w, Brand.colors(img)); }; ic.append(img); }
  else { ic.classList.add('mono'); ic.textContent = (n.app || '?')[0]; }
  w.append(ic); return w;
}
// Long messages: grow to fit (see everything) or essentials only (key sentence). Little drawings show the difference.
function longRow(st) {
  const r = el('div', 'lrow'); r.append(el('h4', '', 'Long messages'));
  const opts = el('div', 'lopts');
  for (const [v, label, lines] of [['grow', 'Grow to fit', 4], ['essentials', 'Essentials', 1]]) {
    const b = el('button', 'lopt long' + ((st.longText || 'grow') === v ? ' on' : ''));
    const pic = el('div', 'lpic'); pic.append(el('i', 't'));
    for (let k = 0; k < lines; k++) pic.append(el('i', k === lines - 1 ? 'end' : ''));
    b.append(pic, el('span', '', label));
    b.onclick = () => { api.set('longText', v); setTimeout(() => api.test(), 250); };
    opts.append(b);
  }
  r.append(opts); return r;
}
function renderLook() {
  if (!state) return;
  const st = state.settings, box = $('look');
  const row = (title, key, list, make) => {
    const r = el('div', 'lrow'); r.append(el('h4', '', title));
    const opts = el('div', 'lopts');
    for (const [v, label] of list) {
      const b = el('button', 'lopt' + (st.icon[key] === v ? ' on' : ''));
      b.append(make(v), el('span', '', label));
      b.onclick = () => { api.set({ shape: 'iconShape', bg: 'iconBg', size: 'iconSize' }[key], v); setTimeout(() => api.test(), 250); };
      opts.append(b);
    }
    r.append(opts); return r;
  };
  box.replaceChildren(
    el('h3', 'sec', 'App icons'),
    row('Shape', 'shape', LOOK.shape, (v) => lookIcon(v, st.icon.bg, st.icon.size)),
    row('Background', 'bg', LOOK.bg, (v) => lookIcon(st.icon.shape === 'auto' ? 'circle' : st.icon.shape, v, st.icon.size)),
    row('Logo size', 'size', LOOK.size, (v) => lookIcon(st.icon.shape === 'auto' ? 'circle' : st.icon.shape, st.icon.bg, v)),
    longRow(st),
    el('h3', 'sec', 'Designs'),
  );
}

function openPanel(name) {
  ['drawer-open', 'lib-open', 'designs-open'].forEach((k) => document.body.classList.toggle(k, k === name && !document.body.classList.contains(k)));
  if (document.body.classList.contains('designs-open')) renderCards(); else clearInterval(cardLoop);
  if (document.body.classList.contains('drawer-open')) renderDrawer();
}
function fit() { document.documentElement.style.setProperty('--z', Math.max(1.05, Math.min(1.45, Math.min(innerWidth, 1180) / 760)).toFixed(2)); }

function dominant(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data; const bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2;
      if (mx === mn) continue;
      const dd = mx - mn, s = l > .5 ? dd / (2 - mx - mn) : dd / (mx + mn); if (s < .3 || l < .15 || l > .9) continue;
      let h = mx === r ? (gg - b) / dd + (gg < b ? 6 : 0) : mx === gg ? (b - r) / dd + 2 : (r - gg) / dd + 4; h /= 6;
      const k = Math.round(h * 24) % 24, o = bins.get(k) || { w: 0, h: 0 }; o.w += s; o.h += h * s; bins.set(k, o);
    }
    let best = null; for (const o of bins.values()) if (!best || o.w > best.w) best = o;
    return best && best.w > 6 ? `hsl(${Math.round((best.h / best.w) * 360)} 85% 58%)` : '#ff3b30';
  } catch { return '#ff3b30'; }
}

// ---------- sound: waveform from the real file, lights up while it plays ----------
async function loadWave(file) {
  peaksFor = file; peaks = null;
  if (file) {
    try {
      const bytes = await api.soundBytes(file);
      const ac = new OfflineAudioContext(1, 8000, 8000);
      const buf = await ac.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const ch = buf.getChannelData(0), B = 56, step = Math.max(1, Math.floor(ch.length / B));
      let start = 0; while (start < ch.length && Math.abs(ch[start]) < 0.01) start++; // skip leading silence
      const span = ch.length - start, st = Math.max(1, Math.floor(span / B));
      peaks = Array.from({ length: B }, (_, i) => { let m = 0; for (let j = start + i * st; j < Math.min(ch.length, start + (i + 1) * st); j++) m = Math.max(m, Math.abs(ch[j])); return m; });
      const mx = Math.max(...peaks) || 1; peaks = peaks.map((p) => Math.max(0.07, Math.sqrt(p / mx)));
      void step;
    } catch { peaks = null; }
  }
  drawWave();
}
function drawWave() {
  const w = $('wave');
  const p = peaks || Array.from({ length: 56 }, () => 0.07);
  w.replaceChildren(...p.map((h) => { const i = el('i'); i.style.height = Math.round(h * 100) + '%'; return i; }));
}
function lightWave(duration) {
  const bars = [...$('wave').children]; clearInterval(waveTimer);
  const t0 = performance.now(), ms = Math.max(400, duration * 1000);
  waveTimer = setInterval(() => {
    const k = (performance.now() - t0) / ms;
    bars.forEach((b, i) => b.classList.toggle('lit', i / bars.length <= k && k < 1));
    if (k >= 1) clearInterval(waveTimer);
  }, 30);
}

// ---------- library ----------
function renderLib() {
  if (!state) return;
  const list = $('liblist');
  if (!state.sounds.length) { list.replaceChildren(el('p', 'none', 'No sounds yet. Drop one below.')); return; }
  list.replaceChildren(...state.sounds.map((s) => {
    const r = el('div', 'snd' + (s.file === state.settings.sound.active ? ' on' : ''));
    const pp = el('button', 'pp'); pp.innerHTML = ICON_PLAY; pp.title = 'Play';
    pp.onclick = (e) => { e.stopPropagation(); api.playSound(s.file); };
    const rm = el('button', 'rm', 'Remove');
    rm.onclick = (e) => { e.stopPropagation(); api.removeSound(s.file); };
    r.append(pp, el('b', '', s.label), rm);
    r.onclick = () => api.set('soundActive', s.file);
    return r;
  }));
}
async function addFiles(files) {
  if (!files || !files.length) return;
  const res = await api.addSounds(files);
  if (res.errors.length) toast(res.errors[0]);
  else if (res.added.length) { toast(`Now playing on every notification: ${res.added[res.added.length - 1].replace(/\.[^.]+$/, '')}`); setTimeout(() => api.playSound(), 300); }
}

// ---------- history: ticker + "see all" drawer ----------
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + ' min'; if (s < 86400) return Math.floor(s / 3600) + ' h';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function renderTicker() {
  const t = $('ticker');
  if (!history.length) { t.replaceChildren(el('span', 'empty-tick', 'Notifications bloom shows will appear here.')); return; }
  t.replaceChildren(...history.slice(0, 4).map((n) => {
    const s = el('span'); s.append(iconEl(n), el('b', '', n.app), document.createTextNode(` · ${n.title ? n.body || n.title : n.body} · ${ago(n.time)}`));
    return s;
  }));
  $('count').textContent = history.length;
}
function dayLabel(t) {
  const d = new Date(t), today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function renderDrawer() {
  const list = $('dlist');
  $('dcount').textContent = history.length ? `${history.length}` : '';
  if (!history.length) { list.replaceChildren(el('p', 'none', 'Nothing yet.')); return; }
  const out = []; let day = null;
  for (const n of history) {
    const dl = dayLabel(n.time); if (dl !== day) { day = dl; out.push(el('div', 'day', dl)); }
    const r = el('div', 'row'); const t = el('div');
    t.append(el('b', '', `${n.app} · ${n.title || n.body}`), el('span', '', n.title ? n.body : ''));
    r.append(iconEl(n), t, el('time', '', new Date(n.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    out.push(r);
  }
  list.replaceChildren(...out);
}
function toggleDrawer(open) {
  const o = open ?? !document.body.classList.contains('drawer-open');
  document.body.classList.remove('lib-open', 'designs-open'); clearInterval(cardLoop);
  document.body.classList.toggle('drawer-open', o);
  if (o) renderDrawer();
}

// ---------- popovers ----------
function closePops() { document.querySelectorAll('.chip.open').forEach((c) => c.classList.remove('open')); }
function togglePop(chip) { const was = chip.classList.contains('open'); closePops(); if (!was) chip.classList.add('open'); }

// ---------- events ----------
$('wmin').onclick = () => api.min();
$('wmax').onclick = () => api.max();
$('wclose').onclick = () => api.close();
api.onMax((m) => { $('wmax').innerHTML = m ? '<svg viewBox="0 0 16 16"><rect x="5" y="3" width="8" height="8" rx="1.5"/><path d="M3 6v6.5a.5.5 0 00.5.5H10"/></svg>' : '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>'; $('wmax').title = m ? 'Restore' : 'Maximize'; });

$('enabled').onchange = (e) => api.set('paused', !e.target.checked);
$('stage').onclick = () => { api.test(); };
$('play').onclick = () => api.playSound();
$('wave').onclick = () => api.playSound();
$('soundbtn').onclick = (e) => { e.stopPropagation(); openPanel('lib-open'); };
$('designbtn').onclick = (e) => { e.stopPropagation(); openPanel('designs-open'); };
$('libclose').onclick = () => document.body.classList.remove('lib-open');
$('designclose').onclick = () => { document.body.classList.remove('designs-open'); clearInterval(cardLoop); };
$('pick').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

$('c-where').onclick = () => togglePop($('c-where'));
document.querySelectorAll('#p-where button').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); api.set('position', b.dataset.pos); closePops(); setTimeout(() => api.test(), 250); }; });
$('c-long').onclick = () => togglePop($('c-long'));
$('c-start').onclick = () => state && api.set('startWithWindows', !state.settings.startWithWindows);
$('vol').oninput = (e) => { $('vol-b').textContent = e.target.value + '%'; e.target.style.setProperty('--p', (e.target.value / 150) * 100 + '%'); };
$('vol').onchange = (e) => { api.set('soundVolume', +e.target.value); if (!state.settings.sound.on) api.set('soundOn', true); setTimeout(() => api.playSound(), 120); };
$('mute').onclick = () => state && api.set('soundOn', !state.settings.sound.on);

$('all').onclick = () => toggleDrawer();
$('dclose').onclick = () => toggleDrawer(false);
$('clear').onclick = () => { api.clearHistory(); history = []; renderDrawer(); renderTicker(); };
document.addEventListener('click', (e) => { if (!e.target.closest('.chip')) closePops(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePops(); toggleDrawer(false); document.body.classList.remove('lib-open', 'designs-open'); clearInterval(cardLoop); } });

// drag a sound anywhere onto the window
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); addFiles(e.dataTransfer.files); });

$('hidewin').onchange = async (e) => {
  const on = e.target.checked;
  const r = await api.hideWindows(on);
  if (r && r.busy) return;
  if (r && r.error) { toast("Couldn't change Windows' setting: " + r.error + '. Nothing was changed.'); return; }
  toast(on ? `Windows popups are off for every app (${r.total}). Only bloom shows now.` : `Windows popups are back for ${r.count} apps, exactly as before.`);
};
$('wintest').onclick = () => {
  api.windowsTest();
  toast(state && state.settings.hideWindows ? 'Sent. Only the bloom version should appear, not the Windows one.' : 'Sent. The switch is off, so you will see the Windows popup too.');
};
api.onState(render);
api.onPlayed((p) => lightWave(p.duration));
api.onHistory((n) => { history.unshift(n); renderTicker(); if (document.body.classList.contains('drawer-open')) renderDrawer(); pill(); if (state) { state.historyCount = history.length; } });
addEventListener('resize', fit);

(async () => {
  fit();
  [state, history] = await Promise.all([api.get(), api.history()]);
  render(state); drawWave(); renderTicker();
})();
setInterval(renderTicker, 30000);
