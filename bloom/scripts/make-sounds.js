// Renders bloom's built-in notification sounds → assets/sounds/*.wav (made here in code, free to share).
// Writes files only; nothing is played. Run: node scripts/make-sounds.js
const fs = require('fs');
const path = require('path');

const SR = 48000;
const out = path.join(__dirname, '..', 'assets', 'sounds');

function render(name, dur, draw) {
  const N = Math.round(SR * dur);
  const pcm = new Float32Array(N);
  draw(pcm, N);
  for (let i = N - 2400; i < N; i++) pcm[i] *= (N - i) / 2400; // soft end, never clicks
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const buf = Buffer.alloc(44 + N * 4); // 16-bit stereo
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) { const v = Math.round((pcm[i] / peak) * 0.7 * 32767); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name + '.wav'), buf);
  console.log('written', name, buf.length, 'bytes');
}

// a bell partial: sine with a soft attack and an exponential tail, plus a quieter octave and a slightly inharmonic overtone
const bell = (pcm, N, start, f, gain, decay) => {
  for (let i = Math.round(start * SR); i < N; i++) {
    const t = i / SR - start;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / decay);
    pcm[i] += gain * env * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / (decay * 0.5)) + 0.12 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / (decay * 0.3)));
  }
};

// 1. bloom chime: soft two-note bell, E6 then B6
render('bloom chime', 0.9, (p, N) => { bell(p, N, 0, 1318.5, 0.32, 0.22); bell(p, N, 0.11, 1975.5, 0.26, 0.28); });

// 2. glass: one bright struck-glass ping with a slow shimmer
render('glass', 1.1, (p, N) => {
  for (let i = 0; i < N; i++) {
    const t = i / SR, a = Math.min(1, t / 0.002);
    p[i] = a * (0.5 * Math.sin(2 * Math.PI * 2093 * t) * Math.exp(-t / 0.35) * (1 + 0.15 * Math.sin(2 * Math.PI * 5 * t))
      + 0.22 * Math.sin(2 * Math.PI * 2093 * 2.32 * t) * Math.exp(-t / 0.12)
      + 0.12 * Math.sin(2 * Math.PI * 2093 * 4.1 * t) * Math.exp(-t / 0.05));
  }
});

// 3. pop: a short round bubble pop, pitch sliding up
render('pop', 0.35, (p, N) => {
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, f = 420 + 900 * (1 - Math.exp(-t / 0.03));
    ph += 2 * Math.PI * f / SR;
    p[i] = Math.min(1, t / 0.0015) * Math.exp(-t / 0.06) * Math.sin(ph);
  }
});

// 4. rise: three quick soft notes going up (C6, E6, G6)
render('rise', 0.95, (p, N) => { [1046.5, 1318.5, 1568].forEach((f, k) => bell(p, N, k * 0.085, f, 0.3, 0.16 + k * 0.05)); });
