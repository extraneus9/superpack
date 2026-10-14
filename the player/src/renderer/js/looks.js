// Markup for the three player looks. Buttons carry data-act (handled once in app.js), live text carries
// data-bind, moving parts carry data-prog (driven by transforms every display frame), and
// data-slot="stage" is where the video goes.
import { icon, winButtons, esc, fmt, fpsLabel, rate, bytes, projectTitle, titleFor, crumbs, stem, timecode } from './util.js';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
export const speedLabel = (r) => ({ 0.25: '¼×', 0.5: '½×', 0.75: '¾×', 1.25: '1¼×', 1.5: '1½×' }[r] || `${r}×`);

export function specLine(info) {
  if (!info) return '';
  const v = info.video, a = info.audio, bits = [];
  if (v) bits.push(`${v.dispW} × ${v.dispH}`, `${fpsLabel(v.fps)} fps`, v.codecName);
  else if (a) bits.push(a.codecName, a.sampleRate ? `${(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)} kHz` : '');
  bits.push(fmt(info.duration));
  return bits.filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
}

export function pills(info, on) {
  if (!info) return '';
  const v = info.video, out = [];
  if (on.container) out.push(info.container);
  if (on.codec) out.push(v ? v.codecName : info.audio && info.audio.codecName);
  if (on.resolution && v) out.push(`${v.dispW}×${v.dispH}`);
  if (on.aspect && v && v.aspect) out.push(v.aspect);
  if (on.fps && v) out.push(`${fpsLabel(v.fps)} fps`);
  if (on.duration) out.push(fmt(info.duration));
  return [...new Set(out.filter(Boolean))].map((p) => `<span>${esc(p)}</span>`).join('');
}

// the way back to the home page — big enough to find over any picture
const backPill = (cls = '') => `<button class="back-pill nd ${cls}" data-act="home" title="Back to home  (Esc)" aria-label="Back to home">${icon('chevL')}<span>Home</span></button>`;

// a scrub bar: fill + buffer + loop + a full-width track that slides the knob; hover preview rides its own track
const hoverPrev = () => `<div class="hp-track" data-hp><div class="hover-prev"><canvas width="320" height="180"></canvas><img alt=""><b></b></div></div>`;

function nextCards(ctx) {
  const { siblings, info, base } = ctx;
  return siblings.filter((s) => s.path !== info.path).map((s) => `<button class="card" data-act="pick" data-path="${esc(s.path)}" title="${esc(s.name)}">
      ${s.kind === 'video' ? `<i style="background-image:url('${base}/frame?f=${s.b64}&p=0.3&w=240')"></i>` : `<i class="aud">${icon('music')}</i>`}
      <div><b>${esc(stem(s.name))}</b><span data-dur="${esc(s.path)}">${esc(s.ext.toUpperCase())}</span></div></button>`).join('');
}

// ---------- A · Glass ----------
function glass(ctx) {
  const { info, settings } = ctx;
  return `<div class="L glass">
    <div class="slot" data-slot="stage" data-act="toggle-click"></div>
    <div class="g-shade" aria-hidden="true"></div>
    <div class="g-top drag">
      ${backPill()}
      <span class="g-name"><b>${esc(info.name)}</b><span>${esc(projectTitle(info.dir))}</span></span><span class="sp"></span>
      <button data-act="settings" class="nd tbtn" aria-label="Settings" title="Settings  (Ctrl+,)">${icon('gear')}</button>${winButtons()}</div>
    <div class="g-pills" data-pills>${pills(info, settings.pills)}</div>
    <div class="g-dock" data-keepalive>
      <div class="g-scrub" data-scrub><div class="rail">
        <div class="buf" data-prog="buf"></div><div class="loopr" data-loop></div><div class="played" data-prog="scale"></div>
        <div class="track" data-prog="move"><div class="knob"></div></div></div>${hoverPrev()}</div>
      <div class="g-row">
        <div class="g-left"><span class="t" data-bind="cur">0:00</span><span class="t dim">/ ${fmt(info.duration)}</span></div>
        <div class="g-mid">
          <button class="skip" data-act="back" aria-label="Back ${settings.seekStep} seconds" title="Back ${settings.seekStep} s  (←)">${icon('back')}</button>
          <button data-act="frame-prev" aria-label="Previous frame" title="Previous frame  ( , )">${icon('prevFrame')}</button>
          <button class="play" data-act="toggle" aria-label="Play or pause" title="Play / pause  (Space)"><span data-bind="pp-icon">${icon('play')}</span></button>
          <button data-act="frame-next" aria-label="Next frame" title="Next frame  ( . )">${icon('nextFrame')}</button>
          <button class="skip" data-act="fwd" aria-label="Forward ${settings.seekStep} seconds" title="Forward ${settings.seekStep} s  (→)">${icon('fwd')}</button>
        </div>
        <div class="g-right">
          <span class="g-vol"><button data-act="mute" aria-label="Mute" title="Mute  (M)"><span data-bind="vol-icon">${icon('vol')}</span></button>
            <input type="range" min="0" max="1" step="0.01" data-vol aria-label="Volume"></span>
          <button class="spd" data-act="speed-cycle" title="Speed  ( [ ] )" data-bind="speed">1×</button>
          <button class="auto" data-act="autoplay" aria-pressed="false" title="Autoplay: start files on open  (A)" aria-label="Autoplay">${icon('autoplay')}</button>
          <button data-act="details" title="File details  (D)" aria-label="File details">${icon('info')}</button>
          <button data-act="fit" title="Fit / Fill  (Z)" aria-label="Fit or fill"><span data-bind="fit-icon">${icon('fit')}</span></button>
          <button data-act="fullscreen" title="Fullscreen  (F)" aria-label="Fullscreen"><span data-bind="full-icon">${icon('full')}</span></button>
        </div>
      </div>
    </div></div>`;
}

// ---------- B · Edit Bay ----------
function editbay(ctx) {
  const { info } = ctx;
  const v = info.video, a = info.audio;
  const row = (k, val) => (val ? `<dt>${k}</dt><dd title="${esc(val)}">${esc(val)}</dd>` : '');
  return `<div class="L editbay">
    <div class="e-tb drag">
      ${backPill('dark')}
      <span class="menu"><button class="nd" data-act="open">Open</button><button class="nd" data-act="details" title="File details  (D)">Details</button><button class="nd" data-act="settings">Settings</button></span>
      <span class="path" title="${esc(info.path)}">${esc(info.dir)}\\<b>${esc(info.name)}</b></span>${winButtons()}</div>
    <div class="e-main">
      <div class="e-view"><div class="slot" data-slot="stage" data-act="toggle-click"></div>
        <div class="e-hud">${v && v.aspect ? `<span>${esc(v.aspect)}</span>` : ''}<span data-bind="fit-word">FIT</span><span class="rec" data-bind="loop-word" hidden>LOOP A–B</span><span class="conv" data-bind="conv-word" hidden>CONVERTED LIVE</span></div></div>
      <aside class="e-insp">
        <div><h4>File</h4><dl>${row('Container', info.container)}${row('Size', bytes(info.size))}${row('Duration', timecode(info.duration, v ? v.fps : 30))}</dl></div>
        ${v ? `<div><h4>Video</h4><dl>${row('Codec', `${v.codecName}${v.pixFmt ? ' · ' + v.pixFmt : ''}`)}${row('Size', `${v.dispW} × ${v.dispH}`)}${row('Frame rate', `${fpsLabel(v.fps)} fps`)}${row('Bitrate', rate(v.bitrate || info.bitrate))}</dl></div>` : ''}
        ${a ? `<div><h4>Audio</h4><dl>${row('Codec', `${a.codecName}${a.channels ? ' · ' + (a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : a.channels + ' ch') : ''}`)}${row('Sample', [a.sampleRate ? `${a.sampleRate / 1000} kHz` : '', rate(a.bitrate)].filter(Boolean).join(' · '))}</dl></div>` : ''}
        <button class="btn d-more" data-act="details">${icon('info')} All file details <kbd>D</kbd></button>
        <div><h4>Autoplay <kbd>A</kbd></h4><div class="seg"><button data-act="autoplay-set" data-v="on">On</button><button data-act="autoplay-set" data-v="off">Off</button></div></div>
        <div><h4>Speed</h4><div class="seg">${SPEEDS.map((s) => `<button data-act="speed" data-v="${s}">${speedLabel(s)}</button>`).join('')}</div></div>
        ${v ? `<div><h4>Picture</h4><div class="seg"><button data-act="fit-set" data-v="fit">Fit</button><button data-act="fit-set" data-v="fill">Fill</button></div></div>` : ''}
        <div><h4>Loop</h4><div class="ab"><button class="btn" data-act="loop-in">In <kbd>I</kbd></button><button class="btn" data-act="loop-out">Out <kbd>O</kbd></button><button class="btn" data-act="loop-clear" title="Clear loop">${icon('close')}</button></div></div>
        ${v ? `<button class="btn wide" data-act="snapshot">Save this frame as PNG <kbd>S</kbd></button>` : ''}
      </aside>
    </div>
    <div class="e-tr">
      <div class="e-ctl">
        <span class="tc"><span data-bind="tc">00:00:00:00</span><small data-bind="frames"></small></span>
        <div class="tp">
          <button data-act="frame-prev" aria-label="Previous frame" title="Previous frame  ( , )">${icon('prevFrame')}</button>
          <button class="pp" data-act="toggle" aria-label="Play or pause" title="Play / pause  (Space)"><span data-bind="pp-icon">${icon('play')}</span></button>
          <button data-act="frame-next" aria-label="Next frame" title="Next frame  ( . )">${icon('nextFrame')}</button>
        </div>
        <span class="keys"><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd>shuttle</span><span><kbd>,</kbd><kbd>.</kbd>frame</span><span><kbd>I</kbd><kbd>O</kbd>loop</span></span>
        <span class="r"><span data-bind="rem-tc"></span><button class="nd vol" data-act="mute" data-bind="vol-word">VOL 80</button><span data-bind="speed">1×</span></span>
      </div>
      <div class="e-lanes" data-scrub="lanes">
        <div class="ruler" data-ruler></div>
        <div class="strip" data-strip></div>
        <div class="wave" data-wave></div>
        <div class="lane-box"><div class="loopr" data-loop><b class="a">A</b><b class="b">B</b></div>
          <div class="head-track" data-prog="move"><div class="head"></div></div></div>
      </div>
    </div></div>`;
}

// ---------- C · alva ----------
function alva(ctx) {
  const { info } = ctx;
  const cards = nextCards(ctx);
  return `<div class="L alva">
    <div class="a-tb drag">${backPill('line')}
      <span class="crumb">${crumbs(info.dir).map(esc).join('<span class="sep">/</span>')}</span><span class="sp"></span>
      <button data-act="settings" class="nd tbtn" aria-label="Settings">${icon('gear')}</button>${winButtons()}</div>
    <div class="a-screen"><div class="slot" data-slot="stage" data-act="toggle-click"></div></div>
    <div class="a-under">
      <div class="a-prog" data-scrub><div class="rail"><div class="loopr" data-loop></div><div class="done" data-prog="scale"></div>
        <div class="track" data-prog="move"><div class="dot"></div></div></div>${hoverPrev()}</div>
      <div class="a-title"><h3>${esc(titleFor(info))}<em>.</em></h3><span class="meta"><b>${esc(info.name)}</b> &nbsp;·&nbsp; ${specLine(info)}</span></div>
      <div class="a-ctrl">
        <span class="tm"><b data-bind="cur">0:00</b> / ${fmt(info.duration)}</span>
        <button data-act="frame-prev" aria-label="Previous frame" title="Previous frame  ( , )">${icon('prevFrame')}</button>
        <button class="pp" data-act="toggle" aria-label="Play or pause"><span data-bind="pp-icon">${icon('play')}</span><span data-bind="pp-word">Play</span></button>
        <button data-act="frame-next" aria-label="Next frame" title="Next frame  ( . )">${icon('nextFrame')}</button>
        <button data-act="mute" aria-label="Mute" title="Mute  (M)"><span data-bind="vol-icon">${icon('vol')}</span></button>
        <button class="auto" data-act="autoplay" aria-pressed="false" title="Autoplay: start files on open  (A)" aria-label="Autoplay">${icon('autoplay')}</button>
        <button data-act="details" aria-label="File details" title="File details  (D)">${icon('info')}</button>
        <button data-act="fit" aria-label="Fit or fill" title="Fit / Fill  (Z)"><span data-bind="fit-icon">${icon('fit')}</span></button>
        <button data-act="fullscreen" aria-label="Fullscreen" title="Fullscreen  (F)"><span data-bind="full-icon">${icon('full')}</span></button>
      </div>
      ${cards ? `<div class="a-next"><span class="lbl">Same folder<br>up next</span><div class="cards">${cards}</div></div>` : ''}
    </div></div>`;
}

export const LOOKS = { glass, editbay, alva };
export const LOOK_NAMES = { glass: 'Glass', editbay: 'Edit Bay', alva: 'alva' };
