// Long messages (the author 2026-10-17): "the notification gets bigger so you can read more, or only the essentials".
//   grow       → the pill grows to fit: title up to 2 lines, message up to 4, and it stays a little longer.
//   essentials → the message is cut to its key sentence (plain rule, instant, no AI), shown on up to 2 lines.
// Shared by the overlay (real notifications) and the app window (previews), so both always match.
(function () {
  // Height of each design once open (its s2 state) and the breathing room the text needs inside it.
  const OPEN_H = { bloom: 72, island: 80, glass: 88, edge: 56, signal: 86, rise: 70, spin: 76, ribbon: 60 };
  const PAD = { bloom: 14, island: 14, glass: 16, edge: 9, signal: 16, rise: 16, spin: 14, ribbon: 10 };

  // The key sentence: first sentence (or first line), markdown noise removed, at most ~120 characters on a word boundary.
  function essentials(text) {
    if (!text) return text;
    let t = String(text).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    const line = String(text).split(/\n/)[0].trim();
    if (line && line.length < t.length && line.length >= 12) t = line.replace(/[*_`#>]+/g, '').trim();
    const m = t.match(/^(.{12,}?[.!?…])(\s|$)/);
    let out = m ? m[1] : t;
    if (out.length < 25 && m) { const m2 = t.match(/^(.+?[.!?…]\s+.+?[.!?…])(\s|$)/); if (m2) out = m2[1]; }
    if (out.length > 120) out = out.slice(0, 120).replace(/\s+\S*$/, '') + '…';
    return out;
  }

  // Extra seconds on screen for long text in "grow" mode: +1 s per ~80 characters past the first 80, at most +6 s.
  const extraSeconds = (len) => Math.min(6, Math.max(0, Math.ceil((len - 80) / 80)));

  // After the pill is in the page: if its text needs more room than the design's open height, let it grow.
  function fit(pill, slot, txt, design, mode) {
    pill.classList.remove('tall', 'l2', 'l4');
    pill.classList.add('tall', mode === 'essentials' ? 'l2' : 'l4');
    const need = Math.ceil(txt.offsetHeight + 2 * (PAD[design] ?? 14));
    const base = OPEN_H[design] ?? 72;
    if (need <= base + 2) { pill.classList.remove('tall', 'l2', 'l4'); return false; }
    pill.style.setProperty('--th', need + 'px');
    if (slot) slot.style.height = (need + 14) + 'px';
    return true;
  }

  window.LongText = { essentials, extraSeconds, fit };
})();
