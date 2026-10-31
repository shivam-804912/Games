import { mulberry32, shade } from '../utils/random.js';
import { HUD_FONT, LightMap, drawGlow, glassPanel, glowSprite, shade as mix, rgba } from './engine/fx.js';
import {
  H,
  IDLE,
  Particles,
  TAU,
  W,
  angleDiff,
  clamp,
  dist,
  formatTime,
  makeCanvas,
  ordinal,
  rand,
  splitViews,
  text,
} from './engine/util.js';

/*
 * Racing Rivals — top-down split-screen racing under the floodlights. Point
 * the stick where you want to go, hold A for nitro, B to brake (or flick it
 * mid-corner to drift). Grip is finite: carry too much speed and the car
 * slides, run wide and the grass and gravel bite, tuck in behind a rival to
 * catch the slipstream. Three laps, F1-style light start.
 */

const WORLD_W = 3600;
const WORLD_H = 2600;
const TRACK_W = 220;
const HALF = TRACK_W / 2;
const CURB_W = 18;
const RUNOFF = 250; // centreline → tyre wall
const PT_GAP = 28; // spacing of the resampled centreline
const TILE = 512; // world texture tile size
const LAPS = 3;
const MAX = 620;
const BOOST_MAX = 860;
const ACCEL = 600;
const REV_MAX = 210;
const GRIP = 2400; // lateral grip on dry asphalt, px/s²
const TURN = 2.9; // peak yaw rate, rad/s
const CIRC_R = 15; // each car is two circles (nose + tail) for collisions
const CIRC_OFF = 15;
const SPIN_I = 520; // yaw inertia used by collision impulses
const LINE_LIM = HALF - 24; // how far CPUs will place their car from the centreline
const CPU_LAT = 1300; // cornering grip the CPUs plan their speeds around
const CPU_BRAKE = 800;
const LIGHT_PRE = 0.8;
const LIGHT_GAP = 0.8;

// Look
const AMBIENT = '#6a7aa8'; // dusk ambient the light map starts from
const SODIUM = '#ffc47a'; // warm floodlight colour
const LIGHT_RES = 1 / 8; // scale of the baked world light texture
const SHADOW_X = 0.45; // baked shadows fall this far per unit of height
const SHADOW_Y = 0.6;
const TREE_LAYERS = [
  [0.45, 1],
  [0.75, 0.78],
  [1, 0.5],
]; // canopy layers as [height, radius] fractions
const HOT = new Set(['#ffd166', '#38d9ff', '#ffb347']); // emissive particle colours
const BOARD_COLORS = ['#1fd1a5', '#4f8bff', '#ff3b5c', '#ffd166', '#f4f4f4'];
const DIM = 'rgba(196,204,235,0.62)';
const GOLD = '#ffd166';
const PURPLE = '#b26bff';

// Grade for the host's WebGL post pass: cool blue dusk shadows, warm sodium
// highlights, enough bloom for lamps, brake lights and nitro to flare.
const POST = {
  bloom: 0.8,
  threshold: 0.72,
  knee: 0.28,
  exposure: 1.14,
  contrast: 1.08,
  saturation: 1.1,
  shoulder: 0.76,
  vignette: 0.3,
  aberration: 0.0014,
  grain: 0.035,
  shadows: [-0.01, 0.02, 0.065],
  highlights: [0.07, 0.035, -0.03],
};

const SURFACES = {
  asphalt: { grip: 1, max: 1, roll: 0 },
  curb: { grip: 0.86, max: 0.97, roll: 40 },
  grass: { grip: 0.42, max: 0.55, roll: 160 },
  sand: { grip: 0.32, max: 0.4, roll: 320 },
};

const CONTROL = [
  [700, 2150],
  [2000, 2200],
  [3000, 2050],
  [3300, 1500],
  [3050, 950],
  [2500, 800],
  [2100, 1150],
  [1650, 1350],
  [1250, 1100],
  [1300, 600],
  [900, 350],
  [450, 650],
  [400, 1400],
  [450, 1900],
];

/* ---------------------------------------------------------------- Track */

function buildTrack() {
  const n = CONTROL.length;
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = CONTROL[(i - 1 + n) % n];
    const p1 = CONTROL[i];
    const p2 = CONTROL[(i + 1) % n];
    const p3 = CONTROL[(i + 2) % n];
    for (let k = 0; k < 40; k++) {
      const t = k / 40;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      dense.push({ x: c(p0[0], p1[0], p2[0], p3[0]), y: c(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  // Resample to evenly spaced points so "progress" is uniform.
  const pts = [dense[0]];
  let carry = 0;
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    let seg = dist(a.x, a.y, b.x, b.y);
    let ax = a.x;
    let ay = a.y;
    while (carry + seg >= PT_GAP) {
      const t = (PT_GAP - carry) / seg;
      ax += (b.x - ax) * t;
      ay += (b.y - ay) * t;
      pts.push({ x: ax, y: ay });
      seg = dist(ax, ay, b.x, b.y);
      carry = 0;
    }
    carry += seg;
  }
  if (dist(pts[0].x, pts[0].y, pts.at(-1).x, pts.at(-1).y) < PT_GAP * 0.5) pts.pop();
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N];
    const b = pts[(i + 1) % N];
    pts[i].angle = Math.atan2(b.y - a.y, b.x - a.x);
  }
  return pts;
}

// Corners, curbs, gravel traps, tyre walls, the racing line and the speed a
// CPU can carry through every point of it.
function analyseTrack(pts) {
  const N = pts.length;
  const w = (i) => ((i % N) + N) % N;
  const nx = pts.map((p) => -Math.sin(p.angle));
  const ny = pts.map((p) => Math.cos(p.angle));
  // Positive turn = bending toward +normal, so the inside of the corner is the +lat side.
  const turn = pts.map((_, i) => angleDiff(pts[w(i - 4)].angle, pts[w(i + 4)].angle));
  const curb = turn.map((_, i) => {
    for (let k = -3; k <= 3; k++) if (Math.abs(turn[w(i + k)]) > 0.3) return true;
    return false;
  });
  // Gravel waits on the outside of the proper corners (0 = none, ±1 = which side).
  const sandSide = turn.map((_, i) => {
    let best = 0;
    for (let k = -6; k <= 6; k++) {
      const t = turn[w(i + k)];
      if (Math.abs(t) > Math.abs(best)) best = t;
    }
    return Math.abs(best) > 0.45 ? -Math.sign(best) : 0;
  });
  // Tyre walls sit RUNOFF out, unless another part of the track is close.
  const wallD = pts.map((p, i) => {
    let d = RUNOFF;
    for (let j = 0; j < N; j++) {
      let k = Math.abs(i - j);
      k = Math.min(k, N - k);
      const dd = dist(p.x, p.y, pts[j].x, pts[j].y);
      if (k * PT_GAP > dd * 2.2) d = Math.min(d, dd / 2 - 12);
    }
    return Math.max(HALF + 60, d);
  });

  // Racing line: relax the path toward its neighbours (shortest, smoothest
  // route) while keeping it on the asphalt — it ends up clipping the apexes.
  const line = new Float64Array(N);
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < N; i++) {
      const a = w(i - 4);
      const b = w(i + 4);
      const mx = (pts[a].x + nx[a] * line[a] + pts[b].x + nx[b] * line[b]) / 2;
      const my = (pts[a].y + ny[a] * line[a] + pts[b].y + ny[b] * line[b]) / 2;
      line[i] = clamp((mx - pts[i].x) * nx[i] + (my - pts[i].y) * ny[i], -LINE_LIM, LINE_LIM);
    }
  }
  const LX = pts.map((p, i) => p.x + nx[i] * line[i]);
  const LY = pts.map((p, i) => p.y + ny[i] * line[i]);
  const vTarget = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = w(i - 4);
    const b = w(i + 4);
    const h1 = Math.atan2(LY[i] - LY[a], LX[i] - LX[a]);
    const h2 = Math.atan2(LY[b] - LY[i], LX[b] - LX[i]);
    const len = dist(LX[a], LY[a], LX[i], LY[i]) + dist(LX[i], LY[i], LX[b], LY[b]);
    const k = Math.max(1e-5, Math.abs(angleDiff(h1, h2)) / (len / 2));
    vTarget[i] = Math.min(BOOST_MAX * 1.5, Math.sqrt(CPU_LAT / k), (TURN * 0.8) / k);
  }
  // Brake in time: nothing may be faster than it can slow down for what's next.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = w(i + 1);
      const ds = dist(LX[i], LY[i], LX[j], LY[j]);
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(vTarget[j] ** 2 + 2 * CPU_BRAKE * ds));
    }
  }
  return { turn, curb, sandSide, wallD, line, vTarget };
}

// Runs of consecutive (wrapping) indices where flag(i) is truthy.
function runs(N, flag) {
  let start = -1;
  for (let i = 0; i < N; i++) if (!flag(i)) start = i;
  if (start === -1) return [Array.from({ length: N }, (_, i) => i)];
  const out = [];
  let cur = null;
  for (let k = 1; k <= N; k++) {
    const i = (start + k) % N;
    if (flag(i)) (cur ??= []).push(i);
    else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* -------------------------------------------------------------- Texture */

function noiseTile(size, base, specks, rnd, { light = 0.06, dark = 0.12, max = 2 } = {}) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let k = 0; k < specks; k++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${light * rnd()})` : `rgba(0,0,0,${dark * rnd()})`;
    const s = 1 + rnd() * max;
    g.fillRect(rnd() * size, rnd() * size, s, s);
  }
  return c;
}

// Grass: optional two-tone mowing stripes plus short blades of noise.
function grassTile(a, b, rnd, stripes = true) {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = a;
  g.fillRect(0, 0, S, S);
  if (stripes) {
    g.fillStyle = b;
    g.fillRect(S / 2, 0, S / 2, S);
  }
  for (let k = 0; k < 7000; k++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(170,230,150,${0.07 * rnd()})` : `rgba(0,10,0,${0.18 * rnd()})`;
    g.fillRect(rnd() * S, rnd() * S, 1, 2 + rnd() * 3);
  }
  return c;
}

// Asphalt: soft tonal mottling, fine aggregate and the odd bright chip.
function asphaltTile(rnd) {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#45474e';
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 40; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 10 + rnd() * 40;
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.025 * rnd()})` : `rgba(0,0,0,${0.06 * rnd()})`;
    // Drawn at every wrap offset so the tile repeats seamlessly
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, TAU);
        g.fill();
      }
    }
  }
  for (let k = 0; k < 9000; k++) {
    g.fillStyle = rnd() < 0.45 ? `rgba(255,255,255,${0.04 + 0.1 * rnd()})` : `rgba(0,0,0,${0.08 + 0.18 * rnd()})`;
    const s = rnd() < 0.85 ? 1 : 2;
    g.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), s, s);
  }
  for (let k = 0; k < 160; k++) {
    g.fillStyle = `rgba(230,235,255,${0.25 + 0.3 * rnd()})`;
    g.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), 1, 1);
  }
  return c;
}

// Gravel: rounded stones with a lit top and a shadowed underside.
function gravelTile(rnd) {
  const S = 96;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#8a7451';
  g.fillRect(0, 0, S, S);
  const tones = ['#b39d74', '#a08a62', '#c7b48c', '#8f7a57', '#9c9488', '#7d6a4b'];
  for (let k = 0; k < 1500; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 0.8 + rnd() * 1.5;
    const tone = tones[Math.floor(rnd() * tones.length)];
    for (const ox of x < 3 ? [0, S] : x > S - 3 ? [0, -S] : [0]) {
      for (const oy of y < 3 ? [0, S] : y > S - 3 ? [0, -S] : [0]) {
        const px = x + ox;
        const py = y + oy;
        g.fillStyle = 'rgba(30,22,12,0.45)';
        g.beginPath();
        g.arc(px + 0.5, py + 0.7, r, 0, TAU);
        g.fill();
        g.fillStyle = tone;
        g.beginPath();
        g.arc(px, py, r, 0, TAU);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.28)';
        g.beginPath();
        g.arc(px - r * 0.3, py - r * 0.35, r * 0.4, 0, TAU);
        g.fill();
      }
    }
  }
  return c;
}

const softCache = new Map();

// Soft round blob (shadows, smoke puffs, tonal variation), cached per colour.
function softSprite(color) {
  let c = softCache.get(color);
  if (c) return c;
  c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, rgba(color, 1));
  grd.addColorStop(0.45, rgba(color, 0.55));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  softCache.set(color, c);
  return c;
}

// One tyre of a tyre wall, seen from above: rounded rubber, painted belt, hollow centre.
function tyreSprite(belt) {
  const c = makeCanvas(40, 40);
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.translate(10, 10);
  let grd = g.createRadialGradient(-2.5, -2.5, 1, 0, 0, 8);
  grd.addColorStop(0, '#3a3b42');
  grd.addColorStop(0.7, '#141519');
  grd.addColorStop(1, '#060608');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, 7.6, 0, TAU);
  g.fill();
  grd = g.createLinearGradient(-5, -5, 5, 5);
  grd.addColorStop(0, mix(belt, 0.35));
  grd.addColorStop(1, shade(belt, -0.35));
  g.strokeStyle = grd;
  g.lineWidth = 2.4;
  g.beginPath();
  g.arc(0, 0, 4.6, 0, TAU);
  g.stroke();
  g.fillStyle = '#050506';
  g.beginPath();
  g.arc(0, 0, 2.6, 0, TAU);
  g.fill();
  return c;
}

// Canopy palettes, [low, mid, top] layer each as [base, highlight, shadow].
// The last one is a conifer.
const CANOPY = [
  [['#1c3d25', '#2f6038', '#0a1a0f'], ['#27552f', '#4c8a4b', '#112a18'], ['#3a7240', '#79b866', '#1a3a22']],
  [['#2b3c1e', '#465f2b', '#121a0b'], ['#3e5628', '#6c8a3c', '#1b2810'], ['#5a7636', '#9cba5a', '#2a3a18']],
  [['#163832', '#25574c', '#081a17'], ['#204d43', '#3f8070', '#0e2622'], ['#2f6b5a', '#62a88c', '#163a30']],
  [['#132e1d', '#22492e', '#07150c'], ['#1b3f27', '#33653f', '#0b1f12'], ['#285634', '#4f8a55', '#13301b']],
];

// One canopy layer: a lumpy (or spiky, for conifers) silhouette lit from the
// upper left, dabbed with leaf clumps.
function canopySprite(rnd, [base, hi, lo], conifer) {
  const S = 96;
  const R = S / 2;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.translate(R, R);
  g.fillStyle = base;
  g.beginPath();
  if (conifer) {
    const n = 12 + Math.floor(rnd() * 4);
    for (let k = 0; k < n * 2; k++) {
      const a = (k / (n * 2)) * TAU;
      const r = (k % 2 ? 0.62 : 0.95) * R * (0.92 + rnd() * 0.08);
      if (k) g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  } else {
    g.arc(0, 0, R * 0.6, 0, TAU);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * TAU + rnd() * 0.5;
      const rr = R * (0.26 + rnd() * 0.12);
      const d = Math.min(R * 0.97 - rr, R * (0.42 + rnd() * 0.12));
      g.moveTo(Math.cos(a) * d + rr, Math.sin(a) * d);
      g.arc(Math.cos(a) * d, Math.sin(a) * d, rr, 0, TAU);
    }
  }
  g.fill();
  g.globalCompositeOperation = 'source-atop';
  let grd = g.createRadialGradient(-R * 0.35, -R * 0.4, 0, -R * 0.35, -R * 0.4, R * 1.1);
  grd.addColorStop(0, rgba(hi, 0.85));
  grd.addColorStop(1, rgba(hi, 0));
  g.fillStyle = grd;
  g.fillRect(-R, -R, S, S);
  grd = g.createRadialGradient(R * 0.35, R * 0.4, 0, R * 0.35, R * 0.4, R * 1.1);
  grd.addColorStop(0, rgba(lo, 0.9));
  grd.addColorStop(1, rgba(lo, 0));
  g.fillStyle = grd;
  g.fillRect(-R, -R, S, S);
  for (let k = 0; k < 260; k++) {
    const a = rnd() * TAU;
    const d = Math.sqrt(rnd()) * R;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    g.fillStyle = rnd() < (x + y < 0 ? 0.55 : 0.25) ? rgba(hi, 0.45) : rgba(lo, 0.45);
    g.beginPath();
    g.arc(x, y, 1.2 + rnd() * 2.6, 0, TAU);
    g.fill();
  }
  return c;
}

// Grandstand seating seen from above: concrete tiers packed with spectators.
// Row 0 is the front (trackside, lowest) tier.
function crowdSprite(len, rnd) {
  const D = 96;
  const c = makeCanvas(len, D);
  const g = c.getContext('2d');
  g.fillStyle = '#2a2e39';
  g.fillRect(0, 0, len, D);
  // Front wall with an LED advertising strip
  g.fillStyle = '#0e1016';
  g.fillRect(0, 0, len, 5);
  g.fillStyle = '#1fd1a5';
  g.fillRect(0, 2, len, 1.5);
  const rows = 10;
  const rh = (D - 10) / rows;
  const shirts = ['#ff3b5c', '#4f8bff', '#ffd166', '#f4f4f4', '#22d36b', '#ff8a2b', '#b26bff', '#1b1d24', '#e8e8e8', '#d6283a'];
  const skin = ['#e8c4a0', '#c99b72', '#8d5a3b', '#f1d3b8', '#5a3a26'];
  for (let r = 0; r < rows; r++) {
    const y = 5 + r * rh;
    g.fillStyle = '#3c4250';
    g.fillRect(0, y, len, rh - 2);
    g.fillStyle = '#191c24';
    g.fillRect(0, y + rh - 2, len, 2);
    for (let x = 3; x < len - 4; x += 5) {
      if (x % 70 < 8 || rnd() < 0.16) continue; // aisles and empty seats
      const jx = x + (rnd() - 0.5);
      g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
      g.fillRect(jx, y + 2.5, 4, rh - 4.5);
      g.fillStyle = skin[Math.floor(rnd() * skin.length)];
      g.beginPath();
      g.arc(jx + 2, y + 2.4, 1.6, 0, TAU);
      g.fill();
    }
  }
  // Aisle stairs
  for (let x = 0; x < len; x += 70) {
    g.fillStyle = '#4b5162';
    g.fillRect(x + 1, 5, 6, D - 10);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 5; y < D - 5; y += rh / 2) g.fillRect(x + 1, y, 6, 1);
  }
  g.fillStyle = '#14161d';
  g.fillRect(0, D - 5, len, 5);
  return c;
}

// Top-down prototype racer, painted once at 2x for crisp edges. Nose = +x.
function paintCar(color, num) {
  const c = makeCanvas(152, 80);
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.translate(38, 20);
  const carbon = '#15161c';
  const lite = mix(color, 0.45);

  // Rear tyres (the fronts are drawn live so they can steer)
  g.fillStyle = '#0c0c0f';
  g.beginPath();
  g.roundRect(-27, -17.5, 14, 7, 2);
  g.roundRect(-27, 10.5, 14, 7, 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fillRect(-26, -16.5, 12, 1.2);
  g.fillRect(-26, 11.5, 12, 1.2);

  // Carbon floor: splitter up front, diffuser at the back
  g.fillStyle = carbon;
  g.beginPath();
  g.roundRect(-32, -13.5, 66, 27, 6);
  g.fill();

  // Body shell: twin fenders, a pinched waist, shaded across its width so it reads as curved
  const body = new Path2D();
  body.moveTo(33, -4);
  body.quadraticCurveTo(33, -9.5, 28, -11.5);
  body.bezierCurveTo(24, -15, 12, -15.5, 7, -13);
  body.quadraticCurveTo(1, -10.5, -6, -12);
  body.bezierCurveTo(-11, -15.5, -24, -15.5, -28.5, -13);
  body.quadraticCurveTo(-31.5, -11.5, -31.5, -7);
  body.lineTo(-31.5, 7);
  body.quadraticCurveTo(-31.5, 11.5, -28.5, 13);
  body.bezierCurveTo(-24, 15.5, -11, 15.5, -6, 12);
  body.quadraticCurveTo(1, 10.5, 7, 13);
  body.bezierCurveTo(12, 15.5, 24, 15, 28, 11.5);
  body.quadraticCurveTo(33, 9.5, 33, 4);
  body.closePath();
  const paint = g.createLinearGradient(0, -15, 0, 15);
  paint.addColorStop(0, shade(color, -0.6));
  paint.addColorStop(0.2, shade(color, -0.2));
  paint.addColorStop(0.42, color);
  paint.addColorStop(0.5, lite);
  paint.addColorStop(0.58, color);
  paint.addColorStop(0.8, shade(color, -0.25));
  paint.addColorStop(1, shade(color, -0.6));
  g.fillStyle = paint;
  g.fill(body);

  g.save();
  g.clip(body);
  // Livery: dark tail split on a diagonal and edged with a bright pin-stripe
  g.fillStyle = 'rgba(10,11,16,0.92)';
  g.beginPath();
  g.moveTo(-40, -20);
  g.lineTo(-10, -20);
  g.lineTo(-22, 20);
  g.lineTo(-40, 20);
  g.closePath();
  g.fill();
  g.strokeStyle = lite;
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(-9, -20);
  g.lineTo(-21, 20);
  g.stroke();
  // Twin stripes down the spine: white over the colour, colour over the dark tail
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(-15, -4.2, 49, 2.2);
  g.fillRect(-15, 2, 49, 2.2);
  g.fillStyle = color;
  g.fillRect(-34, -4.2, 19, 2.2);
  g.fillRect(-34, 2, 19, 2.2);
  // Re-shade over the livery so it wraps around the body
  const wrap = g.createLinearGradient(0, -15, 0, 15);
  wrap.addColorStop(0, 'rgba(0,0,0,0.5)');
  wrap.addColorStop(0.3, 'rgba(0,0,0,0)');
  wrap.addColorStop(0.7, 'rgba(0,0,0,0)');
  wrap.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = wrap;
  g.fillRect(-40, -20, 80, 40);
  // Clear-coat specular: a soft sheen along the left flank
  g.save();
  g.translate(4, -8.5);
  g.scale(1, 0.22);
  const spec = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  spec.addColorStop(0, 'rgba(255,255,255,0.5)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = spec;
  g.fillRect(-30, -30, 60, 60);
  g.restore();
  g.restore();

  // Hot highlight lines on the fender crowns, then a crisp outline
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 0.7;
  g.beginPath();
  g.moveTo(26, -11.3);
  g.bezierCurveTo(20, -14.2, 12, -14.4, 8, -12.4);
  g.moveTo(-8, -12.2);
  g.bezierCurveTo(-13, -14.6, -22, -14.6, -27, -12.6);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 0.9;
  g.stroke(body);

  // Canopy: tinted glass with a sky reflection and a glint
  const glass = new Path2D();
  glass.moveTo(15, 0);
  glass.bezierCurveTo(14, -6, 6, -8.5, -4, -8);
  glass.quadraticCurveTo(-10, -7.5, -10.5, -4);
  glass.lineTo(-10.5, 4);
  glass.quadraticCurveTo(-10, 7.5, -4, 8);
  glass.bezierCurveTo(6, 8.5, 14, 6, 15, 0);
  glass.closePath();
  const tint = g.createLinearGradient(15, 0, -10, 0);
  tint.addColorStop(0, '#30476e');
  tint.addColorStop(0.45, '#121b2e');
  tint.addColorStop(1, '#05070d');
  g.fillStyle = tint;
  g.fill(glass);
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.lineWidth = 1;
  g.stroke(glass);
  g.strokeStyle = 'rgba(200,225,255,0.6)';
  g.lineWidth = 1.1;
  g.beginPath();
  g.moveTo(12.5, -2.5);
  g.quadraticCurveTo(8, -6.5, 0, -6.6);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.arc(11, -3.6, 0.9, 0, TAU);
  g.fill();

  // Engine-cover fin and the race number
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(-30, -0.6, 19, 1.2);
  g.fillStyle = '#f4f5f8';
  g.beginPath();
  g.arc(-20, 0, 5, 0, TAU);
  g.fill();
  g.fillStyle = '#0b0c10';
  g.font = '700 7.5px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), -20, 0.4);

  // Rear wing: carbon plane, coloured end plates
  g.fillStyle = carbon;
  g.beginPath();
  g.roundRect(-37, -15.5, 5.5, 31, 1.5);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(-32.6, -15, 0.9, 30);
  g.fillStyle = color;
  g.fillRect(-37.5, -16.2, 7, 2.4);
  g.fillRect(-37.5, 13.8, 7, 2.4);
  // Mirrors
  g.fillStyle = carbon;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(5, side * 14.3, 2.2, 1.3, 0, 0, TAU);
    g.fill();
  }
  // LED headlights and the full-width tail light bar (they glow live in drawCarLights)
  g.fillStyle = '#eef6ff';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(28.5, side * 10.6);
    g.lineTo(31.2, side * 8.2);
    g.lineTo(30.6, side * 6.8);
    g.lineTo(27.6, side * 9.2);
    g.closePath();
    g.fill();
  }
  g.fillStyle = '#ff2a3a';
  g.fillRect(-31.6, -9, 1.3, 18);
  return c;
}

// Soft contact shadow under a car (blurred once here, never per frame).
function paintCarShadow() {
  const c = makeCanvas(108, 72);
  const g = c.getContext('2d');
  g.translate(54, 36);
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 9;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.beginPath();
  g.roundRect(-33, -15.5, 67, 31, 11);
  g.fill();
  return c;
}

// Soften a wedge sprite's long edges (fade toward its top and bottom).
function featherY(g, w, h) {
  g.globalCompositeOperation = 'destination-in';
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.3, 'rgba(0,0,0,1)');
  grd.addColorStop(0.7, 'rgba(0,0,0,1)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
}

function paintLightSprites() {
  // Headlight wedge for the light map (lights the ground in front of a car).
  const cone = makeCanvas(256, 144);
  let g = cone.getContext('2d');
  let grd = g.createRadialGradient(0, 72, 0, 0, 72, 256);
  grd.addColorStop(0, 'rgba(255,246,228,1)');
  grd.addColorStop(0.35, 'rgba(255,240,215,0.6)');
  grd.addColorStop(1, 'rgba(255,236,205,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, 62);
  g.lineTo(256, 0);
  g.lineTo(256, 144);
  g.lineTo(0, 82);
  g.closePath();
  g.fill();
  featherY(g, 256, 144);

  // Faint additive beam haze, drawn in front of every car.
  const head = makeCanvas(300, 150);
  g = head.getContext('2d');
  grd = g.createRadialGradient(0, 75, 4, 0, 75, 300);
  grd.addColorStop(0, 'rgba(255,240,215,0.3)');
  grd.addColorStop(1, 'rgba(255,240,215,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, 62);
  g.lineTo(300, 0);
  g.lineTo(300, 150);
  g.lineTo(0, 88);
  g.closePath();
  g.fill();
  featherY(g, 300, 150);

  // Nitro flame, anchored at its right edge (the exhaust): blue sheath, white-hot core.
  const flame = makeCanvas(96, 32);
  g = flame.getContext('2d');
  grd = g.createLinearGradient(96, 0, 0, 0);
  grd.addColorStop(0, 'rgba(190,240,255,0.95)');
  grd.addColorStop(0.3, 'rgba(70,170,255,0.75)');
  grd.addColorStop(0.7, 'rgba(60,80,255,0.3)');
  grd.addColorStop(1, 'rgba(120,60,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(96, 6);
  g.quadraticCurveTo(40, 8, 0, 16);
  g.quadraticCurveTo(40, 24, 96, 26);
  g.closePath();
  g.fill();
  grd = g.createLinearGradient(96, 0, 40, 0);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(96, 11);
  g.quadraticCurveTo(60, 13, 40, 16);
  g.quadraticCurveTo(60, 19, 96, 21);
  g.closePath();
  g.fill();

  // Floodlight shaft through the evening haze, brightest at the lamp.
  const beam = makeCanvas(256, 128);
  g = beam.getContext('2d');
  grd = g.createLinearGradient(0, 0, 256, 0);
  grd.addColorStop(0, 'rgba(255,226,180,0.9)');
  grd.addColorStop(1, 'rgba(255,226,180,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, 56);
  g.lineTo(256, 0);
  g.lineTo(256, 128);
  g.lineTo(0, 72);
  g.closePath();
  g.fill();
  featherY(g, 256, 128);

  // One lit boost-pad chevron.
  const chev = makeCanvas(28, 56);
  g = chev.getContext('2d');
  g.translate(1, 28);
  g.fillStyle = '#a8f2ff';
  g.beginPath();
  g.moveTo(0, -26);
  g.lineTo(18, 0);
  g.lineTo(0, 26);
  g.lineTo(8, 26);
  g.lineTo(26, 0);
  g.lineTo(8, -26);
  g.closePath();
  g.fill();

  // Elongated red glow behind the tail light bar.
  const tail = makeCanvas(32, 64);
  g = tail.getContext('2d');
  g.translate(16, 32);
  g.scale(0.5, 1);
  grd = g.createRadialGradient(0, 0, 0, 0, 0, 32);
  grd.addColorStop(0, 'rgba(255,70,80,0.95)');
  grd.addColorStop(0.35, 'rgba(255,24,44,0.4)');
  grd.addColorStop(1, 'rgba(255,0,20,0)');
  g.fillStyle = grd;
  g.fillRect(-32, -32, 64, 64);

  // Floodlight head: the frame with its lamp housings, and (separately) the lit lenses.
  const lampFrame = makeCanvas(32, 152);
  g = lampFrame.getContext('2d');
  g.scale(2, 2);
  g.translate(8, 38);
  g.fillStyle = '#1f222a';
  g.fillRect(-8, -37, 14, 74);
  g.fillStyle = '#3a3f4b';
  for (let r = 0; r < 6; r++) for (const lx of [-6, 0]) g.fillRect(lx, -34 + r * 11.5, 5, 9);
  const lampFaces = makeCanvas(32, 152);
  g = lampFaces.getContext('2d');
  g.scale(2, 2);
  g.translate(8, 38);
  g.fillStyle = '#fff2d2';
  for (let r = 0; r < 6; r++) for (const lx of [-6, 0]) g.fillRect(lx + 0.5, -33.5 + r * 11.5, 4, 8);
  return { cone, head, flame, beam, chev, tail, lampFrame, lampFaces };
}

/* ---------------------------------------------------------------- Smoke */

// Soft, normally-blended puffs (tyre smoke, dust, gravel spray).
class Smoke {
  constructor() {
    this.list = [];
  }

  add(x, y, vx, vy, { r = 8, grow = 40, life = 1, color = '#c8c8cc', alpha = 0.3 } = {}) {
    const p = { x, y, vx, vy, r, grow, life, max: life, color, alpha };
    if (this.list.length >= 360) this.list[Math.floor(Math.random() * 360)] = p;
    else this.list.push(p);
  }

  update(dt) {
    const list = this.list;
    const k = Math.max(0, 1 - dt * 2);
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      p.vx *= k;
      p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.grow * dt;
    }
  }

  render(ctx, x0, y0, x1, y1) {
    ctx.save();
    for (const p of this.list) {
      if (p.x < x0 - p.r || p.x > x1 + p.r || p.y < y0 - p.r || p.y > y1 + p.r) continue;
      const r = p.r * 1.35; // the sprite is soft-edged, so draw it a touch larger
      ctx.globalAlpha = p.alpha * (p.life / p.max);
      ctx.drawImage(softSprite(p.color), p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ HUD */

function measure(ctx, str, size, weight = 700, spacing = 0) {
  ctx.save();
  ctx.font = `${weight} ${size}px "${HUD_FONT}", system-ui, sans-serif`;
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

// Glass chip with an accent edge; returns its width so several can be stacked in a row.
function chip(ctx, label, x, y, color) {
  const w = measure(ctx, label, 14, 700, 2) + 26;
  glassPanel(ctx, x, y - 15, w, 30, { r: 6, accent: color });
  text(ctx, label, x + 14, y + 1, { size: 14, align: 'left', color, spacing: 2 });
  return w;
}

// Broadcast-style caption band behind big centre messages.
function band(ctx, cx, cy, w, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
  g.addColorStop(0, 'rgba(6,8,16,0)');
  g.addColorStop(0.25, 'rgba(6,8,16,0.66)');
  g.addColorStop(0.75, 'rgba(6,8,16,0.66)');
  g.addColorStop(1, 'rgba(6,8,16,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - w / 2, cy - 46, w, 92);
  const l = ctx.createLinearGradient(cx - w * 0.3, 0, cx + w * 0.3, 0);
  l.addColorStop(0, rgba(color, 0));
  l.addColorStop(0.5, rgba(color, 0.8));
  l.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = l;
  ctx.fillRect(cx - w * 0.3, cy - 46, w * 0.6, 1.5);
  ctx.fillRect(cx - w * 0.3, cy + 44.5, w * 0.6, 1.5);
  ctx.restore();
}

function quad(ctx, a, b, c, d) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]);
  ctx.lineTo(d[0], d[1]);
  ctx.closePath();
}

// A tapered pole from a ground point to its (parallax-shifted) top.
function pole(ctx, x, y, tx, ty, w0, w1) {
  const dx = tx - x;
  const dy = ty - y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  ctx.beginPath();
  ctx.moveTo(x + nx * w0, y + ny * w0);
  ctx.lineTo(tx + nx * w1, ty + ny * w1);
  ctx.lineTo(tx - nx * w1, ty - ny * w1);
  ctx.lineTo(x - nx * w0, y - ny * w0);
  ctx.closePath();
  ctx.fill();
  return [nx, ny];
}

/* ----------------------------------------------------------------- Game */

class RacingRivals {
  constructor({ players, host }) {
    this.host = host;
    this.pts = buildTrack();
    this.N = this.pts.length;
    Object.assign(this, analyseTrack(this.pts));
    this.pads = [0.14, 0.4, 0.68, 0.86].map((f) => {
      const p = this.pts[Math.floor(this.N * f)];
      return { x: p.x, y: p.y, angle: p.angle };
    });
    this.slots = Array.from({ length: Math.max(6, players.length) }, (_, i) => this.gridSlot(i));
    this.placeScenery();
    this.tiles = this.sliceTiles(this.paintWorld());
    this.staticLight = this.paintLight();
    this.mini = this.paintMini();
    this.sprites = paintLightSprites();
    this.carShadow = paintCarShadow();
    this.post = { aberration: POST.aberration, flash: 0, flashColor: [1, 0.8, 0.6] };
    this.boostFx = 0;
    this.particles = new Particles();
    this.smoke = new Smoke();
    this.time = 0;
    this.raceTime = 0;
    this.state = 'countdown';
    this.countT = 0;
    this.lights = 0;
    this.goAt = LIGHT_PRE + LIGHT_GAP * 4 + rand(0.6, 1.5); // the hold on five reds is random, like the real thing
    this.finished = 0;
    this.firstFinish = null;
    this.fastest = null;
    this.result = null;

    this.cars = players.map((p, i) => {
      const s = this.slots[i];
      const idx = this.nearestIndex(s.x, s.y);
      return {
        ...p,
        i,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        angle: s.angle,
        yaw: 0,
        spin: 0,
        steer: 0,
        speed: 0,
        top: 0,
        idx,
        progress: idx > this.N / 2 ? idx - this.N : idx,
        pass: new Float32Array(this.N * (LAPS + 4)).fill(-1),
        lat: 0,
        surface: 'asphalt',
        nitro: 0.5,
        nitroOn: false,
        boostT: 0,
        boosting: false,
        braking: false,
        reverse: false,
        revSign: 1,
        drifting: false,
        driftT: 0,
        slip: 0,
        draft: 0,
        tyres: null,
        shake: 0,
        rumbleT: 0,
        place: 0,
        finishTime: null,
        lapStart: 0,
        best: null,
        lastLap: 1,
        splits: [],
        bestSplits: null,
        nextSplit: 1,
        wrongT: 0,
        jump: false,
        holdT: 0,
        launched: false,
        reactT: p.cpu ? rand(0.18, 0.55) : 0,
        note: null,
        split: null,
        // CPU brain
        skill: p.cpu ? rand(0.93, 0.99) : 1,
        pace: 1,
        lane: rand(-18, 18),
        off: 0,
        passOff: 0,
        passT: 0,
        stuckT: 0,
        reverseT: 0,
        sprite: paintCar(p.color, i + 1),
      };
    });
    this.humans = this.cars.filter((c) => !c.cpu);
    this.views = splitViews(this.humans.length);
    this.zoom = this.humans.length === 1 ? 0.85 : this.humans.length === 2 ? 0.7 : 0.55;
    this.lightMaps = this.views.map(() => new LightMap(0.4));
  }

  dispose() {
    // Free the world textures right away.
    for (const t of this.tiles) {
      t.c.width = 0;
      t.c.height = 0;
    }
    this.staticLight.width = 0;
    this.staticLight.height = 0;
  }

  // Cut the painted world into tiles: views draw only what they see, and skid
  // marks dirty only the small tiles they land on (one huge canvas that changes
  // every frame would be re-uploaded whole, every frame).
  sliceTiles(world) {
    const tiles = [];
    this.tileCols = Math.ceil(WORLD_W / TILE);
    this.tileRows = Math.ceil(WORLD_H / TILE);
    for (let r = 0; r < this.tileRows; r++) {
      for (let q = 0; q < this.tileCols; q++) {
        const x = q * TILE;
        const y = r * TILE;
        const w = Math.min(TILE + 1, WORLD_W - x); // 1px overlap hides seams when scaled
        const h = Math.min(TILE + 1, WORLD_H - y);
        const c = makeCanvas(w, h);
        const g = c.getContext('2d');
        g.drawImage(world, x, y, w, h, 0, 0, w, h);
        tiles.push({ c, g, x, y, w, h });
      }
    }
    world.width = 0;
    world.height = 0;
    return tiles;
  }

  tilesIn(x0, y0, x1, y1) {
    const out = [];
    const q0 = clamp(Math.floor(x0 / TILE), 0, this.tileCols - 1);
    const q1 = clamp(Math.floor(x1 / TILE), 0, this.tileCols - 1);
    const r0 = clamp(Math.floor(y0 / TILE), 0, this.tileRows - 1);
    const r1 = clamp(Math.floor(y1 / TILE), 0, this.tileRows - 1);
    for (let r = r0; r <= r1; r++) for (let q = q0; q <= q1; q++) out.push(this.tiles[r * this.tileCols + q]);
    return out;
  }

  // Staggered two-wide grid behind the line, following the track.
  gridSlot(i) {
    const N = this.N;
    const back = 70 + Math.floor(i / 2) * 90 + (i % 2) * 40;
    const p = this.pts[(N - Math.round(back / PT_GAP)) % N];
    const side = i % 2 ? 1 : -1;
    return { x: p.x - Math.sin(p.angle) * side * 48, y: p.y + Math.cos(p.angle) * side * 48, angle: p.angle };
  }

  // Is (x, y) at least m beyond every tyre wall?
  clear(x, y, m) {
    for (let i = 0; i < this.N; i += 2) {
      const p = this.pts[i];
      const r = this.wallD[i] + m;
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < r * r) return false;
    }
    return x > m && y > m && x < WORLD_W - m && y < WORLD_H - m;
  }

  // Where the scenery goes: grandstands, the start gantry, floodlight towers,
  // trackside boards and woods. Tall things are drawn live with parallax, so
  // they're bucketed by world tile for quick culling.
  placeScenery() {
    const { pts, N, wallD } = this;
    const rnd = mulberry32(2087);
    const off = (i, s) => {
      const p = pts[((i % N) + N) % N];
      return [p.x - Math.sin(p.angle) * s, p.y + Math.cos(p.angle) * s];
    };
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x / N;
      my += p.y / N;
    }

    // Grandstands on the outside of the start straight and two big corners
    this.stands = [];
    for (const at of [N - 7, Math.floor(N * 0.27), Math.floor(N * 0.6)]) {
      const p = pts[at];
      const sides = [-1, 1].map((side) => {
        const [x, y] = off(at, side * (wallD[at] + 80));
        return { side, x, y, d: dist(x, y, mx, my) };
      });
      const { side, x, y } = sides[0].d > sides[1].d ? sides[0] : sides[1];
      for (const len of [420, 300, 200]) {
        const fx = Math.cos(p.angle);
        const fy = Math.sin(p.angle);
        const ok = [-1, 1].every((e) => [-1, 1].every((d) => this.clear(x + fx * e * len * 0.5 - fy * d * 48, y + fy * e * len * 0.5 + fx * d * 48, 10)));
        if (!ok) continue;
        this.stands.push({ kind: 'stand', x, y, angle: p.angle, len, side, crowd: crowdSprite(len, rnd) });
        break;
      }
    }
    const inStand = (x, y, m) =>
      this.stands.some((s) => {
        const dx = x - s.x;
        const dy = y - s.y;
        const u = dx * Math.cos(s.angle) + dy * Math.sin(s.angle);
        const v = -dx * Math.sin(s.angle) + dy * Math.cos(s.angle);
        return Math.abs(u) < s.len / 2 + m && Math.abs(v) < 48 + m;
      });

    // Start / finish gantry, its legs planted beyond both tyre walls
    const s0 = pts[0];
    const [ax, ay] = off(0, -(wallD[0] + 22));
    const [bx, by] = off(0, wallD[0] + 22);
    this.gantry = { kind: 'gantry', x: s0.x, y: s0.y, ax, ay, bx, by, angle: s0.angle, h: 120 };
    const nearGantry = (x, y, m) => dist(x, y, ax, ay) < m || dist(x, y, bx, by) < m;

    // Floodlight towers on alternating sides, aimed at the racing surface
    this.towers = [];
    for (let i = 0, n = 0; i < N; i += 24, n++) {
      const side = n % 2 ? 1 : -1;
      const [x, y] = off(i, side * (wallD[i] + 36));
      if (!this.clear(x, y, 12) || inStand(x, y, 30) || nearGantry(x, y, 80)) continue;
      const [px, py] = off(i, side * 30);
      this.towers.push({ kind: 'tower', x, y, h: 250, px, py, face: Math.atan2(py - y, px - x) });
    }

    // Trackside boards just behind the tyre walls
    this.boards = [];
    for (let i = 4; i < N; i += 9) {
      if (rnd() < 0.45) continue;
      const side = rnd() < 0.5 ? -1 : 1;
      const color = BOARD_COLORS[Math.floor(rnd() * BOARD_COLORS.length)];
      const idx = [i - 1, i, i + 1, i + 2].map((j) => (j + N) % N);
      const ok = idx.every((j) => {
        const [x, y] = off(j, side * (wallD[j] + 22));
        return this.clear(x, y, 6) && !inStand(x, y, 10) && !nearGantry(x, y, 30);
      });
      if (ok) this.boards.push({ idx, side, color });
    }

    // Woods: clusters of trees beyond the walls
    this.trees = [];
    for (let k = 0; k < 80; k++) {
      const cx = rnd() * WORLD_W;
      const cy = rnd() * WORLD_H;
      const count = 4 + Math.floor(rnd() * 10);
      for (let t = 0; t < count; t++) {
        const r = 15 + rnd() * 17;
        const x = cx + (rnd() - 0.5) * 240;
        const y = cy + (rnd() - 0.5) * 240;
        const h = r * 2.2 + rnd() * 22;
        const v = Math.floor(rnd() * 12);
        if (!this.clear(x, y, r + 26) || inStand(x, y, r + 10) || nearGantry(x, y, r + 30)) continue;
        if (this.towers.some((tw) => dist(tw.x, tw.y, x, y) < r + 24)) continue;
        this.trees.push({ kind: 'tree', x, y, r, h, v });
      }
    }
    // Twelve canopy shapes: three random silhouettes for each palette
    this.canopies = [];
    for (let v = 0; v < 12; v++) {
      const pal = CANOPY[Math.floor(v / 3)];
      this.canopies.push(pal.map((layer) => canopySprite(rnd, layer, pal === CANOPY[3])));
    }

    this.tileCols = Math.ceil(WORLD_W / TILE);
    this.tileRows = Math.ceil(WORLD_H / TILE);
    this.propGrid = Array.from({ length: this.tileCols * this.tileRows }, () => []);
    for (const p of [...this.trees, ...this.stands, ...this.towers, this.gantry]) {
      const q = clamp(Math.floor(p.x / TILE), 0, this.tileCols - 1);
      const r = clamp(Math.floor(p.y / TILE), 0, this.tileRows - 1);
      this.propGrid[r * this.tileCols + q].push(p);
    }
  }

  propsIn(x0, y0, x1, y1) {
    const out = [];
    const q0 = clamp(Math.floor(x0 / TILE), 0, this.tileCols - 1);
    const q1 = clamp(Math.floor(x1 / TILE), 0, this.tileCols - 1);
    const r0 = clamp(Math.floor(y0 / TILE), 0, this.tileRows - 1);
    const r1 = clamp(Math.floor(y1 / TILE), 0, this.tileRows - 1);
    for (let r = r0; r <= r1; r++) for (let q = q0; q <= q1; q++) for (const p of this.propGrid[r * this.tileCols + q]) out.push(p);
    return out;
  }

  paintWorld() {
    const { pts, N, wallD } = this;
    const rnd = mulberry32(1987);
    const c = makeCanvas(WORLD_W, WORLD_H);
    const g = c.getContext('2d');
    const off = (i, s) => {
      const p = pts[i];
      return [p.x - Math.sin(p.angle) * s, p.y + Math.cos(p.angle) * s];
    };
    const path = (s = (i) => 0, list = null) => {
      g.beginPath();
      const idxs = list ?? pts.map((_, i) => i);
      idxs.forEach((i, k) => {
        const [x, y] = off(i, s(i));
        if (k) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      if (!list) g.closePath();
    };
    const dark = softSprite('#000000');
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Outfield: rough grass with broad, soft tonal variation
    g.fillStyle = g.createPattern(grassTile('#22402a', '#22402a', rnd, false), 'repeat');
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    const meadow = softSprite('#5d7a3c');
    for (let k = 0; k < 150; k++) {
      const r = 120 + rnd() * 320;
      g.globalAlpha = 0.06 + rnd() * 0.12;
      g.drawImage(rnd() < 0.55 ? dark : meadow, rnd() * WORLD_W - r, rnd() * WORLD_H - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;

    // Run-off: freshly mown, striped grass inside the walls
    g.fillStyle = g.createPattern(grassTile('#2c5433', '#30593a', rnd), 'repeat');
    g.beginPath();
    for (let i = 0; i < N; i++) {
      g.moveTo(pts[i].x + wallD[i], pts[i].y);
      g.arc(pts[i].x, pts[i].y, wallD[i], 0, TAU);
    }
    g.fill();

    // Gravel traps on the outside of the big corners: a darker raised lip, then stones
    const traps = [];
    for (let i = 0; i < N; i++) {
      const side = this.sandSide[i];
      if (!side) continue;
      const r = (wallD[i] - HALF - CURB_W) / 2 - 4;
      const [x, y] = off(i, side * (HALF + CURB_W + 4 + r));
      traps.push([x, y, r]);
    }
    g.fillStyle = '#4a3c27';
    g.beginPath();
    for (const [x, y, r] of traps) {
      g.moveTo(x + r + 5, y);
      g.arc(x, y, r + 5, 0, TAU);
    }
    g.fill();
    g.fillStyle = g.createPattern(gravelTile(rnd), 'repeat');
    g.beginPath();
    for (const [x, y, r] of traps) {
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
    g.fill();

    // Painted run-off right outside the white lines (still grass grip)
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = (HALF + CURB_W + 7) * 2;
    path();
    g.stroke();
    g.strokeStyle = g.createPattern(noiseTile(64, '#2c7046', 600, rnd, { light: 0.05, dark: 0.1, max: 1.5 }), 'repeat');
    g.lineWidth = (HALF + CURB_W + 4) * 2;
    path();
    g.stroke();

    // Asphalt with crisp white edge lines
    g.strokeStyle = '#e8e8e4';
    g.lineWidth = TRACK_W;
    path();
    g.stroke();
    g.strokeStyle = g.createPattern(asphaltTile(rnd), 'repeat');
    g.lineWidth = TRACK_W - 10;
    path();
    g.stroke();

    // Resurfaced patches across the full width, and soft tonal blotches
    g.lineCap = 'butt';
    for (let k = 0; k < 8; k++) {
      const i0 = Math.floor(rnd() * N);
      const list = Array.from({ length: 3 + Math.floor(rnd() * 6) }, (_, j) => (i0 + j) % N);
      g.strokeStyle = rnd() < 0.6 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.03)';
      g.lineWidth = TRACK_W - 10;
      path(() => 0, list);
      g.stroke();
    }
    g.lineCap = 'round';
    for (let k = 0; k < 220; k++) {
      const i = Math.floor(rnd() * N);
      const r = 14 + rnd() * 40;
      const [x, y] = off(i, (rnd() * 2 - 1) * (HALF - 8 - r));
      g.globalAlpha = 0.05 + rnd() * 0.08;
      g.drawImage(dark, x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;

    // Rubbered-in racing line: always there, heavier through corners and braking zones
    const line = (list = null) => path((i) => this.line[i], list);
    for (const [w, a] of [
      [110, 0.07],
      [64, 0.09],
      [30, 0.08],
    ]) {
      g.strokeStyle = `rgba(0,0,0,${a})`;
      g.lineWidth = w;
      line();
      g.stroke();
    }
    const ext = (run) => [(run[0] - 2 + N) % N, (run[0] - 1 + N) % N, ...run, (run.at(-1) + 1) % N, (run.at(-1) + 2) % N];
    const corners = runs(N, (i) => Math.abs(this.turn[i]) > 0.18);
    const braking = runs(N, (i) => this.vTarget[i] > this.vTarget[(i + 10) % N] * 1.2);
    g.strokeStyle = 'rgba(0,0,0,0.07)';
    g.lineWidth = 70;
    for (const run of corners) {
      line(ext(run));
      g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,0.09)';
    g.lineWidth = 44;
    for (const run of braking) {
      line(ext(run));
      g.stroke();
    }

    // Old skid marks in the braking zones, a little off the ideal line
    g.lineWidth = 4.5;
    for (const run of braking) {
      for (let set = 0; set < 3; set++) {
        if (rnd() < 0.3) continue;
        const a = Math.floor(rnd() * run.length * 0.5);
        const list = run.slice(a, a + 3 + Math.floor(rnd() * Math.max(1, run.length - a)));
        const j = (rnd() - 0.5) * 34;
        const wob = rnd() * TAU;
        g.strokeStyle = `rgba(8,8,10,${0.12 + rnd() * 0.16})`;
        if (list.length < 2) continue;
        for (const wheel of [-12, 12]) {
          path((i) => clamp(this.line[i] + j + wheel + Math.sin(i * 0.9 + wob) * 2.5, -HALF + 8, HALF - 8), list);
          g.stroke();
        }
      }
    }

    // Marbles: rubber crumbs swept off-line on the outside of the corners
    for (let i = 0; i < N; i++) {
      const t = this.turn[i];
      if (Math.abs(t) < 0.3) continue;
      const a = pts[i].angle;
      for (let k = 0; k < 14; k++) {
        const [x, y] = off(i, clamp(this.line[i] - Math.sign(t) * (48 + rnd() * 50), -HALF + 6, HALF - 6));
        const along = (rnd() - 0.5) * PT_GAP;
        const s = 1 + rnd() * 2.2;
        g.fillStyle = `rgba(14,14,16,${0.35 + rnd() * 0.35})`;
        g.fillRect(x + Math.cos(a) * along, y + Math.sin(a) * along, s, s);
      }
    }

    // Kerbs with depth: drop shadow, ridged red/white blocks, bevelled edges
    g.lineCap = 'butt';
    for (const run of runs(N, (i) => this.curb[i])) {
      const ext1 = [(run[0] - 1 + N) % N, ...run, (run.at(-1) + 1) % N];
      for (const side of [-1, 1]) {
        const mid = () => side * (HALF + CURB_W / 2 - 3);
        g.lineWidth = 12;
        g.strokeStyle = 'rgba(0,0,0,0.38)';
        path(() => side * (HALF + 12), ext1);
        g.stroke();
        g.lineWidth = CURB_W;
        g.strokeStyle = '#f2f2ee';
        path(mid, ext1);
        g.stroke();
        g.strokeStyle = '#d3203a';
        g.setLineDash([22, 22]);
        path(mid, ext1);
        g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.16)';
        g.lineWidth = CURB_W - 2;
        g.setLineDash([1.5, 5.5]);
        path(mid, ext1);
        g.stroke();
        g.setLineDash([]);
        g.lineWidth = 2;
        g.strokeStyle = 'rgba(255,255,255,0.45)';
        path(() => side * (HALF - 2), ext1);
        g.stroke();
        g.lineWidth = 2.5;
        g.strokeStyle = 'rgba(0,0,0,0.45)';
        path(() => side * (HALF + CURB_W - 4), ext1);
        g.stroke();
      }
    }
    g.lineCap = 'round';

    this.paintSheen(g);

    // Starting grid boxes
    g.strokeStyle = 'rgba(245,245,240,0.92)';
    g.fillStyle = 'rgba(245,245,240,0.92)';
    g.font = '700 18px "Rajdhani", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.slots.forEach((s, i) => {
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.angle);
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(22, -24);
      g.lineTo(38, -24);
      g.lineTo(38, 24);
      g.lineTo(22, 24);
      g.stroke();
      g.globalAlpha = 0.6;
      g.fillText(String(i + 1), 52, 0);
      g.restore();
    });

    // Start / finish: chequered strip between two crisp white lines
    const s = pts[0];
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.angle);
    const sq = (TRACK_W - 10) / 10;
    for (let row = 0; row < 2; row++) {
      for (let q = 0; q < 10; q++) {
        g.fillStyle = (row + q) % 2 ? '#111214' : '#f4f4f2';
        g.fillRect(-sq + row * sq, -HALF + 5 + q * sq, sq, sq);
      }
    }
    g.fillStyle = '#f4f4f2';
    g.fillRect(-sq - 4, -HALF + 5, 2, TRACK_W - 10);
    g.fillRect(sq + 2, -HALF + 5, 2, TRACK_W - 10);
    g.restore();

    // Boost pads: dark panels with dim chevrons (they light up live)
    for (const p of this.pads) {
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.angle);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.roundRect(-48, -42, 96, 84, 8);
      g.fill();
      g.fillStyle = '#0c1820';
      g.beginPath();
      g.roundRect(-46, -40, 92, 80, 6);
      g.fill();
      g.strokeStyle = 'rgba(56,217,255,0.55)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#145a70';
      for (let q = 0; q < 3; q++) {
        const x = -30 + q * 26;
        g.beginPath();
        g.moveTo(x, -26);
        g.lineTo(x + 18, 0);
        g.lineTo(x, 26);
        g.lineTo(x + 8, 26);
        g.lineTo(x + 26, 0);
        g.lineTo(x + 8, -26);
        g.closePath();
        g.fill();
      }
      g.restore();
    }

    // Tyre walls: soft shadows first, then stacks with red/white belts
    const tyres = [];
    let k = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      for (const t of [0, 0.5]) {
        for (const side of [-1, 1]) {
          const [ax, ay] = off(i, side * (wallD[i] + 7));
          const [bx, by] = off(j, side * (wallD[j] + 7));
          tyres.push([ax + (bx - ax) * t, ay + (by - ay) * t, k++ % 6 < 3]);
        }
      }
    }
    for (const [r, d, a] of [
      [12, 6, 0.16],
      [8.5, 4, 0.3],
    ]) {
      g.fillStyle = `rgba(0,0,0,${a})`;
      g.beginPath();
      for (const [x, y] of tyres) {
        g.moveTo(x + d * 0.7 + r, y + d);
        g.arc(x + d * 0.7, y + d, r, 0, TAU);
      }
      g.fill();
    }
    const redTyre = tyreSprite('#d6283a');
    const whiteTyre = tyreSprite('#eeeeee');
    for (const [x, y, red] of tyres) g.drawImage(red ? redTyre : whiteTyre, x - 10, y - 10, 20, 20);

    this.paintSceneryGround(g, path, dark);
    return c;
  }

  // The flat parts of the scenery: boards, shadows, footings, forest floor.
  paintSceneryGround(g, path, dark) {
    const { wallD } = this;

    // Trackside boards behind the walls, coloured face toward the track
    g.lineCap = 'butt';
    for (const b of this.boards) {
      g.lineWidth = 9;
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      path((i) => b.side * (wallD[i] + 25), b.idx);
      g.stroke();
      g.lineWidth = 6;
      g.strokeStyle = '#101219';
      path((i) => b.side * (wallD[i] + 22), b.idx);
      g.stroke();
      g.lineWidth = 2.5;
      g.strokeStyle = b.color;
      path((i) => b.side * (wallD[i] + 20.5), b.idx);
      g.stroke();
      g.setLineDash([6, 10]);
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      path((i) => b.side * (wallD[i] + 23.5), b.idx);
      g.stroke();
      g.setLineDash([]);
    }

    // Woods: forest-floor shade, cast shadows, then occlusion at each trunk
    for (const [scale, alpha, sh] of [
      [2.4, 0.2, 0],
      [1.2, 0.5, 0.7],
      [0.5, 0.55, 0],
    ]) {
      g.globalAlpha = alpha;
      for (const t of this.trees) {
        const r = t.r * scale;
        g.drawImage(dark, t.x + SHADOW_X * t.h * sh - r, t.y + SHADOW_Y * t.h * sh - r, r * 2, r * 2);
      }
    }
    g.globalAlpha = 1;

    // Floodlight towers: a long thin shadow ending in the lamp head's, and a concrete footing
    g.lineCap = 'round';
    for (const tw of this.towers) {
      const ex = tw.x + SHADOW_X * tw.h * 0.6;
      const ey = tw.y + SHADOW_Y * tw.h * 0.6;
      for (const [w, a] of [
        [12, 0.16],
        [5, 0.26],
      ]) {
        g.strokeStyle = `rgba(0,0,0,${a})`;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(tw.x, tw.y);
        g.lineTo(ex, ey);
        g.stroke();
      }
      g.save();
      g.translate(ex, ey);
      g.rotate(tw.face);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(-6, -34, 12, 68);
      g.restore();
      g.save();
      g.translate(tw.x, tw.y);
      g.rotate(tw.face);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(-11, -11, 26, 26);
      g.fillStyle = '#5a5e68';
      g.fillRect(-13, -13, 26, 26);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(-13, -13, 26, 3);
      g.restore();
    }

    // Grandstands: long soft shadow, then the concrete footprint
    for (const s of this.stands) {
      g.save();
      g.translate(s.x + SHADOW_X * 50, s.y + SHADOW_Y * 50);
      g.rotate(s.angle);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(-s.len / 2 - 14, -62, s.len + 28, 124);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(-s.len / 2 - 4, -52, s.len + 8, 104);
      g.restore();
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.angle);
      g.fillStyle = '#23262f';
      g.fillRect(-s.len / 2 - 6, -54, s.len + 12, 108);
      g.restore();
    }

    // Gantry: the beam's shadow lies across the track; concrete footings for the legs
    const gt = this.gantry;
    const sx = SHADOW_X * gt.h * 0.6;
    const sy = SHADOW_Y * gt.h * 0.6;
    g.lineCap = 'butt';
    for (const [w, a] of [
      [34, 0.14],
      [16, 0.22],
    ]) {
      g.strokeStyle = `rgba(0,0,0,${a})`;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(gt.ax + sx, gt.ay + sy);
      g.lineTo(gt.bx + sx, gt.by + sy);
      g.stroke();
    }
    for (const [x, y] of [
      [gt.ax, gt.ay],
      [gt.bx, gt.by],
    ]) {
      g.save();
      g.translate(x, y);
      g.rotate(gt.angle);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(-7, -7, 20, 20);
      g.fillStyle = '#5a5e68';
      g.fillRect(-9, -9, 18, 18);
      g.restore();
    }
    g.lineCap = 'round';
  }

  // Wet-look sheen under each floodlight: a warm radial gradient masked to the asphalt.
  paintSheen(g) {
    const S = 960;
    const m = makeCanvas(S, S);
    const mg = m.getContext('2d');
    for (const tw of this.towers) {
      mg.setTransform(1, 0, 0, 1, 0, 0);
      mg.globalCompositeOperation = 'source-over';
      mg.clearRect(0, 0, S, S);
      mg.translate(S / 2 - tw.px, S / 2 - tw.py);
      mg.lineJoin = 'round';
      mg.strokeStyle = '#fff';
      mg.lineWidth = TRACK_W - 12;
      mg.beginPath();
      this.pts.forEach((p, i) => (i ? mg.lineTo(p.x, p.y) : mg.moveTo(p.x, p.y)));
      mg.closePath();
      mg.stroke();
      mg.setTransform(1, 0, 0, 1, 0, 0);
      mg.globalCompositeOperation = 'source-in';
      const grd = mg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, 'rgba(255,214,160,0.11)');
      grd.addColorStop(0.45, 'rgba(255,214,160,0.04)');
      grd.addColorStop(1, 'rgba(255,214,160,0)');
      mg.fillStyle = grd;
      mg.fillRect(0, 0, S, S);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.drawImage(m, tw.px - S / 2, tw.py - S / 2);
      g.restore();
    }
    m.width = 0;
    m.height = 0;
  }

  // Static lighting at 1/8 scale: a soft wash along the circuit plus every
  // floodlight pool. Each view copies its part into its light map per frame.
  paintLight() {
    const c = makeCanvas(Math.ceil(WORLD_W * LIGHT_RES), Math.ceil(WORLD_H * LIGHT_RES));
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.scale(LIGHT_RES, LIGHT_RES);
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    for (const [w, a] of [
      [760, 0.05],
      [520, 0.07],
      [340, 0.1],
      [220, 0.12],
    ]) {
      g.strokeStyle = `rgba(255,222,186,${a})`;
      g.lineWidth = w;
      g.beginPath();
      this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.stroke();
    }
    const pool = (x, y, r, color, a) => {
      g.globalAlpha = a;
      g.drawImage(glowSprite(color, 128, 0.02), x - r, y - r, r * 2, r * 2);
    };
    for (const tw of this.towers) {
      pool(tw.px, tw.py, 460, SODIUM, 0.8);
      pool(tw.px, tw.py, 220, '#fff0d8', 0.25);
      pool(tw.x, tw.y, 90, SODIUM, 0.4);
    }
    for (const s of this.stands) pool(s.x, s.y, s.len * 0.75, '#dfe8ff', 0.5);
    for (const p of this.pads) pool(p.x, p.y, 150, '#38d9ff', 0.45);
    pool(this.gantry.x, this.gantry.y, 300, '#f4f0ff', 0.55);
    g.globalAlpha = 1;
    return c;
  }

  // Minimap track, painted at 2x so it stays crisp when scaled down.
  paintMini() {
    const c = makeCanvas(520, 376);
    const g = c.getContext('2d');
    g.scale(520 / WORLD_W, 376 / WORLD_H);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
    };
    for (const [w, color] of [
      [150, 'rgba(0,0,0,0.55)'],
      [105, 'rgba(255,255,255,0.14)'],
      [40, 'rgba(236,240,255,0.92)'],
    ]) {
      g.strokeStyle = color;
      g.lineWidth = w;
      path();
      g.stroke();
    }
    // Sector boundaries
    g.strokeStyle = GOLD;
    g.lineWidth = 26;
    g.lineCap = 'butt';
    for (const f of [1 / 3, 2 / 3]) {
      const p = this.pts[Math.floor(this.N * f)];
      const nx = -Math.sin(p.angle) * 90;
      const ny = Math.cos(p.angle) * 90;
      g.beginPath();
      g.moveTo(p.x - nx, p.y - ny);
      g.lineTo(p.x + nx, p.y + ny);
      g.stroke();
    }
    return c;
  }

  nearestIndex(x, y, from = null) {
    const N = this.N;
    let best = 0;
    let bd = Infinity;
    if (from !== null) {
      for (let k = -14; k <= 22; k++) {
        const i = (from + k + N) % N;
        const p = this.pts[i];
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (bd < 320 * 320) return best;
    }
    for (let i = 0; i < N; i++) {
      const p = this.pts[i];
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  note(c, title, sub = '', color = '#fff', dur = 1.8) {
    if (!c.cpu) c.note = { title, sub, color, t: dur, dur };
  }

  /* ------------------------------------------------------------ Update */
  update(dt, inputs) {
    this.time += dt;
    this.particles.update(dt);
    this.smoke.update(dt);
    for (const c of this.cars) {
      c.shake = Math.max(0, c.shake - dt * 18);
      if (c.note && (c.note.t -= dt) <= 0) c.note = null;
      if (c.split && (c.split.t -= dt) <= 0) c.split = null;
    }
    this.updatePost(dt);
    if (this.result) return;

    if (this.state === 'countdown') {
      this.countdown(dt, inputs);
      return;
    }

    this.raceTime += dt;
    for (const c of this.cars) {
      const auto = c.cpu || c.finishTime !== null;
      let inp = auto ? this.bot(c, dt) : (inputs[c.i] ?? IDLE);
      if (c.holdT > 0) {
        c.holdT -= dt;
        inp = IDLE;
      } else if (!c.launched && !auto && Math.hypot(inp.x, inp.y) > 0.5) this.launch(c);
      this.slipstream(c, dt);
      this.driveCar(c, inp, dt);
      this.track(c, dt);
    }
    this.collide();

    const humansDone = this.humans.every((c) => c.finishTime !== null);
    const timeout = this.firstFinish !== null && this.raceTime - this.firstFinish > 30;
    if ((humansDone || timeout) && !this.endT) this.endT = 2.5;
    if (this.endT) {
      this.endT -= dt;
      if (this.endT <= 0) this.finish();
    }
  }

  // Five reds come on one by one, hold for a random beat, then go out.
  countdown(dt, inputs) {
    this.countT += dt;
    const lit = clamp(Math.floor((this.countT - LIGHT_PRE) / LIGHT_GAP) + 1, 0, 5);
    if (lit > this.lights) {
      this.lights = lit;
      this.host.sfx('count');
    }
    for (const c of this.humans) {
      const inp = inputs[c.i] ?? IDLE;
      if (this.lights >= 1 && !c.jump && Math.hypot(inp.x, inp.y) > 0.6) {
        c.jump = true;
        this.host.sfx('hit');
        this.host.buzz(c.i, 220);
        this.note(c, 'JUMP START!', 'Wait for the lights to go out', '#ff3b5c', 2.4);
      }
    }
    if (this.countT >= this.goAt) {
      this.state = 'race';
      this.lights = 0;
      this.host.sfx('go');
      for (const c of this.cars) {
        if (c.jump) {
          c.holdT = 1.6;
          c.launched = true;
        }
      }
    }
  }

  // Reaction time off the line decides the launch.
  launch(c) {
    c.launched = true;
    const r = this.raceTime;
    if (r < 0.3) {
      c.boostT = 1.2;
      this.host.sfx('boost');
      this.host.buzz(c.i, 120);
      this.note(c, 'PERFECT START', `${r.toFixed(2)}s reaction`, '#22d36b');
    } else if (r < 0.55) this.note(c, 'GOOD START', `${r.toFixed(2)}s reaction`, '#38d9ff', 1.4);
  }

  // Tuck in behind a rival at speed to cut through the air more easily.
  slipstream(c, dt) {
    let best = 0;
    if (c.speed > 280) {
      const fx = Math.cos(c.angle);
      const fy = Math.sin(c.angle);
      for (const o of this.cars) {
        if (o === c || o.speed < 250) continue;
        const dx = o.x - c.x;
        const dy = o.y - c.y;
        const along = dx * fx + dy * fy;
        if (along < 45 || along > 340) continue;
        if (Math.abs(dx * -fy + dy * fx) > 42) continue;
        best = Math.max(best, 1 - ((along - 45) / 295) * 0.6);
      }
    }
    c.draft += (best - c.draft) * Math.min(1, dt * (best > c.draft ? 2 : 4));
  }

  driveCar(c, inp, dt) {
    const S = SURFACES[c.surface];
    const fx = Math.cos(c.angle);
    const fy = Math.sin(c.angle);
    const rx = -fy;
    const ry = fx;
    let vf = c.vx * fx + c.vy * fy;
    let vr = c.vx * rx + c.vy * ry;

    // Stick → throttle & steering. Pointing well behind a slow car reverses it.
    const m = Math.min(1, Math.hypot(inp.x, inp.y));
    let throttle = 0;
    let steer = 0;
    let reverse = false;
    if (m > 0.25) {
      const want = Math.atan2(inp.y, inp.x);
      const diff = angleDiff(c.angle, want);
      if (inp.reverse || (Math.abs(diff) > 2.1 && vf < 60)) {
        reverse = true;
        throttle = -m;
        // Backing up swings the nose toward the stick, three-point-turn style.
        // Near ±180° keep turning the same way instead of dithering.
        if (!c.reverse || Math.abs(diff) < 2.7) c.revSign = Math.sign(diff) || 1;
        steer = -c.revSign * Math.min(1, Math.abs(diff) * 2.2);
      } else {
        steer = clamp(diff * 2.2, -1, 1);
        throttle = m * (Math.abs(diff) > 1.9 ? 0.3 : 1);
      }
    }
    const braking = inp.b && !reverse;
    // Handbrake turn: brake + steer at speed kicks the tail out.
    if (braking && !inp.noDrift && Math.abs(steer) > 0.35 && vf > 250) c.drifting = true;
    else if (!(c.drifting && inp.b && Math.abs(vr) > 60 && vf > 120)) c.drifting = false;

    c.boostT -= dt;
    const nitro = inp.a && throttle > 0 && c.nitro > 0.02;
    if (nitro) {
      if (!c.nitroOn && !c.cpu) this.host.sfx('boost');
      c.nitro = Math.max(0, c.nitro - dt * 0.45);
    } else c.nitro = Math.min(1, c.nitro + dt * (0.03 + 0.07 * c.draft));
    c.nitroOn = nitro;
    const boosting = c.boostT > 0 || nitro;
    const max = (boosting ? BOOST_MAX : MAX) * S.max * c.pace * (1 + 0.1 * c.draft);

    // Longitudinal: brakes, engine, reverse, rolling resistance
    if (braking && !c.drifting) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 1150 * (0.4 + 0.6 * S.grip) * dt);
    else if (c.drifting) vf -= Math.min(Math.max(vf, 0), 160 * dt);
    if (throttle > 0 && (!braking || c.drifting) && vf < max) {
      const push = ACCEL * throttle * (boosting ? 1.6 : 1) * (1 + 0.35 * c.draft) * (1 - (0.45 * Math.max(0, vf)) / max);
      vf = Math.min(max, vf + push * dt);
    } else if (throttle < 0) vf = Math.max(-REV_MAX, vf + throttle * 520 * dt);
    else if (throttle === 0 && !braking) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 130 * dt);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), S.roll * dt);
    if (vf > max) vf -= (vf - max) * Math.min(1, dt * 2); // ease down after a boost or onto grass

    // Yaw: steering asks for a rotation rate; low grip makes the car slower to respond.
    const spd = Math.abs(vf);
    const sf = clamp(spd / 180, 0.22, 1) * (1 - 0.3 * clamp((spd - 300) / 500, 0, 1));
    const dir = reverse || vf < -5 ? -1 : 1;
    const target = steer * TURN * sf * dir * (c.drifting ? 1.55 : 1);
    c.yaw += (target - c.yaw) * Math.min(1, dt * 9 * (0.4 + 0.6 * S.grip));
    c.spin -= c.spin * Math.min(1, dt * 2.2);
    c.angle += (c.yaw + c.spin) * dt;
    c.steer += (steer * dir - c.steer) * Math.min(1, dt * 12);

    // Lateral: tyres can only pull so hard sideways — beyond that the car slides.
    const grip = GRIP * S.grip * (c.drifting ? 0.3 : 1) * (braking && !c.drifting ? 0.85 : 1);
    vr -= Math.sign(vr) * Math.min(Math.abs(vr), grip * dt);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), Math.abs(vr) * 0.5 * dt); // sliding scrubs speed
    c.slip = Math.abs(vr);

    c.vx = fx * vf + rx * vr;
    c.vy = fy * vf + ry * vr;
    c.x = clamp(c.x + c.vx * dt, 30, WORLD_W - 30);
    c.y = clamp(c.y + c.vy * dt, 30, WORLD_H - 30);
    c.speed = vf;
    c.top = Math.max(c.top, vf);
    c.braking = braking && vf > 20;
    c.reverse = reverse;
    c.boosting = boosting;

    // Drifting on asphalt charges the nitro tank.
    if (c.drifting && c.surface === 'asphalt' && vf > 200 && c.slip > 70) {
      c.nitro = Math.min(1, c.nitro + dt * 0.3);
      c.driftT += dt;
    } else c.driftT = 0;

    this.tyreFx(c, fx, fy, rx, ry, braking, throttle, dt);

    if (boosting && Math.random() < 0.6) {
      this.particles.burst(c.x - fx * 36, c.y - fy * 36, { count: 1, color: Math.random() < 0.5 ? '#38d9ff' : '#ffb347', speed: 140, life: 0.22, angle: c.angle + Math.PI, spread: 0.5, size: 3 });
    }

    for (const pad of this.pads) {
      if (c.boostT <= 0.6 && dist(pad.x, pad.y, c.x, c.y) < 56) {
        c.boostT = 1.3;
        if (!c.cpu) {
          this.host.sfx('boost');
          this.host.buzz(c.i, 60);
        }
      }
    }
  }

  // Skid marks burned into the track, tyre smoke, dust, curb rumble.
  tyreFx(c, fx, fy, rx, ry, braking, throttle, dt) {
    const spd = Math.hypot(c.vx, c.vy);
    const off = c.surface === 'grass' || c.surface === 'sand';
    const lockup = braking && !c.drifting && c.speed > 330;
    const wheelspin = throttle > 0.8 && c.speed < 140 && c.speed > 10 && (c.boostT > 0 || c.nitroOn);
    const skid = c.slip > 110 || lockup || wheelspin;
    const tyres = [
      [-19, -12],
      [-19, 12],
      [18, -12],
      [18, 12],
    ].map(([a, b]) => [c.x + fx * a + rx * b, c.y + fy * a + ry * b]);

    if (c.tyres && spd > 40 && (skid || off)) {
      const n = off || c.slip > 260 || lockup ? 4 : 2;
      const style = off ? (c.surface === 'sand' ? 'rgba(70,52,28,0.35)' : 'rgba(30,22,10,0.3)') : `rgba(10,10,12,${clamp(c.slip / 600 + (lockup ? 0.2 : 0), 0.14, 0.38)})`;
      // Only touch the tiles under the marks, so the GPU re-uploads a few small textures, not the world.
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < n; k++) {
        for (const p of [c.tyres[k], tyres[k]]) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
      }
      for (const t of this.tilesIn(x0 - 8, y0 - 8, x1 + 8, y1 + 8)) {
        const g = t.g;
        g.setTransform(1, 0, 0, 1, -t.x, -t.y);
        g.strokeStyle = style;
        g.lineWidth = off ? 7 : 6;
        g.lineCap = 'round';
        g.beginPath();
        for (let k = 0; k < n; k++) {
          g.moveTo(c.tyres[k][0], c.tyres[k][1]);
          g.lineTo(tyres[k][0], tyres[k][1]);
        }
        g.stroke();
      }
    }
    c.tyres = tyres;

    if (skid && !off && spd > 60) {
      for (let k = 0; k < 2; k++) {
        if (Math.random() < 0.55) {
          this.smoke.add(tyres[k][0], tyres[k][1], c.vx * 0.15 + rand(-30, 30), c.vy * 0.15 + rand(-30, 30), { r: 7, grow: 46, life: 1.1, color: '#d4d4da', alpha: 0.32 });
        }
      }
    }
    if (off && spd > 110 && Math.random() < 0.7) {
      const t = tyres[Math.floor(Math.random() * 2)];
      const sand = c.surface === 'sand';
      this.smoke.add(t[0], t[1], -c.vx * 0.2 + rand(-60, 60), -c.vy * 0.2 + rand(-60, 60), { r: 6, grow: 38, life: 0.9, color: sand ? '#b89a68' : '#5a5236', alpha: sand ? 0.45 : 0.32 });
      if (sand && Math.random() < 0.5) this.particles.burst(t[0], t[1], { count: 2, color: '#c9a86e', speed: 160, life: 0.35, angle: c.angle + Math.PI, spread: 1.2, size: 2 });
    }

    // Rumble: curbs judder, grass shakes
    if ((c.surface === 'curb' || off) && spd > 150) {
      c.rumbleT -= dt;
      if (c.rumbleT <= 0) {
        c.rumbleT = c.surface === 'curb' ? 0.09 : 0.2;
        c.shake = Math.max(c.shake, c.surface === 'curb' ? 2.5 : 3.5);
        if (!c.cpu) this.host.buzz(c.i, c.surface === 'curb' ? 25 : 45);
      }
    }
  }

  track(c, dt) {
    const N = this.N;
    const idx = this.nearestIndex(c.x, c.y, c.idx);
    let delta = idx - c.idx;
    if (delta > N / 2) delta -= N;
    if (delta < -N / 2) delta += N;
    const before = c.progress;
    c.progress += clamp(delta, -12, 12); // big jumps = cutting across the infield, not counted
    for (let k = before + 1; k <= c.progress; k++) {
      const j = k + N;
      if (j >= 0 && j < c.pass.length && c.pass[j] < 0) c.pass[j] = this.raceTime;
    }
    c.idx = idx;
    const p = this.pts[idx];
    const nx = -Math.sin(p.angle);
    const ny = Math.cos(p.angle);
    const s = (c.x - p.x) * nx + (c.y - p.y) * ny;
    const d = Math.abs(s);
    c.lat = s;

    // Tyre wall: bounce off, lose speed, maybe spin
    const wall = this.wallD[idx] - 17;
    if (d > wall) {
      const ox = nx * Math.sign(s);
      const oy = ny * Math.sign(s);
      c.x -= ox * (d - wall);
      c.y -= oy * (d - wall);
      const vn = c.vx * ox + c.vy * oy;
      if (vn > 0) {
        c.vx -= ox * vn * 1.4;
        c.vy -= oy * vn * 1.4;
        const vt = c.vx * -oy + c.vy * ox;
        const f = Math.min(1, vn / 700) * 0.5;
        c.vx -= -oy * vt * f;
        c.vy -= ox * vt * f;
        c.spin = clamp(c.spin - (Math.cos(c.angle) * oy - Math.sin(c.angle) * ox) * vn * 0.006, -7, 7);
        if (vn > 120) {
          c.shake = Math.min(14, c.shake + vn / 40);
          this.particles.burst(c.x + ox * 30, c.y + oy * 30, { count: 12, color: '#ffd166', speed: 240, life: 0.35, size: 2.5 });
          this.particles.burst(c.x + ox * 30, c.y + oy * 30, { count: 4, color: '#2a2a2a', speed: 160, life: 0.5, size: 4 });
          if (!c.cpu) {
            this.host.sfx('crash');
            this.host.buzz(c.i, 140);
          }
        }
      }
    }

    // What's under the car?
    if (d <= HALF + 6) c.surface = 'asphalt';
    else if (this.curb[idx] && d <= HALF + CURB_W) c.surface = 'curb';
    else if (this.sandSide[idx] === Math.sign(s) && d > HALF + CURB_W + 4) c.surface = 'sand';
    else c.surface = 'grass';

    const along = c.vx * Math.cos(p.angle) + c.vy * Math.sin(p.angle);
    c.wrongT = along < -60 ? c.wrongT + dt : Math.max(0, c.wrongT - dt * 2);

    // Sector splits
    const lapBase = (c.lastLap - 1) * N;
    while (c.finishTime === null && c.nextSplit < 3 && c.progress - lapBase >= (c.nextSplit * N) / 3) {
      const t = this.raceTime - c.lapStart;
      c.splits[c.nextSplit - 1] = t;
      this.showSplit(c, c.nextSplit - 1, t);
      c.nextSplit++;
    }

    const lap = Math.floor(c.progress / N) + 1;
    if (lap > c.lastLap && c.finishTime === null) {
      const lapTime = this.raceTime - c.lapStart;
      c.splits[2] = lapTime;
      this.showSplit(c, 2, lapTime);
      const pb = c.best === null || lapTime < c.best;
      if (pb) {
        c.best = lapTime;
        c.bestSplits = c.splits.slice();
      }
      const fastest = this.fastest === null || lapTime < this.fastest;
      if (fastest) this.fastest = lapTime;
      c.splits = [];
      c.nextSplit = 1;
      c.lapStart = this.raceTime;
      c.lastLap = lap;
      if (lap > LAPS) {
        c.finishTime = this.raceTime;
        c.place = ++this.finished;
        if (this.firstFinish === null) this.firstFinish = this.raceTime;
        if (!c.cpu) {
          this.host.sfx(c.place === 1 ? 'win' : 'deliver');
          this.host.buzz(c.i, 300);
        }
      } else if (!c.cpu) {
        const sub = fastest ? `${formatTime(lapTime)} · FASTEST LAP` : pb && lap > 2 ? `${formatTime(lapTime)} · personal best` : formatTime(lapTime);
        this.note(c, lap === LAPS ? 'FINAL LAP' : `LAP ${lap}`, sub, fastest ? '#b26bff' : lap === LAPS ? '#ffd166' : '#fff', 2.2);
        this.host.sfx(fastest ? 'coin' : 'pickup');
      }
    }
  }

  // Sector time vs. the player's own best lap (no ghosts, just numbers).
  showSplit(c, k, t) {
    if (c.cpu) return;
    const ref = c.bestSplits?.[k];
    c.split = { label: k < 2 ? `S${k + 1}` : 'LAP', time: t, delta: ref === undefined ? null : t - ref, t: 2.6 };
  }

  // Two circles per car so a hit on the tail spins it like a real shunt.
  collide() {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (Math.abs(a.x - b.x) > 70 || Math.abs(a.y - b.y) > 70) continue;
        for (const ka of [-1, 1]) {
          for (const kb of [-1, 1]) {
            const ax = a.x + Math.cos(a.angle) * ka * CIRC_OFF;
            const ay = a.y + Math.sin(a.angle) * ka * CIRC_OFF;
            const bx = b.x + Math.cos(b.angle) * kb * CIRC_OFF;
            const by = b.y + Math.sin(b.angle) * kb * CIRC_OFF;
            const d = dist(ax, ay, bx, by);
            if (d === 0 || d >= CIRC_R * 2) continue;
            const nx = (bx - ax) / d;
            const ny = (by - ay) / d;
            const pen = (CIRC_R * 2 - d) / 2;
            a.x -= nx * pen;
            a.y -= ny * pen;
            b.x += nx * pen;
            b.y += ny * pen;
            const cx = (ax + bx) / 2;
            const cy = (ay + by) / 2;
            const rax = cx - a.x;
            const ray = cy - a.y;
            const rbx = cx - b.x;
            const rby = cy - b.y;
            const wa = a.yaw + a.spin;
            const wb = b.yaw + b.spin;
            const rel = (b.vx - wb * rby - (a.vx - wa * ray)) * nx + (b.vy + wb * rbx - (a.vy + wa * rax)) * ny;
            if (rel >= 0) continue;
            const ra = rax * ny - ray * nx;
            const rb = rbx * ny - rby * nx;
            const imp = (-1.3 * rel) / (2 + (ra * ra + rb * rb) / SPIN_I);
            a.vx -= nx * imp;
            a.vy -= ny * imp;
            b.vx += nx * imp;
            b.vy += ny * imp;
            a.spin = clamp(a.spin - (ra * imp) / SPIN_I, -7, 7);
            b.spin = clamp(b.spin + (rb * imp) / SPIN_I, -7, 7);
            if (-rel > 140) {
              this.particles.burst(cx, cy, { count: 10, color: '#ffd166', speed: 220, life: 0.3, size: 2.5 });
              for (const c of [a, b]) {
                c.shake = Math.min(12, c.shake - rel / 40);
                if (!c.cpu) {
                  this.host.sfx('crash');
                  this.host.buzz(c.i, 90);
                }
              }
            }
          }
        }
      }
    }
  }

  standings() {
    return [...this.cars].sort((a, b) => {
      if (a.finishTime !== null && b.finishTime !== null) return a.place - b.place;
      if (a.finishTime !== null) return -1;
      if (b.finishTime !== null) return 1;
      return b.progress - a.progress;
    });
  }

  // Seconds `c` is behind `ahead`, measured where c is now.
  gap(c, ahead) {
    const t = ahead.pass[c.progress + this.N];
    return t === undefined || t < 0 ? null : this.raceTime - t;
  }

  finish() {
    const order = this.standings();
    const winner = order[0];
    this.result = {
      title: `${winner.name} wins the Grand Prix!`,
      color: winner.color,
      subtitle: `${LAPS} laps${this.fastest !== null ? ` · fastest lap ${formatTime(this.fastest)}` : ''}`,
      columns: ['Time', 'Best lap', 'Top speed'],
      rows: order.map((c) => ({
        name: c.name,
        color: c.color,
        values: [c.finishTime !== null ? formatTime(c.finishTime) : 'DNF', c.best !== null ? formatTime(c.best) : '—', `${Math.round(c.top / 3)} km/h`],
      })),
    };
  }

  /* --------------------------------------------------------------- CPU */
  bot(c, dt) {
    if (!c.launched) {
      if (this.raceTime < c.reactT) return IDLE;
      c.launched = true;
      if (c.reactT < 0.3) c.boostT = 1.2;
    }
    const N = this.N;
    const speed = Math.max(0, c.speed);

    // Rubber-banding: ease off when well clear of the humans, dig deeper when behind.
    let lead = -Infinity;
    for (const h of this.humans) if (h.finishTime === null) lead = Math.max(lead, h.progress);
    const gap = lead === -Infinity ? 0 : c.progress - lead;
    c.pace = c.finishTime !== null ? 0.85 : c.skill * clamp(1 - gap * 0.0016, 0.9, 1.05);

    // Stuck against a wall or another car? Back out of it.
    c.stuckT = speed < 30 && c.reverseT <= 0 ? c.stuckT + dt : 0;
    if (c.stuckT > 1) {
      c.reverseT = 0.8;
      c.stuckT = 0;
    }
    if (c.reverseT > 0) {
      c.reverseT -= dt;
      const p = this.pts[(c.idx + 6) % N];
      const a = Math.atan2(p.y - c.y, p.x - c.x); // reversing swings the nose toward the track
      return { x: Math.cos(a), y: Math.sin(a), a: false, b: false, aPressed: false, bPressed: false, reverse: true, noDrift: true };
    }

    // Someone slower right in front? Pick a side and go round.
    const fx = Math.cos(c.angle);
    const fy = Math.sin(c.angle);
    c.passT -= dt;
    for (const o of this.cars) {
      if (o === c) continue;
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      const along = dx * fx + dy * fy;
      if (along < 20 || along > 210) continue;
      if (Math.abs(dx * -fy + dy * fx) > 46 || o.speed > speed + 30) continue;
      let go = o.lat > 0 ? -1 : 1;
      if (Math.abs(o.lat + go * 70) > LINE_LIM) go = -go;
      c.passOff = clamp(o.lat + go * 70, -LINE_LIM, LINE_LIM);
      c.passT = 1.1;
    }

    const look = 5 + Math.floor(speed / 85);
    const j = (c.idx + look) % N;
    const want = c.passT > 0 ? c.passOff : clamp(this.line[j] + c.lane, -LINE_LIM, LINE_LIM);
    c.off += (want - c.off) * Math.min(1, dt * 3);
    const p = this.pts[j];
    const aim = Math.atan2(p.y + Math.cos(p.angle) * c.off - c.y, p.x - Math.sin(p.angle) * c.off - c.x);

    const vt = this.vTarget[(c.idx + 2 + Math.floor(speed / 160)) % N] * c.pace;
    let m = 1;
    let brake = false;
    if (speed > vt + 30) brake = true;
    else if (speed > vt) m = 0.3;
    const nitro = c.nitro > 0.3 && speed > 300 && this.vTarget[(c.idx + 18) % N] > BOOST_MAX && vt > BOOST_MAX;
    return { x: Math.cos(aim) * m, y: Math.sin(aim) * m, a: nitro, b: brake, aPressed: false, bPressed: false, noDrift: true };
  }

  // Post-process nudges for the host's WebGL pass: lens fringing while a
  // player burns nitro, a brief warm flash on a big shunt. Purely cosmetic.
  updatePost(dt) {
    let boost = 0;
    let hit = 0;
    for (const c of this.humans) {
      if (c.boosting) boost = Math.max(boost, c.nitroOn ? 1 : 0.6);
      hit = Math.max(hit, c.shake);
    }
    this.boostFx += (boost - this.boostFx) * Math.min(1, dt * (boost > this.boostFx ? 8 : 3));
    const share = 1 / this.humans.length; // one player's moment shouldn't swamp everyone's screen
    this.post.aberration = POST.aberration + 0.0032 * this.boostFx * share;
    this.post.flash = clamp((hit - 8) / 6, 0, 1) * 0.12 * share;
  }

  /* ------------------------------------------------------------ Render */
  render(ctx) {
    ctx.fillStyle = '#05040d';
    ctx.fillRect(0, 0, W, H);
    const order = this.standings();
    // Camera easing based on elapsed time, so it keeps up at any frame rate.
    const dt = this.time - (this.lastRender ?? this.time);
    this.lastRender = this.time;
    this.camK = 1 - Math.exp(-dt * 6);
    this.zoomK = 1 - Math.exp(-dt * 1.8);
    // Light trails: a short history of every car's pose, sampled at ~60 Hz.
    this.trailT = (this.trailT ?? 0) + dt;
    if (this.trailT >= 1 / 60) {
      this.trailT %= 1 / 60;
      for (const c of this.cars) {
        const t = (c.trail ??= []);
        t.unshift(c.x, c.y, c.angle);
        if (t.length > 30) t.length = 30;
      }
    }
    this.humans.forEach((c, k) => this.renderView(ctx, this.views[k], c, order, k));
    if (this.views.length === 3) this.drawBoard(ctx, order);

    // Split-screen seams: a dark gutter with a faint hairline
    ctx.fillStyle = '#05040d';
    if (this.views.length >= 2) ctx.fillRect(W / 2 - 3, 0, 6, H);
    if (this.views.length >= 3) ctx.fillRect(0, H / 2 - 3, W, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    if (this.views.length >= 2) ctx.fillRect(W / 2 - 0.5, 0, 1, H);
    if (this.views.length >= 3) ctx.fillRect(0, H / 2 - 0.5, W, 1);

    if (this.views.length === 1) this.drawStandings(ctx, order, W - 290, 60);
    if (this.state === 'countdown') this.drawLights(ctx);
    else if (this.raceTime < 1) {
      this.drawLights(ctx, 1 - this.raceTime);
      text(ctx, 'GO!', W / 2, H / 2 + 150, { size: 120, color: '#22d36b', glow: 30, alpha: 1 - this.raceTime, spacing: 8 });
    }
  }

  renderView(ctx, view, car, order, k) {
    // Camera: leads in the direction of travel and pulls back with speed.
    const spd = Math.hypot(car.vx, car.vy);
    const zT = this.zoom * (1.06 - 0.24 * clamp(spd / BOOST_MAX, 0, 1));
    car.camZ = car.camZ === undefined ? zT : car.camZ + (zT - car.camZ) * this.zoomK;
    const z = car.camZ;
    const vw = view.w / z;
    const vh = view.h / z;
    const tx = car.x + car.vx * 0.42 + Math.cos(car.angle) * 40;
    const ty = car.y + car.vy * 0.42 + Math.sin(car.angle) * 40;
    car.camX = car.camX === undefined ? tx : car.camX + (tx - car.camX) * this.camK;
    car.camY = car.camY === undefined ? ty : car.camY + (ty - car.camY) * this.camK;
    const cx = clamp(car.camX - vw / 2 + (Math.random() - 0.5) * car.shake, 0, WORLD_W - vw);
    const cy = clamp(car.camY - vh / 2 + (Math.random() - 0.5) * car.shake, 0, WORLD_H - vh);
    const x1 = cx + vw;
    const y1 = cy + vh;

    // 2.5D: tall things lean away from the view centre like under a real
    // overhead camera, and grow slightly as they get closer to it.
    const ccx = cx + vw / 2;
    const ccy = cy + vh / 2;
    const camH = Math.max(vw, vh) * 1.25;
    const V = {
      ccx,
      ccy,
      proj: (x, y, h) => {
        const f = h / (camH - h);
        return [x + (x - ccx) * f, y + (y - ccy) * f];
      },
      persp: (h) => camH / (camH - h),
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x, view.y, view.w, view.h);
    ctx.clip();
    ctx.translate(view.x, view.y);

    // Everything the floodlights and headlights light
    ctx.save();
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    for (const t of this.tilesIn(cx, cy, x1, y1)) ctx.drawImage(t.c, t.x, t.y);
    const vis = this.cars.filter((c) => c.x > cx - 80 && c.x < x1 + 80 && c.y > cy - 80 && c.y < y1 + 80);
    this.smoke.render(ctx, cx, cy, x1, y1);
    this.drawParticles(ctx, cx, cy, x1, y1, false);
    for (const c of vis) this.drawCar(ctx, c);
    const props = this.propsIn(cx - 300, cy - 300, x1 + 300, y1 + 300);
    this.drawProps(ctx, props, V, cx, cy, x1, y1);
    ctx.restore();

    // Dusk: multiply the view by its light map
    const lights = this.lightMaps[k];
    this.lightView(lights, view, z, cx, cy, x1, y1);
    lights.apply(ctx, 0, 0, view.w, view.h);

    // Emissive layer on top of the lighting: lamps, glows, sparks (these bloom)
    ctx.save();
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    ctx.globalCompositeOperation = 'lighter';
    this.drawPads(ctx, cx, cy, x1, y1);
    for (const c of vis) this.drawTrail(ctx, c);
    for (const c of vis) this.drawCarLights(ctx, c);
    this.drawParticles(ctx, cx, cy, x1, y1, true);
    this.drawPropLights(ctx, props, V);
    ctx.restore();

    // Rival name tags in screen space, so they stay legible when zoomed out
    for (const c of vis) if (c !== car) this.nameTag(ctx, c, (c.x - cx) * z, (c.y - cy) * z - 32);
    this.speedLines(ctx, view.w, view.h, car, spd);
    ctx.restore();

    this.drawHud(ctx, view, car, order);
  }

  // Build a view's light map: dusk ambient, the baked floodlight wash, then
  // every nearby car's headlights, tail lights and nitro, plus flying sparks.
  lightView(L, view, z, x0, y0, x1, y1) {
    const g = L.begin(view.w, view.h, AMBIENT);
    g.scale(z, z);
    g.translate(-x0, -y0);
    g.drawImage(this.staticLight, 0, 0, WORLD_W, WORLD_H);
    const { cone } = this.sprites;
    for (const c of this.cars) {
      if (c.x < x0 - 420 || c.x > x1 + 420 || c.y < y0 - 420 || c.y > y1 + 420) continue;
      const fx = Math.cos(c.angle);
      const fy = Math.sin(c.angle);
      g.save();
      g.translate(c.x + fx * 28, c.y + fy * 28);
      g.rotate(c.angle);
      g.globalAlpha = 0.9;
      g.drawImage(cone, -6, -80, 360, 160);
      g.restore();
      L.light(c.x, c.y, 85, '#c9d6ff', 0.3); // a little fill so every car reads in the dark
      const bx = c.x - fx * 36;
      const by = c.y - fy * 36;
      L.light(bx, by, c.braking ? 90 : 46, '#ff3030', c.braking ? 0.9 : 0.45);
      if (c.reverse) L.light(bx, by, 80, '#ffffff', 0.6);
      if (c.boosting) L.light(c.x - fx * 52, c.y - fy * 52, 150, '#4aa8ff', 0.9);
    }
    for (const p of this.particles.list) {
      if (!HOT.has(p.color) || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      L.light(p.x, p.y, 36, '#ffb35c', (0.8 * p.life) / p.max);
    }
  }

  // Sparks and exhaust embers are emissive streaks; dirt and debris are plain.
  drawParticles(ctx, x0, y0, x1, y1, hot) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const p of this.particles.list) {
      if (HOT.has(p.color) !== hot) continue;
      if (p.x < x0 - 20 || p.x > x1 + 20 || p.y < y0 - 20 || p.y > y1 + 20) continue;
      const a = Math.max(0, p.life / p.max);
      if (hot) {
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.9;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6);
      } else {
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawCar(ctx, c) {
    // Soft contact shadow, thrown slightly down-right by the floodlights
    ctx.save();
    ctx.translate(c.x + 3, c.y + 5);
    ctx.rotate(c.angle);
    ctx.drawImage(this.carShadow, -54, -36);
    ctx.restore();

    // Cheap motion blur: faint ghosts trailing along the velocity at high speed
    const blur = clamp((Math.hypot(c.vx, c.vy) - 480) / 380, 0, 1);
    if (blur > 0) {
      for (const n of [2, 1]) {
        ctx.save();
        ctx.globalAlpha = blur * (n === 2 ? 0.1 : 0.2);
        ctx.translate(c.x - c.vx * 0.013 * n, c.y - c.vy * 0.013 * n);
        ctx.rotate(c.angle);
        ctx.drawImage(c.sprite, -38, -20, 76, 40);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#0c0c0f';
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(17, side * 13.5);
      ctx.rotate(c.steer * 0.45);
      ctx.beginPath();
      ctx.roundRect(-6.5, -3.5, 13, 7, 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.drawImage(c.sprite, -38, -20, 76, 40);
    if (c.holdT > 0) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(this.time * 20);
      ctx.strokeStyle = '#ff3b5c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-38, -20, 76, 40, 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Tail-light trails: red ribbons that stretch out with speed.
  drawTrail(ctx, c) {
    const t = c.trail;
    const spd = Math.hypot(c.vx, c.vy);
    if (!t || t.length < 9 || spd < 220) return;
    const a = clamp((spd - 220) / 400, 0, 1) * (c.braking ? 0.9 : 0.45);
    const n = t.length / 3;
    ctx.save();
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const side of [-8, 8]) {
      // Tail light position for a pose: local (-31, side)
      const at = (x, y, ang) => [x - Math.cos(ang) * 31 - Math.sin(ang) * side, y - Math.sin(ang) * 31 + Math.cos(ang) * side];
      const [hx, hy] = at(c.x, c.y, c.angle);
      const [ex, ey] = at(t[(n - 1) * 3], t[(n - 1) * 3 + 1], t[(n - 1) * 3 + 2]);
      const grd = ctx.createLinearGradient(hx, hy, ex, ey);
      grd.addColorStop(0, `rgba(255,40,60,${a})`);
      grd.addColorStop(1, 'rgba(255,40,60,0)');
      ctx.strokeStyle = grd;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      for (let i = 0; i < n; i++) {
        const [x, y] = at(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Additive lights: LED lamps, beam haze, tail/brake lights, nitro flame, draft streaks.
  drawCarLights(ctx, c) {
    const { head, flame, tail } = this.sprites;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(head, 30, -75);
    ctx.globalAlpha = 1;
    drawGlow(ctx, 30.5, -8.5, 10, '#d8ecff', 0.9, 0.3);
    drawGlow(ctx, 30.5, 8.5, 10, '#d8ecff', 0.9, 0.3);
    // Tail light bar: always on, far brighter on the brakes
    ctx.globalAlpha = c.braking ? 1 : c.reverse ? 0.75 : 0.38;
    ctx.drawImage(tail, -40, -16, 16, 32);
    ctx.globalAlpha = 1;
    if (c.braking) {
      drawGlow(ctx, -31, -7, 20, '#ff2a3c', 0.85);
      drawGlow(ctx, -31, 7, 20, '#ff2a3c', 0.85);
    }
    if (c.reverse) drawGlow(ctx, -32, 0, 16, '#ffffff', 0.6);
    if (c.boosting) {
      const len = 0.65 + Math.random() * 0.55;
      ctx.save();
      ctx.translate(-36, 0);
      ctx.scale(len, 0.8 + Math.random() * 0.3);
      ctx.drawImage(flame, -96, -16);
      ctx.restore();
      drawGlow(ctx, -44, 0, 40 + Math.random() * 10, '#3d9bff', 0.75, 0.1);
    }
    if (c.draft > 0.25) {
      ctx.strokeStyle = `rgba(190,230,255,${0.4 * c.draft})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const lane of [-20, -8, 8, 20]) {
        const o = ((this.time * 900 + lane * 37) % 120) - 60;
        ctx.moveTo(o + 10, lane);
        ctx.lineTo(o - 40, lane);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Boost pads: chevrons light up in a wave that flows the way you drive.
  drawPads(ctx, x0, y0, x1, y1) {
    const { chev } = this.sprites;
    for (const p of this.pads) {
      if (p.x < x0 - 100 || p.x > x1 + 100 || p.y < y0 - 100 || p.y > y1 + 100) continue;
      drawGlow(ctx, p.x, p.y, 95, '#38d9ff', 0.3, 0.05);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      for (let q = 0; q < 3; q++) {
        const ph = (((this.time * 1.8 - q * 0.28) % 1) + 1) % 1;
        ctx.globalAlpha = 0.25 + 0.75 * (1 - ph) ** 3;
        ctx.drawImage(chev, -31 + q * 26, -28);
      }
      ctx.restore();
    }
  }

  // Tall scenery, drawn live so it can lean with the camera (2.5D parallax).
  drawProps(ctx, props, V, x0, y0, x1, y1) {
    const trees = props.filter((p) => p.kind === 'tree' && p.x > x0 - p.r - 60 && p.x < x1 + p.r + 60 && p.y > y0 - p.r - 60 && p.y < y1 + p.r + 60);
    // Canopies layer by layer across the whole wood, so neighbours knit together
    for (let L = 0; L < 3; L++) {
      const [hf, rf] = TREE_LAYERS[L];
      for (const t of trees) {
        const h = t.h * hf;
        const [x, y] = V.proj(t.x, t.y, h);
        const r = t.r * rf * V.persp(h);
        const o = L === 2 ? -t.r * 0.12 : 0; // the crown sits toward the light
        ctx.drawImage(this.canopies[t.v][L], x - r + o, y - r + o, r * 2, r * 2);
      }
    }
    for (const p of props) if (p.kind === 'stand') this.drawStand(ctx, p, V);
    for (const p of props) if (p.kind === 'tower') this.drawTower(ctx, p, V);
    for (const p of props) if (p.kind === 'gantry') this.drawGantry(ctx, p, V);
  }

  // Local frame of a grandstand: u runs along it, v across (front = trackside).
  standFrame(s) {
    const ca = Math.cos(s.angle);
    const sa = Math.sin(s.angle);
    return {
      at: (u, v) => [s.x + ca * u - sa * v, s.y + sa * u + ca * v],
      hl: s.len / 2,
      vf: -s.side * 48,
      vb: s.side * 48,
    };
  }

  drawStand(ctx, s, V) {
    const { at, hl, vf, vb } = this.standFrame(s);
    // Raked seating: low at the front, high at the back
    const G = [at(-hl, vf), at(hl, vf), at(hl, vb), at(-hl, vb)];
    const hs = [10, 10, 66, 66];
    const T = G.map(([x, y], i) => V.proj(x, y, hs[i]));
    // Roof columns behind the top row
    ctx.strokeStyle = '#2a2e38';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let u = -hl; u <= hl + 1; u += s.len / 4) {
      const [gx, gy] = at(u, s.side * 52);
      const [rx, ry] = V.proj(gx, gy, 96);
      ctx.moveTo(gx, gy);
      ctx.lineTo(rx, ry);
    }
    ctx.stroke();
    // Side walls facing the camera
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex = (G[i][0] + G[j][0]) / 2;
      const ey = (G[i][1] + G[j][1]) / 2;
      if ((V.ccx - ex) * (ex - s.x) + (V.ccy - ey) * (ey - s.y) <= 0) continue;
      ctx.fillStyle = i === 0 ? '#14161d' : i === 2 ? '#1a1d25' : '#2a2e39';
      quad(ctx, G[i], G[j], T[j], T[i]);
      ctx.fill();
    }
    // Seating and crowd, mapped onto the raked top
    const [ax, ay] = T[0];
    const sw = s.crowd.width;
    const sh = s.crowd.height;
    ctx.save();
    ctx.transform((T[1][0] - ax) / sw, (T[1][1] - ay) / sw, (T[3][0] - ax) / sh, (T[3][1] - ay) / sh, ax, ay);
    ctx.drawImage(s.crowd, 0, 0);
    ctx.restore();
    // Roof canopy over the back rows
    const R = [at(-hl - 6, s.side * 6), at(hl + 6, s.side * 6), at(hl + 6, s.side * 58), at(-hl - 6, s.side * 58)].map(([x, y]) => V.proj(x, y, 96));
    const roof = ctx.createLinearGradient(R[0][0], R[0][1], R[3][0], R[3][1]);
    roof.addColorStop(0, '#596072');
    roof.addColorStop(1, '#3a3f4c');
    ctx.fillStyle = roof;
    quad(ctx, R[0], R[1], R[2], R[3]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let q = 1; q < 8; q++) {
      const f = q / 8;
      ctx.moveTo(R[0][0] + (R[1][0] - R[0][0]) * f, R[0][1] + (R[1][1] - R[0][1]) * f);
      ctx.lineTo(R[3][0] + (R[2][0] - R[3][0]) * f, R[3][1] + (R[2][1] - R[3][1]) * f);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(R[0][0], R[0][1]);
    ctx.lineTo(R[1][0], R[1][1]);
    ctx.stroke();
  }

  drawTower(ctx, tw, V) {
    const [tx, ty] = V.proj(tw.x, tw.y, tw.h);
    // Tapered mast with a lit edge so it reads as round
    ctx.fillStyle = '#4c525f';
    const [nx, ny] = pole(ctx, tw.x, tw.y, tx, ty, 6, 3.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tw.x - nx * 3, tw.y - ny * 3);
    ctx.lineTo(tx - nx * 1.6, ty - ny * 1.6);
    ctx.stroke();
    // Lamp head: a frame of floodlights facing the track
    const s = V.persp(tw.h);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(tw.face);
    ctx.scale(s, s);
    ctx.drawImage(this.sprites.lampFrame, -8, -38, 16, 76);
    ctx.restore();
  }

  drawGantry(ctx, gt, V) {
    const fx = Math.cos(gt.angle) * 9;
    const fy = Math.sin(gt.angle) * 9;
    // Legs
    ctx.fillStyle = '#3d424e';
    for (const [x, y] of [
      [gt.ax, gt.ay],
      [gt.bx, gt.by],
    ]) {
      const [tx, ty] = V.proj(x, y, gt.h);
      pole(ctx, x, y, tx, ty, 7, 5.5);
    }
    // Truss beam across the track
    const A0 = V.proj(gt.ax - fx, gt.ay - fy, gt.h);
    const A1 = V.proj(gt.ax + fx, gt.ay + fy, gt.h);
    const B0 = V.proj(gt.bx - fx, gt.by - fy, gt.h);
    const B1 = V.proj(gt.bx + fx, gt.by + fy, gt.h);
    ctx.fillStyle = '#2c303a';
    quad(ctx, A0, B0, B1, A1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let q = 0; q < 16; q++) {
      const f = q / 16;
      const [p, o] = q % 2 ? [A0, B0] : [A1, B1];
      const [p2, o2] = q % 2 ? [A1, B1] : [A0, B0];
      ctx.moveTo(p[0] + (o[0] - p[0]) * f, p[1] + (o[1] - p[1]) * f);
      ctx.lineTo(p2[0] + (o2[0] - p2[0]) * (f + 1 / 16), p2[1] + (o2[1] - p2[1]) * (f + 1 / 16));
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(A1[0], A1[1]);
    ctx.lineTo(B1[0], B1[1]);
    ctx.stroke();
    // Centre panel holding the start lights
    const s = V.persp(gt.h + 6);
    const [px, py] = V.proj(gt.x, gt.y, gt.h + 6);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(gt.angle + Math.PI / 2);
    ctx.scale(s, s);
    ctx.fillStyle = '#101218';
    ctx.beginPath();
    ctx.roundRect(-96, -16, 192, 32, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2a0f14';
    for (let q = 0; q < 5; q++) {
      ctx.beginPath();
      ctx.arc(-56 + q * 28, 0, 8, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Emissive parts of the scenery: floodlight lamps and shafts, gantry lights,
  // grandstand roof strips and the odd camera flash in the crowd.
  drawPropLights(ctx, props, V) {
    const { beam } = this.sprites;
    for (const p of props) {
      if (p.kind === 'tower') {
        const [tx, ty] = V.proj(p.x, p.y, p.h);
        const bx = p.px - tx;
        const by = p.py - ty;
        const bl = Math.hypot(bx, by);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(Math.atan2(by, bx));
        ctx.globalAlpha = 0.09;
        ctx.drawImage(beam, 0, -bl * 0.3, bl, bl * 0.6);
        ctx.restore();
        const s = V.persp(p.h);
        drawGlow(ctx, tx, ty, 130 * s, SODIUM, 0.5, 0.05);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(p.face);
        ctx.scale(s, s);
        ctx.drawImage(this.sprites.lampFaces, -8, -38, 16, 76);
        ctx.restore();
        drawGlow(ctx, tx, ty, 46 * s, '#fff4e0', 0.8, 0.25);
      } else if (p.kind === 'gantry') {
        const s = V.persp(p.h + 6);
        const [px, py] = V.proj(p.x, p.y, p.h + 6);
        const lit = this.state === 'countdown' ? this.lights : 0;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(p.angle + Math.PI / 2);
        ctx.scale(s, s);
        for (let q = 0; q < lit; q++) {
          ctx.fillStyle = '#ff3344';
          ctx.beginPath();
          ctx.arc(-56 + q * 28, 0, 7, 0, TAU);
          ctx.fill();
          drawGlow(ctx, -56 + q * 28, 0, 34, '#ff1e34', 0.9, 0.12);
        }
        if (this.state === 'race') for (const lx of [-84, 84]) drawGlow(ctx, lx, 0, 10, '#22d36b', 0.9, 0.3);
        ctx.restore();
      } else if (p.kind === 'stand') {
        const { at, hl, vf, vb } = this.standFrame(p);
        const [ax, ay] = V.proj(...at(-hl - 6, p.side * 6), 96);
        const [bx, by] = V.proj(...at(hl + 6, p.side * 6), 96);
        ctx.lineCap = 'round';
        for (const [w, a] of [
          [9, 0.12],
          [2, 0.7],
        ]) {
          ctx.strokeStyle = `rgba(255,240,215,${a})`;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
        if (Math.random() < 0.5) {
          const f = 0.1 + Math.random() * 0.8;
          const [x, y] = V.proj(...at((Math.random() - 0.5) * p.len * 0.9, vf + (vb - vf) * f), 10 + 56 * f);
          drawGlow(ctx, x, y, 7 + Math.random() * 6, '#ffffff', 0.9, 0.4);
        }
      }
    }
  }

  nameTag(ctx, c, x, y) {
    const label = c.name.toUpperCase();
    c.tagW ??= measure(ctx, label, 13, 700, 1) + 22;
    const w = c.tagW;
    ctx.save();
    ctx.fillStyle = 'rgba(8,10,18,0.62)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 20, 4);
    ctx.fill();
    ctx.fillStyle = c.color;
    ctx.fillRect(x - w / 2, y - 10, 3, 20);
    ctx.restore();
    text(ctx, label, x + 2, y + 1, { size: 13, spacing: 1 });
  }

  speedLines(ctx, w, h, car, spd) {
    const k = clamp((spd - MAX * 0.75) / (BOOST_MAX - MAX * 0.75), 0, 1) + (car.boosting ? 0.35 : 0);
    if (k < 0.05) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = car.boosting ? '#96d7ff' : '#dce6ff';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = Math.min(0.32, k * 0.28);
    ctx.beginPath();
    const n = 12 + Math.round(k * 12);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const f0 = 0.72 + Math.random() * 0.3;
      const f1 = f0 + 0.08 + Math.random() * 0.2 * k;
      ctx.moveTo(w / 2 + Math.cos(a) * (w / 2) * f0, h / 2 + Math.sin(a) * (h / 2) * f0);
      ctx.lineTo(w / 2 + Math.cos(a) * (w / 2) * f1, h / 2 + Math.sin(a) * (h / 2) * f1);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawHud(ctx, view, car, order) {
    const k = view.h < 600 ? 0.78 : 1;
    const VW = view.w / k;
    const VH = view.h / k;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(k, k);

    // Timing box: position, lap, lap timer, best lap, gap to the car ahead
    const pos = car.finishTime !== null ? car.place : order.indexOf(car) + 1;
    const x0 = 18;
    const y0 = 16;
    glassPanel(ctx, x0, y0, 316, 124, { accent: car.color });
    const posColor = pos === 1 ? GOLD : '#fff';
    const ps = String(pos);
    const pw = measure(ctx, ps, 64);
    text(ctx, 'POS', x0 + 18, y0 + 20, { size: 12, weight: 600, align: 'left', color: DIM, spacing: 3 });
    text(ctx, ps, x0 + 15, y0 + 60, { size: 64, align: 'left', color: posColor });
    text(ctx, ordinal(pos).slice(ps.length).toUpperCase(), x0 + 18 + pw, y0 + 46, { size: 18, align: 'left', color: posColor });
    text(ctx, `/${this.cars.length}`, x0 + 18 + pw, y0 + 70, { size: 16, align: 'left', color: DIM });
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x0 + 124, y0 + 14, 1, 70);
    const xr = x0 + 140;
    const lap = clamp(Math.floor(car.progress / this.N) + 1, 1, LAPS);
    text(ctx, 'LAP', xr, y0 + 20, { size: 12, weight: 600, align: 'left', color: DIM, spacing: 3 });
    text(ctx, car.finishTime !== null ? 'FINISHED' : `${lap}/${LAPS}`, xr + 38, y0 + 20, { size: 18, align: 'left' });
    const cur = this.state === 'race' && car.finishTime === null ? this.raceTime - car.lapStart : 0;
    text(ctx, formatTime(cur), xr, y0 + 52, { size: 34, align: 'left' });
    text(ctx, 'BEST', xr, y0 + 82, { size: 12, weight: 600, align: 'left', color: DIM, spacing: 3 });
    const purple = car.best !== null && car.best === this.fastest;
    text(ctx, car.best !== null ? formatTime(car.best) : '—', xr + 46, y0 + 82, { size: 17, align: 'left', color: purple ? PURPLE : '#fff' });
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x0 + 12, y0 + 96, 292, 1);
    const gapRow = (who, sign, g) => {
      ctx.fillStyle = who.color;
      ctx.fillRect(x0 + 18, y0 + 103, 3, 15);
      text(ctx, `${sign}  ${who.name.toUpperCase()}`, x0 + 28, y0 + 111, { size: 15, align: 'left', spacing: 1 });
      text(ctx, `${sign === '▲' ? '+' : '−'}${g.toFixed(1)}s`, x0 + 300, y0 + 111, { size: 16, align: 'right', color: who.color });
    };
    if (pos > 1 && car.finishTime === null && this.state === 'race') {
      const ahead = order[pos - 2];
      const g = this.gap(car, ahead);
      if (g !== null) gapRow(ahead, '▲', g);
    } else if (pos === 1 && order[1] && car.finishTime === null && this.state === 'race') {
      const g = this.gap(order[1], car);
      if (g !== null) gapRow(order[1], '▼', g);
    }

    // Driver name, top right
    const label = car.name.toUpperCase();
    const nw = measure(ctx, label, 15, 700, 1.5) + 30;
    glassPanel(ctx, VW - 18 - nw, 16, nw, 30, { r: 6, accent: car.color, accentSide: 'right' });
    text(ctx, label, VW - 18 - nw + 13, 32, { size: 15, align: 'left', spacing: 1.5 });

    // Sector / lap split vs. personal best, tucked under the timing box
    if (car.split) {
      const s = car.split;
      const sy = y0 + 132;
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.t * 3);
      glassPanel(ctx, x0, sy, 316, 40, { r: 8 });
      ctx.fillStyle = 'rgba(240,242,250,0.92)';
      ctx.beginPath();
      ctx.roundRect(x0 + 10, sy + 8, 42, 24, 4);
      ctx.fill();
      text(ctx, s.label, x0 + 31, sy + 21, { size: 15, color: '#0a0b12' });
      text(ctx, formatTime(s.time), x0 + 64, sy + 21, { size: 22, align: 'left' });
      if (s.delta !== null) {
        ctx.fillStyle = s.delta < 0 ? '#16c060' : '#e8b400';
        ctx.beginPath();
        ctx.roundRect(x0 + 214, sy + 7, 92, 26, 4);
        ctx.fill();
        text(ctx, `${s.delta < 0 ? '−' : '+'}${Math.abs(s.delta).toFixed(2)}`, x0 + 260, sy + 21, { size: 18, color: '#081208' });
      }
      ctx.restore();
    }

    // Speedometer + nitro ring
    this.drawGauge(ctx, 110, VH - 104, car);
    let tx = 214;
    const ty = VH - 40;
    if (car.driftT > 0.15) tx += chip(ctx, 'DRIFT · NITRO +', tx, ty, '#ff5fc8') + 8;
    if (car.draft > 0.35) tx += chip(ctx, 'SLIPSTREAM', tx, ty, '#38d9ff') + 8;
    if (car.surface === 'sand') tx += chip(ctx, 'GRAVEL', tx, ty, '#d9b77a') + 8;
    else if (car.surface === 'grass' && Math.abs(car.speed) > 60) tx += chip(ctx, 'GRASS', tx, ty, '#7fd36b') + 8;
    if (car.nitro >= 0.999 && car.finishTime === null) chip(ctx, 'NITRO FULL', tx, ty, GOLD);

    // Personal minimap
    this.drawMinimap(ctx, { x: VW - 236, y: VH - 175, w: 220, h: 159 }, car);

    // Centre messages
    if (car.holdT > 0) {
      band(ctx, VW / 2, VH * 0.3, VW, '#ff3b5c');
      text(ctx, `PENALTY ${car.holdT.toFixed(1)}`, VW / 2, VH * 0.3, { size: 48, color: '#ff3b5c', spacing: 4 });
    } else if (car.note) {
      const n = car.note;
      const a = Math.min(1, n.t * 2.5, (n.dur - n.t) * 8 + 0.2);
      band(ctx, VW / 2, VH * 0.3 + (n.sub ? 18 : 0), VW, n.color, a);
      text(ctx, n.title, VW / 2, VH * 0.3, { size: 52, color: n.color, alpha: a, spacing: 4 });
      if (n.sub) text(ctx, n.sub.toUpperCase(), VW / 2, VH * 0.3 + 44, { size: 19, weight: 600, color: '#e6e9ff', alpha: a, spacing: 2 });
    }
    if (car.wrongT > 1 && car.finishTime === null) {
      const blink = Math.floor(this.time * 4) % 2 ? 1 : 0.4;
      band(ctx, VW / 2, VH / 2 - 118, VW * 0.8, '#ff3b5c', 0.9);
      text(ctx, 'WRONG WAY', VW / 2, VH / 2 - 90, { size: 46, color: '#ff3b5c', alpha: blink, spacing: 5 });
      const p = this.pts[car.idx];
      ctx.save();
      ctx.translate(VW / 2, VH / 2 - 142);
      ctx.rotate(p.angle);
      ctx.fillStyle = '#ff3b5c';
      ctx.globalAlpha = blink;
      ctx.beginPath();
      ctx.moveTo(30, 0);
      ctx.lineTo(-10, -24);
      ctx.lineTo(-10, -10);
      ctx.lineTo(-30, -10);
      ctx.lineTo(-30, 10);
      ctx.lineTo(-10, 10);
      ctx.lineTo(-10, 24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (car.finishTime !== null) {
      const color = car.place === 1 ? GOLD : '#ffffff';
      band(ctx, VW / 2, VH / 2 - 36, VW, color);
      text(ctx, `${ordinal(car.place).toUpperCase()} PLACE`, VW / 2, VH / 2 - 56, { size: 56, color, spacing: 5 });
      text(ctx, formatTime(car.finishTime), VW / 2, VH / 2, { size: 26, color: DIM, spacing: 2 });
    }
    ctx.restore();
  }

  drawGauge(ctx, x, y, car) {
    const spd = Math.max(0, car.speed);
    const a0 = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const boostF = MAX / BOOST_MAX;
    ctx.save();
    // Glass dial
    const bg = ctx.createRadialGradient(x, y - 30, 8, x, y, 84);
    bg.addColorStop(0, 'rgba(30,34,54,0.8)');
    bg.addColorStop(1, 'rgba(6,7,14,0.84)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(x, y, 84, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 83.5, 0, TAU);
    ctx.stroke();
    // Tick ring; the boost-only band past normal top speed is tinted cyan
    ctx.lineWidth = 1.5;
    for (const boost of [false, true]) {
      ctx.strokeStyle = boost ? 'rgba(56,217,255,0.75)' : 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const f = i / 40;
        if (f > boostF + 1e-6 !== boost) continue;
        const a = a0 + sweep * f;
        const r0 = i % 5 === 0 ? 70 : 74;
        ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
        ctx.lineTo(x + Math.cos(a) * 78, y + Math.sin(a) * 78);
      }
      ctx.stroke();
    }
    // Speed arc with a soft additive glow (it blooms in post)
    const f = clamp(spd / BOOST_MAX, 0, 1);
    const col = car.boosting ? '#38d9ff' : f > boostF * 0.93 ? '#ff8a2b' : '#1fd1a5';
    ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.arc(x, y, 62, a0, a0 + sweep);
    ctx.stroke();
    if (f > 0.005) {
      const a1 = a0 + sweep * f;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(col, 0.22);
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.arc(x, y, 62, a0, a1);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = col;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(x, y, 62, a0, a1);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 62, a0, a1);
      ctx.stroke();
      drawGlow(ctx, x + Math.cos(a1) * 62, y + Math.sin(a1) * 62, 20, col, 0.9, 0.25);
    }
    // Nitro: segmented inner arc
    const seg = (sweep * 48) / 12;
    const ncol = car.nitro >= 0.999 ? GOLD : car.nitroOn ? '#ffffff' : PURPLE;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 5;
    ctx.setLineDash([seg - 2.5, 2.5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(x, y, 48, a0, a0 + sweep);
    ctx.stroke();
    if (car.nitro > 0.005) {
      ctx.strokeStyle = ncol;
      ctx.beginPath();
      ctx.arc(x, y, 48, a0, a0 + sweep * car.nitro);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    text(ctx, String(Math.round(spd / 3)), x, y - 6, { size: 50 });
    text(ctx, 'KM/H', x, y + 24, { size: 12, weight: 600, color: DIM, spacing: 3 });
    text(ctx, 'NITRO', x, y + 58, { size: 11, color: ncol, spacing: 3 });
  }

  drawMinimap(ctx, box, focus = null) {
    glassPanel(ctx, box.x - 10, box.y - 10, box.w + 20, box.h + 20, { r: 10 });
    ctx.drawImage(this.mini, box.x, box.y, box.w, box.h);
    // Start / finish: a chequered tick across the track
    const s0 = this.pts[0];
    ctx.save();
    ctx.translate(box.x + (s0.x / WORLD_W) * box.w, box.y + (s0.y / WORLD_H) * box.h);
    ctx.rotate(s0.angle);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-2, -7, 4, 14);
    ctx.fillStyle = '#111';
    for (let q = 0; q < 4; q++) ctx.fillRect(q % 2 ? 0 : -2, -7 + q * 3.5, 2, 3.5);
    ctx.restore();
    for (const c of [...this.cars].reverse()) {
      if (c === focus) continue;
      ctx.fillStyle = c.color;
      ctx.strokeStyle = 'rgba(5,4,13,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(box.x + (c.x / WORLD_W) * box.w, box.y + (c.y / WORLD_H) * box.h, 4.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    if (focus) {
      // You: a heading arrow with a soft halo
      const x = box.x + (focus.x / WORLD_W) * box.w;
      const y = box.y + (focus.y / WORLD_H) * box.h;
      drawGlow(ctx, x, y, 18, focus.color, 0.6, 0.2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(focus.angle);
      ctx.fillStyle = focus.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-5.5, -6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-5.5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Timing tower in the style of a modern F1 broadcast.
  drawStandings(ctx, order, x, y0) {
    const w = 260;
    const rowH = 30;
    const head = 40;
    glassPanel(ctx, x, y0, w, head + order.length * rowH + 8, { r: 8, alpha: 0.7 });
    const lap = clamp(Math.floor(order[0].progress / this.N) + 1, 1, LAPS);
    text(ctx, 'LAP', x + 14, y0 + 21, { size: 12, weight: 600, align: 'left', color: DIM, spacing: 3 });
    text(ctx, `${lap}/${LAPS}`, x + 50, y0 + 21, { size: 20, align: 'left' });
    text(ctx, 'LIVE', x + w - 14, y0 + 21, { size: 12, weight: 600, align: 'right', color: DIM, spacing: 3 });
    ctx.fillStyle = '#ff3b5c';
    ctx.beginPath();
    ctx.arc(x + w - 62, y0 + 21, 3.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x + 10, y0 + head - 2, w - 20, 1);
    order.forEach((c, k) => {
      const y = y0 + head + k * rowH;
      const cy = y + rowH / 2;
      if (k % 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(x + 4, y, w - 8, rowH);
      }
      ctx.fillStyle = k === 0 ? GOLD : '#eef0f8';
      ctx.beginPath();
      ctx.roundRect(x + 10, y + 5, 26, rowH - 10, 3);
      ctx.fill();
      text(ctx, String(k + 1), x + 23, cy + 1, { size: 16, color: '#0a0b12' });
      ctx.fillStyle = c.color;
      ctx.fillRect(x + 44, y + 7, 3, rowH - 14);
      text(ctx, c.name.toUpperCase(), x + 56, cy + 1, { size: 16, align: 'left', spacing: 1 });
      const g = k > 0 && c.finishTime === null && this.state === 'race' ? this.gap(c, order[0]) : null;
      if (c.finishTime !== null) text(ctx, 'FINISH', x + w - 14, cy + 1, { size: 13, weight: 600, align: 'right', color: k === 0 ? GOLD : DIM, spacing: 2 });
      else if (k === 0 && this.state === 'race') text(ctx, 'LEADER', x + w - 14, cy + 1, { size: 13, weight: 600, align: 'right', color: DIM, spacing: 2 });
      else if (g !== null) text(ctx, `+${g.toFixed(1)}`, x + w - 14, cy + 1, { size: 16, align: 'right', color: '#e6e9ff' });
    });
  }

  // Fourth quadrant in 3-player games: big map + timing tower.
  drawBoard(ctx, order) {
    const x = W / 2;
    const y = H / 2;
    const bg = ctx.createLinearGradient(x, y, W, H);
    bg.addColorStop(0, '#0d1222');
    bg.addColorStop(1, '#05060d');
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, W / 2, H / 2);
    ctx.strokeStyle = 'rgba(130,160,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = x + 40; gx < W; gx += 40) {
      ctx.moveTo(gx + 0.5, y);
      ctx.lineTo(gx + 0.5, H);
    }
    for (let gy = y + 40; gy < H; gy += 40) {
      ctx.moveTo(x, gy + 0.5);
      ctx.lineTo(W, gy + 0.5);
    }
    ctx.stroke();
    text(ctx, 'LIVE TIMING', x + 50, y + 40, { size: 20, align: 'left', spacing: 5 });
    ctx.fillStyle = '#1fd1a5';
    ctx.fillRect(x + 50, y + 56, 40, 2);
    this.drawMinimap(ctx, { x: x + 50, y: y + 90, w: 360, h: 260 });
    this.drawStandings(ctx, order, x + 470, y + 80);
  }

  // Modern F1-style start lights: five units hanging from a carbon beam.
  drawLights(ctx, fade = 1) {
    const cx = W / 2;
    const cy = H / 2;
    ctx.save();
    ctx.globalAlpha = fade;
    const beam = ctx.createLinearGradient(0, cy - 100, 0, cy - 84);
    beam.addColorStop(0, '#2a2d36');
    beam.addColorStop(1, '#0d0e13');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.roundRect(cx - 300, cy - 100, 600, 16, 4);
    ctx.fill();
    for (let k = 0; k < 5; k++) {
      const on = k < this.lights;
      const x = cx - 220 + k * 110;
      const hg = ctx.createLinearGradient(x - 38, 0, x + 38, 0);
      hg.addColorStop(0, '#121318');
      hg.addColorStop(0.5, '#23252d');
      hg.addColorStop(1, '#0d0e12');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.roundRect(x - 38, cy - 88, 76, 176, 14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
      for (const dy of [-38, 38]) {
        const ly = cy + dy;
        ctx.fillStyle = '#07080b';
        ctx.beginPath();
        ctx.arc(x, ly, 28, 0, TAU);
        ctx.fill();
        if (on) drawGlow(ctx, x, ly, 120, '#ff1e34', 0.9, 0.1);
        const lg = ctx.createRadialGradient(x - 6, ly - 7, 2, x, ly, 23);
        lg.addColorStop(0, on ? '#ffd6da' : '#3a1a20');
        lg.addColorStop(0.35, on ? '#ff4054' : '#24100f');
        lg.addColorStop(1, on ? '#c30f24' : '#16090c');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(x, ly, 23, 0, TAU);
        ctx.fill();
        // LED matrix over the lens
        ctx.fillStyle = on ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.04)';
        for (let gy = -16; gy <= 16; gy += 8) {
          for (let gx = -16; gx <= 16; gx += 8) if (gx * gx + gy * gy < 400) ctx.fillRect(x + gx - 1.2, ly + gy - 1.2, 2.4, 2.4);
        }
      }
    }
    ctx.restore();
    if (this.state === 'countdown') {
      text(ctx, 'HANDS OFF THE STICK  ·  GO WHEN THE LIGHTS GO OUT', cx, cy + 124, { size: 18, weight: 600, color: 'rgba(230,234,255,0.88)', spacing: 3 });
    }
  }
}

export default {
  id: 'racing-rivals',
  title: 'Racing Rivals',
  art: 'racing',
  genre: 'Racing',
  accent: '#1fd1a5',
  tagline: 'Wheel-to-wheel split-screen racing under the floodlights. Drift, draft and dive-bomb your way to the flag.',
  minPlayers: 2,
  maxPlayers: 4,
  cpu: true,
  post: POST,
  controls:{ move: 'Point to steer (point back to reverse)', a: 'Nitro', b: 'Brake / drift' },
  howTo: [
    'Five red lights, then GO when they go out — move early and you get a stall penalty, react fast for a perfect launch.',
    'Push the stick the way you want to go. Tyres have limited grip: carry too much speed and the car slides wide.',
    'Hold B to brake; flick B while turning at speed to drift. Drifting refills nitro — hold A to burn it.',
    'Tuck in behind a rival for a slipstream boost. Curbs rumble, grass and gravel slow you, tyre walls bite back.',
    `Sector splits show you vs. your best lap. First across the line after ${LAPS} laps wins.`,
  ],
  create: (opts) => new RacingRivals(opts),
};
