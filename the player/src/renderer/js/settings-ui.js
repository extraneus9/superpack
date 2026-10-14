// Settings drawer. Every control writes straight to settings and the change shows at once.
import { esc, icon } from './util.js';

export const ACCENTS = [
  ['#e3262d', 'alva red'], ['#f4f2ee', 'Paper'], ['#7cc4ff', 'Ice'], ['#b6f24a', 'Lime'], ['#ffb020', 'Amber'], ['#a78bfa', 'Violet'],
];
const FONTS = [['ogg', 'Ogg Text'], ['instrument', 'Instrument Serif'], ['inter', 'Inter']];
const PILLS = [['container', 'Format'], ['codec', 'Codec'], ['resolution', 'Resolution'], ['aspect', 'Aspect ratio'], ['fps', 'Frame rate'], ['duration', 'Duration']];
const ASPECTS = [['4:3', '4:3 videos'], ['16:9', '16:9 videos'], ['9:16', '9:16 videos'], ['other', 'Everything else']];

const seg = (key, value, opts) => `<div class="s-seg" role="radiogroup">${opts.map(([v, l]) =>
  `<button role="radio" aria-checked="${String(v) === String(value)}" data-set="${key}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
const toggle = (key, on, label, hint = '') => `<label class="s-tog"><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span>
  <input type="checkbox" data-set="${key}" ${on ? 'checked' : ''}><i></i></label>`;

// mini drawings of each look so the choice reads at a glance
const LOOK_CARDS = [
  ['glass', 'Glass', 'All video. A frosted dock floats over it and fades away.', '<i class="mg-dock"></i>'],
  ['editbay', 'Edit Bay', 'Timecode, filmstrip, waveform and file specs. For checking gens.', '<i class="me-side"></i><i class="me-bot"></i>'],
  ['alva', 'alva', 'Black, white and one red line. Big serif title, same-folder strip.', '<i class="ma-line"></i><i class="ma-title"></i>'],
];

export function renderSettings(s, env) {
  return `<div class="s-head"><h2>Settings</h2><button class="s-x" data-act="settings-close" aria-label="Close settings">${icon('close')}</button></div>
  <div class="s-body">
    <section><h3>Player look</h3>
      <div class="s-looks">${LOOK_CARDS.map(([id, name, desc, art]) => `<button class="s-look ${s.look === id ? 'on' : ''}" data-set="look" data-v="${id}" aria-pressed="${s.look === id}">
        <span class="mini mini-${id}">${art}</span><b>${name}</b><small>${desc}</small></button>`).join('')}</div>
      <p class="s-note">The home page is the alva showreel. Keys <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> switch looks while playing.</p>
    </section>

    <section><h3>Window</h3>
      ${toggle('wrapWindow', s.wrapWindow, 'The window takes the video\'s shape', 'Off: the window keeps the size you gave it. On: a 16:9 video gets a 16:9 window, a 4:3 video a 4:3 one.')}
      <div class="s-row"><span>When I open a file</span>${seg('startOn', s.startOn, [['play', 'Show it'], ['home', 'Show home']])}</div>
      <div class="s-row"><span>Autoplay <small>(A)</small></span>${seg('startPaused', String(s.startPaused !== false), [['false', 'On'], ['true', 'Off · wait for Play']])}</div>
      <div class="s-row"><span>Window motion</span>${seg('windowMotion', s.windowMotion || 'smooth', [['instant', 'Instant'], ['smooth', 'Smooth'], ['cinematic', 'Cinematic']])}</div>
      <p class="s-note">How the window appears and closes. Smooth is light on any PC; Cinematic adds depth and a soft focus pull, for powerful PCs.</p>
      ${toggle('stayReady', s.stayReady !== false, 'Stay ready after closing', 'Opens files almost instantly. Closing hides the player instead of quitting; quit from its icon next to the clock.')}
      ${toggle('startWithWindows', s.startWithWindows !== false, 'Start with Windows, in the background', 'So the first file of the day opens instantly too. Only while "Stay ready" is on.')}
    </section>

    <section><h3>Home page</h3>
      ${toggle('homeRows.played', (s.homeRows || {}).played !== false, 'Recently played', 'Everything you played here, newest first.')}
      ${toggle('homeRows.downloads', (s.homeRows || {}).downloads !== false, 'Recent downloads', 'Video and audio in Downloads and its folders, newest first.')}
      ${toggle('homeRows.pc', (s.homeRows || {}).pc !== false, 'Recent on this PC', 'Video and audio Windows lists as recently opened, in any app.')}
    </section>

    <section><h3>Colour and type</h3>
      <div class="s-row"><span>Accent</span><div class="s-swatches">${ACCENTS.map(([c, n]) => `<button class="sw ${s.accent.toLowerCase() === c ? 'on' : ''}" style="--c:${c}" data-set="accent" data-v="${c}" title="${n}" aria-label="${n}"></button>`).join('')}
        <label class="sw custom" title="Custom colour"><input type="color" value="${esc(s.accent)}" data-set="accent"></label></div></div>
      <div class="s-row"><span>Title font</span>${seg('titleFont', s.titleFont, FONTS)}</div>
    </section>

    <section><h3>Glass</h3>
      <div class="s-row"><span>Blur <output data-out="glassBlur">${s.glassBlur}px</output></span><input type="range" min="0" max="60" step="1" value="${s.glassBlur}" data-set="glassBlur"></div>
      <div class="s-row"><span>Frost <output data-out="glassTint">${s.glassTint}%</output></span><input type="range" min="0" max="40" step="1" value="${s.glassTint}" data-set="glassTint"></div>
      <div class="s-row"><span>Hide controls after <output data-out="hideDelay">${s.hideDelay}s</output></span><input type="range" min="0.8" max="5" step="0.2" value="${s.hideDelay}" data-set="hideDelay"></div>
      <div class="s-sub">Info at the top</div>
      <div class="s-chips">${PILLS.map(([k, l]) => `<label class="chip"><input type="checkbox" data-set="pills.${k}" ${s.pills[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </section>

    <section><h3>Picture</h3>
      <p class="s-note">When the window can't take the video's shape (maximised, fullscreen, or with that option off): Fit shows the whole frame, Fill crops it to cover. <kbd>Z</kbd> flips it while playing and remembers it for that shape.</p>
      ${ASPECTS.map(([k, l]) => `<div class="s-row"><span>${l}</span>${seg('fit.' + k, s.fit[k] || 'fit', [['fit', 'Fit'], ['fill', 'Fill']])}</div>`).join('')}
    </section>

    <section><h3>Playback</h3>
      <div class="s-row"><span>Skip with ← →</span>${seg('seekStep', s.seekStep, [[2, '2 s'], [5, '5 s'], [10, '10 s']])}</div>
      ${toggle('resume', s.resume, 'Remember where I stopped', 'Each file reopens at the same moment.')}
      ${toggle('autoplayNext', s.autoplayNext, 'Play the next file in the folder')}
      ${toggle('loop', s.loop, 'Loop the file')}
    </section>

    <section><h3>Saved frames</h3>
      <div class="s-path"><span title="${esc(s.snapshotDir)}">${esc(s.snapshotDir)}</span><button class="s-btn" data-act="snap-folder">Change</button></div>
    </section>

    <section><h3>Windows</h3>
      <button class="s-btn wide accent" data-act="register-default">Set as my default player</button>
      <p class="s-note">Registers the player for every video and audio format and opens Windows Settings. Choose <b>the player</b> there once.</p>
      <button class="s-btn wide" data-act="shortcuts">Add Start menu and desktop shortcuts</button>
    </section>

    <section class="s-about"><h3>Engine</h3>
      <p class="s-note">${env.ffmpeg ? `FFmpeg ready · conversion on ${env.encoder === 'h264_nvenc' ? 'the GPU (NVENC)' : 'the CPU'}` : 'FFmpeg not found. Only formats Windows can decode will play.'}</p>
    </section>
  </div>`;
}
