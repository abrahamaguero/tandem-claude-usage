// Synthesizes five clean, bell-like notification tones as 16-bit mono WAV files.
import fs from 'node:fs';
import path from 'node:path';

const RATE = 44100;
const outDir = process.argv[2];

// A struck-bar voice: fundamental plus a couple of quieter partials, each dying away exponentially.
function bell(buf, start, freq, { decay = 0.25, gain = 1, partials = [[1, 1], [2, 0.28], [4.2, 0.1]] } = {}) {
  const from = Math.floor(start * RATE);
  const length = Math.floor(decay * 6 * RATE);
  for (let i = 0; i < length && from + i < buf.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.004);
    let sample = 0;
    for (const [ratio, amp] of partials) sample += amp * Math.sin(2 * Math.PI * freq * ratio * t) * Math.exp(-t / (decay / Math.sqrt(ratio)));
    buf[from + i] += sample * attack * gain;
  }
}

// A soft "bubble": a sine whose pitch glides upwards quickly.
function pop(buf, start, f0, f1, dur, gain = 1) {
  const from = Math.floor(start * RATE);
  const length = Math.floor(dur * RATE);
  let phase = 0;
  for (let i = 0; i < length && from + i < buf.length; i++) {
    const x = i / length;
    phase += (2 * Math.PI * (f0 + (f1 - f0) * x * x)) / RATE;
    buf[from + i] += Math.sin(phase) * Math.sin(Math.PI * x) ** 1.5 * gain;
  }
}

function write(name, seconds, build) {
  const buf = new Float64Array(Math.floor(seconds * RATE));
  build(buf);
  const fade = Math.floor(0.03 * RATE);
  for (let i = 0; i < fade; i++) buf[buf.length - 1 - i] *= i / fade;
  const peak = Math.max(...buf.map(Math.abs)) || 1;
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round((buf[i] / peak) * 0.8 * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(outDir, `${name}.wav`), Buffer.concat([header, data]));
  console.log(name, `${seconds}s`);
}

const N = { G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093, E7: 2637.02, G7: 3135.96, C5: 523.25, E5: 659.25 };

// Note: one warm bell with a quiet fifth above it.
write('note', 0.9, (b) => { bell(b, 0, N.A5, { decay: 0.3 }); bell(b, 0, N.E6, { decay: 0.22, gain: 0.35 }); });
// Tri-tone: three quick rising mallet notes.
write('tritone', 0.8, (b) => { bell(b, 0, N.G5, { decay: 0.12 }); bell(b, 0.1, N.C6, { decay: 0.12 }); bell(b, 0.2, N.E6, { decay: 0.2 }); });
// Glass: two very high, thin partials struck together, then a sparkle.
write('glass', 0.7, (b) => { const thin = [[1, 1], [2.76, 0.2]]; bell(b, 0, N.C7, { decay: 0.14, partials: thin }); bell(b, 0, N.G7, { decay: 0.1, gain: 0.5, partials: thin }); bell(b, 0.09, N.E7, { decay: 0.16, gain: 0.6, partials: thin }); });
// Pop: two soft bubbles, the second higher.
write('pop', 0.4, (b) => { pop(b, 0, 420, 880, 0.07); pop(b, 0.11, 560, 1180, 0.08); });
// Chord: a fast upward strum that rings briefly.
write('chord', 1.0, (b) => { [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => bell(b, i * 0.035, f, { decay: 0.3, gain: 0.8 })); });
