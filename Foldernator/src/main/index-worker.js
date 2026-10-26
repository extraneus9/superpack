// Instant search: a file-name index of the drives (the idea behind "Everything"), in a worker thread so the app
// never stalls. Built once by walking the folders, saved to disk (ready at the next start), kept fresh by
// watching each root for changes, and rebuilt quietly in the background now and then. A search is a
// substring scan over one big lowercase string of names — milliseconds for hundreds of thousands of files.
// Electron's fs opens .asar files as archives and keeps them open (a stat was enough to lock an app being
// rebuilt) — the index must treat them as plain files.
process.noAsar = true;
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const store = workerData.dir;
fs.mkdirSync(store, { recursive: true });
const SKIP_ANY = /^(\$recycle\.bin|system volume information|node_modules|\.git|appdata|\$windows\.~(bt|ws)|\$winreagent|\$sysreset|msocache|config\.msi)$/i;
const SKIP_TOP = /^(windows|program files|program files \(x86\)|programdata|recovery|perflogs|pagefile\.sys|hiberfil\.sys|swapfile\.sys)$/i;

const roots = new Map(); // key(lower root) -> R
// R = { root, dirs: [], names: [], parents: Int32Array, isDir: Uint8Array, blob, offs: Int32Array, n,
//       delta: Map(lowerPath -> {p, n, d}), gone: Set(lowerPath), at, building, watcher }

const keyOf = (root) => root.toLowerCase();
const fileFor = (root) => path.join(store, root.replace(/[:\\/]+/g, '_').replace(/_+$/, '') + '.json.gz');

async function walk(root) {
  const dirs = [root], names = [], parents = [], isDir = [];
  const stack = [{ d: root, idx: 0, depth: 0 }];
  while (stack.length) {
    const { d, idx, depth } = stack.pop();
    let h;
    try { h = await fsp.opendir(d, { bufferSize: 256 }); } catch { continue; }
    try {
      for await (const e of h) {
        const nm = e.name;
        if (SKIP_ANY.test(nm) || (depth === 0 && SKIP_TOP.test(nm))) continue;
        const dirent = e.isDirectory();
        names.push(nm); parents.push(idx); isDir.push(dirent ? 1 : 0);
        if (dirent && !e.isSymbolicLink()) {
          const full = d.endsWith('\\') ? d + nm : d + '\\' + nm;
          dirs.push(full);
          stack.push({ d: full, idx: dirs.length - 1, depth: depth + 1 });
        }
      }
    } catch {}
  }
  return { dirs, names, parents, isDir };
}

function finalize(root, data, at) {
  const lower = data.names.map((s) => s.toLowerCase());
  const offs = new Int32Array(lower.length + 1);
  let o = 0;
  for (let i = 0; i < lower.length; i++) { offs[i] = o; o += lower[i].length + 1; }
  offs[lower.length] = o;
  const prev = roots.get(keyOf(root));
  const R = {
    root, dirs: data.dirs, names: data.names, parents: Int32Array.from(data.parents), isDir: Uint8Array.from(data.isDir),
    blob: lower.join('\n') + '\n', offs, n: lower.length, at,
    delta: new Map(), gone: new Set(), building: false, watcher: prev ? prev.watcher : null,
  };
  roots.set(keyOf(root), R);
  return R;
}

async function save(R) {
  const json = JSON.stringify({ v: 1, root: R.root, at: R.at, dirs: R.dirs, names: R.names, parents: Array.from(R.parents), isDir: Array.from(R.isDir) });
  const gz = await new Promise((res, rej) => zlib.gzip(json, { level: 4 }, (e, b) => (e ? rej(e) : res(b))));
  const f = fileFor(R.root);
  await fsp.writeFile(f + '.tmp', gz);
  await fsp.rename(f + '.tmp', f);
}

async function load(root) {
  try {
    const gz = await fsp.readFile(fileFor(root));
    const d = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    if (d.v !== 1 || d.root.toLowerCase() !== root.toLowerCase()) return null;
    return finalize(root, d, d.at);
  } catch { return null; }
}

async function build(root) {
  const cur = roots.get(keyOf(root));
  if (cur && cur.building) return;
  if (cur) cur.building = true;
  else roots.set(keyOf(root), { root, building: true, n: 0, delta: new Map(), gone: new Set() });
  const t0 = Date.now();
  const data = await walk(root);
  const R = finalize(root, data, Date.now());
  post({ event: 'built', root, n: R.n, ms: Date.now() - t0 });
  save(R).catch(() => {});
  watch(R);
}

// Live changes: a created/renamed file shows up in results at once; a deleted one disappears.
// Each top-level folder gets its own recursive watcher and skipped ones (AppData, Windows…) get none:
// one watcher on the home folder received ~60 browser/temp-cache events a second, all thrown away.
const skipped = (rel) => rel.split(/[\\/]/).some((x, i) => SKIP_ANY.test(x) || (i === 0 && SKIP_TOP.test(x)));
function watch(R) {
  if (R.watcher) return;
  const base = R.root.endsWith('\\') ? R.root : R.root + '\\';
  const subs = new Map(); // lower top-level name -> FSWatcher
  let pending = new Set(), timer = null;
  const queue = (rel) => {
    if (!rel || skipped(rel)) return;
    if (pending.size < 20000) pending.add(base + rel);
    if (!timer) timer = setTimeout(flush, 1000); // at most one pass a second, even under a steady stream
  };
  const flush = async () => {
    const batch = [...pending]; pending = new Set();
    const cur = roots.get(keyOf(R.root));
    if (cur && cur.delta) {
      for (const p of batch) {
        const k = p.toLowerCase();
        try {
          const st = await fsp.stat(p);
          cur.gone.delete(k);
          cur.delta.set(k, { p, n: path.basename(p), d: st.isDirectory() });
        } catch { cur.delta.delete(k); cur.gone.add(k); }
      }
    }
    timer = null;
    if (pending.size) timer = setTimeout(flush, 1000);
  };
  const watchSub = (name) => {
    const k = name.toLowerCase();
    if (subs.has(k) || skipped(name)) return;
    try {
      const w = fs.watch(base + name, { recursive: true, persistent: false }, (ev, rel) => rel && queue(name + '\\' + rel));
      w.on('error', () => { try { w.close(); } catch {} subs.delete(k); });
      subs.set(k, w);
    } catch {}
  };
  try {
    const top = fs.watch(R.root, { persistent: false }, (ev, rel) => {
      if (!rel) return;
      queue(rel);
      fs.stat(base + rel, (e, st) => { if (!e && st.isDirectory()) watchSub(rel); }); // a new top-level folder
    });
    top.on('error', () => {});
    for (const e of fs.readdirSync(R.root, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) watchSub(e.name);
    R.watcher = { close: () => { try { top.close(); } catch {} for (const w of subs.values()) try { w.close(); } catch {} } };
  } catch { R.watcher = null; }
}

function fullPath(R, i) { const d = R.dirs[R.parents[i]]; return d.endsWith('\\') ? d + R.names[i] : d + '\\' + R.names[i]; }

async function search({ q, under, prefer, max = 2000, statLimit = 400 }) {
  const t0 = Date.now();
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { items: [], ms: 0, indexed: true };
  const lead = words.reduce((a, b) => (b.length > a.length ? b : a));
  const rest = words.filter((w) => w !== lead);
  const u = under ? under.replace(/\\$/, '').toLowerCase() : null;
  const inside = (pl) => !u || pl.startsWith(u + '\\') || pl === u;
  const hits = [], seen = new Set();
  let covered = false;
  for (const R of roots.values()) {
    if (!R.blob) continue;
    const rl = R.root.replace(/\\$/, '').toLowerCase();
    if (u && !(u === rl || u.startsWith(rl + '\\') || rl.startsWith(u + '\\'))) continue;
    if (u && (u === rl || u.startsWith(rl + '\\'))) covered = true;
    const { blob, offs } = R;
    let pos = blob.indexOf(lead);
    while (pos !== -1 && hits.length < Math.max(max * 3, 20000)) { // rank among many, show the best few
      let lo = 0, hi = R.n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= pos) lo = mid; else hi = mid - 1; }
      const i = lo, nameEnd = offs[i + 1] - 1;
      const nm = blob.slice(offs[i], nameEnd);
      if (rest.every((w) => nm.includes(w))) {
        const p = fullPath(R, i), pl = p.toLowerCase();
        if (inside(pl) && !R.gone.has(pl) && !seen.has(pl)) { seen.add(pl); hits.push({ p, n: R.names[i], d: !!R.isDir[i], nm }); }
      }
      pos = blob.indexOf(lead, nameEnd + 1);
    }
    for (const [pl, x] of R.delta) {
      const nm = x.n.toLowerCase();
      if (words.every((w) => nm.includes(w)) && inside(pl) && !seen.has(pl)) { seen.add(pl); hits.push({ p: x.p, n: x.n, d: x.d, nm }); }
    }
  }
  // Best matches first: exact name, then name starting with the query, then folders, then the rest.
  const ql = words.join(' ');
  const pr = prefer ? prefer.replace(/\\$/, '').toLowerCase() + '\\' : null;
  const score = (h) => (pr && !h.p.toLowerCase().startsWith(pr) ? 8 : 0) + (pr && h.p.slice(0, h.p.length - h.n.length).toLowerCase() === pr ? -2 : 0) + (h.nm === ql ? 0 : h.nm.startsWith(words[0]) ? 1 : 2) * 2 + (h.d ? 0 : 1);
  hits.sort((a, b) => score(a) - score(b) || a.nm.localeCompare(b.nm));
  const top = hits.slice(0, max);
  // size / date for the results (the index keeps names only, to stay small)
  const out = top.map((h) => ({ n: h.n, p: h.p, d: h.d, s: 0, m: 0 }));
  const nStat = Math.min(top.length, statLimit);
  let k = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (k < nStat) {
      const j = k++, h = top[j];
      try { const st = await fsp.stat(h.p); out[j] = { n: h.n, p: h.p, d: st.isDirectory(), s: st.isDirectory() ? 0 : st.size, m: st.mtimeMs, c: st.birthtimeMs }; } catch { out[j] = null; }
    }
  }));
  return { items: out.filter(Boolean), total: hits.length, capped: hits.length > max, ms: Date.now() - t0, indexed: covered || !u };
}

function status() {
  return [...roots.values()].map((R) => ({ root: R.root, n: R.n || 0, at: R.at || 0, building: !!R.building, ready: !!R.blob }));
}

function post(m) { parentPort.postMessage(m); }

async function setRoots(list) {
  const want = new Set(list.map(keyOf));
  for (const [k, R] of roots) if (!want.has(k)) { try { R.watcher && R.watcher.close(); } catch {} roots.delete(k); }
  // load saved indexes first (instant), then build missing ones and refresh stale ones one at a time
  for (const r of list) if (!roots.has(keyOf(r))) { const R = await load(r); if (R) { watch(R); post({ event: 'loaded', root: r, n: R.n }); } }
  for (const r of list) {
    const R = roots.get(keyOf(r));
    if (!R || !R.blob) await build(r);
  }
  for (const r of list) {
    const R = roots.get(keyOf(r));
    if (R && R.at && Date.now() - R.at > 24 * 3600e3) await build(r); // live watching keeps it fresh in between
  }
}

parentPort.on('message', async (m) => {
  try {
    if (m.cmd === 'roots') { setRoots(m.roots).catch(() => {}); post({ id: m.id, ok: true }); }
    else if (m.cmd === 'search') post({ id: m.id, result: await search(m) });
    else if (m.cmd === 'status') post({ id: m.id, result: status() });
    else if (m.cmd === 'rebuild') { post({ id: m.id, ok: true }); for (const R of [...roots.values()]) await build(R.root); }
  } catch (e) { post({ id: m.id, error: String(e && e.message || e) }); }
});
