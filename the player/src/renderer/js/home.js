// Home — the alva showreel you get when the app opens on its own.
// The hero cycles muted previews of recent videos (or of one project), crossfading clip to clip while the
// title rises out of a mask. Below it, rows you scroll through smoothly (Lenis), always complete:
// the project's files, Continue watching, Recently played, Recent downloads, Recent on this PC, Projects.
// Rows render straight from the folder listing; durations and codecs fill in as cards scroll into view.
import { $, $$, esc, fmt, icon, winButtons, projectTitle, titleFor, stem, ago } from './util.js';
import { EASE, reduced, revealWords, hideWords, rise } from './motion.js';
import { specLine } from './looks.js';
import Lenis from '../../../node_modules/lenis/dist/lenis.mjs';

const CLIP_MS = 7000;
const MAX_REEL = 8;
const pad2 = (n) => String(n).padStart(2, '0');
const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
const SOURCE = { played: 'Recently played', downloads: 'Downloaded', pc: 'Opened on this PC', project: 'Project' };

function seekTo(v, t, ms) {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (done) return; done = true; clearTimeout(timer); v.removeEventListener('seeked', end); v.removeEventListener('loadeddata', onData); resolve(); };
    const onData = () => { if (Math.abs(v.currentTime - t) < 0.5) end(); };
    const timer = setTimeout(end, ms);
    v.addEventListener('seeked', end);
    v.addEventListener('loadeddata', onData);
    const go = () => { try { v.currentTime = t; } catch { end(); } };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  });
}
const imgReady = (img, ms) => new Promise((resolve) => {
  if (img.complete && img.naturalWidth) return resolve();
  const t = setTimeout(resolve, ms);
  img.onload = img.onerror = () => { clearTimeout(t); resolve(); };
});

export class Home {
  constructor(root, deps) {
    this.root = root;
    this.d = deps;          // { api, env, settings: () => settings }
    this.played = []; this.downloads = []; this.pc = []; this.project = []; this.cont = []; this.dirs = []; this.reel = [];
    this.infos = new Map(); // path → probe info (filled lazily)
    this.i = 0; this.cur = 0; this.timer = null; this.showToken = 0;
    this.awake = false; this.started = false; this.paused = false;
    this.focus = null; this.lenis = null; this.layers = []; this.io = null;
    this.queue = []; this.probing = 0; this.loadGen = 0;
    this.hv = null; this.hoverCard = null; this.hoverTimer = null;
    root.addEventListener('pointerover', (e) => this.onOver(e));
    root.addEventListener('pointerout', (e) => this.onOut(e));
  }

  get base() { return this.d.env.base; }
  info(path) { return this.infos.get(path) || null; }
  async probe(path) {
    const hit = this.infos.get(path);
    if (hit) return hit;
    try { const i = await this.d.api.probe(path); this.infos.set(path, i); return i; } catch { return null; } // a failure is retried next time
  }

  // gather what to show; `focus` = { file, time } when coming back from a video or picking a project
  // Returns false when a newer load() started meanwhile (that one renders instead).
  async load(focus = null) {
    const gen = ++this.loadGen, stale = () => gen !== this.loadGen;
    const { api } = this.d, s = this.d.settings(), pos = s.positions || {};
    const lib = await api.library();
    if (stale()) return false;
    // a file that changed on disk (re-export) gets probed again
    for (const x of [...lib.played, ...lib.downloads, ...lib.pc]) {
      const i = this.infos.get(x.path);
      if (i && (i.size !== x.size || Math.abs(i.mtime - x.mtime) > 1)) this.infos.delete(x.path);
    }
    let project = [];
    if (focus && focus.file) project = (await api.siblings(focus.file)).map((x) => ({ ...x, dir: dirOf(x.path) }));
    if (stale()) return false;
    for (const x of project) {
      const i = this.infos.get(x.path);
      if (i && (i.size !== x.size || Math.abs(i.mtime - x.mtime) > 1)) this.infos.delete(x.path);
    }
    // Continue watching needs real durations for its progress bars; projects = the folders of what he played.
    // These and the showreel's probes all run side by side (startup speed); a newer load() simply overwrites.
    const started = lib.played.filter((x) => (pos[x.path] || 0) > 5).slice(0, 24);
    const dirs = [];
    for (const x of lib.played) if (!dirs.some((d) => d.dir === x.dir)) dirs.push({ dir: x.dir, first: lib.played.find((y) => y.dir === x.dir && y.kind === 'video') || x });
    this.focus = focus;
    this.played = lib.played; this.downloads = lib.downloads; this.pc = lib.pc; this.downloadsDir = lib.downloadsDir;
    this.project = project;
    const [, counted, reel] = await Promise.all([
      Promise.all(started.map((x) => this.probe(x.path))),
      Promise.all(dirs.slice(0, 12).map(async (d) => ({ ...d, n: (await api.siblings(d.first.path)).length }))),
      this.pickReel(),
    ]);
    if (stale()) return false;
    this.cont = started.filter((x) => { const i = this.info(x.path); return i && pos[x.path] < i.duration - 5; });
    this.dirs = counted;
    this.reel = reel;
    this.render();
    this.loadedAt = performance.now();
    this.loadedFocus = focus;
    return true;
  }

  // A home-row switch changed: rebuild the showreel from the sources that are on (probes are cached, so it's quick).
  // Same clips → only the rows redraw and the reel keeps playing. Returns false if a newer load/rebuild took over.
  async rebuildReel() {
    const gen = ++this.loadGen;
    const reel = await this.pickReel();
    if (gen !== this.loadGen) return false;
    const same = reel.length === this.reel.length && reel.every((r, i) => r.path === this.reel[i].path);
    if (same) { this.refreshRows(); return true; }
    this.reel = reel;
    this.render();
    this.start();
    return true;
  }

  // the showreel: this project's videos, or played → downloaded → opened on this PC
  // (rows switched off in Settings don't feed the showreel either)
  async pickReel() {
    const show = this.d.settings().homeRows || {};
    const on = (src, list) => (show[src] !== false ? list.map((x) => ({ x, src })) : []);
    let cands = this.focus
      ? this.project.filter((x) => x.kind === 'video').map((x) => ({ x, src: 'project' }))
      // newest first across every source, so clip 1 is the most recent video
      : [...on('played', this.played), ...on('downloads', this.downloads), ...on('pc', this.pc)].filter(({ x }) => x.kind === 'video')
        .sort((a, b) => (b.x.at || 0) - (a.x.at || 0));
    if (this.focus) { const k = cands.findIndex(({ x }) => x.path === this.focus.file); if (k > 0) cands = [...cands.slice(k), ...cands.slice(0, k)]; }
    const seen = new Set(), uniq = [];
    for (const c of cands) {
      const key = c.x.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); uniq.push(c);
      if (uniq.length >= MAX_REEL * 3) break;
    }
    // probe a batch at a time, keeping the order
    const reel = [];
    for (let i = 0; i < uniq.length && reel.length < MAX_REEL; i += MAX_REEL) {
      const part = uniq.slice(i, i + MAX_REEL);
      const infos = await Promise.all(part.map((c) => this.probe(c.x.path)));
      infos.forEach((info, j) => { if (info && info.video && reel.length < MAX_REEL) reel.push({ ...info, src: part[j].src, at: part[j].x.at }); });
    }
    return reel;
  }

  // ---------- markup ----------
  render() {
    this.renderGen = (this.renderGen || 0) + 1;
    this.releaseMedia();
    const empty = !this.played.length && !this.downloads.length && !this.pc.length && !this.project.length;
    this.root.innerHTML = `<div class="H">
      <header class="h-top drag"><span class="mark">the player<em>.</em></span><span class="sp"></span>
        <button class="tbtn nd" data-act="open" title="Open a file  (Ctrl+O)" aria-label="Open a file">${icon('open')}</button>
        <button class="tbtn nd" data-act="settings" title="Settings  (Ctrl+,)" aria-label="Settings">${icon('gear')}</button>${winButtons()}</header>
      <div class="H-scroll"><div class="H-in">
        ${empty ? this.emptyHTML() : this.heroHTML()}
        <div class="rows">${empty ? '' : this.rowsHTML()}</div>
      </div></div></div>`;
    this.scroller = $('.H-scroll', this.root);
    this.content = $('.H-in', this.root);
    this.hero = $('.hero', this.root);
    this.top = $('.h-top', this.root);
    this.layers = $$('.layer', this.root).map((el) => ({ el, video: $('video', el), img: $('img', el) }));
    this.started = false; this.paused = false; this.cur = 0; this.i = 0; // a fresh page always starts at the top
    this.setupScroll();
    this.observeCards();
    this.watchTitle();
    if (this.reel.length === 0 && this.hero && !empty) this.copy(null, true);
    rise($$('.row', this.root), { delay: 260, step: 90 });
  }

  // rows only (a setting changed): the showreel keeps playing
  refreshRows() {
    const rows = $('.rows', this.root);
    if (!rows || $('.hero.empty', this.root)) return;
    rows.innerHTML = this.rowsHTML();
    this.observeCards();
    this.lenis && this.lenis.resize();
  }

  emptyHTML() {
    return `<section class="hero empty dropzone"><div class="dz-in">
      <span class="dz-big">Drop a video or audio file</span>
      <button class="btn-line" data-act="open">${icon('open')} Open file</button>
      <span class="dz-small">mp4 · mov · mkv · hevc · prores · avi · mp3 · wav · flac · and the rest</span></div></section>`;
  }

  heroHTML() {
    return `<section class="hero">
      <div class="reel" aria-hidden="true">
        <div class="layer"><video muted playsinline preload="auto" disablepictureinpicture loop></video><img alt="" hidden></div>
        <div class="layer"><video muted playsinline preload="auto" disablepictureinpicture loop></video><img alt="" hidden></div>
      </div>
      <div class="hero-shade" aria-hidden="true"></div>
      <div class="hero-copy">
        <span class="kicker" data-kicker></span>
        <h1 class="h-title" data-title></h1>
        <span class="h-meta" data-meta></span>
        <div class="h-cta" data-cta></div>
      </div>
      ${this.reel.length > 1 ? `<div class="reel-nav" style="--clip:${CLIP_MS}ms">${this.reel.map((x, k) => `<button class="rseg" data-act="reel-go" data-i="${k}" title="${esc(stem(x.name))}" aria-label="Clip ${k + 1}"><i></i></button>`).join('')}</div>` : ''}
    </section>`;
  }

  card(x, { now = false, progress = 0, sub = '' } = {}) {
    const info = this.info(x.path);
    const thumb = x.kind === 'video'
      ? `<img alt="" loading="lazy" decoding="async" src="${this.base}/frame?f=${x.b64}&p=0.3&w=480&v=${Math.round(x.mtime || 0)}">`
      : `<span class="aud"><img alt="" loading="lazy" decoding="async" src="${this.base}/wave?f=${x.b64}&w=480&h=120&c=f4f2ee&v=${Math.round(x.mtime || 0)}">${icon('music')}</span>`;
    return `<button class="hc${now ? ' now' : ''}" data-act="home-play" data-path="${esc(x.path)}" data-kind="${x.kind}" data-mode="${info ? info.mode : ''}" title="${esc(x.path)}">
      <span class="th">${thumb}${progress ? `<i class="pr"><i style="transform:scaleX(${Math.min(1, progress).toFixed(3)})"></i></i>` : ''}${now ? '<em class="tag">Now</em>' : ''}<span class="dur">${info ? fmt(info.duration) : ''}</span></span>
      <span class="tx"><b>${esc(stem(x.name))}</b><small>${esc(sub)}</small></span></button>`;
  }

  projectCard(d) {
    const f = d.first;
    return `<button class="pc" data-act="home-project" data-path="${esc(f.path)}" title="${esc(d.dir)}">
      <span class="th">${f.kind === 'video' ? `<img alt="" loading="lazy" decoding="async" src="${this.base}/frame?f=${f.b64}&p=0.3&w=480">` : ''}<span class="pname">${esc(projectTitle(d.dir))}<em>.</em></span></span>
      <span class="tx"><small>${d.n} ${d.n === 1 ? 'file' : 'files'}</small></span></button>`;
  }

  row(title, cards, { cls = '', count = null } = {}) {
    if (!cards.length) return '';
    return `<section class="row ${cls}"><div class="row-h"><h2>${esc(title)}</h2>${count != null ? `<span class="cnt">${count}</span>` : ''}<span class="sp"></span>
      <button class="rn" data-act="row-scroll" data-dir="-1" aria-label="Scroll left">${icon('arrowL')}</button>
      <button class="rn" data-act="row-scroll" data-dir="1" aria-label="Scroll right">${icon('arrowR')}</button></div>
      <div class="cards">${cards.join('')}</div></section>`;
  }

  folderLabel(x) { return x.dir === this.downloadsDir ? 'Downloads' : projectTitle(x.dir); }

  rowsHTML() {
    const s = this.d.settings(), pos = s.positions || {}, show = s.homeRows || {};
    const out = [];
    if (this.focus && this.project.length) {
      out.push(this.row(`In ${this.folderLabel(this.project[0])}`,
        this.project.map((x) => this.card(x, { now: x.path === this.focus.file, sub: x.ext.toUpperCase() })), { count: this.project.length }));
    }
    out.push(this.row('Continue watching', this.cont.map((x) => {
      const i = this.info(x.path);
      return this.card(x, { progress: pos[x.path] / i.duration, sub: `${this.folderLabel(x)} · ${fmt(pos[x.path])} of ${fmt(i.duration)}` });
    })));
    if (show.played !== false) out.push(this.row('Recently played', this.played.map((x) => this.card(x, { sub: `${this.folderLabel(x)} · ${ago(x.at)}` })), { count: this.played.length }));
    if (show.downloads !== false) out.push(this.row('Recent downloads', this.downloads.map((x) => this.card(x, { sub: `${this.folderLabel(x)} · ${ago(x.at)}` })), { count: this.downloads.length }));
    if (show.pc !== false) out.push(this.row('Recent on this PC', this.pc.map((x) => this.card(x, { sub: `${this.folderLabel(x)} · ${ago(x.at)}` })), { count: this.pc.length }));
    if (this.dirs.length > 1 || (!this.focus && this.dirs.length)) out.push(this.row('Projects', this.dirs.map((d) => this.projectCard(d)), { cls: 'projects' }));
    return out.join('');
  }

  // ---------- lazy details: a card that scrolls into view gets its duration and preview ability ----------
  observeCards() {
    this.io && this.io.disconnect();
    this.queue = [];
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        this.io.unobserve(en.target);
        // this card and the next few in its row, so a row scrolled sideways is already filled
        let c = en.target;
        for (let k = 0; c && k < 5; k++, c = c.nextElementSibling) if (!c.dataset.filled) { c.dataset.filled = '1'; this.queue.push(c); }
      }
      this.pump();
    }, { root: null, rootMargin: '200px 0px 200px 0px' });
    for (const c of $$('.hc', this.root)) { if (c.dataset.mode) c.dataset.filled = '1'; else this.io.observe(c); }
  }
  pump() {
    while (this.probing < 4 && this.queue.length) {
      const c = this.queue.shift();
      this.probing++;
      this.probe(c.dataset.path).then((i) => {
        this.probing--;
        if (i) {
          c.dataset.mode = i.mode;
          const dur = c.querySelector('.dur');
          if (dur && !dur.textContent) dur.textContent = fmt(i.duration);
        }
        this.pump();
      });
    }
  }

  // ---------- scrolling ----------
  setupScroll() {
    this.lenis && this.lenis.destroy();
    this.lenis = null;
    const onScroll = this.onScroll = (y) => {
      this.top.classList.toggle('solid', y > 24);
      if (!this.hero) return;
      const h = this.hero.offsetHeight || 1;
      const k = Math.min(1, y / h);
      // the reel drifts slower than the page and the words fade as you scroll past them
      const reelEl = $('.reel', this.hero);
      if (reelEl) reelEl.style.transform = `translate3d(0, ${(y * 0.38).toFixed(1)}px, 0) scale(${(1 + k * 0.06).toFixed(4)})`;
      const copy = $('.hero-copy', this.hero);
      if (copy) { copy.style.opacity = String(Math.max(0, 1 - k * 1.7).toFixed(3)); copy.style.transform = `translate3d(0, ${(y * 0.12).toFixed(1)}px, 0)`; }
      const out = y > h * 0.72;
      if (out !== this.paused) { this.paused = out; out ? this.pauseReel() : this.resumeReel(); }
    };
    if (reduced()) { this.scroller.addEventListener('scroll', () => onScroll(this.scroller.scrollTop)); return; }
    this.lenis = new Lenis({
      wrapper: this.scroller, content: this.content, autoRaf: true,
      duration: 1.15, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true, allowNestedScroll: true, gestureOrientation: 'vertical',
    });
    this.lenis.on('scroll', (l) => onScroll(l.scroll));
  }

  scrollRow(btn) {
    const cards = btn.closest('.row').querySelector('.cards');
    cards.scrollBy({ left: Number(btn.dataset.dir) * cards.clientWidth * 0.82, behavior: 'smooth' });
  }

  // ---------- the reel ----------
  start() {
    this.awake = true;
    this.lenis && this.lenis.start();
    if (!this.reel.length) return Promise.resolve();
    if (!this.started) { this.started = true; return this.show(0, { first: true }); }
    this.resumeReel();
    return Promise.resolve();
  }
  sleep() {
    this.awake = false;
    clearTimeout(this.timer);
    for (const L of this.layers) L.video.pause();
    this.leaveCard();
    this.lenis && this.lenis.stop();
  }
  pauseReel() { clearTimeout(this.timer); this.hero && this.hero.classList.add('paused'); for (const L of this.layers) L.video.pause(); }
  resumeReel() {
    if (!this.awake || this.paused || !this.hero) return;
    this.hero.classList.remove('paused');
    const L = this.layers[this.cur];
    if (L && L.video.src && !L.video.hidden) L.video.play().catch(() => {});
    this.schedule();
  }
  releaseMedia() {
    clearTimeout(this.timer);
    ++this.showToken; // a show() still waiting on the old layers gives up
    this.io && this.io.disconnect();
    for (const L of this.layers) { L.video.pause(); L.video.removeAttribute('src'); L.video.load(); }
    if (this.hv) { this.hv.pause(); this.hv.removeAttribute('src'); this.hv.load(); this.hv.remove(); this.hv = null; }
  }

  startFor(item, first) {
    if (first && this.focus && item.path === this.focus.file && this.focus.time != null) return this.focus.time;
    const p = Number((this.d.settings().positions || {})[item.path] || 0);
    if (p > 5 && p < item.duration - 8) return p;
    return item.duration > 14 ? item.duration * 0.3 : 0;
  }

  async show(k, { first = false } = {}) {
    if (!this.reel.length || !this.layers.length) return;
    k = (k + this.reel.length) % this.reel.length;
    const token = ++this.showToken;
    clearTimeout(this.timer);
    const item = this.reel[k];
    const next = this.layers[first ? 0 : 1 - this.cur];
    const prev = first ? null : this.layers[this.cur];
    const at = this.startFor(item, first);
    if (first) { this.i = k; this.copy(item, true); this.segs(k); } // the words don't wait for the picture
    if (item.mode === 'direct') {
      next.img.hidden = true; next.video.hidden = false;
      if (next.video.dataset.path !== item.path) { next.video.src = item.url; next.video.dataset.path = item.path; }
      await seekTo(next.video, at, 1500);
      if (token !== this.showToken) return;
      if (this.awake && !this.paused) next.video.play().catch(() => {});
    } else {
      next.video.pause(); next.video.hidden = true; next.video.removeAttribute('src'); next.video.dataset.path = '';
      next.img.hidden = false; next.img.src = `${this.base}/frame?f=${item.b64}&t=${at.toFixed(1)}&w=1600`;
      await imgReady(next.img, 2500);
      if (token !== this.showToken) return;
    }
    next.el.style.zIndex = '2';
    next.el.classList.add('on');
    if (prev && prev !== next) {
      prev.el.style.zIndex = '1';
      prev.el.classList.remove('on');
      setTimeout(() => { if (!prev.el.classList.contains('on')) prev.video.pause(); }, 1400);
    }
    this.cur = this.layers.indexOf(next);
    this.i = k;
    if (!first) { this.copy(item, first); this.segs(k); }
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.awake && !this.paused && this.reel.length > 1) this.timer = setTimeout(() => this.show(this.i + 1), CLIP_MS);
  }
  segs(k) {
    const segs = $$('.rseg', this.root);
    for (const b of segs) b.classList.remove('on');
    void this.root.offsetWidth; // restart the active fill from zero
    segs.forEach((b, j) => { b.classList.toggle('done', j < k); b.classList.toggle('on', j === k); });
  }

  // title, line of specs and buttons for the clip on screen
  copy(item, first) {
    const kick = $('[data-kicker]', this.root), title = $('[data-title]', this.root), meta = $('[data-meta]', this.root), cta = $('[data-cta]', this.root);
    if (!title) return;
    if (!item) {
      revealWords(title, '<span class="m"><span class="w">Recent</span></span><em>.</em>');
      meta.textContent = 'Pick up where you left off';
      kick.textContent = ''; cta.innerHTML = '';
      return;
    }
    // machine-made file names read better without underscores, and never run off the hero
    let name = titleFor(item).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length > 28) { const cut = name.slice(0, 28).replace(/\s+\S*$/, ''); name = (cut.length >= 16 ? cut : name.slice(0, 28)).trim() + '…'; }
    const html = name.split(/\s+/).map((w) => `<span class="m"><span class="w">${esc(w)}</span></span>`).join(' ') + '<em>.</em>';
    if (title.dataset.name !== name) {
      title.dataset.name = name;
      const show = (opts) => { title.classList.toggle('long', name.length > 16); revealWords(title, html, opts); this.fitTitle(); };
      if (first) show({ delay: 120 });
      else hideWords(title).then(() => { if (title.dataset.name === name) show(); });
    }
    const when = item.src === 'downloads' || item.src === 'pc' ? ` ${ago(item.at)}` : '';
    kick.textContent = this.focus ? 'Project' : `${SOURCE[item.src] || 'Recent'}${when} · ${pad2(this.i + 1)} / ${pad2(this.reel.length)}`;
    meta.innerHTML = `<b>${esc(item.name)}</b> &nbsp;·&nbsp; ${specLine(item)}`;
    const pos = Number((this.d.settings().positions || {})[item.path] || 0);
    const resume = pos > 5 && pos < item.duration - 5;
    cta.innerHTML = resume
      ? `<button class="pp solid" data-act="home-play" data-hero="1" data-path="${esc(item.path)}">${icon('play')}<span>Resume ${fmt(pos)}</span></button>
         <button class="pp ghost" data-act="home-play" data-hero="1" data-from="0" data-path="${esc(item.path)}">From the start</button>`
      : `<button class="pp solid" data-act="home-play" data-hero="1" data-path="${esc(item.path)}">${icon('play')}<span>Play</span></button>`;
    if (!reduced()) for (const el of [kick, meta, cta]) el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: first ? 380 : 260, easing: EASE.out, fill: 'backwards' });
  }

  // shrink the title until it fits its column (a long single word can't wrap); hidden pages are fitted once shown
  fitTitle() {
    const title = $('[data-title]', this.root);
    if (!title) return;
    const room = title.parentElement.clientWidth;
    if (!room) return;
    title.style.fontSize = '';
    const w = title.scrollWidth;
    if (w > room) title.style.fontSize = `${Math.max(28, parseFloat(getComputedStyle(title).fontSize) * room / w)}px`;
  }
  watchTitle() {
    this.ro && this.ro.disconnect();
    const copy = $('.hero-copy', this.root);
    if (!copy) return;
    let lastW = -1;
    this.ro = new ResizeObserver(() => { const w = copy.clientWidth; if (w !== lastW) { lastW = w; this.fitTitle(); } });
    this.ro.observe(copy);
  }

  // ---------- leaving for a video and coming back to the same spot ----------
  snapshot(fromEl, path) {
    if ($('.hero.empty', this.root)) return null; // nothing to return to: going back reloads so the file just played shows up
    return {
      gen: this.renderGen, path,
      y: this.lenis ? this.lenis.scroll : (this.scroller ? this.scroller.scrollTop : 0),
      rows: $$('.row .cards', this.root).map((c) => c.scrollLeft),
      card: fromEl ? fromEl.closest('.hc, .pc') : null,
      hero: !!(fromEl && fromEl.closest('.reel')),
      cardRect: fromEl && fromEl.closest('.hc, .pc') ? (({ top, left }) => ({ top, left }))(fromEl.closest('.hc, .pc').getBoundingClientRect()) : null,
    };
  }
  valid(snap) { return !!(snap && snap.gen === this.renderGen && this.scroller && this.root.contains(this.scroller)); }
  // put the page back exactly where it was (call once the page is visible)
  restore(snap) {
    this.awake = true;
    if (this.lenis) { this.lenis.start(); this.lenis.resize(); this.lenis.scrollTo(snap.y, { immediate: true, force: true }); }
    if (Math.abs(this.scroller.scrollTop - snap.y) > 2) this.scroller.scrollTop = snap.y;
    $$('.row .cards', this.root).forEach((c, i) => { if (snap.rows[i] != null) c.scrollLeft = snap.rows[i]; });
    // the card he clicked goes back to the same place on screen, even if the page width changed meanwhile
    if (snap.card && snap.cardRect && this.root.contains(snap.card)) {
      const dy = snap.card.getBoundingClientRect().top - snap.cardRect.top;
      if (Math.abs(dy) > 2) {
        const y = this.scroller.scrollTop + dy;
        if (this.lenis) { this.lenis.resize(); this.lenis.scrollTo(y, { immediate: true, force: true }); }
        if (Math.abs(this.scroller.scrollTop - y) > 2) this.scroller.scrollTop = y;
      }
      const dx = snap.card.getBoundingClientRect().left - snap.cardRect.left;
      if (Math.abs(dx) > 2 && snap.card.parentElement) snap.card.parentElement.scrollLeft += dx;
    }
    if (this.onScroll) this.onScroll(this.scroller.scrollTop);
    this.resumeReel();
  }
  // back from the hero: the clip on screen jumps to the moment he stopped, and the buttons are redrawn
  async heroAt(path, t) {
    const item = this.current(), L = this.layers[this.cur];
    if (!item || !L || item.path !== path || !(t >= 0)) return;
    if (item.mode === 'direct') { if (L.video.src) { L.video.pause(); await seekTo(L.video, t, 600); } }
    else { L.img.src = `${this.base}/frame?f=${item.b64}&t=${t.toFixed(1)}&w=1600`; await imgReady(L.img, 1200); }
    this.copy(item, false);
  }
  // where the video should land on the way back: the card he clicked (or the hero), if it's still that video
  returnTarget(snap, path) {
    if (snap.hero) { const cur = this.current(); return cur && cur.path === path ? this.heroMedia() : null; }
    return snap.card && snap.card.dataset.path === path && this.root.contains(snap.card) ? snap.card.querySelector('.th') : null;
  }
  // a quick ring around the card he came back to, and its progress bar moved to where he stopped
  markReturn(snap, path, curDur) {
    const saved = this.d.settings().positions || {};
    for (const c of $$('.hc', this.root)) {
      const p = c.dataset.path;
      if (p !== path && p !== snap.path) continue;
      const info = this.info(p), d = p === path ? curDur : (info ? info.duration : 0), t = Number(saved[p] || 0);
      const th = c.querySelector('.th');
      let pr = th.querySelector('.pr');
      if (t > 5 && d && t < d - 5) {
        if (!pr) { pr = document.createElement('i'); pr.className = 'pr'; pr.innerHTML = '<i></i>'; th.appendChild(pr); }
        pr.firstElementChild.style.transform = `scaleX(${Math.min(1, t / d).toFixed(3)})`;
      } else if (pr) pr.remove();
    }
    if (snap.card && snap.card.dataset.path === path && this.root.contains(snap.card) && !reduced()) {
      snap.card.classList.remove('back-here'); void snap.card.offsetWidth; snap.card.classList.add('back-here');
      setTimeout(() => snap.card && snap.card.classList.remove('back-here'), 1800);
    }
  }

  current() { return this.reel[this.i] || null; }
  heroMedia() { return this.layers[this.cur] ? this.layers[this.cur].el : null; }

  // ---------- card previews: hover a card for a moment and it starts playing, muted ----------
  onOver(e) {
    const c = e.target.closest('.hc');
    if (!c || c === this.hoverCard) return;
    this.leaveCard();
    this.hoverCard = c;
    if (c.dataset.kind !== 'video' || c.dataset.mode === 'transcode' || reduced()) return;
    this.hoverTimer = setTimeout(() => this.previewCard(c), 420);
  }
  onOut(e) {
    const c = e.target.closest('.hc');
    if (c && !c.contains(e.relatedTarget)) this.leaveCard();
  }
  async previewCard(c) {
    const info = await this.probe(c.dataset.path);
    if (!info || info.mode !== 'direct' || this.hoverCard !== c) return;
    if (!this.hv) {
      this.hv = document.createElement('video');
      Object.assign(this.hv, { muted: true, loop: true, playsInline: true, preload: 'auto' });
      this.hv.className = 'hv';
      this.hv.addEventListener('playing', () => this.hv.classList.add('on'));
    }
    const v = this.hv;
    v.classList.remove('on');
    $('.th', c).appendChild(v);
    if (v.dataset.path !== info.path) { v.src = info.url; v.dataset.path = info.path; }
    seekTo(v, this.startFor(info, false), 1200).then(() => { if (this.hoverCard === c) v.play().catch(() => {}); });
  }
  leaveCard() {
    clearTimeout(this.hoverTimer);
    this.hoverCard = null;
    if (this.hv) { this.hv.classList.remove('on'); this.hv.pause(); }
  }
}
