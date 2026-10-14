// Where the home page's rows come from:
//   played    — what he played in the player (settings.recent), checked against the disk
//   downloads — video/audio in Downloads and its subfolders (one level), newest first
//   pc        — Windows' own Recent list (files opened in any app), video/audio only, newest first
// Nothing here is probed with FFmpeg: rows show instantly and the page fills durations as cards scroll into view.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { isMedia, extOf, AUDIO_EXT } = require('./media');

const kindOf = (p) => (AUDIO_EXT.includes(extOf(p)) ? 'audio' : 'video');
const INCOMPLETE = /\.(crdownload|part|partial|tmp|download|opdownload)$/i;
const MAX_SUBDIRS = 60; // the most recently changed subfolders of Downloads
// Windows names a second shortcut with the same file name "clip.mp4 (2).lnk"
const lnkTargetName = (n) => n.slice(0, -4).replace(/ \(\d+\)$/, '');

async function entry(p, at) {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size === 0) return null;
    return {
      path: p, name: path.basename(p), dir: path.dirname(p), ext: extOf(p), kind: kindOf(p), size: st.size,
      // when it arrived: a download or copy gets a fresh creation time, an edit a fresh modified time
      at: at != null ? at : Math.max(st.birthtimeMs || 0, st.mtimeMs || 0),
      mtime: st.mtimeMs,
    };
  } catch { return null; }
}

// stat in small batches so a big folder never floods the disk
async function batch(list, fn, size = 48) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
  return out.filter(Boolean);
}

// listing is cheap; only the filtered media entries are stat'd or resolved, so no cap on the listing itself
async function readDir(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}
const visibleName = (n) => !n.startsWith('.') && !n.startsWith('$') && n.toLowerCase() !== 'desktop.ini';

async function downloads(dir, limit = 300) {
  if (!dir) return [];
  const files = [];
  const top = await readDir(dir);
  for (const d of top) {
    if (!visibleName(d.name)) continue;
    if (d.isFile() && isMedia(d.name) && !INCOMPLETE.test(d.name)) files.push(path.join(dir, d.name));
  }
  // newest folders first (a folder's modified time moves when a download lands in it), so a cap never hides fresh ones
  const stamped = await batch(top.filter((d) => d.isDirectory() && visibleName(d.name)).map((d) => path.join(dir, d.name)), async (p) => {
    try { const st = await fs.promises.stat(p); return { p, t: Math.max(st.birthtimeMs || 0, st.mtimeMs || 0) }; } catch { return null; }
  });
  for (const { p } of stamped.sort((a, b) => b.t - a.t).slice(0, MAX_SUBDIRS)) {
    for (const d of await readDir(p)) {
      if (d.isFile() && visibleName(d.name) && isMedia(d.name) && !INCOMPLETE.test(d.name)) files.push(path.join(p, d.name));
    }
  }
  const items = await batch(files, (p) => entry(p));
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

async function windowsRecent(dir, limit = 300) {
  if (!dir) return [];
  // Windows names each shortcut after its target ("clip.mp4.lnk"), so media can be picked before resolving anything
  const named = (await readDir(dir)).filter((d) => d.isFile() && /\.lnk$/i.test(d.name) && isMedia(lnkTargetName(d.name)));
  // stat first (async), then resolve only the newest — resolving a shortcut is a blocking call
  const stamped = await batch(named, async (d) => { const lnk = path.join(dir, d.name); try { return { lnk, opened: (await fs.promises.stat(lnk)).mtimeMs }; } catch { return null; } });
  const lnks = stamped.sort((a, b) => b.opened - a.opened).slice(0, limit * 2);
  const seen = new Set();
  const items = await batch(lnks, async ({ lnk, opened }) => {
    let target = null;
    try { target = shell.readShortcutLink(lnk).target; } catch { return null; }
    if (!target || !isMedia(target)) return null;
    return entry(path.resolve(target), opened);
  });
  // newest first, then one card per file (the newest shortcut wins)
  return items.sort((a, b) => b.at - a.at)
    .filter((x) => { const k = x.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}

async function played(recent, limit = 200) {
  const list = (recent || []).filter((r) => r && r.path).slice(0, limit);
  return batch(list, (r) => entry(path.resolve(r.path), r.at || 0));
}

module.exports = { downloads, windowsRecent, played };
