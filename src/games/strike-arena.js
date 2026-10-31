import {
  H,
  IDLE,
  Particles,
  TAU,
  W,
  angleDiff,
  banner,
  circleRect,
  clamp,
  collideRects,
  dist,
  lineBlocked,
  makeCanvas,
  pick,
  pointInRect,
  rand,
  text,
} from './engine/util.js';
import { HUD_FONT, LightMap, drawGlow, glassPanel, glowSprite, meter } from './engine/fx.js';

/*
 * Strike Arena — top-down arena shooter. Last one standing wins the round,
 * first to 3 rounds wins the match. Weapons have magazines and reload,
 * bullets ricochet, crates break and red barrels explode.
 */

const TOP = 70; // HUD strip
const WINS_NEEDED = 3;
const R = 18;
const SPEED = 280;
const DASH_SPEED = 920;

const WALLS = [
  // Border
  { x: 0, y: TOP, w: W, h: 24 },
  { x: 0, y: H - 24, w: W, h: 24 },
  { x: 0, y: TOP, w: 24, h: H - TOP },
  { x: W - 24, y: TOP, w: 24, h: H - TOP },
  // Corner L-shapes
  { x: 330, y: 200, w: 40, h: 180 },
  { x: 330, y: 200, w: 150, h: 40 },
  { x: 1230, y: 200, w: 40, h: 180 },
  { x: 1120, y: 200, w: 150, h: 40 },
  { x: 330, y: 566, w: 40, h: 180 },
  { x: 330, y: 706, w: 150, h: 40 },
  { x: 1230, y: 566, w: 40, h: 180 },
  { x: 1120, y: 706, w: 150, h: 40 },
  // Mid lanes
  { x: 700, y: 196, w: 200, h: 36 },
  { x: 700, y: 714, w: 200, h: 36 },
  { x: 130, y: 440, w: 110, h: 66 },
  { x: 1360, y: 440, w: 110, h: 66 },
  // Centre
  { x: 770, y: 418, w: 60, h: 110 },
  { x: 560, y: 443, w: 60, h: 60 },
  { x: 980, y: 443, w: 60, h: 60 },
];

const SPAWNS = [
  [90, 140],
  [1510, 830],
  [1510, 140],
  [90, 830],
  [800, 140],
  [800, 830],
  [290, 473],
  [1310, 473],
];

// Props are rebuilt every round: crates soak bullets, barrels explode.
const CRATE = 44;
const CRATE_HP = 70;
const BARREL_R = 17;
const BARREL_HP = 30;
const BLAST_R = 150;
const CRATE_SPOTS = [
  [425, 305],
  [1175, 305],
  [425, 641],
  [1175, 641],
  [660, 330],
  [940, 616],
  [200, 640],
  [1400, 306],
];
const BARREL_SPOTS = [
  [690, 610],
  [910, 336],
  [180, 300],
  [1420, 646],
  [800, 290],
  [800, 656],
];

const WEAPONS = {
  rifle: { label: 'RIFLE', dmg: 17, rate: 0.16, mag: 14, reserve: Infinity, reload: 1.15, speed: 1000, life: 1.1, spread: 0.035, bloom: 0.03, maxBloom: 0.16, pellets: 1, knock: 90, recoil: 40, bounces: 1, len: 26, width: 6, shake: 0, sound: 'shoot', color: '#ffe8a3' },
  smg: { label: 'SMG', dmg: 11, rate: 0.07, mag: 30, reserve: 60, reload: 1.3, speed: 960, life: 0.9, spread: 0.06, bloom: 0.018, maxBloom: 0.24, pellets: 1, knock: 50, recoil: 25, bounces: 1, len: 20, width: 7, shake: 0, sound: 'shoot', color: '#fde68a' },
  shotgun: { label: 'SHOTGUN', dmg: 12, rate: 0.7, mag: 4, reserve: 8, reload: 1.5, speed: 900, life: 0.38, spread: 0.32, bloom: 0, maxBloom: 0, pellets: 7, knock: 70, recoil: 260, bounces: 0, len: 30, width: 8, shake: 5, sound: 'kick', color: '#fdba74' },
  sniper: { label: 'SNIPER', dmg: 85, rate: 1.0, mag: 3, reserve: 4, reload: 1.7, speed: 2400, life: 0.8, spread: 0.004, bloom: 0, maxBloom: 0, pellets: 1, knock: 420, recoil: 300, bounces: 0, pierce: true, len: 42, width: 5, shake: 6, sound: 'crash', color: '#a5f3fc' },
};
for (const [id, w] of Object.entries(WEAPONS)) w.id = id;

const PICKUPS = {
  health: { color: '#22d36b', label: '+', weight: 3 },
  shield: { color: '#22d3ee', label: '◆', weight: 2 },
  smg: { color: '#facc15', weapon: true, weight: 2 },
  shotgun: { color: '#fb923c', weapon: true, weight: 2 },
  sniper: { color: '#a78bfa', weapon: true, weight: 1 },
};

function rollPickup() {
  const keys = Object.keys(PICKUPS);
  let t = rand(keys.reduce((s, k) => s + PICKUPS[k].weight, 0));
  for (const k of keys) {
    t -= PICKUPS[k].weight;
    if (t <= 0) return k;
  }
  return 'health';
}

function nearest(p, list) {
  let best = null;
  let bd = Infinity;
  for (const k of list) {
    const d = dist(p.x, p.y, k.x, k.y);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/* ------------------------------------------------------------ Colour */
function hexRgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return [200, 200, 200];
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;
function shade(hex, amt) {
  const f = (v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt);
  return `rgb(${hexRgb(hex).map(f).join(',')})`;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function hexPath(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6;
    g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
}

/* ------------------------------------------------------- Art direction */
// Modern tactical look: dark teal ambient, warm overhead lamps, teal neon trim.
const CX = W / 2;
const CY = (H + TOP) / 2;
const ART = 2; // sprite supersampling so rotated art stays crisp up to 1440p
const LAYER = 1.5; // resolution of the cached wall layers
const LIGHT_SCALE = 0.4;
const NEON = '#3ee6d0';
const LAMP = '#ffd29a';
const AMBIENT = '#435468';
const LAMPS = [
  [400, 290],
  [1200, 290],
  [400, 660],
  [1200, 660],
  [800, CY],
  [120, CY],
  [1480, CY],
];
const FLICKER = 3; // this lamp is on its last legs
const HAZARD = [12, 13, 16]; // walls with painted hazard ends

// 2.5D: the camera hangs above the arena centre, so anything with height is
// pushed outward from the centre in proportion to its height.
const WALL_F = 0.034;
const CRATE_F = 0.018;
const BARREL_F = 0.02;
const liftX = (x, f) => x + (x - CX) * f;
const liftY = (y, f) => y + (y - CY) * f;

// Side faces darken the further they turn from the (top-left) key light.
const WALL_SIDE = '#4a5361';
const SIDE_TONE = { n: 0, w: -0.14, e: -0.3, s: -0.4 };
const CRATE_SIDES = { n: '#6e4826', w: '#5c3b1f', e: '#4b3019', s: '#3f2815' };

// Particle colours that are solid matter rather than sparks.
const DEBRIS = new Set(['#b98446', '#5e3b1b', '#d6a46a']);
const DUST = '#9ca3af';

const POST = {
  bloom: 0.75,
  threshold: 0.62,
  knee: 0.3,
  exposure: 1.1,
  contrast: 1.08,
  saturation: 1.08,
  shoulder: 0.76,
  vignette: 0.4,
  aberration: 0.0015,
  grain: 0.035,
  shadows: [-0.01, 0.035, 0.05],
  highlights: [0.06, 0.025, -0.03],
};

function subtract(spans, lo, hi) {
  const out = [];
  for (const [a, b] of spans) {
    if (hi <= a || lo >= b) out.push([a, b]);
    else {
      if (lo > a) out.push([a, lo]);
      if (hi < b) out.push([hi, b]);
    }
  }
  return out;
}

// Parts of one edge of a wall that are not buried inside another wall.
function openSpans(w, side) {
  const horizontal = side === 'n' || side === 's';
  const at = side === 'n' ? w.y : side === 's' ? w.y + w.h : side === 'w' ? w.x : w.x + w.w;
  let spans = horizontal ? [[w.x, w.x + w.w]] : [[w.y, w.y + w.h]];
  for (const o of WALLS) {
    if (o === w) continue;
    if (horizontal ? o.y < at && at < o.y + o.h : o.x < at && at < o.x + o.w) {
      spans = horizontal ? subtract(spans, o.x, o.x + o.w) : subtract(spans, o.y, o.y + o.h);
    }
  }
  return spans.filter(([a, b]) => b - a > 0.5).map(([a, b]) => (horizontal ? { side, ax: a, ay: at, bx: b, by: at } : { side, ax: at, ay: a, bx: at, by: b }));
}

// A side face is visible when the camera (arena centre) lies beyond it.
function facesCamera(r, side) {
  return side === 'n' ? CY < r.y : side === 's' ? CY > r.y + r.h : side === 'w' ? CX < r.x : CX > r.x + r.w;
}

function quad(g, ax, ay, bx, by, cx, cy, dx, dy) {
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  g.lineTo(cx, cy);
  g.lineTo(dx, dy);
  g.closePath();
}

// Side faces of an extruded rect that face the camera (used for crates).
function drawBoxSides(g, x, y, w, h, f, tones) {
  const x1 = x + w;
  const y1 = y + h;
  const lx0 = liftX(x, f);
  const ly0 = liftY(y, f);
  const lx1 = liftX(x1, f);
  const ly1 = liftY(y1, f);
  const r = { x, y, w, h };
  for (const side of ['n', 's', 'w', 'e']) {
    if (!facesCamera(r, side)) continue;
    g.fillStyle = tones[side];
    if (side === 'n') quad(g, x, y, x1, y, lx1, ly0, lx0, ly0);
    else if (side === 's') quad(g, x, y1, x1, y1, lx1, ly1, lx0, ly1);
    else if (side === 'w') quad(g, x, y, x, y1, lx0, ly1, lx0, ly0);
    else quad(g, x1, y, x1, y1, lx1, ly1, lx1, ly0);
    g.fill();
  }
}

// Tracer body: a sliver from the bullet head tapering to the tail.
function taper(g, hx, hy, tx, ty, px, py) {
  g.beginPath();
  g.moveTo(hx + px, hy + py);
  g.lineTo(tx, ty);
  g.lineTo(hx - px, hy - py);
  g.closePath();
  g.fill();
}

/* ----------------------------------------------------- Pre-rendered art */
function blob(inner, outer) {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

// Solid-colour copy of a sprite's silhouette.
function tint(src, color) {
  const c = makeCanvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// Soft blurred footprint for a box, cast slightly down-right.
function buildBoxShadow(w, h) {
  const P = 24;
  const c = makeCanvas(w + P * 2, h + P * 2);
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(0,0,0,0.7)';
  g.shadowBlur = 14;
  g.shadowOffsetX = 10000;
  g.fillStyle = '#000';
  g.fillRect(P - 10000, P, w, h);
  return c;
}

function buildSmoke() {
  const S = 96;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  for (let i = 0; i < 9; i++) {
    const a = rand(TAU);
    const d = rand(18);
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const r = rand(16, 30);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(150,158,170,0.3)');
    grad.addColorStop(1, 'rgba(150,158,170,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  return c;
}

// Diamond-plate tread, used for the metal spawn pads.
function treadPattern(g) {
  const p = makeCanvas(12, 12);
  const t = p.getContext('2d');
  t.lineCap = 'round';
  t.lineWidth = 1.6;
  const strokes = [
    [2, 5, 5, 2],
    [7, 10, 10, 7],
    [7, 2, 10, 5],
    [2, 7, 5, 10],
  ];
  for (const [color, o] of [
    ['rgba(0,0,0,0.35)', 0.8],
    ['rgba(255,255,255,0.13)', 0],
  ]) {
    t.strokeStyle = color;
    t.beginPath();
    for (const [a, b, c, d] of strokes) {
      t.moveTo(a + o, b + o);
      t.lineTo(c + o, d + o);
    }
    t.stroke();
  }
  return g.createPattern(p, 'repeat');
}

// Static floor: concrete slabs, metal spawn pads, grates, paint, wet patches
// and the soft shadows the walls throw. Lighting comes later from the light map,
// so everything here is painted at "fully lit" brightness.
function buildFloor() {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const band = g.createLinearGradient(0, 0, 0, TOP);
  band.addColorStop(0, '#05060a');
  band.addColorStop(1, '#0c1017');
  g.fillStyle = band;
  g.fillRect(0, 0, W, TOP);

  // Poured concrete slabs with bevelled expansion joints
  const T = 80;
  for (let y = TOP; y < H; y += T) {
    for (let x = 0; x < W; x += T) {
      const v = rand(-6, 6);
      const s = g.createLinearGradient(x, y, x + T, y + T);
      s.addColorStop(0, `rgb(${62 + v},${67 + v},${75 + v})`);
      s.addColorStop(1, `rgb(${52 + v},${57 + v},${65 + v})`);
      g.fillStyle = s;
      g.fillRect(x, y, T, T);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(x, y, T, 1.5);
      g.fillRect(x, y, 1.5, T);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(x + 1.5, y + 1.5, T - 1.5, 1);
      g.fillRect(x + 1.5, y + 1.5, 1, T - 1.5);
    }
  }
  // Mottling, grit and hairline cracks
  for (let i = 0; i < 70; i++) {
    const x = rand(W);
    const y = rand(TOP, H);
    const r = rand(30, 90);
    const m = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = Math.random() < 0.6 ? '0,0,0' : '255,255,255';
    m.addColorStop(0, `rgba(${tone},0.07)`);
    m.addColorStop(1, `rgba(${tone},0)`);
    g.fillStyle = m;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 12000; i++) {
    g.fillStyle = Math.random() < 0.55 ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rand(W), rand(TOP, H), rand(0.8, 2.2), rand(0.8, 2.2));
  }
  g.strokeStyle = 'rgba(10,12,16,0.45)';
  g.lineWidth = 1;
  for (let i = 0; i < 34; i++) {
    let x = rand(W);
    let y = rand(TOP, H);
    let a = rand(TAU);
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      a += rand(-0.7, 0.7);
      x += Math.cos(a) * rand(6, 16);
      y += Math.sin(a) * rand(6, 16);
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // Oil and grime
  for (let i = 0; i < 26; i++) {
    const x = rand(W);
    const y = rand(TOP, H);
    const r = rand(20, 70);
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, 'rgba(6,7,10,0.38)');
    s.addColorStop(1, 'rgba(6,7,10,0)');
    g.fillStyle = s;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Safety line around the arena and the faded centre circle
  g.strokeStyle = 'rgba(230,180,40,0.2)';
  g.lineWidth = 4;
  g.setLineDash([28, 14]);
  g.strokeRect(62, TOP + 62, W - 124, H - TOP - 124);
  g.lineWidth = 3;
  g.setLineDash([14, 14]);
  g.beginPath();
  g.arc(CX, CY, 190, 0, TAU);
  g.stroke();
  g.setLineDash([]);
  g.lineWidth = 6;
  g.beginPath();
  g.arc(CX, CY, 150, 0, TAU);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 2;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU + Math.PI / 4;
    g.beginPath();
    g.moveTo(CX + Math.cos(a) * 160, CY + Math.sin(a) * 160);
    g.lineTo(CX + Math.cos(a) * 182, CY + Math.sin(a) * 182);
    g.stroke();
  }

  // Drainage grates
  for (const [x, y] of [
    [250, 225],
    [1350, 225],
    [250, 745],
    [1350, 745],
  ]) {
    g.fillStyle = '#101318';
    g.fillRect(x - 40, y - 12, 80, 24);
    for (let k = -36; k <= 34; k += 5) {
      g.fillStyle = '#3c434e';
      g.fillRect(x + k, y - 10, 2.5, 20);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + k, y - 10, 1, 20);
    }
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = 1;
    g.strokeRect(x - 40.5, y - 12.5, 81, 25);
  }

  // Metal spawn pads with tread plate, a painted ring and stencilled numbers
  const tread = treadPattern(g);
  SPAWNS.forEach(([x, y], i) => {
    const s = g.createLinearGradient(x - 36, y - 36, x + 36, y + 36);
    s.addColorStop(0, '#565d69');
    s.addColorStop(1, '#3a404a');
    g.fillStyle = s;
    g.fillRect(x - 36, y - 36, 72, 72);
    g.fillStyle = tread;
    g.fillRect(x - 36, y - 36, 72, 72);
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 2;
    g.strokeRect(x - 36, y - 36, 72, 72);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.strokeRect(x - 34.5, y - 34.5, 69, 69);
    g.fillStyle = 'rgba(255,255,255,0.3)';
    for (const [bx, by] of [
      [-31, -31],
      [30, -31],
      [-31, 30],
      [30, 30],
    ])
      g.fillRect(x + bx, y + by, 1.6, 1.6);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 26, 0, TAU);
    g.stroke();
    g.beginPath();
    g.moveTo(x - 9, y);
    g.lineTo(x + 9, y);
    g.moveTo(x, y - 9);
    g.lineTo(x, y + 9);
    g.stroke();
    g.font = `700 13px "${HUD_FONT}", system-ui, sans-serif`;
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(240,200,80,0.35)';
    g.fillText(`0${i + 1}`, x + 32, y + 32);
  });

  // Wet patches: darker, glossier concrete that mirrors the lamps.
  const wet = makeCanvas(W, H);
  const wg = wet.getContext('2d');
  wg.fillStyle = '#0e141c';
  for (let i = 0; i < 14; i++) {
    const x = rand(80, W - 80);
    const y = rand(TOP + 80, H - 80);
    for (let j = 0; j < 6; j++) {
      wg.beginPath();
      wg.ellipse(x + rand(-40, 40), y + rand(-20, 20), rand(18, 50), rand(10, 26), rand(TAU), 0, TAU);
      wg.fill();
    }
  }
  wg.globalCompositeOperation = 'source-atop';
  for (const [x, y] of LAMPS) {
    const l = wg.createRadialGradient(x, y, 0, x, y, 230);
    l.addColorStop(0, 'rgba(255,214,160,0.7)');
    l.addColorStop(1, 'rgba(255,214,160,0)');
    wg.fillStyle = l;
    wg.fillRect(x - 230, y - 230, 460, 460);
  }
  const sheen = wg.createLinearGradient(0, TOP, W, H);
  sheen.addColorStop(0, 'rgba(120,180,210,0.14)');
  sheen.addColorStop(1, 'rgba(120,180,210,0.04)');
  wg.fillStyle = sheen;
  wg.fillRect(0, 0, W, H);
  g.globalAlpha = 0.5;
  g.drawImage(wet, 0, 0);
  g.globalAlpha = 1;

  // Walls throw a broad soft shadow plus tight contact occlusion.
  g.save();
  g.fillStyle = '#000';
  for (const w of WALLS) {
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 30;
    g.shadowOffsetX = 10000 + 10;
    g.shadowOffsetY = 16;
    g.fillRect(w.x - 10000, w.y, w.w, w.h);
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = 10;
    g.shadowOffsetX = 10000;
    g.shadowOffsetY = 0;
    g.fillRect(w.x - 10000, w.y, w.w, w.h);
  }
  g.restore();
  return c;
}

function hazard(g, x, y, w, h) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = 'rgba(214,164,32,0.8)';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(18,18,20,0.85)';
  for (let k = -h; k < w + h; k += 12) {
    g.beginPath();
    g.moveTo(x + k, y + h);
    g.lineTo(x + k + 6, y + h);
    g.lineTo(x + k + 6 + h, y);
    g.lineTo(x + k + h, y);
    g.closePath();
    g.fill();
  }
  // Scuffed paint
  for (let i = 0; i < (w * h) / 12; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(40,42,46,0.45)' : 'rgba(255,255,255,0.06)';
    g.fillRect(x + rand(w), y + rand(h), rand(1, 3), rand(1, 2));
  }
  g.restore();
}

// Wall side face: dark at the floor (occlusion), lit toward the lip, with ribs.
function drawWallSide(g, f) {
  const lax = liftX(f.ax, WALL_F);
  const lay = liftY(f.ay, WALL_F);
  const lbx = liftX(f.bx, WALL_F);
  const lby = liftY(f.by, WALL_F);
  const mx = (f.ax + f.bx) / 2;
  const my = (f.ay + f.by) / 2;
  const lmx = (lax + lbx) / 2;
  const lmy = (lay + lby) / 2;
  if (Math.hypot(lmx - mx, lmy - my) < 0.5) return;
  const tone = SIDE_TONE[f.side];
  const grad = g.createLinearGradient(mx, my, lmx, lmy);
  grad.addColorStop(0, '#12161d');
  grad.addColorStop(0.65, shade(WALL_SIDE, tone - 0.1));
  grad.addColorStop(1, shade(WALL_SIDE, tone));
  g.fillStyle = grad;
  quad(g, f.ax, f.ay, f.bx, f.by, lbx, lby, lax, lay);
  g.fill();
  const len = Math.hypot(f.bx - f.ax, f.by - f.ay);
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = 1;
  g.beginPath();
  for (let d = 26; d < len - 4; d += 26) {
    const t = d / len;
    g.moveTo(f.ax + (f.bx - f.ax) * t, f.ay + (f.by - f.ay) * t);
    g.lineTo(lax + (lbx - lax) * t, lay + (lby - lay) * t);
  }
  g.stroke();
  // Recess that holds the light strip, just under the lip.
  const s = 0.8;
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(f.ax + (lax - f.ax) * s, f.ay + (lay - f.ay) * s);
  g.lineTo(f.bx + (lbx - f.bx) * s, f.by + (lby - f.by) * s);
  g.stroke();
}

function drawWallCap(g, w, i) {
  const x0 = liftX(w.x, WALL_F);
  const y0 = liftY(w.y, WALL_F);
  const cw = liftX(w.x + w.w, WALL_F) - x0;
  const ch = liftY(w.y + w.h, WALL_F) - y0;
  // Brushed steel speckle
  for (let k = 0; k < (cw * ch) / 30; k++) {
    g.fillStyle = Math.random() < 0.6 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.05)';
    g.fillRect(x0 + rand(cw), y0 + rand(ch), rand(0.8, 2), rand(0.8, 2));
  }
  // Engraved inner panel
  if (cw > 24 && ch > 24) {
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,0.38)';
    g.strokeRect(x0 + 5.5, y0 + 5.5, cw - 11, ch - 11);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.strokeRect(x0 + 6.5, y0 + 6.5, cw - 11, ch - 11);
  }
  // Plate seams across the long axis
  const horizontal = cw >= ch;
  const span = horizontal ? cw : ch;
  for (let k = 48; k < span - 8; k += 48) {
    for (const [color, o] of [
      ['rgba(0,0,0,0.4)', 0],
      ['rgba(255,255,255,0.06)', 1],
    ]) {
      g.fillStyle = color;
      if (horizontal) g.fillRect(x0 + k + o, y0, 1, ch);
      else g.fillRect(x0, y0 + k + o, cw, 1);
    }
  }
  if (HAZARD.includes(i)) {
    if (horizontal) {
      hazard(g, x0 + 4, y0 + 4, 16, ch - 8);
      hazard(g, x0 + cw - 20, y0 + 4, 16, ch - 8);
    } else {
      hazard(g, x0 + 4, y0 + 4, cw - 8, 16);
      hazard(g, x0 + 4, y0 + ch - 20, cw - 8, 16);
    }
  }
  // Bolts
  for (const [bx, by] of [
    [x0 + 3, y0 + 3],
    [x0 + cw - 5, y0 + 3],
    [x0 + 3, y0 + ch - 5],
    [x0 + cw - 5, y0 + ch - 5],
  ]) {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(bx + 0.6, by + 0.6, 2, 2);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fillRect(bx, by, 2, 2);
  }
}

/*
 * The walls as one cached 2.5D layer (side faces + caps, drawn above players
 * so walls can occlude what stands behind them) plus an emissive neon layer
 * drawn after lighting. Also returns where the neon sits, for light spill.
 */
function buildWalls() {
  const art = makeCanvas(W * LAYER, H * LAYER);
  const g = art.getContext('2d');
  g.scale(LAYER, LAYER);
  const trim = makeCanvas(W * LAYER, H * LAYER);
  const t = trim.getContext('2d');
  t.scale(LAYER, LAYER);
  t.lineCap = 'round';
  const strips = [];
  const border = (w) => w.x === 0 || w.y === TOP || w.x + w.w === W || w.y + w.h === H;

  // Side faces first: caps (all the same height) always sit on top of them.
  const sides = [];
  for (const w of WALLS) {
    for (const side of ['n', 's', 'w', 'e']) {
      if (facesCamera(w, side)) for (const f of openSpans(w, side)) sides.push({ ...f, wall: w });
    }
  }
  for (const f of sides) drawWallSide(g, f);

  for (const w of WALLS) {
    const x0 = liftX(w.x, WALL_F);
    const y0 = liftY(w.y, WALL_F);
    const x1 = liftX(w.x + w.w, WALL_F);
    const y1 = liftY(w.y + w.h, WALL_F);
    const grad = g.createLinearGradient(x0, y0, x0 + Math.min(x1 - x0, 140), y0 + Math.min(y1 - y0, 140));
    grad.addColorStop(0, '#5f6878');
    grad.addColorStop(1, '#444c59');
    g.fillStyle = grad;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  WALLS.forEach((w, i) => drawWallCap(g, w, i));

  // Bevel along the outline of the merged caps: lit top-left, dark bottom-right.
  g.lineWidth = 1.5;
  for (const w of WALLS) {
    for (const side of ['n', 's', 'w', 'e']) {
      const inX = side === 'w' ? 0.75 : side === 'e' ? -0.75 : 0;
      const inY = side === 'n' ? 0.75 : side === 's' ? -0.75 : 0;
      g.strokeStyle = side === 'n' || side === 'w' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.5)';
      g.beginPath();
      for (const s of openSpans(w, side)) {
        g.moveTo(liftX(s.ax, WALL_F) + inX, liftY(s.ay, WALL_F) + inY);
        g.lineTo(liftX(s.bx, WALL_F) + inX, liftY(s.by, WALL_F) + inY);
      }
      g.stroke();
    }
  }

  // Neon: inlaid along interior caps, strip lights along the arena's inner faces.
  const runs = [];
  for (const w of WALLS) {
    if (border(w)) continue;
    for (const side of ['n', 's', 'w', 'e']) {
      const inX = side === 'w' ? 4 : side === 'e' ? -4 : 0;
      const inY = side === 'n' ? 4 : side === 's' ? -4 : 0;
      for (const s of openSpans(w, side)) {
        runs.push([liftX(s.ax, WALL_F) + inX, liftY(s.ay, WALL_F) + inY, liftX(s.bx, WALL_F) + inX, liftY(s.by, WALL_F) + inY]);
      }
    }
  }
  for (const f of sides) {
    if (!border(f.wall)) continue;
    const k = 0.8;
    runs.push([f.ax + (liftX(f.ax, WALL_F) - f.ax) * k, f.ay + (liftY(f.ay, WALL_F) - f.ay) * k, f.bx + (liftX(f.bx, WALL_F) - f.bx) * k, f.by + (liftY(f.by, WALL_F) - f.by) * k]);
  }
  for (const [ax, ay, bx, by] of runs) {
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Segmented fixtures with gaps, inset from the corners.
    for (let d = 7; d < len - 7; d += 84) {
      const e = Math.min(d + 66, len - 7);
      if (e - d < 10) continue;
      const sx = ax + ux * d;
      const sy = ay + uy * d;
      const ex = ax + ux * e;
      const ey = ay + uy * e;
      t.shadowColor = NEON;
      t.shadowBlur = 9 * LAYER;
      t.strokeStyle = rgba(NEON, 0.85);
      t.lineWidth = 2;
      t.beginPath();
      t.moveTo(sx, sy);
      t.lineTo(ex, ey);
      t.stroke();
      t.shadowBlur = 0;
      t.strokeStyle = '#d6fff8';
      t.lineWidth = 0.8;
      t.stroke();
      for (let q = 0; q <= e - d; q += 44) strips.push([sx + ux * q, sy + uy * q]);
    }
  }
  return { art, trim, strips };
}

// Lamps and neon spill, pre-rendered at light-map resolution.
function buildStaticLight(strips) {
  const c = makeCanvas(Math.ceil(W * LIGHT_SCALE), Math.ceil(H * LIGHT_SCALE));
  const g = c.getContext('2d');
  g.scale(LIGHT_SCALE, LIGHT_SCALE);
  g.globalCompositeOperation = 'lighter';
  LAMPS.forEach(([x, y], i) => {
    if (i === FLICKER) return;
    g.globalAlpha = 0.85;
    g.drawImage(glowSprite(LAMP, 128, 0.02), x - 380, y - 380, 760, 760);
  });
  g.globalAlpha = 0.22;
  for (const [x, y] of strips) g.drawImage(glowSprite(NEON, 128, 0.02), x - 52, y - 52, 104, 104);
  return c;
}

/*
 * Top-down operator facing +x: backpack, sleeves, gloved hands, plate carrier
 * in the player's colour and a ballistic helmet with NVG pod. Shading is lit
 * from straight above so it stays correct as the sprite rotates.
 */
function buildSoldier(color) {
  const S = 72;
  const c = makeCanvas(S * ART, S * ART);
  const g = c.getContext('2d');
  g.scale(ART, ART);
  g.translate(S / 2, S / 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Backpack with radio and an ID strip
  const pack = g.createRadialGradient(-14, 0, 1, -14, 0, 11);
  pack.addColorStop(0, '#525a67');
  pack.addColorStop(1, '#1c2027');
  g.fillStyle = pack;
  rr(g, -20.5, -9.5, 12.5, 19, 3.5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = '#15181d';
  rr(g, -19, -7.5, 4, 5.5, 1);
  g.fill();
  g.fillStyle = color;
  g.fillRect(-19.5, 1.5, 9, 1.8);

  // Sleeves reaching for the gun, dark outline under the fabric
  const arms = () => {
    g.beginPath();
    g.moveTo(0, 13);
    g.lineTo(9, 11);
    g.lineTo(14, 4);
    g.moveTo(0, -13);
    g.lineTo(13, -8);
    g.lineTo(23, -1);
  };
  arms();
  g.strokeStyle = '#13161b';
  g.lineWidth = 8;
  g.stroke();
  arms();
  g.strokeStyle = '#3b424e';
  g.lineWidth = 5.6;
  g.stroke();
  for (const [hx, hy] of [
    [14, 4],
    [23, -1],
  ]) {
    const glove = g.createRadialGradient(hx - 0.8, hy - 0.8, 0.5, hx, hy, 4);
    glove.addColorStop(0, '#4a505a');
    glove.addColorStop(1, '#121418');
    g.fillStyle = glove;
    g.beginPath();
    g.arc(hx, hy, 3.8, 0, TAU);
    g.fill();
  }

  // Plate carrier
  const body = g.createRadialGradient(-1, 0, 2, -1, 0, 18);
  body.addColorStop(0, shade(color, 0.32));
  body.addColorStop(0.55, color);
  body.addColorStop(1, shade(color, -0.55));
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(-1, 0, 11.5, 17, 0, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.6;
  g.stroke();
  // Chest rig with mag pouches
  g.fillStyle = 'rgba(12,14,18,0.6)';
  rr(g, 2.5, -9.5, 5.5, 19, 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.1)';
  for (const y of [-8, -2.6, 2.8]) g.fillRect(3.5, y, 3.5, 4.4);
  // Shoulder pads
  for (const sy of [-1, 1]) {
    const pad = g.createRadialGradient(-1, sy * 13, 0.5, -1, sy * 13, 6);
    pad.addColorStop(0, shade(color, 0.45));
    pad.addColorStop(1, shade(color, -0.35));
    g.fillStyle = pad;
    g.beginPath();
    g.ellipse(-1, sy * 13, 5.5, 4, 0, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1;
    g.stroke();
  }

  // Helmet: dark shell, colour band and an NVG pod at the front
  const helm = g.createRadialGradient(0, 0, 1, 1, 0, 10);
  helm.addColorStop(0, '#6a7280');
  helm.addColorStop(0.5, '#363c47');
  helm.addColorStop(1, '#16191e');
  g.fillStyle = helm;
  g.beginPath();
  g.arc(1, 0, 9.5, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  g.lineWidth = 1.4;
  g.stroke();
  g.fillStyle = color;
  g.fillRect(-7.5, -1.3, 12, 2.6);
  g.fillStyle = '#101317';
  rr(g, 7.5, -4, 5, 8, 1.6);
  g.fill();
  g.fillStyle = '#050608';
  for (const y of [-2, 2]) {
    g.beginPath();
    g.arc(11.6, y, 1.4, 0, TAU);
    g.fill();
  }
  return c;
}

// Additive overlay: a soft halo in the player's colour plus emissive NVG lenses.
function buildRim(sprite, color) {
  const c = makeCanvas(sprite.width, sprite.height);
  const g = c.getContext('2d');
  g.shadowColor = color;
  g.shadowBlur = 6 * ART;
  g.drawImage(tint(sprite, color), 0, 0);
  g.shadowBlur = 0;
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(sprite, 0, 0);
  g.globalCompositeOperation = 'lighter';
  g.setTransform(ART, 0, 0, ART, 36 * ART, 36 * ART);
  for (const [x, y, r, col] of [
    [11.8, -2, 2.6, shade(color, 0.6)],
    [11.8, 2, 2.6, shade(color, 0.6)],
    [-6.5, 0, 2.2, color],
  ]) {
    const l = g.createRadialGradient(x, y, 0, x, y, r);
    l.addColorStop(0, '#ffffff');
    l.addColorStop(0.4, col);
    l.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = l;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

// Crate lid: wooden planks in a steel frame. Lit from the top-left like the walls.
function buildCrateTop(damaged) {
  const S = CRATE;
  const c = makeCanvas(S * ART, S * ART);
  const g = c.getContext('2d');
  g.scale(ART, ART);
  const n = 4;
  const pw = S / n;
  for (let i = 0; i < n; i++) {
    const v = rand(-10, 10);
    const grad = g.createLinearGradient(0, i * pw, S, (i + 1) * pw);
    grad.addColorStop(0, `rgb(${Math.round(182 + v)},${Math.round(132 + v)},${Math.round(78 + v * 0.6)})`);
    grad.addColorStop(1, `rgb(${Math.round(140 + v)},${Math.round(96 + v)},${Math.round(52 + v * 0.6)})`);
    g.fillStyle = grad;
    g.fillRect(0, i * pw, S, pw);
    g.strokeStyle = 'rgba(70,40,15,0.3)';
    g.lineWidth = 0.6;
    for (let k = 0; k < 4; k++) {
      const y = i * pw + rand(2, pw - 2);
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(S * 0.3, y + rand(-1.5, 1.5), S * 0.6, y + rand(-1.5, 1.5), S, y + rand(-1, 1));
      g.stroke();
    }
    g.fillStyle = 'rgba(30,16,6,0.6)';
    g.fillRect(0, i * pw, S, 0.9);
  }
  // Diagonal brace
  g.strokeStyle = 'rgba(40,22,8,0.55)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(6, 6);
  g.lineTo(S - 6, S - 6);
  g.stroke();
  g.strokeStyle = 'rgba(255,220,170,0.18)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(6, 4);
  g.lineTo(S - 4, S - 6);
  g.stroke();
  // Steel frame with bevel and corner brackets
  g.strokeStyle = '#2c3038';
  g.lineWidth = 4;
  g.strokeRect(2, 2, S - 4, S - 4);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255,255,255,0.26)';
  g.strokeRect(0.5, 0.5, S - 1, S - 1);
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.strokeRect(4.5, 4.5, S - 9, S - 9);
  for (const [x, y] of [
    [0, 0],
    [S - 9, 0],
    [0, S - 9],
    [S - 9, S - 9],
  ]) {
    const b = g.createLinearGradient(x, y, x + 9, y + 9);
    b.addColorStop(0, '#7a828f');
    b.addColorStop(1, '#3d434d');
    g.fillStyle = b;
    g.fillRect(x, y, 9, 9);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(x + 4, y + 4, 1.4, 1.4);
  }
  // Stencilled supply mark
  g.fillStyle = 'rgba(245,238,220,0.32)';
  g.fillRect(S / 2 - 9, S / 2 - 12, 18, 4);
  g.fillRect(S / 2 - 6, S / 2 + 8, 12, 3);
  if (damaged) {
    g.strokeStyle = 'rgba(20,10,4,0.9)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(9, 3);
    g.lineTo(15, 14);
    g.lineTo(12, 22);
    g.lineTo(20, 33);
    g.moveTo(S - 6, 10);
    g.lineTo(S - 16, 18);
    g.lineTo(S - 12, 28);
    g.stroke();
    g.fillStyle = '#1a0f07';
    g.beginPath();
    g.moveTo(S - 10, S - 4);
    g.lineTo(S - 22, S - 8);
    g.lineTo(S - 17, S - 14);
    g.lineTo(S - 6, S - 12);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, 0, S, S);
  }
  return c;
}

// Barrel lid: red steel, rolled rim, hazard label and bungs.
function buildBarrelTop() {
  const r = BARREL_R;
  const S = (r + 2) * 2;
  const c = makeCanvas(S * ART, S * ART);
  const g = c.getContext('2d');
  g.scale(ART, ART);
  g.translate(S / 2, S / 2);
  const grad = g.createRadialGradient(-4, -5, 1, 0, 0, r);
  grad.addColorStop(0, '#ff7563');
  grad.addColorStop(0.55, '#cf3427');
  grad.addColorStop(1, '#701411');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = '#4a0c0a';
  g.beginPath();
  g.arc(0, 0, r - 1, 0, TAU);
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255,205,195,0.4)';
  g.beginPath();
  g.arc(0, 0, r - 2.6, Math.PI * 0.95, Math.PI * 1.8);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.beginPath();
  g.arc(0, 0, r - 6.5, 0, TAU);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.arc(0, 0, r - 7.5, 0, TAU);
  g.stroke();
  // Hazard label
  g.fillStyle = '#1a1a1a';
  g.beginPath();
  g.moveTo(0, -8);
  g.lineTo(7.5, 5.5);
  g.lineTo(-7.5, 5.5);
  g.closePath();
  g.fill();
  g.fillStyle = '#f5c518';
  g.beginPath();
  g.moveTo(0, -6.3);
  g.lineTo(6, 4.5);
  g.lineTo(-6, 4.5);
  g.closePath();
  g.fill();
  g.fillStyle = '#1b1b1b';
  g.fillRect(-0.9, -2.8, 1.8, 4.2);
  g.fillRect(-0.9, 2.2, 1.8, 1.4);
  for (const [x, y] of [
    [9.5, -8],
    [-8.5, 9],
  ]) {
    g.fillStyle = '#4e0d0b';
    g.beginPath();
    g.arc(x, y, 2.6, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,190,180,0.35)';
    g.beginPath();
    g.arc(x - 0.7, y - 0.7, 1, 0, TAU);
    g.fill();
  }
  return c;
}

// Hexagonal emitter pad that pickups hover over.
function buildPad() {
  const S = 52;
  const c = makeCanvas(S * ART, S * ART);
  const g = c.getContext('2d');
  g.scale(ART, ART);
  g.translate(S / 2, S / 2);
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 8 * ART;
  g.shadowOffsetY = 3 * ART;
  hexPath(g, 0, 0, 19);
  g.fillStyle = '#1b1f26';
  g.fill();
  g.shadowColor = 'transparent';
  const plate = g.createLinearGradient(-19, -19, 19, 19);
  plate.addColorStop(0, '#59616e');
  plate.addColorStop(1, '#2b3039');
  g.fillStyle = plate;
  hexPath(g, 0, 0, 18);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.lineWidth = 1;
  g.stroke();
  hexPath(g, 0, 0, 13.5);
  g.fillStyle = '#0d1014';
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 6; i += 2) {
    const a = (i / 6) * TAU + Math.PI / 6;
    g.fillRect(Math.cos(a) * 15.5 - 0.8, Math.sin(a) * 15.5 - 0.8, 1.6, 1.6);
  }
  return c;
}

// Muzzle flash pointing along +x: hot core with warm petals.
function buildMuzzle(big) {
  const L = big ? 46 : 30;
  const Hh = big ? 30 : 18;
  const c = makeCanvas((L + 8) * ART, Hh * ART);
  const g = c.getContext('2d');
  g.scale(ART, ART);
  g.translate(4, Hh / 2);
  g.globalCompositeOperation = 'lighter';
  const petal = (len, w, col) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, -w);
    g.quadraticCurveTo(len * 0.4, -w * 0.6, len, 0);
    g.quadraticCurveTo(len * 0.4, w * 0.6, 0, w);
    g.closePath();
    g.fill();
  };
  petal(L, Hh * 0.3, 'rgba(255,140,50,0.55)');
  for (const a of [0.75, -0.75]) {
    g.save();
    g.rotate(a);
    petal(L * 0.42, Hh * 0.12, 'rgba(255,170,80,0.65)');
    g.restore();
  }
  petal(L * 0.7, Hh * 0.17, 'rgba(255,220,150,0.85)');
  petal(L * 0.4, Hh * 0.1, 'rgba(255,255,240,1)');
  return c;
}

// Gun drawn along +x in the player's rotated frame. `holo` draws it as a
// single-colour hologram (pickups).
function drawGun(g, w, kick, holo = null) {
  const x = 10 - kick;
  const hw = w.width / 2;
  const body = holo ?? '#1c1f26';
  const dark = holo ?? '#0b0c10';
  const hi = holo ? 'rgba(255,255,255,0.8)' : '#5d6676';
  if (w.id === 'shotgun') {
    g.fillStyle = holo ?? '#5a3a1f';
    g.fillRect(x - 6, -hw + 1, 10, w.width - 2);
  }
  g.fillStyle = body;
  g.fillRect(x, -hw, w.len, w.width);
  g.fillStyle = hi;
  g.fillRect(x + 3, -0.8, w.len - 7, 1.6);
  g.fillStyle = dark;
  if (w.id === 'rifle') g.fillRect(x + 8, hw - 1, 5, 6);
  else if (w.id === 'smg') g.fillRect(x + 6, hw - 1, 4, 9);
  else if (w.id === 'shotgun') {
    g.fillStyle = holo ?? '#7a4a24';
    g.fillRect(x + 13, -hw - 1, 9, w.width + 2);
  } else if (w.id === 'sniper') {
    g.fillStyle = holo ?? '#2c313b';
    g.fillRect(x + 8, -3, 15, 6);
    g.fillStyle = holo ? '#ffffff' : '#7dd3fc';
    g.fillRect(x + 22, -1.5, 2, 3);
  }
  g.fillStyle = dark;
  g.fillRect(x + w.len - 1, -hw * 0.6, 4, w.width * 0.6);
}

/* -------------------------------------------------------------- Game */
class StrikeArena {
  constructor({ players, host }) {
    this.host = host;
    this.floor = buildFloor();
    this.ground = makeCanvas(W, H); // floor with this round's decals baked in
    this.dctx = this.ground.getContext('2d');
    const walls = buildWalls();
    this.wallBase = walls.art;
    this.wallArt = makeCanvas(walls.art.width, walls.art.height); // walls + bullet holes
    this.wctx = this.wallArt.getContext('2d');
    this.wctx.scale(LAYER, LAYER);
    this.trimArt = walls.trim;
    this.staticLight = buildStaticLight(walls.strips);
    this.lightMap = new LightMap(LIGHT_SCALE);
    this.crateArt = [buildCrateTop(false), buildCrateTop(true)];
    this.crateShadow = buildBoxShadow(CRATE, CRATE);
    this.barrelArt = buildBarrelTop();
    this.padArt = buildPad();
    this.muzzleArt = [buildMuzzle(false), buildMuzzle(true)];
    this.shadowArt = blob('rgba(0,0,0,0.6)', 'rgba(0,0,0,0)');
    this.smokeArt = [buildSmoke(), buildSmoke(), buildSmoke()];
    this.particles = new Particles();
    this.players = players.map((p, i) => {
      const sprite = buildSoldier(p.color);
      return {
        ...p,
        i,
        wins: 0,
        kills: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angle: 0,
        hp: 100,
        alive: true,
        sprite,
        flashArt: tint(sprite, '#ffffff'),
        rim: buildRim(sprite, p.color),
        ghost: tint(sprite, shade(p.color, 0.25)),
      };
    });
    // Dash afterimages remember the sprite; map it to the matching glow art.
    this.ghostArt = new Map(this.players.map((p) => [p.sprite, p.ghost]));
    this.round = 0;
    this.result = null;
    this.shake = 0;
    this.flashT = 0;
    this.time = 0;
    // Transient post-processing (read by the host every frame) and its drivers.
    this.boom = 0;
    this.koPulse = 0;
    this.post = { flash: 0, flashColor: [1, 0.62, 0.32], aberration: POST.aberration, desaturate: 0 };
    this.startRound();
  }

  startRound() {
    this.round++;
    this.bullets = [];
    this.pickups = [];
    this.casings = [];
    this.ghosts = [];
    this.numbers = [];
    this.lights = [];
    this.smoke = [];
    this.trails = [];
    this.feed = [];
    this.rings = [];
    this.pickupTimer = 4;
    // Fresh decals: restore the clean floor and walls.
    this.dctx.drawImage(this.floor, 0, 0);
    this.wctx.clearRect(0, 0, W, H);
    this.wctx.drawImage(this.wallBase, 0, 0, W, H);
    this.crates = CRATE_SPOTS.map(([x, y]) => ({ x: x - CRATE / 2, y: y - CRATE / 2, w: CRATE, h: CRATE, hp: CRATE_HP, hit: 0 }));
    this.barrels = BARREL_SPOTS.map(([x, y]) => ({ x, y, hp: BARREL_HP, armed: false, fuse: 0, from: null, hit: 0 }));
    this.refreshSolids();
    // Two guns up for grabs right away so every round opens with a scramble.
    const guns = ['smg', 'shotgun', 'sniper'].sort(() => Math.random() - 0.5);
    this.pickups.push({ x: 695, y: 473, type: guns[0], t: 0 }, { x: 905, y: 473, type: guns[1], t: 0 });

    this.state = 'countdown';
    this.stateT = 3;
    this.lastCount = 4;
    this.roundWinner = null;
    const order = [...SPAWNS];
    this.players.forEach((p, i) => {
      const [x, y] = order[i % order.length];
      Object.assign(p, {
        x,
        y,
        vx: 0,
        vy: 0,
        kx: 0,
        ky: 0,
        angle: Math.atan2(H / 2 - y, W / 2 - x),
        hp: 100,
        shield: 0,
        alive: true,
        cooldown: 0,
        dash: 0,
        dashCd: 0,
        ghostT: 0,
        flash: 0,
        muzzle: 0,
        kick: 0,
        bloom: 0,
        idle: 0,
        lastHit: null,
        brain: null,
      });
      this.equip(p, 'rifle');
    });
  }

  refreshSolids() {
    this.solids = WALLS.concat(this.crates);
  }

  equip(p, id) {
    const w = WEAPONS[id];
    p.weapon = id;
    p.mag = w.mag;
    p.reserve = w.reserve;
    p.reloadT = 0;
    p.bloom = 0;
  }

  update(dt, inputs) {
    this.time += dt;
    this.dt = dt;
    this.particles.update(dt);
    this.shake = Math.max(0, this.shake - dt * 30);
    this.flashT -= dt;
    this.updateFx(dt);

    if (this.state === 'countdown') {
      this.stateT -= dt;
      const n = Math.ceil(this.stateT);
      if (n < this.lastCount && n > 0) this.host.sfx('count');
      this.lastCount = n;
      if (this.stateT <= 0) {
        this.state = 'fight';
        this.host.sfx('go');
      }
      return;
    }

    if (this.state === 'roundover') {
      this.stateT -= dt;
      this.updateBullets(dt);
      this.updateProps(dt);
      if (this.stateT <= 0 && !this.result) this.startRound();
      return;
    }

    if (this.state === 'matchover') return;

    for (const p of this.players) {
      if (!p.alive) continue;
      const inp = inputs[p.i] ?? (p.cpu ? this.bot(p) : IDLE);
      this.updatePlayer(p, inp, dt);
    }
    this.separatePlayers();
    this.updateBullets(dt);
    this.updateProps(dt);
    this.updatePickups(dt);

    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      const winner = alive[0] ?? null;
      this.roundWinner = winner;
      if (winner) winner.wins++;
      this.state = 'roundover';
      this.stateT = 2.8;
      if (winner && winner.wins >= WINS_NEEDED) this.finish(winner);
    }
  }

  updatePlayer(p, inp, dt) {
    p.cooldown -= dt;
    p.dashCd -= dt;
    p.flash -= dt;
    p.muzzle -= dt;
    p.idle += dt;
    p.kick = Math.max(0, p.kick - dt * 45);
    p.bloom = Math.max(0, p.bloom - dt * 0.45);

    // Magazine handling: auto reload when empty or after a pause in fire.
    const w = WEAPONS[p.weapon];
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        const take = Math.min(w.mag - p.mag, p.reserve);
        p.mag += take;
        p.reserve -= take;
        this.host.sfx('block');
      }
    } else if (p.mag <= 0) {
      if (p.reserve > 0) this.startReload(p);
      else {
        this.equip(p, 'rifle');
        this.popText(p.x, p.y - R - 40, 'OUT OF AMMO', '#9aa3b8', 15);
      }
    } else if (p.idle > 1.6 && p.mag < w.mag && p.reserve > 0) this.startReload(p);

    const mag = Math.min(1, Math.hypot(inp.x, inp.y));
    if (mag > 0.25) p.angle = Math.atan2(inp.y, inp.x);

    if (inp.bPressed && p.dashCd <= 0) {
      p.dash = 0.17;
      p.dashCd = 1.1;
      this.host.sfx('dash');
      this.particles.burst(p.x, p.y, { count: 10, color: '#9ca3af', speed: 160, life: 0.4, angle: p.angle + Math.PI, spread: 1.4, size: 4 });
    }

    if (p.dash > 0) {
      p.dash -= dt;
      p.vx = Math.cos(p.angle) * DASH_SPEED;
      p.vy = Math.sin(p.angle) * DASH_SPEED;
      p.ghostT -= dt;
      if (p.ghostT <= 0) {
        p.ghostT = 0.022;
        this.ghosts.push({ x: p.x, y: p.y, angle: p.angle, sprite: p.sprite, life: 0.28 });
      }
    } else {
      const speed = SPEED * (inp.a ? 0.72 : 1) * (p.weapon === 'sniper' ? 0.9 : 1);
      const k = Math.min(1, dt * 14);
      const len = Math.max(1, Math.hypot(inp.x, inp.y));
      const nx = mag > 0 ? (inp.x / len) * speed : 0;
      const ny = mag > 0 ? (inp.y / len) * speed : 0;
      p.vx += (nx - p.vx) * k;
      p.vy += (ny - p.vy) * k;
    }

    // Knockback is its own decaying velocity so hits shove you around.
    const kd = Math.exp(-dt * 7);
    p.kx *= kd;
    p.ky *= kd;
    p.x += (p.vx + p.kx) * dt;
    p.y += (p.vy + p.ky) * dt;
    this.collide(p);

    if (inp.a) {
      p.idle = 0;
      if (p.cooldown <= 0 && p.reloadT <= 0 && p.dash <= 0 && p.mag > 0) this.shoot(p, mag);
    }
  }

  startReload(p) {
    p.reloadT = WEAPONS[p.weapon].reload;
    this.host.sfx('block');
  }

  collide(p) {
    collideRects(p, R, WALLS);
    collideRects(p, R, this.crates);
    for (const k of this.barrels) {
      const d = dist(p.x, p.y, k.x, k.y);
      if (d > 0 && d < R + BARREL_R) {
        const push = R + BARREL_R - d;
        p.x += ((p.x - k.x) / d) * push;
        p.y += ((p.y - k.y) / d) * push;
      }
    }
  }

  shoot(p, moving) {
    const w = WEAPONS[p.weapon];
    p.cooldown = w.rate;
    p.mag--;
    p.muzzle = 0.05;
    p.kick = w.id === 'shotgun' || w.id === 'sniper' ? 9 : 5;
    const ca = Math.cos(p.angle);
    const sa = Math.sin(p.angle);

    // Spread grows with sustained fire (bloom) and while moving.
    const spread = w.spread + p.bloom + moving * (w.id === 'sniper' ? 0.1 : 0.035);
    p.bloom = Math.min(w.maxBloom, p.bloom + w.bloom);
    const sx = p.x + ca * 12;
    const sy = p.y + sa * 12;
    for (let k = 0; k < w.pellets; k++) {
      const a = w.pellets > 1 ? p.angle + (k / (w.pellets - 1) - 0.5) * w.spread + rand(-0.04, 0.04) : p.angle + rand(-spread, spread);
      const sp = w.speed * (w.pellets > 1 ? rand(0.85, 1.1) : 1);
      this.bullets.push({ x: sx, y: sy, sx, sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, owner: p, weapon: w.id, dmg: w.dmg, life: w.life, bounces: w.bounces, pierce: w.pierce, hits: null, travel: 0 });
    }

    // Recoil shoves the shooter back.
    p.kx -= ca * w.recoil;
    p.ky -= sa * w.recoil;
    this.shake = Math.max(this.shake, w.shake);

    const mx = p.x + ca * (12 + w.len);
    const my = p.y + sa * (12 + w.len);
    this.particles.burst(mx, my, { count: w.pellets > 1 ? 10 : 4, color: '#ffe8a3', speed: 200, life: 0.12, angle: p.angle, spread: 0.8, size: 2.2 });
    this.lights.push({ x: mx, y: my, r: w.id === 'shotgun' || w.id === 'sniper' ? 150 : 90, life: 0.07, max: 0.07, color: '#ffc06a' });
    if (w.id === 'shotgun' || w.id === 'sniper') this.puff(mx, my, 3, ca * 40, sa * 40);

    // Spent casing flies out of the ejection port to the right.
    const ea = p.angle + Math.PI / 2 + rand(-0.4, 0.4);
    if (this.casings.length > 160) this.casings.shift();
    this.casings.push({
      x: p.x + ca * 16,
      y: p.y + sa * 16,
      z: 14,
      vx: Math.cos(ea) * rand(90, 170) + p.vx * 0.5,
      vy: Math.sin(ea) * rand(90, 170) + p.vy * 0.5,
      vz: rand(90, 170),
      rot: rand(TAU),
      spin: rand(-25, 25),
      color: w.id === 'shotgun' ? '#c2410c' : '#d4a743',
      len: w.id === 'shotgun' ? 7 : w.id === 'sniper' ? 8 : 5,
      bounces: 0,
    });

    this.host.sfx(w.sound);
    if (w.id === 'shotgun') this.host.sfx('shoot');
  }

  separatePlayers() {
    const ps = this.players.filter((p) => p.alive);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        const d = dist(a.x, a.y, b.x, b.y);
        if (d > 0 && d < R * 2) {
          const push = (R * 2 - d) / 2;
          const nx = (b.x - a.x) / d;
          const ny = (b.y - a.y) / d;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
        }
      }
    }
  }

  updateBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) {
        this.endBullet(b);
        continue;
      }
      // Sub-step so fast rounds can't tunnel through thin walls or players.
      const speed = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((speed * dt) / 12));
      let dead = false;
      for (let s = 0; s < steps && !dead; s++) {
        const ox = b.x;
        const oy = b.y;
        const stepX = (b.vx * dt) / steps;
        const stepY = (b.vy * dt) / steps;
        b.x += stepX;
        b.y += stepY;
        b.travel += Math.hypot(stepX, stepY);

        const wall = WALLS.find((w) => pointInRect(b.x, b.y, w));
        const crate = wall ? null : this.crates.find((c) => pointInRect(b.x, b.y, c));
        const rect = wall || crate;
        if (rect) {
          this.particles.burst(b.x, b.y, { count: 6, color: crate ? '#d6a46a' : '#ffd9a0', speed: 220, life: 0.25, size: 2, angle: Math.atan2(-b.vy, -b.vx), spread: 2 });
          if (crate) {
            this.hitCrate(crate, b.dmg);
            dead = true;
          } else if (b.bounces > 0) {
            // Ricochet off whichever face we crossed.
            if (ox < rect.x || ox > rect.x + rect.w) b.vx = -b.vx;
            else b.vy = -b.vy;
            b.x = ox;
            b.y = oy;
            b.bounces--;
            b.dmg *= 0.6;
            b.travel = 0;
            b.life = Math.min(b.life, 0.45);
            this.host.sfx('whiff');
            break;
          } else {
            this.stampHole(b.x, b.y);
            dead = true;
          }
          continue;
        }

        const barrel = this.barrels.find((k) => !k.armed && dist(k.x, k.y, b.x, b.y) < BARREL_R);
        if (barrel) {
          this.particles.burst(b.x, b.y, { count: 6, color: '#ffd9a0', speed: 220, life: 0.25, size: 2 });
          this.hitBarrel(barrel, b.dmg, b.owner);
          dead = true;
          continue;
        }

        for (const p of this.players) {
          // Dashing players slip through bullets.
          if (!p.alive || p === b.owner || p.dash > 0 || b.hits?.has(p)) continue;
          if (dist(p.x, p.y, b.x, b.y) < R + 3) {
            const w = WEAPONS[b.weapon];
            this.damage(p, b.dmg, b.owner, Math.atan2(b.vy, b.vx), w.knock, w.label);
            if (b.pierce) {
              (b.hits ??= new Set()).add(p);
              b.dmg *= 0.7;
            } else dead = true;
            break;
          }
        }
      }
      if (dead) {
        this.endBullet(b);
        continue;
      }
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) continue;
      keep.push(b);
    }
    this.bullets = keep;
  }

  endBullet(b) {
    if (b.weapon === 'sniper') this.trails.push({ x1: b.sx, y1: b.sy, x2: b.x, y2: b.y, life: 0.5 });
  }

  damage(p, amount, from, angle, knock, label) {
    if (this.state !== 'fight' || !p.alive) return;
    let dmg = amount;
    let absorbed = 0;
    if (p.shield > 0) {
      absorbed = Math.min(p.shield, dmg);
      p.shield -= absorbed;
      dmg -= absorbed;
    }
    p.hp -= dmg;
    p.flash = 0.1;
    p.kx += Math.cos(angle) * knock;
    p.ky += Math.sin(angle) * knock;
    if (from && from !== p) {
      p.lastHit = from;
      from.lastDealt = this.time;
    }

    // Damage numbers: pellets from one blast merge into a single number.
    const recent = this.numbers.find((n) => n.p === p && n.life > 0.72);
    if (recent) {
      recent.value += amount;
      recent.txt = String(Math.round(recent.value));
    } else {
      this.numbers.push({ p, x: p.x + rand(-10, 10), y: p.y - R - 6, vy: -80, life: 0.8, value: amount, txt: String(Math.round(amount)), color: absorbed >= amount ? '#67e8f9' : amount >= 40 ? '#ff5f6d' : '#fff', size: amount >= 40 ? 28 : 20 });
    }

    this.particles.burst(p.x, p.y, { count: 7, color: absorbed > 0 ? '#67e8f9' : '#ffe2b0', speed: 260, life: 0.25, angle, spread: 1.2, size: 2 });
    this.particles.burst(p.x, p.y, { count: 4, color: p.color, speed: 160, life: 0.35, angle, spread: 1.6 });
    this.host.sfx('hit');
    this.host.buzz(p.i, 60);
    if (p.hp <= 0) {
      p.alive = false;
      const killer = from && from !== p ? from : p.lastHit;
      if (killer && killer !== p) killer.kills++;
      this.feed.unshift({ killer, victim: p, label, t: 5 });
      if (this.feed.length > 5) this.feed.pop();
      this.shake = Math.max(this.shake, 12);
      this.particles.burst(p.x, p.y, { count: 34, color: p.color, speed: 420, life: 0.9, size: 4 });
      this.particles.burst(p.x, p.y, { count: 18, color: '#fff3c4', speed: 260, life: 0.5, size: 3 });
      this.lights.push({ x: p.x, y: p.y, r: 220, life: 0.3, max: 0.3, color: p.color });
      this.rings.push({ x: p.x, y: p.y, r: 60, life: 0.35, max: 0.35, color: p.color });
      this.koPulse = 1;
      this.puff(p.x, p.y, 5, 0, 0);
      this.stampScorch(p.x, p.y, 34, p.color);
      // Drop a special weapon for someone else to grab.
      if (p.weapon !== 'rifle') this.pickups.push({ x: p.x, y: p.y, type: p.weapon, t: 0 });
      this.host.sfx('explode');
      this.host.buzz(p.i, 350);
    }
  }

  /* ------------------------------------------------------------- Props */
  hitCrate(c, dmg) {
    c.hp -= dmg;
    c.hit = 0.08;
    if (c.hp > 0) return;
    const cx = c.x + CRATE / 2;
    const cy = c.y + CRATE / 2;
    this.crates = this.crates.filter((o) => o !== c);
    this.refreshSolids();
    this.particles.burst(cx, cy, { count: 22, color: '#b98446', speed: 300, life: 0.6, size: 4 });
    this.particles.burst(cx, cy, { count: 10, color: '#5e3b1b', speed: 200, life: 0.7, size: 3 });
    this.puff(cx, cy, 3, 0, 0);
    this.stampDebris(cx, cy);
    this.host.sfx('crash');
    if (Math.random() < 0.4) this.pickups.push({ x: cx, y: cy, type: rollPickup(), t: 0 });
  }

  hitBarrel(k, dmg, from) {
    k.hp -= dmg;
    k.hit = 0.08;
    if (from) k.from = from;
    if (k.hp <= 0 && !k.armed) {
      k.armed = true;
      k.fuse = 0.1;
    }
  }

  updateProps(dt) {
    for (const c of this.crates) c.hit -= dt;
    for (const k of [...this.barrels]) {
      k.hit -= dt;
      if (k.armed) {
        k.fuse -= dt;
        if (k.fuse <= 0) {
          this.barrels = this.barrels.filter((o) => o !== k);
          this.explode(k.x, k.y, k.from);
        }
      } else if (k.hp < BARREL_HP * 0.6) {
        // Punctured barrels burn and eventually go off on their own.
        k.hp -= dt * 5;
        if (Math.random() < dt * 30) this.particles.burst(k.x + rand(-6, 6), k.y - 6, { count: 1, color: pick(['#ff8a2b', '#facc15', '#ff5f3b']), speed: 60, life: 0.45, angle: -Math.PI / 2, spread: 0.8, size: 4 });
        if (Math.random() < dt * 4) this.puff(k.x, k.y - 8, 1, rand(-10, 10), -30);
        if (k.hp <= 0) this.hitBarrel(k, 0, null);
      }
    }
  }

  explode(x, y, from) {
    this.shake = Math.max(this.shake, 16);
    this.flashT = 0.12;
    this.lights.push({ x, y, r: 440, life: 0.45, max: 0.45, color: '#ffb347' });
    this.rings.push({ x, y, r: BLAST_R, life: 0.5, max: 0.5, color: '#ffb347' });
    this.boom = 1;
    this.particles.burst(x, y, { count: 40, color: '#ff8a2b', speed: 480, life: 0.7, size: 6 });
    this.particles.burst(x, y, { count: 22, color: '#ffe8a3', speed: 300, life: 0.4, size: 5 });
    this.particles.burst(x, y, { count: 16, color: '#ffd27a', speed: 700, life: 0.3, size: 2 });
    this.puff(x, y, 10, 0, 0);
    this.stampScorch(x, y, 90);
    this.host.sfx('explode');

    for (const p of this.players) {
      if (!p.alive) continue;
      const d = dist(x, y, p.x, p.y);
      if (d > BLAST_R + R || lineBlocked(x, y, p.x, p.y, WALLS)) continue;
      const f = 1 - d / (BLAST_R + R);
      this.damage(p, Math.round(20 + 60 * f), from, Math.atan2(p.y - y, p.x - x), 250 + 900 * f, 'BARREL');
      this.host.buzz(p.i, 200);
    }
    for (const c of [...this.crates]) {
      const d = dist(x, y, c.x + CRATE / 2, c.y + CRATE / 2);
      if (d < BLAST_R) this.hitCrate(c, 90 * (1 - d / BLAST_R) + 20);
    }
    // Chain reactions.
    for (const k of this.barrels) if (!k.armed && dist(x, y, k.x, k.y) < BLAST_R) this.hitBarrel(k, 100, from);
  }

  updatePickups(dt) {
    this.pickupTimer -= dt;
    if (this.pickupTimer <= 0 && this.pickups.length < 4) {
      this.pickupTimer = rand(5, 8);
      for (let tries = 0; tries < 30; tries++) {
        const x = rand(60, W - 60);
        const y = rand(TOP + 60, H - 60);
        if (!this.blockedAt(x, y, 30)) {
          this.pickups.push({ x, y, type: rollPickup(), t: 0 });
          break;
        }
      }
    }
    this.pickups = this.pickups.filter((k) => {
      k.t += dt;
      const info = PICKUPS[k.type];
      const p = this.players.find((pl) => {
        if (!pl.alive || dist(pl.x, pl.y, k.x, k.y) > R + 18) return false;
        if (k.type === 'health') return pl.hp < 100;
        if (k.type === 'shield') return pl.shield < 50;
        return true;
      });
      if (!p) return true;
      if (k.type === 'health') p.hp = Math.min(100, p.hp + 40);
      else if (k.type === 'shield') {
        p.shield = 50;
        this.host.sfx('shield');
      } else if (p.weapon === k.type) p.reserve += WEAPONS[k.type].mag;
      else this.equip(p, k.type);
      this.popText(k.x, k.y - 26, info.weapon ? WEAPONS[k.type].label : k.type === 'health' ? '+40' : 'SHIELD', info.color, 18);
      this.particles.burst(k.x, k.y, { count: 16, color: info.color, speed: 200, life: 0.5 });
      this.host.sfx('pickup');
      return false;
    });
  }

  /* ----------------------------------------------------------- Effects */
  puff(x, y, n, vx, vy) {
    for (let i = 0; i < n; i++) {
      this.smoke.push({ x: x + rand(-10, 10), y: y + rand(-10, 10), vx: vx + rand(-25, 25), vy: vy + rand(-25, 25), r: rand(14, 26), life: rand(0.8, 1.4), max: 1.4, v: (Math.random() * 3) | 0 });
    }
    if (this.smoke.length > 120) this.smoke.splice(0, this.smoke.length - 120);
  }

  popText(x, y, txt, color, size) {
    this.numbers.push({ p: null, x, y, vy: -50, life: 1.1, value: 0, txt, color, size });
  }

  // Bullet holes land on the wall face the shot came through, if the camera can see it.
  stampHole(x, y) {
    const w = WALLS.find((r) => pointInRect(x, y, r));
    let g = this.dctx;
    if (w) {
      const d = { n: y - w.y, s: w.y + w.h - y, w: x - w.x, e: w.x + w.w - x };
      const side = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
      if (!facesCamera(w, side)) return;
      g = this.wctx;
      x = liftX(x, WALL_F * 0.5);
      y = liftY(y, WALL_F * 0.5);
    }
    const r = rand(1.6, 2.6);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.arc(x, y, r + 1.6, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(6,6,8,0.85)';
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 0.8;
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = rand(TAU);
      g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      g.lineTo(x + Math.cos(a) * (r + rand(2, 5)), y + Math.sin(a) * (r + rand(2, 5)));
    }
    g.stroke();
  }

  stampScorch(x, y, r, tint) {
    const g = this.dctx;
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, 'rgba(5,5,7,0.85)');
    s.addColorStop(0.45, 'rgba(10,10,12,0.5)');
    s.addColorStop(1, 'rgba(10,10,12,0)');
    g.fillStyle = s;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    // Blotchy soot edge
    for (let i = 0; i < 12; i++) {
      const a = rand(TAU);
      const d = rand(0.3, 0.85) * r;
      const bx = x + Math.cos(a) * d;
      const by = y + Math.sin(a) * d;
      const br = rand(0.12, 0.3) * r;
      const b = g.createRadialGradient(bx, by, 0, bx, by, br);
      b.addColorStop(0, 'rgba(8,8,10,0.35)');
      b.addColorStop(1, 'rgba(8,8,10,0)');
      g.fillStyle = b;
      g.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    // Blast streaks
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < 11; i++) {
      const a = rand(TAU);
      g.lineWidth = rand(1, 2.6);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
      g.lineTo(x + Math.cos(a) * r * rand(0.8, 1.25), y + Math.sin(a) * r * rand(0.8, 1.25));
      g.stroke();
    }
    if (tint) {
      g.strokeStyle = rgba(tint, 0.22);
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r * 0.55, 0, TAU);
      g.stroke();
    }
    // Glassy specks in the crater
    g.fillStyle = 'rgba(255,255,255,0.1)';
    for (let i = 0; i < 10; i++) g.fillRect(x + rand(-r, r) * 0.4, y + rand(-r, r) * 0.4, 1.2, 1.2);
  }

  stampDebris(x, y) {
    const g = this.dctx;
    for (let i = 0; i < 10; i++) {
      g.save();
      g.translate(x + rand(-26, 26), y + rand(-26, 26));
      g.rotate(rand(TAU));
      const w = rand(8, 20);
      const h = rand(3, 5);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(-w / 2 + 1, -h / 2 + 1.5, w, h);
      g.fillStyle = pick(['#8a5a2b', '#6b4423', '#b98446']);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.fillStyle = 'rgba(255,230,190,0.2)';
      g.fillRect(-w / 2, -h / 2, w, 1);
      g.restore();
    }
  }

  updateFx(dt) {
    for (const c of this.casings) {
      c.vz -= 900 * dt;
      c.z += c.vz * dt;
      const ox = c.x;
      const oy = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.spin * dt;
      if (WALLS.some((w) => pointInRect(c.x, c.y, w))) {
        c.x = ox;
        c.y = oy;
        c.vx *= -0.5;
        c.vy *= -0.5;
      }
      if (c.z <= 0) {
        c.z = 0;
        c.vz = -c.vz * 0.4;
        c.vx *= 0.55;
        c.vy *= 0.55;
        c.spin *= 0.5;
        c.bounces++;
      }
    }
    // Settled casings become part of the floor.
    this.casings = this.casings.filter((c) => {
      if (c.bounces < 3) return true;
      const g = this.dctx;
      g.save();
      g.translate(c.x, c.y);
      g.rotate(c.rot);
      g.globalAlpha = 0.85;
      g.fillStyle = c.color;
      g.fillRect(-c.len / 2, -1.2, c.len, 2.4);
      g.fillStyle = 'rgba(255,240,200,0.45)';
      g.fillRect(-c.len / 2, -1.2, c.len, 0.8);
      g.restore();
      return false;
    });

    for (const s of this.smoke) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 1 - dt;
      s.vy *= 1 - dt;
      s.r += dt * 22;
      s.life -= dt;
    }
    for (const n of this.numbers) {
      n.y += n.vy * dt;
      n.vy *= 1 - dt * 2.5;
      n.life -= dt;
    }
    for (const g of this.ghosts) g.life -= dt;
    for (const l of this.lights) l.life -= dt;
    for (const t of this.trails) t.life -= dt;
    for (const f of this.feed) f.t -= dt;
    this.smoke = this.smoke.filter((s) => s.life > 0);
    this.numbers = this.numbers.filter((n) => n.life > 0);
    this.ghosts = this.ghosts.filter((g) => g.life > 0);
    this.lights = this.lights.filter((l) => l.life > 0);
    this.trails = this.trails.filter((t) => t.life > 0);
    this.feed = this.feed.filter((f) => f.t > 0);

    // Render-only state: shockwaves, HUD damage ghosts and post-process transients.
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const p of this.players) p.hpGhost = Math.max(p.hp, (p.hpGhost ?? 100) - dt * 60);
    this.boom = Math.max(0, this.boom - dt * 2.5);
    this.koPulse = Math.max(0, this.koPulse - dt * 1.8);
    const post = this.post;
    post.flash = Math.max(0, this.flashT) * 3 + this.boom * 0.04;
    post.aberration = POST.aberration + this.boom * 0.005 + this.koPulse * 0.0025;
    post.desaturate = this.koPulse * 0.3;
  }

  finish(winner) {
    this.state = 'matchover';
    this.host.sfx('win');
    const rows = [...this.players]
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
      .map((p) => ({ name: p.name, color: p.color, values: [p.wins, p.kills] }));
    this.result = {
      title: `${winner.name} wins!`,
      color: winner.color,
      subtitle: `First to ${WINS_NEEDED} rounds · ${this.round} rounds played`,
      columns: ['Rounds', 'Kills'],
      rows,
    };
  }

  /* --------------------------------------------------------------- CPU */
  // True if a body of the given radius can't stand at (x, y).
  blockedAt(x, y, r = R) {
    if (x < 24 + r || x > W - 24 - r || y < TOP + 24 + r || y > H - 24 - r) return true;
    for (const w of this.solids) if (circleRect(x, y, r, w)) return true;
    for (const k of this.barrels) if (dist(x, y, k.x, k.y) < r + BARREL_R) return true;
    return false;
  }

  // Pick the free direction that best heads to the goal.
  steer(p, b, gx, gy) {
    const goalAngle = Math.atan2(gy - p.y, gx - p.x);
    let best = b.dir;
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      if (this.blockedAt(p.x + Math.cos(a) * 30, p.y + Math.sin(a) * 30, R + 4)) continue;
      const score = Math.cos(a - goalAngle) + Math.cos(a - b.dir) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    b.dir = best;
    return best;
  }

  // A nearby spot the target can't see, cached for a moment.
  findCover(p, target, b) {
    if (b.coverT > 0 && b.cover) return b.cover;
    b.coverT = 1.2;
    b.cover = null;
    let bestD = Infinity;
    for (const radius of [100, 180, 260]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        const x = p.x + Math.cos(a) * radius;
        const y = p.y + Math.sin(a) * radius;
        if (this.blockedAt(x, y) || !lineBlocked(x, y, target.x, target.y, this.solids, 20)) continue;
        const d = radius - dist(x, y, target.x, target.y) * 0.1;
        if (d < bestD) {
          bestD = d;
          b.cover = { x, y };
        }
      }
      if (b.cover) break;
    }
    return b.cover;
  }

  bot(p) {
    const dt = this.dt;
    const b = (p.brain ??= { t: 0, jitter: 0, dir: Math.random() * TAU, dashT: rand(1, 3), phase: 'fire', phaseT: 1, strafe: 1, seenT: 0, coverT: 0, cover: null, target: null });
    b.t -= dt;
    b.dashT -= dt;
    b.phaseT -= dt;
    b.coverT -= dt;
    const out = (x, y, a, dash) => ({ x, y, a, b: dash, aPressed: a, bPressed: dash });

    // Dodge incoming fire with a sideways dash.
    if (p.dashCd <= 0 && b.dashT <= 0) {
      for (const bl of this.bullets) {
        if (bl.owner === p) continue;
        const dx = p.x - bl.x;
        const dy = p.y - bl.y;
        if (dx * dx + dy * dy > 220 * 220) continue;
        const sp = Math.hypot(bl.vx, bl.vy);
        if ((dx * bl.vx + dy * bl.vy) / sp <= 0) continue;
        if (Math.abs(dx * bl.vy - dy * bl.vx) / sp > R + 8) continue;
        b.dashT = rand(1.2, 3);
        if (Math.random() < 0.55) {
          let a = Math.atan2(bl.vy, bl.vx) + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
          if (this.blockedAt(p.x + Math.cos(a) * 90, p.y + Math.sin(a) * 90)) a += Math.PI;
          return out(Math.cos(a), Math.sin(a), false, true);
        }
        break;
      }
    }

    // Stuck-breaker: no progress and no hits for a while, so wander somewhere new.
    b.anchorT = (b.anchorT ?? 2.5) - dt;
    if (b.anchorT <= 0) {
      b.anchorT = 2.5;
      if (b.ax !== undefined && dist(p.x, p.y, b.ax, b.ay) < 70 && this.time - (p.lastDealt ?? -99) > 2.5) {
        b.wanderT = 1.4;
        b.wx = rand(80, W - 80);
        b.wy = rand(TOP + 80, H - 80);
      }
      b.ax = p.x;
      b.ay = p.y;
    }
    if (b.wanderT > 0) {
      b.wanderT -= dt;
      const a = this.steer(p, b, b.wx, b.wy);
      return out(Math.cos(a), Math.sin(a), false, false);
    }

    const enemies = this.players.filter((o) => o !== p && o.alive);
    if (!enemies.length) return IDLE;
    // Re-think the target now and then: visible enemies are preferred.
    if (b.t <= 0 || !b.target?.alive) {
      b.t = rand(0.3, 0.8);
      b.jitter = rand(-0.12, 0.12);
      let best = Infinity;
      for (const o of enemies) {
        const score = dist(p.x, p.y, o.x, o.y) - (lineBlocked(p.x, p.y, o.x, o.y, this.solids, 20) ? 0 : 400);
        if (score < best) {
          best = score;
          b.target = o;
        }
      }
    }
    const target = b.target;
    const d = dist(p.x, p.y, target.x, target.y);
    const sees = !lineBlocked(p.x, p.y, target.x, target.y, this.solids, 20);
    b.seenT = sees ? b.seenT + dt : 0;
    const w = WEAPONS[p.weapon];

    // Pick a goal other than the fight: health, a better gun, shield, or cover.
    let goal = null;
    if (p.hp < 45) goal = nearest(p, this.pickups.filter((k) => k.type === 'health'));
    if (!goal && p.weapon === 'rifle') {
      const gun = nearest(
        p,
        this.pickups.filter((k) => PICKUPS[k.type].weapon),
      );
      if (gun && dist(p.x, p.y, gun.x, gun.y) < (sees ? 260 : 700)) goal = gun;
    }
    if (!goal && p.shield <= 0) {
      const sh = nearest(
        p,
        this.pickups.filter((k) => k.type === 'shield'),
      );
      if (sh && dist(p.x, p.y, sh.x, sh.y) < 260) goal = sh;
    }
    // Hide while reloading or when outmatched, but never for too long.
    b.braveT = (b.braveT ?? 0) - dt;
    if (!goal && sees && b.braveT <= 0 && (p.reloadT > 0 || (p.hp < 35 && target.hp >= p.hp)) && d < 700) {
      const cover = this.findCover(p, target, b);
      b.hideT = (b.hideT ?? 0) + dt;
      if (b.hideT > 2.5) {
        b.hideT = 0;
        b.braveT = 4;
      }
      if (cover) {
        if (dist(p.x, p.y, cover.x, cover.y) < 16) return IDLE;
        goal = cover;
      }
    }
    if (goal) {
      const a = this.steer(p, b, goal.x, goal.y);
      return out(Math.cos(a), Math.sin(a), false, false);
    }

    if (sees) {
      // Lead the target a little; better yet, shoot a barrel next to them.
      let ax = target.x + target.vx * (d / w.speed) * 0.6;
      let ay = target.y + target.vy * (d / w.speed) * 0.6;
      for (const k of this.barrels) {
        if (k.armed || dist(k.x, k.y, target.x, target.y) > 110 || dist(k.x, k.y, p.x, p.y) < 220) continue;
        if (!lineBlocked(p.x, p.y, k.x, k.y, this.solids, 20)) {
          ax = k.x;
          ay = k.y;
          break;
        }
      }
      const aim = Math.atan2(ay - p.y, ax - p.x) + b.jitter * (p.weapon === 'sniper' ? 0.25 : 1);
      const ideal = { shotgun: 150, smg: 260, rifle: 340, sniper: 620 }[p.weapon];

      if (b.phase === 'move') {
        if (b.phaseT <= 0) {
          b.phase = 'fire';
          b.phaseT = rand(0.7, 1.4) * (p.weapon === 'sniper' ? 2 : 1);
        }
        // Strafe sideways between bursts.
        let a = aim + b.strafe * (Math.PI / 2);
        if (this.blockedAt(p.x + Math.cos(a) * 40, p.y + Math.sin(a) * 40)) {
          b.strafe = -b.strafe;
          a = aim + b.strafe * (Math.PI / 2);
        }
        return out(Math.cos(a), Math.sin(a), false, false);
      }
      if (b.phaseT <= 0) {
        b.phase = 'move';
        b.phaseT = rand(0.25, 0.55);
        if (Math.random() < 0.5) b.strafe = -b.strafe;
      }
      const m = p.weapon === 'sniper' ? 0.26 : d > ideal ? 0.7 : 0.26;
      const tol = p.weapon === 'sniper' ? 0.06 : p.weapon === 'shotgun' ? 0.25 : 0.18;
      const aligned = Math.abs(angleDiff(p.angle, aim)) < tol;
      const inRange = p.weapon !== 'shotgun' || d < 330;
      const fire = aligned && inRange && b.seenT > 0.25;
      return out(Math.cos(aim) * m, Math.sin(aim) * m, fire, false);
    }

    const a = this.steer(p, b, target.x, target.y);
    return out(Math.cos(a), Math.sin(a), false, false);
  }

  /* ------------------------------------------------------------ Render */
  /*
   * Frame order: lit scene (floor → bodies → things tall enough to occlude
   * them) → light map multiply → additive emissives (bloom in post) → overlay
   * text → HUD.
   */
  render(ctx) {
    ctx.save();
    if (this.shake > 0) ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));

    // Floor level
    ctx.drawImage(this.ground, 0, 0, W, H);
    this.drawTrails(ctx, false);
    for (const k of this.pickups) ctx.drawImage(this.padArt, k.x - 26, k.y - 26, 52, 52);
    this.drawShadows(ctx);
    this.drawCasings(ctx);

    // Bodies, then everything taller that may overlap them from behind.
    for (const p of this.players) if (p.alive) this.drawPlayer(ctx, p);
    this.drawProps(ctx);
    ctx.drawImage(this.wallArt, 0, 0, W, H);
    this.drawDebris(ctx);
    this.drawSmoke(ctx);

    this.buildLights();
    this.lightMap.apply(ctx, 0, 0, W, H);

    // Emissive pass: neon, holograms, tracers and flashes.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.trimArt, 0, 0, W, H);
    for (const k of this.pickups) this.drawPickupHolo(ctx, k);
    this.drawGhosts(ctx);
    for (const p of this.players) if (p.alive) this.drawPlayerGlow(ctx, p);
    this.drawPropGlow(ctx);
    this.drawTrails(ctx, true);
    this.drawBullets(ctx);
    for (const p of this.players) if (p.alive && p.muzzle > 0) this.drawMuzzle(ctx, p);
    this.drawFlashes(ctx);
    this.drawSparks(ctx);
    ctx.restore();

    // Overlay: tags and numbers stay readable whatever the lighting.
    for (const p of this.players) if (p.alive) this.drawTags(ctx, p);
    for (const n of this.numbers) {
      const a = clamp(n.life * 2.5, 0, 1);
      text(ctx, n.txt, n.x + 1.5, n.y + 2, { size: n.size, color: 'rgba(0,0,0,0.65)', alpha: a });
      text(ctx, n.txt, n.x, n.y, { size: n.size, color: n.color, alpha: a });
    }
    ctx.restore();

    this.drawHud(ctx);
    this.drawFeed(ctx);

    if (this.state === 'countdown') {
      const n = Math.ceil(this.stateT);
      banner(ctx, n > 0 ? String(n) : 'FIGHT!', `Round ${this.round}`, { color: '#fff' });
    }
    if (this.state === 'roundover' || this.state === 'matchover') {
      const w = this.roundWinner;
      const title = this.state === 'matchover' ? `${w.name} wins the match!` : w ? `${w.name} takes round ${this.round}` : 'Draw!';
      banner(ctx, title, this.state === 'matchover' ? '' : 'Next round starting…', { color: w?.color ?? '#fff' });
    }
  }

  // Ambient + baked lamps/neon, then everything that moves or flashes.
  buildLights() {
    const L = this.lightMap;
    const g = L.begin(W, H, AMBIENT);
    g.drawImage(this.staticLight, 0, 0, W, H);
    const [fx, fy] = LAMPS[FLICKER];
    const dying = Math.sin(this.time * 1.7) > 0.93 || Math.sin(this.time * 0.37) > 0.985;
    L.light(fx, fy, 380, LAMP, 0.85 * (dying ? rand(0.15, 0.8) : 1));
    for (const p of this.players) {
      if (!p.alive) continue;
      const ca = Math.cos(p.angle);
      const sa = Math.sin(p.angle);
      L.light(p.x, p.y, 140, '#cfe2ff', 0.42);
      L.cone(p.x + ca * 16, p.y + sa * 16, p.angle, 0.7, 360, '#e9f3ff', 0.4);
    }
    for (const k of this.pickups) L.light(k.x, k.y, 120, PICKUPS[k.type].color, 0.45 + Math.sin(k.t * 5) * 0.1);
    for (let i = 0; i < this.bullets.length && i < 90; i++) {
      const b = this.bullets[i];
      L.light(b.x, b.y, b.weapon === 'sniper' ? 90 : 60, b.owner.color, 0.35);
    }
    for (const k of this.barrels) {
      if (k.armed) L.light(k.x, k.y, 200, '#ffb347', 1);
      else if (k.hp < BARREL_HP * 0.6) L.light(k.x, k.y, 130, '#ff8a3b', 0.45 + rand(0.2));
    }
    for (const l of this.lights) L.light(l.x, l.y, l.r * 1.5, l.color, Math.min(1, (l.life / l.max) * 1.3));
  }

  drawShadows(ctx) {
    const s = this.shadowArt;
    for (const c of this.crates) ctx.drawImage(this.crateShadow, c.x - 24 + 5, c.y - 24 + 8);
    for (const k of this.barrels) ctx.drawImage(s, k.x - BARREL_R - 7 + 4, k.y - BARREL_R - 7 + 6, (BARREL_R + 7) * 2, (BARREL_R + 7) * 2);
    for (const p of this.players) if (p.alive) ctx.drawImage(s, p.x - R - 7 + 4, p.y - R - 7 + 6, (R + 7) * 2, (R + 7) * 2);
  }

  drawCasings(ctx) {
    // Batch by colour: one stroke per colour keeps hundreds of casings cheap.
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'butt';
    for (const color of ['#d4a743', '#c2410c']) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const c of this.casings) {
        if (c.color !== color) continue;
        const y = c.y - c.z * 0.6;
        const dx = (Math.cos(c.rot) * c.len) / 2;
        const dy = (Math.sin(c.rot) * c.len) / 2;
        ctx.moveTo(c.x - dx, y - dy);
        ctx.lineTo(c.x + dx, y + dy);
      }
      ctx.stroke();
    }
  }

  drawPlayer(ctx, p) {
    const w = WEAPONS[p.weapon];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    if (p.reloadT > 0) {
      // Gun dips while reloading.
      ctx.save();
      ctx.rotate(0.5);
      drawGun(ctx, w, 3);
      ctx.restore();
    } else drawGun(ctx, w, p.kick);
    ctx.drawImage(p.sprite, -36, -36, 72, 72);
    ctx.restore();
  }

  // Crates and barrels as 2.5D solids: camera-facing sides, then the lid.
  drawProps(ctx) {
    const cs = CRATE * (1 + CRATE_F);
    for (const c of this.crates) {
      const x = c.x + (c.hit > 0 ? rand(-1.5, 1.5) : 0);
      drawBoxSides(ctx, x, c.y, CRATE, CRATE, CRATE_F, CRATE_SIDES);
      ctx.drawImage(this.crateArt[c.hp < CRATE_HP / 2 ? 1 : 0], liftX(x, CRATE_F), liftY(c.y, CRATE_F), cs, cs);
    }
    const rs = (BARREL_R + 2) * (1 + BARREL_F);
    ctx.lineCap = 'round';
    for (const k of this.barrels) {
      const x = k.x + (k.hit > 0 || k.armed ? rand(-2, 2) : 0);
      const tx = liftX(x, BARREL_F);
      const ty = liftY(k.y, BARREL_F);
      ctx.strokeStyle = '#6a1410';
      ctx.lineWidth = BARREL_R * 2;
      ctx.beginPath();
      ctx.moveTo(x, k.y);
      ctx.lineTo(tx + 0.01, ty);
      ctx.stroke();
      // Rolling hoops peeking out on the camera side
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1.5;
      for (const t of [0.35, 0.7]) {
        ctx.beginPath();
        ctx.arc(x + (tx - x) * t, k.y + (ty - k.y) * t, BARREL_R - 0.5, 0, TAU);
        ctx.stroke();
      }
      ctx.drawImage(this.barrelArt, tx - rs, ty - rs, rs * 2, rs * 2);
    }
  }

  drawDebris(ctx) {
    for (const p of this.particles.list) {
      const a = Math.max(0, p.life / p.max);
      if (DEBRIS.has(p.color)) {
        p.rot ??= rand(TAU); // visual only
        const s = p.size;
        ctx.save();
        ctx.globalAlpha = Math.min(1, a * 2);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot + p.life * 14);
        ctx.fillStyle = p.color;
        ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.9);
        ctx.fillStyle = 'rgba(255,230,190,0.25)';
        ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.25);
        ctx.restore();
      } else if (p.color === DUST) {
        const r = p.size * 3 + (1 - a) * 10;
        ctx.globalAlpha = a * 0.35;
        ctx.drawImage(this.smokeArt[0], p.x - r, p.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawSmoke(ctx) {
    for (const s of this.smoke) {
      ctx.globalAlpha = Math.min(1, s.life / s.max) * 0.75;
      const r = s.r * 1.25;
      ctx.drawImage(this.smokeArt[s.v ?? 0], s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // Sniper trails: a lit smoke line, plus a brief hot ion core in the glow pass.
  drawTrails(ctx, glow) {
    ctx.lineCap = 'round';
    for (const t of this.trails) {
      const k = t.life / 0.5;
      if (glow) {
        if (k < 0.55) continue;
        ctx.globalAlpha = (k - 0.55) / 0.45;
        ctx.strokeStyle = '#a5f3fc';
        ctx.lineWidth = 2;
      } else {
        ctx.globalAlpha = 0.32 * k;
        ctx.strokeStyle = '#c8d4e6';
        ctx.lineWidth = 3 + (1 - k) * 12;
      }
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Additive hologram over the emitter pad.
  drawPickupHolo(ctx, k) {
    const info = PICKUPS[k.type];
    const pulse = 0.75 + Math.sin(k.t * 5) * 0.25;
    ctx.strokeStyle = info.color;
    ctx.globalAlpha = 0.3 * pulse;
    ctx.lineWidth = 6;
    hexPath(ctx, k.x, k.y, 14);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * pulse;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.translate(k.x, k.y - 4 + Math.sin(k.t * 3) * 2.5);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = info.color;
    if (info.weapon) {
      const w = WEAPONS[k.type];
      ctx.rotate(-0.5);
      ctx.translate(-(10 + w.len / 2), 0);
      drawGun(ctx, w, 0, info.color);
    } else if (k.type === 'health') {
      ctx.fillRect(-3, -9, 6, 18);
      ctx.fillRect(-9, -3, 18, 6);
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.6;
      ctx.fillRect(-1, -7, 2, 14);
      ctx.fillRect(-7, -1, 14, 2);
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(8, 0);
      ctx.lineTo(0, 10);
      ctx.lineTo(-8, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 0);
      ctx.lineTo(0, 5);
      ctx.lineTo(-4, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (info.weapon) text(ctx, WEAPONS[k.type].label, k.x, k.y + 32, { size: 13, color: info.color, spacing: 2, alpha: 0.9 });
  }

  drawGhosts(ctx) {
    for (const g of this.ghosts) {
      const art = this.ghostArt.get(g.sprite);
      if (!art) continue;
      ctx.save();
      ctx.globalAlpha = (g.life / 0.28) * 0.35;
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.drawImage(art, -36, -36, 72, 72);
      ctx.restore();
    }
  }

  // Colour halo, NVG lenses, hit flash and the shield bubble.
  drawPlayerGlow(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.shield > 0) {
      const a = 0.55 + Math.sin(this.time * 8) * 0.15;
      ctx.strokeStyle = '#22d3ee';
      ctx.globalAlpha = a * 0.25;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(0, 0, R + 9, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Rotating facets
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const s = this.time * 1.6 + (i / 3) * TAU;
        ctx.moveTo(Math.cos(s) * (R + 9), Math.sin(s) * (R + 9));
        ctx.arc(0, 0, R + 9, s, s + 0.6);
      }
      ctx.stroke();
    }
    ctx.rotate(p.angle);
    ctx.globalAlpha = 0.65;
    ctx.drawImage(p.rim, -36, -36, 72, 72);
    if (p.flash > 0) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(p.flashArt, -36, -36, 72, 72);
    }
    ctx.restore();
  }

  drawPropGlow(ctx) {
    for (const k of this.barrels) {
      const tx = liftX(k.x, BARREL_F);
      const ty = liftY(k.y, BARREL_F);
      if (k.armed) drawGlow(ctx, tx, ty, 48, '#ffb347', 0.8 + rand(0.2), 0.3);
      else if (k.hp < BARREL_HP * 0.6) drawGlow(ctx, tx + 5, ty - 5, 24, '#ff7a2b', 0.45 + Math.sin(this.time * 23 + k.x) * 0.12 + rand(0.15), 0.1);
    }
  }

  drawBullets(ctx) {
    for (const b of this.bullets) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const ux = b.vx / sp;
      const uy = b.vy / sp;
      const sniper = b.weapon === 'sniper';
      const tail = Math.min(b.travel, sniper ? 110 : 34);
      const tx = b.x - ux * tail;
      const ty = b.y - uy * tail;
      const w = sniper ? 2.6 : 2;
      // Soft sheath in the shooter's colour, then a hot core.
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = b.owner.color;
      taper(ctx, b.x, b.y, tx, ty, -uy * w * 1.8, ux * w * 1.8);
      ctx.globalAlpha = 1;
      ctx.fillStyle = WEAPONS[b.weapon].color;
      taper(ctx, b.x, b.y, tx, ty, -uy * w * 0.6, ux * w * 0.6);
      ctx.drawImage(glowSprite(b.owner.color, 64, 0.2), b.x - 10, b.y - 10, 20, 20);
    }
  }

  drawMuzzle(ctx, p) {
    const w = WEAPONS[p.weapon];
    const big = w.id === 'shotgun' || w.id === 'sniper';
    const art = this.muzzleArt[big ? 1 : 0];
    const mx = 12 + w.len;
    const s = rand(0.8, 1.15);
    const aw = (art.width / ART) * s;
    const ah = (art.height / ART) * s;
    const gr = big ? 34 : 22;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.drawImage(glowSprite('#ffb347', 128, 0.2), mx - gr, -gr, gr * 2, gr * 2);
    ctx.drawImage(art, mx - 4 * s, -ah / 2, aw, ah);
    ctx.restore();
  }

  // Light glows (the light map does the real illumination) and shockwaves.
  drawFlashes(ctx) {
    for (const l of this.lights) {
      const r = l.r * 0.5;
      ctx.globalAlpha = (l.life / l.max) * 0.55;
      ctx.drawImage(glowSprite(l.color), l.x - r, l.y - r, r * 2, r * 2);
    }
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      const rad = 10 + r.r * 1.15 * (1 - (1 - t) ** 3);
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2 + 12 * (1 - t);
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = (1 - t) * 0.6;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad * 0.94, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Sparks streak along their velocity; slow embers become soft glows.
  drawSparks(ctx) {
    ctx.lineCap = 'round';
    for (const p of this.particles.list) {
      if (DEBRIS.has(p.color) || p.color === DUST) continue;
      const sp = Math.hypot(p.vx, p.vy);
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      if (sp > 90) {
        const k = Math.min(0.045, 26 / sp);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.9;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * k, p.y - p.vy * k);
        ctx.stroke();
      } else {
        const r = p.size * 2.6;
        ctx.drawImage(glowSprite(p.color, 64, 0.25), p.x - r, p.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawTags(ctx, p) {
    const w = WEAPONS[p.weapon];
    const bw = 44;
    const x = p.x - bw / 2;
    const y = p.y - R - 17;
    const hp = clamp(p.hp, 0, 100) / 100;
    meter(ctx, x, y, bw, 4, hp, hp > 0.5 ? '#22d36b' : hp > 0.25 ? '#facc15' : '#ff3b5c', { segments: 4, glow: false, back: 'rgba(0,0,0,0.6)' });
    if (p.shield > 0) meter(ctx, x, y - 4, bw, 2, p.shield / 50, '#22d3ee', { glow: false, back: 'rgba(0,0,0,0.45)' });
    const name = p.name.toUpperCase();
    text(ctx, name, p.x + 1, p.y - R - 29, { size: 14, color: 'rgba(0,0,0,0.7)', spacing: 1.5 });
    text(ctx, name, p.x, p.y - R - 30, { size: 14, color: '#f1f4ff', spacing: 1.5 });

    if (p.reloadT > 0) {
      const t = 1 - p.reloadT / w.reload;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 13, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,244,255,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 13, -Math.PI / 2, -Math.PI / 2 + t * TAU);
      ctx.stroke();
    }

    // Ammo readout under special weapons, or when running low.
    let ammo = null;
    if (p.reloadT > 0) ammo = 'RELOADING';
    else if (p.weapon !== 'rifle') ammo = `${w.label} ${p.mag}/${p.reserve}`;
    else if (p.mag <= 4) ammo = `${p.mag}/${w.mag}`;
    if (ammo) {
      const color = p.mag <= 2 && p.reloadT <= 0 ? '#ff8a8a' : '#dfe6f5';
      text(ctx, ammo, p.x + 1, p.y + R + 18, { size: 13, weight: 600, color: 'rgba(0,0,0,0.7)', spacing: 1.5 });
      text(ctx, ammo, p.x, p.y + R + 17, { size: 13, weight: 600, color, spacing: 1.5 });
    }
  }

  drawHud(ctx) {
    glassPanel(ctx, W / 2 - 100, 10, 200, 50, { r: 8, accent: rgba(NEON, 0.9), accentSide: 'bottom' });
    text(ctx, `ROUND ${this.round}`, W / 2, 30, { size: 26, spacing: 4 });
    text(ctx, `FIRST TO ${WINS_NEEDED}`, W / 2, 49, { size: 12, weight: 600, color: 'rgba(200,215,235,0.6)', spacing: 3 });

    const n = this.players.length;
    const slot = Math.min(170, (W / 2 - 160) / Math.ceil(n / 2));
    const cw = slot - 10;
    this.players.forEach((p, i) => {
      const left = i % 2 === 0;
      const k = Math.floor(i / 2);
      const x = left ? 30 + k * slot : W - 30 - (k + 1) * slot + 10;
      const align = left ? 'left' : 'right';
      const tx = left ? x + 14 : x + cw - 14;
      ctx.save();
      ctx.globalAlpha = p.alive || this.state !== 'fight' ? 1 : 0.4;
      glassPanel(ctx, x, 10, cw, 50, { r: 8, accent: p.color, accentSide: align });
      const name = p.name.length > 11 ? `${p.name.slice(0, 10)}…` : p.name;
      text(ctx, name.toUpperCase(), tx, 25, { size: 16, align, color: '#eef2ff', spacing: 1 });

      // Round wins as slanted pips on the far side of the card.
      for (let w = 0; w < WINS_NEEDED; w++) {
        const px = left ? x + cw - 12 - (WINS_NEEDED - w) * 13 : x + 12 + w * 13;
        ctx.fillStyle = w < p.wins ? p.color : 'rgba(255,255,255,0.14)';
        ctx.beginPath();
        ctx.moveTo(px + 3, 20);
        ctx.lineTo(px + 12, 20);
        ctx.lineTo(px + 9, 27);
        ctx.lineTo(px, 27);
        ctx.closePath();
        ctx.fill();
      }

      // Health bar and weapon
      const mw = cw * 0.52;
      meter(ctx, left ? tx : tx - mw, 40, mw, 5, p.alive ? p.hp / 100 : 0, p.color, { ghost: p.alive ? p.hpGhost / 100 : null, segments: 5, glow: false });
      const label = !p.alive ? 'K.O.' : WEAPONS[p.weapon].label;
      const color = !p.alive ? '#ff5f6d' : p.weapon === 'rifle' ? 'rgba(200,210,230,0.55)' : PICKUPS[p.weapon].color;
      text(ctx, label, left ? x + cw - 12 : x + 12, 43, { size: 12, align: left ? 'right' : 'left', color, spacing: 1.5 });
      ctx.restore();
    });
  }

  drawFeed(ctx) {
    if (!this.feed.length) return;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const nameFont = `700 17px "${HUD_FONT}", system-ui, sans-serif`;
    const tagFont = `600 12px "${HUD_FONT}", system-ui, sans-serif`;
    let y = TOP + 40;
    for (const f of this.feed) {
      const killer = f.killer && f.killer !== f.victim ? f.killer : null;
      const parts = killer
        ? [
            [killer.name.toUpperCase(), killer.color, nameFont],
            [f.label, '#8f9ab0', tagFont],
            [f.victim.name.toUpperCase(), f.victim.color, nameFont],
          ]
        : [
            [f.label, '#8f9ab0', tagFont],
            [f.victim.name.toUpperCase(), f.victim.color, nameFont],
          ];
      ctx.letterSpacing = '1px';
      const widths = parts.map(([s, , font]) => {
        ctx.font = font;
        return ctx.measureText(s).width;
      });
      const gap = 12;
      const total = widths.reduce((s, v) => s + v, 0) + gap * (parts.length - 1);
      let x = W - 40 - total;
      ctx.globalAlpha = clamp(f.t, 0, 1);
      glassPanel(ctx, x - 14, y - 15, total + 28, 30, { r: 6, alpha: 0.55, accent: killer ? killer.color : '#8f9ab0' });
      parts.forEach(([s, c, font], k) => {
        ctx.font = font;
        ctx.fillStyle = c;
        ctx.fillText(s, x, y + 1);
        x += widths[k] + gap;
      });
      y += 36;
    }
    ctx.restore();
  }
}

export default {
  id: 'strike-arena',
  title: 'Strike Arena',
  art: 'shooter',
  genre: 'Shooting',
  accent: '#8b93ff',
  tagline: 'Tactical arena shooting with ricochets, explosive barrels and loot. Be the last one standing.',
  minPlayers: 2,
  maxPlayers: 8,
  cpu: true,
  controls: { move: 'Move & aim', a: 'Shoot', b: 'Dash' },
  howTo: [
    'You aim where you move — hold A to fire. Spray widens your spread; short bursts stay accurate.',
    'Guns have magazines and reload on their own. Rifle bullets ricochet once off walls.',
    'Dash with B: you slip through bullets mid-dash (short cooldown).',
    'Grab loot: SMG, shotgun, sniper, + health, ◆ shield. Shoot crates for drops.',
    'Red barrels explode — shoot them when enemies are close.',
    `Last one standing wins the round. First to ${WINS_NEEDED} rounds wins.`,
  ],
  post: POST,
  create: (opts) => new StrikeArena(opts),
};
