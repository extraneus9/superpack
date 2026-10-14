// Settings: appearance (theme editor), statuses, Google Drive sync, view, shortcuts.
import { el, fileUrl } from './util.js';
import { icon, folderSvg, fileSvg, homeIcon, galleryIcon, iconStyles, FOLDER_STYLES, UI_STYLES } from './icons.js';
import { PRESETS, resolveTheme } from './themes.js';
import { motionLevel, HoverPill, flip as motionFlip, enter as motionEnter, flyInto } from './motion.js';

const FONT_CHOICES = ['Segoe UI Variable Text, Segoe UI, sans-serif', 'Inter, Segoe UI, sans-serif', 'Ogg Text, Georgia, serif', 'Bahnschrift, Segoe UI, sans-serif', 'Cascadia Code, Consolas, monospace', 'Georgia, serif'];

export function openSettings(app, section = 'appearance') {
  const rootEl = document.getElementById('modal-root');
  let current = section;
  const back = el('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === back) close(); } });
  const nav = el('div', { class: 'settings-nav' }, el('h2', { text: 'Settings' }));
  const body = el('div', { class: 'settings-body' });
  const sections = [
    ['appearance', 'Appearance'],
    ['icons', 'Icons'],
    ['motion', 'Motion'],
    ['layout', 'Layout & sidebar'],
    ['statuses', 'Status colors'],
    ['drive', 'Google Drive'],
    ['view', 'Files & view'],
    ['keys', 'Shortcuts'],
  ];
  const navBtns = sections.map(([k, label]) => {
    const b = el('button', { text: label, onclick: () => { current = k; draw(); } });
    b.dataset.k = k;
    nav.append(b);
    return b;
  });
  nav.append(el('div', { style: { flex: '1' } }), el('button', {
    class: 'reset-btn', html: `${icon('undo', 14)}<span>Restore defaults</span>`, title: 'Back to factory settings',
    onclick: () => app.resetToDefaults(),
  }));
  back.append(el('div', { class: 'settings', role: 'dialog' }, nav, body));
  const onKey = (e) => { if (e.key === 'Escape' && !e.target.matches('input, select')) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  rootEl.append(back);

  function close() {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    app.view.root.focus();
  }

  function draw() {
    navBtns.forEach((b) => b.classList.toggle('active', b.dataset.k === current));
    body.replaceChildren(el('button', { class: 'icon-btn settings-close', title: 'Close (Esc)', html: icon('close'), onclick: close }));
    ({ appearance, iconsSection, motionSection, layoutSection, statuses, drive, view, keys })[{ layout: 'layoutSection', icons: 'iconsSection', motion: 'motionSection' }[current] || current]();
  }

  // ---------- appearance ----------
  function appearance() {
    const s = app.settings();
    const theme = { ...resolveTheme(s) };
    body.append(el('h3', { text: 'Theme' }), el('p', { class: 'hint', text: 'Pick a starting point, then change anything below. Edits are saved as your own theme.' }));
    const grid = el('div', { class: 'preset-grid' });
    const all = { ...PRESETS, ...(s.customThemes || {}) };
    for (const [id, t] of Object.entries(all)) {
      const pv = el('div', { class: 'pp', style: { background: t.bg } },
        el('div', { class: 'pp-side', style: { background: t.panel } }, el('i', { style: { background: t.text, width: '80%' } }), el('i', { style: { background: t.text, width: '60%' } }), el('i', { style: { background: t.accent, width: '70%', opacity: 1 } })),
        el('div', { class: 'pp-main', style: { background: t.panel, borderLeft: `1px solid ${t.text}22` }, html: folderSvg(t.folder, { size: 26 }) + folderSvg('#ffad46', { size: 26 }) + folderSvg('#16a765', { size: 26 }) }));
      const card = el('button', { class: 'preset' + (s.themeId === id ? ' active' : '') },
        pv, el('div', { class: 'pp-label', style: { background: t.panel, color: t.text } }, el('span', { text: t.name }), id.startsWith('custom-') ? el('span', { html: icon('close', 12), title: 'Delete theme', onclick: (e) => { e.stopPropagation(); deleteTheme(id); } }) : null));
      card.addEventListener('click', () => { app.setTheme(id); draw(); });
      grid.append(card);
    }
    body.append(grid);

    body.append(el('h3', { text: 'Customize' }), el('p', { class: 'hint', text: theme.name + (s.themeId.startsWith('custom-') ? '' : ' — changing anything creates “' + theme.name + ' (custom)”.') }));
    const form = el('div', { class: 'form-grid' });
    const edit = (patch) => { app.editTheme(patch); };
    const seg = (label, key, options) => {
      const wrap = el('div', { class: 'seg' });
      for (const [v, l] of options) {
        wrap.append(el('button', { class: theme[key] === v ? 'on' : '', text: l, onclick: () => {
          const patchObj = { [key]: v };
          // Glass needs see-through panels: a solid theme switched to Liquid glass would otherwise cover it 100%.
          if (key === 'material' && v === 'liquid') {
            if ((theme.panelOpacity ?? 1) > 0.6) patchObj.panelOpacity = 0.34;
            if (theme.glassBlur == null) patchObj.glassBlur = 22;
            if (theme.liveGlass == null) patchObj.liveGlass = true;
          }
          if (key === 'material' && v === 'none' && (theme.panelOpacity ?? 1) < 1) patchObj.panelOpacity = 1;
          edit(patchObj); draw();
        } }));
      }
      form.append(el('label', { text: label }), el('div', { class: 'form-row' }, wrap));
    };
    const color = (label, key) => {
      const input = el('input', { type: 'color', value: theme[key] });
      const text = el('input', { type: 'text', value: theme[key], spellcheck: 'false', style: { maxWidth: '120px' } });
      input.addEventListener('input', () => { text.value = input.value; edit({ [key]: input.value }); });
      text.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) { input.value = text.value; edit({ [key]: text.value }); } });
      form.append(el('label', { text: label }), el('div', { class: 'form-row' }, input, text));
    };
    const range = (label, key, min, max, step, fmt = (v) => v) => {
      const val = el('span', { class: 'val', text: fmt(theme[key]) });
      const input = el('input', { type: 'range', min, max, step, value: theme[key] });
      input.addEventListener('input', () => { val.textContent = fmt(+input.value); edit({ [key]: +input.value }); });
      form.append(el('label', { text: label }), el('div', { class: 'form-row' }, input, val));
    };

    seg('Mode', 'mode', [['dark', 'Dark'], ['light', 'Light']]);
    seg('Window material', 'material', [['liquid', 'Liquid glass'], ['mica', 'Mica'], ['acrylic', 'Acrylic'], ['none', 'Solid']]);
    color('Background', 'bg');
    color('Panels', 'panel');
    if (theme.material !== 'none') range(theme.material === 'liquid' ? 'Glass tint' : 'Panel opacity', 'panelOpacity', 0.05, 1, 0.01, (v) => Math.round(v * 100) + '%');
    if (theme.material === 'liquid') {
      seg('Glass layout', 'glassLayout', [['cards', 'Floating cards'], ['single', 'Single pane']]);
      if (!theme.glassLayout) theme.glassLayout = 'cards';
      const liveOn = theme.liveGlass !== false;
      const sw = el('div', { class: 'switch' + (liveOn ? ' on' : ''), onclick: () => { edit({ liveGlass: !liveOn }); draw(); } });
      form.append(el('label', { text: 'Live background' }), el('div', { class: 'form-row' }, sw,
        el('span', { class: 'hint', style: { margin: 0 }, text: liveOn ? 'See-through, live. Win+Shift+S and PrintScreen work automatically (the glass freezes for the snip). Screen recorders still can’t see it — press Ctrl+Shift+L (or the eye button) to freeze before recording.' : 'Off: Windows blur behind the window — always visible in screenshots and recordings.' })));
      if (theme.glassBlur == null) theme.glassBlur = 22;
      range('Glass blur', 'glassBlur', 0, 60, 1, (v) => (v === 0 ? 'clear' : v + 'px'));
      if (theme.refraction == null) theme.refraction = 0.06;
      range('Refraction (menus & dialogs)', 'refraction', 0, 0.16, 0.005, (v) => Math.round(v * 1000) / 10 + '');
    }
    color('Text', 'text');
    color('Accent', 'accent');
    color('Default folder color', 'folder');

    const fontSel = el('select', {});
    const fonts = [...FONT_CHOICES];
    if (!fonts.includes(theme.font)) fonts.unshift(theme.font);
    for (const f of fonts) fontSel.append(el('option', { value: f, text: f.split(',')[0], selected: f === theme.font }));
    fontSel.addEventListener('change', () => edit({ font: fontSel.value }));
    const fontMore = el('button', { class: 'btn', text: 'All installed fonts…', onclick: async () => {
      try {
        const list = await window.queryLocalFonts();
        const fams = [...new Set(list.map((f) => f.family))].sort();
        fontSel.replaceChildren(...fams.map((f) => el('option', { value: `${f}, sans-serif`, text: f, selected: theme.font.startsWith(f + ',') })));
        fontMore.remove();
      } catch { fontMore.textContent = 'Not available'; }
    } });
    form.append(el('label', { text: 'Font' }), el('div', { class: 'form-row' }, fontSel, fontMore));
    range('Text size', 'fontSize', 11, 17, 1, (v) => v + 'px');
    seg('Density', 'density', [['compact', 'Compact'], ['normal', 'Normal'], ['comfy', 'Roomy']]);
    range('Corner radius', 'radius', 0, 16, 1, (v) => v + 'px');

    const bgText = el('input', { type: 'text', placeholder: 'Image path (or empty)', value: theme.bgImage ? decodeURI(theme.bgImage.replace('file:///', '').replace(/\//g, '\\')) : '', spellcheck: 'false' });
    bgText.addEventListener('change', () => edit({ bgImage: bgText.value.trim() ? fileUrl(bgText.value.trim().replace(/^"|"$/g, '')) : '' }));
    const bgFromSel = el('button', { class: 'btn', text: 'Use selected image', onclick: () => {
      const it = app.selectedItems().find((x) => /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(x.n));
      if (!it) return app.toast('Select an image file first.', 'warn');
      bgText.value = it.p;
      edit({ bgImage: fileUrl(it.p) });
    } });
    form.append(el('label', { text: 'Background image' }), el('div', { class: 'form-row' }, bgText, bgFromSel));
    range('Image opacity', 'bgImageOpacity', 0, 1, 0.02, (v) => Math.round(v * 100) + '%');
    range('Image blur', 'bgBlur', 0, 40, 1, (v) => v + 'px');
    body.append(form);
  }

  function deleteTheme(id) {
    const s = app.settings();
    const custom = { ...(s.customThemes || {}) };
    delete custom[id];
    app.api.setSetting('customThemes', custom).then((ns) => {
      app.state.settings = ns;
      if (s.themeId === id) app.setTheme('windows-dark');
      draw();
    });
  }

  // ---------- statuses ----------
  function statuses() {
    const s = app.settings();
    body.append(el('h3', { text: 'Status colors' }), el('p', { class: 'hint', text: 'Right-click a folder → Status, or press Alt + the number. The color is written into the folder itself, so Windows Explorer, the desktop and every Open/Save window show it too — and it syncs to Google Drive.' }));
    const rows = el('div', { class: 'status-rows' });
    const list = s.statuses.map((x) => ({ ...x }));
    const save = () => app.saveStatuses(list);
    list.forEach((st) => {
      const c = el('input', { type: 'color', value: st.color });
      const sel = el('select', {});
      for (const p of app.state.palette) sel.append(el('option', { value: p, text: p, selected: p === st.color }));
      if (!app.state.palette.includes(st.color)) sel.prepend(el('option', { value: st.color, text: st.color + ' (custom)', selected: true }));
      const label = el('input', { type: 'text', value: st.label, spellcheck: 'false' });
      c.addEventListener('change', () => { st.color = c.value; save(); draw(); });
      sel.addEventListener('change', () => { st.color = sel.value; save(); draw(); });
      label.addEventListener('change', () => { st.label = label.value.trim() || st.label; save(); });
      rows.append(el('div', { class: 'status-row' }, el('div', { class: 'form-row' }, c), label, el('div', { class: 'form-row' }, sel), el('span', { class: 'key', html: `<kbd>Alt</kbd> + <kbd>${st.hotkey}</kbd>` })));
    });
    body.append(rows);
    body.append(el('p', { class: 'hint', text: 'Google Drive only has 24 folder colors — the dropdown lists them. A custom color syncs to the nearest Drive color. Clear a status with Alt + 0.' }));

    body.append(el('h3', { text: 'Status folders', style: { marginTop: '26px' } }), el('p', { class: 'hint', text: 'Statuses only appear inside these folders: each folder directly inside one of them (one video) can be marked. Everything else stays a normal folder. A * stands for any one folder — e.g. …\\1-SOCIALS\\* covers vol3, vol4 and every future vol.' }));
    const scopeRows = el('div', { class: 'rule-rows' });
    const drawScopes = () => {
      const scopes = app.settings().statusScopes || [];
      scopeRows.replaceChildren(...scopes.map((sc) => el('div', { class: 'rule-row', style: { gridTemplateColumns: '1fr 32px' } },
        el('input', { type: 'text', value: sc, readonly: true, spellcheck: 'false' }),
        el('button', { class: 'icon-btn', title: 'Remove', html: icon('close'), onclick: async () => {
          app.state.settings = await app.api.setSetting('statusScopes', (app.settings().statusScopes || []).filter((x) => x !== sc));
          app.view.render({ keepScroll: true });
          drawScopes();
        } }))));
      if (!scopes.length) scopeRows.append(el('p', { class: 'hint', text: 'No status folders yet.' }));
    };
    drawScopes();
    const loc = app.tab().loc;
    body.append(scopeRows, el('button', {
      class: 'btn', html: `${icon('plus')}<span>Add the current folder</span>`,
      disabled: !/^[a-zA-Z]:\\./.test(loc) || null,
      title: loc,
      onclick: async () => { await app.setScope(loc, true); drawScopes(); },
    }));
  }

  // ---------- icons ----------
  function iconsSection() {
    const s = app.settings();
    const statusColors = s.statuses.map((x) => x.color);
    const set = async (patchObj) => { await app.setIconStyle(patchObj); draw(); };
    const seg = (cur, options, onPick) => {
      const wrap = el('div', { class: 'seg' });
      for (const [v, l] of options) wrap.append(el('button', { class: cur === v ? 'on' : '', text: l, onclick: () => onPick(v) }));
      return wrap;
    };

    body.append(el('h3', { text: 'Folder style' }), el('p', { class: 'hint', text: 'How folders are drawn everywhere in Foldernator — status colors included.' }));
    const grid = el('div', { class: 'style-grid' });
    for (const [k, label] of FOLDER_STYLES) {
      const sample = [app.themeFolder(), ...statusColors.filter((c) => c !== '#8f8f8f').slice(0, 3)].map((c) => folderSvg(c, { size: 40, style: k })).join('');
      const card = el('button', { class: 'style-card' + (iconStyles.folder === k ? ' active' : ''), dataset: { style: k } },
        el('div', { class: 'style-sample', html: sample }), el('div', { class: 'style-label', text: label }));
      card.addEventListener('click', () => set({ folder: k }));
      grid.append(card);
    }
    body.append(grid);
    const colored = Object.keys(s.statusIndex || {}).length;
    const out = el('p', { class: 'hint', style: { marginTop: '8px' } });
    body.append(el('div', { class: 'pv-actions' }, el('button', {
      class: 'btn', html: `${icon('refresh')}<span>Update ${colored} colored folder${colored === 1 ? '' : 's'} in Windows Explorer</span>`,
      title: 'Colored folders keep the icon they got when you colored them. This redraws them in the folder style above (Google Drive colors don’t change).',
      onclick: async () => { out.textContent = 'Updating…'; const n = await app.restyleColoredFolders(); out.textContent = `${n} updated.`; },
    })), out);

    body.append(el('h3', { text: 'App icons', style: { marginTop: '22px' } }), el('p', { class: 'hint', text: 'Toolbar, menus and sidebar symbols.' }));
    const uiNames = ['back', 'forward', 'up', 'refresh', 'search', 'newFolder', 'cut', 'copy', 'paste', 'rename', 'trash', 'sort', 'view', 'preview', 'pin', 'cloud', 'home', 'gear'];
    body.append(el('div', { class: 'form-row', style: { marginBottom: '10px' } }, seg(iconStyles.ui, UI_STYLES, (v) => set({ ui: v }))));
    body.append(el('div', { class: 'icon-preview', html: uiNames.map((n) => `<span>${icon(n, 20)}</span>`).join('') }));

    body.append(el('h3', { text: 'Sidebar icons', style: { marginTop: '22px' } }), el('p', { class: 'hint', text: 'Keep Windows’ colorful icons for Desktop, Downloads, drives… or draw them in the app icon style.' }));
    body.append(el('div', { class: 'form-row', style: { marginBottom: '10px' } }, seg(iconStyles.sidebar, [['windows', 'Windows colors'], ['mono', 'Match app icons']], (v) => set({ sidebar: v }))));
    const p = app.state.paths;
    const side = iconStyles.sidebar === 'mono'
      ? [icon('home', 18), icon('image', 18), icon('desktop', 18), icon('download', 18), icon('music', 18), icon('drive', 18)]
      : [homeIcon(20), galleryIcon(20), ...[p.desktop, p.downloads, p.music, 'C:\\'].map((x) => `<img src="ficon://f/?p=${encodeURIComponent(x)}&s=normal&d=1" width="20" height="20" alt="">`)];
    body.append(el('div', { class: 'icon-preview', html: side.map((h) => `<span>${h}</span>`).join('') }));

    body.append(el('h3', { text: 'File icons', style: { marginTop: '22px' } }), el('p', { class: 'hint', text: 'Windows’ own file icons, or clean pages with a colored type tag. Photos and videos still show their thumbnails in icon views.' }));
    body.append(el('div', { class: 'form-row', style: { marginBottom: '10px' } }, seg(iconStyles.files, [['windows', 'Windows'], ['minimal', 'Minimal']], (v) => set({ files: v }))));
    const exts = ['mp4', 'png', 'pdf', 'blend', 'zip', 'txt', 'mp3', 'json', 'docx', 'psd'];
    const files = iconStyles.files === 'minimal'
      ? exts.map((e) => fileSvg(e, 36))
      : exts.map((e) => `<img src="ficon://f/?p=${encodeURIComponent('C:\\__preview__.' + e)}&s=large" width="36" height="36" alt="">`);
    body.append(el('div', { class: 'icon-preview big', html: files.map((h) => `<span>${h}</span>`).join('') }));
  }

  // ---------- motion ----------
  function motionSection() {
    body.append(el('h3', { text: 'Fluidity' }), el('p', { class: 'hint', text: 'How much Foldernator moves. Windows’ “reduce animations” setting always wins.' }));
    const levels = [
      [0, 'Off', 'Nothing moves. Every change is instant.'],
      [1, 'Smooth', 'Short, quiet transitions — fades and slides that stay out of the way.'],
      [2, 'Liquid', 'Everything flows like water: springy motion, a highlight that glides between items, folders that open when you drag onto them, files that fly in when dropped.'],
    ];
    const grid = el('div', { class: 'motion-grid' });
    for (const [n, label, text] of levels) {
      const card = el('button', { class: 'motion-card' + (motionLevel() === n ? ' active' : ''), dataset: { level: String(n) } },
        el('div', { class: 'motion-dots', html: [0, 1, 2].map((k) => `<i class="${k <= n ? 'on' : ''}"></i>`).join('') }),
        el('div', { class: 'motion-name', text: label }),
        el('div', { class: 'motion-text', text }));
      card.addEventListener('click', () => { app.setMotion(n); draw(); });
      grid.append(card);
    }
    body.append(grid);

    // Live demo: hover the folders, shuffle them, drop one into another.
    body.append(el('h3', { text: 'Try it', style: { marginTop: '24px' } }), el('p', { class: 'hint', text: 'Hover the folders, then press the buttons.' }));
    const colors = [app.themeFolder(), ...app.settings().statuses.map((x) => x.color)];
    const stage = el('div', { class: 'motion-stage' });
    const W = 96, H = 104;
    let order = colors.map((c, i) => ({ id: 'd' + i, c, name: ['Footage', 'Not published', 'Neutral', 'Scheduled', 'Published'][i] || 'Folder' }));
    const nodes = new Map();
    const placeAll = () => order.forEach((o, i) => { const n = nodes.get(o.id); n.style.left = (12 + i * W) + 'px'; n.style.top = '12px'; });
    for (const o of order) {
      const n = el('div', { class: 'tile demo-tile', style: { width: (W - 6) + 'px', height: H + 'px' } },
        el('div', { class: 'tile-icon', style: { width: '56px', height: '56px' }, html: folderSvg(o.c, { size: 56 }) }),
        el('div', { class: 'tile-name', text: o.name }));
      nodes.set(o.id, n);
      stage.append(n);
    }
    placeAll();
    new HoverPill(stage, '.demo-tile');
    const shuffle = () => {
      const before = new Map([...nodes].map(([k, n]) => [k, { top: parseFloat(n.style.top), left: parseFloat(n.style.left) }]));
      order = order.map((o) => [Math.random(), o]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      placeAll();
      motionFlip(nodes, before);
    };
    const replay = () => motionEnter(order.map((o) => nodes.get(o.id)), 'forward');
    const drop = () => {
      const a = nodes.get(order[0].id), b = nodes.get(order[order.length - 1].id);
      b.classList.add('drop');
      setTimeout(() => { flyInto([a], b.querySelector('.tile-icon')); b.classList.remove('drop'); }, motionLevel() ? 420 : 0);
    };
    body.append(stage, el('div', { class: 'pv-actions', style: { marginTop: '10px' } },
      el('button', { class: 'btn', html: `${icon('refresh')}<span>Open a folder</span>`, onclick: replay }),
      el('button', { class: 'btn', html: `${icon('sort')}<span>Re-sort</span>`, onclick: shuffle }),
      el('button', { class: 'btn', html: `${icon('download')}<span>Drop into a folder</span>`, onclick: drop })));
  }

  // ---------- layout ----------
  function layoutSection() {
    const L = app.layout.cfg;
    body.append(el('h3', { text: 'Layout' }), el('p', { class: 'hint', text: 'Move panels here, from View → Panel positions, or by dragging a panel by its header onto a dock zone. Drag any edge to resize; double-click an edge to reset it.' }));
    const form = el('div', { class: 'form-grid' });
    const seg = (label, cur, options, onPick) => {
      const wrap = el('div', { class: 'seg' });
      for (const [v, l] of options) wrap.append(el('button', { class: cur === v ? 'on' : '', text: l, onclick: () => { onPick(v); draw(); } }));
      form.append(el('label', { text: label }), el('div', { class: 'form-row' }, wrap));
    };
    seg('Navigation pane', L.sidebar, [['left', 'Left'], ['right', 'Right'], ['hidden', 'Hidden']], (v) => app.layout.set({ sidebar: v }));
    seg('Preview pane', L.preview, [['right', 'Right'], ['left', 'Left'], ['bottom', 'Bottom']], (v) => app.layout.set({ preview: v }));
    const pvOn = app.settings().view.previewPane;
    seg('Show preview', pvOn ? 'on' : 'off', [['on', 'On'], ['off', 'Off']], (v) => app.setViewFlag('previewPane', v === 'on'));
    body.append(form);

    body.append(el('h3', { text: 'Quick access' }), el('p', { class: 'hint', text: 'Pinned folders in the sidebar. Drag them to reorder, drop a folder between them to pin it, right-click to unpin. You can copy your pins from Windows Explorer again at any time.' }));
    const out = el('p', { class: 'hint' });
    body.append(el('div', { class: 'pv-actions' },
      el('button', { class: 'btn', html: `${icon('pin')}<span>Replace with my Windows pins</span>`, onclick: async () => { const n = await app.importWindowsPins(true); out.textContent = `${n} pins copied from Windows Explorer.`; } }),
      el('button', { class: 'btn', html: `${icon('plus')}<span>Add missing Windows pins</span>`, onclick: async () => { const n = await app.importWindowsPins(false); out.textContent = `${n} pins now.`; } })), out);

    body.append(el('h3', { text: 'Gallery', style: { marginTop: '22px' } }), el('p', { class: 'hint', text: 'Gallery shows every photo and video inside these folders, newest first. Empty = your Pictures folder.' }));
    const roots = [...(app.settings().galleryRoots || [])];
    const rows = el('div', { class: 'rule-rows' });
    const save = () => app.api.setSetting('galleryRoots', roots).then((ns) => { app.state.settings = ns; });
    const drawRoots = () => rows.replaceChildren(...roots.map((r, i) => el('div', { class: 'rule-row', style: { gridTemplateColumns: '1fr 32px' } },
      el('input', { type: 'text', value: r, spellcheck: 'false', onchange: (e) => { roots[i] = e.target.value.trim(); save(); } }),
      el('button', { class: 'icon-btn', title: 'Remove', html: icon('close'), onclick: () => { roots.splice(i, 1); save(); drawRoots(); } }))));
    drawRoots();
    const loc = app.tab().loc;
    body.append(rows, el('button', { class: 'btn', html: `${icon('plus')}<span>Add the current folder</span>`, disabled: !/^[a-zA-Z]:\\/.test(loc) || null, onclick: () => { roots.push(loc); save(); drawRoots(); } }));
  }

  // ---------- drive ----------
  function drive() {
    const s = app.settings();
    const cfg = JSON.parse(JSON.stringify(s.drive));
    const save = () => app.api.patchSettings({ drive: cfg }).then((ns) => { app.state.settings = ns; });
    body.append(el('h3', { text: 'Google Drive sync' }), el('p', { class: 'hint', text: 'When you set a status on a local folder that also exists on Drive, the Drive folder gets the same color. Needs rclone installed, with a Google Drive remote.' }));
    const sw = el('div', { class: 'switch' + (cfg.enabled ? ' on' : ''), onclick: () => { cfg.enabled = !cfg.enabled; sw.classList.toggle('on', cfg.enabled); save(); } });
    body.append(el('div', { class: 'check-line' }, el('div', { class: 'cl-text', html: 'Sync folder colors to Google Drive<small>Turn off to keep colors local only.</small>' }), sw));
    body.append(el('h3', { text: 'Folder mapping', style: { marginTop: '22px' } }), el('p', { class: 'hint', text: 'Local folder → Drive folder. The longest matching local path wins.' }));
    const rows = el('div', { class: 'rule-rows' });
    const drawRules = () => {
      rows.replaceChildren(...cfg.rules.map((r, i) => {
        const a = el('input', { type: 'text', value: r.local, spellcheck: 'false' });
        const b = el('input', { type: 'text', value: r.remote, spellcheck: 'false' });
        a.addEventListener('change', () => { r.local = a.value.trim(); save(); });
        b.addEventListener('change', () => { r.remote = b.value.trim(); save(); });
        return el('div', { class: 'rule-row' }, a, el('span', { class: 'arrow', html: icon('forward', 14) }), b,
          el('button', { class: 'icon-btn', title: 'Remove', html: icon('close'), onclick: () => { cfg.rules.splice(i, 1); save(); drawRules(); } }));
      }));
    };
    drawRules();
    body.append(rows, el('button', { class: 'btn', html: `${icon('plus')}<span>Add mapping</span>`, onclick: () => { cfg.rules.push({ local: '', remote: '' }); drawRules(); } }));
    const out = el('p', { class: 'hint', style: { marginTop: '16px' } });
    const test = el('button', { class: 'btn', style: { marginTop: '18px' }, html: `${icon('cloud')}<span>Check the current folder on Drive</span>`, onclick: async () => {
      const loc = app.tab().loc;
      out.textContent = 'Checking ' + loc + '…';
      const r = await app.api.driveCheck(loc);
      out.textContent = !r.mapped ? 'This folder isn’t covered by any mapping.'
        : r.error ? `${r.remote}: ${r.error}`
          : r.id ? `Found on Drive: ${r.remote}` : `Not on Drive yet: ${r.remote}`;
    } });
    body.append(test, out);
  }

  // ---------- view ----------
  function view() {
    const s = app.settings();
    body.append(el('h3', { text: 'Files & view' }), el('p', { class: 'hint', text: 'Defaults for every folder. Each folder also remembers its own view and sort.' }));
    const line = (label, small, key) => {
      const sw = el('div', { class: 'switch' + (s.view[key] ? ' on' : ''), onclick: () => { app.setViewFlag(key, !app.settings().view[key]); sw.classList.toggle('on', app.settings().view[key]); } });
      body.append(el('div', { class: 'check-line' }, el('div', { class: 'cl-text', html: `${label}<small>${small}</small>` }), sw));
    };
    line('Show hidden files', 'Ctrl+H toggles it anywhere.', 'showHidden');
    line('Show file extensions', '.mp4, .png, .drp …', 'showExt');
    line('Folders first', 'Keep folders above files when sorting.', 'foldersFirst');
    line('Preview pane', 'Alt+P toggles it.', 'previewPane');
    line('Built-in image viewer', 'Images open inside Foldernator: ← → browse the folder, Enter opens the default app.', 'builtinViewer');
    line('Folder previews', 'Folders show the images and videos inside them.', 'folderPreviews');
    line('Reopen last tabs on start', 'Off: Foldernator starts fresh at Home after you close it (updates still bring your tabs back).', 'restoreTabs');
  }

  function keys() {
    body.append(el('h3', { text: 'Shortcuts' }), el('p', { class: 'hint', text: 'Same keys as Windows Explorer, plus status colors.' }));
    const rows = [
      ['New tab / close tab', 'Ctrl+T · Ctrl+W'], ['This folder in a new tab', 'Ctrl+N'], ['Full screen', 'F11'], ['Next / previous tab', 'Ctrl+Tab · Ctrl+Shift+Tab'], ['Back / forward / up', 'Alt+← · Alt+→ · Alt+↑'],
      ['Address bar', 'Ctrl+L · Alt+D'], ['Search', 'Ctrl+F · Ctrl+E'], ['Refresh', 'F5'], ['Rename', 'F2'], ['New folder', 'Ctrl+Shift+N'],
      ['Copy / cut / paste', 'Ctrl+C · Ctrl+X · Ctrl+V'], ['Recycle / delete permanently', 'Del · Ctrl+D · Shift+Del'], ['Select all', 'Ctrl+A'],
      ['Status 1–4 / clear', 'Alt+1…4 · Alt+0'], ['Preview pane', 'Alt+P'], ['Properties', 'Alt+Enter'], ['Media details (video / audio)', 'Ctrl+I'], ['Windows menu (all options)', 'Shift+F10 · Shift+right-click'],
      ['Views: XL / large / medium / details', 'Ctrl+Shift+1 · 2 · 3 · 6'], ['Hidden files', 'Ctrl+H'], ['Navigation pane', 'Ctrl+Shift+E'], ['Freeze glass for screenshots / go live', 'Ctrl+Shift+L'], ['Settings', 'Ctrl+,'],
    ];
    body.append(el('table', { class: 'kbd-table' }, ...rows.map(([a, b]) => el('tr', {}, el('td', { text: a }), el('td', { html: b.split(' · ').map((k) => k.split('+').map((x) => `<kbd>${x}</kbd>`).join('+')).join(' &nbsp;·&nbsp; ') })))));
  }

  draw();
}
