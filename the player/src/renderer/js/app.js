// the player — renderer. One video element, a showreel home, three player looks, a settings drawer.
// Moving parts are driven every display frame by transforms only, so nothing steps at the video's 24 fps.
import { $, $$, clamp, esc, fmt, timecode, icon, aspectKey, baseName, stem } from './util.js';
import { Engine } from './engine.js';
import { LOOKS, LOOK_NAMES, pills as pillsHTML, speedLabel } from './looks.js';
import { Home } from './home.js';
import { renderSettings } from './settings-ui.js';
import { renderDetails } from './details.js';
import { morph, zoomFit, pop, flash, rise, reduced } from './motion.js';

const api = window.api;
const body = document.body;
const video = $('#v');
const stage = $('#stage');
const pv = $('#pv');
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// every navigation bumps this; an older one that is still loading gives up when it sees a newer number
let nav = 0;

const S = {
  env: null, settings: null, engine: null, home: null,
  info: null, siblings: [], view: 'boot',
  loopA: null, loopB: null, played: false, lastSave: 0,
  binds: {}, prog: { scale: [], move: [], buf: [] }, scrub: null,
};
window.__app = S; // for QA

// ---------- settings ----------
async function setSetting(patch) {
  S.settings = await api.setSettings(patch);
  applyTheme();
  return S.settings;
}
function applyTheme() {
  const s = S.settings, r = document.documentElement.style;
  r.setProperty('--accent', s.accent);
  if (s.accent !== applyTheme.accent) { applyTheme.accent = s.accent; if (S.info) waveImages(); } // the audio wave's fill follows the accent
  r.setProperty('--glass-blur', s.glassBlur + 'px');
  r.setProperty('--glass-tint', (s.glassTint / 100).toFixed(3));
  r.setProperty('--title-font', { ogg: '"Ogg Text", "Instrument Serif", Georgia, serif', instrument: '"Instrument Serif", Georgia, serif', inter: '"Inter", "Segoe UI", sans-serif' }[s.titleFont] || '"Ogg Text", Georgia, serif');
  body.classList.toggle('title-sans', s.titleFont === 'inter');
  for (const id of Object.keys(LOOKS)) body.classList.toggle('look-' + id, s.look === id);
  video.loop = !!s.loop;
  applyFit();
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------- files ----------
async function prepare(file) {
  const [info, siblings] = await Promise.all([api.probe(file), api.siblings(file)]);
  return { info, siblings };
}
function resumeAt(info) {
  const pos = S.settings.resume ? Number(S.settings.positions[info.path] || 0) : 0;
  return pos > 5 && pos < info.duration - 5 ? pos : 0;
}
function setCurrent({ info, siblings }) {
  savePosition();
  S.info = info; S.siblings = siblings; S.loopA = S.loopB = null; S.played = false;
  S.details = null;
  if (drawerOpen('details')) openDetails(); // the open details drawer follows to the new file
  api.win('title', `${info.name} — the player`);
  setSetting({ recent: [{ path: info.path, at: Date.now() }, ...(S.settings.recent || []).filter((r) => r.path !== info.path)].slice(0, 200) });
  body.classList.toggle('kind-audio', info.kind === 'audio');
  body.classList.toggle('mode-transcode', info.mode === 'transcode');
  const art = $('.audio-art', stage);
  if (info.kind === 'audio') { waveImages(); art.querySelector('span').textContent = stem(info.name); }
  else for (const img of art.querySelectorAll('img')) img.removeAttribute('src');
  if (info.kind === 'video' && info.mode === 'direct') pv.src = info.url; else pv.removeAttribute('src');
  applyFit();
  if (info.mode === 'transcode') toast(`Converting <b>${esc(info.video ? info.video.codecName : info.audio.codecName)}</b> live so it plays here`);
}

// opening a file: plays it (default) or shows it on the home page
// Audio: the waveform IS the progress bar — the played part fills in the accent colour, a thin head rides the edge,
// click or drag it to move. Two copies of the same wave (dim ink + accent), revealed by transforms only (165 Hz safe).
const wv = { el: document.querySelector('.audio-art .wv'), clip: document.querySelector('.wv-clip'), inner: document.querySelector('.wv-inner'), track: document.querySelector('.wv-track'), ghost: document.querySelector('.wv-ghost'), last: '' };
function waveImages() {
  if (!S.info || S.info.kind !== 'audio') return;
  const url = (c) => `${S.env.base}/wave?f=${S.info.b64}&w=1600&h=360&c=${c}`;
  wv.el.querySelector('.wv-base').src = url('f4f2ee');
  wv.el.querySelector('.wv-fill').src = url(String(S.settings.accent || '#e3262d').replace('#', ''));
  wv.last = '';
}
function waveProgress(p) {
  const k = p.toFixed(5);
  if (k === wv.last) return;
  wv.last = k;
  wv.clip.style.transform = `translate3d(${((p - 1) * 100).toFixed(4)}%, 0, 0)`;
  wv.inner.style.transform = `translate3d(${((1 - p) * 100).toFixed(4)}%, 0, 0)`;
  wv.track.style.transform = `translate3d(${(p * 100).toFixed(4)}%, 0, 0)`;
}
wv.el.addEventListener('pointermove', (e) => {
  if (!S.info || S.scrub) return;
  const r = wv.el.getBoundingClientRect(), f = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
  wv.ghost.style.transform = `translate3d(${(f * r.width).toFixed(1)}px, 0, 0)`;
  wv.ghost.firstElementChild.textContent = fmt(f * S.info.duration);
  wv.ghost.classList.add('on');
});
wv.el.addEventListener('pointerleave', () => wv.ghost.classList.remove('on'));

// Autoplay: does a file he opens start by itself (on) or wait on its first frame for Play (off)?
async function setAutoplay(on) {
  await setSetting({ startPaused: !on });
  syncState();
  if (drawerOpen('settings')) redrawSettings();
  toast(on ? '<b>Autoplay on</b> · files start playing when they open' : '<b>Autoplay off</b> · files open paused, waiting for Play', 2200);
}

// play = show it in the player (vs the home page); autostart = start playing (default: Settings › "When a video opens")
async function openFile(file, { play = null, from = null, at = null, autostart = null } = {}) {
  if (!file) return;
  const my = ++nav;
  let prep;
  try { prep = await prepare(file); mark('prepared'); } catch (e) { toast(`Couldn't open <b>${esc(baseName(file))}</b>. ${esc(e.message || '')}`, 4000); if (S.view === 'boot') toHome(null); return; }
  if (my !== nav) return;
  const goPlay = play != null ? play : (S.view === 'player' || S.settings.startOn !== 'home');
  if (!goPlay) return toHome({ file, time: null });
  const run = autostart != null ? autostart : !S.settings.startPaused;
  if (S.view === 'player') return swapFile(prep, at, run);
  return enterPlayer(prep, { fromEl: from, at, my, run });
}

// home → player: the picture you clicked grows into the player
async function enterPlayer(prep, { fromEl = null, at = null, my = nav, run = true } = {}) {
  const start = at != null ? at : resumeAt(prep.info);
  setCurrent(prep);
  S.engine.load(prep.info, start, false);
  await S.engine.ready(450);
  mark('frame');
  if (my !== nav) return; // a newer click or navigation took over (it owns the return spot and the morph)
  if (S.view === 'boot') {
    showPlayer(); if (run) S.engine.play();
    await wrapWindow(0);
    S.shownAt = performance.now(); api.showWindow();
    return;
  }
  S.homeReturn = S.view === 'home' ? S.home.snapshot(fromEl, prep.info.path) : null;
  if (fromEl) fromEl.style.viewTransitionName = 'media';
  await morph(() => {
    if (fromEl) fromEl.style.viewTransitionName = '';
    S.home.sleep();
    showPlayer();
    if (run) S.engine.play();
  }, 'to-player');
  await wrapWindow();
}

// another file while playing: the old picture dissolves into the new one
async function swapFile(prep, at = null, run = true) {
  const start = at != null ? at : resumeAt(prep.info);
  await morph(async () => {
    setCurrent(prep);
    S.engine.load(prep.info, start, run);
    await S.engine.ready(450);
    renderLook();
  }, 'file');
  await wrapWindow();
}

// player → home: the video shrinks back into the showreel, which carries on from the same moment
async function toHome(focus = null) {
  const fromPlayer = S.view === 'player';
  if (fromPlayer && S.home.valid(S.homeReturn)) return backToSameSpot(S.homeReturn);
  const my = ++nav;
  if (fromPlayer) savePosition();
  if (!(await S.home.load(focus))) return; // a newer home load took over
  mark('library');
  if (my !== nav) return; // a file was opened meanwhile: it wins
  const first = S.home.start();
  await Promise.race([first, wait(90)]); // a cached clip lands within this; otherwise it fades in after the window shows
  mark('reel');
  if (my !== nav) { S.home.sleep(); return; }
  if (S.view === 'boot') { showHome(); S.shownAt = performance.now(); api.showWindow(); return; }
  const media = fromPlayer ? S.home.heroMedia() : null;
  await morph(() => {
    S.engine.pause();
    if (media) media.style.viewTransitionName = 'media';
    showHome();
  }, 'to-home');
  if (media) media.style.viewTransitionName = '';
  api.homeSize();
}

// He opened the video from the home page: return to exactly where he was (same scroll, same row position),
// the video shrinking back into the card he clicked, which rings once.
async function backToSameSpot(snap) {
  const my = ++nav;
  S.homeReturn = null;
  savePosition();
  const path = S.info ? S.info.path : null;
  const pos = S.engine.time, dur = S.info ? S.info.duration : 0;
  S.engine.pause();
  // with the window-shape option on, the window first glides back to his home size (the video still showing),
  // so the page appears once, already in place — nothing jumps after it lands
  await api.homeSize();
  if (my !== nav) return;
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  let target = null;
  await morph(async () => {
    showHome();
    // back from the hero: the reel picks up at the moment he stopped, and its buttons show the new resume point
    if (snap.hero) await S.home.heroAt(path, pos);
    S.home.restore(snap);
    target = S.home.returnTarget(snap, path);
    if (target) target.style.viewTransitionName = 'media';
  }, 'to-home');
  if (target) target.style.viewTransitionName = '';
  S.home.markReturn(snap, path, dur);
}

function savePosition(force = true) {
  // only a file that actually played moves its resume point (browsing never erases it)
  if (!S.info || !S.settings.resume || !S.played) return;
  const t = S.engine.time, d = S.info.duration;
  if (!force && Date.now() - S.lastSave < 5000) return;
  S.lastSave = Date.now();
  setSetting({ positions: { [S.info.path]: t > 5 && t < d - 5 ? Math.round(t * 10) / 10 : 0 } });
}

// ---------- views ----------
function placeStage(root) {
  // a screen without a video slot parks the stage so it can't cover the page
  const slot = (root && $('[data-slot="stage"]', root)) || $('#stage-park');
  if (stage.parentElement !== slot) slot.appendChild(stage);
}
function showHome() {
  S.view = 'home'; api.view('home');
  api.win('title'); // back to the app name
  body.classList.add('view-home'); body.classList.remove('view-player', 'view-boot', 'idle', 'playing');
  placeStage(null);
  stopTicker();
}
function showPlayer() {
  S.view = 'player'; api.view('player');
  body.classList.add('view-player'); body.classList.remove('view-home', 'view-boot');
  renderLook();
}
function renderLook() {
  if (!S.info) return;
  const look = LOOKS[S.settings.look] ? S.settings.look : 'glass';
  $('#player').innerHTML = LOOKS[look]({ info: S.info, settings: S.settings, siblings: S.siblings, base: S.env.base });
  placeStage($('#player'));
  bindNodes();
  if (look === 'editbay') buildLanes();
  fillDurations();
  syncState(true);
  syncLoop();
  frame(true);
  wake();
}

// the window takes the video's shape (unless maximised / fullscreen / turned off)
async function wrapWindow(ms = 380, retry = true) {
  if (!S.settings.wrapWindow || !S.info || !S.info.video || S.view !== 'player') return;
  if (body.classList.contains('fullscreen') || body.classList.contains('maximized')) return;
  const slot = stage.parentElement;
  if (!slot || !slot.dataset.slot) return;
  const r = slot.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const aspect = S.info.video.dispW / S.info.video.dispH;
  await api.wrap({ aspect, extraW: window.innerWidth - r.width, extraH: window.innerHeight - r.height, ms });
  await wait(60);
  const r2 = slot.getBoundingClientRect();
  // a look whose panels changed height with the new size gets one exact correction
  if (retry && r2.height && Math.abs(r2.width / r2.height - aspect) / aspect > 0.012) return wrapWindow(0, false);
}

// cache every live field so the per-frame work is a handful of transform writes
function bindNodes() {
  S.binds = {};
  for (const el of $$('#player [data-bind]')) (S.binds[el.dataset.bind] ||= []).push(el);
  S.prog = { scale: $$('#player [data-prog="scale"]'), move: $$('#player [data-prog="move"]'), buf: $$('#player [data-prog="buf"]') };
  lastSX = lastBuf = '';
  const vol = $('#player [data-vol]');
  if (vol) { vol.value = video.muted ? 0 : video.volume; vol.oninput = () => { video.muted = false; video.volume = Number(vol.value); }; }
}
const setText = (k, txt) => { for (const el of S.binds[k] || []) if (el.textContent !== txt) el.textContent = txt; };
const setHTML = (k, html) => { for (const el of S.binds[k] || []) if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } };

// ---------- the frame loop ----------
let raf = 0, idleFrames = 0, lastNow = 0, shownP = 0, smoothUntil = 0, lastSX = '', lastBuf = '';
const hp = { track: null, target: 0, cur: 0, active: false };
function frame(force = false) {
  const e = S.engine, info = S.info;
  if (!info) return;
  const now = performance.now();
  const dt = Math.min(64, now - (lastNow || now)); lastNow = now;
  const d = info.duration || e.duration || 0, t = e.time;
  const p = d ? clamp(t / d, 0, 1) : 0;
  // a seek glides the head over ~150 ms; playback and dragging follow exactly
  if (force || S.scrub || now > smoothUntil) shownP = p;
  else shownP += (p - shownP) * (1 - Math.exp(-dt / 55));
  if (Math.abs(p - shownP) < 0.0003) shownP = p;
  const sx = `scaleX(${shownP.toFixed(5)})`;
  if (sx !== lastSX) {
    lastSX = sx;
    const tx = `translate3d(${(shownP * 100).toFixed(4)}%, 0, 0)`;
    for (const el of S.prog.scale) el.style.transform = sx;
    for (const el of S.prog.move) el.style.transform = tx;
  }
  if (info.kind === 'audio') waveProgress(shownP);
  if (S.prog.buf.length) {
    const b = video.buffered;
    const bs = `scaleX(${(d && b.length ? clamp((e.offset + b.end(b.length - 1)) / d, 0, 1) : 0).toFixed(4)})`;
    if (bs !== lastBuf) { lastBuf = bs; for (const el of S.prog.buf) el.style.transform = bs; }
  }
  if (S.view !== 'player') return;
  setText('cur', fmt(t));
  setText('rem', '-' + fmt(d - t));
  if (S.binds.tc) {
    const fps = e.fps;
    setText('tc', timecode(t, fps));
    setText('rem-tc', '-' + timecode(Math.max(0, d - t), fps));
    if (info.video) setText('frames', `F ${Math.floor(t * fps + 1e-6)} / ${Math.max(0, Math.round(d * fps) - 1)}`);
  }
  if (hp.active && hp.track) {
    hp.cur += (hp.target - hp.cur) * (1 - Math.exp(-dt / 40));
    if (Math.abs(hp.target - hp.cur) < 0.0005) { hp.cur = hp.target; hp.active = false; }
    hp.track.style.transform = `translate3d(${(hp.cur * 100).toFixed(3)}%, 0, 0)`;
  }
}
function tick() {
  raf = 0;
  frame();
  const busy = S.engine.playing || S.scrub || performance.now() < smoothUntil + 60 || hp.active;
  if (busy) idleFrames = 0;
  if (busy || idleFrames++ < 4) raf = requestAnimationFrame(tick);
}
function kick() { if (!raf && S.view === 'player') { idleFrames = 0; lastNow = performance.now(); raf = requestAnimationFrame(tick); } }
function stopTicker() { cancelAnimationFrame(raf); raf = 0; }

let lastPlaying = null;
function syncState(force = false) {
  const e = S.engine;
  if (!S.info || S.view !== 'player') return;
  const playing = e.playing;
  if (force || playing !== lastPlaying) {
    const changed = lastPlaying !== null && playing !== lastPlaying;
    lastPlaying = playing;
    setHTML('pp-icon', icon(playing ? 'pause' : 'play'));
    if (changed && !force) for (const el of S.binds['pp-icon'] || []) pop(el.firstElementChild);
    setText('pp-word', playing ? 'Pause' : 'Play');
    body.classList.toggle('playing', playing);
    if (!playing) wake();
  }
  const r = e.reverse ? -e.reverse : e.rate;
  setText('speed', e.reverse ? `◀ ${e.reverse}×` : speedLabel(r));
  setHTML('vol-icon', icon(video.muted || video.volume === 0 ? 'mute' : 'vol'));
  setText('vol-word', video.muted ? 'MUTED' : `VOL ${Math.round(video.volume * 100)}`);
  const fill = body.classList.contains('fit-fill');
  setHTML('fit-icon', icon(fill ? 'fill' : 'fit'));
  setText('fit-word', fill ? 'FILL' : 'FIT');
  setHTML('full-icon', icon(body.classList.contains('fullscreen') ? 'unfull' : 'full'));
  for (const el of S.binds['loop-word'] || []) el.hidden = S.loopA == null;
  for (const el of S.binds['conv-word'] || []) el.hidden = e.mode !== 'transcode';
  for (const btn of $$('#player [data-act="speed"]')) btn.classList.toggle('on', Number(btn.dataset.v) === r);
  const auto = !S.settings.startPaused;
  for (const btn of $$('#player [data-act="autoplay"]')) { btn.classList.toggle('on', auto); btn.setAttribute('aria-pressed', String(auto)); }
  for (const btn of $$('#player [data-act="autoplay-set"]')) btn.classList.toggle('on', (btn.dataset.v === 'on') === auto);
  for (const btn of $$('#player [data-act="fit-set"]')) btn.classList.toggle('on', (btn.dataset.v === 'fill') === fill);
}
function syncLoop() {
  const d = S.info ? S.info.duration : 0;
  const on = S.loopA != null && d > 0;
  body.classList.toggle('has-loop', on);
  if (!on) return;
  const a = S.loopA / d, b = (S.loopB != null ? S.loopB : d) / d;
  for (const el of $$('#player [data-loop]')) { el.style.left = (a * 100).toFixed(3) + '%'; el.style.width = (Math.max(0, b - a) * 100).toFixed(3) + '%'; }
}

// durations for the folder strips arrive one by one
async function fillDurations() {
  const info = S.info;
  for (const s of S.siblings) {
    if (S.info !== info) return;
    if (s.path === info.path) continue;
    try {
      const p = await api.probe(s.path);
      for (const el of $$(`#player [data-dur="${CSS.escape(s.path)}"]`)) el.textContent = fmt(p.duration) + (p.mode === 'transcode' ? ` · ${p.video ? p.video.codecName : p.container}` : '');
    } catch {}
  }
}

// ---------- fit / fill ----------
function applyFit() {
  const mode = S.info && S.info.video ? (S.settings.fit[aspectKey(S.info)] || 'fit') : 'fit';
  body.classList.toggle('fit-fill', mode === 'fill');
}
async function setFit(mode) {
  if (!S.info || !S.info.video) return;
  const key = aspectKey(S.info);
  S.settings.fit[key] = mode;
  zoomFit(video, mode === 'fill', () => applyFit());
  syncState();
  await setSetting({ fit: { [key]: mode } });
  const label = key === 'other' ? 'videos with this shape' : `${key} videos`;
  const wrapped = S.settings.wrapWindow && !body.classList.contains('fullscreen') && !body.classList.contains('maximized');
  toast(`<b>${mode === 'fill' ? 'Fill' : 'Fit'}</b> · all ${label}${wrapped ? ' when maximised or fullscreen' : ' open like this now'}`, 2600);
}

// ---------- Edit Bay lanes: ruler, filmstrip, waveform ----------
function buildLanes() {
  const lanes = $('#player [data-scrub="lanes"]');
  if (!lanes || !S.info) return;
  const d = S.info.duration || 1, w = lanes.clientWidth - 32;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => d / s <= 12) || 3600;
  let ticks = '';
  for (let s = 0; s <= d + 1e-6; s += step) {
    const x = s / d;
    ticks += `<span style="left:${(x * 100).toFixed(3)}%;${x === 0 ? 'transform:none' : x > 0.985 ? 'transform:translateX(-100%)' : ''}">${fmt(s)}</span>`;
  }
  $('[data-ruler]', lanes).innerHTML = ticks;
  const strip = $('[data-strip]', lanes);
  if (S.info.video) {
    const ar = S.info.video.dispW / S.info.video.dispH || 16 / 9;
    const n = clamp(Math.round(w / (56 * ar)), 4, 40);
    let html = '';
    for (let i = 0; i < n; i++) html += `<i style="background-image:url('${S.env.base}/frame?f=${S.info.b64}&t=${((i + 0.5) / n * d).toFixed(2)}&w=160')"></i>`;
    strip.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    strip.innerHTML = html;
  } else strip.innerHTML = '';
  $('[data-wave]', lanes).style.backgroundImage = S.info.audio ? `url('${S.env.base}/wave?f=${S.info.b64}&w=${Math.round(clamp(w, 400, 3000))}&h=104&c=b9bec7')` : 'none';
}
let laneTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(laneTimer);
  laneTimer = setTimeout(() => { if (S.view === 'player' && S.settings.look === 'editbay') buildLanes(); }, 250);
});

// ---------- scrubbing + hover previews ----------
const railOf = (el) => el.querySelector('.rail, .lane-box') || el;
function fracOf(el, e) {
  const r = railOf(el).getBoundingClientRect();
  return clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-scrub]');
  if (!el || e.button !== 0 || !S.info || S.view !== 'player') return;
  e.preventDefault();
  S.scrub = { el, wasPlaying: S.engine.playing };
  if (S.engine.mode === 'transcode') S.engine.pause();
  el.setPointerCapture(e.pointerId);
  body.classList.add('scrubbing');
  scrubTo(e);
});
document.addEventListener('pointermove', (e) => {
  if (S.scrub) { scrubTo(e); return; }
  const el = e.target.closest('[data-scrub]');
  if (el && el.querySelector('[data-hp]') && S.view === 'player') hoverPreview(el, e); else hideHover();
});
document.addEventListener('pointerup', () => {
  if (!S.scrub) return;
  const { wasPlaying } = S.scrub;
  S.scrub = null;
  body.classList.remove('scrubbing');
  if (S.engine.mode === 'transcode' && wasPlaying) S.engine.play();
  wake();
});
function scrubTo(e) {
  const t = fracOf(S.scrub.el, e) * S.info.duration;
  if (S.engine.mode === 'transcode') { S.engine.hold = t; clearTimeout(scrubTo.t); scrubTo.t = setTimeout(() => S.engine.seek(t), 120); }
  else S.engine.seek(t);
  kick();
}
let pvBusy = false, pvNext = null;
function hoverPreview(el, e) {
  const track = el.querySelector('[data-hp]'), bubble = track.firstElementChild;
  const f = fracOf(el, e), t = f * S.info.duration;
  const was = bubble.classList.contains('on');
  hp.track = track; hp.target = f;
  if (!was) { hp.cur = f; track.style.transform = `translate3d(${(f * 100).toFixed(3)}%, 0, 0)`; }
  hp.active = true;
  bubble.classList.add('on');
  bubble.querySelector('b').textContent = fmt(t);
  kick();
  if (!S.info.video) { bubble.classList.add('no-pic'); return; }
  bubble.classList.remove('no-pic');
  if (S.info.mode === 'direct' && pv.src) {
    bubble.classList.remove('img');
    pv._hp = bubble;
    if (pvBusy) { pvNext = t; return; }
    pvBusy = true; pv.currentTime = t;
  } else {
    bubble.classList.add('img');
    const img = bubble.querySelector('img');
    const want = `${S.env.base}/frame?f=${S.info.b64}&t=${Math.round(t)}&w=320`;
    if (img.dataset.want !== want) { img.dataset.want = want; clearTimeout(hoverPreview.t); hoverPreview.t = setTimeout(() => { img.src = want; }, 60); }
  }
}
pv.addEventListener('seeked', () => {
  const bubble = pv._hp;
  if (bubble) {
    const c = bubble.querySelector('canvas');
    const ar = pv.videoWidth / pv.videoHeight || 16 / 9;
    const h = Math.round(c.width / ar);
    if (c.height !== h) c.height = h;
    c.getContext('2d').drawImage(pv, 0, 0, c.width, c.height);
  }
  pvBusy = false;
  if (pvNext != null) { const n = pvNext; pvNext = null; pvBusy = true; pv.currentTime = n; }
});
function hideHover() { for (const h of $$('.hover-prev.on')) h.classList.remove('on'); }

// ---------- Glass: controls rest out of the way while the film plays ----------
let idleTimer = null;
function wake() {
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const overDock = $('#player [data-keepalive]:hover');
    if (S.view === 'player' && S.engine.playing && !overDock && !S.scrub && !drawerOpen()) body.classList.add('idle');
  }, (S.settings.hideDelay || 1.6) * 1000);
}
document.addEventListener('mousemove', () => { if (S.view === 'player') wake(); });
document.addEventListener('mouseleave', () => { if (S.view === 'player' && S.engine.playing) body.classList.add('idle'); });

// ---------- actions ----------
async function switchLook(look) {
  await setSetting({ look });
  if (S.view !== 'player') return;
  await morph(() => renderLook(), 'look');
  toast(LOOK_NAMES[look], 900);
  await wrapWindow();
}
const actions = {
  'win-min': () => api.win('min'),
  'win-max': () => api.win('max'),
  'win-close': () => { savePosition(); api.win('close'); },
  toggle: () => S.engine.toggle(),
  'toggle-click': (el, e) => {
    if (e.detail !== 1) return;
    clearTimeout(actions._clk);
    actions._clk = setTimeout(() => { S.engine.toggle(); flash(el, icon(S.engine.playing ? 'play' : 'pause')); }, 200);
  },
  home: () => { if (S.view === 'player') toHome({ file: S.info.path, time: S.engine.time }); },
  back: () => S.engine.seek(S.engine.time - S.settings.seekStep),
  fwd: () => S.engine.seek(S.engine.time + S.settings.seekStep),
  'frame-prev': () => S.engine.step(-1),
  'frame-next': () => S.engine.step(1),
  mute: () => { video.muted = !video.muted; const v = $('#player [data-vol]'); if (v) v.value = video.muted ? 0 : video.volume; },
  fullscreen: () => api.win('fullscreen'),
  fit: () => setFit(body.classList.contains('fit-fill') ? 'fit' : 'fill'),
  'fit-set': (el) => setFit(el.dataset.v),
  speed: (el) => S.engine.setRate(Number(el.dataset.v)),
  'speed-cycle': () => { const i = SPEEDS.indexOf(S.engine.rate); S.engine.setRate(SPEEDS[(i + 1) % 7]); },
  'loop-in': () => { S.loopA = S.engine.time; if (S.loopB != null && S.loopB <= S.loopA) S.loopB = null; syncLoop(); syncState(); toast(`Loop in · ${fmt(S.loopA)}`); },
  'loop-out': () => {
    const t = S.engine.time;
    if (S.loopA == null) S.loopA = 0;
    if (t <= S.loopA) { toast('Loop out has to come after loop in'); return; }
    S.loopB = t; S.engine.seek(S.loopA); syncLoop(); syncState(); toast(`Looping ${fmt(S.loopA)} – ${fmt(S.loopB)}`);
  },
  'loop-clear': () => { S.loopA = S.loopB = null; syncLoop(); syncState(); toast('Loop cleared'); },
  snapshot: async () => {
    if (!S.info || !S.info.video) return;
    S.engine.pause();
    const fps = S.engine.fps, frameNo = Math.floor(S.engine.time * fps + 1e-6);
    try {
      const out = await api.snapshot(S.info.path, frameNo, fps, `${stem(S.info.name)}_${timecode(S.engine.time, fps).replace(/:/g, '-')}`);
      S.lastSnapshot = out;
      toast(`Frame saved · <b>${esc(baseName(out))}</b>`, 3200);
    } catch (e) { toast(esc(e.message || 'Could not save the frame')); }
  },
  pick: (el) => openFile(el.dataset.path, { play: true }),
  'home-play': (el) => {
    const fromHero = el.dataset.hero === '1';
    const from = fromHero ? S.home.heroMedia() : el.querySelector('.th');
    openFile(el.dataset.path, { play: true, from, at: el.dataset.from === '0' ? 0 : null });
  },
  'home-project': async (el) => {
    const my = ++nav;
    await morph(async () => { if ((await S.home.load({ file: el.dataset.path, time: null })) && my === nav && S.view === 'home') S.home.start(); }, 'project');
  },
  'reel-go': (el) => S.home.show(Number(el.dataset.i)),
  'row-scroll': (el) => S.home.scrollRow(el),
  open: async () => { const f = await api.openDialog(); if (f) openFile(f, { play: true }); },
  settings: () => openSettings(),
  'settings-close': () => closeSettings(),
  'drawer-close': () => closeSettings(),
  autoplay: () => setAutoplay(!!S.settings.startPaused),
  'autoplay-set': (el) => setAutoplay(el.dataset.v === 'on'),
  noop: () => {}, // the audio waveform seeks; a click there must not also play/pause
  details: () => {
    if (drawerOpen('details')) return closeSettings();
    if (detailsPending) { detailsReq++; detailsPending = false; return; } // second press while it loads = never mind
    openDetails();
  },
  'details-copy': (el) => { api.copy(el.textContent); toast(`Copied · <b>${esc(el.textContent.length > 60 ? el.textContent.slice(0, 60) + '…' : el.textContent)}</b>`, 1600); },
  'details-copy-path': () => { if (S.details) { api.copy(S.details.path); toast('Path copied', 1400); } },
  'details-copy-all': () => { if (S.details) { api.copy(S.details.text); toast('All details copied', 1400); } },
  'details-reveal': () => { if (S.details) api.reveal(S.details.path); },
  'snap-folder': async () => { const d = await api.pickFolder(); if (d) { await setSetting({ snapshotDir: d }); redrawSettings(); } },
  'register-default': async () => {
    try {
      const r = await api.registerDefault();
      if (r.ok) toast(r.machine ? 'Registered. In Windows Settings, choose <b>the player</b> for video and audio.'
        : 'Windows permission was not given, so Default apps won’t list it. Right-click a video › Open with › <b>the player</b> › Always.', 7000);
    }
    catch (e) { toast('Could not register: ' + esc(e.message), 5000); }
  },
  shortcuts: async () => { const r = await api.makeShortcuts(); toast(r.ok ? 'Shortcuts added to the Start menu and the desktop' : 'Could not add the shortcuts', 4000); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.stopPropagation(); fn(el, e); }
});
document.addEventListener('dblclick', (e) => {
  if (e.target.closest('#player [data-slot="stage"]')) { clearTimeout(actions._clk); api.win('fullscreen'); }
});
document.addEventListener('wheel', (e) => {
  if (!S.info || S.view !== 'player' || !e.target.closest('[data-slot="stage"], [data-vol]')) return;
  video.muted = false;
  video.volume = clamp(video.volume + (e.deltaY < 0 ? 0.05 : -0.05), 0, 1);
  const v = $('#player [data-vol]'); if (v) v.value = video.volume;
  toast(`Volume ${Math.round(video.volume * 100)}`, 800);
}, { passive: true });

// ---------- settings drawer ----------
function redrawSettings() {
  const el = $('#settings');
  const scroll = $('#settings .s-body')?.scrollTop || 0;
  el.innerHTML = renderSettings(S.settings, S.env);
  const b = $('#settings .s-body'); if (b) b.scrollTop = scroll;
}
// Settings and File details are the same kind of drawer: one open at a time, over a dim scrim.
// which drawer is open, logically (the hidden attribute only lags behind for the close animation)
const drawerOpen = (id) => (id ? S.drawer === id : S.drawer != null);
let drawerTimer = 0;
function openDrawer(id, html) {
  S.drawer = id;
  clearTimeout(drawerTimer); // a pending close must not hide the drawer being opened
  const el = $('#' + id), scrim = $('#scrim');
  for (const other of $$('.drawer')) if (other !== el && !other.hidden) { other.classList.remove('on'); other.hidden = true; }
  // the button that opened the drawer would keep focus and reopen it on Space / Enter
  const a = document.activeElement;
  if (a && a !== document.body && !el.contains(a)) a.blur();
  el.innerHTML = html;
  el.hidden = false; scrim.hidden = false;
  void el.offsetWidth; // commit the off-screen start so the slide-in plays
  requestAnimationFrame(() => { el.classList.add('on'); scrim.classList.add('on'); });
  rise($$(`#${id} section, #${id} .d-file`), { delay: 140, step: 40, y: 16, duration: 640 });
  body.classList.remove('idle');
}
function openSettings() { detailsReq++; detailsPending = false; openDrawer('settings', renderSettings(S.settings, S.env)); }
// File details: read the file, then open — unless he went home, opened Settings, changed file or pressed D again meanwhile
let detailsReq = 0, detailsPending = false;
async function openDetails() {
  if (!S.info || S.view !== 'player') return;
  const file = S.info.path, my = nav, req = ++detailsReq;
  detailsPending = true;
  let d;
  try { d = await api.details(file); } catch (e) { if (req === detailsReq) { detailsPending = false; toast(`Couldn't read the details · ${esc(e.message || '')}`, 3000); } return; }
  if (req !== detailsReq) return;
  detailsPending = false;
  if (my !== nav || S.view !== 'player' || drawerOpen('settings') || !S.info || S.info.path !== file) return;
  const { html, text } = renderDetails(d, S.engine.mode);
  S.details = { path: d.path, text };
  openDrawer('details', html);
}
function closeSettings() {
  S.drawer = null;
  const scrim = $('#scrim');
  for (const el of $$('.drawer')) {
    // give the keyboard back to the page (a focused button in the closed drawer would swallow Space)
    if (el.contains(document.activeElement)) document.activeElement.blur();
    el.classList.remove('on');
  }
  scrim.classList.remove('on');
  clearTimeout(drawerTimer);
  drawerTimer = setTimeout(() => {
    if ($$('.drawer').some((d) => d.classList.contains('on'))) return;
    for (const el of $$('.drawer')) el.hidden = true;
    scrim.hidden = true;
  }, 340);
  if (S.view === 'player') wake(); // the Glass controls rest again while the film plays
}
const setPath = (key, value) => key.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);
async function onSettingInput(e) {
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const key = el.dataset.set;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'range') value = Number(el.value);
  else if (el.type === 'color') value = el.value;
  else value = el.dataset.v;
  if (key === 'seekStep') value = Number(value);
  if (key === 'startPaused') value = value === 'true';
  const out = $(`[data-out="${key}"]`);
  if (out) out.textContent = key === 'hideDelay' ? `${value}s` : key === 'glassTint' ? `${value}%` : `${value}px`;
  if (key === 'look') { await switchLook(value); redrawSettings(); return; }
  await setSetting(setPath(key, value));
  if (key.startsWith('pills.')) { const p = $('#player [data-pills]'); if (p && S.info) p.innerHTML = pillsHTML(S.info, S.settings.pills); }
  if (key === 'seekStep' && S.view === 'player') renderLook();
  if (key === 'wrapWindow' && value) wrapWindow();
  if (key.startsWith('homeRows.')) {
    // the showreel uses the same sources; outside a project it is rebuilt (same clips → just the rows redraw)
    if (S.view === 'home') { if (S.home.focus) S.home.refreshRows(); else await S.home.rebuildReel(); }
    else S.homeReturn = null; // the hidden home is out of date: going back rebuilds it with the new rows
  }
  if (key.startsWith('fit.')) syncState();
  if (e.type === 'click' || el.type === 'color' || el.type === 'checkbox') redrawSettings();
}
$('#settings').addEventListener('click', (e) => { if (e.target.closest('button[data-set]')) onSettingInput(e); });
$('#settings').addEventListener('input', (e) => { if (e.target.matches('input[type=range]')) onSettingInput(e); });
$('#settings').addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox], input[type=color]')) onSettingInput(e); });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], textarea')) return;
  const k = e.key, e2 = S.engine;
  if (k === 'Escape') {
    if (drawerOpen()) return closeSettings();
    if (body.classList.contains('fullscreen')) return api.win('fullscreen', false);
    if (S.view === 'player') return actions.home();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') { e.preventDefault(); return actions.open(); }
  if ((e.ctrlKey || e.metaKey) && k === ',') { e.preventDefault(); return openSettings(); }
  if (drawerOpen()) { if ((k === 'd' || k === 'D') && drawerOpen('details')) closeSettings(); return; } // nothing plays behind an open drawer
  if (S.view === 'home') {
    const cur = S.home.current();
    if (k === 'ArrowRight') { e.preventDefault(); S.home.show(S.home.i + 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); S.home.show(S.home.i - 1); }
    else if ((k === ' ' || k === 'Enter') && cur && !e.target.closest('button')) {
      e.preventDefault();
      openFile(cur.path, { play: true, from: S.home.heroMedia(), autostart: true }); // the showreel's Play button = he asked to play
    }
    return;
  }
  if (S.view !== 'player' || !S.info) return;
  wake();
  const big = e.shiftKey ? 1 : S.settings.seekStep;
  switch (k) {
    case ' ': case 'k': case 'K': e.preventDefault(); k === ' ' ? e2.toggle() : e2.pause(); break;
    case 'ArrowLeft': e.preventDefault(); e2.seek(e2.time - big); break;
    case 'ArrowRight': e.preventDefault(); e2.seek(e2.time + big); break;
    case 'ArrowUp': e.preventDefault(); video.muted = false; video.volume = clamp(video.volume + 0.05, 0, 1); toast(`Volume ${Math.round(video.volume * 100)}`, 800); break;
    case 'ArrowDown': e.preventDefault(); video.volume = clamp(video.volume - 0.05, 0, 1); toast(`Volume ${Math.round(video.volume * 100)}`, 800); break;
    case ',': e2.step(-1); break;
    case '.': e2.step(1); break;
    case 'Home': e2.seek(0); break;
    case 'End': e2.seek(e2.duration - 0.05); break;
    case 'j': case 'J': e2.shuttleBack(); break;
    case 'l': case 'L': { const r = e2.playing && !e2.reverse ? Math.min(e2.rate * 2, 16) : 1; e2.setRate(r); e2.play(); break; }
    case '[': { const i = SPEEDS.indexOf(e2.rate); e2.setRate(SPEEDS[Math.max(0, (i < 0 ? 3 : i) - 1)]); toast(speedLabel(e2.rate), 800); break; }
    case ']': { const i = SPEEDS.indexOf(e2.rate); e2.setRate(SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + 1)]); toast(speedLabel(e2.rate), 800); break; }
    case 'f': case 'F': api.win('fullscreen'); break;
    case 'm': case 'M': actions.mute(); break;
    case 'z': case 'Z': actions.fit(); break;
    case 'd': case 'D': actions.details(); break;
    case 'a': case 'A': actions.autoplay(); break;
    case 's': case 'S': actions.snapshot(); break;
    case 'i': case 'I': actions['loop-in'](); break;
    case 'o': case 'O': actions['loop-out'](); break;
    case 'PageDown': case 'n': case 'N': nextFile(1); break;
    case 'PageUp': case 'p': case 'P': nextFile(-1); break;
    case '1': case '2': case '3': switchLook(['glass', 'editbay', 'alva'][Number(k) - 1]); break;
    default: return;
  }
  kick();
});
function nextFile(dir) {
  if (!S.info || !S.siblings.length) return;
  const i = S.siblings.findIndex((s) => s.path === S.info.path);
  const n = S.siblings[i + dir];
  if (n) openFile(n.path, { play: true, autostart: S.engine.playing }); else toast(dir > 0 ? 'Last file in this folder' : 'First file in this folder', 1200);
}

// ---------- drag and drop ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  const p = f && api.pathForFile(f);
  if (p) openFile(p, { play: true });
});

// ---------- QA hooks ----------
S.openFileForQA = (p, play, autostart = play) => openFile(p, { play, autostart });
S.toHomeForQA = () => actions.home();
S.reloadSettingsForQA = async () => { S.settings = await api.setSettings({}); };

// ---------- boot ----------
// startup marks (ms since the page began loading) — scripts/startup.js reads them
S.marks = { boot: Math.round(performance.now()) };
const mark = (k) => { if (S.marks[k] == null) S.marks[k] = Math.round(performance.now()); };
(async function boot() {
  S.env = await api.init();
  mark('init');
  document.body.classList.toggle('mac', S.env.platform === 'darwin');
  S.settings = S.env.settings;
  S.engine = new Engine(video, S.env.base);
  S.home = new Home($('#home'), { api, env: S.env, settings: () => S.settings });
  video.volume = S.settings.volume; video.muted = S.settings.muted;
  applyTheme();
  const e = S.engine;
  e.addEventListener('frame', () => { if (!e.playing) kick(); });
  e.addEventListener('seeking', () => { smoothUntil = performance.now() + 260; kick(); });
  e.addEventListener('state', () => { syncState(); kick(); });
  e.addEventListener('loaded', () => { applyFit(); syncState(); kick(); });
  e.addEventListener('fallback', () => { body.classList.add('mode-transcode'); toast('This file needs converting · playing it live'); syncState(); });
  e.addEventListener('failed', () => toast(`Couldn't play <b>${esc(S.info ? S.info.name : '')}</b>${S.env.ffmpeg ? '' : ' · FFmpeg is missing'}`, 5000));
  e.addEventListener('ended', () => {
    if (S.info) setSetting({ positions: { [S.info.path]: 0 } });
    if (S.settings.autoplayNext && !S.settings.loop) nextFile(1);
  });
  video.addEventListener('timeupdate', () => {
    if (S.loopB != null && e.time >= S.loopB - 0.02) e.seek(S.loopA || 0);
    if (e.playing) savePosition(false);
  });
  video.addEventListener('playing', () => { S.played = true; });
  video.addEventListener('volumechange', () => setSetting({ volume: Number(video.volume.toFixed(2)), muted: video.muted }));
  video.addEventListener('waiting', () => stage.classList.add('wait'));
  for (const ev of ['playing', 'seeked', 'canplay']) video.addEventListener(ev, () => stage.classList.remove('wait'));
  api.onOpenFile((f) => openFile(f));
  // stay ready: closed = hidden with nothing loaded; the next file (or the tray) brings it back through the
  // same path as a cold start (view 'boot' → load → first picture → reveal), just without starting Electron again
  // window motion: the page grows into place as the window fades in (cinematic: from a soft blur), and back out
  api.onMotion(({ dir, level, ms }) => {
    const app = document.getElementById('app');
    if (!ms || reduced()) { app.getAnimations().forEach((x) => x.cancel()); return; } // instant: just clear any leftover fade
    const deep = level === 'cinematic';
    const frames = [
      { opacity: 0, transform: `scale(${deep ? 0.94 : 0.975})`, filter: deep ? 'blur(10px)' : 'none' },
      { opacity: 1, transform: 'none', filter: 'none' },
    ];
    app.getAnimations().forEach((a) => a.cancel());
    app.animate(dir === 'in' ? frames : frames.slice().reverse(), { duration: ms, easing: dir === 'in' ? 'cubic-bezier(.16,1,.3,1)' : 'cubic-bezier(.55,0,1,.45)', fill: dir === 'in' ? 'none' : 'forwards' });
  });
  api.onBackground(() => {
    const app = document.getElementById('app'); app.getAnimations().forEach((a) => a.cancel());
    S.leftFrom = S.view; // home → the same page comes back instantly; player → a fresh home or the next file
    nav++;
    savePosition();
    if (drawerOpen()) closeSettings();
    S.engine.pause(); S.engine.unload();
    S.home.sleep();
    S.homeReturn = null;
    S.view = 'boot';
  });
  api.onWake((f) => {
    S.wokeAt = performance.now();
    if (f) return openFile(f);
    const h = S.home;
    if (S.leftFrom === 'home' && h.loadedAt && !h.loadedFocus && performance.now() - h.loadedAt < 10 * 60e3) {
      ++nav;
      showHome(); h.start();
      S.shownAt = performance.now(); api.showWindow();
      return;
    }
    return toHome(null);
  });
  api.onWinState((st) => {
    const was = body.classList.contains('fullscreen') || body.classList.contains('maximized');
    body.classList.toggle('fullscreen', st.fullscreen);
    body.classList.toggle('maximized', st.maximized);
    syncState();
    if (was && !st.fullscreen && !st.maximized) setTimeout(() => wrapWindow(320), 80);
  });
  window.addEventListener('beforeunload', () => savePosition());
  if (S.env.background) { S.view = 'boot'; return; } // started with Windows: wait, invisible, for the first file
  if (S.env.file) await openFile(S.env.file);
  else await toHome(null);
})();
