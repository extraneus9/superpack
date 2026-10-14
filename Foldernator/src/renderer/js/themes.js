// Theme presets + application. Every field is editable in Settings → Appearance.
import { mix, withAlpha, luminance, hexToRgb } from './util.js';
import { setRefraction, setLiveGlass } from './glass.js';

export const PRESETS = {
  'windows-dark': {
    name: 'Windows Dark', mode: 'dark', material: 'mica',
    bg: '#202020', panel: '#1c1c1c', panelOpacity: 0.62, text: '#f3f3f3', accent: '#4cc2ff', folder: '#f2c55c',
    font: 'Segoe UI Variable Text, Segoe UI, Inter, sans-serif', fontSize: 13, density: 'normal', radius: 6,
    bgImage: '', bgImageOpacity: 0.25, bgBlur: 0,
  },
  'windows-light': {
    name: 'Windows Light', mode: 'light', material: 'mica',
    bg: '#f3f3f3', panel: '#ffffff', panelOpacity: 0.7, text: '#1b1b1b', accent: '#005fb8', folder: '#e8b840',
    font: 'Segoe UI Variable Text, Segoe UI, Inter, sans-serif', fontSize: 13, density: 'normal', radius: 6,
    bgImage: '', bgImageOpacity: 0.25, bgBlur: 0,
  },
  alva: {
    name: 'alva', mode: 'dark', material: 'none',
    bg: '#070707', panel: '#0e0e0e', panelOpacity: 1, text: '#f4f4f2', accent: '#e3150f', folder: '#ecebe6',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 2,
    bgImage: '', bgImageOpacity: 0.2, bgBlur: 0,
  },
  paper: {
    name: 'Paper', mode: 'light', material: 'none',
    bg: '#e9e3d8', panel: '#f6f2ea', panelOpacity: 1, text: '#2b2621', accent: '#b2532b', folder: '#c79f5f',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'comfy', radius: 10,
    bgImage: '', bgImageOpacity: 0.2, bgBlur: 0,
  },
  'liquid-glass': {
    name: 'Liquid Glass', mode: 'dark', material: 'liquid', liveGlass: true, glassBlur: 22,
    bg: '#0e1016', panel: '#14161d', panelOpacity: 0.30, text: '#f6f7fb', accent: '#8ab4ff', folder: '#f4c766',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 14, refraction: 0.06,
    bgImage: '', bgImageOpacity: 0.55, bgBlur: 0,
  },
  'liquid-glass-light': {
    name: 'Liquid Glass Light', mode: 'light', material: 'liquid', liveGlass: true, glassBlur: 22,
    bg: '#eef1f6', panel: '#ffffff', panelOpacity: 0.38, text: '#14161b', accent: '#0a64ff', folder: '#efb63c',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 14, refraction: 0.06,
    bgImage: '', bgImageOpacity: 0.55, bgBlur: 0,
  },
  'liquid-glass-single': {
    name: 'Liquid Glass · Single', mode: 'dark', material: 'liquid', glassLayout: 'single', liveGlass: true, glassBlur: 22,
    bg: '#0e1016', panel: '#14161d', panelOpacity: 0.36, text: '#f6f7fb', accent: '#8ab4ff', folder: '#f4c766',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 14, refraction: 0.06,
    bgImage: '', bgImageOpacity: 0.55, bgBlur: 0,
  },
  'liquid-glass-single-light': {
    name: 'Liquid Glass · Single Light', mode: 'light', material: 'liquid', glassLayout: 'single', liveGlass: true, glassBlur: 22,
    bg: '#eef1f6', panel: '#ffffff', panelOpacity: 0.42, text: '#14161b', accent: '#0a64ff', folder: '#efb63c',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 14, refraction: 0.06,
    bgImage: '', bgImageOpacity: 0.55, bgBlur: 0,
  },
  midnight: {
    name: 'Midnight', mode: 'dark', material: 'acrylic',
    bg: '#0b1020', panel: '#10172c', panelOpacity: 0.78, text: '#dfe6ff', accent: '#7aa2ff', folder: '#7aa2ff',
    font: 'Inter, Segoe UI, sans-serif', fontSize: 13, density: 'normal', radius: 8,
    bgImage: '', bgImageOpacity: 0.3, bgBlur: 0,
  },
};

export const DENSITY = { compact: 26, normal: 32, comfy: 38 };

export function resolveTheme(settings) {
  const id = settings.themeId;
  return (settings.customThemes && settings.customThemes[id]) || PRESETS[id] || PRESETS['windows-dark'];
}

export function applyTheme(t) {
  const r = document.documentElement.style;
  const dark = t.mode === 'dark';
  // Glass needs stronger secondary text: the background behind it can be anything.
  const textDim = mix(t.text, t.bg, t.material === 'liquid' ? 0.26 : 0.42);
  const solidPanel = t.panel;
  const translucent = t.material !== 'none';
  const panel = translucent ? withAlpha(t.panel, t.panelOpacity) : solidPanel;
  r.setProperty('--bg', translucent ? 'transparent' : t.bg);
  r.setProperty('--bg-solid', t.bg);
  r.setProperty('--chrome', translucent ? 'transparent' : t.bg);
  r.setProperty('--panel', panel);
  r.setProperty('--panel-solid', solidPanel);
  r.setProperty('--text', t.text);
  r.setProperty('--text-dim', textDim);
  r.setProperty('--text-faint', mix(t.text, t.bg, t.material === 'liquid' ? 0.45 : 0.62));
  r.setProperty('--accent', t.accent);
  r.setProperty('--accent-text', luminance(t.accent) > 0.45 ? '#000000' : '#ffffff');
  r.setProperty('--hover', withAlpha(t.text, dark ? 0.06 : 0.05));
  r.setProperty('--press', withAlpha(t.text, dark ? 0.1 : 0.09));
  r.setProperty('--border', withAlpha(t.text, dark ? 0.09 : 0.1));
  r.setProperty('--border-strong', withAlpha(t.text, dark ? 0.16 : 0.18));
  r.setProperty('--sel', withAlpha(t.accent, dark ? 0.22 : 0.16));
  r.setProperty('--sel-hover', withAlpha(t.accent, dark ? 0.3 : 0.22));
  r.setProperty('--sel-border', withAlpha(t.accent, 0.55));
  r.setProperty('--menu', dark ? mix(t.panel, '#ffffff', 0.04) : mix(t.panel, '#ffffff', 0.6));
  r.setProperty('--input', withAlpha(t.text, dark ? 0.06 : 0.04));
  r.setProperty('--folder', t.folder);
  r.setProperty('--font', t.font);
  r.setProperty('--fs', t.fontSize + 'px');
  r.setProperty('--row-h', (DENSITY[t.density] || 32) + 'px');
  r.setProperty('--radius', t.radius + 'px');
  r.setProperty('--radius-sm', Math.max(0, Math.round(t.radius * 0.66)) + 'px');
  r.setProperty('--bg-image', t.bgImage ? `url("${t.bgImage}")` : 'none');
  r.setProperty('--bg-image-opacity', String(t.bgImageOpacity ?? 0.25));
  r.setProperty('--bg-blur', (t.bgBlur || 0) + 'px');
  // Liquid Glass tuning (used only when material = liquid)
  const [pr, pg, pb] = hexToRgb(t.panel);
  r.setProperty('--lg-sheen', dark ? '0.13' : '0.55');
  r.setProperty('--lg-top', dark ? '0.07' : '0.38');
  r.setProperty('--lg-bottom', dark ? '0.015' : '0.12');
  r.setProperty('--lg-rim', dark ? '0.30' : '0.95');
  r.setProperty('--lg-shadow', dark ? '0.30' : '0.12');
  r.setProperty('--lg-radius', Math.max(10, t.radius + 4) + 'px');
  r.setProperty('--lg-glass-rgb', `${pr}, ${pg}, ${pb}`);
  r.setProperty('--lg-glass-a', String(Math.min(0.85, (t.panelOpacity ?? 0.4) + 0.1)));
  setRefraction(t.refraction ?? 0.06);
  // Live glass: blur + tone of the captured background (dark themes dim it a little for legibility).
  r.setProperty('--glass-blur', (t.glassBlur ?? 22) + 'px');
  r.setProperty('--glass-tone', dark ? 'saturate(1.5)' : 'saturate(1.35)');
  setLiveGlass(t.material === 'liquid' && t.liveGlass !== false);
  r.setProperty('--shadow', dark ? '0 8px 28px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06)' : '0 8px 28px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.06)');
  document.documentElement.dataset.mode = t.mode;
  document.documentElement.dataset.material = t.material;
  document.documentElement.dataset.glassLayout = t.glassLayout === 'single' ? 'single' : 'cards';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  window.api.windowChrome({
    color: translucent ? '#00000000' : t.bg,
    symbolColor: t.text,
    material: t.material === 'none' ? 'none' : t.material === 'liquid' ? 'acrylic' : t.material,
    mode: t.mode,
  });
}
