// Synthesised sound effects — no audio files needed.

let ac = null;
let master = null;
const last = {};

let muted = false;
try {
  muted = localStorage.getItem('pv-muted') === '1';
} catch {
  /* storage unavailable */
}

function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function tone({ type = 'square', f0, f1 = f0, dur = 0.12, vol = 0.12, delay = 0 }) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuffer = null;
function noise({ dur = 0.3, vol = 0.25, freq = 1200, delay = 0 }) {
  const a = audio();
  if (!a) return;
  if (!noiseBuffer) {
    noiseBuffer = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime + delay;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

const SOUNDS = {
  shoot: () => tone({ type: 'square', f0: 900, f1: 240, dur: 0.07, vol: 0.05 }),
  laser: () => tone({ type: 'sawtooth', f0: 1300, f1: 320, dur: 0.09, vol: 0.04 }),
  hit: () => tone({ type: 'triangle', f0: 320, f1: 90, dur: 0.12, vol: 0.18 }),
  explode: () => noise({ dur: 0.55, vol: 0.4, freq: 900 }),
  smallExplode: () => noise({ dur: 0.25, vol: 0.22, freq: 1400 }),
  pickup: () => {
    tone({ type: 'sine', f0: 660, dur: 0.08, vol: 0.12 });
    tone({ type: 'sine', f0: 990, dur: 0.12, vol: 0.12, delay: 0.07 });
  },
  coin: () => {
    tone({ type: 'square', f0: 988, dur: 0.06, vol: 0.05 });
    tone({ type: 'square', f0: 1319, dur: 0.14, vol: 0.05, delay: 0.06 });
  },
  punch: () => noise({ dur: 0.08, vol: 0.35, freq: 2200 }),
  kick: () => {
    noise({ dur: 0.12, vol: 0.4, freq: 1200 });
    tone({ type: 'sine', f0: 170, f1: 60, dur: 0.16, vol: 0.25 });
  },
  whiff: () => noise({ dur: 0.07, vol: 0.08, freq: 4000 }),
  block: () => tone({ type: 'square', f0: 1500, f1: 900, dur: 0.05, vol: 0.06 }),
  jump: () => tone({ type: 'sine', f0: 280, f1: 620, dur: 0.12, vol: 0.08 }),
  dash: () => noise({ dur: 0.16, vol: 0.14, freq: 3200 }),
  boost: () => tone({ type: 'sawtooth', f0: 200, f1: 760, dur: 0.35, vol: 0.06 }),
  shield: () => tone({ type: 'sine', f0: 400, f1: 1300, dur: 0.3, vol: 0.12 }),
  special: () => {
    tone({ type: 'sawtooth', f0: 140, f1: 900, dur: 0.4, vol: 0.1 });
    noise({ dur: 0.4, vol: 0.12, freq: 2500 });
  },
  crash: () => noise({ dur: 0.25, vol: 0.3, freq: 650 }),
  horn: () => tone({ type: 'square', f0: 415, dur: 0.25, vol: 0.06 }),
  deliver: () => [523, 659, 784].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.15, vol: 0.12, delay: i * 0.08 })),
  count: () => tone({ type: 'square', f0: 520, dur: 0.15, vol: 0.07 }),
  go: () => tone({ type: 'square', f0: 1040, dur: 0.45, vol: 0.07 }),
  ko: () => {
    noise({ dur: 0.7, vol: 0.4, freq: 700 });
    tone({ type: 'sawtooth', f0: 300, f1: 40, dur: 0.8, vol: 0.12 });
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.22, vol: 0.12, delay: i * 0.12 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.3, vol: 0.12, delay: i * 0.18 })),
};

export const sfx = {
  play(name) {
    if (muted) return;
    const now = performance.now();
    if (now - (last[name] ?? 0) < 45) return; // avoid stacking the same sound
    last[name] = now;
    SOUNDS[name]?.();
  },
  unlock() {
    audio();
  },
  get muted() {
    return muted;
  },
  setMuted(v) {
    muted = v;
    try {
      localStorage.setItem('pv-muted', v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  },
};
