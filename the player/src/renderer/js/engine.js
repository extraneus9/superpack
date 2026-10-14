// Playback engine around one <video> element.
// direct    → the file plays straight from disk (Chromium decoders, HEVC on the GPU).
// transcode → FFmpeg converts it live; the stream starts at `offset`, so media time = offset + currentTime.

export class Engine extends EventTarget {
  constructor(video, base) {
    super();
    this.v = video;
    this.base = base;
    this.info = null;
    this.mode = 'direct';
    this.offset = 0;
    this.hold = null;        // head position while dragging on a converted file
    this.frameTime = 0;      // media time of the frame on screen (from requestVideoFrameCallback)
    this.wantPlay = false;
    this.fellBack = false;
    this.reverse = 0;        // J shuttle speed (seconds per second, backwards)
    this._revTimer = null;
    const v = this.v;
    v.addEventListener('error', () => this._onError());
    v.addEventListener('loadedmetadata', () => this._onMeta());
    v.addEventListener('ended', () => this.dispatchEvent(new Event('ended')));
    v.addEventListener('seeking', () => this.dispatchEvent(new Event('seeking')));
    for (const ev of ['play', 'pause', 'ratechange', 'volumechange', 'waiting', 'playing', 'seeked', 'loadeddata'])
      v.addEventListener(ev, () => this.dispatchEvent(new Event('state')));
    const onFrame = (_now, meta) => {
      this.frameTime = this.offset + meta.mediaTime;
      this.dispatchEvent(new Event('frame'));
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  get fps() { return (this.info && this.info.video && this.info.video.fps) || 30; }
  get duration() { return (this.info && this.info.duration) || (isFinite(this.v.duration) ? this.offset + this.v.duration : 0); }
  get time() {
    if (this.hold != null) return this.hold;
    // while paused, the frame on screen is the truth; while playing, currentTime runs smoothly between frames
    const t = this.offset + (this.v.currentTime || 0);
    return this.v.paused && this.info && this.info.video && Math.abs(this.frameTime - t) < 1 ? this.frameTime : t;
  }
  get playing() { return !this.v.paused || this.reverse > 0; }
  get rate() { return this.v.playbackRate; }

  streamUrl(t) { return `${this.base}/stream?f=${this.info.b64}&t=${t.toFixed(3)}`; }

  load(info, startAt = 0, autoplay = false) {
    this.stopReverse();
    this.info = info;
    this.fellBack = false;
    this.hold = null;
    this.wantPlay = autoplay;
    this._pendingSeek = null;
    this.mode = info.mode;
    if (this.mode === 'direct') {
      this.offset = 0;
      this._pendingSeek = startAt > 0 ? startAt : null;
      this.v.src = info.url;
    } else {
      this.offset = Math.max(0, startAt);
      this.v.src = this.streamUrl(this.offset);
    }
    this.frameTime = startAt;
    this.v.load();
  }

  unload() { this.stopReverse(); this.info = null; this.v.removeAttribute('src'); this.v.load(); }

  // resolves once the first picture at the start position is decoded (or after `ms`)
  ready(ms = 500) {
    const v = this.v;
    const ok = () => v.readyState >= 2 && !v.seeking && this._pendingSeek == null;
    if (ok()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(t); v.removeEventListener('loadeddata', chk); v.removeEventListener('seeked', chk); v.removeEventListener('canplay', chk); resolve(r); };
      const chk = () => { if (ok()) done(true); };
      const t = setTimeout(() => done(false), ms);
      v.addEventListener('loadeddata', chk); v.addEventListener('seeked', chk); v.addEventListener('canplay', chk);
    });
  }

  _onMeta() {
    if (this._pendingSeek != null) { this.v.currentTime = this._pendingSeek; this._pendingSeek = null; }
    if (this.wantPlay) this.v.play().catch(() => {});
    this.dispatchEvent(new Event('loaded'));
  }

  _onError() {
    if (!this.info) return;
    // the file looked playable but Chromium refused it → convert it live instead
    if (this.mode === 'direct' && !this.fellBack) {
      this.fellBack = true;
      const t = this.time;
      this.mode = 'transcode';
      this.offset = Math.max(0, t);
      this.v.src = this.streamUrl(this.offset);
      this.v.load();
      this.dispatchEvent(new CustomEvent('fallback'));
      return;
    }
    this.dispatchEvent(new CustomEvent('failed', { detail: this.v.error && this.v.error.message }));
  }

  play() { this.stopReverse(); this.wantPlay = true; return this.v.play().catch(() => {}); }
  pause() { this.stopReverse(); this.wantPlay = false; this.v.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t, { keepPlaying = true } = {}) {
    if (!this.info) return;
    const d = this.duration;
    t = Math.max(0, d ? Math.min(t, d - 0.001) : t);
    this.hold = null;
    this.frameTime = t;
    this.dispatchEvent(new Event('seeking'));
    if (this.mode === 'direct') { this.v.currentTime = t; return; }
    // converted: jump inside what's already streamed, otherwise restart the stream there
    const rel = t - this.offset;
    const buf = this.v.buffered;
    if (rel >= 0 && buf.length && rel <= buf.end(buf.length - 1)) { this.v.currentTime = rel; return; }
    const was = keepPlaying && !this.v.paused;
    this.offset = t;
    this.wantPlay = was;
    this.v.src = this.streamUrl(t);
    this.v.load();
  }

  // exact frame stepping: land a tenth of a frame inside the target frame
  step(n) {
    if (!this.info) return;
    this.pause();
    const fps = this.fps;
    const idx = Math.round(this.time * fps);
    this.seek((idx + n + 0.1) / fps);
  }

  setRate(r) { this.stopReverse(); this.v.playbackRate = r; this.v.defaultPlaybackRate = r; }

  // J: play backwards by stepping (Chromium can't play in reverse); repeated J doubles the speed
  shuttleBack() {
    const next = this.reverse ? Math.min(this.reverse * 2, 16) : 1;
    this.v.pause();
    this.reverse = next;
    clearInterval(this._revTimer);
    this._revTimer = setInterval(() => {
      const t = this.time - this.reverse * 0.1;
      if (t <= 0) { this.seek(0); this.stopReverse(); return; }
      this.seek(t, { keepPlaying: false });
    }, 100);
    this.dispatchEvent(new Event('state'));
  }
  stopReverse() {
    if (!this.reverse) return;
    clearInterval(this._revTimer); this._revTimer = null; this.reverse = 0;
    this.dispatchEvent(new Event('state'));
  }
}
