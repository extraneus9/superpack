// Brand colours of the app that sent a notification, read from its own icon (the author: "Claude is orange, Gmail is
// its combined colours"). One-colour apps give one colour; Google-style icons give up to four. Used by the overlay
// and the app window, so the preview and the real notification always match.
(function () {
  const BRAND = '#e0312b';

  function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  // Returns ['hsl(...)', ...] (1–4 colours, strongest first) or null when the icon has no real colour (grey/black/white).
  function colors(img) {
    try {
      const S = 32, c = document.createElement('canvas'); c.width = c.height = S;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, S, S);
      const d = g.getImageData(0, 0, S, S).data;
      const bins = Array.from({ length: 36 }, () => ({ w: 0, h: 0 }));
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255; if (a < 0.5) continue;
        const [h, s, l] = hsl(d[i], d[i + 1], d[i + 2]);
        if (s < 0.35 || l < 0.18 || l > 0.86) continue;
        const b = bins[Math.floor(h / 10) % 36], w = s * a;
        b.w += w; b.h += h * w;
      }
      // merge each bin with its neighbours so one hue split across two bins still counts once
      const peaks = bins.map((b, i) => {
        const n = [bins[(i + 35) % 36], b, bins[(i + 1) % 36]];
        const w = n.reduce((t, x) => t + x.w, 0);
        return { w, hue: b.w ? b.h / b.w : i * 10 + 5, own: b.w };
      }).filter((p) => p.own > 0).sort((a, b) => b.w - a.w);
      if (!peaks.length || peaks[0].w < 6) return null;
      const out = [];
      for (const p of peaks) {
        if (p.w < peaks[0].w * 0.16) break;
        if (out.every((q) => hueGap(q.hue, p.hue) >= 38)) out.push(p);
        if (out.length === 4) break;
      }
      return out.map((p) => `hsl(${Math.round(p.hue)} 85% 58%)`);
    } catch { return null; }
  }

  // Paints --c (main) and --c2..--c4 (the other brand colours; repeats when the app has fewer).
  function apply(el, list) {
    const c = list && list.length ? list : [BRAND];
    el.style.setProperty('--c', c[0]);
    el.style.setProperty('--c2', c[1] || c[0]);
    el.style.setProperty('--c3', c[2] || c[0]);
    el.style.setProperty('--c4', c[3] || c[1] || c[0]);
    el.dataset.colors = c.length;
    return c;
  }

  window.Brand = { colors, apply, BRAND };
})();
