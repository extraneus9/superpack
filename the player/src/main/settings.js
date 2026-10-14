// Settings persisted as JSON in the user data folder. Debounced, atomic writes.
const fs = require('fs');
const path = require('path');

function defaults(app) {
  return {
    version: 4,
    look: 'glass',              // glass | editbay | alva — the player screen
    accent: '#e3262d',
    titleFont: 'ogg',           // ogg (brand) | instrument | inter — project titles
    glassBlur: 30,              // px
    glassTint: 14,              // % white in the frosted dock
    hideDelay: 1.6,             // seconds without the mouse before Glass controls fade
    pills: { container: true, codec: true, resolution: true, aspect: true, fps: true, duration: true },
    startOn: 'play',            // play | home — what opening a file shows first
    startPaused: true,          // a file he opens waits on its first frame for his Play (false = plays at once)
    windowMotion: 'smooth',     // instant | smooth | cinematic — how the window arrives and leaves
    stayReady: true,            // closing hides the window and keeps the player loaded (files open almost instantly)
    startWithWindows: true,     // with stayReady: launch hidden at sign-in (--background)
    wrapWindow: false,          // true = the window takes each video's shape; false = it keeps the size he gave it
    resume: true,
    autoplayNext: false,
    loop: false,
    seekStep: 5,
    volume: 0.8,
    muted: false,
    fit: { '4:3': 'fit', '16:9': 'fit', '9:16': 'fit', other: 'fit' }, // when the window can't take the video's shape
    snapshotDir: app.getPath('downloads'),
    positions: {},              // path -> seconds
    recent: [],                 // [{ path, at }] — everything played, newest first (up to 200)
    homeRows: { played: true, downloads: true, pc: true }, // rows on the home page
    window: { width: 1280, height: 800, maximized: false },
    homeWindow: { width: 1280, height: 800 },
    playerArea: 1280 * 720,     // video area (px²) the window wraps to; follows his own resizing
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function create(app) {
  const file = path.join(app.getPath('userData'), 'settings.json');
  let data = defaults(app);
  let migrated = false;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = merge(data, saved);
    // v2: opening a file plays it straight away; the home page is the showreel you get when the app starts on its own
    if (!saved.version || saved.version < 2) { data.version = 2; data.startOn = 'play'; migrated = true; }
    // v3: the window keeps its size when he opens a video (taking the video's shape is opt-in)
    if (!saved.version || saved.version < 3) { data.version = 3; data.wrapWindow = false; migrated = true; }
    // v4: an opened video waits for his Play instead of starting by itself
    if (!saved.version || saved.version < 4) { data.version = 4; data.startPaused = true; migrated = true; }
    if (data.startOn === 'project') data.startOn = 'home';
  } catch {}
  let timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('settings save failed', e); }
  };
  if (migrated) flush();
  return {
    get: () => data,
    set(patch) {
      data = merge(data, patch);
      // keep the bookkeeping lists small
      const pos = Object.entries(data.positions || {});
      if (pos.length > 400) data.positions = Object.fromEntries(pos.slice(-400));
      if (Array.isArray(data.recent)) data.recent = data.recent.slice(0, 200);
      clearTimeout(timer); timer = setTimeout(flush, 300);
      return data;
    },
    flush,
    file,
  };
}

module.exports = { create };
