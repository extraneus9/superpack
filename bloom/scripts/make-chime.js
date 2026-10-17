// Renders bloom's own default notification sound → assets/sounds/bloom chime.wav (made here, free to share).
// A soft two-note bell (E6 then B6), short and quiet: anyone who installs bloom gets this until they drop their own sound.
const fs = require('fs');
const path = require('path');

const SR = 48000, DUR = 0.9, N = Math.round(SR * DUR);
const pcm = new Float32Array(N);
// a bell partial: sine with a soft attack and an exponential tail, plus a quieter octave and a slightly inharmonic overtone
function bell(start, f, gain, decay) {
  const s0 = Math.round(start * SR);
  for (let i = s0; i < N; i++) {
    const t = (i - s0) / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / decay);
    pcm[i] += gain * env * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / (decay * 0.5)) + 0.12 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / (decay * 0.3)));
  }
}
bell(0.00, 1318.5, 0.32, 0.22); // E6
bell(0.11, 1975.5, 0.26, 0.28); // B6
// gentle fade at the very end so it never clicks
for (let i = N - 2400; i < N; i++) pcm[i] *= (N - i) / 2400;
const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const buf = Buffer.alloc(44 + N * 4); // 16-bit stereo
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { const v = Math.round((pcm[i] / peak) * 0.7 * 32767); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
const out = path.join(__dirname, '..', 'assets', 'sounds');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'bloom chime.wav'), buf);
console.log('written', path.join(out, 'bloom chime.wav'), buf.length, 'bytes');
