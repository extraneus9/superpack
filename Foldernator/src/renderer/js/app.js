// Foldernator — UI controller: tabs, navigation, commands, keyboard, status colors.
import {
  $, el, debounce, collator, typeLabel, isRoot, isFsPath, normDir, baseName, parentOf, fmtSize, extOf,
  IS_MAC, SEP, trimSep, diskOf,
} from './util.js';
import { icon, folderSvg, folderImages, homeIcon, galleryIcon, setIconStyles, iconStyles } from './icons.js';
import { Layout } from './layout.js';
import { isViewable } from './viewer.js';
import { openTheater } from './theater.js';
import { initGlass, initLiveGlass, setLiveGlass, liveGlassOn, freezeGlass, unfreezeGlass, glassFrozen } from './glass.js';
import { setMotionLevel, motionLevel, exit as motionExit, flyInto, ripple, bounce } from './motion.js';
import { applyTheme, resolveTheme, PRESETS } from './themes.js';
import { FileView } from './view.js';
import { Sidebar } from './sidebar.js';
import { Preview } from './preview.js';
import { showMenu, showMenuAt, closeMenus, menuOpen } from './menu.js';
import { toast, confirmDialog } from './dialogs.js';
import { openSettings } from './settings-ui.js';
import { openMediaDetails, isMediaFile } from './media-details.js';

const api = window.api;
if (IS_MAC) document.documentElement.classList.add('mac'); // Mac layout: traffic lights top-left
const state = { settings: null, palette: [], paths: {}, drives: [], tabs: [], active: 0, clip: null, dragging: null, undo: [], iconsReady: new Set() };
let view, sidebar, preview, layout;
let tabSeq = 0;
const VIEW_STEPS = [['details', null], ['icons', 'medium'], ['icons', 'large'], ['icons', 'xl']];

const app = {
  api, state,
  tab: () => state.tabs[state.active],
  settings: () => state.settings,
  toast,
};
window.__app = app; // QA hook

// ---------- tabs ----------
function makeTab(loc) {
  return { id: ++tabSeq, loc, history: [loc], hi: 0, items: [], view: [], index: new Map(), sel: new Set(), anchor: null, focus: null, scroll: 0, loading: false, error: null, filter: '', search: null, loaded: false };
}

const isVirt = (loc) => typeof loc === 'string' && loc.startsWith('::'); // portable device (MTP) locations
state.names = new Map();   // virtual path -> display name
state.parents = new Map(); // virtual path -> parent location

function titleFor(loc) {
  if (loc === 'thispc') return IS_MAC ? 'Computer' : 'This PC';
  if (isVirt(loc)) return state.names.get(loc) || 'Device';
  if (loc === 'home') return 'Home';
  if (loc === 'gallery') return 'Gallery';
  if (loc.startsWith('board:')) {
    const s = app.statusByKey(loc.slice(6));
    return s ? s.label : 'Status';
  }
  if (isRoot(loc)) {
    const d = state.drives.find((x) => x.path.toLowerCase() === loc.toLowerCase());
    return d ? `${d.label || 'Local Disk'} (${loc.slice(0, 2)})` : loc.slice(0, 2);
  }
  return baseName(loc);
}

function tabIconHtml(loc) {
  if (loc === 'thispc') return icon('pc', 16);
  if (loc === 'home') return homeIcon(16);
  if (loc === 'gallery') return galleryIcon(16);
  if (loc.startsWith('board:')) {
    const s = app.statusByKey(loc.slice(6));
    return `<i class="status-swatch" style="background:${s ? s.color : '#888'}"></i>`;
  }
  const st = app.knownStatus(loc);
  if (st && st.color) return folderSvg(st.color, { size: 16 });
  // Drives and the Windows user folders (Downloads, Documents, Desktop…) get their own icon, so each tab says where it is.
  const p = state.paths || {};
  const special = [p.desktop, p.downloads, p.documents, p.pictures, p.videos, p.music].some((x) => x && x.toLowerCase() === loc.toLowerCase());
  if ((isRoot(loc) || special) && sidebar) return sidebar.shellIcon(loc);
  return folderSvg(app.themeFolder(), { size: 16 });
}

function renderTabs() {
  const host = $('#tabs');
  host.replaceChildren(...state.tabs.map((t, i) => {
    const node = el('div', { class: 'tab' + (i === state.active ? ' active' : ''), role: 'tab', title: t.loc === 'thispc' ? 'This PC' : t.loc },
      el('span', { class: 'tab-icon', html: tabIconHtml(t.loc) }),
      el('span', { class: 'tab-title', text: titleFor(t.loc) }),
      el('button', { class: 'tab-close', title: 'Close tab (Ctrl+W)', html: icon('close', 12), onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); closeTab(i); } }));
    node.addEventListener('mousedown', (e) => { if (e.button === 0) { if (i !== state.active) switchTab(i); startTabDrag(e, i); } });
    node.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(i); });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([
        { label: 'New tab', icon: 'plus', key: 'Ctrl+T', action: () => newTab('home', { end: true }) },
        { label: 'Duplicate tab', icon: 'copy', action: () => newTab(t.loc) },
        '-',
        { label: 'Close tab', icon: 'close', key: 'Ctrl+W', action: () => closeTab(i) },
        { label: 'Close other tabs', disabled: state.tabs.length < 2, action: () => { state.tabs = [t]; state.active = 0; switchTab(0); } },
        { label: 'Close tabs to the right', disabled: i === state.tabs.length - 1, action: () => { state.tabs = state.tabs.slice(0, i + 1); switchTab(Math.min(state.active, i)); } },
      ], e.clientX, e.clientY);
    });
    let hoverTimer = null;
    node.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      if (!isFsPath(t.loc)) return;
      e.preventDefault();
      node.classList.add('drag-over');
      e.dataTransfer.dropEffect = app.dropEffectFor(e, t.loc);
      if (!hoverTimer && i !== state.active) hoverTimer = setTimeout(() => switchTab(i), 600);
    });
    node.addEventListener('dragleave', () => { node.classList.remove('drag-over'); clearTimeout(hoverTimer); hoverTimer = null; });
    node.addEventListener('drop', (e) => { node.classList.remove('drag-over'); clearTimeout(hoverTimer); e.preventDefault(); app.handleDrop(e, t.loc); });
    return node;
  }));
  document.title = titleFor(app.tab().loc) + ' — Foldernator';
  // Past the minimum width the strip scrolls (wheel); keep the active tab in view.
  fitTabTitles();
  const act = host.children[state.active];
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Drag a tab sideways to reorder it (Chrome-style): it follows the pointer and swaps with a neighbour
// once it passes the neighbour's middle. Pointer-based, so tabs stay drop targets for files.
function startTabDrag(e, index) {
  const host = $('#tabs');
  const x0 = e.clientX;
  let idx = index, dragging = false, grab = 0;
  const node = () => host.children[idx];
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - x0) < 5) return;
      dragging = true;
      grab = x0 - node().getBoundingClientRect().left;
      document.body.classList.add('tab-dragging');
    }
    // swap while the pointer is past a neighbour's middle
    for (;;) {
      const prev = host.children[idx - 1], next = host.children[idx + 1];
      if (next && ev.clientX > next.getBoundingClientRect().left + next.offsetWidth / 2) swap(idx, idx + 1);
      else if (prev && ev.clientX < prev.getBoundingClientRect().left + prev.offsetWidth / 2) swap(idx, idx - 1);
      else break;
    }
    const n = node();
    n.style.transform = '';
    const left = n.getBoundingClientRect().left, hb = host.getBoundingClientRect();
    const target = Math.max(hb.left, Math.min(hb.right - n.offsetWidth, ev.clientX - grab));
    n.classList.add('dragging');
    n.style.transform = `translateX(${target - left}px)`;
  };
  const swap = (a, b) => {
    const t = state.tabs.splice(a, 1)[0];
    state.tabs.splice(b, 0, t);
    if (state.active === a) state.active = b; else if (state.active === b) state.active = a;
    idx = b;
    renderTabs();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!dragging) return;
    document.body.classList.remove('tab-dragging');
    const n = node();
    if (n) {
      n.classList.remove('dragging');
      if (motionLevel() > 0 && n.style.transform) n.animate([{ transform: n.style.transform }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(0.16,1,0.3,1)' });
      n.style.transform = '';
    }
    saveSession();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// end: the + button / Ctrl+T add at the far right (like Chrome); opening a folder in a new tab puts it next to the current one.
// Shrink each tab label only as much as it needs (100% → 72%), so names stay whole when many tabs are open.
function fitTabTitles() {
  requestAnimationFrame(() => {
    for (const t of document.querySelectorAll("#tabs .tab-title")) {
      t.style.fontSize = "";
      for (const f of [0.92, 0.85, 0.78, 0.72]) { if (t.scrollWidth <= t.clientWidth + 1) break; t.style.fontSize = f + "em"; }
    }
  });
}
window.addEventListener("resize", () => fitTabTitles());

function newTab(loc = 'home', { background = false, end = false } = {}) {
  const t = makeTab(loc);
  // A folder opened from here inherits this tab's history (like Chrome), so Back leads to where you were.
  const cur = app.tab();
  if (!end && cur && loc !== 'home' && cur.loc.toLowerCase() !== String(loc).toLowerCase()) { t.history = cur.history.slice(0, cur.hi + 1).concat(loc); t.hi = t.history.length - 1; }
  const at = end ? state.tabs.length : state.active + 1;
  state.tabs.splice(at, 0, t);
  if (!background) switchTab(at);
  else { renderTabs(); load(t); saveSession(); }
  return t;
}
app.newTab = (loc, opts) => newTab(loc, opts);

function closeTab(i) {
  if (state.tabs.length === 1) { window.close(); return; }
  const t = state.tabs[i];
  if (t.search && t.search.running) api.searchCancel(t.search.sid);
  if (t.scan && t.scan.running) api.searchCancel(t.scan.sid);
  clearTimeout(t.scanTimer); clearTimeout(t.searchTimer);
  state.tabs.splice(i, 1);
  let next = state.active;
  if (i < state.active || state.active >= state.tabs.length) next = Math.max(0, state.active - 1);
  switchTab(Math.min(next, state.tabs.length - 1));
}

function switchTab(i) {
  state.active = Math.max(0, Math.min(i, state.tabs.length - 1));
  const t = app.tab();
  $('#search-input').value = t.filter || (t.search ? t.search.query : '');
  renderChrome();
  if ((!t.loaded || t.stale) && !t.loading) { t.stale = false; load(t, { keep: t.loaded }); }
  else view.render({ keepScroll: true });
  updateWatch();
  saveSession();
}

// ---------- navigation ----------
async function navigate(loc, { push = true, select = null, newTabFlag = false } = {}) {
  if (!loc) return;
  if (isFsPath(loc)) loc = normDir(loc);
  if (newTabFlag) return newTab(loc);
  const t = app.tab();
  if (t.search) cancelSearch(t, false);
  if (push && t.loc.toLowerCase() !== loc.toLowerCase()) {
    t.history = t.history.slice(0, t.hi + 1);
    t.history.push(loc);
    t.hi = t.history.length - 1;
  }
  // Previews still being scanned for the old folder stop, so the disk serves this folder first.
  api.peekReset(); view.peekWanted.clear();
  const from = t.loc;
  t.pendingEnter = !push ? 'back' : (isFsPath(loc) && isFsPath(from) && parentOf(from).toLowerCase() === loc.toLowerCase()) ? 'back' : 'forward';
  t.loc = loc;
  t.sel = new Set();
  t.focus = null; t.anchor = null; t.scroll = 0; t.filter = '';
  t.items = []; t.view = []; t.index = new Map();
  $('#search-input').value = '';
  $('#search').classList.remove('has-value');
  // Going up: select the folder we came from (like Explorer).
  if (!select && isFsPath(from) && parentOf(from).toLowerCase() === loc.toLowerCase()) select = from;
  renderChrome();
  await load(t, { select });
  updateWatch();
  saveSession();
}
app.navigate = (loc, opts) => navigate(loc, opts);

function back() { const t = app.tab(); if (t.hi > 0) { t.hi--; navigate(t.history[t.hi], { push: false }); } }
function forward() { const t = app.tab(); if (t.hi < t.history.length - 1) { t.hi++; navigate(t.history[t.hi], { push: false }); } }
function up() { const t = app.tab(); if (isVirt(t.loc)) return navigate(state.parents.get(t.loc) || 'thispc'); if (!isFsPath(t.loc)) return; const p = parentOf(t.loc); if (p !== t.loc) navigate(p); }
function refresh() { const t = app.tab(); if (t.search) return startSearch(t.search.query); t.forceDrive = true; load(t, { keep: true }); refreshDrives(); }
app.back = back; app.forward = forward;

async function load(t, { select = null, keep = false } = {}) {
  const loc = t.loc;
  // Only the newest load of a tab may land: an older one (A -> B -> A quickly, or a refresh racing a
  // watcher reload) would otherwise overwrite fresher items with its stale listing.
  const seq = t.loadSeq = (t.loadSeq || 0) + 1;
  t.loading = true;
  t.error = null;
  // Leaving the gallery stops its scan, so late batches can't spill into the folder shown next.
  if (loc !== 'gallery' && t.scan) { if (t.scan.running) api.searchCancel(t.scan.sid); clearTimeout(t.scanTimer); t.scanTimer = 0; t.scan = null; }
  const spinnerTimer = setTimeout(() => { if (t.loading && t === app.tab()) view.renderEmpty(); }, 160);
  let items = [];
  try {
    if (isVirt(loc)) {
      const list = await api.shellList(loc);
      items = list.map((x) => { state.names.set(x.p, x.n); state.parents.set(x.p, loc); return { n: x.n, p: x.p, d: x.d, s: x.s, m: x.m, virt: true, typeLabel: x.d ? 'File folder' : x.t }; });
    } else if (loc === 'thispc') {
      state.drives = await api.drives();
      state.portable = await api.portable().catch(() => []);
      items = state.drives.filter((d) => d.ready).map((d) => ({
        n: d.path, p: d.path, d: true, drive: true, type: d.type, m: 0, s: 0,
        label: `${d.label || (d.type === 'Removable' ? 'USB Drive' : 'Local Disk')} (${d.path.slice(0, 2)})`,
        total: d.total, free: d.free, format: d.format, typeLabel: d.type === 'Removable' ? 'Removable Disk' : d.type === 'Network' ? 'Network Drive' : 'Local Disk',
      }));
      for (const d of state.portable || []) { state.names.set(d.path, d.name); state.parents.set(d.path, 'thispc'); }
      items = items.concat((state.portable || []).map((d) => ({ n: d.name, p: d.path, d: true, portable: true, virt: true, label: d.name, m: 0, s: 0, typeLabel: d.type || 'Portable Device' })));
    } else if (loc === 'home') {
      items = await homeItems();
    } else if (loc === 'gallery') {
      if (t.scan && t.scan.running) api.searchCancel(t.scan.sid);
      const sid = 'g' + Date.now();
      t.scan = { sid, running: true };
      t.items = [];
      api.galleryStart({ sid, roots: state.settings.galleryRoots || [] });
      items = [];
    } else if (loc.startsWith('board:')) {
      items = await api.statusBoard(loc.slice(6));
    } else {
      const r = await api.list(loc);
      items = r.items;
    }
  } catch (e) {
    t.error = cleanError(e.message);
  }
  clearTimeout(spinnerTimer);
  if (t.loc !== loc || t.loadSeq !== seq) return; // navigated away (or reloaded) meanwhile
  t.items = items;
  t.loading = false;
  t.loaded = true;
  computeView(t);
  const known = new Set(t.view.map((i) => i.p));
  t.sel = new Set([...t.sel].filter((p) => known.has(p)));
  if (select && known.has(select)) { t.sel = new Set([select]); t.focus = select; t.anchor = select; }
  else if (select) {
    const match = t.view.find((i) => i.p.toLowerCase() === select.toLowerCase());
    if (match) { t.sel = new Set([match.p]); t.focus = match.p; t.anchor = match.p; }
  }
  if (t.focus && !known.has(t.focus)) t.focus = null;
  if (t === app.tab()) {
    const enterDir = t.pendingEnter && !keep ? t.pendingEnter : null;
    t.pendingEnter = null;
    view.render({ keepScroll: keep, enterDir, flip: keep && !enterDir });
    if (t.focus) view.ensureVisible(t.index.get(t.focus));
    renderStatusbar();
    renderCommandBar();
    showPreview();
    renderTabs();
  }
  // Opening a folder: the Drive comparison (which reads the whole tree) starts a moment later, and only if you
  // are still here, so the disk serves this folder's listing and thumbnails first.
  if (isFsPath(loc) && !t.error) {
    if (keep) checkDrive(t, { force: t.forceDrive });
    else { t.driveInfo = null; setTimeout(() => { if (t.loc === loc && t.loadSeq === seq) checkDrive(t); }, 400); }
  }
  t.forceDrive = false;
  if (isFsPath(loc) && !t.error) {
    const statuses = items.filter((i) => i.d && (i.st || i.col)).map((i) => ({ path: i.p, status: i.st || null, color: i.col || null }));
    api.statusSeen({ dir: loc, statuses }).then((changed) => {
      if (!changed) return;
      const idx = { ...state.settings.statusIndex };
      const parentKey = trimSep(loc).toLowerCase();
      for (const k of Object.keys(idx)) if (trimSep(parentOf(idx[k].path)).toLowerCase() === parentKey) delete idx[k];
      for (const s of statuses) idx[s.path.toLowerCase()] = { path: s.path, status: s.status, color: s.color, t: Date.now() };
      state.settings.statusIndex = idx;
      sidebar.render();
    });
  }
}

// ---------- Google Drive badges ----------
// For a folder that maps to Drive: each file is on Drive (same size) or not; each subfolder is fully
// uploaded, partly (n files missing, checked one level deep) or not on Drive.
async function checkDrive(t, { force = false } = {}) {
  // Full comparison runs in the main process; results stream in through onDriveItem / onDriveDone.
  const loc = t.loc, seq = t.loadSeq;
  if (!isFsPath(loc) || !state.settings.drive.enabled) { t.driveInfo = null; return; }
  for (const it of t.items) delete it.driveState;
  t.driveInfo = { loading: true, done: 0, total: 0 };
  const r = await api.driveDeep(loc, force);
  if (t.loc !== loc || t.loadSeq !== seq) return;
  if (!r.mapped) { t.driveInfo = null; }
  else if (r.cached) {
    for (const it of t.items) if (r.items[it.n]) it.driveState = r.items[it.n];
    t.driveInfo = r.summary;
  }
  if (t === app.tab()) { view.render({ keepScroll: true }); renderStatusbar(); }
}

let driveRenderTimer = 0;
function driveRenderSoon() {
  if (driveRenderTimer) return;
  driveRenderTimer = setTimeout(() => {
    driveRenderTimer = 0;
    view.render({ keepScroll: true });
    renderStatusbar();
    if (preview) { preview.current = null; showPreview(); }
  }, 200);
}
function onDriveItem({ dir, name, info }) {
  for (const t of state.tabs) {
    if (t.loc.toLowerCase() !== dir.toLowerCase()) continue;
    const it = t.items.find((x) => x.n === name);
    if (it) it.driveState = info;
    if (t === app.tab()) driveRenderSoon();
  }
}
function onDriveProgress({ dir, done, total, remote, exists }) {
  for (const t of state.tabs) {
    if (t.loc.toLowerCase() !== dir.toLowerCase() || !t.driveInfo || !t.driveInfo.loading) continue;
    Object.assign(t.driveInfo, { done, total, remote, exists });
    if (t === app.tab()) renderStatusbar();
  }
}
function onDriveDone({ dir, summary, error }) {
  for (const t of state.tabs) {
    if (t.loc.toLowerCase() !== dir.toLowerCase()) continue;
    t.driveInfo = error ? { error } : summary;
    if (t === app.tab()) driveRenderSoon();
  }
}

app.driveColumn = (t) => !!(t.driveInfo && !t.search && isFsPath(t.loc));

async function homeItems() {
  const p = state.paths;
  const special = new Set([p.desktop, p.downloads, p.documents, p.pictures, p.videos, p.music].filter(Boolean).map((x) => x.toLowerCase()));
  const pins = (state.settings.pinned || []).map((x) => {
    const st = app.knownStatus(x);
    return { n: baseName(x), p: x, d: true, group: 'pin', label: sidebar.pinLabel(x), special: special.has(x.toLowerCase()), st: st && st.status, col: st && st.color, m: 0 };
  });
  let recent = [];
  try {
    const qa = await api.quickAccess();
    const files = qa.filter((x) => !x.pinned && x.path && isFsPath(x.path)).slice(0, 40);
    recent = (await Promise.all(files.map(async (x) => {
      try { const st = await api.stat(x.path); return st.isDir ? null : { n: baseName(x.path), p: x.path, d: false, s: st.size, m: st.mtime, group: 'recent' }; } catch { return null; }
    }))).filter(Boolean);
  } catch {}
  return [...pins, ...recent];
}

function cleanError(msg) {
  const m = String(msg || '');
  if (/UnauthorizedAccess|denied/i.test(m)) return 'Access is denied.';
  if (/DirectoryNotFound|not find|not found/i.test(m)) return 'This folder doesn’t exist (anymore).';
  if (/IOException.*not ready/i.test(m)) return 'The device is not ready.';
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^\w+Exception: /, '');
}

// ---------- view model ----------
app.viewSettings = (loc = app.tab().loc) => {
  const base = state.settings.view;
  const fv = state.settings.folderViews[loc.toLowerCase()] || {};
  const def = loc === 'thispc' ? { mode: 'icons', iconSize: 'large' } : loc === 'gallery' ? { mode: 'icons', iconSize: 'large', sort: { key: 'modified', dir: -1 } } : {};
  // Downloads groups by date out of the box (like Windows Explorer); every folder can switch it (View → Group by).
  const isDownloads = state.paths && state.paths.downloads && loc.toLowerCase() === state.paths.downloads.toLowerCase();
  const group = fv.group !== undefined ? fv.group : isDownloads ? 'date' : 'none';
  const sort = fv.sort || def.sort || (isDownloads ? { key: 'modified', dir: -1 } : base.sort);
  return { mode: fv.mode || def.mode || base.mode, iconSize: fv.iconSize || def.iconSize || base.iconSize, sort, group };
};

// Date groups, newest first — the same buckets Windows Explorer uses.
const DATE_GROUPS = ['Today', 'Yesterday', 'Earlier this week', 'Last week', 'Earlier this month', 'Last month', 'Earlier this year', 'A long time ago'];
function dateBucket(ms, now = new Date()) {
  if (!ms) return 7;
  const d = new Date(ms);
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (ms >= day0) return 0;
  if (ms >= day0 - DAY) return 1;
  const weekStart = day0 - now.getDay() * DAY; // weeks start on Sunday, like Explorer (en-US)
  if (ms >= weekStart) return 2;
  if (ms >= weekStart - 7 * DAY) return 3;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 4;
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()) return 5;
  if (d.getFullYear() === now.getFullYear()) return 6;
  return 7;
}

function setGroupBy(group) {
  const loc = app.tab().loc;
  const fv = { ...(state.settings.folderViews[loc.toLowerCase()] || {}), group };
  state.settings.folderViews = { ...state.settings.folderViews, [loc.toLowerCase()]: fv };
  api.patchSettings({ folderViews: { [loc.toLowerCase()]: fv } });
  for (const t of state.tabs) if (t.loc.toLowerCase() === loc.toLowerCase()) computeView(t);
  view.render({ keepScroll: false, enterDir: 'none' });
}
app.setGroupBy = setGroupBy;
app.toggleGroup = (label) => {
  const t = app.tab();
  t.collapsed = t.collapsed || new Set();
  if (t.collapsed.has(label)) t.collapsed.delete(label); else t.collapsed.add(label);
  view.render({ keepScroll: true });
};

function computeView(t) {
  const v = app.viewSettings(t.loc);
  const showHidden = state.settings.view.showHidden;
  let list = t.search ? t.search.items : t.items;
  if (t.loc === 'home') {
    t.view = t.filter ? list.filter((it) => (it.label || it.n).toLowerCase().includes(t.filter.toLowerCase())) : list;
    t.index = new Map(t.view.map((it, i) => [it.p, i]));
    return;
  }
  list = list.filter((it) => !(it.h && it.sys) && (showHidden || !it.h));
  if (t.filter) {
    const q = t.filter.toLowerCase();
    list = list.filter((it) => (it.label || it.n).toLowerCase().includes(q));
  }
  const { key, dir } = v.sort;
  const ff = state.settings.view.foldersFirst;
  const order = Object.fromEntries(state.settings.statuses.map((s, i) => [s.key, i]));
  const types = new Map();
  const tl = (it) => { let x = types.get(it); if (x === undefined) { x = typeLabel(it); types.set(it, x); } return x; };
  list = [...list].sort((a, b) => {
    if (ff && a.d !== b.d) return a.d ? -1 : 1;
    let r = 0;
    switch (key) {
      case 'modified': r = (a.m || 0) - (b.m || 0); break;
      case 'size': r = (a.s || 0) - (b.s || 0); break;
      case 'type': r = collator.compare(tl(a), tl(b)); break;
      case 'status': r = (a.st in order ? order[a.st] : a.col ? 50 : 99) - (b.st in order ? order[b.st] : b.col ? 50 : 99); break;
      case 'location': r = collator.compare(a.p, b.p); break;
      case 'total': r = (a.total || 0) - (b.total || 0); break;
      case 'free': r = (a.free || 0) - (b.free || 0); break;
      default: r = 0;
    }
    if (r === 0) r = collator.compare(a.n, b.n);
    return r * dir;
  });
  // Grouped by date: stable re-order into buckets (newest bucket first), keeping the chosen sort inside each.
  t.groups = null;
  if (v.group === 'date' && t.loc !== 'thispc' && t.loc !== 'gallery') {
    const now = new Date();
    const b = list.map((it, i) => [dateBucket(it.m, now), i]);
    b.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const ordered = b.map(([, i]) => list[i]);
    t.groups = [];
    b.forEach(([g], k) => { const last = t.groups[t.groups.length - 1]; if (!last || last.g !== g) t.groups.push({ g, label: DATE_GROUPS[g], start: k, count: 1 }); else last.count++; });
    list = ordered;
  }
  t.view = list;
  t.index = new Map(list.map((it, i) => [it.p, i]));
}

app.itemByPath = (p) => { const t = app.tab(); const i = t.index.get(p); return i == null ? null : t.view[i]; };
app.selectedItems = () => { const t = app.tab(); return t.view.filter((it) => t.sel.has(it.p)); };
app.isCut = (p) => !!(state.clip && state.clip.cut && state.clip.set.has(p.toLowerCase()));
app.statusByKey = (k) => state.settings.statuses.find((s) => s.key === k) || null;
app.knownStatus = (p) => {
  const e = (state.settings.statusIndex || {})[p.toLowerCase()];
  if (!e) return null;
  const s = e.status && app.statusByKey(e.status);
  return { status: e.status, color: (s && s.color) || e.color };
};
const lower = (p) => trimSep(p).toLowerCase();
app.scopes = () => (state.settings.statusScopes || []).map(lower);
// "*" in a status folder path matches any one folder (…\1-SOCIALS\* = vol3, vol4, vol7 later…).
const scopeMatch = (scope, loc) => {
  const a = scope.split(SEP), b = lower(loc).split(SEP);
  return a.length === b.length && a.every((seg, i) => seg === '*' || seg === b[i]);
};
app.isStatusScope = (loc) => isFsPath(loc) && app.scopes().some((s) => scopeMatch(s, loc));
app.scopeEntryFor = (loc) => (state.settings.statusScopes || []).find((s) => scopeMatch(lower(s), loc)) || null;
// A folder takes a status when it sits directly inside a status folder (one subfolder = one video).
app.isStatusTarget = (p) => isFsPath(p) && !isRoot(p) && app.isStatusScope(parentOf(p));
app.showStatusColumn = (t) => app.isStatusScope(t.loc) || t.loc.startsWith('board:') || (!!t.search && app.isStatusScope(t.search.root));
app.statusCounts = () => {
  const c = {};
  for (const e of Object.values(state.settings.statusIndex || {})) if (e.status && app.isStatusTarget(e.path)) c[e.status] = (c[e.status] || 0) + 1;
  return c;
};
app.themeFolder = () => resolveTheme(state.settings).folder;
app.columnWidths = () => ({ location: 280, total: 120, free: 120, drive: 140, ...state.settings.view.columns });
app.saveColumnWidths = (w) => { state.settings.view.columns = { ...state.settings.view.columns, ...w }; api.patchSettings({ view: { columns: state.settings.view.columns } }); };

app.selectRange = (from, to, additive) => {
  const t = app.tab();
  let a = t.index.get(from), b = t.index.get(to);
  if (a == null) a = b;
  if (a > b) [a, b] = [b, a];
  const set = additive ? new Set(t.sel) : new Set();
  for (let i = a; i <= b; i++) set.add(t.view[i].p);
  t.sel = set;
};

const previewSoon = debounce(() => showPreview(), 110);
app.selectionChanged = ({ light = false } = {}) => {
  view.updateSelection();
  renderStatusbar();
  if (!light) { renderCommandBar(); previewSoon(); }
};

function showPreview() { preview.show(app.selectedItems().slice(0, 50)); }

function setViewMode(mode, iconSize) {
  const loc = app.tab().loc;
  const fv = { ...(state.settings.folderViews[loc.toLowerCase()] || {}), mode, ...(iconSize ? { iconSize } : {}) };
  state.settings.folderViews = { ...state.settings.folderViews, [loc.toLowerCase()]: fv };
  state.settings.view = { ...state.settings.view, mode, ...(iconSize ? { iconSize } : {}) };
  api.patchSettings({ folderViews: { [loc.toLowerCase()]: fv }, view: { mode, ...(iconSize ? { iconSize } : {}) } });
  view.render({ keepScroll: false, enterDir: 'none' });
  const t = app.tab();
  if (t.focus) view.ensureVisible(t.index.get(t.focus));
  renderCommandBar();
  renderStatusbar();
}
app.zoomView = (delta) => {
  const v = app.viewSettings();
  let i = VIEW_STEPS.findIndex(([m, s]) => m === v.mode && (m === 'details' || s === v.iconSize));
  if (i < 0) i = 0;
  const n = Math.max(0, Math.min(VIEW_STEPS.length - 1, i + delta));
  if (n !== i) setViewMode(VIEW_STEPS[n][0], VIEW_STEPS[n][1]);
};

app.setSort = (key) => {
  const loc = app.tab().loc;
  const cur = app.viewSettings().sort;
  const dir = cur.key === key ? -cur.dir : (key === 'modified' || key === 'size' ? -1 : 1);
  const fv = { ...(state.settings.folderViews[loc.toLowerCase()] || {}), sort: { key, dir } };
  state.settings.folderViews = { ...state.settings.folderViews, [loc.toLowerCase()]: fv };
  api.patchSettings({ folderViews: { [loc.toLowerCase()]: fv } });
  for (const t of state.tabs) if (t.loc.toLowerCase() === loc.toLowerCase()) computeView(t);
  view.render({ keepScroll: true, flip: true });
  renderCommandBar();
};

app.setViewFlag = (key, value) => {
  state.settings.view = { ...state.settings.view, [key]: value };
  api.patchSettings({ view: { [key]: value } });
  if (key === 'previewPane') { document.body.classList.toggle('preview-on', value); preview.current = null; showPreview(); }
  for (const t of state.tabs) computeView(t);
  view.render({ keepScroll: true });
  renderCommandBar();
  renderStatusbar();
};

// ---------- open ----------
async function openItems(items, { inNewTab = false } = {}) {
  if (!items.length) return;
  const dirs = items.filter((i) => i.d);
  const files = items.filter((i) => !i.d);
  // One image or video: Foldernator's viewer, each in its own window, so several stay open side by side and
  // ← → / PageUp/Down walk the folder (Photos can't when another app opens it; Media Player reuses one window).
  const isVideoFile = (f) => !f.d && !f.virt && ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ogv'].includes(extOf(f.n));
  if (files.length === 1 && !dirs.length && (isViewable(files[0]) || isVideoFile(files[0])) && state.settings.view.builtinViewer !== false) {
    const kind = isVideoFile(files[0]) ? isVideoFile : isViewable;
    const list = app.tab().view.filter(kind).map(({ p, n, m, s }) => ({ p, n, m, s }));
    return api.viewerOpen({ list, index: Math.max(0, list.findIndex((x) => x.p === files[0].p)) });
  }
  if (files.length > 12 && !(await confirmDialog({ title: `Open ${files.length} files?`, text: 'Each file opens in its default app.', ok: 'Open all' }))) return;
  for (const f of files) {
    if (f.virt) { api.shellInvoke(f.p).catch((e) => toast(cleanError(e.message), 'err')); continue; }
    if (extOf(f.n) === 'lnk') {
      const target = await api.readLink(f.p).catch(() => null);
      if (target && target.isDir) { navigate(target.path, { newTabFlag: inNewTab }); continue; }
    }
    const err = await api.open(f.p);
    if (err) toast(`Couldn’t open “${f.n}”: ${err}`, 'err');
  }
  dirs.forEach((d, i) => { if (i === 0 && !inNewTab) navigate(d.p); else newTab(d.p, { background: true }); });
}
app.openItems = (items, opts) => openItems(items, opts);
app.revealInView = (p) => { const t = app.tab(); if (!t.index.has(p)) return; t.sel = new Set([p]); t.focus = p; t.anchor = p; app.selectionChanged(); view.ensureVisible(t.index.get(p)); };

// ---------- clipboard / file ops ----------
async function copySel(cut) {
  const items = app.selectedItems().filter((i) => !i.drive && !i.portable);
  if (!items.length) return;
  const paths = items.map((i) => i.p);
  if (items.some((i) => i.virt)) { // files on a device: copy only, pasted through the shell
    state.virtClip = paths;
    toast(`Copied ${paths.length} item${paths.length > 1 ? 's' : ''} from the device`, 'info', { id: 'clip', ms: 1600 });
    return;
  }
  state.virtClip = null;
  await api.setClipboardFiles({ paths, cut });
  state.clip = { cut, set: new Set(paths.map((p) => p.toLowerCase())) };
  view.updateSelection();
  toast(`${cut ? 'Cut' : 'Copied'} ${paths.length} item${paths.length > 1 ? 's' : ''}`, 'info', { id: 'clip', ms: 1600 });
}

async function deviceCopy(paths, to) {
  const t = app.tab();
  toast(`Copying ${paths.length} item${paths.length > 1 ? 's' : ''}…`, 'busy', { id: 'devcopy' });
  try {
    await api.shellCopy({ paths, to });
    toast('Copied', 'ok', { id: 'devcopy' });
  } catch (e) { toast(`Couldn’t copy: ${cleanError(e.message)}`, 'err', { id: 'devcopy' }); }
  if (to.toLowerCase() === t.loc.toLowerCase()) setTimeout(() => load(t, { keep: true }), 600);
}
app.deviceCopy = deviceCopy;

async function paste(targetDir) {
  const t = app.tab();
  targetDir = targetDir || t.loc;
  // Device folders (Fire, phones) and device files go through the shell — always a copy.
  if (state.virtClip && state.virtClip.length && (isFsPath(targetDir) || isVirt(targetDir))) return deviceCopy(state.virtClip, targetDir);
  if (isVirt(targetDir)) {
    const cb = await api.getClipboardFiles();
    if (!cb.paths.length) { toast('Nothing to paste', 'warn', { id: 'clip' }); return; }
    return deviceCopy(cb.paths, targetDir);
  }
  if (!isFsPath(targetDir)) return;
  const cb = await api.getClipboardFiles();
  if (!cb.paths.length) { toast('Nothing to paste', 'warn', { id: 'clip' }); return; }
  const r = await api.fileOp({ op: cb.cut ? 'move' : 'copy', paths: cb.paths, to: targetDir });
  if (cb.cut && !r.aborted) { await api.copyText(''); state.clip = null; }
  if (targetDir.toLowerCase() === t.loc.toLowerCase()) await load(t, { keep: true });
  const names = new Set(cb.paths.map((p) => baseName(p).toLowerCase()));
  const pasted = t.view.filter((i) => names.has(i.n.toLowerCase())).map((i) => i.p);
  if (pasted.length && targetDir.toLowerCase() === t.loc.toLowerCase()) { t.sel = new Set(pasted); t.focus = pasted[0]; app.selectionChanged(); }
}

async function del(permanent) {
  const t = app.tab();
  const items = app.selectedItems().filter((i) => !i.drive);
  if (!items.length) return;
  const firstIdx = t.index.get(items[0].p);
  if (!permanent) await motionExit(items.map((i) => view.nodes.get(i.p)).filter(Boolean));
  const r = await api.fileOp({ op: permanent ? 'delete' : 'recycle', paths: items.map((i) => i.p) });
  if (r && r.hr && !r.aborted) toast(`${IS_MAC ? 'Some items' : 'Windows'} couldn’t be deleted.`, 'err');
  // Search results aren't re-listed by load(): drop the ones that are really gone.
  if (t.search) {
    const gone = await Promise.all(items.map((i) => api.stat(i.p).then(() => null, () => i.p)));
    const drop = new Set(gone.filter(Boolean));
    t.search.items = t.search.items.filter((i) => !drop.has(i.p));
  }
  await load(t, { keep: true });
  const next = t.view[Math.min(firstIdx, t.view.length - 1)];
  if (next) { t.sel = new Set([next.p]); t.focus = next.p; t.anchor = next.p; app.selectionChanged(); }
}

app.copyPaths = (items) => {
  const text = items.map((i) => `"${i.p}"`).join('\r\n');
  api.copyText(text);
  toast(items.length > 1 ? `Copied ${items.length} paths` : 'Copied path', 'info', { id: 'clip', ms: 1600 });
};

app.commitRename = async (it, newName) => {
  const t = app.tab();
  try {
    const to = await api.rename(it.p, newName);
    state.undo.push({ type: 'rename', from: it.p, to, label: 'rename' });
    // Same for search results: the renamed hit takes its new name/path in place.
    const hit = t.search && t.search.items.find((i) => i.p === it.p);
    if (hit) { hit.n = baseName(to); hit.p = to; }
    // Rename in place first, so the reload finds the same node with the same signature and changes nothing
    // (no thumbnail re-fetch, no fade-in blink).
    const from = it.p;
    const live = t.items.find((i) => i.p === from) || it;
    live.n = baseName(to); live.p = to;
    if (t.index.has(from)) { t.index.set(to, t.index.get(from)); t.index.delete(from); }
    if (t.sel.delete(from)) t.sel.add(to);
    if (t.focus === from) t.focus = to;
    if (t === app.tab()) view.renameInPlace(from, live);
    await load(t, { keep: true, select: to });
  } catch (e) {
    toast(cleanError(e.message), 'err');
  }
};

async function newFolder() {
  const t = app.tab();
  if (!isFsPath(t.loc) || t.search) return;
  try {
    const p = await api.mkdir(t.loc);
    state.undo.push({ type: 'create', path: p, label: 'new folder' });
    await load(t, { keep: true, select: p });
    view.startRename(p);
  } catch (e) { toast(cleanError(e.message), 'err'); }
}

async function newFile() {
  const t = app.tab();
  if (!isFsPath(t.loc) || t.search) return;
  try {
    const p = await api.newFile(t.loc);
    state.undo.push({ type: 'create', path: p, label: 'new file' });
    await load(t, { keep: true, select: p });
    view.startRename(p);
  } catch (e) { toast(cleanError(e.message), 'err'); }
}

async function undo() {
  const a = state.undo.pop();
  if (!a) return;
  try {
    if (a.type === 'rename') await api.rename(a.to, baseName(a.from));
    if (a.type === 'create') await api.fileOp({ op: 'recycle', paths: [a.path] });
    toast(`Undid ${a.label}`, 'info', { ms: 1800 });
    load(app.tab(), { keep: true, select: a.type === 'rename' ? a.from : null });
  } catch (e) { toast(cleanError(e.message), 'err'); }
}

// ---------- status colors ----------
async function ensureIcon(color) {
  const style = iconStyles.folder;
  const key = style + ':' + color;
  if (!color || state.iconsReady.has(key)) return;
  if (!(await api.hasIcon(color, style))) await api.writeIcon({ hex: color, style, images: await folderImages(color, style) });
  state.iconsReady.add(key);
}

function currentFolderItem() {
  const loc = app.tab().loc;
  const st = app.knownStatus(loc);
  return { n: baseName(loc), p: loc, d: true, st: st && st.status, col: st && st.color };
}

function statusTargets() {
  const sel = app.selectedItems().filter((i) => i.d && !i.drive && app.isStatusTarget(i.p));
  if (sel.length) return sel;
  const loc = app.tab().loc;
  return app.isStatusTarget(loc) ? [currentFolderItem()] : [];
}

function statusAvailableHere() {
  const t = app.tab();
  return app.isStatusScope(t.loc) || app.isStatusTarget(t.loc) || t.loc.startsWith('board:');
}

async function setScope(loc, on) {
  const cur = state.settings.statusScopes || [];
  const entry = app.scopeEntryFor(loc);
  if (!on && entry && lower(entry) !== lower(loc)) {
    toast(`This folder is covered by “${entry}” — change it in Settings → Status colors.`, 'warn', { ms: 5000 });
    return;
  }
  const next = on ? [...cur.filter((x) => lower(x) !== lower(loc)), loc] : cur.filter((x) => lower(x) !== lower(loc));
  state.settings = await api.setSetting('statusScopes', next);
  for (const t of state.tabs) computeView(t);
  view.render({ keepScroll: true });
  renderChrome();
  toast(on ? `Status colors on for “${titleFor(loc)}”` : `Status colors off for “${titleFor(loc)}”`, 'ok', { ms: 2200 });
}
app.setScope = setScope;

async function setStatus(statusKey, explicitColor, targets) {
  targets = targets || statusTargets();
  if (statusKey && !targets.length) {
    toast(statusAvailableHere() ? 'Select one or more video folders first.' : 'Status colors work inside status folders. Right-click empty space → “Use status colors here” to add this one.', 'warn', { ms: 5000 });
    return;
  }
  if (!targets.length) { toast('Select one or more folders first.', 'warn'); return; }
  const st = statusKey ? app.statusByKey(statusKey) : null;
  const color = st ? st.color : (explicitColor || null);
  try {
    await ensureIcon(color);
    const { results, statusIndex } = await api.setStatus({ paths: targets.map((i) => i.p), status: statusKey || null, color, iconStyle: iconStyles.folder });
    state.settings.statusIndex = statusIndex;
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    for (const t of state.tabs) {
      let touched = false;
      for (const it of t.items) {
        if (ok.some((r) => r.path.toLowerCase() === it.p.toLowerCase())) { it.st = statusKey || undefined; it.col = color || undefined; touched = true; }
      }
      if (touched) computeView(t);
    }
    view.render({ keepScroll: true });
    for (const r of ok) { const n = view.nodes.get(r.path) || [...view.nodes.entries()].find(([k]) => k.toLowerCase() === r.path.toLowerCase())?.[1]; if (n) bounce(n.querySelector('.tile-icon, .ic')); }
    sidebar.render();
    renderTabs();
    preview.current = null; showPreview();
    if (bad.length) toast(`${bad.length} couldn’t be colored: ${bad[0].error}`, 'err');
    else toast(`${st ? st.label : color ? 'Color set' : 'Status cleared'} · ${ok.length} folder${ok.length > 1 ? 's' : ''}`, 'ok', { id: 'status', ms: 2200 });
    if (app.tab().loc.startsWith('board:')) load(app.tab(), { keep: true });
  } catch (e) {
    toast(cleanError(e.message), 'err');
  }
}
app.setStatus = setStatus;

// Pull the colors already set on Google Drive into a status folder (local only — nothing is written back).
async function pullDriveColors(dir) {
  const t = app.tab();
  toast('Reading folder colors from Google Drive…', 'busy', { id: 'pull' });
  const r = await api.driveChildColors(dir);
  if (r.error) return toast(`Drive: ${r.error}`, 'err', { id: 'pull' });
  if (!r.mapped) return toast('This folder isn’t mapped to Google Drive (Settings → Google Drive).', 'warn', { id: 'pull' });
  if (r.missing) return toast(`Not on Drive: ${r.remote}`, 'warn', { id: 'pull' });
  const byName = new Map(r.items.filter((x) => x.color && x.color !== '#8f8f8f').map((x) => [x.name.toLowerCase(), x.color]));
  const local = t.items.filter((i) => i.d && byName.has(i.n.toLowerCase()));
  const groups = new Map();
  for (const it of local) {
    const color = byName.get(it.n.toLowerCase());
    if ((it.col || '').toLowerCase() === color) continue;
    const st = state.settings.statuses.find((s) => s.color.toLowerCase() === color);
    const key = st ? 'st:' + st.key : 'c:' + color;
    if (!groups.has(key)) groups.set(key, { status: st ? st.key : null, color, items: [] });
    groups.get(key).items.push(it);
  }
  let n = 0;
  for (const g of groups.values()) {
    await ensureIcon(g.color);
    const { results, statusIndex } = await api.setStatus({ paths: g.items.map((i) => i.p), status: g.status, color: g.color, skipDrive: true, iconStyle: iconStyles.folder });
    state.settings.statusIndex = statusIndex;
    n += results.filter((x) => x.ok).length;
  }
  await load(t, { keep: true });
  sidebar.render();
  toast(n ? `${n} folder${n > 1 ? 's' : ''} colored from Google Drive` : 'Already matches Google Drive', 'ok', { id: 'pull' });
}
app.pullDriveColors = pullDriveColors;

function statusSubmenu(targets) {
  const s = state.settings;
  const cur = targets.length && targets.every((t) => t.st === targets[0].st) ? targets[0].st : null;
  return [
    ...s.statuses.map((st) => ({ label: st.label + (cur === st.key ? '  ✓' : ''), swatch: st.color, key: 'Alt+' + st.hotkey, action: () => setStatus(st.key, null, targets) })),
    '-',
    { label: 'Clear status', icon: 'close', key: 'Alt+0', action: () => setStatus(null, null, targets) },
  ];
}

function paletteElement(targets) {
  return () => {
    const cur = targets.length === 1 ? targets[0].col : null;
    const grid = el('div', { class: 'palette-grid' });
    for (const c of state.palette) {
      const b = el('button', { class: c === cur ? 'cur' : '', title: c, style: { background: c } });
      b.addEventListener('click', () => { closeMenus(); setStatus(null, c, targets); });
      grid.append(b);
    }
    const custom = el('input', { type: 'color', title: 'Custom color', style: { width: '26px', height: '26px', padding: 0, border: 0, borderRadius: '50%', background: 'none' } });
    custom.addEventListener('change', () => { closeMenus(); setStatus(null, custom.value, targets); });
    grid.append(custom);
    return el('div', {}, el('div', { class: 'menu-head', text: 'Google Drive colors' }), grid);
  };
}

// ---------- pins ----------
app.isPinned = (p) => (state.settings.pinned || []).some((x) => x.toLowerCase() === p.toLowerCase());
app.pinFolders = async (paths, index) => {
  const pins = [...(state.settings.pinned || [])];
  let at = index == null ? pins.length : index;
  for (const p of paths) {
    try { const st = await api.stat(p); if (!st.isDir) continue; } catch { continue; }
    if (pins.some((x) => x.toLowerCase() === p.toLowerCase())) continue;
    pins.splice(at++, 0, p);
  }
  state.settings = await api.setSetting('pinned', pins);
  sidebar.render();
  if (app.tab().loc === 'home') load(app.tab(), { keep: true });
};
app.movePin = async (from, to) => {
  const pins = [...(state.settings.pinned || [])];
  if (from < 0 || from >= pins.length) return;
  const [p] = pins.splice(from, 1);
  pins.splice(to > from ? to - 1 : to, 0, p);
  state.settings = await api.setSetting('pinned', pins);
  sidebar.render();
  if (app.tab().loc === 'home') load(app.tab(), { keep: true });
};
app.importWindowsPins = async (replace = true) => {
  const qa = await api.quickAccess();
  const win = qa.filter((x) => x.pinned && x.path).map((x) => x.path.replace(/\\$/, '') + (/^[a-zA-Z]:$/.test(x.path.replace(/\\$/, '')) ? '\\' : ''));
  const pins = replace ? win : [...(state.settings.pinned || []), ...win.filter((w) => !(state.settings.pinned || []).some((x) => x.toLowerCase() === w.toLowerCase()))];
  state.settings = await api.setSetting('pinned', pins);
  state.settings = await api.setSetting('pinsImported', true);
  sidebar.render();
  return pins.length;
};
app.unpin = async (p) => {
  state.settings = await api.setSetting('pinned', (state.settings.pinned || []).filter((x) => x.toLowerCase() !== p.toLowerCase()));
  sidebar.render();
};

// ---------- drag & drop ----------
// The drag runs in Windows' own drag loop, which swallows mouse events, so the dragged paths are kept until the
// drop (or the next click) instead of being guessed away on a stray mousemove/focus — that used to empty them
// mid-drag and a drop onto a folder then did nothing.
app.beginDrag = (paths) => {
  state.dragging = paths;
  state.dragAt = Date.now();
  api.startDrag(paths);
  const clear = () => { if (Date.now() - state.dragAt > 300) { state.dragging = null; window.removeEventListener('mousedown', clear, true); } };
  window.addEventListener('mousedown', clear, true);
};

function decideOp(e, paths, dir) {
  if (IS_MAC ? e.altKey : e.ctrlKey) return 'copy';
  if (IS_MAC ? e.metaKey : e.shiftKey) return 'move';
  return paths.length && diskOf(paths[0]) === diskOf(dir) ? 'move' : 'copy';
}

// Only our own drags report "move" back to the source; external sources always see "copy",
// so Explorer never deletes originals before our shell move finishes.
app.dropEffectFor = (e, dir) => (state.dragging ? decideOp(e, state.dragging, dir) : /copy|all|uninitialized/i.test(e.dataTransfer.effectAllowed || 'all') ? 'copy' : 'move');

// Drops from other apps honour what the source allows. Archive apps (WinRAR, 7-Zip) hand over files they just
// extracted to a temp folder and only allow COPY — asking Windows for a move made the drop get refused.
const TEMPISH = /[\\/](temp|tmp|t)[\\/]/i; // (a Mac's temp folders end in /T/)
function externalOp(e, paths, dir) {
  const ea = (e.dataTransfer && e.dataTransfer.effectAllowed) || 'all';
  const canMove = /move|all|uninitialized/i.test(ea), canCopy = /copy|all|uninitialized/i.test(ea);
  if (!canMove) return 'copy';
  if (!canCopy) return 'move';
  if (e.ctrlKey) return 'copy';
  if (paths.some((p) => TEMPISH.test(p))) return 'copy';
  return decideOp(e, paths, dir);
}
app.externalOp = externalOp;

app.pathsFromDrop = (e) => {
  const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  return paths.length ? paths : (state.dragging || []);
};
app.pathsFromDropAsync = async (e) => {
  const p = app.pathsFromDrop(e);
  if (p.length) return p;
  const last = await api.lastDrag().catch(() => null); // our own drag, remembered by the main process
  return last && Date.now() - last.t < 30000 ? last.paths : [];
};

// Drag diagnostics (foldernator.log): what other apps really hand over on enter / drop.
let dragLogAt = 0;
document.addEventListener('dragenter', (e) => { if (state.dragging || Date.now() - dragLogAt < 1500) return; dragLogAt = Date.now(); try { api.log('dragenter types=' + JSON.stringify([...e.dataTransfer.types]) + ' allowed=' + e.dataTransfer.effectAllowed + ' items=' + e.dataTransfer.items.length); } catch {} }, true);
document.addEventListener('drop', (e) => { if (state.dragging) return; try { const f = [...e.dataTransfer.files]; api.log('drop types=' + JSON.stringify([...e.dataTransfer.types]) + ' allowed=' + e.dataTransfer.effectAllowed + ' dropEffect=' + e.dataTransfer.dropEffect + ' files=' + JSON.stringify(f.map((x) => [x.name, x.size, api.pathForFile(x)]))); } catch (err) { api.log('drop log failed ' + err.message); } }, true);

app.handleDrop = async (e, dir, targetNode) => {
  const ours = state.dragging;
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  let paths = app.pathsFromDrop(e);
  state.dragging = null;
  // Archive apps (WinRAR, 7-Zip) give relative names and extract after the drop: wait, then copy the result.
  const rel = paths.filter((p) => !isFsPath(p));
  if (!ours && rel.length && dir && isFsPath(dir)) {
    ripple(e.clientX, e.clientY);
    toast(`Waiting for the archive to extract ${rel.length} item${rel.length > 1 ? 's' : ''}…`, 'busy', { id: 'rar' });
    try {
      const abs = await api.resolveRelativeDrop({ rels: rel, since: Date.now() });
      toast(`Copying ${abs.length} item${abs.length > 1 ? 's' : ''}…`, 'busy', { id: 'rar' });
      await api.fileOp({ op: 'copy', paths: abs, to: dir });
      toast(`Copied ${abs.length} item${abs.length > 1 ? 's' : ''} from the archive`, 'ok', { id: 'rar' });
    } catch (err) { toast(`Couldn’t copy from the archive: ${cleanError(err.message)}`, 'err', { id: 'rar' }); }
    const t1 = app.tab(); if (isFsPath(t1.loc)) load(t1, { keep: true });
    paths = paths.filter((p) => !rel.includes(p));
    if (!paths.length) return;
  }
  // Files that arrive as data with no path on disk (virtual files: some archive apps, mail attachments,
  // browsers) are written into the folder.
  const loose = ours ? [] : files.filter((f) => !api.pathForFile(f));
  if (loose.length && dir && isFsPath(dir)) {
    ripple(e.clientX, e.clientY);
    toast(`Copying ${loose.length} item${loose.length > 1 ? 's' : ''}…`, 'busy', { id: 'loose' });
    try {
      for (const f of loose) await api.writeDropped({ dir, name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      toast('Copied', 'ok', { id: 'loose' });
    } catch (err) { toast(`Couldn’t copy: ${cleanError(err.message)}`, 'err', { id: 'loose' }); }
    const t0 = app.tab(); if (isFsPath(t0.loc)) load(t0, { keep: true });
    if (!paths.length || paths === ours) return;
  }
  if (ours && targetNode) flyInto(ours.map((p) => view.nodes.get(p)).filter(Boolean), targetNode.querySelector('.tile-icon, .ic') || targetNode);
  else if (!ours) ripple(e.clientX, e.clientY);
  if (!paths.length || !dir) return;
  if (isVirt(dir) || paths.some(isVirt)) return deviceCopy(paths, dir); // to / from a device: shell copy
  const dl = trimSep(dir).toLowerCase();
  const valid = paths.filter((p) => { const pl = p.toLowerCase(); return pl !== dl && !dl.startsWith(pl + SEP); });
  if (!valid.length) { toast('Can’t move a folder into itself.', 'warn'); return; }
  const op = ours ? decideOp(e, valid, dir) : externalOp(e, valid, dir);
  // Moving out of this folder: the items leave the view at once (put back if the move fails), instead of
  // waiting for the move and the reload.
  const t = app.tab();
  let hidden = null;
  if (op === 'move' && ours && isFsPath(t.loc) && dir.toLowerCase() !== t.loc.toLowerCase()) {
    const gone = new Set(valid.map((p) => p.toLowerCase()));
    hidden = t.items.filter((i) => gone.has(i.p.toLowerCase()));
    if (hidden.length) {
      t.items = t.items.filter((i) => !gone.has(i.p.toLowerCase()));
      for (const p of valid) t.sel.delete(p);
      setTimeout(() => { if (t === app.tab()) { computeView(t); view.render({ keepScroll: true }); renderStatusbar(); } }, motionLevel() > 0 ? 260 : 0);
    }
  }
  let r = null;
  try { r = await api.fileOp({ op, paths: valid, to: dir }); } catch (err) { toast(cleanError(err.message), 'err'); }
  if (r && r.noop && !(hidden && hidden.length)) return;
  if (isFsPath(t.loc)) load(t, { keep: true });
};

// ---------- menus ----------
function viewSubmenu() {
  const v = app.viewSettings();
  const is = (m, s) => v.mode === m && (m === 'details' || v.iconSize === s);
  return [
    { label: 'Extra large icons', checked: is('icons', 'xl'), key: 'Ctrl+Shift+1', action: () => setViewMode('icons', 'xl') },
    { label: 'Large icons', checked: is('icons', 'large'), key: 'Ctrl+Shift+2', action: () => setViewMode('icons', 'large') },
    { label: 'Medium icons', checked: is('icons', 'medium'), key: 'Ctrl+Shift+3', action: () => setViewMode('icons', 'medium') },
    { label: 'Details', checked: is('details'), key: 'Ctrl+Shift+6', action: () => setViewMode('details') },
    '-',
    { label: 'Group by', icon: 'sort', submenu: () => [
      { label: 'None', checked: v.group !== 'date', action: () => setGroupBy('none') },
      { label: 'Date modified', checked: v.group === 'date', action: () => setGroupBy('date') },
    ] },
    '-',
    { label: 'Navigation pane', checked: layout.cfg.sidebar !== 'hidden', action: () => layout.set({ sidebar: layout.cfg.sidebar === 'hidden' ? 'left' : 'hidden' }) },
    { label: 'Preview pane', checked: state.settings.view.previewPane, key: 'Alt+P', action: () => app.setViewFlag('previewPane', !state.settings.view.previewPane) },
    { label: 'Panel positions', icon: 'dockLeft', submenu: () => [
      { head: 'Navigation pane' },
      { label: 'Left', checked: layout.cfg.sidebar === 'left', action: () => layout.set({ sidebar: 'left' }) },
      { label: 'Right', checked: layout.cfg.sidebar === 'right', action: () => layout.set({ sidebar: 'right' }) },
      '-',
      { head: 'Preview pane' },
      { label: 'Right', checked: layout.cfg.preview === 'right', action: () => layout.set({ preview: 'right' }) },
      { label: 'Left', checked: layout.cfg.preview === 'left', action: () => layout.set({ preview: 'left' }) },
      { label: 'Bottom', checked: layout.cfg.preview === 'bottom', action: () => layout.set({ preview: 'bottom' }) },
    ] },
    { label: 'Hidden items', checked: state.settings.view.showHidden, key: 'Ctrl+H', action: () => app.setViewFlag('showHidden', !state.settings.view.showHidden) },
    { label: 'File name extensions', checked: state.settings.view.showExt, action: () => app.setViewFlag('showExt', !state.settings.view.showExt) },
  ];
}

function sortSubmenu() {
  const s = app.viewSettings().sort;
  const keys = [['name', 'Name'], ['modified', 'Date modified'], ['type', 'Type'], ['size', 'Size'], ['status', 'Status']];
  if (app.tab().search || app.tab().loc.startsWith('board:')) keys.push(['location', 'Folder']);
  return [
    ...keys.map(([k, l]) => ({ label: l, checked: s.key === k, action: () => { if (s.key !== k) app.setSort(k); } })),
    '-',
    { label: 'Ascending', checked: s.dir > 0, action: () => { if (s.dir < 0) app.setSort(s.key); } },
    { label: 'Descending', checked: s.dir < 0, action: () => { if (s.dir > 0) app.setSort(s.key); } },
    '-',
    { label: 'Folders first', checked: state.settings.view.foldersFirst, action: () => app.setViewFlag('foldersFirst', !state.settings.view.foldersFirst) },
  ];
}

async function mountImage(it) {
  toast(`Mounting “${it.n}”…`, 'busy', { id: 'mount' });
  try {
    const root = await api.mountImage(it.p);
    toast(root ? `Mounted as ${root.slice(0, 2)}` : 'Mounted', 'ok', { id: 'mount', action: root ? { label: 'Open', onClick: () => navigate(root) } : null });
    refreshDrives();
  } catch (e) { toast(`Couldn’t mount: ${cleanError(e.message)}`, 'err', { id: 'mount' }); }
}
async function ejectDrive(root) {
  try { await api.ejectDrive(root); toast(`Ejected ${root.slice(0, 2)}`, 'ok'); setTimeout(refreshDrives, 800); }
  catch (e) { toast(`Couldn’t eject: ${cleanError(e.message)}`, 'err'); }
}

app.itemMenu = (x, y, extended) => {
  const items = app.selectedItems();
  if (!items.length) return;
  if (items.some((i) => i.virt || i.portable)) {
    const one = items.length === 1 ? items[0] : null;
    showMenu([
      { label: 'Open', icon: 'open', key: 'Enter', action: () => openItems(items) },
      one && one.d ? { label: 'Open in new tab', icon: 'plus', action: () => newTab(one.p, { background: true }) } : null,
      '-',
      !items.some((i) => i.portable) ? { label: 'Copy', icon: 'copy', key: 'Ctrl+C', action: () => copySel(false) } : null,
      one && one.d ? { label: 'Paste into folder', icon: 'paste', key: 'Ctrl+V', action: () => paste(one.p) } : null,
      '-',
      { label: 'Open in Windows Explorer', icon: 'folder', action: () => api.explorerOpen(items[0].p) },
    ].filter(Boolean), x, y);
    return;
  }
  if (extended) return nativeMenu(x, y, true);
  const one = items.length === 1 ? items[0] : null;
  const folders = items.filter((i) => i.d && !i.drive);
  const targets = folders.filter((i) => app.isStatusTarget(i.p));
  const anyDrive = items.some((i) => i.drive);
  showMenu([
    { label: 'Open', icon: 'open', key: 'Enter', action: () => openItems(items) },
    one && one.d ? { label: 'Open in new tab', icon: 'plus', action: () => newTab(one.p, { background: true }) } : null,
    one && !one.d ? { label: 'Open with…', icon: 'external', action: () => api.openWith(one.p) } : null,
    one && !one.d && ['iso', 'img', 'vhd', 'vhdx'].includes(extOf(one.n)) ? { label: 'Mount', icon: 'drive', action: () => mountImage(one) } : null,
    one && one.drive && one.type !== 'Fixed' ? { label: 'Eject', icon: 'up', action: () => ejectDrive(one.p) } : null,
    '-',
    targets.length ? { label: 'Status', icon: 'dot', submenu: () => statusSubmenu(targets) } : null,
    folders.length ? { label: 'Folder color', icon: 'palette', submenu: () => [{ element: paletteElement(folders) }, '-', { label: 'Default color', icon: 'close', action: () => setStatus(null, null, folders) }] } : null,
    folders.length ? '-' : null,
    !anyDrive ? { label: 'Cut', icon: 'cut', key: 'Ctrl+X', action: () => copySel(true) } : null,
    !anyDrive ? { label: 'Copy', icon: 'copy', key: 'Ctrl+C', action: () => copySel(false) } : null,
    one && one.d ? { label: 'Paste into folder', icon: 'paste', action: () => paste(one.p) } : null,
    { label: 'Copy as path', icon: 'link', key: 'Ctrl+Shift+C', action: () => app.copyPaths(items) },
    '-',
    one && !one.drive ? { label: 'Rename', icon: 'rename', key: 'F2', action: () => view.startRename(one.p) } : null,
    !anyDrive ? { label: 'Delete', icon: 'trash', key: 'Del', action: () => del(false) } : null,
    '-',
    one && one.d ? (app.isPinned(one.p) ? { label: 'Unpin from Quick access', icon: 'pin', action: () => app.unpin(one.p) } : { label: 'Pin to Quick access', icon: 'pin', action: () => app.pinFolders([one.p]) }) : null,
    one && one.d ? { label: 'Open in Terminal', icon: 'terminal', action: () => api.terminal(one.p) } : null,
    { label: 'Show in Windows Explorer', icon: 'folder', action: () => api.reveal(items[0].p) },
    one && isMediaFile(one) ? { label: 'Media details', icon: 'video', key: 'Ctrl+I', action: () => openMediaDetails(app, one.p) } : null,
    { label: 'Properties', icon: 'info', key: 'Alt+Enter', action: () => api.properties(items.map((i) => i.p)) },
    '-',
    { label: 'Show more options', icon: 'more', key: 'Shift+F10', action: () => nativeMenu(x, y) },
  ], x, y);
};

app.backgroundMenu = (x, y) => {
  const t = app.tab();
  const loc = t.loc;
  const fs = isFsPath(loc) && !t.search;
  const last = state.undo[state.undo.length - 1];
  showMenu([
    { label: 'View', icon: 'view', submenu: viewSubmenu },
    { label: 'Sort by', icon: 'sort', submenu: sortSubmenu },
    { label: 'Refresh', icon: 'refresh', key: 'F5', action: refresh },
    '-',
    fs ? { label: 'Paste', icon: 'paste', key: 'Ctrl+V', action: () => paste(loc) } : null,
    last ? { label: `Undo ${last.label}`, icon: 'undo', key: 'Ctrl+Z', action: undo } : null,
    fs ? { label: 'New', icon: 'plus', submenu: [{ label: 'Folder', icon: 'newFolder', key: 'Ctrl+Shift+N', action: newFolder }, { label: 'Text document', icon: 'doc', action: newFile }] } : null,
    '-',
    app.isStatusTarget(loc) ? { label: 'Status of this folder', icon: 'dot', submenu: () => statusSubmenu([currentFolderItem()]) } : null,
    app.isStatusScope(loc) && state.settings.drive.enabled ? { label: 'Get status colors from Google Drive', icon: 'cloud', action: () => pullDriveColors(loc) } : null,
    fs && !isRoot(loc) ? (app.isStatusScope(loc)
      ? { label: 'Stop using status colors here', icon: 'close', action: () => setScope(loc, false) }
      : { label: 'Use status colors here', icon: 'dot', action: () => setScope(loc, true) }) : null,
    fs && !isRoot(loc) && !app.isPinned(loc) ? { label: 'Pin to Quick access', icon: 'pin', action: () => app.pinFolders([loc]) } : null,
    fs ? { label: 'Open in Terminal', icon: 'terminal', action: () => api.terminal(loc) } : null,
    fs ? { label: 'Open in Windows Explorer', icon: 'folder', action: () => api.open(loc) } : null,
    fs ? { label: 'Properties', icon: 'info', action: () => api.properties([loc]) } : null,
  ], x, y);
};

app.sidebarMenu = (x, y, loc, { pinned } = {}) => {
  const fs = isFsPath(loc);
  const st = app.knownStatus(loc);
  const item = { n: baseName(loc), p: loc, d: true, st: st && st.status };
  showMenu([
    { label: 'Open', icon: 'open', action: () => navigate(loc) },
    { label: 'Open in new tab', icon: 'plus', action: () => newTab(loc, { background: true }) },
    app.isStatusTarget(loc) ? '-' : null,
    app.isStatusTarget(loc) ? { label: 'Status', icon: 'dot', submenu: () => statusSubmenu([item]) } : null,
    '-',
    pinned ? { label: 'Unpin from Quick access', icon: 'pin', action: () => app.unpin(loc) } : null,
    fs && !pinned && !isRoot(loc) && !app.isPinned(loc) ? { label: 'Pin to Quick access', icon: 'pin', action: () => app.pinFolders([loc]) } : null,
    fs ? { label: 'Open in Terminal', icon: 'terminal', action: () => api.terminal(loc) } : null,
    fs ? { label: 'Properties', icon: 'info', action: () => api.properties([loc]) } : null,
  ], x, y);
};

async function nativeMenu(x, y, extended = false) {
  const items = app.selectedItems().filter((i) => !i.drive || true);
  if (!items.length) return;
  if (x == null) {
    const n = view.nodes.get(app.tab().focus || items[0].p);
    const r = n ? n.getBoundingClientRect() : view.root.getBoundingClientRect();
    x = r.left + 40; y = r.top + r.height / 2;
  }
  try {
    const r = await api.nativeMenu({ paths: items.map((i) => i.p), x, y, extended });
    if (!r || !r.chosen) return;
    if (r.action === 'rename' && items.length === 1) view.startRename(items[0].p);
    else if (r.action === 'delete') del(false);
    else if (r.action === 'cut') copySel(true);
    else if (r.action === 'copy') copySel(false);
    else if (r.action === 'paste') paste(items.length === 1 && items[0].d ? items[0].p : null);
    else setTimeout(() => load(app.tab(), { keep: true }), 600);
  } catch (e) {
    toast((IS_MAC ? 'Menu failed: ' : 'Windows menu failed: ') + cleanError(e.message), 'err');
  }
}

// ---------- chrome: breadcrumb, command bar, status bar ----------
function crumbSegments(loc) {
  if (loc === 'thispc') return [{ label: 'This PC', loc: 'thispc', icon: 'pc' }];
  if (isVirt(loc)) {
    const chain = [];
    for (let l = loc; l && isVirt(l); l = state.parents.get(l)) chain.unshift({ label: titleFor(l), loc: l });
    return [{ label: 'This PC', loc: 'thispc', icon: 'pc' }, ...chain];
  }
  if (loc === 'home') return [{ label: 'Home', loc: 'home', icon: 'home' }];
  if (loc === 'gallery') return [{ label: 'Gallery', loc: 'gallery', icon: 'image' }];
  if (loc.startsWith('board:')) return [{ label: 'Status', loc: null, icon: 'dot' }, { label: titleFor(loc), loc }];
  const segs = [{ label: IS_MAC ? 'Computer' : 'This PC', loc: 'thispc', icon: 'pc' }];
  if (IS_MAC) {
    // a Mac path: the disk ("/" or /Volumes/<name>), then each folder
    const vol = /^\/Volumes\/[^/]+/.exec(loc);
    const root = vol ? vol[0] : '/';
    segs.push({ label: baseName(root), loc: root });
    let acc = root === '/' ? '' : root;
    for (const part of loc.slice(root === '/' ? 1 : root.length).split('/').filter(Boolean)) { acc += '/' + part; segs.push({ label: part, loc: acc }); }
    return segs;
  }
  const root = loc.slice(0, 3);
  segs.push({ label: titleFor(root), loc: root });
  const rest = loc.slice(3).split('\\').filter(Boolean);
  let acc = root;
  for (const part of rest) { acc = acc.endsWith('\\') ? acc + part : acc + '\\' + part; segs.push({ label: part, loc: acc }); }
  return segs;
}

function renderCrumbs() {
  const host = $('#crumbs');
  if (host.classList.contains('editing')) return;
  const t = app.tab();
  const segs = crumbSegments(t.loc);
  const nodes = [];
  segs.forEach((s, i) => {
    const c = el('button', { class: 'crumb', dataset: { loc: s.loc || '' } },
      s.icon ? el('span', { class: 'crumb-icon', html: icon(s.icon, 14) }) : null,
      el('span', { text: s.label }));
    if (s.loc) c.addEventListener('click', () => navigate(s.loc));
    if (s.loc && isFsPath(s.loc)) {
      c.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); c.classList.add('drag-over'); e.dataTransfer.dropEffect = app.dropEffectFor(e, s.loc); });
      c.addEventListener('dragleave', () => c.classList.remove('drag-over'));
      c.addEventListener('drop', (e) => { e.preventDefault(); c.classList.remove('drag-over'); app.handleDrop(e, s.loc); });
    }
    nodes.push(c);
    if (s.loc && (s.loc === 'thispc' || isFsPath(s.loc))) {
      const sep = el('button', { class: 'sep', html: icon('chevron', 12), title: 'Show subfolders' });
      sep.addEventListener('click', (e) => { e.stopPropagation(); subfolderMenu(s.loc, sep); });
      nodes.push(sep);
    }
  });
  const fill = el('div', { class: 'crumb-fill' });
  fill.addEventListener('mousedown', (e) => { e.preventDefault(); editAddress(); });
  host.replaceChildren(...nodes, fill);
  // Collapse leading crumbs when the path is too long.
  let hidden = 0;
  const crumbs = [...host.querySelectorAll('.crumb')];
  while (host.scrollWidth > host.clientWidth && hidden < crumbs.length - 1) {
    crumbs[hidden].style.display = 'none';
    const sep = crumbs[hidden].nextElementSibling;
    if (sep && sep.classList.contains('sep')) sep.style.display = 'none';
    hidden++;
  }
  if (hidden) {
    const more = el('button', { class: 'crumb crumb-overflow', html: '…', title: 'More' });
    more.addEventListener('click', () => showMenuAt(segs.slice(0, hidden).reverse().map((s) => ({ label: s.label, icon: s.icon || 'folder', action: () => s.loc && navigate(s.loc) })), more));
    host.prepend(more);
  }
}

async function subfolderMenu(loc, anchor) {
  try {
    let entries;
    if (loc === 'thispc') {
      entries = state.drives.filter((d) => d.ready).map((d) => ({ label: `${d.label || 'Local Disk'} (${d.path.slice(0, 2)})`, loc: d.path }));
    } else {
      const r = await api.list(loc);
      const showHidden = state.settings.view.showHidden;
      entries = r.items.filter((i) => i.d && !(i.h && i.sys) && (showHidden || !i.h)).sort((a, b) => collator.compare(a.n, b.n)).map((i) => ({ label: i.n, loc: i.p }));
    }
    if (!entries.length) entries = [{ label: 'No subfolders', disabled: true }];
    const cur = app.tab().loc.toLowerCase();
    showMenuAt(entries.slice(0, 400).map((e) => ({ label: e.label, icon: e.loc && isRoot(e.loc) ? 'pc' : 'folder', disabled: e.disabled, checked: e.loc && cur.startsWith(e.loc.toLowerCase()), action: () => navigate(e.loc) })), anchor);
  } catch (e) { toast(cleanError(e.message), 'err'); }
}

function editAddress() {
  const host = $('#crumbs');
  const t = app.tab();
  host.classList.add('editing');
  const input = el('input', { type: 'text', spellcheck: 'false', value: t.loc === 'thispc' ? 'This PC' : t.loc.startsWith('board:') ? titleFor(t.loc) : t.loc });
  host.replaceChildren(input);
  input.focus();
  input.select();
  const finish = () => { host.classList.remove('editing'); renderCrumbs(); };
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(); view.root.focus(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim().replace(/^"|"$/g, '');
      host.classList.remove('editing');
      await goTo(v);
      renderCrumbs();
      view.root.focus();
    }
  });
  input.addEventListener('blur', () => { if (host.classList.contains('editing')) finish(); });
}

async function goTo(text) {
  if (!text || /^(this pc|thispc|computer)$/i.test(text)) return navigate('thispc');
  let p = text.replace(/%([^%]+)%/g, (m, v) => ({ userprofile: state.paths.home, home: state.paths.home }[v.toLowerCase()] || m));
  if (IS_MAC && p.startsWith('~')) p = state.paths.home + p.slice(1);
  if (/^[a-zA-Z]:$/.test(p)) p += '\\';
  try {
    const st = await api.stat(p);
    if (st.isDir) navigate(p);
    else openItems([{ n: baseName(p), p, d: false }]);
  } catch {
    toast(`${IS_MAC ? 'Foldernator' : 'Windows'} can’t find “${text}”.`, 'err');
  }
}

function cmd(label, iconName, action, { disabled = false, on = false, caret = false, title, iconOnly = false, cls = '' } = {}) {
  const b = el('button', { class: 'cmd' + (iconOnly ? ' icon-only' : '') + (disabled ? ' disabled' : '') + (on ? ' on' : '') + (cls ? ' ' + cls : ''), title: title || label },
    iconName ? el('span', { html: icon(iconName) }) : null,
    !iconOnly ? el('span', { text: label }) : null,
    caret ? el('span', { class: 'caret', html: icon('chevronDown', 12) }) : null);
  b.addEventListener('click', (e) => { if (!disabled) action(e, b); });
  return b;
}

function renderCommandBar() {
  const t = app.tab();
  const sel = app.selectedItems();
  const fs = isFsPath(t.loc) && !t.search;
  const noDrive = sel.length && !sel.some((i) => i.drive);
  const targets = statusTargets();
  const curStatus = targets.length && targets.every((x) => x.st === targets[0].st) && targets[0].st ? app.statusByKey(targets[0].st) : null;
  const v = app.viewSettings();
  const bar = $('#commandbar');
  const statusHere = statusAvailableHere();
  const statusBtn = cmd(curStatus ? curStatus.label : 'Status', null, (e, b) => showMenuAt(statusSubmenu(statusTargets()), b), { caret: true, disabled: !targets.length, title: 'Set a status color (Alt+1…4)' });
  statusBtn.prepend(el('i', { class: 'status-swatch', style: { background: curStatus ? curStatus.color : 'transparent', boxShadow: curStatus ? '' : 'inset 0 0 0 1.5px currentColor' } }));
  bar.replaceChildren(...[
    cmd('New', 'plus', (e, b) => showMenuAt([{ label: 'Folder', icon: 'newFolder', key: 'Ctrl+Shift+N', action: newFolder }, { label: 'Text document', icon: 'doc', action: newFile }], b), { caret: true, disabled: !fs }),
    el('div', { class: 'cmd-sep' }),
    cmd('Cut (Ctrl+X)', 'cut', () => copySel(true), { iconOnly: true, disabled: !noDrive }),
    cmd('Copy (Ctrl+C)', 'copy', () => copySel(false), { iconOnly: true, disabled: !noDrive }),
    cmd('Paste (Ctrl+V)', 'paste', () => paste(), { iconOnly: true, disabled: !fs }),
    cmd('Rename (F2)', 'rename', () => sel[0] && view.startRename(sel[0].p), { iconOnly: true, disabled: sel.length !== 1 || !!sel[0].drive }),
    cmd('Delete (Del)', 'trash', () => del(false), { iconOnly: true, disabled: !noDrive }),
    el('div', { class: 'cmd-sep' }),
    statusHere ? statusBtn : null,
    statusHere ? el('div', { class: 'cmd-sep' }) : null,
    cmd('Sort', 'sort', (e, b) => showMenuAt(sortSubmenu(), b), { caret: true }),
    cmd('View', v.mode === 'details' ? 'details' : 'view', (e, b) => showMenuAt(viewSubmenu(), b), { caret: true }),
    cmd('More', 'more', (e, b) => showMenuAt([
      { label: 'Select all', key: 'Ctrl+A', action: selectAll },
      { label: 'Select none', action: () => { t.sel = new Set(); app.selectionChanged(); } },
      { label: 'Invert selection', action: () => { t.sel = new Set(t.view.filter((i) => !t.sel.has(i.p)).map((i) => i.p)); app.selectionChanged(); } },
      '-',
      { label: 'Copy path', icon: 'link', action: () => app.copyPaths(sel.length ? sel : [{ p: t.loc }]), disabled: !isFsPath(t.loc) },
      { label: 'Open in Terminal', icon: 'terminal', action: () => api.terminal(t.loc), disabled: !isFsPath(t.loc) },
      { label: 'Properties', icon: 'info', key: 'Alt+Enter', action: () => api.properties(sel.length ? sel.map((i) => i.p) : [t.loc]), disabled: !isFsPath(t.loc) && !sel.length },
    ], b), { iconOnly: true }),
    el('div', { class: 'cmd-spacer' }),
    cmd('Keep tabs', 'pin', () => { app.setViewFlag('restoreTabs', !state.settings.view.restoreTabs); toast(state.settings.view.restoreTabs ? 'Your tabs will be here next time you open Foldernator.' : 'Foldernator will start fresh at Home next time.', 'ok'); }, { iconOnly: true, cls: 'keep-tabs', on: !!state.settings.view.restoreTabs, title: state.settings.view.restoreTabs ? 'Keep tabs: ON — closing and reopening Foldernator brings back these tabs. Click to turn off.' : 'Keep tabs: OFF — Foldernator starts fresh at Home. Click to keep these tabs for next time.' }),
    cmd('Refresh', 'refresh', () => reloadUi(), { iconOnly: true, title: 'Refresh the interface — everything stays as it is (Ctrl+Shift+R)' }),
    cmd('Preview', 'preview', () => app.setViewFlag('previewPane', !state.settings.view.previewPane), { on: state.settings.view.previewPane, title: 'Preview pane (Alt+P)' }),
    resolveTheme(state.settings).material === 'liquid'
      ? cmd('Live glass', 'eye', () => app.toggleLiveGlass(), { iconOnly: true, on: liveGlassOn(), title: liveGlassOn() ? 'Live glass ON — hidden from screenshots. Click to freeze it for a screenshot (Ctrl+Shift+L)' : glassFrozen() ? 'Glass frozen — screenshots work. Click to go live again (Ctrl+Shift+L)' : 'Live glass off. Click to turn on (Ctrl+Shift+L)' })
      : null,
    state.updateReady ? cmd('Restart', 'refresh', () => api.relaunch(), { on: true, title: 'Foldernator was updated — restart to load it (your tabs come back)' }) : null,
    cmd('Settings', 'gear', () => openSettings(app), { iconOnly: true, title: 'Settings (Ctrl+,)' }),
  ].filter(Boolean));
  $('#addressbar [data-cmd="back"]').disabled = t.hi <= 0;
  $('#addressbar [data-cmd="forward"]').disabled = t.hi >= t.history.length - 1;
  $('#addressbar [data-cmd="up"]').disabled = t.loc === 'thispc';
}

function renderStatusbar() {
  const t = app.tab();
  const sel = app.selectedItems();
  const bar = $('#statusbar');
  const parts = [el('span', { text: `${t.view.length.toLocaleString()} item${t.view.length === 1 ? '' : 's'}` })];
  if (sel.length) {
    const size = sel.filter((i) => !i.d).reduce((s, i) => s + (i.s || 0), 0);
    parts.push(el('span', { text: `${sel.length.toLocaleString()} selected${size ? '  ' + fmtSize(size) : ''}` }));
  }
  const di = t.driveInfo;
  if (di && !t.search) {
    const txt = di.loading ? (di.total ? `Checking Google Drive (every file)… ${di.done}/${di.total} folders` : 'Checking Google Drive (every file)…')
      : di.error ? 'Drive check failed'
        : !di.exists ? 'This folder isn’t on Google Drive'
          : (di.missing || di.partial) ? `Drive: ${di.ok} complete · ${di.partial} partial · ${di.missing} not uploaded` : `Everything here is on Google Drive (${(di.files || 0).toLocaleString()} files checked)`;
    parts.push(el('span', { class: 'sb-drive', title: di.remote || di.error || '', html: `${icon('cloud', 13)}<span>${txt}</span>` }));
  }
  if (t.search) parts.push(el('span', { text: t.search.running ? `Searching… ${t.search.scanned.toLocaleString()} scanned` : `Search finished · ${t.search.scanned.toLocaleString()} scanned` }));
  const v = app.viewSettings();
  const det = el('button', { class: 'sb-btn' + (v.mode === 'details' ? ' on' : ''), title: 'Details', html: icon('details', 14), onclick: () => setViewMode('details') });
  const big = el('button', { class: 'sb-btn' + (v.mode === 'icons' ? ' on' : ''), title: 'Large icons', html: icon('view', 14), onclick: () => setViewMode('icons', 'large') });
  bar.replaceChildren(...parts, el('div', { class: 'grow' }), det, big);
}

function renderBanner() {
  const content = $('#content');
  const old = content.querySelector('.view-banner');
  const t = app.tab();
  if (!t.search) { if (old) old.remove(); return; }
  const s = t.search;
  const b = el('div', { class: 'view-banner' },
    s.running ? el('div', { class: 'spinner' }) : el('span', { html: icon('search', 14) }),
    el('span', { class: 'grow', text: `${s.running ? 'Searching' : 'Results'} for “${s.query}” in ${titleFor(s.root)} — ${s.items.length.toLocaleString()}${s.capped ? '+' : ''} found${s.indexed ? ` · ${s.ms} ms` : ''}` }),
    s.running ? el('button', { text: 'Stop', onclick: () => { api.searchCancel(s.sid); } }) : null,
    el('button', { text: 'Close search', onclick: () => clearSearch() }));
  if (old) old.replaceWith(b); else content.prepend(b);
}

function renderChrome() {
  renderTabs();
  renderCrumbs();
  renderCommandBar();
  renderStatusbar();
  renderBanner();
  sidebar.render();
  const t = app.tab();
  $('#search-input').placeholder = `Search ${titleFor(t.loc)}`;
}

// ---------- search ----------
const searchInput = () => $('#search-input');

// Instant search: as you type (2+ letters), the index answers for everything inside this folder — sub-folders
// included — in milliseconds. Folders the index doesn't cover fall back to filtering what's on screen; Enter
// still runs the classic deep scan there.
let ixTimer = 0, ixToken = 0;
// ---------- suggestions while typing (the index answers in a few ms; only ~10 rows are drawn) ----------
let sugToken = 0, sugTimer = 0, sugItems = [], sugSel = -1;
const sugBox = () => $('#suggest');
function hideSuggest() { sugItems = []; sugSel = -1; const b = sugBox(); if (b) { b.classList.remove('on'); b.replaceChildren(); } }
function suggestSoon(q) {
  clearTimeout(sugTimer);
  if (q.length < 2) { hideSuggest(); return; }
  sugTimer = setTimeout(() => showSuggest(q), 60);
}
async function showSuggest(q) {
  const t = app.tab();
  const token = ++sugToken;
  const here = isFsPath(t.loc) ? t.loc : null;
  let res;
  try { res = await api.indexSearch({ q, under: null, prefer: here, max: 10, statLimit: 0 }); } catch { return; }
  if (token !== sugToken || searchInput().value.trim() !== q || document.activeElement !== searchInput()) return;
  sugItems = res.items || []; sugSel = -1;
  const b = sugBox();
  if (!sugItems.length) { b.classList.remove('on'); b.replaceChildren(); return; }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mark = (name) => { // bold the typed letters
    const low = name.toLowerCase(); const on = new Array(name.length).fill(false);
    for (const w of words) { const i = low.indexOf(w); if (i >= 0) for (let k = i; k < i + w.length; k++) on[k] = true; }
    let html = '', open = false;
    for (let k = 0; k < name.length; k++) { if (on[k] !== open) { html += on[k] ? '<b>' : '</b>'; open = on[k]; } html += name[k].replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    return html + (open ? '</b>' : '');
  };
  b.replaceChildren(...sugItems.map((it, i) => {
    const dirPath = it.p.slice(0, it.p.length - it.n.length).replace(/\\$/, '');
    const row = el('div', { class: 'sg-row', role: 'option', dataset: { i: String(i) } },
      el('span', { class: 'sg-ic', html: it.d ? folderSvg(app.themeFolder(), { size: 18 }) : `<img src="ficon://f/?p=${encodeURIComponent(it.p)}&s=normal" alt="">` }),
      el('span', { class: 'sg-text' }, el('span', { class: 'sg-name', html: mark(it.n) }), el('span', { class: 'sg-path', text: dirPath })));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggest(i); });
    row.addEventListener('mousemove', () => setSugSel(i));
    return row;
  }), el('div', { class: 'sg-foot', text: `Enter: all results · ↑↓ choose · ${res.ms} ms` }));
  b.classList.add('on');
}
function setSugSel(i) { sugSel = i; sugBox().querySelectorAll('.sg-row').forEach((r, k) => r.classList.toggle('sel', k === i)); }
// A folder opens; a file opens its folder with the file selected.
async function pickSuggest(i) {
  const it = sugItems[i]; if (!it) return;
  hideSuggest();
  searchInput().value = ''; $('#search').classList.remove('has-value');
  const t = app.tab(); t.filter = ''; if (t.search) cancelSearch(t, false);
  if (it.d) { navigate(it.p); return; }
  await navigate(parentOf(it.p), { select: it.p });
  app.revealInView(it.p);
  view.root.focus();
}
app.suggest = { show: showSuggest, pick: pickSuggest, items: () => sugItems };

async function indexSearch(q, { fromEnter = false } = {}) {
  const t = app.tab();
  const under = t.search && t.search.indexed ? t.search.root : t.loc;
  if (!(isFsPath(under) || under === 'thispc')) return false;
  const token = ++ixToken;
  let res;
  try { res = await api.indexSearch({ q, under: under === 'thispc' ? null : under }); } catch { return false; }
  if (token !== ixToken || app.tab() !== t) return true;
  if (!res.indexed) return false;
  if (!fromEnter && searchInput().value.trim() !== q) return true;
  t.search = { sid: 'ix' + token, query: q, root: under, items: res.items, running: false, scanned: 0, capped: !!res.capped, indexed: true, ms: res.ms };
  t.filter = '';
  computeView(t);
  view.render({ keepScroll: false });
  renderBanner(); renderStatusbar();
  return true;
}

function onSearchInput() {
  const t = app.tab();
  const v = searchInput().value;
  $('#search').classList.toggle('has-value', !!v);
  clearTimeout(ixTimer);
  suggestSoon(v.trim());
  if (t.search && t.search.indexed && !v.trim()) { ixToken++; cancelSearch(t, false); }
  if (t.search && !t.search.running && v !== t.search.query) cancelSearch(t, false);
  t.filter = t.search ? '' : v;
  computeView(t);
  view.render({ keepScroll: false });
  renderStatusbar();
}

async function startSearch(q) {
  const t = app.tab();
  q = (q || '').trim();
  if (!q) return;
  if (await indexSearch(q, { fromEnter: true })) return; // the index covers it: instant
  if (!isFsPath(t.loc) && !(t.search && isFsPath(t.search.root))) { toast('Open a folder or drive to search inside it.', 'warn'); return; }
  const root = t.search ? t.search.root : t.loc;
  if (t.search && t.search.running) api.searchCancel(t.search.sid);
  const sid = 's' + Date.now();
  t.search = { sid, query: q, root, items: [], running: true, scanned: 0, capped: false };
  t.filter = '';
  t.sel = new Set();
  computeView(t);
  view.render({ keepScroll: false });
  renderBanner();
  renderStatusbar();
  api.searchStart({ sid, root, query: q, hidden: state.settings.view.showHidden });
}

function cancelSearch(t, rerender = true) {
  if (!t.search) return;
  if (t.search.running) api.searchCancel(t.search.sid);
  t.search = null;
  if (rerender) { computeView(t); view.render({ keepScroll: false }); renderBanner(); renderStatusbar(); renderCommandBar(); }
}

function clearSearch() {
  const t = app.tab();
  searchInput().value = '';
  $('#search').classList.remove('has-value');
  t.filter = '';
  cancelSearch(t, false);
  computeView(t);
  view.render({ keepScroll: false });
  renderBanner();
  renderStatusbar();
  renderCommandBar();
}

function onSearchBatch(m) {
  const g = state.tabs.find((x) => x.scan && x.scan.sid === m.sid);
  if (g) {
    if (g.loc !== 'gallery') return;
    g.items.push(...m.items);
    if (!g.scanTimer) g.scanTimer = setTimeout(() => {
      g.scanTimer = 0;
      computeView(g);
      if (g === app.tab()) { view.render({ keepScroll: true }); renderStatusbar(); }
    }, 250);
    return;
  }
  const t = state.tabs.find((x) => x.search && x.search.sid === m.sid);
  if (!t) return;
  t.search.items.push(...m.items);
  t.search.scanned = m.scanned;
  // Per tab: one shared timer would drop renders for a second tab searching at the same time.
  if (t.searchTimer) return;
  t.searchTimer = setTimeout(() => {
    t.searchTimer = 0;
    if (!t.search) return;
    computeView(t);
    if (t === app.tab()) { view.render({ keepScroll: true }); renderBanner(); renderStatusbar(); }
  }, 180);
}

function onSearchDone(m) {
  const g = state.tabs.find((x) => x.scan && x.scan.sid === m.sid);
  if (g) {
    g.scan.running = false;
    clearTimeout(g.scanTimer); g.scanTimer = 0;
    computeView(g);
    if (g === app.tab()) { view.render({ keepScroll: true }); renderStatusbar(); }
    return;
  }
  const t = state.tabs.find((x) => x.search && x.search.sid === m.sid);
  if (!t) return;
  t.search.running = false;
  t.search.scanned = m.scanned;
  t.search.capped = m.capped;
  computeView(t);
  if (t === app.tab()) { view.render({ keepScroll: true }); renderBanner(); renderStatusbar(); }
}

// ---------- keyboard ----------
let typeBuf = '', typeTimer = 0;

function selectAll() { const t = app.tab(); t.sel = new Set(t.view.map((i) => i.p)); app.selectionChanged(); }

function moveFocus(delta, { shift = false, ctrl = false, abs = null } = {}) {
  const t = app.tab();
  if (!t.view.length) return;
  let i = t.focus != null && t.index.has(t.focus) ? t.index.get(t.focus) : -1;
  let n = abs != null ? abs : i < 0 ? 0 : i + delta;
  n = Math.max(0, Math.min(t.view.length - 1, n));
  const p = t.view[n].p;
  t.focus = p;
  if (shift) app.selectRange(t.anchor || p, p, ctrl);
  else if (!ctrl) { t.sel = new Set([p]); t.anchor = p; }
  view.ensureVisible(n);
  app.selectionChanged();
}

function typeAhead(ch) {
  const t = app.tab();
  clearTimeout(typeTimer);
  typeBuf += ch.toLowerCase();
  typeTimer = setTimeout(() => { typeBuf = ''; }, 900);
  const start = t.focus && t.index.has(t.focus) ? t.index.get(t.focus) : -1;
  const same = typeBuf.split('').every((c) => c === typeBuf[0]);
  const needle = same ? typeBuf[0] : typeBuf;
  const from = same || typeBuf.length === 1 ? start + 1 : Math.max(0, start);
  const list = t.view;
  for (let k = 0; k < list.length; k++) {
    const i = (from + k) % list.length;
    if ((list[i].label || list[i].n).toLowerCase().startsWith(needle)) { moveFocus(0, { abs: i }); return; }
  }
}

// macOS: the Mac versions of the shortcuts are re-sent as the Windows ones, so every command keeps one code path.
// ⌘X/⌘C/⌘V/⌘A… → Ctrl, ⌘I → Get Info, ⌘⌫ → Move to Trash, ⌘↑ → up a folder, ⌘↓ → open. Text boxes keep their own ⌘ keys.
function macKeys(e) {
  if (e.__mac || !e.metaKey || e.ctrlKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const map = { Backspace: { key: 'Delete' }, i: { key: 'Enter', altKey: true }, I: { key: 'Enter', altKey: true }, ArrowUp: { key: 'ArrowUp', altKey: true }, ArrowDown: { key: 'Enter' } }[e.key]
    || { key: e.key, ctrlKey: true };
  e.preventDefault(); e.stopImmediatePropagation();
  const ev = new KeyboardEvent('keydown', { key: map.key, code: e.code, ctrlKey: !!map.ctrlKey, altKey: !!map.altKey, shiftKey: e.shiftKey, metaKey: false, bubbles: true, cancelable: true });
  ev.__mac = true;
  (t || document).dispatchEvent(ev);
}

function onKeyDown(e) {
  if (document.querySelector('#modal-root > *')) return;
  if (menuOpen()) return;
  const inField = e.target.matches('input, textarea, select');
  const k = e.key;
  const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
  const t = app.tab();

  // Global shortcuts (also inside fields)
  if (ctrl && !alt && (k === 't' || k === 'T')) { e.preventDefault(); return newTab('home', { end: true }); }
  if (ctrl && !alt && (k === 'w' || k === 'W')) { e.preventDefault(); return closeTab(state.active); }
  if (ctrl && k === 'Tab') { e.preventDefault(); return switchTab((state.active + (shift ? -1 : 1) + state.tabs.length) % state.tabs.length); }
  if (ctrl && !shift && !alt && /^[1-9]$/.test(k)) { e.preventDefault(); return switchTab(k === '9' ? state.tabs.length - 1 : +k - 1); }
  if (ctrl && shift && (k === 'l' || k === 'L')) { e.preventDefault(); return app.toggleLiveGlass(); }
  if ((ctrl && !shift && (k === 'l' || k === 'L')) || (alt && (k === 'd' || k === 'D')) || k === 'F4') { e.preventDefault(); return editAddress(); }
  if (ctrl && shift && (k === 'e' || k === 'E')) { e.preventDefault(); return layout.set({ sidebar: layout.cfg.sidebar === 'hidden' ? 'left' : 'hidden' }); }
  if ((ctrl && (k === 'f' || k === 'F' || k === 'e' || k === 'E')) || k === 'F3') { e.preventDefault(); searchInput().focus(); searchInput().select(); return; }
  if (ctrl && k === ',') { e.preventDefault(); return openSettings(app); }
  if (k === 'F12') { e.preventDefault(); return api.devtools(); }
  if (k === 'F11') { e.preventDefault(); return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); }
  if (ctrl && !shift && !alt && (k === 'n' || k === 'N')) { e.preventDefault(); return newTab(app.tab().loc, { end: true }); }
  if (alt && k === 'ArrowLeft') { e.preventDefault(); return back(); }
  if (alt && k === 'ArrowRight') { e.preventDefault(); return forward(); }
  if (alt && k === 'ArrowUp') { e.preventDefault(); return up(); }
  if (ctrl && shift && (k === 'r' || k === 'R')) { e.preventDefault(); return reloadUi(); }
  if (k === 'F5' || (ctrl && (k === 'r' || k === 'R'))) { e.preventDefault(); return refresh(); }
  if (alt && (k === 'p' || k === 'P')) { e.preventDefault(); return app.setViewFlag('previewPane', !state.settings.view.previewPane); }
  if (inField) return;

  if (ctrl && (k === 'h' || k === 'H')) { e.preventDefault(); return app.setViewFlag('showHidden', !state.settings.view.showHidden); }
  if (ctrl && shift && /^Digit[1-8]$/.test(e.code)) {
    e.preventDefault();
    const n = +e.code.slice(5);
    if (n === 1) return setViewMode('icons', 'xl');
    if (n === 2) return setViewMode('icons', 'large');
    if (n === 3 || n === 4) return setViewMode('icons', 'medium');
    return setViewMode('details');
  }
  if (alt && /^Digit[0-9]$/.test(e.code)) {
    e.preventDefault();
    const n = e.code.slice(5);
    if (n === '0') { if (statusTargets().length) return setStatus(null, null); return; }
    const st = state.settings.statuses.find((s) => s.hotkey === n);
    if (st) return setStatus(st.key, null);
    return;
  }
  if (alt && k === 'Enter') { e.preventDefault(); const sel = app.selectedItems(); return api.properties(sel.length ? sel.map((i) => i.p) : [t.loc]); }
  if (ctrl && !shift && !alt && (k === 'i' || k === 'I')) {
    e.preventDefault();
    const sel = app.selectedItems();
    if (sel.length === 1 && isMediaFile(sel[0])) return openMediaDetails(app, sel[0].p);
    return toast('Select one video or audio file to see its media details (Ctrl+I).', 'info');
  }
  if (shift && k === 'F10') { e.preventDefault(); return nativeMenu(); }
  if (k === 'ContextMenu') {
    e.preventDefault();
    const n = view.nodes.get(t.focus);
    const r = n ? n.getBoundingClientRect() : view.root.getBoundingClientRect();
    return app.selectedItems().length ? app.itemMenu(r.left + 30, r.top + r.height / 2) : app.backgroundMenu(r.left + 30, r.top + 30);
  }
  if (ctrl && shift && (k === 'n' || k === 'N')) { e.preventDefault(); return newFolder(); }
  if (ctrl && shift && (k === 'c' || k === 'C')) { e.preventDefault(); const sel = app.selectedItems(); return sel.length && app.copyPaths(sel); }
  if (ctrl && (k === 'a' || k === 'A')) { e.preventDefault(); return selectAll(); }
  if (ctrl && (k === 'c' || k === 'C')) { e.preventDefault(); return copySel(false); }
  if (ctrl && (k === 'x' || k === 'X')) { e.preventDefault(); return copySel(true); }
  if (ctrl && (k === 'v' || k === 'V')) { e.preventDefault(); return paste(); }
  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); return undo(); }
  if (k === 'F2') { e.preventDefault(); const s = app.selectedItems(); if (s.length === 1 && !s[0].drive) view.startRename(s[0].p); return; }
  if (k === 'Delete') { e.preventDefault(); return del(shift); }
  // Windows Explorer extras: Ctrl+D recycles, Ctrl+N opens this folder again (Foldernator: in a new tab), F11 full screen.
  if (ctrl && !shift && (k === 'd' || k === 'D')) { e.preventDefault(); return del(false); }
  if (k === 'Enter') { e.preventDefault(); return openItems(app.selectedItems(), { inNewTab: ctrl }); }
  if (k === 'Backspace') { e.preventDefault(); return back(); }
  if (k === 'Escape') {
    if (t.search || t.filter) return clearSearch();
    if (state.clip && state.clip.cut) { state.clip = null; view.updateSelection(); return; }
    t.sel = new Set(); return app.selectionChanged();
  }
  const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  if (dirs[k]) { e.preventDefault(); const d = view.step(dirs[k]); if (d) moveFocus(d, { shift, ctrl }); return; }
  if (k === 'Home') { e.preventDefault(); return moveFocus(0, { abs: 0, shift, ctrl }); }
  if (k === 'End') { e.preventDefault(); return moveFocus(0, { abs: t.view.length - 1, shift, ctrl }); }
  if (k === 'PageDown') { e.preventDefault(); return moveFocus(view.pageSize(), { shift, ctrl }); }
  if (k === 'PageUp') { e.preventDefault(); return moveFocus(-view.pageSize(), { shift, ctrl }); }
  if (k === ' ' && ctrl && t.focus) { e.preventDefault(); if (t.sel.has(t.focus)) t.sel.delete(t.focus); else t.sel.add(t.focus); return app.selectionChanged(); }
  if (k === ' ' && !ctrl && !alt && !typeBuf) {
    const sel = app.selectedItems();
    if (sel.length === 1 && isViewable(sel[0])) { e.preventDefault(); return openItems(sel); }
    // Space on a video: theater over the file area (continues from the preview player if it's there)
    if (sel.length === 1 && !sel[0].d && ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ogv'].includes(extOf(sel[0].n))) { e.preventDefault(); const pv = document.querySelector('#preview .pv-video video'); if (pv) pv.pause(); return openTheater(sel[0].p, { time: pv ? pv.currentTime : 0, name: sel[0].n, from: pv }); }
  }
  if (k.length === 1 && !ctrl && !alt && !e.metaKey) { e.preventDefault(); typeAhead(k); }
}

// ---------- misc ----------
function sessionNow() {
  const tabs = state.tabs.map((t) => t.loc);
  // Each tab's back/forward history travels with it, so "Restart now" doesn't wipe where you came from.
  const history = state.tabs.map((t) => { const from = Math.max(0, t.hi - 49); return { list: t.history.slice(from, from + 100), hi: t.hi - from }; });
  return { tabs, active: state.active, history };
}
const saveSession = debounce(() => api.patchSettings({ session: sessionNow() }), 400);

// Refresh button: reloads the whole interface (a visual glitch goes away) and comes back exactly as it was —
// same tabs, same folders, same back history.
async function reloadUi() {
  await api.patchSettings({ session: sessionNow() });
  const u = new URL(location.href);
  u.searchParams.delete('open');
  u.searchParams.set('restore', '1');
  location.replace(u.toString());
}
app.reloadUi = reloadUi;

function updateWatch() {
  const dirs = [...new Set(state.tabs.map((t) => t.loc).filter(isFsPath))];
  api.watch(dirs);
}

async function refreshDrives() {
  try {
    const pd = await api.portable().catch(() => null);
    if (pd) { const sigP = (x) => (x || []).map((i) => i.path).join("|"); const changed = sigP(pd) !== sigP(state.portable); state.portable = pd.map((x) => ({ ...x, label: x.name })); for (const x of pd) { state.names.set(x.path, x.name); state.parents.set(x.path, "thispc"); } if (changed) { sidebar.children.delete("thispc"); sidebar.render(); } }
    const d = await api.drives();
    const sig = (x) => x.map((i) => `${i.path}${i.ready}${i.label}${Math.round((i.free || 0) / 1e8)}`).join('|');
    if (sig(d) !== sig(state.drives)) {
      state.drives = d;
      sidebar.render();
      if (app.tab().loc === 'thispc') load(app.tab(), { keep: true });
    }
  } catch {}
}

app.setTheme = (id) => {
  state.settings.themeId = id;
  api.patchSettings({ themeId: id });
  applyTheme(resolveTheme(state.settings));
  view.render({ keepScroll: true });
  sidebar.render();
  renderTabs();
};

const saveThemeSoon = debounce((custom, id) => api.patchSettings({ customThemes: custom, themeId: id }), 300);
app.editTheme = (patch) => {
  const s = state.settings;
  let id = s.themeId;
  let theme = resolveTheme(s);
  if (!id.startsWith('custom-')) {
    id = 'custom-' + Date.now().toString(36);
    theme = { ...theme, name: theme.name + ' (custom)' };
  }
  theme = { ...theme, ...patch };
  s.customThemes = { ...(s.customThemes || {}), [id]: theme };
  s.themeId = id;
  applyTheme(theme);
  if ('folder' in patch || 'density' in patch || 'fontSize' in patch) { view.render({ keepScroll: true }); sidebar.render(); }
  saveThemeSoon(s.customThemes, id);
};

app.resetToDefaults = async () => {
  const ok = await confirmDialog({
    title: 'Restore default settings?',
    text: 'Theme, layout, views, columns, status colors, status folders and Google Drive mapping go back to how they shipped. Your pinned folders, saved themes and the statuses already set on folders are kept.',
    ok: 'Restore defaults',
  });
  if (!ok) return;
  await setLiveGlass(false);
  await api.resetSettings();
  location.reload();
};

// Live glass hides the window from screenshots. Freezing keeps the exact glass look on screen but stops
// capturing, so screenshots and recordings show the app; unfreeze to go live again.
app.toggleLiveGlass = async () => {
  if (resolveTheme(state.settings).material !== 'liquid') return;
  if (glassFrozen()) {
    const on = await unfreezeGlass();
    toast(on ? 'Live glass back on (hidden from screenshots while live)' : 'Live glass couldn’t start', on ? 'ok' : 'err', { id: 'live', ms: 3000 });
  } else if (liveGlassOn()) {
    await freezeGlass();
    toast('Glass frozen — screenshots and recordings show the app now. Ctrl+Shift+L to go live again.', 'info', { id: 'live', ms: 4500 });
  } else {
    const on = await setLiveGlass(true);
    toast(on ? 'Live glass on' : 'Live glass couldn’t start', on ? 'ok' : 'err', { id: 'live', ms: 3000 });
  }
  renderCommandBar();
};

// Icon styles (Settings → Icons): re-render everything that draws icons.
app.setIconStyle = async (patchObj) => {
  const next = { ...(state.settings.icons || {}), ...patchObj };
  state.settings.icons = next;
  api.patchSettings({ icons: next });
  setIconStyles(next);
  paintStaticIcons();
  layout.buildHeads();
  renderChrome();
  view.render({ keepScroll: true });
  preview.current = null; showPreview();
};

// Colored folders in Windows Explorer keep the icon they got when colored; this re-applies them in the
// current folder style (local desktop.ini only — Drive colors don't change).
app.restyleColoredFolders = async () => {
  const groups = new Map();
  for (const e of Object.values(state.settings.statusIndex || {})) {
    if (!e.color && !e.status) continue;
    const st = e.status && app.statusByKey(e.status);
    const color = (st && st.color) || e.color;
    if (!color) continue;
    const k = (e.status || '') + '|' + color;
    if (!groups.has(k)) groups.set(k, { status: e.status || null, color, paths: [] });
    groups.get(k).paths.push(e.path);
  }
  let n = 0;
  for (const g of groups.values()) {
    await ensureIcon(g.color);
    const { results, statusIndex } = await api.setStatus({ paths: g.paths, status: g.status, color: g.color, skipDrive: true, iconStyle: iconStyles.folder });
    state.settings.statusIndex = statusIndex;
    n += results.filter((r) => r.ok).length;
  }
  toast(`${n} colored folder${n === 1 ? '' : 's'} updated in Windows Explorer`, 'ok');
  return n;
};

app.setMotion = (n) => {
  state.settings.motion = setMotionLevel(n);
  api.patchSettings({ motion: state.settings.motion });
};

app.saveStatuses = async (list) => {
  state.settings = await api.setSetting('statuses', list);
  for (const st of list) ensureIcon(st.color);
  for (const t of state.tabs) computeView(t);
  view.render({ keepScroll: true });
  renderChrome();
};

function paintStaticIcons() {
  $('#new-tab').innerHTML = icon('plus');
  $('#search .search-icon').innerHTML = icon('search', 14);
  $('#search-clear').innerHTML = icon('close', 12);
  const navIcons = { back: 'back', forward: 'forward', up: 'up', refresh: 'refresh' };
  document.querySelectorAll('#addressbar [data-cmd]').forEach((b) => { b.innerHTML = icon(navIcons[b.dataset.cmd]); });
}

// ---------- boot ----------
async function boot() {
  const init = await api.init();
  state.settings = init.settings;
  state.palette = init.palette;
  state.paths = init.paths;
  initGlass();
  initLiveGlass();
  setMotionLevel(state.settings.motion ?? 2);
  applyTheme(resolveTheme(state.settings));
  document.body.classList.toggle('preview-on', !!state.settings.view.previewPane);
  try { state.drives = await api.drives(); } catch { state.drives = []; }

  view = new FileView($('#view'), app);
  sidebar = new Sidebar($('#sidebar'), app);
  preview = new Preview($('#preview .pv-scroll'), app);
  layout = new Layout(app);
  layout.apply();
  app.view = view;
  app.layout = layout;
  if (!state.settings.pinsImported) {
    try { await app.importWindowsPins(true); } catch { state.settings.pinsImported = true; }
  }

  setIconStyles(state.settings.icons || {});
  paintStaticIcons();
  $('#new-tab').addEventListener('click', () => newTab('home', { end: true }));
  $('#tabs').addEventListener('wheel', (e) => { const h = e.currentTarget; if (h.scrollWidth > h.clientWidth) { h.scrollLeft += e.deltaY || e.deltaX; e.preventDefault(); } }, { passive: false });
  $('#search-clear').addEventListener('click', () => { clearSearch(); view.root.focus(); });
  document.querySelectorAll('#addressbar [data-cmd]').forEach((b) => {
    b.addEventListener('click', () => ({ back, forward, up, refresh })[b.dataset.cmd]());
  });
  searchInput().addEventListener('input', onSearchInput);
  searchInput().addEventListener('blur', () => setTimeout(hideSuggest, 120));
  searchInput().addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && sugItems.length) { e.preventDefault(); setSugSel(Math.min(sugItems.length - 1, sugSel + 1)); return; }
    if (e.key === 'ArrowUp' && sugItems.length) { e.preventDefault(); setSugSel(Math.max(-1, sugSel - 1)); return; }
    if (e.key === 'Enter' && sugSel >= 0) { e.preventDefault(); pickSuggest(sugSel); return; }
    if (e.key === 'Escape' && sugItems.length) { e.preventDefault(); hideSuggest(); return; }
    if (e.key === 'Enter') { e.preventDefault(); hideSuggest(); startSearch(searchInput().value); }
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); view.root.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); view.root.focus(); moveFocus(0, { abs: 0 }); }
  });

  const params = new URLSearchParams(location.search);
  const open = params.get('open') ? JSON.parse(params.get('open')) : null;
  const session = state.settings.session || {};
  const restore = params.get('restore') === '1' || !!state.settings.view.restoreTabs;
  const locs = open && open.length ? open : (restore && session.tabs && session.tabs.length ? session.tabs : ['home']);
  state.tabs = locs.map((l) => makeTab(l));
  if (locs === session.tabs && Array.isArray(session.history)) {
    state.tabs.forEach((t, i) => {
      const h = session.history[i];
      if (h && Array.isArray(h.list) && h.list[h.hi] === t.loc) { t.history = h.list; t.hi = h.hi; }
    });
  }
  state.active = open && open.length ? 0 : restore ? Math.min(session.active || 0, state.tabs.length - 1) : 0;

  if (IS_MAC) document.addEventListener('keydown', macKeys, true); // ⌘ shortcuts → the same commands as Ctrl
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mouseup', (e) => { if (e.button === 3) back(); if (e.button === 4) forward(); });
  view.root.addEventListener('focus', () => view.updateSelection());
  view.root.addEventListener('blur', () => view.updateSelection());
  window.addEventListener('focus', () => refreshDrives());
  api.onDrivesChanged(({ drives, portable, added, removed }) => {
    state.drives = drives;
    state.portable = portable || [];
    for (const d of state.portable) { state.names.set(d.path, d.label); state.parents.set(d.path, 'thispc'); }
    sidebar.children.delete('thispc');
    sidebar.render();
    if (app.tab().loc === 'thispc') load(app.tab(), { keep: true });
    const name = (d) => (d.portable ? d.label : `${d.label || (d.type === 'Removable' ? 'USB Drive' : 'Drive')} (${d.path.slice(0, 2)})`);
    for (const d of added) toast(`${name(d)} connected`, 'ok', { id: 'dev-' + d.path, action: { label: 'Open', onClick: () => navigate(d.path) } });
    for (const d of removed) toast(`${name(d)} removed`, 'info');
  });
  window.addEventListener('liveglass', () => renderCommandBar());
  const crumbsResize = debounce(() => renderCrumbs(), 80);
  new ResizeObserver(crumbsResize).observe($('#crumbs'));
  if (new URLSearchParams(location.search).get('qa')) document.documentElement.dataset.qa = '1';

  // A folder changed on disk: re-list it — only in the tab you're looking at (hidden tabs catch up when
  // shown), and a big folder that keeps changing (a render or download writing into it) at most every few
  // seconds, so re-listing thousands of files doesn't eat the app.
  api.onChanged((dir) => {
    for (const t of state.tabs) {
      if (t.search || t.loc.toLowerCase() !== dir.toLowerCase()) continue;
      if (t !== app.tab()) { t.stale = true; continue; }
      const gap = (t.items || []).length > 3000 ? 3000 : 0, wait = (t.watchAt || 0) + gap - Date.now();
      clearTimeout(t.watchTimer);
      const go = () => { t.watchAt = Date.now(); t.watchTimer = 0; load(t, { keep: true }); };
      if (wait > 0) t.watchTimer = setTimeout(go, wait); else go();
    }
    sidebar.invalidate(dir);
  });
  api.onSearchBatch(onSearchBatch);
  api.onDriveItem(onDriveItem);
  api.onDriveProgress(onDriveProgress);
  api.onDriveDone(onDriveDone);
  api.onSearchDone(onSearchDone);
  api.onToast((m) => toast(m.text, m.kind, { id: m.id }));
  // An update waits behind a toast AND a Restart button in the command bar (the toast is easy to click away).
  api.onUpdateReady(() => { state.updateReady = true; renderCommandBar(); toast('Foldernator was updated.', 'ok', { id: 'update', action: { label: 'Restart now', onClick: () => api.relaunch() } }); });
  api.onNav((d) => (d === 'back' ? back() : forward()));
  api.onOpenTabs((paths) => paths.forEach((p) => newTab(p)));
  api.onViewerShown((p) => app.revealInView(p));

  renderChrome();
  refreshDrives(); // portable devices (no drive letter) into the Devices list right away
  await load(app.tab());
  updateWatch();
  view.root.focus();
  setInterval(refreshDrives, 15000);
  // Pre-render the status icons so the first color change is instant.
  for (const st of state.settings.statuses) ensureIcon(st.color).catch(() => {});
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#f88;white-space:pre-wrap">Foldernator failed to start:\n${e.stack || e}</pre>`;
});
