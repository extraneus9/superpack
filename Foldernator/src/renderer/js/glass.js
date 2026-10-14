// Liquid Glass refraction map: a lens-shaped displacement field (strong at the rims, flat in the middle).
// feDisplacementMap samples P(x + s·(R−0.5), y + s·(G−0.5)), so R>0.5 at the left rim pulls content
// outward from inside — the bent-edge look of a thick glass slab.
export function initGlass() {
  const N = 256;
  const band = 0.2;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const f = (t) => {
    if (t < band) return Math.pow(1 - t / band, 2.2);
    if (t > 1 - band) return -Math.pow((t - (1 - band)) / band, 2.2);
    return 0;
  };
  for (let y = 0; y < N; y++) {
    const fy = f((y + 0.5) / N);
    for (let x = 0; x < N; x++) {
      const fx = f((x + 0.5) / N);
      const i = (y * N + x) * 4;
      img.data[i] = 128 + 127 * fx;
      img.data[i + 1] = 128 + 127 * fy;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  const fe = document.getElementById('lg-map');
  if (fe) {
    fe.setAttribute('href', url);
    fe.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  }
}

export function setRefraction(amount) {
  const d = document.querySelector('#lg-refract feDisplacementMap');
  if (d) d.setAttribute('scale', String(amount));
}

// ---------- Live glass ----------
// The window is excluded from screen capture, so capturing its monitor returns exactly what is BEHIND
// the window — wallpaper, other windows, a video playing — live. That stream sits under the UI, blurred,
// and the glass panels bend it at their rims (#lg-refract). It follows the window as it moves.
let live = null;      // { stream, video, displayId, info, timer }
let wanted = false;
let starting = null;

// Adaptive tint: like real Liquid Glass, the glass darkens over bright backgrounds (dark themes) and
// lightens over dark ones (light themes) so text stays readable. Samples the part of the live frame
// behind the window ~3×/s at 32×20 px (cheap).
const sampler = document.createElement('canvas');
sampler.width = 32; sampler.height = 20;
const sctx = sampler.getContext('2d', { willReadFrequently: true });

function adapt() {
  if (!live || !live.info) return;
  const v = live.video, info = live.info;
  if (!v.videoWidth) return;
  const sx = v.videoWidth / info.display.width, sy = v.videoHeight / info.display.height;
  const x = Math.max(0, (info.content.x - info.display.x) * sx), y = Math.max(0, (info.content.y - info.display.y) * sy);
  const w = Math.min(v.videoWidth - x, info.content.width * sx), h = Math.min(v.videoHeight - y, info.content.height * sy);
  if (w < 4 || h < 4) return;
  try { sctx.drawImage(v, x, y, w, h, 0, 0, 32, 20); } catch { return; }
  const d = sctx.getImageData(0, 0, 32, 20).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
  lum.sort((a, b) => a - b);
  const hi = lum[Math.floor(lum.length * 0.85)], lo = lum[Math.floor(lum.length * 0.15)];
  const root = document.documentElement.style;
  if (document.documentElement.dataset.mode === 'dark') {
    // keep the brightest part of the background at or below ~32% luminance
    root.setProperty('--glass-bright', Math.max(0.22, Math.min(0.85, 0.32 / Math.max(hi, 0.05))).toFixed(3));
    root.setProperty('--glass-veil', '0');
  } else {
    root.setProperty('--glass-bright', '1.04');
    root.setProperty('--glass-veil', Math.max(0, Math.min(0.65, 0.78 - lo)).toFixed(3));
  }
}

let frozenInfo = null; // last placement while frozen (the window can still move)

function place(info) {
  const target = live ? [live.video] : [];
  const canvas = document.querySelector('#glass-live .glass-freeze');
  if (document.documentElement.dataset.frozen) { target.push(canvas); frozenInfo = info; }
  if (live) live.info = info;
  for (const v of target) {
    v.style.width = info.display.width + 'px';
    v.style.height = info.display.height + 'px';
    v.style.transform = `translate(${info.display.x - info.content.x}px, ${info.display.y - info.content.y}px)`;
  }
}

// Freeze: keep the current frame of the background on screen, stop capturing, and let the window be
// captured again — screenshots and recordings show the app with its glass look.
export async function freezeGlass() {
  if (!live || !live.video.videoWidth) return false;
  const v = live.video, canvas = document.querySelector('#glass-live .glass-freeze');
  canvas.width = v.videoWidth; canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  document.documentElement.dataset.frozen = '1';
  const info = live.info;
  clearInterval(live.timer);
  live.stream.getTracks().forEach((t) => t.stop());
  live.video.srcObject = null;
  live = null;
  frozenInfo = info;
  place(info);
  delete document.documentElement.dataset.live;
  await window.api.glassProtect(false);
  window.dispatchEvent(new Event('liveglass'));
  return true;
}

export async function unfreezeGlass() {
  if (!document.documentElement.dataset.frozen) return false;
  const ok = await setLiveGlass(true);
  // give the fresh stream a moment so its first frames never include the window itself
  setTimeout(() => { delete document.documentElement.dataset.frozen; window.dispatchEvent(new Event('liveglass')); }, ok ? 350 : 0);
  return ok;
}

export const glassFrozen = () => !!document.documentElement.dataset.frozen;

async function startLive() {
  const api = window.api;
  const info = await api.glassStart();
  if (!info.sourceId) throw new Error('no screen to capture');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: info.sourceId, maxWidth: 2560, maxHeight: 1600, maxFrameRate: 30 } },
  });
  if (!wanted) { stream.getTracks().forEach((t) => t.stop()); api.glassStop(); return; }
  const video = document.querySelector('#glass-live video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  live = { stream, video, displayId: info.displayId };
  place(info);
  live.timer = setInterval(adapt, 330);
  setTimeout(adapt, 120);
  document.documentElement.dataset.live = '1';
  window.dispatchEvent(new Event('liveglass'));
}

function stopLive({ keepWanted = false } = {}) {
  if (!keepWanted) wanted = false;
  if (live) {
    clearInterval(live.timer);
    live.stream.getTracks().forEach((t) => t.stop());
    live.video.srcObject = null;
    live = null;
  }
  delete document.documentElement.dataset.live;
  if (!keepWanted) { delete document.documentElement.dataset.frozen; window.api.glassStop(); }
  window.dispatchEvent(new Event('liveglass'));
}

export async function setLiveGlass(on) {
  wanted = !!on && !/Macintosh/.test(navigator.userAgent);
  if (!wanted) { stopLive(); return false; }
  if (live) return true;
  if (!starting) starting = startLive().catch((e) => { console.warn('live glass unavailable:', e.message); stopLive(); }).finally(() => { starting = null; });
  await starting;
  return !!live;
}

export const liveGlassOn = () => !!live;

export function initLiveGlass() {
  const api = window.api;
  // Screenshot guard: freeze for the snip, then go live again (only if the snip froze it).
  let frozenBySnip = false;
  api.onSnipFreeze(async () => {
    if (live) { frozenBySnip = await freezeGlass(); }
    api.snipFrozen();
  });
  api.onSnipUnfreeze(async () => {
    if (frozenBySnip) { frozenBySnip = false; await unfreezeGlass(); }
  });
  api.onGlassBounds((info) => {
    if (!live) { if (document.documentElement.dataset.frozen) place(info); return; }
    if (info.displayId !== live.displayId) { stopLive({ keepWanted: true }); setLiveGlass(true); return; } // moved to another monitor
    place(info);
  });
  // Minimized/hidden: release the capture; bring it back when visible again.
  document.addEventListener('visibilitychange', () => {
    if (!wanted) return;
    if (document.hidden) stopLive({ keepWanted: true });
    else setLiveGlass(true);
  });
}
