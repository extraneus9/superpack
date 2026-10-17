// "Do it manually": a walkthrough of Windows Settings (the author: "go to Settings, select this, click here") showing the
// per-app "Show notification banners" checkbox — the same setting bloom's switch turns off for every app at once.
// Each slide is a mock Windows 11 screen. The cursor aims at the REAL position of the thing to click
// (measured from the slide's own layout), so it always lands on the button even when the window is resized.
(function () {
  const CURSOR = '<svg class="cur" viewBox="0 0 20 24"><path d="M2 1.5v18.2l4.6-4.4 3.1 7.1 3-1.3-3.1-7h6.3z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="#9cc8ff" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>';
  const DESK = '<div class="mwin"></div><div class="mtb"><i class="startb"></i><i></i><i></i><i></i><i></i><i></i></div><div class="mclock">4:12 PM<br>10/16/2026</div>';
  const FX = '<div class="rip r1"></div><div class="rip r2"></div>' + CURSOR;
  const NAV = (on) => `<nav>${['Home', 'System', 'Bluetooth & devices', 'Network & internet', 'Personalization', 'Apps'].map((n) => `<span${n === on ? ' class="navon"' : ''}>${n}</span>`).join('')}</nav>`;
  // Settings › System › Notifications: the "Notifications from apps and other senders" list (click the NAME, not the switch)
  const APP = (cls, color, name) => `<div class="rw app ${cls}"><i class="ai" style="background:${color}"></i><span class="nm">${name}<small>Banners, Sounds</small></span><i class="tg on"></i><span class="chev">›</span></div>`;
  const APP_LIST = '<h6>Notifications from apps and other senders</h6>' + APP('', '#d97757', 'Claude') + APP('', '#3b82f6', 'Snipping Tool') + APP('wa', '#25d366', 'WhatsApp') + APP('', '#e8eaed', 'Google Chrome');
  // the app's own page: the two pictures with their checkboxes (only the banner one gets unticked)
  const APP_PAGE = '<div class="rw"><span>Notifications</span><i class="tg on"></i></div><div class="tiles">'
    + '<div class="tile2 b"><div class="pv"><i></i></div><span><i class="cbx banner"></i>Show notification banners</span></div>'
    + '<div class="tile2 c"><div class="pv center"><i></i><i></i><b></b></div><span><i class="cbx"></i>Show notifications in notification center</span></div></div>';

  const STEPS = [
    { title: 'Open Settings', text: 'Click Start, then Settings', sub: 'Or press Windows + I on your keyboard.',
      mode: 'two', targets: ['.startb', '.gear'],
      html: DESK + '<div class="startm"><div class="ssearch">Search for apps, settings, and documents</div><b class="spin">Pinned</b><div class="sgrid">'
        + '<span><i></i>Edge</span><span><i></i>Mail</span><span><i></i>Photos</span><span class="gear">' + GEAR + 'Settings</span><span><i></i>Store</span><span><i></i>Files</span>'
        + '<span><i></i>Calendar</span><span><i></i>Clock</span><span><i></i>Notepad</span><span><i></i>Paint</span><span><i></i>Camera</span><span><i></i>Terminal</span></div></div>' + FX },
    { title: 'System › Notifications', text: 'Click System, then Notifications', sub: 'System is the first item on the left.',
      mode: 'two', targets: ['nav span:nth-child(2)', '.notifrow'],
      html: DESK + '<div class="set">' + NAV('') + '<div class="pane"><h5>System</h5>'
        + '<div class="rw"><span>Display</span><span class="chev">›</span></div><div class="rw"><span>Sound</span><span class="chev">›</span></div>'
        + '<div class="rw notifrow"><span>Notifications</span><span class="chev">›</span></div><div class="rw"><span>Focus</span><span class="chev">›</span></div>'
        + '<div class="rw"><span>Power & battery</span><span class="chev">›</span></div></div></div>' + FX },
    { title: 'Pick an app', text: "Click the app's name in the list", sub: 'Under "Notifications from apps and other senders". Click the name, not the On/Off switch.',
      mode: 'one', targets: ['.wa .nm'],
      html: DESK + '<div class="set">' + NAV('System') + '<div class="pane"><h5>System › Notifications</h5>' + APP_LIST + '</div></div>' + FX },
    { title: 'Banners off', text: 'Untick "Show notification banners"', sub: 'Leave "Show notifications in notification center" ticked: that is how bloom still gets them.',
      mode: 'one', targets: ['.cbx.banner'],
      html: DESK + '<div class="set">' + NAV('System') + '<div class="pane"><h5>Notifications › WhatsApp</h5>' + APP_PAGE + '</div></div><div class="dndtag">Banners off · still in notification center</div>' + FX },
    { title: 'Every app', text: 'Repeat for each app, and only bloom shows', sub: "Doing every app by hand takes a while: bloom's switch does all of them at once.",
      mode: 'none', targets: [],
      html: DESK + '<div class="wcard"><i></i><span>Windows notification</span></div><div class="bp" id="tut-pill"></div><div class="okline">Only bloom now<small>Every notification, your design, your sound</small></div>' },
  ];
  const LOOP = [5600, 5600, 4400, 4400, 6200];

  const $ = (id) => document.getElementById(id);
  let at = 0, loop = null, timers = [];

  function build() {
    $('tstage').replaceChildren(...STEPS.map((s, i) => { const d = document.createElement('div'); d.className = `sl t${i + 1} ${s.mode}`; d.innerHTML = s.html; return d; }));
    $('steps').replaceChildren(...STEPS.map((s, i) => {
      const b = document.createElement('button'); b.innerHTML = `<b>Step ${i + 1}</b>`; b.append(s.title);
      b.onclick = () => go(i); return b;
    }));
  }

  // Where the cursor goes: the centre of each target, in % of the stage.
  function aim(sl, s) {
    const st = $('tstage').getBoundingClientRect();
    const pt = (sel) => { const e = sl.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [((r.left + r.width / 2 - st.left) / st.width) * 100, ((r.top + r.height / 2 - st.top) / st.height) * 100]; };
    const a = pt(s.targets[0]), b = s.targets[1] ? pt(s.targets[1]) : null;
    if (a) { sl.style.setProperty('--x1', a[0] + '%'); sl.style.setProperty('--y1', a[1] + '%'); }
    if (b) { sl.style.setProperty('--x2', b[0] + '%'); sl.style.setProperty('--y2', b[1] + '%'); }
  }

  function playSlide() {
    const sl = $('tstage').children[at], s = STEPS[at];
    timers.forEach(clearTimeout); timers = [];
    sl.classList.remove('run'); void sl.offsetWidth; // not 'play': .play is the round play button's class
    aim(sl, s);
    sl.classList.add('run');
    if (at === STEPS.length - 1) { // last step: his real chosen design blooms in
      const design = (state && state.settings.design) || 'bloom';
      const { slot, p } = pillEl({ app: 'Claude', title: 'Only bloom from now on', body: 'Windows popups are off', icon: claudeIcon() }, design);
      $('tut-pill').replaceChildren(slot);
      timers.push(setTimeout(() => play(p, design), 1700));
    }
  }
  function claudeIcon() { const h = (history || []).find((n) => n.icon && /claude/i.test(n.app)); return h ? h.icon : null; }

  function go(i) {
    at = Math.max(0, Math.min(STEPS.length - 1, i));
    [...$('tstage').children].forEach((s, k) => s.classList.toggle('on', k === at));
    [...$('steps').children].forEach((b, k) => { b.classList.toggle('on', k === at); b.classList.toggle('done', k < at); });
    const s = STEPS[at];
    $('tnum').textContent = at + 1;
    $('ttext').innerHTML = ''; $('ttext').append(s.text, Object.assign(document.createElement('small'), { textContent: s.sub }));
    $('tback').style.visibility = at ? 'visible' : 'hidden';
    $('tnext').textContent = at === STEPS.length - 1 ? 'Done' : 'Next';
    playSlide();
    clearInterval(loop); loop = setInterval(playSlide, LOOP[at]);
  }

  function open() { build(); document.body.classList.add('tut-open'); requestAnimationFrame(() => go(0)); }
  function close() { document.body.classList.remove('tut-open'); clearInterval(loop); timers.forEach(clearTimeout); }

  $('howbtn').onclick = (e) => { e.stopPropagation(); open(); };
  $('tclose').onclick = close;
  $('tback').onclick = () => go(at - 1);
  $('tnext').onclick = () => (at === STEPS.length - 1 ? close() : go(at + 1));
  $('treplay').onclick = playSlide;
  $('topen').onclick = () => window.bloomSettings.openWindowsSettings();
  addEventListener('resize', () => { if (document.body.classList.contains('tut-open')) playSlide(); });
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('tut-open')) return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') go(at + 1); else if (e.key === 'ArrowLeft') go(at - 1);
  });
  window.bloomTutorial = { open, close, go };
})();
