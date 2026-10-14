// File details drawer — everything about the open file, MediaInfo-style.
// The sections come from details-core.js (shared with Foldernator); this file only draws them.
// Every value is a button: click copies it. renderDetails() also returns the same content as plain text (Copy all).
import { esc, icon } from './util.js';
import { detailSections, detailsText } from './details-core.js';

export function renderDetails(d, playMode) {
  const secs = detailSections(d, playMode || 'direct');
  const text = detailsText(d, secs);
  const html = `<div class="s-head"><h2>File details</h2><button class="s-x" data-act="drawer-close" aria-label="Close file details">${icon('close')}</button></div>
  <div class="s-body d-body">
    <div class="d-file"><b>${esc(d.name)}</b><span title="${esc(d.path)}">${esc(d.dir)}</span>
      <div class="d-actions"><button class="s-btn" data-act="details-reveal">Show in folder</button><button class="s-btn" data-act="details-copy-path">Copy path</button><button class="s-btn" data-act="details-copy-all">Copy all</button></div></div>
    ${secs.map((s) => `<section><h3>${esc(s.title)}</h3><dl class="d-rows">${s.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd><button class="d-val" data-act="details-copy" title="Click to copy">${esc(v)}</button></dd>`).join('')}</dl></section>`).join('')}
    <p class="s-note d-hint">Click any value to copy it.</p>
  </div>`;
  return { html, text };
}
