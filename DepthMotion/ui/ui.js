// DepthMotion UI — talks to the local engine (server.py) on the same origin.
const $ = (s) => document.querySelector(s);
const NAMES = { clay: 'Clay', depth: 'Depth', normal: 'Normal', color: 'Colour', tinted: 'Depth + people', people: 'People', compare: 'Compare', png16: '16-bit frames' };
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
  go.disabled = !st.clip || !passes().length || document.body.classList.contains('busy');
  go.textContent = st.uploading ? 'Reading the clip…' : 'Extract motion';
}

// ---------- run ----------
$('#go').addEventListener('click', async () => {
  const full = +tin.value === 0 && +tout.value === 1000;
  const body = { id: st.clip, start: full ? 0 : +t(tin.value).toFixed(3), end: full ? 0 : +t(tout.value).toFixed(3), passes: passes(),
    quality: st.quality, cutoff: +$('#iso').value / 100, invert: $('#invert').checked, ramp: st.ramp,
    people: $('#pplOn').checked ? (st.people === null ? 'auto' : st.people.length ? st.people : null) : null,
    onlyPeople: $('#pplOn').checked && $('#onlyPeople').checked };
  st.used = Array.isArray(body.people) ? body.people : [];
  const r = await fetch('/api/run', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return fail((await r.json()).error);
  document.body.classList.add('busy'); ready();
  show('work'); poll();
});
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
  const order = ['clay', 'tinted', 'people', 'depth', 'normal', 'color', 'compare'].filter((p) => j.files[p]);
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
  $('#copySeed').hidden = !j.files.clay;
  show('result');
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
    st.people = j.boxes.map((box, i) => ({ box, color: j.colors[i % j.colors.length] }));
    const img = $('#pplImg');
    img.onload = () => { $('#pplFrame').style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; drawPeople(); };
    img.src = j.frame;
    $('#pplMsg').textContent = st.people.length ? '' : 'Nobody found on the first frame. Move the in point to a frame where everyone is visible.';
  } catch (e) {
    if (ticket === finding) $('#pplMsg').textContent = e.message || 'Could not look for people.';
  }
}
function drawPeople() {
  const img = $('#pplImg'), W = img.naturalWidth, H = img.naturalHeight, svg = $('#pplBoxes');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  st.people.forEach((p, i) => {
    const [x1, y1, x2, y2] = p.box;
    const r = document.createElementNS(NS, 'rect');
    Object.entries({ x: x1 * W, y: y1 * H, width: (x2 - x1) * W, height: (y2 - y1) * H, rx: 6, stroke: p.color }).forEach(([k, v]) => r.setAttribute(k, v));
    const tx = document.createElementNS(NS, 'text');
    Object.entries({ x: x1 * W + 7, y: y1 * H + 18, fill: p.color }).forEach(([k, v]) => tx.setAttribute(k, v));
    tx.textContent = i + 1;
    svg.append(r, tx);
  });
  const chips = $('#pplChips'); chips.textContent = '';
  st.people.forEach((p, i) => {
    const c = document.createElement('span'); c.className = 'chip-p';
    const sw = document.createElement('button'); sw.className = 'sw'; sw.style.background = p.color; sw.title = 'Change colour';
    sw.addEventListener('click', () => {
      const taken = new Set(st.people.map((q) => q.color));
      let k = st.palette.indexOf(p.color);
      do k = (k + 1) % st.palette.length; while (taken.has(st.palette[k]) && st.palette[k] !== p.color);
      p.color = st.palette[k]; drawPeople();
    });
    const label = document.createElement('span'); label.textContent = `Person ${i + 1}`;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Leave this person grey';
    x.addEventListener('click', () => { st.people.splice(i, 1); drawPeople(); if (!st.people.length) $('#pplMsg').textContent = 'Nobody will be coloured.'; });
    c.append(sw, label, x); chips.append(c);
  });
}
