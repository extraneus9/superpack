// Settings persisted as JSON in the user data folder. Debounced, atomic writes.
const fs = require('fs');
const path = require('path');

// Defaults are generic: a new PC starts clean (no status folders, Drive off). the author's own folders and Drive mappings
// are stored explicitly in his settings.json, so these never touch his setup.
const DEFAULTS = {
  version: 4,
  themeId: 'windows-dark',
  customThemes: {},
  view: {
    mode: 'details',          // details | icons
    iconSize: 'large',        // medium | large | xl
    showHidden: false,
    showExt: true,
    previewPane: false,
    sidebarWidth: 232,
    previewWidth: 340,
    foldersFirst: true,
    sort: { key: 'name', dir: 1 },
    restoreTabs: false,
    folderPreviews: true,
    builtinViewer: true,      // images open in Foldernator's viewer (arrows browse the folder)     // folders show the images/videos inside (Windows 11 style)       // false = start at Home after closing (like Windows Explorer)
    columns: { name: 360, status: 130, modified: 170, type: 150, size: 100 },
  },
  folderViews: {},            // lowercased path -> { mode, iconSize, sort }
  pinned: [],
  pinsImported: false,        // first run imports the Windows Quick access pins
  layout: { sidebar: 'left', preview: 'right', previewHeight: 280 },
  // Folders whose direct subfolders take a status (one subfolder = one video).
  statusScopes: [],           // right-click empty space › Use status colors here
  galleryRoots: [],           // empty = Pictures
  icons: { folder: 'windows', ui: 'regular', sidebar: 'windows', files: 'windows' },
  motion: 2,                  // fluidity: 0 off · 1 smooth · 2 liquid
  statuses: [
    { key: 'unpublished', label: 'Not published', color: '#f83a22', hotkey: '1' },
    { key: 'neutral', label: 'Neutral', color: '#8f8f8f', hotkey: '2' },
    { key: 'scheduled', label: 'Scheduled', color: '#ffad46', hotkey: '3' },
    { key: 'published', label: 'Published', color: '#16a765', hotkey: '4' },
  ],
  statusIndex: {},            // lowercased path -> { path, status, color, t }
  drive: { enabled: false, rules: [] }, // opt-in: needs rclone with a Google Drive remote

  window: { width: 1280, height: 800, maximized: false },
  session: { tabs: [], active: 0, history: [] },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], over[k])
      : over[k];
  }
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = structuredClone(DEFAULTS); // a copy: set() must never change DEFAULTS (Restore defaults)
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = deepMerge(structuredClone(DEFAULTS), raw);
      this.migrate(raw);
    } catch {}
    this.timer = null;
  }
  migrate(raw) {
    // v4: a solid theme switched to Liquid glass kept 100% opaque panels and hid the glass completely.
    if ((raw.version || 1) < 4) {
      const themes = { ...(this.data.customThemes || {}) };
      for (const [id, t] of Object.entries(themes)) {
        if (t.material === 'liquid' && (t.panelOpacity ?? 1) > 0.85) themes[id] = { ...t, panelOpacity: 0.34, glassBlur: Math.max(t.glassBlur ?? 22, 14) };
      }
      this.data.customThemes = themes;
      this.data.version = 4;
      this.save();
    }
  }

  // Back to factory settings. Keeps what is data, not preference: pins, status records, saved themes, window spot.
  reset(keep = ['pinned', 'pinsImported', 'statusIndex', 'customThemes', 'window', 'session']) {
    const kept = {};
    for (const k of keep) if (k in this.data) kept[k] = this.data[k];
    this.data = deepMerge(structuredClone(DEFAULTS), kept);
    this.flush();
    return this.data;
  }
  get() { return this.data; }
  patch(partial) {
    this.data = deepMerge(this.data, partial);
    this.save();
    return this.data;
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('settings save failed', e); }
  }
}

module.exports = { Settings, DEFAULTS };
