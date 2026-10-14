// Google Drive folder-color sync through the rclone token (scope=drive).
// Local Z:\A\B maps to gdrive:A/B via ordered prefix rules (longest local prefix wins).
const { execFile } = require('child_process');

const PALETTE = [
  '#ac725e', '#d06b64', '#f83a22', '#fa573c', '#ff7537', '#ffad46', '#42d692', '#16a765',
  '#7bd148', '#b3dc6c', '#fbe983', '#fad165', '#92e1c0', '#9fe1e7', '#9fc6e7', '#4986e7',
  '#9a9cff', '#b99aff', '#8f8f8f', '#cabdbf', '#cca6ac', '#f691b2', '#cd74e6', '#a47ae2',
];
const DEFAULT_COLOR = '#8f8f8f';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function nearestPalette(hex) {
  if (!hex) return DEFAULT_COLOR;
  const lc = hex.toLowerCase();
  if (PALETTE.includes(lc)) return lc;
  const [r, g, b] = hexToRgb(lc);
  let best = DEFAULT_COLOR, bd = Infinity;
  for (const p of PALETTE) {
    const [pr, pg, pb] = hexToRgb(p);
    const d = (r - pr) ** 2 * 0.3 + (g - pg) ** 2 * 0.59 + (b - pb) ** 2 * 0.11;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function run(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      resolve(stdout);
    });
  });
}

class DriveSync {
  constructor(getConfig, notify) {
    this.getConfig = getConfig; // () => settings.drive
    this.notify = notify;       // (msg) => void
    this.ids = new Map();
    this.token = null;
    this.queue = [];
    this.busy = false;
  }

  mapPath(localPath) {
    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) return null;
    const lp = localPath.replace(/[\\/]+$/, '');
    const rules = [...(cfg.rules || [])].sort((a, b) => b.local.length - a.local.length);
    for (const r of rules) {
      const base = r.local.replace(/[\\/]+$/, '');
      if (lp.toLowerCase() === base.toLowerCase() || lp.toLowerCase().startsWith(base.toLowerCase() + '\\')) {
        const rest = lp.slice(base.length).replace(/^\\+/, '').split('\\').filter(Boolean).join('/');
        const remote = r.remote.endsWith(':') || r.remote.endsWith('/') ? r.remote + rest : (rest ? r.remote + '/' + rest : r.remote);
        return { remote, remoteName: r.remote.split(':')[0] };
      }
    }
    return null;
  }

  // Authenticated Drive API call with rate-limit backoff (rclone's shared OAuth project is throttled).
  async api(url, remoteName, init = {}) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const token = await this.accessToken(remoteName);
      const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
      if (res.status === 401) { this.token = null; continue; }
      if (res.status === 403 || res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const reason = JSON.stringify(body);
        if (!/rate|quota|userRateLimit/i.test(reason)) throw new Error((body.error && body.error.message) || 'Drive refused (403)');
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      const body = await res.json();
      if (!res.ok) throw new Error((body.error && body.error.message) || res.statusText);
      return body;
    }
    throw new Error('Drive rate limit — try again in a minute');
  }

  // Resolve gdrive:A/B/C to a folder id, one segment at a time (each level cached).
  async folderId(remote) {
    const [remoteName, rest = ''] = remote.split(':');
    const segs = rest.split('/').filter(Boolean);
    let parent = 'root';
    let key = remoteName + ':';
    for (const seg of segs) {
      key += '/' + seg;
      if (this.ids.has(key)) { parent = this.ids.get(key); continue; }
      const quoted = seg.split('\\').join('\\\\').split("'").join("\\'"); // Drive query string escaping
      const q = `'${parent}' in parents and name = '${quoted}' and trashed = false`;
      const r = await this.api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,shortcutDetails)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=20`, remoteName);
      let files = r.files || [];
      if (!files.length) {
        // Drive names can differ in case from disk (togo vs TOGO): list the folder and match loosely.
        const q2 = `'${parent}' in parents and trashed = false and (mimeType = '${FOLDER}' or mimeType = '${SHORTCUT}')`;
        const all = await this.api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q2)}&fields=files(id,name,mimeType,shortcutDetails)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000`, remoteName);
        files = (all.files || []).filter((x) => x.name.toLowerCase() === seg.toLowerCase());
      }
      const f = files.find((x) => x.mimeType === FOLDER)
        || files.find((x) => x.mimeType === SHORTCUT && x.shortcutDetails && x.shortcutDetails.targetMimeType === FOLDER);
      if (!f) return null;
      parent = f.mimeType === SHORTCUT ? f.shortcutDetails.targetId : f.id;
      this.ids.set(key, parent);
    }
    return parent === 'root' ? null : parent;
  }

  async accessToken(remoteName) {
    const now = Date.now();
    if (this.token && this.token.remote === remoteName && this.token.expiry - 90000 > now) return this.token.value;
    const read = async () => {
      const dump = JSON.parse(await run(['config', 'dump']));
      if (!dump[remoteName]) throw new Error(`rclone remote "${remoteName}" not found`);
      const t = JSON.parse(dump[remoteName].token);
      return { remote: remoteName, value: t.access_token, expiry: Date.parse(t.expiry) || 0 };
    };
    let tok = await read();
    if (tok.expiry - 90000 <= now) {
      await run(['about', remoteName + ':', '--json'], 120000).catch(() => {}); // rclone refreshes + saves the token
      tok = await read();
    }
    this.token = tok;
    return tok.value;
  }

  async listAll(q, fields, remoteName) {
    const out = [];
    let pageToken = '';
    do {
      const r = await this.api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${fields})&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`, remoteName);
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  // Direct children of a mapped local folder on Drive: name(lower) -> { id, folder, size }.
  async topLevel(localDir) {
    const m = this.mapPath(localDir);
    if (!m) return { mapped: false };
    const id = await this.folderId(m.remote);
    if (!id) return { mapped: true, remote: m.remote, exists: false, m };
    const kids = await this.listAll(`'${id}' in parents and trashed = false`, 'id,name,mimeType,size,shortcutDetails', m.remoteName);
    const items = new Map();
    for (const f of kids) {
      const key = f.name.toLowerCase();
      if (items.has(key) && items.get(key).folder) continue;
      const isFolder = f.mimeType === FOLDER || (f.mimeType === SHORTCUT && f.shortcutDetails && f.shortcutDetails.targetMimeType === FOLDER);
      items.set(key, { id: f.mimeType === SHORTCUT && isFolder ? f.shortcutDetails.targetId : f.id, folder: isFolder, size: f.size != null ? Number(f.size) : null });
    }
    return { mapped: true, remote: m.remote, exists: true, items, m };
  }

  // Every file under a Drive folder, at every depth: relative path(lower, "/") -> size (null for Google files).
  // Walks one level at a time, ~40 folders per request.
  async subtreeFiles(folderId, remoteName) {
    const files = new Map();
    const visited = new Set([folderId]);
    let level = [{ id: folderId, rel: '' }];
    while (level.length) {
      const next = [];
      for (let i = 0; i < level.length; i += 40) {
        const chunk = level.slice(i, i + 40);
        const relOf = Object.fromEntries(chunk.map((c) => [c.id, c.rel]));
        const q = `(${chunk.map((c) => `'${c.id}' in parents`).join(' or ')}) and trashed = false`;
        const found = await this.listAll(q, 'id,name,mimeType,size,parents,shortcutDetails', remoteName);
        for (const f of found) {
          const p = (f.parents || []).find((x) => x in relOf);
          if (p === undefined) continue;
          const rel = relOf[p] ? relOf[p] + '/' + f.name : f.name;
          const isFolder = f.mimeType === FOLDER || (f.mimeType === SHORTCUT && f.shortcutDetails && f.shortcutDetails.targetMimeType === FOLDER);
          if (isFolder) {
            const tid = f.mimeType === SHORTCUT ? f.shortcutDetails.targetId : f.id;
            if (!visited.has(tid)) { visited.add(tid); next.push({ id: tid, rel }); }
          } else files.set(rel.toLowerCase(), f.size != null ? Number(f.size) : null);
        }
      }
      level = next;
    }
    return files;
  }

  // Colors of the Drive subfolders of a mapped local folder: [{ name, color }].
  async childColors(localDir) {
    const m = this.mapPath(localDir);
    if (!m) return { mapped: false, items: [] };
    const id = await this.folderId(m.remote);
    if (!id) return { mapped: true, remote: m.remote, missing: true, items: [] };
    const q = `'${id}' in parents and trashed = false and mimeType = '${FOLDER}'`;
    const items = [];
    let pageToken = '';
    do {
      const r = await this.api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(name,folderColorRgb)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`, m.remoteName);
      for (const f of r.files || []) items.push({ name: f.name, color: (f.folderColorRgb || '').toLowerCase() });
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return { mapped: true, remote: m.remote, items };
  }

  // Queue a color change; resolves with { ok, skipped?, reason?, color }.
  setColor(localPath, hex) {
    return new Promise((resolve) => {
      this.queue.push({ localPath, hex, resolve });
      this.pump();
    });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      job.resolve(await this.apply(job.localPath, job.hex));
      await new Promise((r) => setTimeout(r, 700)); // rclone's shared OAuth project has a tight per-minute quota
    }
    this.busy = false;
  }

  async apply(localPath, hex) {
    const m = this.mapPath(localPath);
    if (!m) return { ok: false, skipped: true, reason: 'not mapped to Drive' };
    const color = hex ? nearestPalette(hex) : DEFAULT_COLOR;
    try {
      const id = await this.folderId(m.remote);
      if (!id) return { ok: false, skipped: true, reason: 'folder not on Drive', remote: m.remote };
      const body = await this.api(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=id,name,folderColorRgb`, m.remoteName, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderColorRgb: color }),
      });
      const got = (body.folderColorRgb || '').toLowerCase();
      return { ok: got === color, color: got, remote: m.remote, reason: got === color ? undefined : `Drive kept ${got}` };
    } catch (e) {
      return { ok: false, reason: e.message, remote: m.remote };
    }
  }
}

module.exports = { DriveSync, PALETTE, nearestPalette };
