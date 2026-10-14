// Preview / details pane (Alt+P): media, PDF, text, folder info.
import { el, fmtSize, fmtDate, typeLabel, extOf, fileUrl, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, TEXT_EXT } from './util.js';
import { folderSvg, driveSvg, icon } from './icons.js';
import { openTheater, closeTheater } from './theater.js';
import { openMediaDetails, isMediaFile } from './media-details.js';

export class Preview {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.token = 0;
    this.current = null;
  }

  clear() {
    closeTheater();
    this.root.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch {} });
  }

  async show(items) {
    if (!document.body.classList.contains('preview-on')) return;
    const key = items.map((i) => i.p + i.m).join('|');
    if (key === this.current) return;
    this.current = key;
    const token = ++this.token;
    this.clear();
    if (!items.length) {
      const t = this.app.tab();
      this.root.replaceChildren(el('div', { class: 'pv-empty' }, el('div', {},
        el('div', { html: icon('info', 28), style: { display: 'grid', placeItems: 'center', marginBottom: '10px', opacity: '.6' } }),
        el('div', { text: `${t.view.length.toLocaleString()} items` }),
        el('div', { text: 'Select a file to preview it.', style: { marginTop: '4px' } }))));
      return;
    }
    if (items.length > 1) {
      const files = items.filter((i) => !i.d);
      const total = files.reduce((s, i) => s + (i.s || 0), 0);
      this.root.replaceChildren(el('div', { class: 'pv' },
        el('div', { class: 'pv-media', style: { minHeight: '160px' }, html: folderSvg(this.app.themeFolder(), { size: 96 }) }),
        el('div', {}, el('div', { class: 'pv-title', text: `${items.length} items selected` }),
          el('div', { class: 'pv-sub', text: files.length ? `${files.length} files · ${fmtSize(total)}` : `${items.length} folders` }))));
      return;
    }
    const it = items[0];
    const ext = extOf(it.n);
    const media = el('div', { class: 'pv-media' });
    const extra = [];
    const url = fileUrl(it.p);
    let isVideo = false;

    if (it.drive) media.innerHTML = driveSvg(undefined, 120);
    else if (it.d) {
      const s = it.st && this.app.statusByKey(it.st);
      media.innerHTML = folderSvg((s && s.color) || it.col || this.app.themeFolder(), { size: 140 });
      media.style.minHeight = '180px';
    } else if (IMAGE_EXT.has(ext)) {
      const img = el('img', { src: url, alt: '', draggable: 'false' });
      img.onload = () => { if (token === this.token) this.addRow(dl, 'Dimensions', `${img.naturalWidth} × ${img.naturalHeight}`); };
      img.onerror = () => { img.src = `thumb://t/?p=${encodeURIComponent(it.p)}&s=512&m=${it.m}`; };
      media.append(img);
    } else if (VIDEO_EXT.has(ext)) {
      // Centred mini-player. Double-click or the full-view button → theater over the file area (not the
      // browser's full screen, which is replaced by our button).
      isVideo = true;
      const v = el('video', { src: url, controls: true, preload: 'metadata', muted: true, controlsList: 'nofullscreen', disablePictureInPicture: true });
      v.muted = true;
      const theater = () => { v.pause(); openTheater(it.p, { time: v.currentTime, playing: true, name: it.n, from: v }); };
      v.addEventListener('dblclick', (e) => { e.preventDefault(); theater(); });
      const full = el('button', { class: 'pv-full', title: 'Full view (double-click the video · Space)', html: icon('maximize', 15) });
      full.addEventListener('click', (e) => { e.stopPropagation(); theater(); });
      media.classList.add('pv-vwrap');
      v.onloadedmetadata = () => {
        if (token !== this.token) return;
        this.addRow(dl, 'Dimensions', `${v.videoWidth} × ${v.videoHeight}`);
        this.addRow(dl, 'Length', fmtDuration(v.duration));
      };
      v.onerror = () => { media.replaceChildren(el('img', { src: `thumb://t/?p=${encodeURIComponent(it.p)}&s=512&m=${it.m}`, alt: '' })); };
      media.append(v, full);
    } else if (AUDIO_EXT.has(ext)) {
      const a = el('audio', { src: url, controls: true, preload: 'metadata' });
      a.onloadedmetadata = () => { if (token === this.token) this.addRow(dl, 'Length', fmtDuration(a.duration)); };
      media.append(a);
    } else if (ext === 'pdf') {
      media.append(el('iframe', { src: url + '#toolbar=0&view=FitH' }));
    } else if (TEXT_EXT.has(ext) || it.s < 64 * 1024) {
      media.innerHTML = `<div class="spinner" style="margin:24px"></div>`;
      this.app.api.readText(it.p).then((r) => {
        if (token !== this.token) return;
        if (r.binary || r.text == null) media.replaceChildren(el('img', { src: `thumb://t/?p=${encodeURIComponent(it.p)}&s=256&m=${it.m}`, alt: '', onerror: (e) => { e.target.src = `ficon://f/?p=${encodeURIComponent(it.p)}&s=large`; } }));
        else {
          // Text preview with a Copy button (copies the text shown; long files are previewed in part).
          const btn = el('button', { class: 'pv-copy', title: 'Copy text', html: icon('copy', 14) + '<span>Copy</span>' });
          btn.addEventListener('click', async () => {
            await this.app.api.copyText(r.text);
            btn.classList.add('done'); btn.querySelector('span').textContent = 'Copied';
            setTimeout(() => { btn.classList.remove('done'); btn.querySelector('span').textContent = 'Copy'; }, 1400);
          });
          media.replaceChildren(el('div', { class: 'pv-text' }, btn, el('pre', { text: r.text + (r.truncated ? '\n…' : '') })));
        }
      }).catch(() => media.replaceChildren(el('span', { text: 'Can’t read this file.' })));
    } else {
      media.append(el('img', { src: `thumb://t/?p=${encodeURIComponent(it.p)}&s=256&m=${it.m}`, alt: '', style: { maxWidth: '256px' }, onerror: (e) => { e.target.onerror = null; e.target.src = `ficon://f/?p=${encodeURIComponent(it.p)}&s=large`; } }));
      media.style.minHeight = '180px';
    }

    const dl = el('dl', { class: 'pv-rows' });
    if (!it.drive) {
      this.addRow(dl, 'Type', typeLabel(it));
      if (!it.d) this.addRow(dl, 'Size', `${fmtSize(it.s)} (${(it.s || 0).toLocaleString()} bytes)`);
      this.addRow(dl, 'Modified', fmtDate(it.m));
      this.addRow(dl, 'Created', fmtDate(it.c));
      if (it.d) {
        const s = it.st && this.app.statusByKey(it.st);
        if (s) this.addRow(dl, 'Status', s.label);
      }
    } else {
      this.addRow(dl, 'Free', fmtSize(it.free));
      this.addRow(dl, 'Total', fmtSize(it.total));
      if (it.format) this.addRow(dl, 'File system', it.format);
    }
    const ds = it.driveState;
    if (ds) this.addRow(dl, 'Google Drive', ds.state === 'ok' ? 'On Drive' : ds.state === 'partial' ? `${ds.missing} of ${ds.total} files not on Drive` : ds.state === 'differs' ? 'On Drive (different size)' : 'Not on Drive');
    if (ds && ds.names && ds.names.length) this.addRow(dl, 'Not uploaded', ds.names.join(', ') + (ds.missing > ds.names.length ? ` +${ds.missing - ds.names.length} more` : ''));
    this.addRow(dl, 'Location', it.p);

    const actions = el('div', { class: 'pv-actions' },
      el('button', { class: 'btn', html: `${icon(it.d ? 'open' : 'external')}<span>Open</span>`, onclick: () => this.app.openItems([it]) }),
      el('button', { class: 'btn', html: `${icon('copy')}<span>Copy path</span>`, onclick: () => this.app.copyPaths([it]) }),
      isMediaFile(it) ? el('button', { class: 'btn pv-md', title: 'Everything about this file (Ctrl+I)', html: `${icon('video')}<span>Media details</span>`, onclick: () => openMediaDetails(this.app, it.p) }) : null);

    const head = el('div', {}, el('div', { class: 'pv-title', text: it.drive ? it.label : it.n }), el('div', { class: 'pv-sub', text: typeLabel(it) }));
    if (isVideo) {
      // Option C: the player sits centred; details fold away behind a toggle (remembered).
      const open = localStorage.getItem('pvVideoDetails') === '1';
      const box = el('div', { class: 'pv-more' + (open ? ' open' : '') }, dl, actions);
      const tg = el('button', { class: 'pv-toggle' + (open ? ' open' : ''), html: `<span>Details</span>${icon('chevronDown', 12)}` });
      tg.addEventListener('click', () => { box.classList.toggle('open'); tg.classList.toggle('open', box.classList.contains('open')); try { localStorage.setItem('pvVideoDetails', box.classList.contains('open') ? '1' : '0'); } catch {} });
      this.root.replaceChildren(el('div', { class: 'pv pv-video' }, media, head, tg, box, ...extra));
    } else {
      this.root.replaceChildren(el('div', { class: 'pv' }, media, head, dl, actions, ...extra));
    }
    if (it.d && !it.drive) this.folderStats(it, dl, token);
  }

  addRow(dl, k, v) {
    if (!dl || v == null || v === '') return;
    dl.append(el('dt', { text: k }), el('dd', { text: v }));
  }

  async folderStats(it, dl, token) {
    try {
      const r = await this.app.api.list(it.p);
      if (token !== this.token) return;
      const files = r.items.filter((x) => !x.d && !(x.h && x.sys));
      const dirs = r.items.filter((x) => x.d && !(x.h && x.sys));
      const size = files.reduce((s, x) => s + x.s, 0);
      this.addRow(dl, 'Contains', `${files.length} files, ${dirs.length} folders`);
      if (files.length) this.addRow(dl, 'Files size', fmtSize(size));
    } catch {}
  }
}

function fmtDuration(sec) {
  if (!isFinite(sec)) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
