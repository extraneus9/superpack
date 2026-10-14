// The file view: Details list + icon grids, virtualized, with selection, rubber band, rename and drag-drop.
import { el, escapeHtml, fmtSize, fmtDate, typeLabel, extOf, stripExt, VIDEO_EXT, isRoot, isFsPath } from './util.js';
import { folderSvg, driveSvg, icon, fileSvg, iconStyles } from './icons.js';
import { enter as motionEnter, flip as motionFlip, HoverPill, motionLevel } from './motion.js';

export const TILE = {
  medium: { w: 104, h: 116, icon: 60, thumb: 96 },
  large: { w: 136, h: 160, icon: 100, thumb: 160 },
  xl: { w: 220, h: 244, icon: 184, thumb: 256 },
};

const BASE_COLS = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'modified', label: 'Date modified' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size', num: true },
];

const enc = encodeURIComponent;

const CLOUD_OK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5a3 3 0 0 1-.4-6 4.2 4.2 0 0 1 8 .9 2.6 2.6 0 0 1-.6 5.1z"/><path d="m6.2 9.4 1.3 1.3 2.4-2.6"/></svg>';
const CLOUD_PART = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5a3 3 0 0 1-.4-6 4.2 4.2 0 0 1 8 .9 2.6 2.6 0 0 1-.6 5.1z"/><path d="M8 7.6v2.2M8 11.2v.1"/></svg>';
const CLOUD_OFF = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.6a4.2 4.2 0 0 1 6.1 2.8 2.6 2.6 0 0 1 1.3 4.2M11.2 12.5H4.5a3 3 0 0 1-.4-6"/><path d="m2.5 2.5 11 11"/></svg>';

// Google Drive state for one item: green = on Drive, amber = partly / different, gray = not uploaded.
function driveBadge(it, info, compact = false) {
  if (!info || it.drive) return '';
  if (info.loading) return compact ? '' : '<span class="drv drv-wait">…</span>';
  if (info.error) return compact ? '' : `<span class="drv drv-off" title="${escapeHtml(info.error)}">—</span>`;
  const s = it.driveState;
  if (!s) return info.loading && !compact ? '<span class="drv drv-wait">…</span>' : '';
  if (s.state === 'error') return compact ? '' : `<span class="drv drv-off" title="${escapeHtml(s.error)}">—</span>`;
  if (s.state === 'ok') return `<span class="drv drv-ok" title="On Google Drive${s.total != null ? ` · all ${s.total} file${s.total === 1 ? '' : 's'} inside checked` : ''}">${CLOUD_OK}${compact ? '' : '<span>On Drive</span>'}</span>`;
  if (s.state === 'partial') return `<span class="drv drv-part" title="${escapeHtml(`${s.missing} of ${s.total} files inside aren’t on Drive: ${(s.names || []).join(', ')}`)}">${CLOUD_PART}${compact ? '' : `<span>${s.missing} missing</span>`}</span>`;
  if (s.state === 'differs') return `<span class="drv drv-part" title="On Drive, but the size is different">${CLOUD_PART}${compact ? '' : '<span>Different</span>'}</span>`;
  return `<span class="drv drv-off" title="Not on Google Drive">${CLOUD_OFF}${compact ? '' : '<span>Not on Drive</span>'}</span>`;
}
const isRootPath = (p) => isRoot(p);
// Files Windows can render a real thumbnail for; everything else gets its shell icon.
const THUMB_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'psd', 'ai', 'eps', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2',
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'mpg', 'mpeg', 'flv', '3gp', 'pdf', 'blend', 'docx', 'pptx', 'xlsx', 'mp3', 'm4a', 'flac']);

export class FileView {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.inner = el('div', { class: 'scroller-inner' });
    root.append(this.inner);
    this.nodes = new Map();
    this.peekCache = new Map(); this.peekWanted = new Map(); this.peekTimer = null;
    this.layout = null;
    this.renaming = null;
    this.raf = 0;
    this.pendingCollapse = null;
    this.pill = new HoverPill(this.inner, '.row, .tile');

    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    // On resize, re-flow the items that already exist (renderVisible repositions them). Rebuilding them here
    // used to cancel running animations whenever a scrollbar or column appeared.
    new ResizeObserver(() => { if (this.layout && this.layout.mode !== 'home') { this.computeLayout(); this.renderVisible(); } }).observe(root);
    root.addEventListener('mousedown', (e) => this.onMouseDown(e));
    root.addEventListener('dblclick', (e) => this.onDblClick(e));
    // Resting the pointer on a folder (or pressing it) warms its thumbnails, so they are ready when it opens.
    let hoverTimer = null;
    const folderAt = (e) => { const n = e.target.closest && e.target.closest('.tile, .row'); const it = n && this.items[+n.dataset.i]; return it && it.d && !it.drive ? it : null; };
    root.addEventListener('mouseover', (e) => { clearTimeout(hoverTimer); const it = folderAt(e); if (it) hoverTimer = setTimeout(() => this.prefetch(it.p), 120); });
    root.addEventListener('mouseout', () => clearTimeout(hoverTimer));
    root.addEventListener('pointerdown', (e) => { const it = folderAt(e); if (it) this.prefetch(it.p); }, true);
    root.addEventListener('auxclick', (e) => this.onAuxClick(e));
    root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    root.addEventListener('dragstart', (e) => this.onDragStart(e));
    root.addEventListener('dragover', (e) => this.onDragOver(e));
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) this.setDropTarget(null); });
    root.addEventListener('drop', (e) => this.onDrop(e));
    root.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.app.zoomView(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  get tab() { return this.app.tab(); }
  get items() { return this.tab.view; }

  // ---------- layout ----------
  columns() {
    const t = this.tab;
    const cols = BASE_COLS.filter((c) => c.key !== 'status' || this.app.showStatusColumn(t));
    if (this.app.driveColumn(t)) cols.splice(cols.findIndex((c) => c.key === 'modified'), 0, { key: 'drive', label: 'Google Drive' });
    if (t.search || (t.loc || '').startsWith('board:') || t.loc === 'gallery') cols.splice(1, 0, { key: 'location', label: 'Folder' });
    if (t.loc === 'thispc') return [{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'total', label: 'Total size', num: true }, { key: 'free', label: 'Free space', num: true }];
    return cols;
  }

  computeLayout() {
    const v = this.app.viewSettings();
    const width = this.root.clientWidth;
    if (v.mode === 'details') {
      const rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 32;
      const cols = this.columns();
      const widths = this.app.columnWidths();
      const total = cols.reduce((s, c) => s + (widths[c.key] || 120), 0);
      this.layout = { mode: 'details', rowH, top: 32 + 4, cols, total, count: this.items.length };
      this.inner.style.height = (32 + 8 + this.items.length * rowH) + 'px';
      this.inner.style.width = '';
      this.groupLayout();
    } else {
      // Tile height follows the text size so names never get squeezed or clipped.
      const base = TILE[v.iconSize] || TILE.large;
      const fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 13;
      const lineH = Math.ceil(fs * 1.3);
      const drives = this.items.some((i) => i.drive);
      const need = base.icon + 14 + 4 + lineH * 2 + 6 + (drives ? 4 + 8 + Math.ceil(fs * 0.84 * 1.3) + 4 : 0);
      const size = { ...base, h: Math.max(base.h, need) };
      const perRow = Math.max(1, Math.floor((width - 16) / size.w));
      this.layout = { mode: 'icons', size, perRow, top: 8, left: 8, count: this.items.length };
      this.inner.style.height = (16 + Math.ceil(this.items.length / perRow) * size.h) + 'px';
      this.inner.style.width = '';
      this.groupLayout();
    }
  }

  // Grouped view (e.g. by date): a header row per group (Today, Yesterday, Last week…), items laid out under
  // it; a collapsed group keeps only its header. Positions go in L.tops/L.lefts (NaN = hidden).
  groupLayout() {
    const L = this.layout, t = this.tab;
    L.groups = null; L.tops = null; L.lefts = null;
    if (!t.groups || !t.groups.length) return;
    const HEAD = 36, n = this.items.length;
    const tops = new Float64Array(n).fill(NaN), lefts = new Float64Array(n).fill(NaN);
    const heads = [];
    let y = L.mode === 'details' ? L.top : L.top;
    for (const g of t.groups) {
      const collapsed = !!(t.collapsed && t.collapsed.has(g.label));
      heads.push({ label: g.label, count: g.count, top: y, collapsed });
      y += HEAD;
      if (collapsed) continue;
      for (let k = 0; k < g.count; k++) {
        const i = g.start + k;
        if (L.mode === 'details') { tops[i] = y + k * L.rowH; lefts[i] = 4; }
        else { tops[i] = y + Math.floor(k / L.perRow) * L.size.h; lefts[i] = L.left + (k % L.perRow) * L.size.w; }
      }
      y += L.mode === 'details' ? g.count * L.rowH : Math.ceil(g.count / L.perRow) * L.size.h;
      y += 6;
    }
    L.groups = heads; L.tops = tops; L.lefts = lefts;
    this.inner.style.height = (y + 16) + 'px';
  }

  renderHeads() {
    const L = this.layout;
    this.headNodes = this.headNodes || [];
    for (const h of this.headNodes) h.remove();
    this.headNodes = [];
    if (!L || !L.groups) return;
    const width = L.mode === 'details' ? L.total : this.root.clientWidth - 24;
    for (const g of L.groups) {
      const h = el('div', { class: 'group-head' + (g.collapsed ? ' collapsed' : ''), style: { top: g.top + 'px', width: width + 'px' }, title: g.collapsed ? 'Show this group' : 'Hide this group' },
        el('span', { class: 'gh-chev', html: icon('chevronDown', 12) }), el('span', { class: 'gh-label', text: g.label }), el('span', { class: 'gh-count', text: String(g.count) }), el('i', { class: 'gh-line' }));
      h.addEventListener('mousedown', (e) => e.stopPropagation());
      h.addEventListener('click', () => this.app.toggleGroup(g.label));
      this.inner.append(h);
      this.headNodes.push(h);
    }
  }

  applyColumnVars() {
    const widths = this.app.columnWidths();
    for (const [k, w] of Object.entries(widths)) this.root.style.setProperty(`--col-${k}`, w + 'px');
  }

  render({ keepScroll = true, enterDir = null, flip = false } = {}) {
    // FLIP: remember where things were, so changes (delete, paste, sort…) glide instead of jumping.
    const before = flip && motionLevel() > 0 && this.layout && this.layout.mode !== 'home'
      ? new Map([...this.nodes].map(([k, n]) => [k, { top: parseFloat(n.style.top) || 0, left: parseFloat(n.style.left) || 0 }]))
      : null;
    // Same folder, same view → update in place: items keep their element (so running animations and
    // loaded thumbnails survive), and an item is only rebuilt when what it shows actually changed.
    const t = this.tab;
    const key = `${t.id}|${t.loc}|${this.app.viewSettings().mode}|${this.app.viewSettings().iconSize}|${t.search ? t.search.sid : ''}|${t.groups ? 'g' : ''}`;
    const soft = !enterDir && keepScroll && this.renderKey === key && this.layout && this.layout.mode !== 'home';
    this.renderKey = key;
    if (soft) { this.softRender(before); return; }
    if (this.pill) this.pill.hide();
    // A background refresh (file watcher) must not kill a rename in progress.
    if (this.renaming && !this.tab.view.some((x) => x.p === this.renaming.path)) this.cancelRename(false);
    this.clearNodes();
    const keep = this.renaming && this.renaming.node;
    // Remove everything except the node being renamed (detaching a focused input would blur → commit).
    for (const c of [...this.inner.children]) if (c !== keep) c.remove();
    this.applyColumnVars();
    if (this.tab.loc === 'home') { this.renderHome(enterDir); return; }
    this.computeLayout();
    if (this.layout.mode === 'details') this.inner.append(this.buildHeader());
    this.root.scrollTop = keepScroll ? (this.tab.scroll || 0) : 0;
    if (!keepScroll) this.tab.scroll = 0;
    this.renderVisible();
    this.renderEmpty();
    if (enterDir) motionEnter([...this.nodes.values()].sort((a, b) => a.dataset.i - b.dataset.i), enterDir);
    else if (before) motionFlip(this.nodes, before);
  }

  // What a node shows, minus its Google Drive badge. The badge changes on its own (results stream in after the
  // folder opens) and is patched in place (dsig), so tiles and their thumbnails are never rebuilt for it.
  sig(it) {
    const stc = it.st && this.app.statusByKey(it.st);
    return [it.n, it.s, it.m, it.st || '', stc ? stc.color : '', it.col || '', this.app.settings().view.showExt ? 1 : 0,
      iconStyles.folder, iconStyles.files, this.app.themeFolder(), this.app.driveColumn(this.tab) ? 'D' : '', this.app.settings().view.folderPreviews ? 'P' : ''].join('|');
  }

  dsig(it) {
    const s = it.driveState;
    return (s ? `${s.state}${s.missing || ''}/${s.total || ''}` : '') + (this.tab.driveInfo && this.tab.driveInfo.loading ? 'L' : '');
  }

  patchDrive(n, it) {
    n.dataset.dsig = this.dsig(it);
    if (this.layout.mode === 'details') {
      const cell = n.querySelector('.cell.drive, [data-col="drive"]');
      if (cell) cell.innerHTML = driveBadge(it, this.tab.driveInfo);
      return;
    }
    const ic = n.querySelector('.tile-icon');
    if (!ic) return;
    ic.querySelector('.tile-drive')?.remove();
    if (this.app.driveColumn(this.tab) && !it.drive) {
      const b = driveBadge(it, this.tab.driveInfo, true);
      if (b) ic.append(el('span', { class: 'tile-drive', html: b }));
    }
  }

  softRender(before) {
    if (this.renaming && !this.tab.view.some((x) => x.p === this.renaming.path)) this.cancelRename(false);
    this.applyColumnVars();
    const prevCols = this.layout.cols ? this.layout.cols.map((c) => c.key).join(',') : '';
    this.computeLayout();
    const colsChanged = this.layout.mode === 'details' && this.layout.cols.map((c) => c.key).join(',') !== prevCols;
    const oldHead = this.inner.querySelector('.list-header');
    if (this.layout.mode === 'details') { const h = this.buildHeader(); if (oldHead) oldHead.replaceWith(h); else this.inner.prepend(h); }
    else if (oldHead) oldHead.remove();
    const present = new Map(this.items.map((i) => [i.p, i]));
    for (const [k, n] of this.nodes) {
      const renamingThis = this.renaming && this.renaming.path === k;
      const it = present.get(k);
      if (!it) { if (!renamingThis) { n.remove(); this.nodes.delete(k); } continue; }
      if (renamingThis) continue;
      const sig = this.sig(it);
      if (!colsChanged && n.dataset.sig === sig) { if (n.dataset.dsig !== this.dsig(it)) this.patchDrive(n, it); continue; }
      const fresh = this.layout.mode === 'details' ? this.buildRow(it) : this.buildTile(it);
      n.replaceChildren(...fresh.childNodes);
      n.draggable = fresh.draggable;
      n.dataset.sig = sig;
      n.dataset.dsig = this.dsig(it);
    }
    this.renderVisible();
    this.renderEmpty();
    if (before) motionFlip(this.nodes, before);
  }

  // Home: Quick access tiles + Recent files (small, so no virtualization).
  renderHome(enterDirHome = null) {
    for (const h of this.headNodes || []) h.remove();
    this.headNodes = []; this.headKey = null;
    const items = this.items;
    this.layout = { mode: 'home', count: items.length };
    this.inner.style.height = '';
    const wrap = el('div', { class: 'home' });
    const grid = el('div', { class: 'home-grid' });
    const rows = el('div', { class: 'home-rows' });
    items.forEach((it, i) => {
      const n = it.group === 'pin' ? this.buildHomeTile(it) : this.buildHomeRow(it);
      n.dataset.i = i;
      this.nodes.set(it.p, n);
      this.decorate(n, it);
      (it.group === 'pin' ? grid : rows).append(n);
    });
    wrap.append(el('h4', { text: 'Quick access' }), grid);
    const recent = items.filter((i) => i.group === 'recent').length;
    if (recent) wrap.append(el('h4', { text: 'Recent' }), el('div', { class: 'rows-head' }, el('span', { text: 'Name' }), el('span', { text: 'Date modified', style: { width: '170px' } }), el('span', { text: 'File location', style: { width: '340px' } })), rows);
    this.inner.append(wrap);
    this.root.scrollTop = this.tab.scroll || 0;
    this.renderEmpty();
    if (enterDirHome) motionEnter([...wrap.querySelectorAll('.tile, .row')], enterDirHome);
  }

  buildHomeTile(it) {
    const tile = el('div', { class: 'tile', draggable: 'true' });
    const ic = el('div', { class: 'tile-icon', style: { width: '64px', height: '64px' } });
    if (isRootPath(it.p)) ic.innerHTML = driveSvg(undefined, 64);
    else if (it.special) ic.append(el('img', { class: 'ficon', alt: '', draggable: 'false', style: { width: '56px', height: '56px' }, src: `ficon://f/?p=${enc(it.p)}&s=jumbo&d=1` }));
    else ic.innerHTML = folderSvg(this.folderColor(it) || this.app.themeFolder(), { size: 64 });
    tile.append(ic, el('div', { class: 'tile-name', text: it.label || it.n, title: it.p }));
    return tile;
  }

  buildHomeRow(it) {
    const row = el('div', { class: 'row', draggable: 'true' });
    row.innerHTML = `<div class="cell name"><span class="ic">${iconStyles.files === 'minimal' ? fileSvg(extOf(it.n), 20) : `<img src="ficon://f/?p=${enc(it.p)}&s=normal" alt="" draggable="false">`}</span><span class="nm">${escapeHtml(this.displayName(it))}</span></div>`
      + `<div class="cell" style="width:170px">${escapeHtml(fmtDate(it.m))}</div>`
      + `<div class="cell" style="width:340px" title="${escapeHtml(it.p)}">${escapeHtml(it.p.slice(0, it.p.length - it.n.length).replace(/[\\/]$/, ''))}</div>`;
    return row;
  }

  renderEmpty() {
    const old = this.root.querySelector('.empty-state');
    if (old) old.remove();
    const t = this.tab;
    if (t.loading && !this.items.length) {
      this.root.append(el('div', { class: 'empty-state' }, el('div', { class: 'spinner' })));
    } else if (t.error) {
      this.root.append(el('div', { class: 'empty-state' }, el('b', { text: 'Can’t open this location' }), el('span', { text: t.error })));
    } else if (!this.items.length) {
      const msg = t.search ? (t.search.running ? 'Searching…' : 'No items match your search.')
        : t.filter ? 'No items match your filter.'
          : (t.loc || '').startsWith('board:') ? 'No folders with this status yet.' : 'This folder is empty.';
      this.root.append(el('div', { class: 'empty-state' }, el('span', { text: msg })));
    }
  }

  buildHeader() {
    const t = this.tab;
    const sort = this.app.viewSettings().sort;
    const head = el('div', { class: 'list-header' });
    head.style.paddingLeft = '4px';
    for (const c of this.layout.cols) {
      const sorted = sort.key === c.key;
      const h = el('div', { class: 'col-h' + (c.num ? ' num' : '') + (sorted ? ' sorted' : ''), style: { width: `var(--col-${c.key}, 120px)` }, dataset: { key: c.key } },
        el('span', { text: c.label }),
        sorted ? el('span', { class: 'sort-arrow', style: { transform: sort.dir > 0 ? 'rotate(180deg)' : 'none' }, html: icon('chevronDown', 12) }) : null,
        el('span', { class: 'col-resize', dataset: { resize: c.key } }));
      h.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        if (e.target.dataset.resize) return this.startColResize(e, c.key, h);
        this.app.setSort(c.key);
      });
      h.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.app.backgroundMenu(e.clientX, e.clientY); });
      head.append(h);
    }
    if (t.loc === 'thispc') head.querySelectorAll('.col-resize').forEach((r) => r.remove());
    return head;
  }

  startColResize(e, key, headCell) {
    const startX = e.clientX;
    const widths = this.app.columnWidths();
    const startW = widths[key] || 120;
    const move = (ev) => {
      const w = Math.max(60, startW + ev.clientX - startX);
      this.root.style.setProperty(`--col-${key}`, w + 'px');
      widths[key] = w;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this.app.saveColumnWidths(widths);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.tab.scroll = this.root.scrollTop;
      this.renderVisible();
    });
  }

  range() {
    const L = this.layout;
    if (L.mode === 'home') return [0, -1];
    const st = this.root.scrollTop, h = this.root.clientHeight;
    if (L.tops) {
      const lo = st - 400, hi = st + h + 400, n = L.count;
      let first = 0, last = n - 1;
      while (first < n && !(L.tops[first] >= lo)) first++; // NaN (collapsed) and above-the-fold are skipped
      while (last >= 0 && !(L.tops[last] <= hi)) last--;
      return first <= last ? [first, last] : [0, -1];
    }
    if (L.mode === 'details') {
      const first = Math.max(0, Math.floor((st - L.top) / L.rowH) - 8);
      const last = Math.min(L.count - 1, Math.ceil((st + h - L.top) / L.rowH) + 8);
      return [first, last];
    }
    const r0 = Math.max(0, Math.floor((st - L.top) / L.size.h) - 2);
    const r1 = Math.ceil((st + h - L.top) / L.size.h) + 2;
    return [r0 * L.perRow, Math.min(L.count - 1, (r1 + 1) * L.perRow - 1)];
  }

  clearNodes() {
    for (const h of this.headNodes || []) h.remove();
    this.headNodes = []; this.headKey = null;
    for (const [k, n] of this.nodes) { if (this.renaming && this.renaming.path === k) continue; n.remove(); }
    this.nodes = this.renaming && this.nodes.has(this.renaming.path) ? new Map([[this.renaming.path, this.nodes.get(this.renaming.path)]]) : new Map();
  }

  renderVisible() {
    if (!this.layout || this.layout.mode === 'home') return;
    const items = this.items;
    const [a, b] = this.range();
    const want = new Set();
    const L0 = this.layout;
    for (let i = a; i <= b; i++) if (items[i] && !(L0.tops && Number.isNaN(L0.tops[i]))) want.add(items[i].p);
    if (this.headKey !== (L0.groups ? L0.groups.map((g) => g.label + g.top + g.collapsed).join('|') + L0.total + this.root.clientWidth : '')) {
      this.headKey = L0.groups ? L0.groups.map((g) => g.label + g.top + g.collapsed).join('|') + L0.total + this.root.clientWidth : '';
      this.renderHeads();
    }
    for (const [k, n] of this.nodes) {
      if (!want.has(k) && !(this.renaming && this.renaming.path === k)) { n.remove(); this.nodes.delete(k); }
    }
    for (let i = a; i <= b; i++) {
      const it = items[i];
      if (!it || !want.has(it.p)) continue;
      let n = this.nodes.get(it.p);
      if (!n) {
        n = this.layout.mode === 'details' ? this.buildRow(it) : this.buildTile(it);
        n.dataset.sig = this.sig(it); n.dataset.dsig = this.dsig(it); n.dataset.dsig = this.dsig(it);
        this.nodes.set(it.p, n);
        this.inner.append(n);
      }
      this.position(n, i);
      this.decorate(n, it);
    }
  }

  position(n, i) {
    const L = this.layout;
    n.dataset.i = i;
    if (L.tops) {
      n.style.top = L.tops[i] + 'px';
      n.style.left = L.lefts[i] + 'px';
      n.style.width = (L.mode === 'details' ? L.total : L.size.w - 4) + 'px';
      n.style.height = '';
      n.style.minHeight = L.mode === 'details' ? '' : (L.size.h - 4) + 'px';
      return;
    }
    if (L.mode === 'details') {
      n.style.top = (L.top + i * L.rowH) + 'px';
      n.style.left = '4px';
      n.style.width = L.total + 'px';
      n.style.minHeight = '';
    } else {
      const r = Math.floor(i / L.perRow), c = i % L.perRow;
      n.style.top = (L.top + r * L.size.h) + 'px';
      n.style.left = (L.left + c * L.size.w) + 'px';
      n.style.width = (L.size.w - 4) + 'px';
      // min-height, not height: the focused tile grows to show its whole name (like Explorer)
      n.style.height = '';
      n.style.minHeight = (L.size.h - 4) + 'px';
    }
  }

  decorate(n, it) {
    const t = this.tab;
    n.classList.toggle('sel', t.sel.has(it.p));
    n.classList.toggle('focus', t.focus === it.p && document.activeElement === this.root);
    n.classList.toggle('cut', this.app.isCut(it.p));
    n.classList.toggle('hidden-item', !!it.h);
  }

  updateSelection() {
    for (const [k, n] of this.nodes) {
      const it = this.app.itemByPath(k);
      if (it) this.decorate(n, it);
    }
  }

  async prefetch(dir) {
    if (!this.prefetched) this.prefetched = new Map();
    const at = this.prefetched.get(dir);
    if (at && Date.now() - at < 60000) return;
    this.prefetched.set(dir, Date.now());
    if (this.prefetched.size > 300) this.prefetched.delete(this.prefetched.keys().next().value);
    const vs = this.app.viewSettings(dir);
    if (vs.mode !== 'icons') return;
    const sz = TILE[vs.iconSize] || TILE.large;
    let r;
    try { r = await window.api.list(dir); } catch { return; }
    const media = (r.items || []).filter((i) => !i.d && THUMB_EXT.has(extOf(i.n))).slice(0, 60);
    this.warm = media.map((i) => { const im = new Image(); im.decoding = 'async'; im.src = `thumb://t/?p=${enc(i.p)}&s=${sz.thumb}&m=${i.m}`; return im; });
  }

  // After a rename: re-key the existing node and update its label without rebuilding it.
  renameInPlace(from, it) {
    const n = this.nodes.get(from);
    if (!n) return;
    this.nodes.delete(from);
    this.nodes.set(it.p, n);
    const label = n.querySelector('.tile-name, .nm');
    if (label) { label.textContent = this.displayName(it); if (label.classList.contains('tile-name')) label.title = it.n; }
    n.dataset.sig = this.sig(it);
  }

  displayName(it) {
    if (it.drive) return it.label;
    if (it.d || this.app.settings().view.showExt) return it.n;
    return stripExt(it.n);
  }

  // Folder previews (Settings → Files & view). Cached per path+mtime; asked for in one batch per frame, and
  // tiles already on screen get their icon swapped in place when the answer arrives.
  peekFor(it) {
    if (!this.app.settings().view.folderPreviews || !isFsPath(it.p)) return null;
    const c = this.peekCache.get(it.p);
    if (c && c.m === it.m) return c.urls;
    if (!this.peekWanted.has(it.p)) { this.peekWanted.set(it.p, it.m); if (!this.peekTimer) this.peekTimer = setTimeout(() => this.flushPeek(), 30); }
    return null;
  }

  async flushPeek() {
    this.peekTimer = null;
    const want = new Map(this.peekWanted);
    this.peekWanted.clear();
    let res = {};
    try { res = await window.api.peek([...want.keys()]); } catch { return; }
    const thumbPx = Math.min(256, (this.layout.size && this.layout.size.thumb) || 128);
    for (const [p, m] of want) {
      if (!res[p]) continue; // not answered (batch cap) — ask again next time it's on screen
      const files = res[p];
      const urls = files.map((f) => `thumb://t/?p=${enc(f)}&s=${thumbPx}`);
      if (this.peekCache.size > 4000) this.peekCache.delete(this.peekCache.keys().next().value); // bounded (oldest out)
      this.peekCache.set(p, { m, urls });
      if (!urls.length || this.layout.mode === 'details' || this.layout.mode === 'home') continue;
      const n = this.nodes.get(p), it = this.app.itemByPath(p);
      const ic = n && n.querySelector('.tile-icon');
      if (!ic || !it || !it.d) continue;
      const svg = folderSvg(this.folderColor(it) || this.app.themeFolder(), { size: this.layout.size.icon, peek: urls });
      ic.querySelector('svg')?.remove();
      ic.insertAdjacentHTML('afterbegin', svg);
    }
  }

  folderColor(it) {
    const s = it.st && this.app.statusByKey(it.st);
    return (s && s.color) || it.col || null;
  }

  smallIcon(it) {
    if (it.drive || it.portable) return driveSvg(undefined, 20);
    if (it.virt && !it.d) return fileSvg(extOf(it.n), 20);
    if (it.d) return folderSvg(this.folderColor(it) || this.app.themeFolder(), { size: 20 });
    if (iconStyles.files === 'minimal') return fileSvg(extOf(it.n), 20);
    return `<img src="ficon://f/?p=${enc(it.p)}&s=normal" alt="" loading="lazy" draggable="false">`;
  }

  buildRow(it) {
    const cols = this.layout.cols;
    const row = el('div', { class: 'row', draggable: it.drive ? 'false' : 'true' });
    for (const c of cols) {
      const cell = el('div', { class: 'cell' + (c.key === 'name' ? ' name' : '') + (c.num ? ' num' : ''), style: { width: `var(--col-${c.key}, 120px)` }, 'data-col': c.key });
      switch (c.key) {
        case 'name':
          cell.innerHTML = `<span class="ic">${this.smallIcon(it)}</span><span class="nm">${escapeHtml(this.displayName(it))}</span>${it.o ? `<span class="cloud-badge" title="Online-only">${icon('cloud', 14)}</span>` : ''}`;
          break;
        case 'status': {
          const s = it.st && this.app.statusByKey(it.st);
          if (s) cell.innerHTML = `<span class="pill"><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`;
          else if (it.col) cell.innerHTML = `<span class="pill"><i style="background:${it.col}"></i>Color</span>`;
          break;
        }
        case 'drive': cell.innerHTML = driveBadge(it, this.tab.driveInfo); break;
        case 'location': cell.textContent = it.p.slice(0, it.p.length - it.n.length).replace(/[\\/]$/, ''); cell.title = cell.textContent; break;
        case 'modified': cell.textContent = it.drive ? '' : fmtDate(it.m); break;
        case 'type': cell.textContent = typeLabel(it); break;
        case 'size': cell.textContent = it.d ? '' : fmtSize(it.s); break;
        case 'total': cell.textContent = it.total ? fmtSize(it.total) : ''; break;
        case 'free': cell.textContent = it.free != null ? fmtSize(it.free) : ''; break;
      }
      row.append(cell);
    }
    return row;
  }

  buildTile(it) {
    const size = this.layout.size;
    const tile = el('div', { class: 'tile', draggable: it.drive ? 'false' : 'true' });
    const ic = el('div', { class: 'tile-icon', style: { width: size.icon + 'px', height: size.icon + 'px' } });
    if (it.drive || it.portable) ic.innerHTML = driveSvg(undefined, size.icon);
    else if (it.virt) ic.innerHTML = it.d ? folderSvg(this.app.themeFolder(), { size: size.icon }) : fileSvg(extOf(it.n), Math.round(size.icon * 0.82));
    else if (it.d) ic.innerHTML = folderSvg(this.folderColor(it) || this.app.themeFolder(), { size: size.icon, peek: this.peekFor(it) });
    else if (!THUMB_EXT.has(extOf(it.n)) && iconStyles.files === 'minimal') {
      ic.innerHTML = fileSvg(extOf(it.n), Math.round(size.icon * 0.82));
    } else if (!THUMB_EXT.has(extOf(it.n))) {
      const px = Math.round(size.icon * 0.82);
      ic.append(el('img', { class: 'ficon', alt: '', draggable: 'false', style: { width: px + 'px', height: px + 'px' }, src: `ficon://f/?p=${enc(it.p)}&s=${size.icon > 64 ? 'jumbo' : 'large'}` }));
    } else {
      const img = el('img', { class: 'thumb', alt: '', draggable: 'false', loading: 'lazy', decoding: 'async' });
      img.src = `thumb://t/?p=${enc(it.p)}&s=${size.thumb}&m=${it.m}`;
      // Cached thumbnails (revisits) appear at once; only slow ones fade in.
      const t0 = performance.now();
      img.addEventListener('load', () => { if (performance.now() - t0 < 80) img.classList.add('instant'); img.classList.add('loaded'); }, { once: true });
      img.onerror = () => {
        img.onerror = null;
        if (iconStyles.files === 'minimal') { img.replaceWith(document.createRange().createContextualFragment(fileSvg(extOf(it.n), Math.round(size.icon * 0.82)))); return; }
        img.className = 'ficon';
        img.src = `ficon://f/?p=${enc(it.p)}&s=jumbo`;
      };
      ic.append(img);
      if (VIDEO_EXT.has(extOf(it.n)) || ['mkv', 'avi', 'wmv', 'mts', 'm2ts'].includes(extOf(it.n))) {
        if (size.icon >= 96) ic.append(el('span', { class: 'vid-badge', html: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg>' }));
      }
    }
    if (this.app.driveColumn(this.tab) && !it.drive) {
      const b = driveBadge(it, this.tab.driveInfo, true);
      if (b) ic.append(el('span', { class: 'tile-drive', html: b }));
    }
    tile.append(ic, el('div', { class: 'tile-name', text: this.displayName(it), title: it.n }));
    if (it.drive && it.total) {
      const used = 1 - it.free / it.total;
      tile.append(el('div', { class: 'drive-bar' + (used > 0.9 ? ' full' : ''), style: { width: '80%', marginTop: '2px' } }, el('i', { style: { width: Math.round(used * 100) + '%' } })),
        el('div', { class: 'tile-sub', text: `${fmtSize(it.free)} free of ${fmtSize(it.total)}` }));
    }
    return tile;
  }

  // ---------- geometry ----------
  indexFromEvent(e) {
    const n = e.target.closest('.row, .tile');
    if (!n || !this.inner.contains(n)) return -1;
    return parseInt(n.dataset.i, 10);
  }

  ensureVisible(i) {
    const L = this.layout;
    if (!L || i < 0) return;
    if (L.mode === 'home') { const it = this.items[i]; const n = it && this.nodes.get(it.p); if (n) n.scrollIntoView({ block: 'nearest' }); return; }
    let top, h;
    if (L.tops) {
      if (Number.isNaN(L.tops[i])) { const g = this.tab.groups.find((x) => i >= x.start && i < x.start + x.count); if (g) { this.tab.collapsed.delete(g.label); this.render({ keepScroll: true }); } return this.ensureVisible(i); }
      top = L.tops[i] - (L.mode === 'details' ? 32 : 0); h = L.mode === 'details' ? L.rowH : L.size.h;
    } else if (L.mode === 'details') { top = L.top + i * L.rowH; h = L.rowH; top -= 32; }
    else { top = L.top + Math.floor(i / L.perRow) * L.size.h; h = L.size.h; }
    const st = this.root.scrollTop, vh = this.root.clientHeight - (L.mode === 'details' ? 32 : 0);
    if (top < st) this.root.scrollTop = top;
    else if (top + h > st + vh) this.root.scrollTop = top + h - vh;
    this.renderVisible();
  }

  pageSize() {
    const L = this.layout;
    if (!L) return 10;
    return L.mode === 'details' ? Math.max(1, Math.floor((this.root.clientHeight - 32) / L.rowH) - 1) : Math.max(1, Math.floor(this.root.clientHeight / L.size.h)) * L.perRow;
  }

  step(dir) {
    // returns index delta for an arrow key
    const L = this.layout;
    if (!L) return 0;
    if (L.mode === 'details') return { up: -1, down: 1, left: 0, right: 0 }[dir];
    if (L.mode === 'home') return { up: -1, down: 1, left: -1, right: 1 }[dir];
    return { up: -L.perRow, down: L.perRow, left: -1, right: 1 }[dir];
  }

  // ---------- mouse ----------
  onMouseDown(e) {
    this.root.focus({ preventScroll: true });
    if (e.button !== 0) return;
    if (e.target.closest('.list-header') || e.target.classList.contains('rename-input')) return;
    if (e.offsetX > this.root.clientWidth && e.target === this.root) return; // scrollbar
    const i = this.indexFromEvent(e);
    const t = this.tab;
    if (i >= 0) {
      if (e.detail >= 2) return;
      const it = this.items[i];
      if (e.ctrlKey && !e.shiftKey) {
        if (t.sel.has(it.p)) t.sel.delete(it.p); else t.sel.add(it.p);
        t.anchor = it.p; t.focus = it.p;
      } else if (e.shiftKey) {
        this.app.selectRange(t.anchor || it.p, it.p, e.ctrlKey);
        t.focus = it.p;
      } else if (!t.sel.has(it.p)) {
        t.sel = new Set([it.p]);
        t.anchor = it.p; t.focus = it.p;
      } else {
        this.pendingCollapse = it.p;
        t.focus = it.p;
        const up = () => {
          document.removeEventListener('mouseup', up);
          if (this.pendingCollapse === it.p) { t.sel = new Set([it.p]); t.anchor = it.p; this.app.selectionChanged(); }
          this.pendingCollapse = null;
        };
        document.addEventListener('mouseup', up);
      }
      this.app.selectionChanged();
      if (!it.drive && !it.portable) this.armDrag(e, it);
      return;
    }
    this.startRubberBand(e);
  }

  // Dragging items. Inside the window the drag is ours (pointer events): a drop on a folder, a tab or a
  // navigation entry moves/copies there. Electron's native drag can't drop back onto its own window — that is
  // why dragging a file onto a folder did nothing. The native drag starts only when the pointer leaves the
  // window, so files still drag out into Resolve, CapCut, Explorer…
  armDrag(down, it) {
    const x0 = down.clientX, y0 = down.clientY;
    let ghost = null, paths = null, hot = null, hotDir = null;
    const clearHot = () => { if (hot && !this.inner.contains(hot)) hot.classList.remove('drop'); this.setDropTarget(null); hot = null; hotDir = null; };
    const end = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('mouseout', leave, true);
      clearHot();
      if (ghost) ghost.remove();
      document.body.classList.remove('item-dragging');
    };
    const targetAt = (x, y) => {
      const elx = document.elementFromPoint(x, y);
      if (!elx) return null;
      if (this.root.contains(elx)) { const t = this.dropTargetFor({ target: elx }); return t ? { dir: t.dir, node: t.node } : null; }
      const tab = elx.closest('#tabs .tab');
      if (tab) { const tt = this.app.state.tabs[[...tab.parentNode.children].indexOf(tab)]; return tt && isFsPath(tt.loc) ? { dir: tt.loc, node: tab } : null; }
      const side = elx.closest('#sidebar [data-drop]');
      if (side && side.dataset.drop) return { dir: side.dataset.drop, node: side };
      return null;
    };
    const move = (e) => {
      if (!paths) {
        if (!(e.buttons & 1)) { end(); return; }
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
        const t = this.tab;
        this.pendingCollapse = null;
        paths = t.sel.has(it.p) ? [...t.sel] : [it.p];
        this.app.state.dragging = paths;
        document.body.classList.add('item-dragging');
        // Preview under the cursor: the item's own thumbnail/icon (cloned from its tile or row) + a count badge.
        const src = this.nodes.get(it.p);
        const pic = src && (src.querySelector('.tile-icon img.thumb') || src.querySelector('.tile-icon svg, .tile-icon img, .ic img, .ic svg'));
        ghost = el('div', { class: 'drag-ghost' + (paths.length > 1 ? ' multi' : '') },
          el('div', { class: 'dg-pic' }, pic ? pic.cloneNode(true) : ''),
          el('div', { class: 'dg-name', text: paths.length > 1 ? `${paths.length} items` : it.n }));
        document.body.append(ghost);
      }
      // Left the window: hand over to Windows' drag (button still held) for dropping into other apps.
      // (Chromium stops sending moves once the pointer is outside, so the 3 px window edge counts as leaving.)
      if (e.clientX < 3 || e.clientY < 3 || e.clientX >= window.innerWidth - 3 || e.clientY >= window.innerHeight - 3) { handOff(); return; }
      ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
      const tg = targetAt(e.clientX, e.clientY);
      const dragging = paths.map((p) => p.toLowerCase());
      const here = (this.tab.loc || '').toLowerCase().replace(/[\\/]$/, '');
      const ok = !!tg && !dragging.includes(tg.dir.toLowerCase()) && (!!tg.node || tg.dir.toLowerCase().replace(/[\\/]$/, '') !== here); // empty space of this same folder = nowhere
      const node = ok ? tg.node : null;
      if (node !== hot) {
        clearHot();
        hot = node; hotDir = ok ? tg.dir : null;
        if (hot && this.inner.contains(hot)) this.setDropTarget(hot); else if (hot) hot.classList.add('drop');
      } else hotDir = ok ? tg.dir : null;
      ghost.dataset.op = hotDir ? (e.ctrlKey ? 'copy' : e.shiftKey ? 'move' : '') : '';
    };
    const up = (e) => {
      if (!paths) { end(); return; }
      const dir = hotDir, node = hot;
      end();
      if (!dir) { this.app.state.dragging = null; return; }
      e.preventDefault();
      this.app.handleDrop({ ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, clientX: e.clientX, clientY: e.clientY, dataTransfer: { files: [] } }, dir, node && this.inner.contains(node) ? node : null);
    };
    const handOff = () => { if (!paths) return; const p = paths; end(); this.app.beginDrag(p); };
    const leave = (e) => { if (paths && !e.relatedTarget) handOff(); };
    document.addEventListener('mouseout', leave, true);
    const key = (e) => { if (e.key === 'Escape' && paths) { e.stopPropagation(); end(); this.app.state.dragging = null; } };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('keydown', key, true);
  }

  onDblClick(e) {
    const i = this.indexFromEvent(e);
    if (i < 0 || e.button !== 0) return;
    if (e.target.classList.contains('rename-input')) return;
    this.app.openItems([this.items[i]]);
  }

  onAuxClick(e) {
    if (e.button !== 1) return;
    const i = this.indexFromEvent(e);
    if (i < 0) return;
    const it = this.items[i];
    if (it.d) { e.preventDefault(); this.app.newTab(it.p, { background: true }); }
  }

  onContextMenu(e) {
    e.preventDefault();
    if (e.target.closest('.list-header')) return;
    const i = this.indexFromEvent(e);
    const t = this.tab;
    if (i >= 0) {
      const it = this.items[i];
      if (!t.sel.has(it.p)) { t.sel = new Set([it.p]); t.anchor = it.p; }
      t.focus = it.p;
      this.app.selectionChanged();
      this.app.itemMenu(e.clientX, e.clientY, e.shiftKey);
    } else {
      if (!e.ctrlKey) { t.sel = new Set(); this.app.selectionChanged(); }
      this.app.backgroundMenu(e.clientX, e.clientY);
    }
  }

  startRubberBand(e) {
    if (this.pill) this.pill.hide();
    const t = this.tab;
    const rect = this.root.getBoundingClientRect();
    const toContent = (cx, cy) => ({ x: cx - rect.left + this.root.scrollLeft, y: cy - rect.top + this.root.scrollTop });
    const start = toContent(e.clientX, e.clientY);
    const base = e.ctrlKey ? new Set(t.sel) : new Set();
    if (!e.ctrlKey && !e.shiftKey && t.sel.size) { t.sel = new Set(); this.app.selectionChanged(); }
    let band = null, last = { cx: e.clientX, cy: e.clientY }, scrollTimer = 0;
    const update = () => {
      const cur = toContent(last.cx, last.cy);
      const x0 = Math.min(start.x, cur.x), x1 = Math.max(start.x, cur.x);
      const y0 = Math.min(start.y, cur.y), y1 = Math.max(start.y, cur.y);
      if (!band) {
        if (Math.abs(cur.x - start.x) < 4 && Math.abs(cur.y - start.y) < 4) return;
        band = el('div', { class: 'rubber' });
        this.inner.append(band);
      }
      Object.assign(band.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
      const hits = this.hitTest(x0, y0, x1, y1);
      const sel = new Set(base);
      for (const i of hits) { const p = this.items[i].p; if (base.has(p)) sel.delete(p); else sel.add(p); }
      t.sel = sel;
      this.updateSelection();
      this.app.selectionChanged({ light: true });
    };
    const autoScroll = () => {
      const r = this.root.getBoundingClientRect();
      let dy = 0;
      if (last.cy < r.top + 30) dy = -Math.min(40, (r.top + 30 - last.cy) / 2 + 4);
      else if (last.cy > r.bottom - 20) dy = Math.min(40, (last.cy - r.bottom + 20) / 2 + 4);
      if (dy) { this.root.scrollTop += dy; update(); }
      scrollTimer = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => { last = { cx: ev.clientX, cy: ev.clientY }; update(); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      cancelAnimationFrame(scrollTimer);
      if (band) band.remove();
      this.app.selectionChanged();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    scrollTimer = requestAnimationFrame(autoScroll);
  }

  hitTest(x0, y0, x1, y1) {
    const L = this.layout;
    const out = [];
    if (L.mode === 'home') return out;
    if (L.tops) {
      const w = L.mode === 'details' ? L.total : L.size.w - 4, h = L.mode === 'details' ? L.rowH : L.size.h - 4;
      for (let i = 0; i < L.count; i++) {
        const t = L.tops[i], l = L.lefts[i];
        if (Number.isNaN(t)) continue;
        if (l < x1 && l + w > x0 && t < y1 && t + h > y0) out.push(i);
      }
      return out;
    }
    if (L.mode === 'details') {
      if (x1 < 4 || x0 > 4 + L.total) return out;
      const a = Math.max(0, Math.floor((y0 - L.top) / L.rowH));
      const b = Math.min(L.count - 1, Math.floor((y1 - L.top) / L.rowH));
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    }
    const c0 = Math.max(0, Math.floor((x0 - L.left) / L.size.w));
    const c1 = Math.min(L.perRow - 1, Math.floor((x1 - L.left) / L.size.w));
    const r0 = Math.max(0, Math.floor((y0 - L.top) / L.size.h));
    const r1 = Math.floor((y1 - L.top) / L.size.h);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * L.perRow + c;
      if (i < L.count) out.push(i);
    }
    return out;
  }

  // ---------- drag and drop ----------
  onDragStart(e) {
    const i = this.indexFromEvent(e);
    e.preventDefault();
    if (i < 0) return;
    const it = this.items[i];
    if (it.drive) return;
    // Item drags are handled by armDrag (pointer events); the browser's own drag is always suppressed.
  }

  dropTargetFor(e) {
    const i = this.indexFromEvent(e);
    const it = i >= 0 ? this.items[i] : null;
    const dragging = this.app.state.dragging || [];
    if (it && (it.d || it.drive) && !dragging.some((p) => p.toLowerCase() === it.p.toLowerCase())) return { dir: it.p, node: this.nodes.get(it.p) };
    const loc = this.tab.loc;
    if (this.tab.search || !(isFsPath(loc) || loc.startsWith('::'))) return null;
    return { dir: loc, node: null };
  }

  setDropTarget(node) {
    if (this.dropNode && this.dropNode !== node) this.dropNode.classList.remove('drop');
    this.dropNode = node;
    if (node) node.classList.add('drop');
  }

  onDragOver(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    const target = this.dropTargetFor(e);
    if (!target) { e.dataTransfer.dropEffect = 'none'; this.setDropTarget(null); return; }
    e.preventDefault();
    this.setDropTarget(target.node);
    e.dataTransfer.dropEffect = this.app.dropEffectFor(e, target.dir);
  }

  onDrop(e) {
    const target = this.dropTargetFor(e);
    this.setDropTarget(null);
    if (!target) return;
    e.preventDefault();
    this.app.handleDrop(e, target.dir, target.node);
  }

  // ---------- rename ----------
  startRename(path) {
    const idx = this.items.findIndex((x) => x.p === path);
    if (idx < 0) return;
    this.ensureVisible(idx);
    const node = this.nodes.get(path);
    if (!node) return;
    const it = this.items[idx];
    const isTile = node.classList.contains('tile');
    const target = isTile ? node.querySelector('.tile-name') : node.querySelector('.nm');
    const input = el(isTile ? 'textarea' : 'input', { class: 'rename-input', spellcheck: 'false', rows: isTile ? '2' : null });
    input.value = it.n;
    target.replaceWith(input);
    this.renaming = { path, input, target, node };
    node.draggable = false;
    input.focus();
    const dot = it.d ? -1 : it.n.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : it.n.length);
    const done = (commit) => {
      if (!this.renaming || this.renaming.input !== input) return;
      const value = input.value.replace(/[\r\n]/g, '');
      this.renaming = null;
      if (input.isConnected) input.replaceWith(target);
      node.draggable = true;
      this.root.focus({ preventScroll: true });
      if (commit && value && value !== it.n) this.app.commitRename(it, value);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('blur', () => done(true));
    this._doneRename = done;
  }

  cancelRename(commit) {
    if (this.renaming && this._doneRename) this._doneRename(commit);
  }
}
