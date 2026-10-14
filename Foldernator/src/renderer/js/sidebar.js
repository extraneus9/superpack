// Navigation pane, laid out like Windows 11 Explorer: Home, Gallery, pinned folders (real shell icons,
// drag to reorder), the expandable This PC tree, then status boards for the status folders.
import { el, baseName, fmtSize, isRoot, isFsPath, debounce, collator, IS_MAC } from './util.js';
import { icon, folderSvg, driveSvg, homeIcon, galleryIcon, iconStyles } from './icons.js';
import { HoverPill, enter as motionEnter } from './motion.js';

const enc = encodeURIComponent;
const PIN_TYPE = 'application/x-alva-pin';

export class Sidebar {
  constructor(root, app) {
    this.root = root;
    this.scroll = root.querySelector('.side-scroll');
    this.app = app;
    this.children = new Map(); // tree: path(lower) -> [{ n, p }]
    this.open = new Set((app.settings().treeOpen || ['thispc']).map((x) => x.toLowerCase()));
    this.saveOpen = debounce(() => app.api.setSetting('treeOpen', [...this.open]), 400);
    this.pill = new HoverPill(this.scroll, '.side-item');
    this.scroll.addEventListener('dragover', (e) => this.onDragOver(e));
    this.scroll.addEventListener('dragleave', (e) => { if (!this.scroll.contains(e.relatedTarget)) this.clearDrop(); });
    this.scroll.addEventListener('drop', (e) => this.onDrop(e));
  }

  activeLoc() { const t = this.app.tab(); return t ? t.loc.toLowerCase() : ''; }

  row({ label, iconHtml, loc, meta, pin, depth, tree, dropDir, title }) {
    const node = el('div', {
      class: 'side-item' + (tree ? ' tree' : '') + (this.activeLoc() === (loc || '').toLowerCase() ? ' active' : ''),
      title: title || (loc && isFsPath(loc) ? loc : label),
      dataset: { loc: loc || '', drop: dropDir || '', pin: pin != null ? String(pin) : '' },
    });
    if (tree) {
      node.style.setProperty('--depth', depth);
      const known = this.children.get(loc.toLowerCase());
      const chev = el('button', { class: 'tree-chev' + (this.open.has(loc.toLowerCase()) ? ' open' : '') + (known && !known.length ? ' leaf' : ''), html: icon('chevron', 11), title: 'Expand' });
      chev.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(loc); });
      node.append(chev);
    }
    node.append(el('span', { class: 'si-icon', html: iconHtml }), el('span', { class: 'si-label', text: label }));
    if (meta != null) node.append(el('span', { class: 'status-count', text: String(meta) }));
    if (pin != null) {
      node.append(el('span', { class: 'si-pin', html: icon('pin', 12) }));
      node.draggable = true;
      node.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(PIN_TYPE, String(pin));
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    if (loc) {
      node.addEventListener('click', () => this.app.navigate(loc));
      node.addEventListener('auxclick', (e) => { if (e.button === 1) this.app.newTab(loc, { background: true }); });
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.sidebarMenu(e.clientX, e.clientY, loc, { pinned: pin != null }); });
    }
    return node;
  }

  shellIcon(p) {
    const st = this.app.knownStatus(p);
    if (st && st.color && !isRoot(p)) return folderSvg(st.color, { size: 18 });
    if (iconStyles.sidebar === 'mono') {
      if (isRoot(p)) return icon('drive', 16);
      const paths = this.app.state.paths;
      const special = { [paths.desktop]: 'desktop', [paths.downloads]: 'download', [paths.documents]: 'doc', [paths.pictures]: 'image', [paths.videos]: 'video', [paths.music]: 'music' };
      return special[p] ? icon(special[p], 16) : folderSvg(this.app.themeFolder(), { size: 18 });
    }
    return `<img class="shell-ic" src="ficon://f/?p=${enc(p)}&s=normal&d=1" alt="" draggable="false">`;
  }

  pinLabel(p) {
    if (isRoot(p)) {
      const d = this.app.state.drives.find((x) => x.path.toLowerCase() === p.toLowerCase());
      return d && d.ready ? `${d.label || 'Local Disk'} (${p.slice(0, 2)})` : p;
    }
    const known = { [this.app.state.paths.desktop]: 'Desktop', [this.app.state.paths.downloads]: 'Downloads', [this.app.state.paths.documents]: 'Documents', [this.app.state.paths.pictures]: 'Pictures', [this.app.state.paths.videos]: 'Videos', [this.app.state.paths.music]: 'Music' };
    return known[p] || baseName(p);
  }

  render() {
    const app = this.app;
    const s = app.settings();
    const frag = document.createDocumentFragment();
    const mono = iconStyles.sidebar === 'mono';
    frag.append(this.row({ label: 'Home', iconHtml: mono ? icon('home', 16) : homeIcon(18), loc: 'home' }));
    frag.append(this.row({ label: 'Gallery', iconHtml: mono ? icon('image', 16) : galleryIcon(18), loc: 'gallery' }));
    frag.append(el('div', { class: 'side-sep' }));

    (s.pinned || []).forEach((p, i) => frag.append(this.row({ label: this.pinLabel(p), iconHtml: this.shellIcon(p), loc: p, pin: i, dropDir: p })));
    frag.append(el('div', { class: 'side-sep', dataset: { pinEnd: '1' } }));

    const devices = [
      ...(app.state.drives || []).filter((d) => d.ready && ['Removable', 'CDRom'].includes(d.type)).map((d) => ({ label: `${d.label || (d.type === 'CDRom' ? 'Disc' : 'USB Drive')} (${d.path.slice(0, 2)})`, loc: d.path, html: mono ? icon('drive', 16) : `<img src="ficon://f/?p=${enc(d.path)}&s=normal&d=1" alt="" draggable="false">`, drop: d.path })),
      ...(app.state.portable || []).map((d) => ({ label: d.label || d.name, loc: d.path, html: icon('drive', 16), drop: d.path })),
    ];
    if (devices.length) {
      frag.append(el('div', { class: 'side-head' }, el('span', { text: 'Devices' })));
      for (const d of devices) frag.append(this.row({ label: d.label, iconHtml: d.html, loc: d.loc, dropDir: d.drop, title: d.label }));
      frag.append(el('div', { class: 'side-sep' }));
    }

    this.renderTree(frag, 'thispc', IS_MAC ? 'Computer' : 'This PC', icon('pc', 16), 0);

    const scopes = s.statusScopes || [];
    if (scopes.length) {
      frag.append(el('div', { class: 'side-sep' }));
      frag.append(el('div', { class: 'side-head', title: scopes.join('\n') }, el('span', { text: 'Status' })));
      const counts = app.statusCounts();
      for (const st of s.statuses) {
        frag.append(this.row({ label: st.label, iconHtml: `<i class="status-swatch" style="background:${st.color}"></i>`, loc: 'board:' + st.key, meta: counts[st.key] || 0 }));
      }
    }
    const animateKids = this.animateKids;
    this.animateKids = null;
    this.scroll.replaceChildren(frag);
    this.pill.cur = null;
    if (animateKids) {
      const rows = [...this.scroll.querySelectorAll('.side-item.tree')];
      const i = rows.findIndex((r) => r.dataset.loc.toLowerCase() === animateKids.toLowerCase());
      if (i >= 0) {
        const d = +rows[i].style.getPropertyValue('--depth');
        const kids = [];
        for (let j = i + 1; j < rows.length && +rows[j].style.getPropertyValue('--depth') > d; j++) kids.push(rows[j]);
        motionEnter(kids, 'none');
      }
    }
    this.reveal();
    // Unavailable drives/folders (e.g. an unplugged USB) have no shell icon: fall back to a plain folder.
    this.scroll.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => {
      img.replaceWith(document.createRange().createContextualFragment(folderSvg(this.app.themeFolder(), { size: 18 })));
    }, { once: true }));
  }

  renderTree(frag, loc, label, iconHtml, depth) {
    frag.append(this.row({ label, iconHtml, loc, depth, tree: true, dropDir: loc === 'thispc' ? '' : loc }));
    if (!this.open.has(loc.toLowerCase())) return;
    const kids = this.children.get(loc.toLowerCase());
    if (!kids) { this.loadChildren(loc); return; }
    for (const k of kids) {
      if (loc === 'thispc' && k.portable) {
        frag.append(this.row({ label: k.n, iconHtml: icon('drive', 16), loc: k.p, depth: depth + 1, title: k.n + ' (portable device)' }));
      } else if (loc === 'thispc') {
        const d = k.drive;
        const used = d.total ? 1 - d.free / d.total : 0;
        this.renderTree(frag, d.path, `${d.label || (d.type === 'Removable' ? 'USB Drive' : 'Local Disk')} (${d.path.slice(0, 2)})`, iconStyles.sidebar === 'mono' ? icon('drive', 16) : `<img src="ficon://f/?p=${enc(d.path)}&s=normal&d=1" alt="" draggable="false">`, depth + 1);
        const last = frag.lastElementChild;
        if (last && last.dataset.loc === d.path) last.title = `${d.path}  ·  ${fmtSize(d.free)} free of ${fmtSize(d.total)} (${Math.round(used * 100)}% used)`;
      } else {
        const st = this.app.knownStatus(k.p);
        this.renderTree(frag, k.p, k.n, folderSvg((st && st.color) || this.app.themeFolder(), { size: 18 }), depth + 1);
      }
    }
  }

  async loadChildren(loc) {
    const key = loc.toLowerCase();
    if (this.loading && this.loading.has(key)) return;
    this.loading = this.loading || new Set();
    this.loading.add(key);
    // Always finish after the current render: rendering again from inside render() let the outer, stale
    // pass overwrite the result (This PC showed as expanded with no drives under it).
    await Promise.resolve();
    try {
      let kids;
      if (loc === 'thispc') kids = this.app.state.drives.filter((d) => d.ready).map((d) => ({ n: d.path, p: d.path, drive: d }))
        .concat((this.app.state.portable || []).map((d) => ({ n: d.label || d.name, p: d.path, portable: true })));
      else {
        const r = await this.app.api.list(loc);
        kids = r.items.filter((i) => i.d && !i.h && !i.sys).sort((a, b) => collator.compare(a.n, b.n)).map((i) => ({ n: i.n, p: i.p }));
      }
      this.children.set(key, kids);
      this.animateKids = loc;
    } catch {
      this.children.set(key, []);
    }
    this.loading.delete(key);
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  // After expanding, scroll so the new children are visible (the tree sits at the bottom of the pane).
  reveal() {
    const loc = this.revealLoc;
    if (!loc || !this.children.has(loc.toLowerCase())) return;
    this.revealLoc = null;
    const rows = [...this.scroll.querySelectorAll('.side-item.tree')];
    const i = rows.findIndex((r) => r.dataset.loc.toLowerCase() === loc.toLowerCase());
    if (i < 0) return;
    const d = +rows[i].style.getPropertyValue('--depth');
    let j = i;
    while (j + 1 < rows.length && +rows[j + 1].style.getPropertyValue('--depth') > d) j++;
    rows[j].scrollIntoView({ block: 'nearest' });
    rows[i].scrollIntoView({ block: 'nearest' });
  }

  toggle(loc) {
    const key = loc.toLowerCase();
    if (this.open.has(key)) this.open.delete(key);
    else { this.open.add(key); this.children.delete(key); this.revealLoc = loc; }
    this.saveOpen();
    this.render();
  }

  invalidate(dir) {
    if (!dir) { this.children.clear(); return; }
    if (this.children.delete(dir.toLowerCase()) && this.open.has(dir.toLowerCase())) this.render();
  }

  // ---------- drag & drop: reorder pins, pin folders, drop files into folders ----------
  clearDrop() {
    this.scroll.querySelectorAll('.drag-over, .ins-before, .ins-after').forEach((n) => n.classList.remove('drag-over', 'ins-before', 'ins-after'));
  }

  targetOf(e) {
    const n = e.target.closest('.side-item, [data-pin-end]');
    if (!n) return null;
    const isPin = n.dataset.pin !== undefined && n.dataset.pin !== '';
    if (n.dataset.pinEnd) return { node: n, insert: (this.app.settings().pinned || []).length, edge: 'before' };
    const r = n.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (isPin && (y < 0.28 || y > 0.72)) {
      const idx = +n.dataset.pin + (y > 0.72 ? 1 : 0);
      return { node: n, insert: idx, edge: y > 0.72 ? 'after' : 'before' };
    }
    if (n.dataset.drop) return { node: n, dir: n.dataset.drop };
    return null;
  }

  onDragOver(e) {
    const isPinDrag = e.dataTransfer.types.includes(PIN_TYPE);
    if (!isPinDrag && !e.dataTransfer.types.includes('Files')) return;
    const t = this.targetOf(e);
    this.clearDrop();
    if (!t) return;
    if (isPinDrag && t.insert == null) return;
    e.preventDefault();
    if (t.insert != null) {
      if (t.node.dataset.pinEnd) { const prev = t.node.previousElementSibling; if (prev && prev.classList.contains('side-item')) prev.classList.add('ins-after'); }
      else t.node.classList.add(t.edge === 'after' ? 'ins-after' : 'ins-before');
      e.dataTransfer.dropEffect = isPinDrag ? 'move' : 'link';
    } else {
      t.node.classList.add('drag-over');
      e.dataTransfer.dropEffect = this.app.dropEffectFor(e, t.dir);
    }
  }

  onDrop(e) {
    const isPinDrag = e.dataTransfer.types.includes(PIN_TYPE);
    const t = this.targetOf(e);
    this.clearDrop();
    if (!t) return;
    e.preventDefault();
    if (isPinDrag) {
      if (t.insert != null) this.app.movePin(+e.dataTransfer.getData(PIN_TYPE), t.insert);
      return;
    }
    if (t.insert != null) { this.app.pinFolders(this.app.pathsFromDrop(e), t.insert); return; }
    this.app.handleDrop(e, t.dir);
  }
}
