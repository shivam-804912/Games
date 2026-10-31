import { mulberry32, shade } from '../utils/random.js';
import { HUD_FONT, LightMap, drawGlow, glassPanel, glowSprite, hexToRgb, meter, rgba } from './engine/fx.js';
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
  dist,
  lerp,
  makeCanvas,
  pick,
  rand,
  randInt,
  splitViews,
  text,
  turnToward,
} from './engine/util.js';

/*
 * City Adventure — co-op open world. Run or drive around a living neon
 * city (traffic lights, traffic, pedestrians, dusk turning into night),
 * pick up packages and deliver them before the shift clock runs out.
 * Every player gets their own split-screen view with a GPS radar.
 */

const WORLD_W = 3200;
const WORLD_H = 2400;
const ROAD = 120;
const HALF = ROAD / 2;
const ROADS_X = Array.from({ length: 8 }, (_, i) => 200 + i * 400);
const ROADS_Y = Array.from({ length: 6 }, (_, i) => 200 + i * 400);
const LANE = 24; // traffic lane offset from the centre line
const PARK = 55; // parked cars sit half up on the curb
const STOP = HALF + 52; // where NPC cars wait, clear of the crosswalk
const EXIT = 74;
const SIDEWALK = HALF + 9;
const GAME_TIME = 150;
const PERSON_R = 13;
const MS = 0.25; // scale of the minimap canvas
const CELL = 100; // collision grid cell size
const GW = WORLD_W / CELL;
const GH = WORLD_H / CELL;
const LIGHT_CYCLE = 15;
const NPC_CARS = 16;
const PEDS = 44;
const COMBO_TIME = 35;
const BEAM_W = 230;
const BEAM_H = 150;

const CAR_COLORS = ['#ff4d7d', '#38bdf8', '#facc15', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#e5e7eb'];
const SHIRTS = ['#f87171', '#60a5fa', '#fbbf24', '#34d399', '#c084fc', '#f472b6', '#e5e7eb', '#fb923c', '#2dd4bf'];
const SKINS = ['#f1c7a3', '#d9a27a', '#a8714f', '#7a4b31', '#ffd9b8'];

// Handling for each vehicle class. `r` is the radius of the two collision
// circles that make up the body; `cap` is how many packages fit inside.
const VEHICLES = {
  sedan: { len: 56, wid: 28, r: 14, max: 400, boost: 590, accel: 1.9, turn: 3.4, grip: 9, mass: 1, cap: 1, hp: 100, label: 'Sedan' },
  sport: { len: 54, wid: 26, r: 13, max: 470, boost: 680, accel: 2.5, turn: 3.9, grip: 7.5, mass: 0.85, cap: 1, hp: 70, label: 'Sports car' },
  van: { len: 68, wid: 32, r: 16, max: 320, boost: 470, accel: 1.4, turn: 2.7, grip: 11, mass: 1.7, cap: 2, hp: 160, label: 'Van' },
};

const JOB_TYPES = {
  normal: { color: '#22d3ee', label: 'PARCEL', mult: 1 },
  express: { color: '#facc15', label: 'EXPRESS', mult: 1.3 },
  fragile: { color: '#ff5fc8', label: 'FRAGILE', mult: 1.6 },
};
const jobColor = (job) => JOB_TYPES[job.type].color;
const money = (v) => (v < 0 ? `-$${-v}` : `$${v}`);

/* ---------------------------------------------------------------- World */

const ROOF = [
  ['#4a4f6e', '#30344c'],
  ['#3d5170', '#283850'],
  ['#56486e', '#382e4c'],
  ['#3a5a60', '#263e44'],
  ['#4e4c5a', '#34333e'],
];
const NEON = ['#ff3fa4', '#38d9ff', '#a78bfa', '#facc15', '#22d36b'];

function buildCity(seed) {
  const rand01 = mulberry32(seed);
  const solids = [
    { x: 0, y: 0, w: WORLD_W, h: ROADS_Y[0] - HALF },
    { x: 0, y: ROADS_Y.at(-1) + HALF, w: WORLD_W, h: WORLD_H - ROADS_Y.at(-1) - HALF },
    { x: 0, y: 0, w: ROADS_X[0] - HALF, h: WORLD_H },
    { x: ROADS_X.at(-1) + HALF, y: 0, w: WORLD_W - ROADS_X.at(-1) - HALF, h: WORLD_H },
  ];
  const buildings = [];
  const parks = [];
  const blocks = [];

  for (let i = 0; i < ROADS_X.length - 1; i++) {
    for (let j = 0; j < ROADS_Y.length - 1; j++) {
      const bx = ROADS_X[i] + HALF;
      const by = ROADS_Y[j] + HALF;
      const size = 400 - ROAD;
      const park = rand01() < 0.16;
      blocks.push({ x: bx, y: by, w: size, h: size, park });
      if (park) {
        parks.push({ x: bx, y: by, w: size, h: size });
        continue;
      }
      const m = 18;
      const inner = size - m * 2;
      const split = rand01();
      const cells =
        split < 0.3
          ? [[0, 0, 1, 1]]
          : split < 0.6
            ? rand01() < 0.5
              ? [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]
              : [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]
            : [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
      for (const [cx, cy, cw, ch] of cells) {
        const gap = 6;
        const rect = {
          x: bx + m + cx * inner + (cx > 0 ? gap : 0),
          y: by + m + cy * inner + (cy > 0 ? gap : 0),
          w: cw * inner - (cells.length > 1 ? gap : 0),
          h: ch * inner - (cells.length > 1 ? gap : 0),
        };
        const hue = Math.floor(rand01() * 5);
        // h3 = how tall the building is (parallax factor for its walls).
        const h3 = 0.05 + rand01() * 0.08;
        buildings.push({
          ...rect,
          hue,
          detail: Math.floor(rand01() * 4),
          neon: rand01() < 0.45,
          neonCol: NEON[Math.floor(rand01() * NEON.length)],
          h3,
          floors: 3 + Math.floor(h3 * 30),
          wallV: shade(ROOF[hue][0], -0.3),
          wallH: shade(ROOF[hue][0], -0.5),
        });
        solids.push(rect);
      }
    }
  }

  // Street lamps on the curbs, two per road segment on alternating sides.
  const lamps = [];
  for (const y of ROADS_Y) {
    for (let i = 0; i < ROADS_X.length - 1; i++) {
      const x0 = ROADS_X[i] + HALF;
      const len = ROADS_X[i + 1] - HALF - x0;
      lamps.push({ x: x0 + len / 3, y: y - HALF - 5 }, { x: x0 + (len * 2) / 3, y: y + HALF + 5 });
    }
  }
  for (const x of ROADS_X) {
    for (let j = 0; j < ROADS_Y.length - 1; j++) {
      const y0 = ROADS_Y[j] + HALF;
      const len = ROADS_Y[j + 1] - HALF - y0;
      lamps.push({ x: x + HALF + 5, y: y0 + len / 3 }, { x: x - HALF - 5, y: y0 + (len * 2) / 3 });
    }
  }
  return { solids, buildings, parks, blocks, lamps, rand01 };
}

/* ------------------------------------------------------------------ Art */

// Window atlas: one cell is a single window column on a single floor (texture px).
const WIN_CW = 10;
const WIN_FH = 14;
const WIN_COLS = 64;
const WIN_ROWS = 24;
const RS = 0.5; // resolution of the wet-road reflection layer
const CS = 2; // car sprites are rendered at 2x so they stay crisp when upscaled
const POLE = 0.035; // parallax of lamp posts and signal masts
const RAIN = 160; // rain streaks per view
// Light-map ambient: blue hour at the start of the shift, deep night at the end.
const DUSK_AMBIENT = [150, 130, 186];
const NIGHT_AMBIENT = [56, 62, 122];
const DUSK_TINT = [40, 8, -26];
const SIGNAL_COLORS = { g: '#3dff8a', y: '#ffd23d', r: '#ff3b4f' };
const WALLS = ['#4d5378', '#41597a', '#5c4c7c', '#3c5f6a', '#57546a'];
const LEAF_A = ['#173f2b', '#226b41', '#3b9156'];
const LEAF_B = ['#163a35', '#1f6253', '#36906f'];
const BLOSSOM = ['#5a1f48', '#9a3f78', '#d77bb0'];

const hash = (v) => {
  const s = Math.sin(v) * 43758.5453;
  return s - Math.floor(s);
};

// Additive glow; the caller switches to 'lighter' once for a whole batch.
function glow(ctx, x, y, r, color, a) {
  ctx.globalAlpha = a;
  ctx.drawImage(glowSprite(color, 64, 0.12), x - r, y - r, r * 2, r * 2);
}

// Soft round blob (`rgb` like '0,0,0') used for wear, AO and smoke.
function softSprite(rgb, size = 64) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const h = size / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.5, `rgba(${rgb},0.45)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

// Purely visual extras (true heights, window offsets, signs, antennas, lamp
// styles) from their own RNG, so the street layout stays identical to the seed.
function decorateCity(city) {
  const r = mulberry32(7331);
  for (const b of city.buildings) {
    // Parallax factor for the 2.5D extrusion; a few towers rise above the rest.
    const t = (b.h3 - 0.05) / 0.08;
    b.ht = 0.05 + t * t * 0.09 + (r() < 0.14 ? 0.045 : 0);
    b.storeys = clamp(Math.round(b.ht * 80), 4, 16);
    const base = WALLS[b.hue];
    b.faces = { n: shade(base, -0.42), s: shade(base, 0.08), e: shade(base, -0.18), w: shade(base, -0.3) };
    b.win = [
      Math.floor(r() * (WIN_COLS - 26)),
      Math.floor(r() * (WIN_ROWS - 16)),
      Math.floor(r() * (WIN_COLS - 26)),
      Math.floor(r() * (WIN_ROWS - 16)),
    ];
    b.sign = b.neon ? { u: 0.15 + r() * 0.55, v: r() < 0.5, len: 0.35 + r() * 0.35, col: NEON[Math.floor(r() * NEON.length)], flicker: r() < 0.3 } : null;
    if (r() < 0.4 || b.ht > 0.12) {
      const corner = b.detail === 0; // keep clear of the helipad
      b.antenna = {
        x: corner ? b.x + 12 : b.x + b.w * (0.2 + r() * 0.6),
        y: corner ? b.y + 12 : b.y + b.h * (0.2 + r() * 0.6),
        h: 0.25 + r() * 0.35,
        phase: r() * TAU,
      };
    }
  }
  city.lamps.forEach((l, i) => {
    l.white = i % 3 === 0; // a mix of sodium and LED street lights
    // The pole stands on the curb; the luminaire hangs out over the lane.
    const road = ROADS_Y.find((y) => Math.abs(l.y - y) < HALF + 10);
    if (road !== undefined) {
      l.ax = 0;
      l.ay = Math.sign(road - l.y);
    } else {
      l.ax = Math.sign(ROADS_X.find((x) => Math.abs(l.x - x) < HALF + 10) - l.x);
      l.ay = 0;
    }
    l.lx = l.x + l.ax * 22;
    l.ly = l.y + l.ay * 22;
  });
}

// Every stretch of road between two intersections.
function roadSegments() {
  const segs = [];
  for (const y of ROADS_Y) for (let i = 0; i < ROADS_X.length - 1; i++) segs.push({ h: true, c: y, a: ROADS_X[i] + HALF, b: ROADS_X[i + 1] - HALF });
  for (const x of ROADS_X) for (let j = 0; j < ROADS_Y.length - 1; j++) segs.push({ h: false, c: x, a: ROADS_Y[j] + HALF, b: ROADS_Y[j + 1] - HALF });
  return segs;
}

// Point on a segment: `t` along it, `o` across from the centre line.
const segPoint = (s, t, o) => (s.h ? { x: s.a + (s.b - s.a) * t, y: s.c + o } : { x: s.c + o, y: s.a + (s.b - s.a) * t });

// The static street layer. Colours here are the "albedo": the light map
// turns them into night, so they are painted fairly evenly lit.
function paintCity(city) {
  const c = makeCanvas(WORLD_W, WORLD_H);
  const g = c.getContext('2d');
  const r = mulberry32(4242);
  const dark = softSprite('0,0,0');
  const lite = softSprite('255,255,255');
  const segs = roadSegments();
  const segLine = (s, o, inset) => {
    if (s.h) {
      g.moveTo(s.a + inset, s.c + o);
      g.lineTo(s.b - inset, s.c + o);
    } else {
      g.moveTo(s.c + o, s.a + inset);
      g.lineTo(s.c + o, s.b - inset);
    }
  };

  // Asphalt: blue-black with broad wear patches and fine grit.
  g.fillStyle = '#2d2b38';
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let k = 0; k < 520; k++) {
    const s = 60 + r() * 240;
    const l = r() < 0.3;
    g.globalAlpha = l ? 0.03 + r() * 0.04 : 0.1 + r() * 0.14;
    g.drawImage(l ? lite : dark, r() * WORLD_W - s / 2, r() * WORLD_H - s / 2, s, s * (0.4 + r() * 0.8));
  }
  g.globalAlpha = 1;
  for (let k = 0; k < 16000; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.14)';
    g.fillRect(r() * WORLD_W, r() * WORLD_H, 2, 2);
  }

  // Tar-sealed cracks and puddles (puddles also get a sheen in the reflection layer).
  city.puddles = [];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of segs) {
    g.strokeStyle = 'rgba(8,7,16,0.45)';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 0; k < 3; k++) {
      let p = segPoint(s, r(), (r() - 0.5) * (ROAD - 20));
      g.moveTo(p.x, p.y);
      for (let q = 0; q < 5; q++) {
        p = { x: p.x + (r() - 0.5) * 26, y: p.y + (r() - 0.5) * 26 };
        g.lineTo(p.x, p.y);
      }
    }
    g.stroke();
    for (let k = 0; k < 3; k++) {
      const p = segPoint(s, 0.08 + r() * 0.84, (r() - 0.5) * (ROAD - 30));
      const along = 16 + r() * 30;
      const across = 6 + r() * 10;
      const pw = s.h ? along : across;
      const ph = s.h ? across : along;
      city.puddles.push({ x: p.x, y: p.y, w: pw, h: ph });
      g.fillStyle = 'rgba(6,6,18,0.4)';
      g.beginPath();
      g.ellipse(p.x, p.y, pw, ph, 0, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(130,140,255,0.06)';
      g.beginPath();
      g.ellipse(p.x - pw * 0.15, p.y - ph * 0.2, pw * 0.6, ph * 0.5, 0, 0, TAU);
      g.fill();
    }
    // Manhole on one of the lanes
    if (r() < 0.6) {
      const p = segPoint(s, 0.2 + r() * 0.6, (r() < 0.5 ? -1 : 1) * LANE);
      g.fillStyle = '#1c1b25';
      g.beginPath();
      g.arc(p.x, p.y, 9, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(160,160,185,0.4)';
      g.lineWidth = 1.5;
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      for (let q = -6; q <= 6; q += 3) {
        const half = Math.sqrt(64 - q * q);
        g.moveTo(p.x - half, p.y + q);
        g.lineTo(p.x + half, p.y + q);
      }
      g.stroke();
    }
    // Storm drain in the gutter
    const d = segPoint(s, 0.3 + r() * 0.4, (r() < 0.5 ? -1 : 1) * (HALF - 4));
    g.fillStyle = '#121119';
    if (s.h) g.fillRect(d.x - 9, d.y - 2.5, 18, 5);
    else g.fillRect(d.x - 2.5, d.y - 9, 5, 18);
  }

  // Lane markings: double yellow centre line, white edge lines, lane arrows.
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(240,188,56,0.85)';
  g.lineWidth = 2.2;
  g.beginPath();
  for (const s of segs) {
    segLine(s, -3.5, 22);
    segLine(s, 3.5, 22);
  }
  g.stroke();
  g.strokeStyle = 'rgba(235,235,250,0.4)';
  g.lineWidth = 1.6;
  g.beginPath();
  for (const s of segs) {
    segLine(s, -(HALF - 9), 18);
    segLine(s, HALF - 9, 18);
  }
  g.stroke();
  g.fillStyle = 'rgba(235,235,250,0.42)';
  for (let ix = 0; ix < ROADS_X.length; ix++) {
    for (let iy = 0; iy < ROADS_Y.length; iy++) {
      for (const d of approaches(ix, iy)) {
        const rt = rightOf(d);
        g.save();
        g.translate(ROADS_X[ix] - d.x * (HALF + 70) + rt.x * LANE, ROADS_Y[iy] - d.y * (HALF + 70) + rt.y * LANE);
        g.rotate(Math.atan2(d.y, d.x));
        g.beginPath();
        g.moveTo(14, 0);
        g.lineTo(4, -7);
        g.lineTo(4, -2.5);
        g.lineTo(-14, -2.5);
        g.lineTo(-14, 2.5);
        g.lineTo(4, 2.5);
        g.lineTo(4, 7);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
  }

  // Intersections: zebra crosswalks with worn paint, stop lines
  for (let ix = 0; ix < ROADS_X.length; ix++) {
    for (let iy = 0; iy < ROADS_Y.length; iy++) {
      const x = ROADS_X[ix];
      const y = ROADS_Y[iy];
      g.fillStyle = 'rgba(0,0,0,0.14)';
      g.fillRect(x - HALF, y - HALF, ROAD, ROAD);
      g.fillStyle = 'rgba(236,236,248,0.62)';
      for (let k = -HALF + 8; k <= HALF - 15; k += 12) {
        g.fillRect(x + k, y - HALF - 17, 7, 16);
        g.fillRect(x + k, y + HALF + 1, 7, 16);
        g.fillRect(x - HALF - 17, y + k, 16, 7);
        g.fillRect(x + HALF + 1, y + k, 16, 7);
      }
      g.fillStyle = 'rgba(20,18,30,0.5)';
      for (let k = 0; k < 70; k++) {
        const side = Math.floor(r() * 4);
        const along = (r() - 0.5) * ROAD;
        const depth = HALF + 1 + r() * 16;
        const px = side < 2 ? x + along : x + (side === 2 ? -depth : depth);
        const py = side < 2 ? y + (side === 0 ? -depth : depth) : y + along;
        g.fillRect(px, py, 2 + r() * 3, 2 + r() * 3);
      }
      g.strokeStyle = 'rgba(240,240,252,0.62)';
      g.lineWidth = 4;
      g.beginPath();
      for (const d of approaches(ix, iy)) {
        const rt = rightOf(d);
        const sx = x - d.x * (HALF + 21);
        const sy = y - d.y * (HALF + 21);
        g.moveTo(sx + rt.x * 3, sy + rt.y * 3);
        g.lineTo(sx + rt.x * (HALF - 4), sy + rt.y * (HALF - 4));
      }
      g.stroke();
    }
  }

  // Blocks: paving slabs, curb lip and gutter, inner lot
  for (const b of city.blocks) {
    g.fillStyle = '#56546a';
    g.fillRect(b.x, b.y, b.w, b.h);
    for (let k = 0; k < 40; k++) {
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.09)';
      const t = Math.floor(r() * (b.w / 20)) * 20;
      const side = Math.floor(r() * 4);
      if (side === 0) g.fillRect(b.x + t, b.y, 20, 18);
      else if (side === 1) g.fillRect(b.x + t, b.y + b.h - 18, 20, 18);
      else if (side === 2) g.fillRect(b.x, b.y + t, 18, 20);
      else g.fillRect(b.x + b.w - 18, b.y + t, 18, 20);
    }
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 20; k < b.w; k += 20) {
      g.moveTo(b.x + k, b.y);
      g.lineTo(b.x + k, b.y + 18);
      g.moveTo(b.x + k, b.y + b.h - 18);
      g.lineTo(b.x + k, b.y + b.h);
      g.moveTo(b.x, b.y + k);
      g.lineTo(b.x + 18, b.y + k);
      g.moveTo(b.x + b.w - 18, b.y + k);
      g.lineTo(b.x + b.w, b.y + k);
    }
    g.stroke();
    g.fillStyle = b.park ? '#20402f' : '#33313f';
    g.fillRect(b.x + 18, b.y + 18, b.w - 36, b.h - 36);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 3;
    g.strokeRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
    g.strokeStyle = '#8a88a0';
    g.lineWidth = 2.5;
    g.strokeRect(b.x + 1.25, b.y + 1.25, b.w - 2.5, b.h - 2.5);
  }

  // Ambient occlusion where the towers meet the ground
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 24;
  g.fillStyle = '#121119';
  for (const b of city.buildings) g.fillRect(b.x, b.y, b.w, b.h);
  g.restore();

  // Beyond the barrier: dark, distant rooftops
  for (const s of city.solids.slice(0, 4)) {
    g.save();
    g.beginPath();
    g.rect(s.x, s.y, s.w, s.h);
    g.clip();
    g.fillStyle = '#0d0c15';
    g.fillRect(s.x, s.y, s.w, s.h);
    for (let k = 0; k < (s.w * s.h) / 4000; k++) {
      const w = 20 + r() * 70;
      const h = 20 + r() * 70;
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.35)';
      g.fillRect(s.x + r() * s.w - w / 2, s.y + r() * s.h - h / 2, w, h);
    }
    g.restore();
  }
  const ix0 = ROADS_X[0] - HALF;
  const iy0 = ROADS_Y[0] - HALF;
  const ix1 = ROADS_X.at(-1) + HALF;
  const iy1 = ROADS_Y.at(-1) + HALF;
  g.strokeStyle = '#4a4858';
  g.lineWidth = 6;
  g.strokeRect(ix0 - 3, iy0 - 3, ix1 - ix0 + 6, iy1 - iy0 + 6);
  g.fillStyle = 'rgba(255,190,70,0.75)';
  for (let x = ix0 + 20; x < ix1; x += 48) {
    g.fillRect(x, iy0 - 4, 6, 2);
    g.fillRect(x, iy1 + 2, 6, 2);
  }
  for (let y = iy0 + 20; y < iy1; y += 48) {
    g.fillRect(ix0 - 4, y, 2, 6);
    g.fillRect(ix1 + 2, y, 2, 6);
  }

  paintParks(g, city, r, dark);
  // Rooftops. These are painted at ground level and lifted into place at
  // render time, so the 2.5D buildings reuse this art.
  for (const b of city.buildings) paintRoof(g, b, r);
  return c;
}

// Parks: lawn, paths, a fountain plaza and layered tree canopies.
function paintParks(g, city, r, dark) {
  for (const p of city.parks) {
    const x = p.x + 18;
    const y = p.y + 18;
    const w = p.w - 36;
    const h = p.h - 36;
    const mx = p.x + p.w / 2;
    const my = p.y + p.h / 2;
    g.fillStyle = '#20402f';
    g.fillRect(x, y, w, h);
    for (let k = 0; k < 2200; k++) {
      g.fillStyle = r() < 0.5 ? 'rgba(150,230,150,0.06)' : 'rgba(0,0,0,0.14)';
      g.fillRect(x + r() * w, y + r() * h, 2, 2);
    }
    g.globalAlpha = 0.15;
    for (let k = 0; k < 14; k++) {
      const s = 40 + r() * 80;
      g.drawImage(dark, x + r() * w - s / 2, y + r() * h - s / 2, s, s);
    }
    g.globalAlpha = 1;
    // Hedge border
    g.strokeStyle = '#183324';
    g.lineWidth = 8;
    g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    g.strokeStyle = 'rgba(120,200,130,0.12)';
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    // Paved paths with crisp edges
    g.strokeStyle = '#4c4a5a';
    g.lineWidth = 16;
    g.beginPath();
    g.moveTo(x, my);
    g.lineTo(x + w, my);
    g.moveTo(mx, y);
    g.lineTo(mx, y + h);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1;
    g.beginPath();
    for (const o of [-8, 8]) {
      g.moveTo(x, my + o);
      g.lineTo(x + w, my + o);
      g.moveTo(mx + o, y);
      g.lineTo(mx + o, y + h);
    }
    g.stroke();
    // Plaza and fountain
    g.fillStyle = '#5a586a';
    g.beginPath();
    g.arc(mx, my, 46, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 2;
    g.stroke();
    const water = g.createRadialGradient(mx, my, 4, mx, my, 28);
    water.addColorStop(0, '#2b86ad');
    water.addColorStop(1, '#123a55');
    g.fillStyle = water;
    g.beginPath();
    g.arc(mx, my, 28, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(170,235,255,0.3)';
    g.lineWidth = 1.2;
    for (const rr of [10, 17, 23]) {
      g.beginPath();
      g.arc(mx, my, rr, 0, TAU);
      g.stroke();
    }
    g.strokeStyle = '#9a98ae';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(mx, my, 30, 0, TAU);
    g.stroke();
    // Benches beside the paths
    g.fillStyle = '#6e5440';
    for (const s of [-1, 1]) {
      g.fillRect(mx + s * 72 - 8, my - 15, 16, 5);
      g.fillRect(mx + 10, my + s * 72 - 8, 5, 16);
    }
    for (let t = 0; t < 18; t++) {
      const tx = x + 16 + r() * (w - 32);
      const ty = y + 16 + r() * (h - 32);
      if (Math.abs(tx - mx) < 30 || Math.abs(ty - my) < 30) continue;
      const k = r();
      paintTree(g, tx, ty, 12 + r() * 10, k < 0.15 ? BLOSSOM : k < 0.55 ? LEAF_A : LEAF_B, r, dark);
    }
  }
}

// Three canopy layers, each smaller and shifted toward the light, over a soft shadow.
function paintTree(g, x, y, tr, pal, r, dark) {
  g.globalAlpha = 0.6;
  g.drawImage(dark, x - tr * 1.7, y - tr * 1.7 + 4, tr * 3.4, tr * 3.4);
  g.globalAlpha = 1;
  for (let layer = 0; layer < 3; layer++) {
    const n = 6 - layer * 2;
    const rr = tr * (0.62 - layer * 0.14);
    const off = layer * tr * 0.14;
    const d = tr * (0.38 - layer * 0.1);
    g.fillStyle = pal[layer];
    g.beginPath();
    g.moveTo(x - off + rr, y - off);
    g.arc(x - off, y - off, rr, 0, TAU);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + r() * 0.6;
      const bx = x - off + Math.cos(a) * d;
      const by = y - off + Math.sin(a) * d;
      g.moveTo(bx + rr, by);
      g.arc(bx, by, rr, 0, TAU);
    }
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.1)';
  g.beginPath();
  g.arc(x - tr * 0.35, y - tr * 0.35, tr * 0.18, 0, TAU);
  g.fill();
}

function paintRoof(g, b, r) {
  const [top, bottom] = ROOF[b.hue];
  const grad = g.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(b.x, b.y, b.w, b.h);
  // Membrane seams and grit
  g.strokeStyle = 'rgba(255,255,255,0.04)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = b.x + 22; x < b.x + b.w - 10; x += 22) {
    g.moveTo(x, b.y + 8);
    g.lineTo(x, b.y + b.h - 8);
  }
  g.stroke();
  for (let k = 0; k < (b.w * b.h) / 250; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
    g.fillRect(b.x + r() * b.w, b.y + r() * b.h, 2, 2);
  }
  // A raised box with a contact shadow and a lit top-left edge.
  const box = (x, y, w, h, col, lift = 3) => {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(x + lift, y + lift, w, h);
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(x, y, w, 1.5);
    g.fillRect(x, y, 1.5, h);
  };
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (b.detail === 0) {
    // Helipad
    const R = Math.min(b.w, b.h) * 0.3;
    g.fillStyle = '#262833';
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(250,204,21,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, R - 5, 0, TAU);
    g.stroke();
    const s = R * 0.42;
    g.fillStyle = 'rgba(240,240,250,0.85)';
    g.fillRect(cx - s * 0.7, cy - s, s * 0.3, s * 2);
    g.fillRect(cx + s * 0.4, cy - s, s * 0.3, s * 2);
    g.fillRect(cx - s * 0.7, cy - s * 0.15, s * 1.4, s * 0.3);
  } else if (b.detail === 1) {
    // Rows of AC units
    const cols = Math.min(4, Math.floor((b.w - 28) / 28));
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < cols; k++) {
        const x = b.x + 16 + k * 28;
        const y = b.y + 16 + row * 28;
        box(x, y, 20, 20, '#7a8096');
        g.fillStyle = '#262833';
        g.beginPath();
        g.arc(x + 10, y + 10, 7, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(200,205,225,0.5)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(x + 5, y + 10);
        g.lineTo(x + 15, y + 10);
        g.moveTo(x + 10, y + 5);
        g.lineTo(x + 10, y + 15);
        g.stroke();
      }
    }
  } else if (b.detail === 2) {
    // Glass skylights
    for (let yy = b.y + 16; yy < b.y + b.h - 26; yy += 20) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(b.x + 16, yy, b.w - 32, 12);
      g.fillStyle = 'rgba(90,150,215,0.42)';
      g.fillRect(b.x + 17, yy + 1, b.w - 34, 10);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      for (let xx = b.x + 30; xx < b.x + b.w - 18; xx += 14) {
        g.moveTo(xx, yy + 1);
        g.lineTo(xx, yy + 11);
      }
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(b.x + 17, yy + 1, b.w - 34, 2);
    }
  } else {
    // Water tank and its pipe run
    const tx = b.x + b.w * 0.7;
    const ty = b.y + b.h * 0.32;
    g.strokeStyle = '#5d5b70';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(tx - 14, ty);
    g.lineTo(b.x + 16, ty);
    g.lineTo(b.x + 16, b.y + b.h - 16);
    g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.arc(tx + 4, ty + 5, 15, 0, TAU);
    g.fill();
    const tg = g.createRadialGradient(tx - 5, ty - 5, 2, tx, ty, 15);
    tg.addColorStop(0, '#a3a0b8');
    tg.addColorStop(1, '#4c4a5e');
    g.fillStyle = tg;
    g.beginPath();
    g.arc(tx, ty, 15, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1.5;
    for (const rr of [10, 5]) {
      g.beginPath();
      g.arc(tx, ty, rr, 0, TAU);
      g.stroke();
    }
  }
  // Stairwell housing
  if (b.detail !== 0) box(b.x + b.w - 46, b.y + b.h - 40, 30, 24, '#4c4f62', 4);
  // Vents
  for (let k = 0; k < 3; k++) {
    const vx = b.x + 14 + r() * (b.w - 64);
    const vy = b.y + b.h * 0.55 + r() * (b.h * 0.45 - 22);
    box(vx, vy, 8, 8, '#8a8ea6', 2);
  }
  // Parapet: bright lip, inner shadow
  g.strokeStyle = shade(top, 0.5);
  g.lineWidth = 3;
  g.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 4;
  g.strokeRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
}

// Wet-road reflections of street lights and neon (half resolution, additive).
function paintReflections(city) {
  const c = makeCanvas(WORLD_W * RS, WORLD_H * RS);
  const g = c.getContext('2d');
  g.scale(RS, RS);
  g.globalCompositeOperation = 'lighter';
  const smear = (x, y, w, h, color, a) => {
    g.globalAlpha = a;
    g.drawImage(glowSprite(color, 128, 0.08), x - w / 2, y - h / 2, w, h);
  };
  // Lamps streak across the wet lanes.
  for (const l of city.lamps) {
    const across = [l.ax ? 170 : 54, l.ax ? 54 : 170];
    smear(l.lx + l.ax * 26, l.ly + l.ay * 26, across[0], across[1], l.white ? '#9fc4ff' : '#ff9d4a', 0.5);
  }
  // Neon facades bleed onto the street beside them.
  for (const b of city.buildings) {
    if (!b.neon) continue;
    const blk = city.blocks.find((k) => b.x >= k.x && b.x < k.x + k.w && b.y >= k.y && b.y < k.y + k.h);
    if (!blk) continue;
    if (b.x - blk.x < 30) smear(blk.x - 34, b.y + b.h / 2, 70, b.h * 1.1, b.neonCol, 0.55);
    if (blk.x + blk.w - (b.x + b.w) < 30) smear(blk.x + blk.w + 34, b.y + b.h / 2, 70, b.h * 1.1, b.neonCol, 0.55);
    if (b.y - blk.y < 30) smear(b.x + b.w / 2, blk.y - 34, b.w * 1.1, 70, b.neonCol, 0.55);
    if (blk.y + blk.h - (b.y + b.h) < 30) smear(b.x + b.w / 2, blk.y + blk.h + 34, b.w * 1.1, 70, b.neonCol, 0.55);
  }
  for (const p of city.puddles) smear(p.x, p.y, p.w * 2.6, p.h * 2.6, '#7d6bff', 0.16);
  for (const p of city.parks) smear(p.x + p.w / 2, p.y + p.h / 2, 150, 150, '#38d9ff', 0.35);
  return c;
}

// Flat map used by the radar and the 3-player city map.
function paintMini(city) {
  const c = makeCanvas(WORLD_W * MS, WORLD_H * MS);
  const g = c.getContext('2d');
  g.scale(MS, MS);
  g.fillStyle = '#2f3760';
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (const b of city.blocks) {
    g.fillStyle = b.park ? '#123d2e' : '#141a30';
    g.fillRect(b.x, b.y, b.w, b.h);
  }
  g.fillStyle = '#1e2546';
  for (const b of city.buildings) g.fillRect(b.x, b.y, b.w, b.h);
  g.strokeStyle = 'rgba(120,150,255,0.22)';
  g.lineWidth = 4;
  for (const b of city.buildings) g.strokeRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
  g.fillStyle = '#05060c';
  for (const s of city.solids.slice(0, 4)) g.fillRect(s.x, s.y, s.w, s.h);
  return c;
}

// Facade textures shared by every building. `dim` is the glass and slabs
// (lit by the scene), `lit` holds only the lit windows (drawn additively).
function makeWindowAtlas() {
  const r = mulberry32(99);
  const w = WIN_COLS * WIN_CW;
  const h = WIN_ROWS * WIN_FH;
  const dim = makeCanvas(w, h);
  const lit = makeCanvas(w, h);
  const gd = dim.getContext('2d');
  const gl = lit.getContext('2d');
  for (let row = 0; row < WIN_ROWS; row++) {
    const y = row * WIN_FH;
    const busy = r(); // some floors are busier than others
    gd.fillStyle = 'rgba(255,255,255,0.08)';
    gd.fillRect(0, y, w, 1);
    gd.fillStyle = 'rgba(0,0,0,0.25)';
    gd.fillRect(0, y + 1, w, 1.5);
    for (let col = 0; col < WIN_COLS; col++) {
      const x = col * WIN_CW;
      gd.fillStyle = 'rgba(6,8,22,0.62)';
      gd.fillRect(x + 2, y + 4, WIN_CW - 4, WIN_FH - 6);
      gd.fillStyle = 'rgba(140,170,255,0.12)';
      gd.fillRect(x + 2, y + 4, WIN_CW - 4, 2);
      if (col % 4 === 0) {
        gd.fillStyle = 'rgba(0,0,0,0.22)';
        gd.fillRect(x, y, 1.5, WIN_FH);
      }
      if (r() < 0.1 + busy * 0.45) {
        const k = r();
        gl.globalAlpha = 0.45 + r() * 0.55;
        gl.fillStyle = k < 0.6 ? '#ffd79a' : k < 0.85 ? '#cfe8ff' : k < 0.93 ? '#ff8ad8' : '#7ff3ff';
        gl.fillRect(x + 2, y + 4, WIN_CW - 4, WIN_FH - 6);
      }
    }
  }
  return { dim, lit };
}

// Vertical gradient strip, stretched over a wall in its own texture space.
function makeWallTex(stops) {
  const c = makeCanvas(4, 64);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return c;
}

function makeBeam(rgb) {
  const c = makeCanvas(BEAM_W, BEAM_H);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(0, BEAM_H / 2, 4, 0, BEAM_H / 2, BEAM_W);
  grad.addColorStop(0, `rgba(${rgb},0.95)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.45)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, BEAM_H / 2 - 12);
  g.lineTo(BEAM_W, 0);
  g.lineTo(BEAM_W, BEAM_H);
  g.lineTo(0, BEAM_H / 2 + 12);
  g.closePath();
  g.fill();
  return c;
}

// Soft contact shadow under a car (blurred once, drawn every frame).
function makeCarShadow(kind) {
  const v = VEHICLES[kind];
  const pad = 18;
  const c = makeCanvas(v.len + pad * 2, v.wid + pad * 2);
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = 9;
  g.shadowOffsetX = 2000;
  g.fillStyle = '#000';
  g.beginPath();
  g.roundRect(pad - 2001, pad - 1, v.len + 2, v.wid + 2, 9);
  g.fill();
  return c;
}

function makeCoinSprite() {
  const c = makeCanvas(48, 48);
  const g = c.getContext('2d');
  g.translate(24, 24);
  const grad = g.createLinearGradient(-20, -20, 20, 20);
  grad.addColorStop(0, '#fff2b0');
  grad.addColorStop(0.45, '#ffc53d');
  grad.addColorStop(1, '#a8661a');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 20, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(120,70,10,0.8)';
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(0, 0, 14, 0, TAU);
  g.stroke();
  g.fillStyle = '#8a5a12';
  g.fillRect(-2, -11, 4, 22);
  g.fillRect(-7, -6, 14, 3.5);
  g.fillRect(-7, 2.5, 14, 3.5);
  return c;
}

// Top-down car sprite facing +x (4px margin), rendered at CS× resolution.
function makeCarSprite(kind, color) {
  const v = VEHICLES[kind];
  const L = v.len;
  const Wd = v.wid;
  const c = makeCanvas((L + 8) * CS, (Wd + 8) * CS);
  const g = c.getContext('2d');
  g.scale(CS, CS);
  g.translate(L / 2 + 4, Wd / 2 + 4);
  const rad = kind === 'van' ? 6 : kind === 'sport' ? 11 : 9;
  const body = (i = 0) => {
    g.beginPath();
    g.roundRect(-L / 2 + i, -Wd / 2 + i, L - i * 2, Wd - i * 2, Math.max(2, rad - i));
  };
  // Paint: the flanks curve away into shadow, the crown catches the light.
  const flank = g.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
  flank.addColorStop(0, shade(color, -0.55));
  flank.addColorStop(0.2, shade(color, -0.1));
  flank.addColorStop(0.42, shade(color, 0.3));
  flank.addColorStop(0.62, color);
  flank.addColorStop(1, shade(color, -0.6));
  g.fillStyle = flank;
  body();
  g.fill();
  const ends = g.createLinearGradient(-L / 2, 0, L / 2, 0);
  ends.addColorStop(0, 'rgba(0,0,0,0.4)');
  ends.addColorStop(0.1, 'rgba(0,0,0,0)');
  ends.addColorStop(0.9, 'rgba(0,0,0,0)');
  ends.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = ends;
  body();
  g.fill();

  // Glass: dark with a sky reflection, plus one sharp highlight streak.
  const glass = (x0, x1, i0, i1) => {
    const gr = g.createLinearGradient(x0, -Wd / 2, x1, Wd / 2);
    gr.addColorStop(0, '#2b3b62');
    gr.addColorStop(0.5, '#0b1020');
    gr.addColorStop(1, '#1a2440');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(x0, -Wd / 2 + i0);
    g.lineTo(x1, -Wd / 2 + i1);
    g.lineTo(x1, Wd / 2 - i1);
    g.lineTo(x0, Wd / 2 - i0);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * 0.3, -Wd / 2 + i0 + 1.5);
    g.lineTo(x0 + (x1 - x0) * 0.7, Wd / 2 - i1 - 3);
    g.stroke();
  };
  const roof = (x0, x1, i, col) => {
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(x0, -Wd / 2 + i, x1 - x0, Wd - i * 2, 3);
    g.fill();
    const rg = g.createLinearGradient(0, -Wd / 2 + i, 0, Wd / 2 - i);
    rg.addColorStop(0, 'rgba(255,255,255,0.28)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    rg.addColorStop(1, 'rgba(0,0,0,0.2)');
    g.fillStyle = rg;
    g.fill();
  };

  if (kind === 'van') {
    roof(-L / 2 + 3, L / 2 - 18, 3, shade(color, 0.12));
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = -L / 2 + 10; x < L / 2 - 22; x += 7) {
      g.moveTo(x, -Wd / 2 + 5);
      g.lineTo(x, Wd / 2 - 5);
    }
    g.stroke();
    glass(L / 2 - 17, L / 2 - 7, 4, 3);
  } else if (kind === 'sport') {
    glass(-1, 13, 6, 4);
    roof(-13, -1, 6, shade(color, -0.25));
    glass(-13, -18, 6, 6);
    // Racing stripes
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillRect(13, -3, L / 2 - 15, 2);
    g.fillRect(13, 1, L / 2 - 15, 2);
    g.fillRect(-L / 2 + 6, -3, 8, 2);
    g.fillRect(-L / 2 + 6, 1, 8, 2);
    // Spoiler
    g.fillStyle = shade(color, -0.65);
    g.fillRect(-L / 2 + 1, -Wd / 2 + 2, 4, Wd - 4);
  } else {
    glass(7, 18, 6, 4);
    roof(-12, 7, 5, shade(color, -0.08));
    glass(-12, -19, 6, 5);
    // Hood creases
    g.strokeStyle = 'rgba(0,0,0,0.2)';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(19, -Wd / 2 + 6);
    g.lineTo(L / 2 - 3, -Wd / 2 + 7);
    g.moveTo(19, Wd / 2 - 6);
    g.lineTo(L / 2 - 3, Wd / 2 - 7);
    g.stroke();
  }
  // Gloss: a long specular streak along the upper flank
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.roundRect(-L / 2 + 7, -Wd / 2 + 2.2, L - 18, 1.4, 0.7);
  g.fill();
  // Mirrors
  g.fillStyle = shade(color, -0.4);
  const mx = kind === 'van' ? L / 2 - 18 : kind === 'sport' ? 3 : 6;
  g.fillRect(mx, -Wd / 2 - 2, 4, 3);
  g.fillRect(mx, Wd / 2 - 1, 4, 3);
  // Lamps (unlit; the glow pass lights them)
  g.fillStyle = '#dfe6f2';
  g.beginPath();
  g.roundRect(L / 2 - 4.5, -Wd / 2 + 2.5, 3.5, 6, 1.5);
  g.roundRect(L / 2 - 4.5, Wd / 2 - 8.5, 3.5, 6, 1.5);
  g.fill();
  g.fillStyle = '#7a1424';
  g.beginPath();
  g.roundRect(-L / 2 + 0.5, -Wd / 2 + 2, 3, 7, 1);
  g.roundRect(-L / 2 + 0.5, Wd / 2 - 9, 3, 7, 1);
  g.fill();
  // Crisp outline
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 0.8;
  body(0.4);
  g.stroke();
  return c;
}

function buildGrid(solids) {
  const grid = Array.from({ length: GW * GH }, () => []);
  for (const s of solids) {
    const x0 = clamp(Math.floor(s.x / CELL), 0, GW - 1);
    const x1 = clamp(Math.floor((s.x + s.w) / CELL), 0, GW - 1);
    const y0 = clamp(Math.floor(s.y / CELL), 0, GH - 1);
    const y1 = clamp(Math.floor((s.y + s.h) / CELL), 0, GH - 1);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) grid[gy * GW + gx].push(s);
  }
  return grid;
}

/* --------------------------------------------------------------- Helpers */

const rightOf = (d) => ({ x: -d.y, y: d.x });
const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function nodePos(n) {
  return { x: ROADS_X[n.ix], y: ROADS_Y[n.iy] };
}

function validDirs(n) {
  return DIRS.filter((d) => {
    const ix = n.ix + d.x;
    const iy = n.iy + d.y;
    return ix >= 0 && ix < ROADS_X.length && iy >= 0 && iy < ROADS_Y.length;
  });
}

// Directions traffic can arrive at an intersection from.
function approaches(ix, iy) {
  return DIRS.filter((d) => {
    const fx = ix - d.x;
    const fy = iy - d.y;
    return fx >= 0 && fx < ROADS_X.length && fy >= 0 && fy < ROADS_Y.length;
  });
}

// Sidewalk corners: quadrant (sx, sy) around an intersection, if it is on a block.
function cornerOk(n, sx, sy) {
  return (sx < 0 ? n.ix > 0 : n.ix < ROADS_X.length - 1) && (sy < 0 ? n.iy > 0 : n.iy < ROADS_Y.length - 1);
}

function cornerPos(n, sx, sy) {
  return { x: ROADS_X[n.ix] + sx * SIDEWALK, y: ROADS_Y[n.iy] + sy * SIDEWALK };
}

// A random point on a sidewalk beside a road, between intersections.
function curbPoint() {
  if (Math.random() < 0.5) {
    const ix = randInt(0, ROADS_X.length - 1);
    const j = randInt(0, ROADS_Y.length - 2);
    const y = rand(ROADS_Y[j] + HALF + 40, ROADS_Y[j + 1] - HALF - 40);
    return { x: ROADS_X[ix] + pick([-1, 1]) * (HALF - 8), y };
  }
  const iy = randInt(0, ROADS_Y.length - 1);
  const i = randInt(0, ROADS_X.length - 2);
  const x = rand(ROADS_X[i] + HALF + 40, ROADS_X[i + 1] - HALF - 40);
  return { x, y: ROADS_Y[iy] + pick([-1, 1]) * (HALF - 8) };
}

function lanePoint() {
  const p = curbPoint();
  const onX = ROADS_X.some((x) => Math.abs(p.x - x) < HALF + 1);
  if (onX) {
    const x = ROADS_X.find((rx) => Math.abs(p.x - rx) < HALF + 1);
    return { x: x + pick([-1, 1]) * LANE, y: p.y };
  }
  const y = ROADS_Y.find((ry) => Math.abs(p.y - ry) < HALF + 1);
  return { x: p.x, y: y + pick([-1, 1]) * LANE };
}

const nearestIndex = (arr, v) => arr.reduce((best, a, i) => (Math.abs(a - v) < Math.abs(arr[best] - v) ? i : best), 0);

// Which road a point is on (vertical or horizontal) and its snap onto the centre line.
function roadOf(x, y) {
  const ix = nearestIndex(ROADS_X, x);
  const iy = nearestIndex(ROADS_Y, y);
  if (Math.abs(x - ROADS_X[ix]) <= Math.abs(y - ROADS_Y[iy])) {
    return { v: true, i: ix, snap: { x: ROADS_X[ix], y: clamp(y, ROADS_Y[0], ROADS_Y.at(-1)) } };
  }
  return { v: false, i: iy, snap: { x: clamp(x, ROADS_X[0], ROADS_X.at(-1)), y: ROADS_Y[iy] } };
}

// Best road (index) to cross over on, preferring the one nearest the start.
function crossIndex(arr, a, b) {
  let best = 0;
  let bestCost = Infinity;
  arr.forEach((v, i) => {
    const cost = Math.abs(a - v) + Math.abs(b - v) + Math.abs(a - v) * 0.01;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  });
  return best;
}

// GPS: a street route between two points on the road grid.
function gpsRoute(ax, ay, bx, by) {
  const A = roadOf(ax, ay);
  const B = roadOf(bx, by);
  const pts = [{ x: ax, y: ay }, A.snap];
  if (A.v && B.v) {
    if (A.i !== B.i) {
      const ry = ROADS_Y[crossIndex(ROADS_Y, A.snap.y, B.snap.y)];
      pts.push({ x: ROADS_X[A.i], y: ry }, { x: ROADS_X[B.i], y: ry });
    }
  } else if (!A.v && !B.v) {
    if (A.i !== B.i) {
      const rx = ROADS_X[crossIndex(ROADS_X, A.snap.x, B.snap.x)];
      pts.push({ x: rx, y: ROADS_Y[A.i] }, { x: rx, y: ROADS_Y[B.i] });
    }
  } else if (A.v) pts.push({ x: ROADS_X[A.i], y: ROADS_Y[B.i] });
  else pts.push({ x: ROADS_X[B.i], y: ROADS_Y[A.i] });
  pts.push(B.snap, { x: bx, y: by });
  return pts;
}

/* ------------------------------------------------------------------ Game */

class CityAdventure {
  constructor({ players, host }) {
    this.host = host;
    this.city = buildCity(20260);
    decorateCity(this.city);
    this.world = paintCity(this.city);
    this.worldG = this.world.getContext('2d');
    this.solids = this.city.solids;
    this.grid = buildGrid(this.solids);
    this.buildings = this.city.buildings;
    this.lamps = this.city.lamps;
    this.mini = paintMini(this.city);
    // Rendering resources: reflections, facade textures, light map, sprites
    this.reflect = paintReflections(this.city);
    this.atlas = makeWindowAtlas();
    this.wallShade = makeWallTex([
      [0, 'rgba(255,255,255,0.16)'],
      [0.05, 'rgba(255,255,255,0)'],
      [0.5, 'rgba(0,0,0,0.1)'],
      [1, 'rgba(0,0,0,0.55)'],
    ]);
    this.wallSpill = makeWallTex([
      [0, 'rgba(255,170,110,0)'],
      [0.55, 'rgba(255,170,110,0)'],
      [1, 'rgba(255,170,110,0.5)'],
    ]);
    this.lights = new LightMap(0.4);
    this.beam = makeBeam('255,240,214');
    this.coinSprite = makeCoinSprite();
    this.carShadows = Object.fromEntries(Object.keys(VEHICLES).map((k) => [k, makeCarShadow(k)]));
    this.neonBlds = this.buildings.filter((b) => b.neon);
    this.bldList = [];
    this.puffs = new Map();
    this.post = { flash: 0, flashColor: [1, 1, 1] };
    this.sprites = new Map();
    this.particles = new Particles();
    this.smoke = [];
    this.time = 0;
    this.shiftT = 0; // time on shift, drives the sunset
    this.clock = GAME_TIME;
    this.intro = 3;
    this.team = 0;
    this.deliveries = 0;
    this.combo = 0;
    this.comboT = 0;
    this.result = null;
    this.toasts = [];

    const spawn = { ix: 3, iy: 2 };
    const sp = nodePos(spawn);
    this.spawn = sp;
    this.players = players.map((p, i) => ({
      ...p,
      i,
      x: sp.x + (i % 2 ? 36 : -36),
      y: sp.y + (i < 2 ? -36 : 36),
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      car: null,
      stun: 0,
      cargo: [],
      boost: 1,
      drift: 0,
      flash: null,
      earned: 0,
      count: 0,
      coins: 0,
    }));

    this.cars = [];
    // Parked vehicles right next to the start so everyone can grab one.
    const startCars = [
      { kind: 'van', x: sp.x + PARK, y: sp.y - HALF - 100, angle: -Math.PI / 2 },
      { kind: 'sport', x: sp.x - PARK, y: sp.y + HALF + 100, angle: Math.PI / 2 },
      { kind: 'sedan', x: sp.x - HALF - 100, y: sp.y - PARK, angle: Math.PI },
      { kind: 'sedan', x: sp.x + HALF + 100, y: sp.y + PARK, angle: 0 },
    ];
    startCars.forEach((c, k) => this.addCar({ ...c, color: CAR_COLORS[k] }));
    for (let k = 0, tries = 0; k < 14 && tries < 200; tries++) {
      const p = curbPoint();
      const vertical = ROADS_X.some((x) => Math.abs(p.x - x) < HALF + 1);
      const road = vertical ? ROADS_X.find((x) => Math.abs(p.x - x) < HALF + 1) : ROADS_Y.find((y) => Math.abs(p.y - y) < HALF + 1);
      const side = vertical ? Math.sign(p.x - road) : Math.sign(p.y - road);
      const x = vertical ? road + side * PARK : p.x;
      const y = vertical ? p.y : road + side * PARK;
      if (dist(x, y, sp.x, sp.y) < 300 || this.cars.some((c) => dist(c.x, c.y, x, y) < 90)) continue;
      this.addCar({
        kind: Math.random() < 0.7 ? 'sedan' : 'sport',
        x,
        y,
        angle: vertical ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? 0 : Math.PI,
        color: pick(CAR_COLORS),
      });
      k++;
    }
    for (let k = 0; k < NPC_CARS; k++) this.addNpc(false);
    this.peds = [];
    for (let k = 0; k < PEDS; k++) {
      const ped = this.makePed();
      if (ped) this.peds.push(ped);
    }

    this.coins = Array.from({ length: 34 }, () => ({ ...lanePoint(), t: Math.random() * 10 }));
    this.jobs = [];
    const jobCount = this.players.length > 2 ? 4 : 3;
    for (let k = 0; k < jobCount; k++) this.jobs.push(this.newJob());

    const n = this.players.length;
    this.views = splitViews(n);
    this.zoom = n === 1 ? 1 : n === 2 ? 0.85 : 0.68;
  }

  addCar(c) {
    const kind = c.kind ?? 'sedan';
    const car = { kind, vx: 0, vy: 0, speed: 0, driver: null, npc: false, hp: VEHICLES[kind].hp, wrecked: false, daze: 0, braking: false, blink: 0, ...c };
    this.cars.push(car);
    return car;
  }

  addNpc(far) {
    for (let tries = 0; tries < 30; tries++) {
      const node = { ix: randInt(0, ROADS_X.length - 1), iy: randInt(0, ROADS_Y.length - 1) };
      const dir = pick(validDirs(node));
      const c = nodePos(node);
      const off = rightOf(dir);
      const along = rand(EXIT + 10, 400 - STOP - 20);
      const x = c.x + off.x * LANE + dir.x * along;
      const y = c.y + off.y * LANE + dir.y * along;
      if (this.cars.some((o) => dist(o.x, o.y, x, y) < 80)) continue;
      if (dist(x, y, this.spawn.x, this.spawn.y) < 200) continue;
      if (far && this.players.some((p) => dist(p.x, p.y, x, y) < 750)) continue;
      const r = Math.random();
      const car = this.addCar({
        kind: r < 0.2 ? 'van' : r < 0.32 ? 'sport' : 'sedan',
        x,
        y,
        angle: Math.atan2(dir.y, dir.x),
        color: pick(CAR_COLORS),
        npc: true,
        node,
        dir,
        phase: 'go',
        cruise: rand(130, 170),
      });
      car.speed = car.cruise * 0.6;
      car.vx = dir.x * car.speed;
      car.vy = dir.y * car.speed;
      this.npcNextTarget(car);
      return car;
    }
    return null;
  }

  npcNextTarget(car) {
    if (car.phase === 'go') {
      const off = rightOf(car.dir);
      car.node = { ix: car.node.ix + car.dir.x, iy: car.node.iy + car.dir.y };
      const c = nodePos(car.node);
      car.target = { x: c.x + off.x * LANE - car.dir.x * STOP, y: c.y + off.y * LANE - car.dir.y * STOP };
      // Decide the next turn now, so the car can signal it on approach.
      const options = validDirs(car.node).filter((d) => !(d.x === -car.dir.x && d.y === -car.dir.y));
      car.nextDir = pick(options.length ? options : validDirs(car.node));
      car.commit = false;
    } else {
      car.turnBlink = Math.sign(car.dir.x * car.nextDir.y - car.dir.y * car.nextDir.x);
      car.dir = car.nextDir;
      const c = nodePos(car.node);
      const o = rightOf(car.dir);
      car.target = { x: c.x + o.x * LANE + car.dir.x * EXIT, y: c.y + o.y * LANE + car.dir.y * EXIT };
    }
  }

  makePed() {
    for (let tries = 0; tries < 30; tries++) {
      const node = { ix: randInt(0, ROADS_X.length - 1), iy: randInt(0, ROADS_Y.length - 1) };
      const sx = pick([-1, 1]);
      const sy = pick([-1, 1]);
      if (!cornerOk(node, sx, sy)) continue;
      const ped = { node, sx, sy, vx: 0, vy: 0, speed: rand(38, 62), knock: 0, dodge: 0, scared: 0, wait: 0, step: rand(0, 10), angle: 0, shirt: pick(SHIRTS), skin: pick(SKINS) };
      const c = cornerPos(node, sx, sy);
      this.pedNext(ped, true);
      const t = ped.waiting ? 0 : Math.random();
      ped.x = c.x + (ped.target.x - c.x) * t;
      ped.y = c.y + (ped.target.y - c.y) * t;
      ped.angle = Math.atan2(ped.target.y - c.y, ped.target.x - c.x);
      return ped;
    }
    return null;
  }

  // Pick the pedestrian's next leg: along a block edge, or across a crosswalk.
  pedNext(ped, noCross = false) {
    const { node, sx, sy } = ped;
    const opts = [
      { w: 2, to: { node: { ix: node.ix + sx, iy: node.iy }, sx: -sx, sy } },
      { w: 2, to: { node: { ix: node.ix, iy: node.iy + sy }, sx, sy: -sy } },
    ];
    if (!noCross && cornerOk(node, -sx, sy)) opts.push({ w: 1.2, cross: 'ns', to: { node, sx: -sx, sy } });
    if (!noCross && cornerOk(node, sx, -sy)) opts.push({ w: 1.2, cross: 'ew', to: { node, sx, sy: -sy } });
    let roll = Math.random() * opts.reduce((s, o) => s + o.w, 0);
    let o = opts[0];
    for (const opt of opts) {
      roll -= opt.w;
      if (roll <= 0) {
        o = opt;
        break;
      }
    }
    ped.to = o.to;
    ped.cross = o.cross ?? null;
    ped.waiting = !!o.cross;
    ped.wait = 0;
    ped.target = cornerPos(o.to.node, o.to.sx, o.to.sy);
  }

  newJob() {
    const from = curbPoint();
    let to = curbPoint();
    for (let k = 0; k < 20 && dist(from.x, from.y, to.x, to.y) < 1100; k++) to = curbPoint();
    const d = dist(from.x, from.y, to.x, to.y);
    const r = Math.random();
    const type = r < 0.5 ? 'normal' : r < 0.75 ? 'express' : 'fragile';
    return {
      type,
      stage: 'pickup',
      x: from.x,
      y: from.y,
      dx: to.x,
      dy: to.y,
      carrier: null,
      reward: 100 + Math.round(d / 40),
      integrity: 100,
      limit: Math.round(9 + d / 80),
      timer: 0,
    };
  }

  toast(msg, color = '#fff') {
    this.toasts.push({ msg, color, t: 2.4 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  sprite(kind, color) {
    const key = `${kind}|${color}`;
    let s = this.sprites.get(key);
    if (!s) {
      s = makeCarSprite(kind, color);
      this.sprites.set(key, s);
    }
    return s;
  }

  // Traffic light state for one axis of an intersection: 'g', 'y' or 'r'.
  signal(ix, iy, axis) {
    const t = (this.time + ix * 2.7 + iy * 4.1) % LIGHT_CYCLE;
    const ns = t < 7.5;
    const yellow = (t >= 6 && t < 7.5) || t >= 13.5;
    if ((axis === 'ns') === ns) return yellow ? 'y' : 'g';
    return 'r';
  }

  darkness() {
    const t = clamp((this.shiftT - 30) / 75, 0, 1);
    return t * t * (3 - 2 * t) * 0.66;
  }

  dusk() {
    return clamp(1 - Math.abs(this.shiftT - 45) / 45, 0, 1);
  }

  clockLabel() {
    const mins = 17 * 60 + Math.floor(this.shiftT * 2);
    const h = Math.floor(mins / 60) % 24;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  capacity(p) {
    return p.car ? VEHICLES[p.car.kind].cap : 1;
  }

  // Resolve a circle against nearby solids (spatial grid). True if it hit.
  collideWorld(body, r) {
    let hit = false;
    const x0 = clamp(Math.floor((body.x - r) / CELL), 0, GW - 1);
    const x1 = clamp(Math.floor((body.x + r) / CELL), 0, GW - 1);
    const y0 = clamp(Math.floor((body.y - r) / CELL), 0, GH - 1);
    const y1 = clamp(Math.floor((body.y + r) / CELL), 0, GH - 1);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        for (const rect of this.grid[gy * GW + gx]) {
          const push = circleRect(body.x, body.y, r, rect);
          if (push) {
            body.x += push.x;
            body.y += push.y;
            hit = true;
          }
        }
      }
    }
    return hit;
  }

  free(x, y, r) {
    return !this.collideWorld({ x, y }, r);
  }

  // Is a point inside a car's footprint (plus padding)?
  touches(car, x, y, pad) {
    const v = VEHICLES[car.kind];
    const dx = x - car.x;
    const dy = y - car.y;
    if (Math.abs(dx) > 60 || Math.abs(dy) > 60) return false;
    const c = Math.cos(car.angle);
    const s = Math.sin(car.angle);
    return Math.abs(dx * c + dy * s) < v.len / 2 + pad && Math.abs(-dx * s + dy * c) < v.wid / 2 + pad;
  }

  nearPlayer(x, y, range) {
    return this.players.some((p) => Math.abs(p.x - x) < range && Math.abs(p.y - y) < range);
  }

  puff(x, y, { vx = 0, vy = 0, size = 8, life = 1.2, tone = 60, alpha = 0.5 } = {}) {
    if (this.smoke.length > 280) return;
    this.smoke.push({ x, y, vx: vx + rand(-12, 12), vy: vy + rand(-12, 12), size, life, max: life, tone, alpha });
  }

  /* ------------------------------------------------------------ Update */
  update(dt, inputs) {
    this.time += dt;
    this.particles.update(dt);
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.smoke[i] = this.smoke[this.smoke.length - 1];
        this.smoke.pop();
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 1 - dt;
      s.vy *= 1 - dt;
      s.size += dt * 14;
    }
    this.toasts = this.toasts.filter((t) => (t.t -= dt) > 0);
    for (const p of this.players) if (p.flash && (p.flash.t -= dt) <= 0) p.flash = null;
    if (this.result) return;

    if (this.intro > 0) this.intro -= dt;
    else {
      this.shiftT += dt;
      const before = Math.ceil(this.clock);
      this.clock -= dt;
      if (Math.ceil(this.clock) < before && this.clock <= 10 && this.clock > 0) this.host.sfx('count');
      if (this.clock <= 0) return this.finish();
    }
    if (this.comboT > 0 && (this.comboT -= dt) <= 0) this.combo = 0;

    for (const p of this.players) {
      const inp = inputs[p.i] ?? IDLE;
      if (p.car) this.drive(p, inp, dt);
      else this.walk(p, inp, dt);
    }
    for (const car of this.cars) {
      if (car.npc) this.updateNpc(car, dt);
      else if (!car.driver) this.coast(car, dt);
      this.carDamageFx(car, dt);
    }
    this.updatePeds(dt);
    this.carCollisions();
    this.hitPeople();
    this.updatePickups(dt);

    // Tow away old wrecks once nobody is looking, and keep traffic flowing.
    this.cars = this.cars.filter((c) => !c.wrecked || (c.wreckT -= dt) > 0 || this.nearPlayer(c.x, c.y, 600));
    if (this.cars.length < 48 && this.cars.filter((c) => c.npc).length < NPC_CARS && Math.random() < dt * 2) this.addNpc(true);
  }

  walk(p, inp, dt) {
    p.stun -= dt;
    p.boost = Math.min(1, p.boost + dt * 0.15);
    if (p.stun > 0) {
      p.vx *= 1 - dt * 4;
      p.vy *= 1 - dt * 4;
    } else {
      const m = Math.hypot(inp.x, inp.y);
      const speed = inp.a ? 330 : 215;
      const k = m > 1 ? 1 / m : 1;
      p.vx = inp.x * k * speed;
      p.vy = inp.y * k * speed;
      if (m > 0.2) p.angle = Math.atan2(inp.y, inp.x);
      if (inp.bPressed) {
        const car = this.cars
          .filter((c) => !c.driver && !c.wrecked && dist(c.x, c.y, p.x, p.y) < 70)
          .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
        if (car) {
          car.driver = p;
          car.npc = false;
          car.blink = 0;
          p.car = car;
          p.drift = 0;
          this.host.sfx('horn');
          return;
        }
      }
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    this.collideWorld(p, PERSON_R);
  }

  // Hop out on whichever side is free. Forced exits (wrecks) always succeed.
  exitCar(p, force) {
    const car = p.car;
    let placed = false;
    for (const side of [1, -1]) {
      const a = car.angle + (side * Math.PI) / 2;
      const spot = { x: car.x + Math.cos(a) * 38, y: car.y + Math.sin(a) * 38 };
      if (this.free(spot.x, spot.y, PERSON_R)) {
        p.x = spot.x;
        p.y = spot.y;
        placed = true;
        break;
      }
    }
    if (!placed && !force) return false;
    if (!placed) {
      p.x = car.x;
      p.y = car.y;
      this.collideWorld(p, PERSON_R);
    }
    car.driver = null;
    car.braking = false;
    p.car = null;
    p.vx = p.vy = 0;
    p.drift = 0;
    return true;
  }

  drive(p, inp, dt) {
    const car = p.car;
    const spec = VEHICLES[car.kind];
    const speed = Math.hypot(car.vx, car.vy);
    if (inp.bPressed && speed < 260 && this.exitCar(p, false)) return;

    const m = Math.min(1, Math.hypot(inp.x, inp.y));
    const boosting = inp.a && p.boost > 0.02 && m > 0.25;
    if (boosting && !p.wasBoosting) this.host.sfx('boost');
    p.wasBoosting = boosting;
    p.boost = boosting ? Math.max(0, p.boost - dt * 0.45) : Math.min(1, p.boost + dt * 0.12);
    if (boosting && Math.random() < 0.5) {
      this.particles.burst(car.x - Math.cos(car.angle) * spec.len * 0.55, car.y - Math.sin(car.angle) * spec.len * 0.55, {
        count: 1,
        color: '#38d9ff',
        speed: 60,
        life: 0.35,
        size: 5,
      });
    }

    // Damage saps top speed.
    const max = (boosting ? spec.boost : spec.max) * (0.55 + (0.45 * car.hp) / spec.hp);
    let braking = false;
    let sliding = false;
    let throttle = 0;
    if (m > 0.25) {
      const target = Math.atan2(inp.y, inp.x);
      const diff = angleDiff(car.angle, target);
      const fwd0 = car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
      if (Math.abs(diff) > 2.3 && fwd0 > 70) braking = true; // stick pulled back: brake
      else {
        const steer = clamp(0.3 + Math.abs(fwd0) / 200, 0.3, 1);
        car.angle += clamp(diff * 2.4, -1, 1) * spec.turn * steer * dt;
        sliding = Math.abs(diff) > 0.5 && fwd0 > 270; // hard turn at speed: the rear lets go
        throttle = m * (Math.abs(diff) > 1.6 ? 0.3 : 1);
      }
    }

    // Split velocity into forward and sideways parts in the new heading.
    // Sideways speed bleeds off with grip — less grip means a drift.
    const fx = Math.cos(car.angle);
    const fy = Math.sin(car.angle);
    let vF = car.vx * fx + car.vy * fy;
    let vR = -car.vx * fy + car.vy * fx;
    if (braking) vF = Math.max(0, vF - 950 * dt);
    else if (throttle > 0) vF += (throttle * max - vF) * Math.min(1, dt * spec.accel * (boosting ? 1.4 : 1));
    else vF *= 1 - dt * 1.1;
    vR *= Math.exp(-(sliding ? 2.2 : boosting ? spec.grip * 0.7 : spec.grip) * dt);
    car.vx = fx * vF - fy * vR;
    car.vy = fy * vF + fx * vR;
    car.braking = braking;

    this.moveCar(car, dt);
    if (!p.car) return; // wrecked in the crash
    this.skid(car, Math.abs(vR) > 60 || (braking && vF > 100));

    // Drift bonus: hold a slide, cash in when it ends.
    if (Math.abs(vR) > 70 && vF > 150) p.drift += dt;
    else if (p.drift > 0) {
      if (p.drift > 0.55) {
        const cash = Math.round(Math.min(4, p.drift) * 20);
        p.earned += cash;
        this.team += cash;
        p.flash = { msg: `DRIFT +$${cash}`, color: '#38d9ff', t: 1.4 };
        this.host.sfx('coin');
      }
      p.drift = 0;
    }
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
  }

  coast(car, dt) {
    if (Math.abs(car.vx) + Math.abs(car.vy) < 2) {
      car.vx = car.vy = 0;
      car.skidL = null;
      return;
    }
    const f = Math.max(0, 1 - dt * (car.wrecked ? 3 : 2.2));
    car.vx *= f;
    car.vy *= f;
    this.moveCar(car, dt);
  }

  moveCar(car, dt) {
    const spec = VEHICLES[car.kind];
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    const off = spec.len / 2 - spec.r;
    const c = Math.cos(car.angle);
    const s = Math.sin(car.angle);
    let px = 0;
    let py = 0;
    for (const k of [off, -off]) {
      const bx = car.x + c * k;
      const by = car.y + s * k;
      const body = { x: bx, y: by };
      if (this.collideWorld(body, spec.r)) {
        car.x += body.x - bx;
        car.y += body.y - by;
        px += body.x - bx;
        py += body.y - by;
      }
    }
    if (!px && !py) return;
    const d = Math.hypot(px, py) || 1;
    const nx = px / d;
    const ny = py / d;
    const vn = car.vx * nx + car.vy * ny;
    if (vn >= 0) return;
    // Bounce off the wall and scrub some speed.
    car.vx = (car.vx - 1.35 * vn * nx) * 0.85;
    car.vy = (car.vy - 1.35 * vn * ny) * 0.85;
    if (-vn > 120) {
      this.sparks(car.x - nx * spec.len * 0.4, car.y - ny * spec.len * 0.4, -vn);
      this.hurtCar(car, -vn);
    }
  }

  skid(car, on) {
    const spec = VEHICLES[car.kind];
    const c = Math.cos(car.angle);
    const s = Math.sin(car.angle);
    const bx = car.x - c * (spec.len / 2 - 9);
    const by = car.y - s * (spec.len / 2 - 9);
    const w = spec.wid / 2 - 4;
    const l = { x: bx + s * w, y: by - c * w };
    const r = { x: bx - s * w, y: by + c * w };
    if (on && car.skidL) {
      // Tyre marks are burned into the world canvas and stay for the shift.
      const g = this.worldG;
      g.strokeStyle = 'rgba(6,5,14,0.42)';
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(car.skidL.x, car.skidL.y);
      g.lineTo(l.x, l.y);
      g.moveTo(car.skidR.x, car.skidR.y);
      g.lineTo(r.x, r.y);
      g.stroke();
      if (Math.random() < 0.35) this.puff(Math.random() < 0.5 ? l.x : r.x, Math.random() < 0.5 ? l.y : r.y, { size: 6, life: 0.8, tone: 190, alpha: 0.28 });
    }
    car.skidL = on ? l : null;
    car.skidR = on ? r : null;
  }

  sparks(x, y, impact) {
    this.particles.burst(x, y, { count: Math.round(clamp(impact / 18, 5, 24)), color: '#ffd166', speed: 300, life: 0.45, size: 2.5 });
    this.particles.burst(x, y, { count: 4, color: '#ffffff', speed: 200, life: 0.25, size: 2 });
  }

  hurtCar(car, impact) {
    if (car.wrecked) return;
    this.host.sfx('crash');
    car.hp -= impact * 0.09;
    if (car.npc) car.daze = Math.max(car.daze, 1.4);
    const p = car.driver;
    if (p) {
      this.host.buzz(p.i, Math.min(300, impact));
      p.drift = 0;
      for (const job of [...p.cargo]) {
        if (job.type !== 'fragile') continue;
        job.integrity -= impact * 0.25;
        if (job.integrity <= 0) this.breakPackage(p, job);
        else p.flash = { msg: `FRAGILE ${Math.round(job.integrity)}%`, color: '#ff8fa3', t: 1.2 };
      }
    }
    if (car.hp <= 0) this.wreck(car);
  }

  wreck(car) {
    car.wrecked = true;
    car.hp = 0;
    car.npc = false;
    car.wreckT = 20;
    car.blink = 0;
    car.braking = false;
    this.host.sfx('explode');
    this.particles.burst(car.x, car.y, { count: 30, color: '#ff8a2b', speed: 260, life: 0.7, size: 4 });
    for (let k = 0; k < 6; k++) this.puff(car.x, car.y, { size: 14, life: 1.8, tone: 30, alpha: 0.6 });
    const p = car.driver;
    if (p) {
      this.exitCar(p, true);
      p.stun = 0.8;
      this.toast(`${p.name}'s ${VEHICLES[car.kind].label.toLowerCase()} is wrecked!`, '#ff8a2b');
    }
  }

  breakPackage(p, job) {
    p.cargo.splice(p.cargo.indexOf(job), 1);
    this.toast(`${p.name}'s fragile package smashed!`, '#ff8fa3');
    this.host.sfx('smallExplode');
    this.particles.burst(p.x, p.y, { count: 18, color: '#ff8fe0', speed: 220, life: 0.6, size: 3 });
    Object.assign(job, this.newJob());
  }

  carDamageFx(car, dt) {
    const spec = VEHICLES[car.kind];
    const dmg = 1 - car.hp / spec.hp;
    if (dmg < 0.45 || !this.nearPlayer(car.x, car.y, 1100)) return;
    if (Math.random() < dmg * 12 * dt) {
      const hx = car.x + Math.cos(car.angle) * spec.len * 0.32;
      const hy = car.y + Math.sin(car.angle) * spec.len * 0.32;
      this.puff(hx, hy, { vx: car.vx * 0.3, vy: car.vy * 0.3, size: 7, life: 1.5, tone: dmg > 0.75 ? 28 : 95, alpha: 0.55 });
    }
    if (car.wrecked && Math.random() < 14 * dt) {
      this.particles.burst(car.x + rand(-10, 10), car.y + rand(-8, 8), { count: 1, color: pick(['#ff8a2b', '#ffd166', '#ff3b2f']), speed: 40, life: 0.5, size: 5 });
    }
  }

  updateNpc(car, dt) {
    if (car.daze > 0) {
      // Knocked about: roll to a stop before carrying on.
      car.daze -= dt;
      car.speed = 0;
      car.braking = true;
      this.coast(car, dt);
      return;
    }
    const want = Math.atan2(car.target.y - car.y, car.target.x - car.x);
    car.angle = turnToward(car.angle, want, 4 * dt);
    const hx = Math.cos(car.angle);
    const hy = Math.sin(car.angle);

    // Keep a gap to whatever is ahead (cars, players on foot, pedestrians);
    // after waiting a while, nudge through so nobody stays stuck forever.
    car.ghost = Math.max(0, (car.ghost ?? 0) - dt);
    let room = Infinity;
    let byPlayer = false;
    if (car.ghost <= 0) {
      for (const o of this.cars) {
        if (o === car) continue;
        const g = this.ahead(car, hx, hy, o.x, o.y, 150, 22) - (VEHICLES[car.kind].len + VEHICLES[o.kind].len) / 2 - 16;
        if (g < room) {
          room = g;
          byPlayer = !!o.driver;
        }
      }
      for (const p of this.players) {
        if (p.car) continue;
        const g = this.ahead(car, hx, hy, p.x, p.y, 110, 22) - 38;
        if (g < room) {
          room = g;
          byPlayer = true;
        }
      }
      for (const ped of this.peds) {
        const g = this.ahead(car, hx, hy, ped.x, ped.y, 100, 20) - 36;
        if (g < room) {
          room = g;
          byPlayer = false;
        }
      }
    }
    const blocked = room < 8;
    car.wait = blocked ? (car.wait ?? 0) + dt : 0;
    if (car.wait > 3) {
      car.ghost = 1.2;
      car.wait = 0;
    }
    if (blocked && byPlayer && car.wait > 1.2 && !car.honked) {
      car.honked = true;
      if (this.nearPlayer(car.x, car.y, 600)) this.host.sfx('horn');
    } else if (!blocked) car.honked = false;

    let goal = car.cruise * (Math.abs(angleDiff(car.angle, want)) > 0.4 ? 0.45 : 1);
    goal = Math.min(goal, Math.max(0, room * 3));

    // Traffic lights: brake smoothly for the stop line unless committed.
    const d = dist(car.x, car.y, car.target.x, car.target.y);
    let hold = false;
    car.blink = 0;
    if (car.phase === 'go') {
      const sig = this.signal(car.node.ix, car.node.iy, car.dir.x ? 'ew' : 'ns');
      if (d < 45 && (sig === 'g' || (sig === 'y' && car.speed > 60))) car.commit = true;
      if (sig !== 'g' && !car.commit) {
        hold = true;
        goal = d < 14 ? 0 : Math.min(goal, Math.sqrt(2 * 420 * (d - 14)));
      }
      if (d < 170) car.blink = this.turnSide(car);
    } else car.blink = this.turnSide(car);

    car.braking = goal < car.speed - 5;
    car.speed += (goal - car.speed) * Math.min(1, dt * (goal < car.speed ? 5 : 1.5));
    const k = Math.min(1, dt * 6);
    car.vx += (hx * car.speed - car.vx) * k;
    car.vy += (hy * car.speed - car.vy) * k;
    this.moveCar(car, dt);
    if (d < 16 && !hold) {
      car.phase = car.phase === 'go' ? 'turn' : 'go';
      this.npcNextTarget(car);
    }
  }

  // +1 turning right, -1 turning left, 0 straight on.
  turnSide(car) {
    if (car.phase !== 'go') return car.turnBlink ?? 0;
    const a = car.dir;
    const b = car.nextDir;
    return b ? Math.sign(a.x * b.y - a.y * b.x) : 0;
  }

  ahead(car, hx, hy, x, y, range, width) {
    const rx = x - car.x;
    const ry = y - car.y;
    if (Math.abs(rx) > range || Math.abs(ry) > range) return Infinity;
    const along = rx * hx + ry * hy;
    if (along <= 0 || along > range) return Infinity;
    return Math.abs(rx * -hy + ry * hx) < width ? along : Infinity;
  }

  mass(car) {
    return VEHICLES[car.kind].mass * (car.driver || car.npc ? 1 : 1.4);
  }

  carCollisions() {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      const sa = VEHICLES[a.kind];
      const oa = sa.len / 2 - sa.r;
      const ca = Math.cos(a.angle);
      const na = Math.sin(a.angle);
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx * dx + dy * dy > 8100) continue;
        const sb = VEHICLES[b.kind];
        const ob = sb.len / 2 - sb.r;
        const cb = Math.cos(b.angle);
        const nb = Math.sin(b.angle);
        // Each body is two circles; resolve the deepest overlapping pair.
        let best = 0;
        let nx = 0;
        let ny = 0;
        for (const ka of [oa, -oa]) {
          for (const kb of [ob, -ob]) {
            const ex = b.x + cb * kb - (a.x + ca * ka);
            const ey = b.y + nb * kb - (a.y + na * ka);
            const d = Math.hypot(ex, ey);
            const pen = sa.r + sb.r - d;
            if (pen > best && d > 0) {
              best = pen;
              nx = ex / d;
              ny = ey / d;
            }
          }
        }
        if (best <= 0) continue;
        const ma = this.mass(a);
        const mb = this.mass(b);
        const wa = mb / (ma + mb);
        const wb = ma / (ma + mb);
        a.x -= nx * best * wa;
        a.y -= ny * best * wa;
        b.x += nx * best * wb;
        b.y += ny * best * wb;
        const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vrel >= 0) continue;
        const imp = (-1.3 * vrel) / (1 / ma + 1 / mb);
        a.vx -= (imp / ma) * nx;
        a.vy -= (imp / ma) * ny;
        b.vx += (imp / mb) * nx;
        b.vy += (imp / mb) * ny;
        const impact = -vrel;
        // Traffic bumping into traffic is only cosmetic; players cause the real damage.
        if (impact > 110 && !(a.npc && b.npc)) {
          this.sparks((a.x + b.x) / 2, (a.y + b.y) / 2, impact);
          this.hurtCar(a, impact * wa * 1.6);
          this.hurtCar(b, impact * wb * 1.6);
        } else if (impact > 30) {
          if (a.npc) a.daze = Math.max(a.daze, 0.5);
          if (b.npc) b.daze = Math.max(b.daze, 0.5);
        }
      }
    }
  }

  // Fast cars knock people over: players drop their packages, pedestrians
  // cost the driver money and the team its combo.
  hitPeople() {
    for (const car of this.cars) {
      const sp = Math.hypot(car.vx, car.vy);
      if (sp < 60) continue;
      const c = Math.cos(car.angle);
      const s = Math.sin(car.angle);
      for (const ped of this.peds) {
        if (ped.knock > 0 || !this.touches(car, ped.x, ped.y, 5)) continue;
        const across = -(ped.x - car.x) * s + (ped.y - car.y) * c;
        const side = across >= 0 ? 1 : -1;
        if (sp > 140) {
          ped.knock = 2.2;
          ped.vx = car.vx * 0.9 - s * side * 140;
          ped.vy = car.vy * 0.9 + c * side * 140;
          car.vx *= 0.88;
          car.vy *= 0.88;
          this.host.sfx('hit');
          const p = car.driver;
          if (p) {
            p.earned -= 25;
            this.team -= 25;
            this.combo = 0;
            this.comboT = 0;
            this.host.buzz(p.i, 120);
            this.toast(`${p.name} hit a pedestrian! -$25`, '#ff8fa3');
          }
        } else {
          ped.x += -s * side * 4;
          ped.y += c * side * 4;
          ped.scared = 1;
        }
      }
      if (!car.driver || sp < 150) continue;
      for (const p of this.players) {
        if (p.car || p.stun > 0 || !this.touches(car, p.x, p.y, 8)) continue;
        p.stun = 1.2;
        p.vx = car.vx * 0.9;
        p.vy = car.vy * 0.9;
        car.vx *= 0.7;
        car.vy *= 0.7;
        this.host.sfx('hit');
        this.host.buzz(p.i, 250);
        if (p.cargo.length) this.dropPackage(p);
      }
    }
  }

  updatePeds(dt) {
    for (const ped of this.peds) {
      ped.scared = Math.max(0, ped.scared - dt);
      if (ped.knock > 0 || ped.dodge > 0) {
        if (ped.knock > 0) ped.knock -= dt;
        else ped.dodge -= dt;
        const f = Math.max(0, 1 - dt * (ped.knock > 0 ? 2.5 : 4));
        ped.vx *= f;
        ped.vy *= f;
        ped.x += ped.vx * dt;
        ped.y += ped.vy * dt;
        this.collideWorld(ped, 7);
        continue;
      }
      if (this.pedDodge(ped)) continue;
      if (ped.waiting) {
        // Cross only when the traffic being crossed has a red light.
        if (this.signal(ped.node.ix, ped.node.iy, ped.cross) === 'r') ped.waiting = false;
        else if ((ped.wait += dt) > 14) this.pedNext(ped, true);
        continue;
      }
      const dx = ped.target.x - ped.x;
      const dy = ped.target.y - ped.y;
      const d = Math.hypot(dx, dy);
      const sp = ped.speed * (ped.cross ? 1.5 : 1) * (ped.scared > 0 ? 2 : 1);
      if (d < sp * dt + 1) {
        ped.x = ped.target.x;
        ped.y = ped.target.y;
        ped.node = ped.to.node;
        ped.sx = ped.to.sx;
        ped.sy = ped.to.sy;
        this.pedNext(ped);
        continue;
      }
      ped.x += (dx / d) * sp * dt;
      ped.y += (dy / d) * sp * dt;
      ped.angle = Math.atan2(dy, dx);
      ped.step += dt * sp * 0.12;
    }
  }

  // Jump out of the way of a speeding car heading straight for us.
  pedDodge(ped) {
    for (const car of this.cars) {
      const dx = ped.x - car.x;
      const dy = ped.y - car.y;
      if (dx > 170 || dx < -170 || dy > 170 || dy < -170) continue;
      const sp2 = car.vx * car.vx + car.vy * car.vy;
      if (sp2 < 130 * 130) continue;
      const sp = Math.sqrt(sp2);
      const hx = car.vx / sp;
      const hy = car.vy / sp;
      const along = dx * hx + dy * hy;
      const across = -dx * hy + dy * hx;
      if (along > 10 && along < 60 + sp * 0.35 && Math.abs(across) < 34) {
        const side = across >= 0 ? 1 : -1;
        ped.vx = -hy * side * 260 + hx * 40;
        ped.vy = hx * side * 260 + hy * 40;
        ped.dodge = 0.45;
        ped.scared = 1.5;
        return true;
      }
    }
    return false;
  }

  dropPackage(p) {
    for (const job of [...p.cargo]) {
      if (job.type === 'fragile' && (job.integrity -= 35) <= 0) {
        this.breakPackage(p, job);
        continue;
      }
      job.stage = 'pickup';
      job.carrier = null;
      job.x = p.x + rand(-20, 20);
      job.y = p.y + rand(-20, 20);
    }
    if (p.cargo.length) this.toast(`${p.name} dropped a package!`, '#ff8fa3');
    p.cargo = [];
  }

  updatePickups(dt) {
    for (const coin of this.coins) {
      coin.t += dt;
      const p = this.players.find((pl) => dist(pl.x, pl.y, coin.x, coin.y) < (pl.car ? 34 : 26));
      if (!p) continue;
      p.coins++;
      p.earned += 10;
      this.team += 10;
      this.particles.burst(coin.x, coin.y, { count: 10, color: '#ffd166', speed: 160, life: 0.4 });
      this.host.sfx('coin');
      Object.assign(coin, lanePoint());
    }

    for (const job of this.jobs) {
      if (job.stage === 'pickup') {
        const p = this.players.find((pl) => pl.stun <= 0 && pl.cargo.length < this.capacity(pl) && dist(pl.x, pl.y, job.x, job.y) < 60);
        if (p) {
          job.stage = 'carry';
          job.carrier = p;
          p.cargo.push(job);
          if (job.type === 'express' && job.timer <= 0) job.timer = job.limit;
          this.host.sfx('pickup');
          this.host.buzz(p.i, 60);
          const what = job.type === 'normal' ? 'a package' : `a ${job.type} package`;
          this.toast(`${p.name} picked up ${what}`, jobColor(job));
        }
        continue;
      }
      if (job.type === 'express' && (job.timer -= dt) <= 0) {
        job.type = 'normal';
        this.toast('Express window missed — now a regular parcel', '#facc15');
      }
      if (job.carrier && dist(job.carrier.x, job.carrier.y, job.dx, job.dy) < 70) this.deliver(job.carrier, job);
    }
  }

  deliver(p, job) {
    const type = JOB_TYPES[job.type];
    const color = type.color;
    p.cargo.splice(p.cargo.indexOf(job), 1);
    this.combo = this.comboT > 0 ? this.combo + 1 : 1;
    this.comboT = COMBO_TIME;
    const mult = Math.min(2, 1 + 0.25 * (this.combo - 1));
    const care = job.type === 'fragile' ? Math.max(0.2, job.integrity / 100) : 1;
    const cash = Math.round(job.reward * type.mult * care * mult);
    const bonus = job.type === 'express' ? 25 : 15;
    p.earned += cash;
    p.count++;
    this.team += cash;
    this.deliveries++;
    this.clock = Math.min(999, this.clock + bonus);
    this.particles.burst(job.dx, job.dy, { count: 40, color, speed: 320, life: 0.8, size: 4 });
    this.host.sfx('deliver');
    this.host.buzz(p.i, 150);
    const extra = this.combo > 1 ? `  COMBO x${mult.toFixed(2).replace(/\.?0+$/, '')}` : '';
    this.toast(`${p.name} delivered! +$${cash}  +${bonus}s${extra}`, color);
    Object.assign(job, this.newJob());
  }

  finish() {
    this.clock = 0;
    this.host.sfx('win');
    const rows = [...this.players]
      .sort((a, b) => b.earned - a.earned)
      .map((p) => ({ name: p.name, color: p.color, values: [money(p.earned), p.count, p.coins] }));
    this.result = {
      title: 'Shift complete!',
      color: '#facc15',
      subtitle: `Team earned ${money(this.team)} with ${this.deliveries} ${this.deliveries === 1 ? 'delivery' : 'deliveries'}`,
      columns: ['Earned', 'Deliveries', 'Coins'],
      rows,
    };
  }

  /* ------------------------------------------------------------ Render */
  objectiveFor(p) {
    if (p.cargo.length) {
      const j = p.cargo.reduce((best, k) => (dist(p.x, p.y, k.dx, k.dy) < dist(p.x, p.y, best.dx, best.dy) ? k : best));
      return { x: j.dx, y: j.dy, color: jobColor(j), label: 'DROP-OFF' };
    }
    const open = this.jobs.filter((j) => j.stage === 'pickup');
    if (!open.length) return null;
    const j = open.reduce((best, k) => (dist(p.x, p.y, k.x, k.y) < dist(p.x, p.y, best.x, best.y) ? k : best));
    return { x: j.x, y: j.y, color: jobColor(j), label: JOB_TYPES[j.type].label };
  }

  // 0 at the start of the shift, 1 once night has fully fallen.
  nightLevel() {
    return this.darkness() / 0.66;
  }

  // Ambient light colour for the light map; `lift` brightens it toward white
  // (rooftops catch more sky light than the street).
  ambient(n, lift = 0) {
    const d = this.dusk();
    const c = [0, 1, 2].map((k) => Math.round(clamp(lerp(lerp(DUSK_AMBIENT[k], NIGHT_AMBIENT[k], n) + DUSK_TINT[k] * d, 255, lift), 0, 255)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // Transient grading for the post pass: a colour pulse on every delivery and
  // a red heartbeat through the final seconds.
  updatePost(step) {
    if (this.deliveries > (this.seenDeliveries ?? 0)) {
      this.pulse = 1;
      const col = this.toasts.at(-1)?.color;
      this.pulseColor = col?.startsWith('#') ? hexToRgb(col).map((v) => v / 255) : [1, 0.85, 0.3];
    }
    this.seenDeliveries = this.deliveries;
    this.pulse = Math.max(0, (this.pulse ?? 0) - step * 2.2);
    let flash = this.pulse * this.pulse * 0.16;
    let flashColor = this.pulseColor ?? [1, 1, 1];
    if (this.clock <= 10 && this.clock > 0 && this.intro <= 0 && !this.result) {
      const beat = Math.pow(this.clock - Math.floor(this.clock), 10) * 0.07;
      if (beat > flash) {
        flash = beat;
        flashColor = [1, 0.1, 0.2];
      }
    }
    this.post = { flash, flashColor };
  }

  render(ctx) {
    ctx.fillStyle = '#06050f';
    ctx.fillRect(0, 0, W, H);
    // Camera easing based on elapsed time, so it keeps up at any frame rate.
    const step = this.time - (this.lastRender ?? this.time);
    this.camK = 1 - Math.exp(-step * 8);
    this.lastRender = this.time;
    this.updatePost(step);
    this.players.forEach((p, i) => this.renderView(ctx, this.views[i], p));

    // Split lines: a dark gutter with a hairline highlight
    ctx.beginPath();
    if (this.views.length >= 2) {
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
    }
    if (this.views.length >= 3) {
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
    }
    ctx.strokeStyle = '#04030a';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(160,180,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (this.views.length === 3) this.drawMinimap(ctx);
    this.drawHud(ctx);

    if (this.intro > 0) banner(ctx, 'Deliver packages!', 'B: hop in a car · follow the GPS · chain deliveries for combos', { color: '#facc15', alpha: Math.min(1, this.intro) });
  }

  renderView(ctx, view, p) {
    const z = this.zoom;
    const vw = view.w / z;
    const vh = view.h / z;
    const fx = p.x + (p.car ? p.car.vx * 0.25 : 0);
    const fy = p.y + (p.car ? p.car.vy * 0.25 : 0);
    p.camX = p.camX === undefined ? fx : p.camX + (fx - p.camX) * this.camK;
    p.camY = p.camY === undefined ? fy : p.camY + (fy - p.camY) * this.camK;
    const cx = clamp(p.camX - vw / 2, 0, WORLD_W - vw);
    const cy = clamp(p.camY - vh / 2, 0, WORLD_H - vh);
    // Each view has its own vanishing point for the 2.5D parallax.
    const camX = cx + vw / 2;
    const camY = cy + vh / 2;
    const inView = (x, y, m = 80) => x > cx - m && x < cx + vw + m && y > cy - m && y < cy + vh + m;
    const n = this.nightLevel();
    const goal = this.objectiveFor(p);
    const route = goal ? gpsRoute(p.x, p.y, goal.x, goal.y) : null;

    const enter = () => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.w, view.h);
      ctx.clip();
      ctx.translate(view.x, view.y);
      ctx.scale(z, z);
      ctx.translate(-cx, -cy);
    };

    // Street level: everything the light map lights
    enter();
    ctx.drawImage(this.world, cx, cy, vw, vh, cx, cy, vw, vh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 + 0.7 * n;
    ctx.drawImage(this.reflect, cx * RS, cy * RS, vw * RS, vh * RS, cx, cy, vw, vh);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (const ped of this.peds) if (inView(ped.x, ped.y)) this.drawPed(ctx, ped);
    for (const car of this.cars) if (inView(car.x, car.y)) this.drawCar(ctx, car);
    for (const pl of this.players) if (!pl.car && inView(pl.x, pl.y)) this.drawPerson(ctx, pl);
    this.drawSmoke(ctx, inView);
    this.drawPoles(ctx, inView, camX, camY);
    ctx.restore();

    this.drawLighting(ctx, view, cx, cy, n, inView);

    // Street-level emissives: route, lamps, signals, car lights, markers
    enter();
    ctx.globalCompositeOperation = 'lighter';
    if (route) this.drawRoute(ctx, route, goal.color);
    this.drawLamps(ctx, inView, n, camX, camY);
    this.drawSignals(ctx, inView, camX, camY);
    for (const car of this.cars) if (inView(car.x, car.y, 120)) this.drawCarLights(ctx, car, n);
    for (const pl of this.players) if (!pl.car && inView(pl.x, pl.y)) this.drawRing(ctx, pl);
    for (const job of this.jobs) {
      if (job.stage === 'pickup' && inView(job.x, job.y)) this.drawMarker(ctx, job.x, job.y, jobColor(job), false);
      if (job.stage === 'carry' && inView(job.dx, job.dy)) this.drawMarker(ctx, job.dx, job.dy, jobColor(job), true);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const coin of this.coins) if (inView(coin.x, coin.y)) this.drawCoin(ctx, coin);

    // The skyline, then everything that floats above it
    this.drawBuildings(ctx, camX, camY, cx, cy, vw, vh, n);
    for (const job of this.jobs) {
      if (job.stage === 'pickup' && inView(job.x, job.y, 220)) this.drawPickup(ctx, job, camX, camY);
      if (job.stage === 'carry' && inView(job.dx, job.dy, 220)) this.drawDrop(ctx, job, camX, camY);
    }
    for (const pl of this.players) if (inView(pl.x, pl.y)) this.drawTags(ctx, pl);
    this.particles.render(ctx);
    this.drawRain(ctx, cx, cy, vw, vh, camX, camY);
    ctx.restore();

    // Objective arrow along the view edge
    if (goal) {
      const sx = view.x + (goal.x - cx) * z;
      const sy = view.y + (goal.y - cy) * z;
      const inside = sx > view.x + 30 && sx < view.x + view.w - 30 && sy > view.y + 30 && sy < view.y + view.h - 30;
      if (!inside) {
        const ccx = view.x + view.w / 2;
        const ccy = view.y + view.h / 2;
        const a = Math.atan2(sy - ccy, sx - ccx);
        const k = Math.min((view.w / 2 - 44) / Math.abs(Math.cos(a) || 1e-6), (view.h / 2 - 44) / Math.abs(Math.sin(a) || 1e-6));
        const ax = ccx + Math.cos(a) * k;
        const ay = ccy + Math.sin(a) * k;
        drawGlow(ctx, ax, ay, 34, goal.color, 0.55);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(a);
        ctx.fillStyle = goal.color;
        ctx.beginPath();
        ctx.moveTo(20, 0);
        ctx.lineTo(-9, -14);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-9, 14);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
        const meters = Math.round(dist(p.x, p.y, goal.x, goal.y) / 10);
        this.drawPill(ctx, `${goal.label} ${meters}m`, ax - Math.cos(a) * 54, ay - Math.sin(a) * 32, goal.color);
      }
    }

    this.drawLabel(ctx, view, p);
    this.drawRadar(ctx, view, p, goal, route);
  }

  // Low-res light map multiplied over the street: night ambient plus street
  // lamps, neon spill, signals, headlights and the markers.
  drawLighting(ctx, view, cx, cy, n, inView) {
    const L = this.lights;
    const g = L.begin(view.w, view.h, this.ambient(n));
    g.scale(this.zoom, this.zoom);
    g.translate(-cx, -cy);
    const lamp = 0.4 + 0.6 * n;
    for (const l of this.lamps) if (inView(l.lx, l.ly, 190)) L.light(l.lx, l.ly, 190, l.white ? '#cfe0ff' : '#ffbf70', lamp * 0.85);
    for (const b of this.neonBlds) {
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      const R = Math.max(b.w, b.h) * 0.7 + 70;
      if (inView(bx, by, R)) L.light(bx, by, R, b.neonCol, 0.15 + 0.35 * n);
    }
    for (const pk of this.city.parks) {
      if (inView(pk.x + pk.w / 2, pk.y + pk.h / 2, 120)) L.light(pk.x + pk.w / 2, pk.y + pk.h / 2, 110, '#38d9ff', 0.5);
    }
    for (let ix = 0; ix < ROADS_X.length; ix++) {
      for (let iy = 0; iy < ROADS_Y.length; iy++) {
        if (!inView(ROADS_X[ix], ROADS_Y[iy], 150)) continue;
        // Corner lighting keeps the crosswalks readable
        L.light(ROADS_X[ix], ROADS_Y[iy], 150, '#d8dcff', 0.12 + 0.18 * n);
        for (const d of approaches(ix, iy)) {
          const h = this.signalHead(ROADS_X[ix], ROADS_Y[iy], d, 0, 0);
          L.light(h.gx, h.gy, 40, SIGNAL_COLORS[this.signal(ix, iy, d.x ? 'ew' : 'ns')], 0.55);
        }
      }
    }
    for (const car of this.cars) {
      if (!inView(car.x, car.y, 260)) continue;
      if (car.wrecked) {
        L.light(car.x, car.y, 70 + Math.sin(this.time * 23 + car.x) * 10, '#ff7a2b', 0.6);
        continue;
      }
      if (car.driver) L.light(car.x, car.y, 85, car.driver.color, 0.8); // neon underglow
      if (!(car.driver || car.npc)) continue;
      const v = VEHICLES[car.kind];
      g.save();
      g.translate(car.x, car.y);
      g.rotate(car.angle);
      g.globalAlpha = 0.5 + 0.45 * n;
      g.drawImage(this.beam, v.len / 2 - 4, -BEAM_H / 2);
      g.restore();
      const rx = car.x - Math.cos(car.angle) * v.len * 0.55;
      const ry = car.y - Math.sin(car.angle) * v.len * 0.55;
      L.light(rx, ry, car.braking ? 50 : 30, '#ff2440', car.braking ? 0.85 : 0.25 + 0.35 * n);
    }
    for (const pl of this.players) {
      if (pl.car || !inView(pl.x, pl.y)) continue;
      L.light(pl.x, pl.y, 130, '#ffffff', 0.35);
      L.light(pl.x, pl.y, 70, pl.color, 0.8);
    }
    for (const job of this.jobs) {
      if (job.stage === 'pickup' && inView(job.x, job.y, 150)) L.light(job.x, job.y, 150, jobColor(job), 0.9);
      if (job.stage === 'carry' && inView(job.dx, job.dy, 170)) L.light(job.dx, job.dy, 170, jobColor(job), 0.9);
    }
    for (const coin of this.coins) if (inView(coin.x, coin.y, 40)) L.light(coin.x, coin.y, 44, '#ffc53d', 0.45);
    L.apply(ctx, view.x, view.y, view.w, view.h);
  }

  // Signal head for one approach: on a mast arm over the lane, with parallax.
  signalHead(x, y, d, camX, camY) {
    const r = rightOf(d);
    const gx = x - d.x * (HALF + 8) + r.x * LANE;
    const gy = y - d.y * (HALF + 8) + r.y * LANE;
    return {
      gx,
      gy,
      bx: x - d.x * (HALF + 8) + r.x * (HALF + 8),
      by: y - d.y * (HALF + 8) + r.y * (HALF + 8),
      x: gx + (gx - camX) * POLE,
      y: gy + (gy - camY) * POLE,
    };
  }

  // Lamp posts and signal masts lean out with the same parallax as buildings.
  drawPoles(ctx, inView, camX, camY) {
    ctx.strokeStyle = '#0c0b16';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const l of this.lamps) {
      if (!inView(l.x, l.y, 40)) continue;
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.x + (l.x - camX) * POLE, l.y + (l.y - camY) * POLE);
      ctx.lineTo(l.lx + (l.lx - camX) * POLE, l.ly + (l.ly - camY) * POLE);
    }
    const heads = [];
    for (let ix = 0; ix < ROADS_X.length; ix++) {
      for (let iy = 0; iy < ROADS_Y.length; iy++) {
        if (!inView(ROADS_X[ix], ROADS_Y[iy], 120)) continue;
        for (const d of approaches(ix, iy)) {
          const h = this.signalHead(ROADS_X[ix], ROADS_Y[iy], d, camX, camY);
          ctx.moveTo(h.bx, h.by);
          ctx.lineTo(h.bx + (h.bx - camX) * POLE, h.by + (h.by - camY) * POLE);
          ctx.lineTo(h.x, h.y);
          heads.push(h);
        }
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#0a0914';
    for (const h of heads) {
      ctx.beginPath();
      ctx.roundRect(h.x - 5.5, h.y - 5.5, 11, 11, 3);
      ctx.fill();
    }
  }

  drawLamps(ctx, inView, n, camX, camY) {
    const a = 0.35 + 0.65 * n;
    for (const l of this.lamps) {
      if (!inView(l.lx, l.ly, 30)) continue;
      const x = l.lx + (l.lx - camX) * POLE;
      const y = l.ly + (l.ly - camY) * POLE;
      glow(ctx, x, y, 26, l.white ? '#cfe2ff' : '#ffc070', a * 0.75);
      ctx.globalAlpha = a;
      ctx.fillStyle = l.white ? '#f2f7ff' : '#fff0d0';
      if (l.ax) ctx.fillRect(x - 4, y - 2, 8, 4);
      else ctx.fillRect(x - 2, y - 4, 4, 8);
    }
    ctx.globalAlpha = 1;
  }

  drawSignals(ctx, inView, camX, camY) {
    for (let ix = 0; ix < ROADS_X.length; ix++) {
      for (let iy = 0; iy < ROADS_Y.length; iy++) {
        const x = ROADS_X[ix];
        const y = ROADS_Y[iy];
        if (!inView(x, y, 120)) continue;
        for (const d of approaches(ix, iy)) {
          const col = SIGNAL_COLORS[this.signal(ix, iy, d.x ? 'ew' : 'ns')];
          const h = this.signalHead(x, y, d, camX, camY);
          glow(ctx, h.x, h.y, 18, col, 0.9);
          ctx.globalAlpha = 1;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(h.x, h.y, 2.8, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // GPS line: a soft glow under animated dots (drawn additively).
  drawRoute(ctx, pts, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 22;
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 5;
    ctx.setLineDash([3, 17]);
    ctx.lineDashOffset = -this.time * 40;
    ctx.stroke();
    ctx.restore();
  }

  // Buildings as 2.5D blocks: the roof is pushed away from this view's centre
  // in proportion to its height, revealing the walls that face the camera.
  // Farthest drawn first.
  drawBuildings(ctx, camX, camY, cx, cy, vw, vh, n) {
    const list = this.bldList;
    list.length = 0;
    for (const b of this.buildings) {
      if (b.x + b.w < cx - 40 || b.x > cx + vw + 40 || b.y + b.h < cy - 40 || b.y > cy + vh + 40) continue;
      const dx = b.x + b.w / 2 - camX;
      const dy = b.y + b.h / 2 - camY;
      b.ox = dx * b.ht;
      b.oy = dy * b.ht;
      b.d = Math.abs(dx) + Math.abs(dy);
      list.push(b);
    }
    list.sort((a, c) => c.d - a.d);
    const amb = this.ambient(n, 0.22);
    const winA = 0.3 + 0.7 * n;
    for (const b of list) this.drawBuilding(ctx, b, amb, winA, n);
  }

  drawBuilding(ctx, b, amb, winA, n) {
    const { ox, oy } = b;
    // The vertical-edge wall nearest the view centre, then the horizontal one
    const wx = ox > 0 ? b.x : b.x + b.w;
    if (Math.abs(ox) > 1.5) this.drawWall(ctx, b, wx, b.y, 0, b.h, ox > 0 ? b.faces.w : b.faces.e, b.win[0], b.win[1], amb, winA, n, b.sign?.v);
    const wy = oy > 0 ? b.y : b.y + b.h;
    if (Math.abs(oy) > 1.5) this.drawWall(ctx, b, b.x, wy, b.w, 0, oy > 0 ? b.faces.n : b.faces.s, b.win[2], b.win[3], amb, winA, n, b.sign && !b.sign.v);

    // Roof: the painted rooftop lifted into place, then shaded by the night
    const rx = b.x + ox;
    const ry = b.y + oy;
    ctx.drawImage(this.world, b.x, b.y, b.w, b.h, rx, ry, b.w, b.h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = amb;
    ctx.fillRect(rx, ry, b.w, b.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(190,200,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.75, ry + 0.75, b.w - 1.5, b.h - 1.5);
    const ant = b.antenna;
    if (ant) {
      // Mast rises past the roof line
      const k = 1 + ant.h;
      ctx.strokeStyle = '#3a3c4e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ant.x + ox, ant.y + oy);
      ctx.lineTo(ant.x + ox * k, ant.y + oy * k);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'lighter';
    if (b.neon) {
      ctx.strokeStyle = b.neonCol;
      ctx.globalAlpha = 0.16 + n * 0.24;
      ctx.lineWidth = 7;
      ctx.strokeRect(rx + 3, ry + 3, b.w - 6, b.h - 6);
      ctx.globalAlpha = 0.6 + n * 0.4;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx + 3, ry + 3, b.w - 6, b.h - 6);
    }
    if (b.detail === 0) {
      // Helipad edge lights chase around the ring
      const R = Math.min(b.w, b.h) * 0.3 - 2;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        const on = (this.time * 6 - k + 80) % 8 < 1.5;
        glow(ctx, rx + b.w / 2 + Math.cos(a) * R, ry + b.h / 2 + Math.sin(a) * R, on ? 9 : 5, '#facc15', on ? 0.95 : 0.35);
      }
    }
    if (ant && Math.sin(this.time * 3 + ant.phase) > 0.55) {
      const k = 1 + ant.h;
      glow(ctx, ant.x + ox * k, ant.y + oy * k, 12, '#ff2b3a', 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // One side wall. Texture space (u along the wall, v down from the roof line)
  // is mapped onto the wall's parallelogram, so the shared facade textures
  // land in perspective with a single transform.
  drawWall(ctx, b, x0, y0, ex, ey, col, ax, ay, amb, winA, n, sign) {
    const { ox, oy } = b;
    const cols = Math.max(2, Math.round((ex + ey) / 12));
    const sw = cols * WIN_CW;
    const sh = b.storeys * WIN_FH;
    ctx.save();
    ctx.transform(ex / sw, ey / sw, -ox / sh, -oy / sh, x0 + ox, y0 + oy);
    ctx.fillStyle = col;
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(this.atlas.dim, ax * WIN_CW, ay * WIN_FH, sw, sh, 0, 0, sw, sh);
    ctx.drawImage(this.wallShade, 0, 0, sw, sh);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = amb;
    ctx.fillRect(0, 0, sw, sh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = winA;
    ctx.drawImage(this.atlas.lit, ax * WIN_CW, ay * WIN_FH, sw, sh, 0, 0, sw, sh);
    // Street light washing up the base of the facade
    ctx.globalAlpha = 0.25 + 0.5 * n;
    ctx.drawImage(this.wallSpill, 0, 0, sw, sh);
    if (sign) this.drawSign(ctx, b.sign, sw, sh, n);
    ctx.restore();
  }

  // Vertical neon blade sign, drawn in the wall's texture space.
  drawSign(ctx, s, sw, sh, n) {
    if (s.flicker && hash(Math.floor(this.time * 12) + s.u * 100) > 0.9) return;
    const x = s.u * sw;
    const y0 = sh * 0.1;
    const len = sh * s.len;
    ctx.fillStyle = s.col;
    ctx.globalAlpha = 0.25 + 0.2 * n;
    ctx.fillRect(x - 6, y0 - 3, 16, len + 6);
    ctx.globalAlpha = 0.85 + 0.15 * n;
    // Glyph-like segments
    const seg = len / 4;
    for (let k = 0; k < 4; k++) ctx.fillRect(x, y0 + k * seg, 4, seg * 0.72);
  }

  puffSprite(tone) {
    let s = this.puffs.get(tone);
    if (!s) {
      s = softSprite(`${tone},${tone},${Math.min(255, tone + 12)}`, 48);
      this.puffs.set(tone, s);
    }
    return s;
  }

  drawSmoke(ctx, inView) {
    for (const s of this.smoke) {
      if (!inView(s.x, s.y, 40)) continue;
      ctx.globalAlpha = s.alpha * (s.life / s.max);
      const r = s.size * 1.6;
      ctx.drawImage(this.puffSprite(s.tone), s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  drawCoin(ctx, coin) {
    const sx = Math.max(0.15, Math.abs(Math.cos(coin.t * 3)));
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, coin.x, coin.y, 22, '#ffb92e', 0.5);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.coinSprite, coin.x - 10 * sx, coin.y - 10, 20 * sx, 20);
  }

  drawPackage(ctx, x, y, job, s = 1) {
    const color = jobColor(job);
    const base = job.type === 'fragile' ? '#e2cfae' : '#c08a4a';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-9, -6, 22, 18);
    const grad = ctx.createLinearGradient(0, -9, 0, 9);
    grad.addColorStop(0, shade(base, 0.15));
    grad.addColorStop(1, shade(base, -0.3));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(-11, -9, 22, 18, 2.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(-2, -9, 4, 18);
    ctx.fillRect(-11, -2, 22, 4);
    if (job.type === 'express') {
      // Lightning bolt
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(-8, -14);
      ctx.lineTo(-2, -14);
      ctx.lineTo(-5, -11);
      ctx.lineTo(-1, -11);
      ctx.lineTo(-9, -4);
      ctx.lineTo(-6, -9);
      ctx.lineTo(-9, -9);
      ctx.fill();
    } else if (job.type === 'fragile') {
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(5, -7, 3, 7);
    }
    ctx.restore();
  }

  // Small dark pill with spaced caps, used for world labels.
  drawPill(ctx, label, x, y, color, size = 13) {
    const str = label.toUpperCase();
    ctx.save();
    ctx.font = `700 ${size}px "${HUD_FONT}", system-ui, sans-serif`;
    ctx.letterSpacing = '2px';
    const w = ctx.measureText(str).width + 18;
    ctx.fillStyle = 'rgba(8,10,24,0.72)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - size * 0.8, w, size * 1.6, size * 0.8);
    ctx.fill();
    ctx.strokeStyle = rgba(color.startsWith('#') ? color : '#ffffff', 0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    text(ctx, str, x + 1, y + 1, { size, color, spacing: 2 });
  }

  // Pulsing ground ring for pickups and drop-offs (drawn additively).
  drawMarker(ctx, x, y, color, drop) {
    const pulse = (this.time * 1.4) % 1;
    glow(ctx, x, y, 64, color, 0.4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.globalAlpha = (1 - pulse) * 0.9;
    ctx.beginPath();
    ctx.arc(x, y, 24 + pulse * 44, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.5;
    if (drop) {
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -this.time * 30;
      ctx.beginPath();
      ctx.arc(x, y, 38, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(x, y, drop ? 22 : 24, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // A light column rising out of the street. It leans with the parallax like
  // the buildings, so it reads as a tall pillar of light above the skyline.
  drawBeacon(ctx, x, y, color, camX, camY, a) {
    const tx = x + (x - camX) * 0.32;
    const ty = y + (y - camY) * 0.32;
    const len = Math.hypot(tx - x, ty - y);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (len > 4) {
      const nx = -(ty - y) / len;
      const ny = (tx - x) / len;
      const grad = ctx.createLinearGradient(x, y, tx, ty);
      grad.addColorStop(0, rgba(color, 0.5 * a));
      grad.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = grad;
      for (const [w0, w1] of [[16, 24], [4, 6]]) {
        ctx.beginPath();
        ctx.moveTo(x + nx * w0, y + ny * w0);
        ctx.lineTo(tx + nx * w1, ty + ny * w1);
        ctx.lineTo(tx - nx * w1, ty - ny * w1);
        ctx.lineTo(x - nx * w0, y - ny * w0);
        ctx.fill();
      }
    }
    glow(ctx, x, y, 34, color, 0.8 * a);
    ctx.restore();
  }

  drawPickup(ctx, job, camX, camY) {
    const color = jobColor(job);
    this.drawBeacon(ctx, job.x, job.y, color, camX, camY, 0.75);
    ctx.fillStyle = 'rgba(8,10,24,0.72)';
    ctx.beginPath();
    ctx.arc(job.x, job.y, 20, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    this.drawPackage(ctx, job.x, job.y + Math.sin(this.time * 4) * 2, job);
    this.drawPill(ctx, JOB_TYPES[job.type].label, job.x, job.y - 40, color);
  }

  drawDrop(ctx, job, camX, camY) {
    const color = jobColor(job);
    this.drawBeacon(ctx, job.dx, job.dy, color, camX, camY, 1);
    const bob = Math.sin(this.time * 5) * 5;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(job.dx, job.dy - 30 + bob);
    ctx.lineTo(job.dx - 12, job.dy - 48 + bob);
    ctx.lineTo(job.dx, job.dy - 43 + bob);
    ctx.lineTo(job.dx + 12, job.dy - 48 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    this.drawPill(ctx, 'Drop-off', job.dx, job.dy - 66 + bob, color);
  }

  drawCar(ctx, car) {
    const v = VEHICLES[car.kind];
    const sh = this.carShadows[car.kind];
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    ctx.globalAlpha = 0.8;
    ctx.drawImage(sh, -sh.width / 2, -sh.height / 2 + 1);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sprite(car.kind, car.color), -v.len / 2 - 4, -v.wid / 2 - 4, v.len + 8, v.wid + 8);
    const dmg = 1 - car.hp / v.hp;
    if (dmg > 0.3) {
      // Dents and scorch marks
      ctx.fillStyle = `rgba(20,16,24,${Math.min(0.7, dmg * 0.7)})`;
      ctx.beginPath();
      ctx.arc(v.len * 0.32, -4, 6, 0, TAU);
      ctx.arc(-v.len * 0.22, 6, 5, 0, TAU);
      ctx.arc(v.len * 0.05, -v.wid * 0.3, 4, 0, TAU);
      ctx.fill();
    }
    if (car.wrecked) {
      ctx.fillStyle = 'rgba(12,10,16,0.68)';
      ctx.beginPath();
      ctx.roundRect(-v.len / 2, -v.wid / 2, v.len, v.wid, 8);
      ctx.fill();
    }
    ctx.restore();
  }

  // Headlights, tail/brake lights, indicators and the driver's underglow (additive).
  drawCarLights(ctx, car, n) {
    if (car.wrecked) return;
    const v = VEHICLES[car.kind];
    const L = v.len / 2;
    const Wd = v.wid / 2;
    const c = Math.cos(car.angle);
    const s = Math.sin(car.angle);
    const px = (fx, fy) => car.x + c * fx - s * fy;
    const py = (fx, fy) => car.y + s * fx + c * fy;
    if (car.driver) {
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.angle);
      ctx.strokeStyle = car.driver.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(-L - 5, -Wd - 5, L * 2 + 10, Wd * 2 + 10, 11);
      ctx.stroke();
      ctx.restore();
    }
    if (!(car.driver || car.npc)) return;
    for (const side of [-1, 1]) {
      glow(ctx, px(L - 2, side * (Wd - 5)), py(L - 2, side * (Wd - 5)), 9 + 5 * n, '#fff4d6', 0.85);
      glow(ctx, px(-L + 1, side * (Wd - 5)), py(-L + 1, side * (Wd - 5)), car.braking ? 15 : 8, '#ff2b4a', car.braking ? 1 : 0.35 + 0.4 * n);
    }
    // Turn signals
    if (car.blink && Math.floor(this.time * 3) % 2) {
      const side = car.blink > 0 ? Wd - 1 : -Wd + 1;
      glow(ctx, px(L - 4, side), py(L - 4, side), 10, '#ffb020', 1);
      glow(ctx, px(-L + 3, side), py(-L + 3, side), 10, '#ffb020', 1);
    }
    ctx.globalAlpha = 1;
  }

  // Player-colour ring and heading tick around someone on foot (additive).
  drawRing(ctx, p) {
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PERSON_R + 6, 0, TAU);
    ctx.stroke();
    const c = Math.cos(p.angle);
    const s = Math.sin(p.angle);
    const R = PERSON_R + 9;
    ctx.beginPath();
    ctx.moveTo(p.x + c * (R + 7), p.y + s * (R + 7));
    ctx.lineTo(p.x + c * R - s * 5, p.y + s * R + c * 5);
    ctx.lineTo(p.x + c * R + s * 5, p.y + s * R - c * 5);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawPed(ctx, ped) {
    ctx.save();
    ctx.translate(ped.x, ped.y);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(1, 2, 8, 6, 0, 0, TAU);
    ctx.fill();
    if (ped.knock > 0) {
      ctx.rotate(ped.angle + 1.2);
      ctx.fillStyle = ped.shirt;
      ctx.beginPath();
      ctx.ellipse(0, 0, 10, 5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = ped.skin;
      ctx.beginPath();
      ctx.arc(10, 0, 4, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.rotate(ped.angle);
    const sw = Math.sin(ped.step * 6) * 4;
    ctx.fillStyle = '#14121c';
    ctx.beginPath();
    ctx.arc(sw, -3, 2.2, 0, TAU);
    ctx.arc(-sw, 3, 2.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = ped.shirt;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 7.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(-1.5, 0, 3, 7, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = ped.skin;
    ctx.beginPath();
    ctx.arc(0.5, 0, 3.7, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1b1620';
    ctx.beginPath();
    ctx.arc(0.2, 0, 3.7, Math.PI * 0.55, Math.PI * 1.45);
    ctx.fill();
    ctx.restore();
    if (ped.scared > 0.6) text(ctx, '!', ped.x, ped.y - 18, { size: 18, color: '#ffd166' });
  }

  drawPerson(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(1, 3, PERSON_R + 2, PERSON_R, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(p.angle);
    // Courier bag on the back
    ctx.fillStyle = '#1a1b26';
    ctx.beginPath();
    ctx.roundRect(-13, -7, 8, 14, 3);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.fillRect(-12, -1, 6, 2);
    // Jacket with a soft highlight
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 8, 12, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(-2.5, 0, 5, 11, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(2, -4, 3, 5, 0, 0, TAU);
    ctx.fill();
    // Helmet with a visor facing forward
    ctx.fillStyle = '#20222e';
    ctx.beginPath();
    ctx.arc(1, 0, 6.5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#c4f1ff';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(1, 0, 4.6, -0.9, 0.9);
    ctx.stroke();
    ctx.restore();
    if (p.stun > 0) {
      for (let k = 0; k < 3; k++) {
        const a = this.time * 6 + (k * TAU) / 3;
        this.drawStar(ctx, p.x + Math.cos(a) * 16, p.y - 20 + Math.sin(a) * 5, 5, '#ffd166');
      }
    }
  }

  drawStar(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      const d = k % 2 ? r * 0.35 : r;
      ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Name, carried packages and bonus pop-ups above a player (or their car).
  drawTags(ctx, p) {
    const n = p.cargo.length;
    const top = p.car ? 34 : 28;
    p.cargo.forEach((job, k) => this.drawPackage(ctx, p.x + (k - (n - 1) / 2) * 22, p.y - top, job, 0.8));
    const ny = p.y - (n ? top + 20 : p.car ? 32 : 28);
    this.drawPill(ctx, p.name, p.x, ny, '#ffffff', 12);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 8, ny + 8, 16, 2);
    if (p.flash) {
      const rise = (1.4 - p.flash.t) * 24;
      text(ctx, p.flash.msg, p.x, p.y - 66 - rise, { size: 19, color: p.flash.color, alpha: Math.min(1, p.flash.t * 2), spacing: 1 });
    }
  }

  // Light rain falling toward the camera: each streak points away from the
  // view centre and shrinks to nothing where the drop lands.
  drawRain(ctx, cx, cy, vw, vh, camX, camY) {
    const t = this.time;
    ctx.strokeStyle = 'rgba(175,195,255,0.26)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < RAIN; i++) {
      const ph = t * (1.4 + (i % 7) * 0.12) + i * 0.618;
      const cyc = Math.floor(ph);
      const f = ph - cyc;
      const gx = cx + hash(i * 7.13 + cyc * 1.37) * vw;
      const gy = cy + hash(i * 3.71 + cyc * 9.11) * vh;
      const k = (1 - f) * 0.5;
      ctx.moveTo(gx + (gx - camX) * k + 1, gy + (gy - camY) * k + 3);
      ctx.lineTo(gx + (gx - camX) * (k + 0.05) - 1, gy + (gy - camY) * (k + 0.05) - 5);
    }
    ctx.stroke();
  }

  /* --------------------------------------------------------------- HUD */
  drawLabel(ctx, view, p) {
    const ly = view.y + (view.y === 0 ? 82 : 12); // clear of the centre timer
    const x = view.x + 12;
    const w = p.car ? 336 : 272;
    const h = 52 + p.cargo.length * 22;
    glassPanel(ctx, x, ly, w, h, { r: 8, accent: p.color });
    const nearCar = this.cars.some((c) => !c.driver && !c.wrecked && dist(c.x, c.y, p.x, p.y) < 70);
    const full = p.cargo.length >= this.capacity(p);
    const hint = p.car
      ? `${VEHICLES[p.car.kind].label} · B: out · A: boost`
      : nearCar
        ? 'B: get in the car'
        : full
          ? 'Deliver the package!'
          : 'A: sprint';
    text(ctx, p.name.toUpperCase(), x + 16, ly + 17, { size: 19, align: 'left', spacing: 1.5 });
    text(ctx, hint.toUpperCase(), x + 16, ly + 38, { size: 12, weight: 600, align: 'left', color: 'rgba(200,210,255,0.72)', spacing: 0.5 });
    if (p.car) {
      const spec = VEHICLES[p.car.kind];
      const hp = p.car.hp / spec.hp;
      text(ctx, String(Math.round(Math.hypot(p.car.vx, p.car.vy) * 0.3)), x + w - 44, ly + 17, { size: 24, align: 'right' });
      text(ctx, 'KM/H', x + w - 12, ly + 19, { size: 10, align: 'right', color: 'rgba(200,210,255,0.6)', spacing: 1 });
      meter(ctx, x + w - 98, ly + 33, 86, 4, p.boost, '#38d9ff', { segments: 8, glow: false });
      meter(ctx, x + w - 98, ly + 41, 86, 4, hp, hp > 0.55 ? '#22d36b' : hp > 0.25 ? '#facc15' : '#ff3b5c', { segments: 8, glow: false });
    }
    p.cargo.forEach((job, k) => {
      const y = ly + 62 + k * 22;
      const color = jobColor(job);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x + 16, y - 6, 12, 12, 2);
      ctx.fill();
      let status = JOB_TYPES[job.type].label;
      if (job.type === 'express') status += `  ${Math.ceil(job.timer)}s`;
      if (job.type === 'fragile') status += `  ${Math.round(job.integrity)}%`;
      const urgent = job.type === 'express' && job.timer < 8 && Math.floor(this.time * 4) % 2;
      text(ctx, status, x + 36, y + 1, { size: 15, align: 'left', color: urgent ? '#ff3b5c' : color, spacing: 1 });
    });
  }

  // Per-view radar: local street map with the GPS route, in a glass frame.
  drawRadar(ctx, view, p, goal, route) {
    const n = this.views.length;
    const s = n === 1 ? 220 : n === 2 ? 190 : 138;
    const rx = view.x + view.w - s - 18;
    const ry = view.y + view.h - s - 18;
    const span = 1700;
    const k = s / span;
    const ox = p.x - span / 2;
    const oy = p.y - span / 2;
    const tx = (x) => rx + (x - ox) * k;
    const ty = (y) => ry + (y - oy) * k;
    const cl = (v, a) => clamp(v, a + 7, a + s - 7);

    glassPanel(ctx, rx - 6, ry - 6, s + 12, s + 12, { r: 14, alpha: 0.5 });
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(rx, ry, s, s, 10);
    ctx.fillStyle = '#070912';
    ctx.fill();
    ctx.clip();
    const x0 = Math.max(0, ox);
    const y0 = Math.max(0, oy);
    const x1 = Math.min(WORLD_W, ox + span);
    const y1 = Math.min(WORLD_H, oy + span);
    if (x1 > x0 && y1 > y0) ctx.drawImage(this.mini, x0 * MS, y0 * MS, (x1 - x0) * MS, (y1 - y0) * MS, tx(x0), ty(y0), (x1 - x0) * k, (y1 - y0) * k);
    // Range rings
    ctx.strokeStyle = 'rgba(140,170,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const rr of [0.18, 0.36]) {
      ctx.moveTo(rx + s / 2 + s * rr, ry + s / 2);
      ctx.arc(rx + s / 2, ry + s / 2, s * rr, 0, TAU);
    }
    ctx.stroke();
    if (route) {
      ctx.strokeStyle = goal.color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      route.forEach((q, i) => (i ? ctx.lineTo(tx(q.x), ty(q.y)) : ctx.moveTo(tx(q.x), ty(q.y))));
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    for (const job of this.jobs) {
      ctx.fillStyle = jobColor(job);
      if (job.stage === 'pickup') {
        ctx.beginPath();
        ctx.roundRect(cl(tx(job.x), rx) - 4, cl(ty(job.y), ry) - 4, 8, 8, 2);
        ctx.fill();
      } else if (job.carrier === p) {
        ctx.strokeStyle = jobColor(job);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cl(tx(job.dx), rx), cl(ty(job.dy), ry), 5 + Math.sin(this.time * 6), 0, TAU);
        ctx.stroke();
      }
    }
    for (const o of this.players) {
      if (o === p) continue;
      ctx.fillStyle = o.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cl(tx(o.x), rx), cl(ty(o.y), ry), 4.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    // Inner vignette
    const vg = ctx.createRadialGradient(rx + s / 2, ry + s / 2, s * 0.3, rx + s / 2, ry + s / 2, s * 0.72);
    vg.addColorStop(0, 'rgba(4,5,12,0)');
    vg.addColorStop(1, 'rgba(4,5,12,0.7)');
    ctx.fillStyle = vg;
    ctx.fillRect(rx, ry, s, s);
    ctx.restore();

    // You-are-here arrow
    drawGlow(ctx, rx + s / 2, ry + s / 2, 18, p.color, 0.6);
    ctx.save();
    ctx.translate(rx + s / 2, ry + s / 2);
    ctx.rotate(p.car ? p.car.angle : p.angle);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    text(ctx, 'GPS', rx + 10, ry + 13, { size: 11, align: 'left', color: 'rgba(200,210,255,0.6)', spacing: 2 });
    if (goal) {
      const meters = Math.round(dist(p.x, p.y, goal.x, goal.y) / 10);
      text(ctx, `${goal.label} · ${meters}M`, rx + s / 2, ry - 20, { size: 14, color: goal.color, spacing: 2 });
    }
  }

  // Whole-city map, shown in the spare quadrant with three players.
  drawMinimap(ctx) {
    const bg = ctx.createLinearGradient(W / 2, H / 2, W, H);
    bg.addColorStop(0, '#0a0b18');
    bg.addColorStop(1, '#05060d');
    ctx.fillStyle = bg;
    ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
    const box = { x: W / 2 + 120, y: H / 2 + 66, w: 480, h: 360 };
    glassPanel(ctx, box.x - 14, box.y - 48, box.w + 28, box.h + 62, { r: 12, accent: '#22d3ee', accentSide: 'top' });
    text(ctx, 'CITY MAP', box.x, box.y - 24, { size: 18, align: 'left', color: '#dfe6ff', spacing: 4 });
    text(ctx, this.clockLabel(), box.x + box.w, box.y - 24, { size: 15, align: 'right', color: 'rgba(200,210,255,0.65)', spacing: 2 });
    const sx = box.w / WORLD_W;
    const sy = box.h / WORLD_H;
    ctx.drawImage(this.mini, box.x, box.y, box.w, box.h);
    for (const job of this.jobs) {
      const x = box.x + (job.stage === 'pickup' ? job.x : job.dx) * sx;
      const y = box.y + (job.stage === 'pickup' ? job.y : job.dy) * sy;
      ctx.fillStyle = jobColor(job);
      if (job.stage === 'pickup') {
        ctx.beginPath();
        ctx.roundRect(x - 4, y - 4, 8, 8, 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = jobColor(job);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5 + Math.sin(this.time * 6), 0, TAU);
        ctx.stroke();
      }
    }
    for (const p of this.players) {
      ctx.fillStyle = p.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(box.x + p.x * sx, box.y + p.y * sy, 4.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Crescent moon or sun, drawn as vectors so no glyph font is needed.
  drawSkyIcon(ctx, x, y, night) {
    ctx.save();
    if (night) {
      ctx.beginPath();
      ctx.rect(x - 12, y - 12, 24, 24);
      ctx.arc(x + 4, y - 3, 6.5, 0, TAU);
      ctx.clip('evenodd');
      ctx.fillStyle = '#c9d4ff';
      ctx.beginPath();
      ctx.arc(x, y, 7.5, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = '#ffb347';
      ctx.strokeStyle = '#ffb347';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        ctx.moveTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
        ctx.lineTo(x + Math.cos(a) * 9.5, y + Math.sin(a) * 9.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawHud(ctx) {
    const low = this.clock <= 15 && this.intro <= 0;
    const muted = 'rgba(200,210,255,0.6)';
    const px = W / 2 - 210;
    const py = 10;
    const ph = 62;
    glassPanel(ctx, px, py, 420, ph, { r: 10, accent: low ? '#ff3b5c' : '#22d3ee', accentSide: 'bottom' });
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(px + 140, py + 12, 1, ph - 24);
    ctx.fillRect(px + 290, py + 12, 1, ph - 24);
    const t = Math.ceil(this.clock);
    text(ctx, 'SHIFT', px + 70, py + 14, { size: 11, color: muted, spacing: 3 });
    text(ctx, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, px + 70, py + 39, {
      size: 34,
      color: low && Math.floor(this.time * 4) % 2 ? '#ff3b5c' : '#fff',
      spacing: 1,
    });
    text(ctx, 'TEAM', px + 215, py + 14, { size: 11, color: muted, spacing: 3 });
    text(ctx, money(this.team), px + 215, py + 36, { size: 28, color: '#facc15', spacing: 1 });
    text(ctx, `${this.deliveries} DELIVERED`, px + 215, py + 54, { size: 11, color: muted, spacing: 1.5 });
    this.drawSkyIcon(ctx, px + 355, py + 22, this.darkness() > 0.3);
    text(ctx, this.clockLabel(), px + 355, py + 45, { size: 16, color: '#dfe6ff', spacing: 1 });

    let y = 100;
    if (this.combo > 1 && this.comboT > 0) {
      const mult = Math.min(2, 1 + 0.25 * (this.combo - 1));
      glassPanel(ctx, W / 2 - 90, 80, 180, 38, { r: 8, alpha: 0.5 });
      text(ctx, `COMBO ×${mult.toFixed(2).replace(/\.?0+$/, '')}`, W / 2, 95, { size: 17, color: '#ff5fc8', spacing: 3 });
      meter(ctx, W / 2 - 70, 108, 140, 3, this.comboT / COMBO_TIME, '#ff5fc8', { glow: false });
      y = 140;
    }
    ctx.font = `700 16px "${HUD_FONT}", system-ui, sans-serif`;
    this.toasts.forEach((tt, k) => {
      const a = Math.min(1, tt.t * 2);
      const w = ctx.measureText(tt.msg).width + 38;
      const yy = y + k * 32;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(8,10,24,0.66)';
      ctx.beginPath();
      ctx.roundRect(W / 2 - w / 2, yy - 13, w, 26, 13);
      ctx.fill();
      ctx.fillStyle = tt.color;
      ctx.beginPath();
      ctx.arc(W / 2 - w / 2 + 14, yy, 3.5, 0, TAU);
      ctx.fill();
      ctx.restore();
      text(ctx, tt.msg, W / 2 + 8, yy + 1, { size: 16, color: tt.color, alpha: a });
    });
  }
}

export default {
  id: 'city-adventure',
  title: 'City Adventure',
  art: 'city',
  genre: 'Open World',
  accent: '#22c3e6',
  tagline: 'Team up as a courier crew in a living neon city. Grab cars, dodge traffic, deliver packages before the night shift ends.',
  minPlayers: 1,
  maxPlayers: 4,
  cpu: false,
  controls: { move: 'Walk / steer (pull back to brake)', a: 'Sprint / boost', b: 'Enter / exit car' },
  howTo: [
    'Push the stick where you want to go. In a car, pull the stick back to brake, and turn hard at speed to drift — long drifts pay cash.',
    'Press B next to any car to jump in. Vans are slow but carry 2 packages; sports cars are fast but break easily. Crashes damage your car until it wrecks.',
    'Follow the GPS line to PICKUPs and DROP-OFFs. EXPRESS pays extra and adds 25s if you beat its timer; FRAGILE loses value every time you crash.',
    'Chain deliveries for a combo. Traffic stops at red lights and people cross at crosswalks — hit a pedestrian and it costs you. Night falls as the shift goes on.',
  ],
  // Neon-noir grade: deep teal shadows, magenta-tinted highlights, strong bloom.
  post: {
    bloom: 0.8,
    threshold: 0.6,
    knee: 0.3,
    exposure: 1.05,
    contrast: 1.1,
    saturation: 1.15,
    vignette: 0.4,
    aberration: 0.0016,
    grain: 0.035,
    shadows: [0.0, 0.035, 0.065],
    highlights: [0.06, -0.01, 0.05],
  },
  create: (opts) => new CityAdventure(opts),
};
