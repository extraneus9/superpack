// DepthMotion UI — talks to the local engine (server.py) on the same origin.
const $ = (s) => document.querySelector(s);
const NAMES = { clay: 'Clay', depth: 'Depth', normal: 'Normal', color: 'Colour', tinted: 'Depth + people', people: 'People', check: 'Check', compare: 'Compare', png16: '16-bit frames' };
const HUE = { '#e3262d': 'red', '#22c55e': 'green', '#3b82f6': 'blue', '#facc15': 'yellow', '#d946ef': 'magenta', '#06b6d4': 'cyan' };
const SEEDANCE = '@Video 1 is a clay blockout reference. Preserve the subjects\' body motion, timing, impacts, spatial layout, camera position and camera movement. Do not use its clay material, its colours or its empty background.';
function seedanceLine() {
  const ppl = st.used || [];
  if (!ppl.length) return SEEDANCE + ' The left clay figure in @Video 1 corresponds to <your character A>; the right clay figure corresponds to <your character B>.';
  const map = ppl.map((p, i) => `the ${HUE[p.color] || p.color} clay figure corresponds to <character ${String.fromCharCode(65 + i)}>`);
  return SEEDANCE + ' In @Video 1, ' + map.join('; ') + '.';
}

const st = { clip: null, dur: 0, quality: 'best', ramp: 'inferno', uploading: false, files: {}, people: null, palette: [], used: [] };
const src = $('#src'), tin = $('#tin'), tout = $('#tout');

// ---------- engine state ----------
fetch('/api/state').then((r) => r.json()).then((s) => {
  const g = $('#gpu');
  g.classList.add(s.gpu.ok ? 'ok' : 'bad');
  g.querySelector('span').textContent = s.gpu.ok ? `${s.gpu.name} · ${s.gpu.vram} GB` : s.gpu.name;
  if (!s.large) $('#quality [data-v=best] small').textContent = 'Large · downloads 1.5 GB once';
});
$('#lic').textContent = 'Best (Large model) is for non-commercial use · Fast is free for any use';
setInterval(() => fetch('/api/beat').catch(() => {}), 5000);

// ---------- source ----------
const pick = $('#file');
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('over'); });
document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) load(f); });
pick.addEventListener('change', () => pick.files[0] && load(pick.files[0]));
$('#swap').addEventListener('click', () => pick.click());

async function load(file) {
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) return fail('That doesn\'t look like a video file.');
  st.clip = null; st.uploading = true; ready();
  $('#drop').hidden = true; $('#clip').hidden = false;
  $('#clipname').textContent = file.name;
  src.src = URL.createObjectURL(file);
  try {
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Name': encodeURIComponent(file.name).replace(/%20/g, ' ') }, body: file });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    st.clip = j.id;
    st.people = null;
    if ($('#pplOn').checked) findPeople();
  } catch (e) { fail(e.message || 'Could not read that clip.'); }
  st.uploading = false; ready();
}
src.addEventListener('loadedmetadata', () => {
  st.dur = src.duration || 0;
  tin.value = 0; tout.value = 1000;
  $('#vlen').textContent = `${st.dur.toFixed(2)}s clip`;
  trim(); src.play();
});

// ---------- trim ----------
const t = (v) => (v / 1000) * st.dur;
function trim(moved) {
  if (+tin.value > +tout.value - 5) moved === tin ? (tin.value = +tout.value - 5) : (tout.value = +tin.value + 5);
  const a = +tin.value / 10, b = +tout.value / 10;
  $('#trim .sel').style.left = a + '%'; $('#trim .sel').style.right = (100 - b) + '%';
  $('#vin').textContent = t(tin.value).toFixed(2); $('#vout').textContent = t(tout.value).toFixed(2);
  $('#vlen').textContent = `${(t(tout.value) - t(tin.value)).toFixed(2)}s selected`;
  if (moved) src.currentTime = t(moved.value);
}
tin.addEventListener('input', () => trim(tin)); tout.addEventListener('input', () => trim(tout));
tin.addEventListener('change', () => $('#pplOn').checked && findPeople()); // people are found on the in-point frame
src.addEventListener('timeupdate', () => {
  if (!st.dur) return;
  if (src.currentTime >= t(tout.value) || src.currentTime < t(tin.value) - 0.05) src.currentTime = t(tin.value);
  $('#trim .head').style.left = `calc(${(src.currentTime / st.dur) * 100}% - 1px)`;
});

// ---------- options ----------
function single(sel, key) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(sel).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    st[key] = b.dataset.v;
  });
}
single('#quality', 'quality'); single('#ramp', 'ramp');
$('#passes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  b.classList.toggle('on');
  $('#rampRow').hidden = !$('#passes [data-v=color]').classList.contains('on');
  ready();
});
$('#iso').addEventListener('input', () => { const v = +$('#iso').value; $('#isoVal').textContent = v ? (v / 100).toFixed(2) : 'Off'; });
const passes = () => [...document.querySelectorAll('#passes .on')].map((b) => b.dataset.v);
function ready() {
  const go = $('#go');
  go.disabled = !st.clip || (!isLoc() && !passes().length) || document.body.classList.contains('busy') || (st.pre && !st.pre.ok);
  preflight();
  go.textContent = st.uploading ? 'Reading the clip…' : isLoc() ? 'Build location' : 'Extract motion';
}

// ---------- run ----------
// ---------- mode: extract the motion, or put it in a new location ----------
const loc = { style: 'ruins', seed: 7 };
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('#mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  document.body.classList.toggle('loc', b.dataset.v === 'location');
  ready();
});
single('#style', 'style');
$('#style').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) loc.style = b.dataset.v; });
$('#shuffle').addEventListener('click', () => { loc.seed = 1 + Math.floor(Math.random() * 9998); $('#seedVal').textContent = '#' + loc.seed; });
const sunName = (v) => (v < 10 ? 'Dusk' : v < 25 ? 'Golden hour' : v < 42 ? 'Afternoon' : 'Midday');
$('#sun').addEventListener('input', () => { $('#sunVal').textContent = sunName(+$('#sun').value); });
const isLoc = () => document.body.classList.contains('loc');

$('#go').addEventListener('click', async () => {
  const full = +tin.value === 0 && +tout.value === 1000;
  if (isLoc()) {
    const body = { id: st.clip, start: full ? 0 : +t(tin.value).toFixed(3), end: full ? 0 : +t(tout.value).toFixed(3),
      style: loc.style, seed: loc.seed, sun: +$('#sun').value, quality: st.quality,
      people: $('#pplOn').checked && st.people ? st.people : null, dest: lib.dest };
    st.used = coloured();
    return start('/api/location', body);
  }
  const body = { id: st.clip, start: full ? 0 : +t(tin.value).toFixed(3), end: full ? 0 : +t(tout.value).toFixed(3), passes: passes(),
    quality: st.quality, cutoff: +$('#iso').value / 100, invert: $('#invert').checked, ramp: st.ramp,
    people: $('#pplOn').checked && st.people ? (coloured().length ? coloured() : null) : null,
    onlyPeople: $('#pplOn').checked && $('#onlyPeople').checked };
  st.used = Array.isArray(body.people) ? body.people : [];
  body.dest = lib.dest;
  start('/api/run', body);
});
async function start(url, body) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return fail((await r.json()).error);
  document.body.classList.add('busy'); ready();
  show('work'); poll();
}
async function poll() {
  const j = await (await fetch('/api/status')).json();
  $('#pct').textContent = Math.round(j.frac * 100);
  $('#msg').textContent = j.msg;
  $('#barfill').style.transform = `scaleX(${j.frac})`;
  if (j.state === 'running') return setTimeout(poll, 400);
  document.body.classList.remove('busy'); ready();
  if (j.state === 'error') return fail(j.error);
  results(j);
}
function results(j) {
  st.files = j.files; st.folder = j.folder;
  const tabs = $('#tabs'); tabs.textContent = '';
  const order = ['tinted', 'clay', 'check', 'people', 'depth', 'normal', 'color', 'compare'].filter((p) => j.files[p]);
  for (const p of order) {
    const b = document.createElement('button');
    b.textContent = NAMES[p]; b.dataset.v = p;
    b.addEventListener('click', () => view(p));
    tabs.append(b);
  }
  if (j.files.png16) {
    const b = document.createElement('button');
    b.textContent = NAMES.png16 + ' ↗';
    b.addEventListener('click', () => fetch('/api/open', { method: 'POST', body: JSON.stringify({ path: j.files.png16 }) }));
    tabs.append(b);
  }
  $('#saved').textContent = j.folder;
  $('#copySeed').hidden = !j.files.clay && !j.files.tinted;
  $('#openBlend').hidden = $('#remerge').hidden = !j.blend;
  st.blend = j.blend; st.locFolder = j.folder;
  show('result');
  loadLibrary(j.folder);
  if (order.length) view(order[0]);
}
function view(p) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === p));
  const v = $('#view'), at = v.currentTime;
  v.src = '/out?p=' + encodeURIComponent(st.files[p]);
  v.addEventListener('loadedmetadata', () => { v.currentTime = at || 0; v.play(); }, { once: true });
}
$('#openFolder').addEventListener('click', () => fetch('/api/open', { method: 'POST', body: JSON.stringify({ path: Object.values(st.files)[0] || st.folder }) }));
$('#copySeed').addEventListener('click', async () => {
  await navigator.clipboard.writeText(seedanceLine());
  const b = $('#copySeed'); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy Seedance 2.5 line'), 1400);
});

// ---------- stage states ----------
function show(id) { for (const s of ['empty', 'work', 'result', 'err']) $('#' + s).hidden = s !== id; }
let back = 'empty';
function fail(msg) {
  back = $('#result').hidden ? 'empty' : 'result';
  $('#err p').textContent = msg; show('err');
}
$('#err button').addEventListener('click', () => show(back));

// ---------- people ----------
$('#pplOn').addEventListener('change', () => {
  $('#ppl').hidden = !$('#pplOn').checked;
  if ($('#pplOn').checked && st.clip && st.people === null) findPeople();
});
let finding = 0;
async function findPeople() {
  if (!st.clip) return;
  const ticket = ++finding;
  st.people = null;
  $('#pplMsg').textContent = 'Finding the people…'; $('#pplChips').textContent = ''; $('#pplBoxes').innerHTML = '';
  const start = +tin.value === 0 ? 0 : +t(tin.value).toFixed(3);
  try {
    const r = await fetch('/api/people', { method: 'POST', body: JSON.stringify({ id: st.clip, start }) });
    const j = await r.json();
    if (ticket !== finding) return;
    if (!r.ok) throw new Error(j.error);
    st.palette = j.colors;
    st.people = j.boxes.map((box) => ({ box, color: null }));  // nobody is coloured until you choose
    st.sel = 0;
    const img = $('#pplImg');
    img.onload = () => { $('#pplFrame').style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; drawPeople(); };
    img.src = j.frame;
    $('#pplMsg').textContent = st.people.length ? '' : 'Nobody found on the first frame. Move the in point to a frame where everyone is visible.';
    $('#pplHint').textContent = st.people.length ? `${st.people.length} ${st.people.length === 1 ? 'person' : 'people'} found — pick a colour for each one you want tinted.` : '';
  } catch (e) {
    if (ticket === finding) $('#pplMsg').textContent = e.message || 'Could not look for people.';
  }
}
const coloured = () => (st.people || []).filter((p) => p.color);
function drawPeople() {
  const img = $('#pplImg'), W = img.naturalWidth, H = img.naturalHeight, svg = $('#pplBoxes');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  st.people.forEach((p, i) => {
    const [x1, y1, x2, y2] = p.box;
    const r = document.createElementNS(NS, 'rect');
    Object.entries({ x: x1 * W, y: y1 * H, width: (x2 - x1) * W, height: (y2 - y1) * H, rx: 6, stroke: p.color || '#ffffff' }).forEach(([k, v]) => r.setAttribute(k, v));
    if (!p.color) r.classList.add('unset');
    r.style.strokeWidth = i === st.sel ? 4 : 2.5;
    r.addEventListener('click', () => { st.sel = i; drawPeople(); });
    const tx = document.createElementNS(NS, 'text');
    Object.entries({ x: x1 * W + 7, y: y1 * H + 18, fill: p.color || '#ffffff' }).forEach(([k, v]) => tx.setAttribute(k, v));
    tx.textContent = i + 1;
    svg.append(r, tx);
  });
  const rows = $('#pplChips'); rows.textContent = '';
  st.people.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'prow' + (i === st.sel ? ' sel' : '');
    row.addEventListener('click', () => { if (st.sel !== i) { st.sel = i; drawPeople(); } });
    const num = document.createElement('span'); num.className = 'num'; num.textContent = i + 1;
    if (p.color) { num.style.background = p.color; num.style.color = '#fff'; }
    const lab = document.createElement('span'); lab.className = 'lab';
    lab.innerHTML = `Person ${i + 1}<small>${p.color ? (HUE[p.color] || 'custom') : 'not coloured'}</small>`;
    const pal = document.createElement('div'); pal.className = 'pal';
    const none = document.createElement('button'); none.className = 'none' + (p.color ? '' : ' on'); none.title = 'Leave grey';
    none.addEventListener('click', (e) => { e.stopPropagation(); p.color = null; drawPeople(); });
    pal.append(none);
    for (const c of st.palette) {
      const b = document.createElement('button'); b.style.background = c; b.title = HUE[c] || c;
      if (p.color === c) b.classList.add('on');
      b.addEventListener('click', (e) => { e.stopPropagation(); st.people.forEach((q) => { if (q !== p && q.color === c) q.color = null; }); p.color = c; st.sel = i; drawPeople(); });
      pal.append(b);
    }
    const custom = document.createElement('label'); custom.title = 'Any colour';
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = p.color && !HUE[p.color] ? p.color : '#ff7a00';
    inp.addEventListener('input', () => { p.color = inp.value; });
    inp.addEventListener('change', () => { p.color = inp.value; drawPeople(); });
    if (p.color && !HUE[p.color]) custom.classList.add('on');
    custom.append(inp); pal.append(custom);
    row.append(num, lab, pal); rows.append(row);
  });
}

// ---------- the location's .blend: edit it in Blender, then re-merge ----------
$('#openBlend').addEventListener('click', () => fetch('/api/openblend', { method: 'POST', body: JSON.stringify({ path: st.blend }) }));
$('#remerge').addEventListener('click', () => start('/api/remerge', { folder: st.locFolder, quality: st.quality }));
fetch('/api/state').then((r) => r.json()).then((s) => { $('#blenderHint').hidden = !!s.blender; });

// ---------- library: real folders (synced with Foldernator through desktop.ini) ----------
const lib = { dest: null, statuses: [], closed: new Set(JSON.parse(localStorage.getItem('dm-closed') || '[]')), openScene: null };
async function loadLibrary(focus) {
  const j = await (await fetch('/api/library')).json();
  lib.statuses = j.statuses; lib.root = j.tree.path;
  if (!lib.dest) lib.dest = lib.root;
  $('#openLib').textContent = j.foldernator ? 'Open in Foldernator' : 'Open folder';
  if (focus) lib.openScene = focus;
  const tree = $('#libTree'); tree.textContent = '';
  tree.append(folderNode(j.tree, 0));
  const d = lib.dest === lib.root ? 'Library' : lib.dest.split(/[\\/]/).pop();
  $('#destName').textContent = d;
}
const statusColor = (n) => n.color || (lib.statuses.find((s) => s.key === n.status) || {}).color;
function folderNode(n, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div'); row.className = 'row' + (n.path === lib.dest ? ' dest' : '') + (lib.closed.has(n.path) ? ' closed' : '');
  row.innerHTML = `<span class="car">▾</span><span class="fi"></span><span class="nm"></span>`;
  row.querySelector('.nm').textContent = n.name;
  const c = statusColor(n); if (c) row.querySelector('.fi').style.background = c;
  row.addEventListener('click', (e) => {
    if (e.target.classList.contains('car')) { toggle(n.path); return; }
    lib.dest = n.path; loadLibrary();
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e, n, 'folder', depth === 0); });
  dropTarget(row, n.path);
  if (depth > 0) { row.draggable = true; row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/dm-path', n.path)); }
  const kids = document.createElement('div'); kids.className = 'kids' + (lib.closed.has(n.path) ? ' hide' : '');
  for (const f of n.folders) kids.append(folderNode(f, depth + 1));
  for (const sc of n.scenes) kids.append(sceneRow(sc));
  wrap.append(row, kids);
  return wrap;
}
function sceneRow(sc) {
  const row = document.createElement('div'); row.className = 'row' + (sc.path === lib.openScene ? ' open-scene' : '');
  row.draggable = true;
  const th = document.createElement(sc.thumb ? 'img' : 'span'); th.className = 'th';
  if (sc.thumb) th.src = '/thumb?p=' + encodeURIComponent(sc.thumb);
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = sc.name; nm.title = `${sc.name}${sc.clip ? ' · from ' + sc.clip : ''}${sc.made ? ' · ' + sc.made : ''}`;
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = sc.kind === 'location' ? (sc.style || 'location') : '';
  const dot = document.createElement('span'); dot.className = 'dot'; const c = statusColor(sc); dot.style.background = c || 'transparent';
  row.append(th, nm, kind, dot);
  row.addEventListener('click', () => openScene(sc.path));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e, sc, 'scene'); });
  row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/dm-path', sc.path));
  return row;
}
function toggle(p) {
  lib.closed.has(p) ? lib.closed.delete(p) : lib.closed.add(p);
  try { localStorage.setItem('dm-closed', JSON.stringify([...lib.closed])); } catch { /* fine */ }
  loadLibrary();
}
function dropTarget(row, into) {
  row.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/dm-path')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drop'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', async (e) => {
    const p = e.dataTransfer.getData('text/dm-path'); row.classList.remove('drop');
    if (!p) return; e.preventDefault(); e.stopPropagation();
    await act('move', { path: p, into });
  });
}
async function act(op, body) {
  const r = await fetch('/api/library/' + op, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) fail(j.error);
  await loadLibrary();
  return j;
}
async function openScene(p) {
  const r = await fetch('/api/scene?p=' + encodeURIComponent(p));
  if (!r.ok) return fail('That scene has no videos yet.');
  const j = await r.json();
  lib.openScene = p; loadLibrary();
  results({ files: j.files, folder: j.folder, blend: j.blend });
}
function menu(e, n, kind, isRoot) {
  const m = $('#menu'); m.textContent = ''; m.hidden = false;
  const item = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', () => { m.hidden = true; fn(); }); m.append(b); return b; };
  if (kind === 'folder') item('New folder here', () => ask('New folder', '', (name) => act('mkdir', { parent: n.path, name })));
  if (kind === 'folder') item('Save new results here', () => { lib.dest = n.path; loadLibrary(); });
  if (!isRoot) item('Rename', () => ask('Rename', n.name, (name) => act('rename', { path: n.path, name })));
  if (!isRoot) {
    m.append(document.createElement('hr'));
    for (const s of lib.statuses) {
      const b = item(s.label, () => act('status', { path: n.path, status: s.key }));
      const d = document.createElement('span'); d.className = 'dot'; d.style.background = s.color; b.prepend(d);
    }
    item('No status', () => act('status', { path: n.path, status: null }));
  }
  m.append(document.createElement('hr'));
  item($('#openLib').textContent, () => act('open', { path: n.path }));
  if (!isRoot) item('Delete (to the Recycle Bin)', () => { if (confirm(`Move "${n.name}" to the Recycle Bin?`)) act('trash', { path: n.path }); }, 'danger');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}
function ask(title, value, done) {
  const m = $('#menu'); m.textContent = ''; m.hidden = false;
  const inp = document.createElement('input'); inp.value = value; inp.placeholder = title;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { m.hidden = true; done(inp.value.trim()); } if (e.key === 'Escape') m.hidden = true; });
  m.append(inp); setTimeout(() => { inp.focus(); inp.select(); }, 0);
}
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
$('#newFolder').addEventListener('click', () => {
  const m = $('#menu'); const b = $('#newFolder').getBoundingClientRect();
  ask('New folder', '', (name) => act('mkdir', { parent: lib.dest || lib.root, name }));
  m.style.left = b.left + 'px'; m.style.top = b.bottom + 6 + 'px';
});
$('#openLib').addEventListener('click', () => act('open', { path: lib.dest || lib.root }));
loadLibrary();

// ---------- memory: a live gauge, and a pre-check before you generate ----------
const gb = (x) => `${(+x).toFixed(1)} GB`;
async function meter() {
  try {
    const r = await (await fetch('/api/resources')).json();
    const ramUsedFrac = 1 - r.ram_free / r.ram_total;
    const bar = $('#ramBar');
    bar.style.width = `${Math.max(3, (r.ram_free / r.ram_total) * 100)}%`;
    bar.className = r.ram_free < r.reserve + 1 ? 'bad' : r.ram_free < r.reserve + 3 ? 'warn' : '';
    $('#ramRes').style.width = `${(r.reserve / r.ram_total) * 100}%`;
    $('#ramTxt').textContent = `${gb(r.ram_free)} free`;
    $('#mem').title = `RAM: ${gb(r.ram_free)} free of ${gb(r.ram_total)} — DepthMotion always leaves ${gb(r.reserve)} for your other apps (the striped part).\nVRAM: ${gb(r.vram_free)} free of ${gb(r.vram_total)} — the heavy work goes here.`;
    $('#vramBar').style.width = r.vram_total ? `${Math.max(3, (r.vram_free / r.vram_total) * 100)}%` : '0';
    $('#vramTxt').textContent = r.vram_total ? `${gb(r.vram_free)} free` : 'no card';
    st.top = r.top; st.res = r;
    // a job started from outside this window (e.g. by Claude): follow it live
    if (r.busy && !document.body.classList.contains('busy')) { document.body.classList.add('busy'); ready(); show('work'); poll(); }
    if (st.clip && !document.body.classList.contains('busy')) preflight(true);
    st.misses = 0;
  } catch {
    // the engine is busy starting — or gone: say so instead of sitting there dead
    st.misses = (st.misses || 0) + 1;
    if (st.misses === 4) fail('DepthMotion\'s engine stopped. Close this window and open DepthMotion again.');
  }
}
let preTimer = 0;
function preflight(now) {
  clearTimeout(preTimer);
  preTimer = setTimeout(async () => {
    const card = $('#pre');
    if (!st.clip) { card.hidden = true; return; }
    const full = +tin.value === 0 && +tout.value === 1000;
    const body = { id: st.clip, start: full ? 0 : +t(tin.value).toFixed(3), end: full ? 0 : +t(tout.value).toFixed(3),
      mode: isLoc() ? 'location' : 'extract', people: $('#pplOn').checked };
    try {
      const p = await (await fetch('/api/preflight', { method: 'POST', body: JSON.stringify(body) })).json();
      if (p.error) return;
      const was = st.pre && st.pre.ok; st.pre = p;
      card.hidden = false;
      card.className = 'tile ' + (!p.ok ? 'bad' : p.reduced ? 'warn' : 'ok');
      $('#preVerdict').textContent = !p.ok ? '✕ Not enough memory right now' : p.reduced ? `⚠ Will run at ${p.res}px to fit` : '✓ Ready at full quality';
      $('#preNums').textContent = `needs ${gb(p.need)} · ${gb(Math.max(0, p.room))} available`;
      const scale = Math.max(p.need_full, p.room, 0.1) * 1.15;
      $('#preNeed').style.width = `${Math.min(100, (p.need / scale) * 100)}%`;
      $('#preRoom').style.left = `calc(${Math.max(0, Math.min(100, (p.room / scale) * 100))}% - 1px)`;
      $('#preNote').textContent = !p.ok
        ? `This clip needs about ${gb(p.need)}; your PC can spare ${gb(Math.max(0, p.room))} right now (DepthMotion keeps ${gb(st.res ? st.res.reserve : 3)} for your other apps). Free about ${gb(p.short_by)} — or trim the clip shorter.`
        : p.reduced ? `Your PC is busy, so it works at ${p.res}px instead of 1280px. Free about ${gb(p.need_full - p.room)} for full quality.`
          : `Fits with room to spare. ${p.tracker_on_gpu ? 'The heavy tracking runs on your graphics card.' : ''}`;
      const tips = (st.top || []).slice(0, 5);
      $('#preTips').hidden = p.ok && !p.reduced || !tips.length;
      $('#preList').innerHTML = '';
      for (const a of tips) {
        const li = document.createElement('li');
        li.innerHTML = `<span></span><em></em>`;
        li.firstChild.textContent = a.app + (a.windows > 1 ? ` (${a.windows})` : '');
        li.lastChild.textContent = `~${gb(a.gb)}`;
        $('#preList').append(li);
      }
      if (was !== p.ok) ready();
    } catch { /* ignore */ }
  }, now ? 0 : 350);
}
meter(); setInterval(meter, 4000);
['change', 'input'].forEach((ev) => { tin.addEventListener(ev, () => preflight()); tout.addEventListener(ev, () => preflight()); });
$('#pplOn').addEventListener('change', () => preflight());
$('#mode').addEventListener('click', () => preflight());
