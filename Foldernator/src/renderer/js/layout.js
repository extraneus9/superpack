// Panels you can move and resize: drag a panel's header onto a dock zone (sidebar: left/right,
// preview: left/right/bottom), drag any splitter to resize, double-click a splitter to reset.
import { $, el } from './util.js';
import { icon } from './icons.js';
import { showMenuAt } from './menu.js';

const DEFAULTS = { sidebarWidth: 232, previewWidth: 340, previewHeight: 280 };

export class Layout {
  constructor(app) {
    this.app = app;
    this.body = $('#body');
    this.content = $('#content');
    this.sidebar = $('#sidebar');
    this.preview = $('#preview');
    this.splitS = document.querySelector('.splitter[data-split="sidebar"]');
    this.splitP = document.querySelector('.splitter[data-split="preview"]');
    this.overlay = $('#dock-overlay');
    this.buildHeads();
    this.bindSplitters();
  }

  get cfg() { return { sidebar: 'left', preview: 'right', previewHeight: DEFAULTS.previewHeight, ...(this.app.settings().layout || {}) }; }

  apply() {
    const L = this.cfg;
    if ((L.sidebar === 'left' || L.sidebar === 'right') && L.preview === L.sidebar) L.preview = L.sidebar === 'left' ? 'right' : 'left';
    const v = this.app.settings().view;
    document.body.dataset.sidebar = L.sidebar;
    document.body.dataset.preview = L.preview;
    if (L.preview === 'bottom') {
      if (this.preview.parentElement !== this.content) this.content.append(this.splitP, this.preview);
    } else if (this.preview.parentElement !== this.body) {
      this.body.append(this.splitP, this.preview);
    }
    const root = document.documentElement.style;
    root.setProperty('--sidebar-w', (v.sidebarWidth || DEFAULTS.sidebarWidth) + 'px');
    root.setProperty('--preview-w', (v.previewWidth || DEFAULTS.previewWidth) + 'px');
    root.setProperty('--preview-h', (L.previewHeight || DEFAULTS.previewHeight) + 'px');
    this.updateHeads();
  }

  set(patch) {
    const layout = { ...this.cfg, ...patch };
    // Navigation and preview always sit on opposite sides: moving one flips the other.
    const other = { left: 'right', right: 'left' };
    if (patch.sidebar in other && layout.preview in other) layout.preview = other[patch.sidebar];
    if (patch.preview in other && layout.sidebar in other) layout.sidebar = other[patch.preview];
    this.app.state.settings.layout = layout;
    this.app.api.patchSettings({ layout });
    this.apply();
  }

  dockMenu(which, anchor) {
    const L = this.cfg;
    const items = which === 'sidebar'
      ? [
        { label: 'Dock left', icon: 'dockLeft', checked: L.sidebar === 'left', action: () => this.set({ sidebar: 'left' }) },
        { label: 'Dock right', icon: 'dockRight', checked: L.sidebar === 'right', action: () => this.set({ sidebar: 'right' }) },
        '-',
        { label: 'Hide navigation pane', icon: 'close', action: () => this.set({ sidebar: 'hidden' }) },
      ]
      : [
        { label: 'Dock right', icon: 'dockRight', checked: L.preview === 'right', action: () => this.set({ preview: 'right' }) },
        { label: 'Dock left', icon: 'dockLeft', checked: L.preview === 'left', action: () => this.set({ preview: 'left' }) },
        { label: 'Dock bottom', icon: 'dockBottom', checked: L.preview === 'bottom', action: () => this.set({ preview: 'bottom' }) },
        '-',
        { label: 'Close preview', icon: 'close', key: 'Alt+P', action: () => this.app.setViewFlag('previewPane', false) },
      ];
    showMenuAt(items, anchor);
  }

  buildHeads() {
    for (const head of document.querySelectorAll('.panel-head')) {
      const which = head.dataset.panel;
      const title = which === 'sidebar' ? 'Navigation' : 'Preview';
      const dock = el('button', { class: 'icon-btn', title: 'Move this panel', html: icon('more', 14) });
      dock.addEventListener('mousedown', (e) => e.stopPropagation());
      dock.addEventListener('click', () => this.dockMenu(which, dock));
      head.replaceChildren(...[
        el('span', { class: 'ph-grip', html: icon('grip', 14) }),
        el('span', { class: 'ph-title', text: title }),
        dock,
        which === 'preview' ? el('button', { class: 'icon-btn', title: 'Close (Alt+P)', html: icon('close', 12), onmousedown: (e) => e.stopPropagation(), onclick: () => this.app.setViewFlag('previewPane', false) }) : null,
      ].filter(Boolean));
      head.title = 'Drag to move this panel';
      head.addEventListener('mousedown', (e) => { if (e.button === 0) this.startDockDrag(e, which); });
    }
  }

  updateHeads() {}

  zonesFor(which) {
    const b = this.body.getBoundingClientRect();
    const pad = 10, w = Math.min(200, b.width * 0.22);
    const zones = [
      { pos: 'left', icon: 'dockLeft', label: 'Left', x: b.left + pad, y: b.top + pad, w, h: b.height - pad * 2 },
      { pos: 'right', icon: 'dockRight', label: 'Right', x: b.right - pad - w, y: b.top + pad, w, h: b.height - pad * 2 },
    ];
    if (which === 'preview') {
      const h = Math.min(170, b.height * 0.28);
      zones.push({ pos: 'bottom', icon: 'dockBottom', label: 'Bottom', x: b.left + w + pad * 2, y: b.bottom - pad - h, w: b.width - (w + pad * 2) * 2, h });
    }
    return zones;
  }

  startDockDrag(e, which) {
    const sx = e.clientX, sy = e.clientY;
    let started = false, zones = [], ghost = null, hot = null;
    const begin = () => {
      started = true;
      zones = this.zonesFor(which).map((z) => {
        const n = el('div', { class: 'dock-zone', style: { left: z.x + 'px', top: z.y + 'px', width: z.w + 'px', height: z.h + 'px' } },
          el('span', { html: icon(z.icon, 28) }), el('span', { text: z.label }));
        this.overlay.append(n);
        return { ...z, node: n };
      });
      ghost = el('div', { class: 'dock-ghost', text: which === 'sidebar' ? 'Navigation' : 'Preview' });
      document.body.append(ghost);
      this.overlay.classList.add('on');
      document.body.style.cursor = 'grabbing';
    };
    const move = (ev) => {
      if (!started) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return; begin(); }
      ghost.style.left = ev.clientX + 14 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      hot = zones.find((z) => ev.clientX >= z.x && ev.clientX <= z.x + z.w && ev.clientY >= z.y && ev.clientY <= z.y + z.h) || null;
      zones.forEach((z) => z.node.classList.toggle('hot', z === hot));
    };
    const end = (ev) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', end);
      document.removeEventListener('keydown', esc, true);
      if (!started) return;
      this.overlay.classList.remove('on');
      this.overlay.replaceChildren();
      if (ghost) ghost.remove();
      document.body.style.cursor = '';
      if (hot && ev) this.set(which === 'sidebar' ? { sidebar: hot.pos } : { preview: hot.pos });
    };
    const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); hot = null; end(null); } };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
    document.addEventListener('keydown', esc, true);
  }

  bindSplitters() {
    for (const sp of [this.splitS, this.splitP]) {
      sp.addEventListener('dblclick', () => {
        const which = sp.dataset.split;
        const v = this.app.settings().view;
        if (which === 'sidebar') v.sidebarWidth = DEFAULTS.sidebarWidth;
        else if (this.cfg.preview === 'bottom') { this.set({ previewHeight: DEFAULTS.previewHeight }); return; }
        else v.previewWidth = DEFAULTS.previewWidth;
        this.app.api.patchSettings({ view: { sidebarWidth: v.sidebarWidth, previewWidth: v.previewWidth } });
        this.apply();
      });
      sp.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const which = sp.dataset.split;
        const L = this.cfg;
        const v = this.app.settings().view;
        const vertical = which === 'preview' && L.preview === 'bottom';
        const sign = which === 'sidebar' ? (L.sidebar === 'right' ? -1 : 1) : (L.preview === 'left' ? 1 : -1);
        const start = vertical ? e.clientY : e.clientX;
        const startSize = vertical ? (L.previewHeight || DEFAULTS.previewHeight) : which === 'sidebar' ? v.sidebarWidth : v.previewWidth;
        sp.classList.add('dragging');
        document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
        let size = startSize;
        const move = (ev) => {
          const d = (vertical ? ev.clientY : ev.clientX) - start;
          if (vertical) {
            size = Math.max(120, Math.min(window.innerHeight - 260, startSize - d));
            document.documentElement.style.setProperty('--preview-h', size + 'px');
          } else if (which === 'sidebar') {
            size = Math.max(150, Math.min(560, startSize + sign * d));
            document.documentElement.style.setProperty('--sidebar-w', size + 'px');
          } else {
            size = Math.max(220, Math.min(window.innerWidth - 420, startSize + sign * d));
            document.documentElement.style.setProperty('--preview-w', size + 'px');
          }
        };
        const up = () => {
          sp.classList.remove('dragging');
          document.body.style.cursor = '';
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (vertical) { this.set({ previewHeight: size }); return; }
          if (which === 'sidebar') v.sidebarWidth = size; else v.previewWidth = size;
          this.app.api.patchSettings({ view: { sidebarWidth: v.sidebarWidth, previewWidth: v.previewWidth } });
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
  }
}
