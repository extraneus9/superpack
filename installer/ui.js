// superpack setup — the window. Welcome → pick (nothing picked yet; "More info" on each app) → install → done / not finished.
const $ = (s) => document.querySelector(s);
const TYPE = { superpack: 'superpack', done: 'all-set', failed: 'not-done' };
const CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.3l2.4 2.4 4.6-5"/></svg>';
const ogg = (id) => `<img class="ogg" src="assets/type/${id}.png" alt="">`;
const gb = (b) => (b >= 1e9 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let M = null;          // manifest (+ each app's words from apps.json)
const S = { picked: new Set(), tasks: { playerdefault: true, framehudstart: true, desktopicons: false, sourcecode: false }, order: [], fills: {}, status: {}, phase: 'welcome', sheet: null };
const single = () => M.mode === 'single';
const mac = () => M.platform === 'darwin';
const app = (k) => M.apps.find((a) => a.key === k);

(async () => {
  M = await window.setup.manifest();
  document.body.classList.add(single() ? 'single' : 'pack');
  document.body.classList.toggle('many', !single() && M.apps.length > 4); // 5+ apps: compact tiles, three rows
  document.body.classList.toggle('lots', !single() && M.apps.length > 6); // 7+ apps: three columns, so it stays three rows
  // one app on its own is already "picked"; in the pack nobody is — people choose
  if (single()) S.picked.add(M.apps[0].key);
  welcome();
  setTitle(single() ? `t-${M.apps[0].key}` : TYPE.superpack, true);
  $('#grid').innerHTML = M.apps.map((a) => `
    <button class="tile" data-k="${a.key}">
      <span class="ck">${CHECK}</span>
      <img class="ic" src="assets/icons/${a.key}.png" alt="">
      <div>${single() ? '' : `<div class="nm">${ogg(`n-${a.key}`)}</div>`}
        <div class="ds">${esc(a.desc)}</div>
        <div class="sz">${a.size}${a.extra ? ` · ${esc(a.extra)}` : ''}<span class="more-wrap"> · <span class="more" data-k="${a.key}">More info</span></span></div></div>
      <span class="fill"></span>
      <span class="open" data-exe="${esc(a.exe)}">Open</span>
    </button>`).join('');
  $('#opts').innerHTML = [
    // (Windows-only options: on a Mac the apps go to Applications and you pick default apps in Finder › Get Info)
    !mac() && M.apps.some((a) => a.key === 'player') ? `<button class="opt on" data-t="playerdefault"><span class="sw"></span>Make the player my video &amp; audio player <small>Windows asks you to confirm</small></button>` : '',
    !mac() && M.apps.some((a) => a.key === 'framehud') ? `<button class="opt on" data-t="framehudstart"><span class="sw"></span>Start FrameHUD with Windows <small>then it never asks for admin</small></button>` : '',
    !mac() ? `<button class="opt" data-t="desktopicons"><span class="sw"></span>Desktop shortcuts</button>` : '',
    `<button class="opt" data-t="sourcecode"><span class="sw"></span>Save the source code too <small>to Documents · open source, yours to change</small></button>`,
  ].join('');
  document.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', (e) => {
    if (e.target.classList.contains('open')) { window.setup.open(e.target.dataset.exe); return; }
    if (e.target.classList.contains('more')) { openSheet(e.target.dataset.k); return; }
    if (S.phase !== 'pick' || single()) return;
    toggle(t.dataset.k);
  }));
  document.querySelectorAll('.opt').forEach((o) => o.addEventListener('click', () => {
    S.tasks[o.dataset.t] = !S.tasks[o.dataset.t];
    o.classList.toggle('on', S.tasks[o.dataset.t]);
  }));
  $('#min').onclick = () => window.setup.minimize();
  $('#oss').onclick = () => window.setup.repo();
  $('#close').onclick = () => window.setup.close();
  $('#go').onclick = () => {
    if (S.phase === 'welcome') return toPick();
    if (S.phase === 'pick' || S.phase === 'failed') return install();
    window.setup.quit();
  };
  $('#alt').onclick = () => {
    if (S.phase === 'pick') return toWelcome();
    if (S.phase === 'failed') return window.setup.classic();
  };
  $('#sheet .scrim').onclick = closeSheet;
  $('#c-close').onclick = closeSheet;
  $('#c-pick').onclick = () => { if (S.sheet && !single() && S.phase === 'pick') { toggle(S.sheet); paintSheet(); } else closeSheet(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sheet) closeSheet();
    if (e.key === 'Enter' && !S.sheet && !$('#go').disabled && (S.phase === 'welcome' || S.phase === 'pick')) $('#go').click();
  });
  window.setup.onProgress(onProgress);
  paintFooter();
  // entrance: text, then the app icons settle in one after another
  document.querySelectorAll('.w-art img').forEach((im, i) => { im.style.transitionDelay = `${160 + i * 90}ms`; });
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('enter')));
  setTimeout(() => document.querySelectorAll('.w-art img').forEach((im) => { im.style.transitionDelay = ''; }), 1400);
  if (M.fake) demo();
  else if (M.qa) qaRun();
})();

// ---------- welcome ----------
function welcome() {
  const one = single() ? M.apps[0] : null;
  $('#w-kicker').textContent = one ? `${one.name} · made by alva` : 'superpack · apps by alva';
  $('#w-p1').textContent = one
    ? `Thanks for installing ${one.name}. I built it by hand, for my own creative work, and I'm giving it to you for free.`
    : 'Thanks for installing superpack. I built every one of these apps by hand, for my own creative work, and I\'m giving them to you for free.';
  $('#w-p2').textContent = `${one ? "It's" : "They're"} made to be easy to use and to bend to the way you work — change the look, the keys, the motion, almost everything. No accounts, no ads, nothing sent anywhere.`;
  // the apps, scattered like stickers
  const spots = one ? [[60, 70, 180, -5]] : [[10, 20, 118, -8], [150, 0, 104, 7], [30, 168, 104, 5], [164, 150, 120, -6], [96, 96, 88, 9], [6, 100, 80, -10], [196, 84, 84, 11]];
  // (positions set through the DOM: the window's security policy ignores inline style attributes)
  $('#w-art').innerHTML = '';
  M.apps.slice(0, spots.length).forEach((a, i) => {
    const [x, y, s, r] = spots[i];
    const im = document.createElement('img');
    im.src = `assets/icons/${a.key}.png`; im.alt = '';
    Object.assign(im.style, { left: `${x}px`, top: `${y}px`, width: `${s}px`, height: `${s}px`, transform: `rotate(${r}deg)` });
    $('#w-art').appendChild(im);
  });
}
function toPick() {
  S.phase = 'pick';
  document.body.classList.remove('welcome');
  $('#hint').innerHTML = single() ? 'It starts clean, ready to set up your own way.' : 'Pick the apps you want — each one starts clean.';
  paintFooter();
}
function toWelcome() {
  S.phase = 'welcome';
  document.body.classList.add('welcome');
  paintFooter();
}

// ---------- picking ----------
function toggle(k) {
  S.picked.has(k) ? S.picked.delete(k) : S.picked.add(k);
  paintFooter();
}
function paintFooter() {
  const picked = M.apps.filter((a) => S.picked.has(a.key));
  document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('on', S.picked.has(t.dataset.k)));
  const pd = document.querySelector('.opt[data-t="playerdefault"]');
  if (pd) pd.hidden = !S.picked.has('player');
  const fh = document.querySelector('.opt[data-t="framehudstart"]');
  if (fh) fh.hidden = !S.picked.has('framehud');
  const go = $('#go'), alt = $('#alt');
  go.className = 'go';
  if (S.phase === 'welcome') {
    $('#sum').innerHTML = single() ? `<b>${esc(M.apps[0].name)}</b> · ${M.apps[0].size}` : `<b>${M.apps.length} apps</b> · you choose which ones next`;
    go.disabled = false; go.textContent = single() ? 'Continue' : 'Choose your apps';
    alt.hidden = true;
    return;
  }
  const bytes = picked.reduce((n, a) => n + a.bytes, 0);
  const extra = picked.some((a) => a.extra) ? ' + AI models' : '';
  $('#sum').innerHTML = single()
    ? `<b>${esc(M.apps[0].name)}</b> · ${gb(bytes)}${extra}`
    : picked.length ? `<b>${picked.length} of ${M.apps.length}</b> apps · ${gb(bytes)}${extra}` : 'Click an app to pick it.';
  go.disabled = !picked.length;
  go.textContent = single() ? 'Install' : !picked.length ? 'Pick an app' : `Install ${picked.length} app${picked.length > 1 ? 's' : ''}`;
  alt.hidden = false; alt.textContent = 'Back';
}

// ---------- more info ----------
function openSheet(k) {
  S.sheet = k;
  const a = app(k);
  $('#c-ic').src = `assets/icons/${k}.png`;
  $('#c-name').innerHTML = ogg(`n-${k}`);
  $('#c-desc').textContent = a.desc;
  $('#c-lead').textContent = (mac() && a.lead_mac) || a.lead || '';
  $('#c-points').innerHTML = ((mac() && a.points_mac) || a.points || []).map((p) => `<li>${esc(p)}</li>`).join('');
  $('#c-note').textContent = (mac() && a.note_mac) || a.note || '';
  $('#c-size').textContent = `${a.size}${a.extra ? ` ${a.extra}` : ''}`;
  paintSheet();
  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
}
function paintSheet() {
  const b = $('#c-pick');
  if (single() || S.phase !== 'pick') { b.className = 'go dark'; b.textContent = 'Got it'; return; }
  const on = S.picked.has(S.sheet);
  b.className = on ? 'go dark' : 'go';
  b.textContent = on ? 'Picked ✓' : 'Pick this app';
}
function closeSheet() {
  S.sheet = null;
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
}

function setTitle(id, first) {
  const box = $('#title');
  const old = box.querySelector('.ogg');
  if (old && old.dataset.id === id) return;
  box.insertAdjacentHTML('beforeend', ogg(id));
  const img = box.lastElementChild;
  img.dataset.id = id;
  if (first || !old) return;
  img.classList.add('in');
  old.classList.add('out');
  requestAnimationFrame(() => requestAnimationFrame(() => img.classList.remove('in')));
  setTimeout(() => old.remove(), 600);
}

// ---------- installing ----------
async function install() {
  closeSheet();
  S.phase = 'installing';
  S.order = M.apps.filter((a) => S.picked.has(a.key));
  S.fills = {}; S.status = {};
  document.body.classList.remove('failed', 'done');
  document.body.classList.add('installing', 'busy');
  $('#alt').hidden = true;
  setTitle(single() ? `t-${M.apps[0].key}` : TYPE.superpack);
  document.querySelectorAll('.tile').forEach((t) => {
    const on = S.picked.has(t.dataset.k);
    t.classList.remove('on', 'ok', 'now');
    t.classList.toggle('skip', !on);
    t.classList.toggle('wait', on);
    if (!on) t.querySelector('.ds').textContent = 'Not selected';
    else setStatus(t.dataset.k, 'Waiting');
    t.querySelector('.fill').style.transform = 'scaleX(0)';
  });
  $('#hint').innerHTML = 'Starting… <b>0%</b>';
  $('#sum').textContent = mac() ? 'Copying your apps into Applications…' : 'Windows may ask for permission — click Yes.';
  const go = $('#go'); go.disabled = true; go.className = 'go'; go.textContent = 'Installing…';
  const tasks = Object.keys(S.tasks).filter((k) => S.tasks[k] && (k !== 'playerdefault' || S.picked.has('player')) && (k !== 'framehudstart' || S.picked.has('framehud')));
  const res = await window.setup.install(S.order.map((a) => a.key), tasks);
  document.body.classList.remove('installing', 'busy');
  if (res.ok) finish(tasks); else fail(res);
}

// where each app's tile stands, 0..1, from one progress message
const NMW = { files: [0, .35], 'ollama-download': [.35, .5], 'ollama-install': [.5, .55], model: [.55, .9], speech: [.9, .98] };
// apps that download after their files: their tile only fills this far while copying
const AFTER = { nomorewriting: NMW.files[1], depthmotion: .1 };
const DONE = 'Installed ✓';
function onProgress(m) {
  if (S.phase !== 'installing' || !m || m.step === 'done') return;
  const total = S.order.reduce((n, a) => n + a.bytes, 0);
  if (m.step === 'files') {
    let cum = 0;
    const cur = S.order.findIndex((x) => x.key === m.app);
    S.order.forEach((a, i) => {
      const start = (cum / total) * 1000, share = (a.bytes / total) * 1000;
      let f = Math.max(0, Math.min(1, (m.p - start) / share));
      if (i < cur) f = 1; // an earlier app is finished
      if (a.key === m.app && f >= 1) f = .995;
      const tileF = AFTER[a.key] ? f * AFTER[a.key] : f;
      if (f > 0) setFill(a.key, tileF, a.key === m.app ? `Installing… <span class="pct">${Math.round(f * 100)}%</span>` : f >= 1 && !AFTER[a.key] ? DONE : null);
      cum += a.bytes;
    });
  } else {
    // after the files: every app is copied; the player connects to Windows, No More Writing fetches its models
    for (const a of S.order) if (!AFTER[a.key] && a.key !== m.app && S.status[a.key] !== DONE) setFill(a.key, 1, DONE);
    if (m.step === 'register') setFill('player', .995, 'Connecting it to Windows…');
    if (m.step === 'engine') setFill('depthmotion', .12, 'Downloading its AI engine (about 3 GB)…');
    if (m.app !== 'depthmotion' && S.fills.depthmotion >= .12) setFill('depthmotion', 1, DONE);
    if (NMW[m.step]) {
      const [lo, hi] = NMW[m.step];
      const f = m.p > 0 ? m.p / 1000 : 0;
      const label = {
        'ollama-download': `Downloading Ollama — <span class="pct">${Math.round(f * 100)}%</span>`,
        'ollama-install': 'Installing Ollama…',
        model: f ? `Downloading its writing model — <span class="pct">${Math.round(f * 100)}%</span>` : 'Downloading its writing model (3.3 GB)…',
        speech: 'Downloading its speech model (1.6 GB)…',
      }[m.step];
      setFill('nomorewriting', lo + f * (hi - lo), label);
    }
  }
  const pct = Math.round((S.order.reduce((n, a) => n + (S.fills[a.key] || 0) * a.bytes, 0) / total) * 100);
  const now = S.order.find((a) => a.key === m.app) || S.order.find((a) => (S.fills[a.key] || 0) < 1);
  $('#hint').innerHTML = `Installing — <b>${Math.min(pct, 99)}%</b>`;
  const n = S.order.filter((a) => (S.fills[a.key] || 0) >= 1).length;
  $('#sum').innerHTML = now ? `<b>${Math.min(n + 1, S.order.length)} of ${S.order.length}</b> · ${esc(now.name)}` : '';
  if (M.fake) demoTick(m);
}
function setFill(k, f, label) {
  S.fills[k] = Math.max(S.fills[k] || 0, f);
  const t = document.querySelector(`.tile[data-k="${k}"]`);
  if (!t) return;
  t.querySelector('.fill').style.transform = `scaleX(${S.fills[k]})`;
  t.classList.toggle('ok', S.fills[k] >= 1);
  t.classList.toggle('now', S.fills[k] > 0 && S.fills[k] < 1);
  t.classList.toggle('wait', !S.fills[k]);
  if (label) setStatus(k, label);
}
function setStatus(k, html) {
  const t = document.querySelector(`.tile[data-k="${k}"]`);
  if (t && S.status[k] !== html) { S.status[k] = html; t.querySelector('.ds').innerHTML = html; }
}

function finish(tasks) {
  S.phase = 'done';
  document.body.classList.add('done');
  S.order.forEach((a) => setFill(a.key, 1, DONE));
  setTitle(TYPE.done);
  $('#hint').innerHTML = single() ? 'Installed.' : `<b>${S.order.length}</b> app${S.order.length > 1 ? 's' : ''} installed`;
  $('#sum').textContent = (mac() ? 'Find them in Applications and Launchpad.'
    : tasks.includes('playerdefault') ? 'In Default apps, pick the player. Find everything in the Start menu.' : 'Find them in the Start menu any time.')
    + (tasks.includes('sourcecode') ? ' The code is in Documents › superpack source code.' : '');
  const go = $('#go'); go.disabled = false; go.className = 'go dark'; go.textContent = 'Done';
}

function fail(res) {
  S.phase = 'failed';
  document.body.classList.add('failed');
  document.querySelectorAll('.tile').forEach((t) => { t.classList.remove('now', 'wait', 'ok'); t.classList.toggle('skip', !S.picked.has(t.dataset.k)); });
  S.order.forEach((a) => { setStatus(a.key, 'Not installed'); document.querySelector(`.tile[data-k="${a.key}"] .fill`).style.transform = 'scaleX(0)'; });
  S.fills = {};
  setTitle(TYPE.failed);
  $('#hint').textContent = res.why === 'cancelled' ? 'Windows permission was declined.' : 'Something stopped the install.';
  $('#sum').textContent = res.why === 'cancelled' ? 'Installing needs your OK once. Nothing was changed.' : 'Nothing was left half-installed. You can try again, or use the classic installer.';
  $('#alt').hidden = mac(); $('#alt').textContent = 'Classic installer'; // (no classic installer on a Mac)
  const go = $('#go'); go.disabled = false; go.className = 'go'; go.textContent = 'Try again';
}

// ---------- QA: real install (off-screen) and screenshots (--fake) ----------
async function qaRun() {
  await wait(1100); await window.setup.shot('e0-welcome');
  toPick(); M.apps.forEach((a) => S.picked.add(a.key)); paintFooter();
  S.tasks.sourcecode = true; document.querySelector('.opt[data-t="sourcecode"]').classList.add('on');
  await wait(700); await window.setup.shot('e1-pick');
  install();
}
const shotsTaken = new Set();
async function demo() {
  await wait(1400); await window.setup.shot('0-welcome');
  toPick(); await wait(800); await window.setup.shot('1-pick-empty');
  if (!single()) { ['player', 'foldernator', 'nomorewriting'].forEach((k) => S.picked.add(k)); paintFooter(); }
  await wait(400); await window.setup.shot('1-pick');
  openSheet(single() ? M.apps[0].key : 'player'); await wait(800); await window.setup.shot('1b-more-player');
  if (!single()) { openSheet('nomorewriting'); await wait(300); await window.setup.shot('1c-more-nmw'); }
  if (!single() && M.apps.some((a) => a.key === 'framehud')) {
    closeSheet(); S.picked.add('framehud'); paintFooter(); await wait(500); await window.setup.shot('1d-pick-framehud');
    openSheet('framehud'); await wait(800); await window.setup.shot('1e-more-framehud');
  }
  closeSheet(); await wait(500);
  install();
}
async function demoTick(m) {
  const pct = parseInt($('#hint b').textContent, 10);
  if (!shotsTaken.has('2') && m.step === 'files' && pct >= 40) { shotsTaken.add('2'); await wait(450); window.setup.shot('2-installing'); }
  if (!shotsTaken.has('3') && m.step === 'model' && m.p >= 500) { shotsTaken.add('3'); await wait(450); window.setup.shot('3-downloads'); }
}
new MutationObserver(async () => {
  if (!M) return;
  const end = S.phase === 'done' || S.phase === 'failed';
  if (M.qa && !M.fake && end && !shotsTaken.has('end')) { shotsTaken.add('end'); await wait(900); await window.setup.shot(`e2-${S.phase}`); window.setup.quit(); }
  if (M.fake && S.phase === 'done' && !shotsTaken.has('4')) { shotsTaken.add('4'); await wait(900); await window.setup.shot('4-done'); window.setup.quit(); }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
