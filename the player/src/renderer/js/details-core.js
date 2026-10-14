// Media details core — turns a full ffprobe result into readable sections. Pure JS, no DOM, no imports.
// The SAME file lives in two apps (keep them identical):
//   projects/media-player/app/src/renderer/js/details-core.js   (the player's File details drawer)
//   projects/alva-explorer/app/src/renderer/js/details-core.js  (Foldernator's Media details)
// Input `d`: { path, name, dir, size, created, modified, format, streams, chapters } (ffprobe -show_format -show_streams -show_chapters + fs.stat).

const CODEC = { h264: 'H.264 / AVC', hevc: 'HEVC / H.265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', prores: 'Apple ProRes', dnxhd: 'Avid DNxHD / DNxHR', mpeg4: 'MPEG-4 Part 2', mpeg2video: 'MPEG-2', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)', dts: 'DTS', alac: 'Apple Lossless', truehd: 'Dolby TrueHD' };
// what the player decodes natively (must match media-player src/main/media.js)
const DIRECT_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'weba']);
const DIRECT_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);

const num = (n) => Number(n || 0).toLocaleString('en-US');
const ratio = (s) => { const [a, b] = String(s || '').split('/').map(Number); return b ? a / b : a || 0; };
const fpsLabel = (f) => (f ? (Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : f.toFixed(3).replace(/0+$/, '')) : '');
function timecode(s, fps) {
  const r = Math.round(fps || 30);
  const total = Math.floor((Math.max(0, s) + 1e-6) * (fps || 30));
  const f = total % r, sec = Math.floor(total / r);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}:${p(f)}`;
}
const bytes = (n) => {
  if (!n) return '';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return i ? `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]} (${num(n)} bytes)` : `${num(n)} bytes`;
};
const bitrate = (b) => (Number(b) ? (b >= 1e6 ? `${(b / 1e6).toFixed(2)} Mb/s` : `${Math.round(b / 1e3)} kb/s`) : '');
const when = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const exactTime = (s) => {
  // round to whole milliseconds once, so 119.9998 s reads 2:00.000 (never 1:60.000)
  const ms = Math.round(Math.max(0, Number(s) || 0) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), x = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
function chroma(pix) {
  if (!pix) return '';
  if (/^(rgb|bgr|gbr|argb|rgba|bgra)/.test(pix)) return 'RGB';
  if (/444/.test(pix)) return '4:4:4';
  if (/422/.test(pix)) return '4:2:2';
  if (/420|nv12|p010|nv21/.test(pix)) return '4:2:0';
  if (/411/.test(pix)) return '4:1:1';
  if (/^gray/.test(pix)) return 'Greyscale';
  return '';
}
function bitDepth(s) {
  const raw = Number(s.bits_per_raw_sample);
  if (raw) return raw;
  const pix = String(s.pix_fmt || '');
  if (/^(rgb|bgr)48|^(rgba|bgra)64/.test(pix)) return 16;   // packed 16-bit per component
  if (/^xv30|^x2(rgb|bgr)10/.test(pix)) return 10;
  if (/^xv36/.test(pix)) return 12;
  if (/^(rgb|bgr)(565|555|444)/.test(pix)) return 0;        // mixed widths: say nothing rather than something wrong
  const m = pix.match(/p(\d{2})(le|be)?$|(\d{2})(le|be)$/);
  if (m) return Number(m[1] || m[3]);
  if (/p010/.test(pix)) return 10;
  return pix ? 8 : 0;
}
// level as people say it, per codec (ffprobe's raw numbers mean different things per codec)
const LEVEL_MPEG2 = { 4: 'High Level', 6: 'High-1440 Level', 8: 'Main Level', 10: 'Low Level' };
function levelLabel(s) {
  const l = Number(s.level);
  if (!(l > 0)) return '';
  const dec = (n) => n.toFixed(1).replace(/\.0$/, '');
  switch (s.codec_name) {
    case 'h264': return `level ${dec(l / 10)}`;
    case 'hevc': return `level ${dec(l / 30)}`;
    case 'av1': return l === 31 ? '' : `level ${2 + (l >> 2)}.${l & 3}`;
    case 'mpeg2video': return LEVEL_MPEG2[l] || '';
    default: return '';
  }
}
// a real FourCC is 4 printable characters; '[27][0][0][0]' style escapes are noise
const fourcc = (t) => (t && /^[\x20-\x7e]{4}$/.test(t) && t.trim() ? ` (${t})` : '');
const tagDur = (s) => { const m = String((s.tags || {}).DURATION || '').match(/^(\d+):(\d+):([\d.]+)/); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; };
const RANGE = { tv: 'Limited (TV)', pc: 'Full (PC)' };
const SPACE = { bt709: 'BT.709', bt470bg: 'BT.601 (PAL)', smpte170m: 'BT.601 (NTSC)', bt2020nc: 'BT.2020 (non-constant)', bt2020c: 'BT.2020 (constant)', rgb: 'RGB', smpte240m: 'SMPTE 240M' };
const PRIM = { bt709: 'BT.709', bt470bg: 'BT.601 (PAL)', smpte170m: 'BT.601 (NTSC)', bt2020: 'BT.2020', smpte432: 'Display P3', smpte431: 'DCI-P3' };
const TRC = { bt709: 'BT.709', smpte2084: 'PQ (SMPTE 2084)', 'arib-std-b67': 'HLG', iec61966_2_1: 'sRGB', linear: 'Linear', smpte170m: 'BT.601', bt2020_10: 'BT.2020 (10-bit)' };
function hdr(s) {
  const sd = s.side_data_list || [];
  if (sd.some((d) => /dovi|dolby vision/i.test(d.side_data_type || ''))) return 'Dolby Vision';
  if (s.color_transfer === 'smpte2084') return sd.some((d) => /HDR10\+|dynamic/i.test(d.side_data_type || '')) ? 'HDR10+' : 'HDR10';
  if (s.color_transfer === 'arib-std-b67') return 'HLG';
  return 'SDR';
}
const rotDeg = (s) => { const r = (s.side_data_list || []).find((d) => d.rotation != null); return Number(r ? r.rotation : (s.tags || {}).rotate || 0) || 0; };
function rotation(s) { const v = rotDeg(s); return v ? `${Math.abs(v)}°` : ''; }
const scan = (f) => (!f || f === 'unknown' ? '' : f === 'progressive' ? 'Progressive' : `Interlaced (${f === 'tt' || f === 'tb' ? 'top' : 'bottom'} field first)`);
const SAMPLE = { fltp: '32-bit float (planar)', flt: '32-bit float', s16: '16-bit', s16p: '16-bit (planar)', s32: '32-bit', s32p: '32-bit (planar)', u8: '8-bit', dbl: '64-bit float', dblp: '64-bit float (planar)' };
const layout = (a) => a.channel_layout || (a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : a.channels ? `${a.channels} channels` : '');
const tagList = (tags) => Object.entries(tags || {}).filter(([k, v]) => v !== '' && v != null && !/^(DURATION|NUMBER_OF|_STATISTICS|BPS|NUMBER_OF_BYTES)/i.test(k));
// hdlr names like 'VideoHandler', 'Core Media Audio', 'ISO Media file produced by Google Inc.' are muxer boilerplate, not titles
const GENERIC_HANDLER = /handler$|^core media \w+$|^ISO Media file produced by/i;
const trackTitle = (t) => t.title || (t.handler_name && !GENERIC_HANDLER.test(String(t.handler_name).trim()) ? t.handler_name : '');
const pretty = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bId\b/, 'ID');

// sections = [{ title, rows: [[label, value]] }]
// playMode: 'direct' | 'transcode' (what the player is actually doing), or null (outside the player: predict it)
export function detailSections(d, playMode = null) {
  const f = d.format || {};
  const streams = d.streams || [];
  const vids = streams.filter((s) => s.codec_type === 'video' && !(s.disposition || {}).attached_pic);
  const auds = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const other = streams.filter((s) => (s.codec_type === 'video' && (s.disposition || {}).attached_pic) || s.codec_type === 'data' || s.codec_type === 'attachment');
  const v0 = vids[0];
  const fps0 = v0 ? ratio(v0.avg_frame_rate !== '0/0' ? v0.avg_frame_rate : v0.r_frame_rate) : 0;
  const dur = Number(f.duration) || 0;
  // frames from the video stream itself, so the File and Video rows (and the timecode) always agree
  const vDur = v0 ? (Number(v0.duration) || tagDur(v0) || dur) : dur;
  const frames0 = v0 && fps0 ? (Number(v0.nb_frames) || Math.round(vDur * fps0)) : 0;
  const out = [];
  out.push({ title: 'File', rows: [
    ['Name', d.name], ['Folder', d.dir], ['Size', bytes(d.size)],
    ['Container', [f.format_long_name, f.format_name && `(${f.format_name})`].filter(Boolean).join(' ')],
    ['Duration', dur ? `${exactTime(dur)}${frames0 ? ` · ${num(frames0)} frames${fps0 >= 1 ? ` · ${timecode(frames0 / fps0, fps0)}` : ''}` : ''}` : ''],
    ['Overall bitrate', bitrate(f.bit_rate)],
    ['Streams', [vids.length && `${vids.length} video`, auds.length && `${auds.length} audio`, subs.length && `${subs.length} subtitle`, other.length && `${other.length} other`].filter(Boolean).join(' · ')],
    ['Created', when(d.created)], ['Modified', when(d.modified)],
  ] });
  vids.forEach((s, i) => {
    const fpsR = s.r_frame_rate, fpsA = s.avg_frame_rate, fps = ratio(fpsA !== '0/0' ? fpsA : fpsR);
    const vfr = fpsR && fpsA && fpsA !== '0/0' && Math.abs(ratio(fpsR) - ratio(fpsA)) > 0.01;
    const depth = bitDepth(s), ch = chroma(s.pix_fmt);
    const tags = s.tags || {};
    const turned = Math.abs(rotDeg(s)) % 180 === 90;
    const darRaw = s.display_aspect_ratio && s.display_aspect_ratio !== '0:1' ? s.display_aspect_ratio : '';
    const dar = turned && darRaw ? darRaw.split(':').reverse().join(':') : darRaw;
    const frames = Number(s.nb_frames) || (i === 0 ? frames0 : 0);
    out.push({ title: vids.length > 1 ? `Video ${i + 1}` : 'Video', rows: [
      ['Codec', `${CODEC[s.codec_name] || s.codec_long_name || s.codec_name}${fourcc(s.codec_tag_string)}`],
      ['Profile', [s.profile, levelLabel(s)].filter(Boolean).join(', ')],
      ['Resolution', `${s.width} × ${s.height}${s.coded_width && (s.coded_width !== s.width || s.coded_height !== s.height) ? ` (coded ${s.coded_width} × ${s.coded_height})` : ''}${turned ? ` · shown ${s.height} × ${s.width} (rotated)` : ''}`],
      ['Aspect ratio', [dar ? `${dar} display` : '', s.sample_aspect_ratio && s.sample_aspect_ratio !== '1:1' && s.sample_aspect_ratio !== '0:1' ? `${s.sample_aspect_ratio} pixels` : 'square pixels'].filter(Boolean).join(' · ')],
      ['Frame rate', fps ? `${fpsLabel(fps)} fps${fpsA && fpsA !== '0/0' ? ` (${fpsA})` : ''}${vfr ? ' · variable' : ''}` : ''],
      ['Frame count', frames ? num(frames) : ''],
      ['Bitrate', bitrate(s.bit_rate)],
      ['Pixel format', [s.pix_fmt, ch, depth ? `${depth}-bit` : ''].filter(Boolean).join(' · ')],
      ['Dynamic range', hdr(s)],
      ['Colour range', RANGE[s.color_range] || ''],
      ['Colour space', SPACE[s.color_space] || s.color_space || ''],
      ['Primaries', PRIM[s.color_primaries] || s.color_primaries || ''],
      ['Transfer', TRC[s.color_transfer] || s.color_transfer || ''],
      ['Scan', scan(s.field_order)],
      ['Rotation', rotation(s)],
      ['B-frames', s.has_b_frames != null ? (Number(s.has_b_frames) ? `yes (${s.has_b_frames})` : 'no') : ''],
      ['Timecode', tags.timecode || ''],
      ['Language', tags.language && tags.language !== 'und' ? tags.language : ''],
      ['Title', trackTitle(tags)],
    ] });
  });
  auds.forEach((s, i) => {
    const tags = s.tags || {};
    out.push({ title: auds.length > 1 ? `Audio ${i + 1}` : 'Audio', rows: [
      ['Codec', `${CODEC[s.codec_name] || s.codec_long_name || s.codec_name}${s.profile ? ` · ${s.profile}` : ''}`],
      ['Channels', [s.channels, layout(s)].filter(Boolean).join(' · ')],
      ['Sample rate', s.sample_rate ? `${+(Number(s.sample_rate) / 1000).toFixed(3)} kHz` : ''],
      ['Sample format', SAMPLE[s.sample_fmt] || s.sample_fmt || ''],
      ['Bit depth', Number(s.bits_per_raw_sample) ? `${s.bits_per_raw_sample}-bit` : Number(s.bits_per_sample) ? `${s.bits_per_sample}-bit` : ''],
      ['Bitrate', bitrate(s.bit_rate)],
      ['Language', tags.language && tags.language !== 'und' ? tags.language : ''],
      ['Title', trackTitle(tags)],
      ['Default track', (s.disposition || {}).default ? 'yes' : ''],
    ] });
  });
  if (subs.length) out.push({ title: 'Subtitles', rows: subs.map((s, i) => [`Track ${i + 1}`, [s.codec_long_name || s.codec_name, (s.tags || {}).language, (s.tags || {}).title, (s.disposition || {}).forced ? 'forced' : ''].filter(Boolean).join(' · ')]) });
  if (other.length) out.push({ title: 'Other streams', rows: other.map((s, i) => [`${s.codec_type === 'video' ? 'Cover art' : pretty(s.codec_type)} ${i + 1}`, [s.codec_long_name || s.codec_name, s.width ? `${s.width} × ${s.height}` : '', trackTitle(s.tags || {})].filter(Boolean).join(' · ')]) });
  if ((d.chapters || []).length) out.push({ title: 'Chapters', rows: d.chapters.map((c, i) => [`${i + 1}. ${exactTime(c.start_time).replace(/\.\d+$/, '')}`, (c.tags || {}).title || `Chapter ${i + 1}`]) });
  const ft = tagList(f.tags);
  if (ft.length) out.push({ title: 'Tags', rows: ft.map(([k, v]) => [pretty(k), String(v)]) });
  // how the player plays it (or would, when shown outside the player)
  const ext = String(d.name || '').split('.').pop().toLowerCase();
  const vOk = !v0 || DIRECT_VIDEO.has(v0.codec_name), aOk = !auds[0] || DIRECT_AUDIO.has(auds[0].codec_name), cOk = DIRECT_EXT.has(ext);
  const why = [!vOk && `${CODEC[v0.codec_name] || v0.codec_name} video`, !aOk && `${CODEC[auds[0].codec_name] || auds[0].codec_name} audio`, vOk && aOk && !cOk && `the .${ext} container`].filter(Boolean).join(' and ');
  const none = !v0 && !auds[0]; // the player needs a video or an audio stream
  const mode = playMode || (vOk && aOk && cOk && !none ? 'direct' : 'transcode');
  const said = !playMode && none ? 'Won’t play · no audio or video stream' : mode === 'transcode'
    ? `Converted live by FFmpeg${why ? ` (${why} isn't decoded natively)` : ''}`
    : `Direct${v0 && v0.codec_name === 'hevc' ? ' · GPU decoder' : ''}`;
  out.push({ title: playMode ? 'Playback' : 'In the player', rows: [['Decoding', said]] });
  return out.map((s) => ({ ...s, rows: s.rows.filter(([, v]) => v !== '' && v != null && v !== false && v !== 0) })).filter((s) => s.rows.length);
}

// the same report as plain text (Copy all)
export function detailsText(d, sections) {
  return [`${d.name}`, d.path, ''].concat(sections.flatMap((s) => [`${s.title.toUpperCase()}`, ...s.rows.map(([k, v]) => `  ${k}: ${v}`), ''])).join('\n');
}
