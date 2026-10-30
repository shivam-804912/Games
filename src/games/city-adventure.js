import { mulberry32, shade } from '../utils/random.js';
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
const MS = 0.25; // scale of the minimap and light-mask canvases
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
  ['#2a2260', '#1b1645'],
  ['#20305e', '#141f42'],
  ['#3a1f55', '#24133a'],
  ['#1d3b4f', '#122835'],
  ['#2f2a4a', '#1d1a30'],
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

function paintCity(city) {
  const c = makeCanvas(WORLD_W, WORLD_H);
  const g = c.getContext('2d');
  const r = city.rand01;

  // Asphalt everywhere; blocks are painted on top.
  g.fillStyle = '#1d1a31';
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let k = 0; k < 9000; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.07)';
    g.fillRect(r() * WORLD_W, r() * WORLD_H, 3, 3);
  }

  // Centre lines
  g.strokeStyle = 'rgba(250,204,21,0.38)';
  g.lineWidth = 3;
  g.setLineDash([26, 22]);
  g.beginPath();
  for (const x of ROADS_X) {
    g.moveTo(x, 0);
    g.lineTo(x, WORLD_H);
  }
  for (const y of ROADS_Y) {
    g.moveTo(0, y);
    g.lineTo(WORLD_W, y);
  }
  g.stroke();
  g.setLineDash([]);

  // Intersections, crosswalks and stop lines
  for (let ix = 0; ix < ROADS_X.length; ix++) {
    for (let iy = 0; iy < ROADS_Y.length; iy++) {
      const x = ROADS_X[ix];
      const y = ROADS_Y[iy];
      g.fillStyle = '#1a1730';
      g.fillRect(x - HALF, y - HALF, ROAD, ROAD);
      g.fillStyle = 'rgba(255,255,255,0.2)';
      for (let k = -HALF + 10; k < HALF - 8; k += 14) {
        g.fillRect(x + k, y - HALF - 16, 8, 14);
        g.fillRect(x + k, y + HALF + 2, 8, 14);
        g.fillRect(x - HALF - 16, y + k, 14, 8);
        g.fillRect(x + HALF + 2, y + k, 14, 8);
      }
      g.strokeStyle = 'rgba(255,255,255,0.42)';
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

  // Blocks: paved sidewalk ring, curb, inner lot
  for (const b of city.blocks) {
    g.fillStyle = '#48426e';
    g.fillRect(b.x, b.y, b.w, b.h);
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
    g.fillStyle = b.park ? '#14382f' : '#2b2647';
    g.fillRect(b.x + 18, b.y + 18, b.w - 36, b.h - 36);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2;
    g.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
  }

  // Outer wall
  g.fillStyle = '#0c0a1d';
  for (const s of city.solids.slice(0, 4)) g.fillRect(s.x, s.y, s.w, s.h);

  // Parks
  for (const p of city.parks) {
    g.strokeStyle = '#2a5a48';
    g.lineWidth = 14;
    g.beginPath();
    g.moveTo(p.x + 18, p.y + p.h / 2);
    g.lineTo(p.x + p.w - 18, p.y + p.h / 2);
    g.moveTo(p.x + p.w / 2, p.y + 18);
    g.lineTo(p.x + p.w / 2, p.y + p.h - 18);
    g.stroke();
    g.fillStyle = '#1e4f6b';
    g.beginPath();
    g.arc(p.x + p.w / 2, p.y + p.h / 2, 30, 0, TAU);
    g.fill();
    g.strokeStyle = '#38d9ff';
    g.lineWidth = 3;
    g.stroke();
    for (let t = 0; t < 14; t++) {
      const tx = p.x + 34 + r() * (p.w - 68);
      const ty = p.y + 34 + r() * (p.h - 68);
      if (Math.abs(tx - (p.x + p.w / 2)) < 26 || Math.abs(ty - (p.y + p.h / 2)) < 26) continue;
      const tr = 12 + r() * 10;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(tx + tr * 0.6, ty + tr * 0.8, tr, 0, TAU);
      g.fill();
      g.fillStyle = r() < 0.5 ? '#1f7a55' : '#24945f';
      g.beginPath();
      g.arc(tx, ty, tr, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      g.arc(tx - tr * 0.3, ty - tr * 0.3, tr * 0.45, 0, TAU);
      g.fill();
    }
  }

  // Building shadows (sun low in the top-left), one path so overlaps don't stack.
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.beginPath();
  for (const b of city.buildings) {
    const L = b.h3 * 520;
    const dx = L * 0.75;
    const dy = L;
    g.moveTo(b.x, b.y);
    g.lineTo(b.x + b.w, b.y);
    g.lineTo(b.x + b.w + dx, b.y + dy);
    g.lineTo(b.x + b.w + dx, b.y + b.h + dy);
    g.lineTo(b.x + dx, b.y + b.h + dy);
    g.lineTo(b.x, b.y + b.h);
    g.closePath();
  }
  g.fill();

  // Rooftops. These are painted at ground level and lifted into place at
  // render time, so the 3D buildings reuse this art.
  for (const b of city.buildings) {
    const [top, bottom] = ROOF[b.hue];
    const grad = g.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(b.x, b.y, b.w, b.h);
    // Parapet
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 5;
    g.strokeRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 2;
    g.strokeRect(b.x + 7, b.y + 7, b.w - 14, b.h - 14);

    if (b.detail === 0) {
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.22, 0, TAU);
      g.stroke();
      g.font = `${Math.min(b.w, b.h) * 0.2}px "Russo One", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillText('H', b.x + b.w / 2, b.y + b.h / 2);
    } else if (b.detail === 1) {
      // AC units
      for (let k = 0; k < Math.min(4, Math.floor((b.w - 20) / 20)); k++) {
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(b.x + 18 + k * 20, b.y + 18, 14, 14);
        g.fillStyle = 'rgba(180,180,220,0.4)';
        g.fillRect(b.x + 14 + k * 20, b.y + 14, 14, 14);
        g.strokeStyle = 'rgba(0,0,0,0.3)';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(b.x + 21 + k * 20, b.y + 21, 4, 0, TAU);
        g.stroke();
      }
    } else if (b.detail === 2) {
      // Skylights
      g.fillStyle = 'rgba(56,217,255,0.14)';
      for (let yy = b.y + 14; yy < b.y + b.h - 20; yy += 18) g.fillRect(b.x + 14, yy, b.w - 28, 10);
    } else {
      // Water tank
      const tx = b.x + b.w * 0.7;
      const ty = b.y + b.h * 0.3;
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(tx + 4, ty + 5, 13, 0, TAU);
      g.fill();
      g.fillStyle = '#6b5f7e';
      g.beginPath();
      g.arc(tx, ty, 13, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(tx, ty, 8, 0, TAU);
      g.stroke();
    }
    // Vents
    for (let k = 0; k < 3; k++) {
      const vx = b.x + 14 + r() * (b.w - 34);
      const vy = b.y + b.h * 0.55 + r() * (b.h * 0.45 - 22);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(vx + 2, vy + 2, 8, 8);
      g.fillStyle = 'rgba(200,200,230,0.28)';
      g.fillRect(vx, vy, 8, 8);
    }
  }

  // Street-light pools
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const l of city.lamps) {
    const light = g.createRadialGradient(l.x, l.y, 0, l.x, l.y, 130);
    light.addColorStop(0, 'rgba(255,214,150,0.14)');
    light.addColorStop(1, 'rgba(255,214,150,0)');
    g.fillStyle = light;
    g.fillRect(l.x - 130, l.y - 130, 260, 260);
  }
  g.restore();
  return c;
}

// Flat map used by the radar and the 3-player city map.
function paintMini(city) {
  const c = makeCanvas(WORLD_W * MS, WORLD_H * MS);
  const g = c.getContext('2d');
  g.scale(MS, MS);
  g.fillStyle = '#5a53a3';
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (const b of city.blocks) {
    g.fillStyle = b.park ? '#1d6a4c' : '#231e45';
    g.fillRect(b.x, b.y, b.w, b.h);
  }
  g.fillStyle = '#3a3370';
  for (const b of city.buildings) g.fillRect(b.x, b.y, b.w, b.h);
  g.fillStyle = '#0a0818';
  for (const s of city.solids.slice(0, 4)) g.fillRect(s.x, s.y, s.w, s.h);
  return c;
}

// Where light falls at night: punched out of the darkness overlay.
function paintLightMask(city) {
  const c = makeCanvas(WORLD_W * MS, WORLD_H * MS);
  const g = c.getContext('2d');
  g.scale(MS, MS);
  const glow = (x, y, rad, a) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.5, `rgba(255,255,255,${a * 0.5})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  for (const l of city.lamps) glow(l.x, l.y, 160, 0.92);
  for (const x of ROADS_X) for (const y of ROADS_Y) glow(x, y, 80, 0.35);
  for (const p of city.parks) glow(p.x + p.w / 2, p.y + p.h / 2, 90, 0.6);
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

function makeHalo() {
  const c = makeCanvas(180, 180);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(90, 90, 0, 90, 90, 90);
  grad.addColorStop(0, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 180, 180);
  return c;
}

// Top-down car sprite, facing +x, with a 4px margin.
function makeCarSprite(kind, color) {
  const v = VEHICLES[kind];
  const L = v.len;
  const Wd = v.wid;
  const c = makeCanvas(L + 8, Wd + 8);
  const g = c.getContext('2d');
  g.translate(L / 2 + 4, Wd / 2 + 4);
  const dark = shade(color, -0.35);
  const body = () => {
    g.beginPath();
    g.roundRect(-L / 2, -Wd / 2, L, Wd, kind === 'van' ? 5 : 8);
    g.fill();
  };
  g.fillStyle = color;
  body();
  const grad = g.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.22)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = grad;
  body();

  g.fillStyle = '#1b2440';
  if (kind === 'van') {
    g.fillStyle = shade(color, 0.12);
    g.fillRect(-L / 2 + 3, -Wd / 2 + 3, L - 22, Wd - 6);
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = -L / 2 + 10; x < L / 2 - 20; x += 8) {
      g.moveTo(x, -Wd / 2 + 4);
      g.lineTo(x, Wd / 2 - 4);
    }
    g.stroke();
    g.fillStyle = '#1b2440';
    g.beginPath();
    g.roundRect(L / 2 - 15, -Wd / 2 + 3, 8, Wd - 6, 3);
    g.fill();
  } else if (kind === 'sport') {
    g.fillStyle = dark;
    g.beginPath();
    g.roundRect(-16, -Wd / 2 + 4, 22, Wd - 8, 6);
    g.fill();
    g.fillStyle = '#1b2440';
    g.beginPath();
    g.roundRect(3, -Wd / 2 + 5, 7, Wd - 10, 3);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillRect(11, -3, L / 2 - 14, 2);
    g.fillRect(11, 1, L / 2 - 14, 2);
    g.fillRect(-L / 2 + 5, -3, 10, 2);
    g.fillRect(-L / 2 + 5, 1, 10, 2);
    g.fillStyle = shade(color, -0.5);
    g.fillRect(-L / 2, -Wd / 2 + 1, 4, Wd - 2);
  } else {
    g.fillStyle = dark;
    g.beginPath();
    g.roundRect(-12, -Wd / 2 + 3, 26, Wd - 6, 5);
    g.fill();
    g.fillStyle = '#1b2440';
    g.beginPath();
    g.roundRect(9, -Wd / 2 + 4, 8, Wd - 8, 3);
    g.fill();
    g.fillRect(-17, -Wd / 2 + 5, 5, Wd - 10);
  }
  // Mirrors
  g.fillStyle = dark;
  const mx = kind === 'van' ? L / 2 - 16 : 6;
  g.fillRect(mx, -Wd / 2 - 2, 4, 3);
  g.fillRect(mx, Wd / 2 - 1, 4, 3);
  // Lamps (unlit; the glow pass lights them)
  g.fillStyle = '#d8d2a8';
  g.fillRect(L / 2 - 4, -Wd / 2 + 2, 4, 6);
  g.fillRect(L / 2 - 4, Wd / 2 - 8, 4, 6);
  g.fillStyle = '#7a1424';
  g.fillRect(-L / 2, -Wd / 2 + 2, 3, 6);
  g.fillRect(-L / 2, Wd / 2 - 8, 3, 6);
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
    this.world = paintCity(this.city);
    this.worldG = this.world.getContext('2d');
    this.solids = this.city.solids;
    this.grid = buildGrid(this.solids);
    this.buildings = this.city.buildings;
    this.lamps = this.city.lamps;
    this.mini = paintMini(this.city);
    this.lightMask = paintLightMask(this.city);
    this.lightCanvas = makeCanvas(W, H);
    this.lightCtx = this.lightCanvas.getContext('2d');
    this.beamCut = makeBeam('255,255,255');
    this.beamGlow = makeBeam('255,236,180');
    this.halo = makeHalo();
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

  render(ctx) {
    ctx.fillStyle = '#0b0920';
    ctx.fillRect(0, 0, W, H);
    // Camera easing based on elapsed time, so it keeps up at any frame rate.
    this.camK = 1 - Math.exp(-(this.time - (this.lastRender ?? this.time)) * 8);
    this.lastRender = this.time;
    this.players.forEach((p, i) => this.renderView(ctx, this.views[i], p));

    // Split lines
    ctx.strokeStyle = '#05040d';
    ctx.lineWidth = 6;
    ctx.beginPath();
    if (this.views.length >= 2) {
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
    }
    if (this.views.length >= 3) {
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
    }
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
    const inView = (x, y, m = 80) => x > cx - m && x < cx + vw + m && y > cy - m && y < cy + vh + m;
    const dark = this.darkness();
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

    // Ground + everything that night should darken
    enter();
    ctx.drawImage(this.world, cx, cy, vw, vh, cx, cy, vw, vh);
    if (route) this.drawRoute(ctx, route, goal.color);
    for (const ped of this.peds) if (inView(ped.x, ped.y)) this.drawPed(ctx, ped);
    for (const car of this.cars) if (inView(car.x, car.y)) this.drawCar(ctx, car);
    for (const pl of this.players) if (!pl.car && inView(pl.x, pl.y)) this.drawPerson(ctx, pl);
    this.drawSmoke(ctx, inView);
    this.drawSignals(ctx, inView, false);
    const blds = this.drawBuildings(ctx, cx + vw / 2, cy + vh / 2, cx, cy, vw, vh);
    const dusk = this.dusk();
    if (dusk > 0) {
      ctx.fillStyle = `rgba(255,128,60,${dusk * 0.09})`;
      ctx.fillRect(cx, cy, vw, vh);
    }
    ctx.restore();

    if (dark > 0.01) this.drawDarkness(ctx, view, cx, cy, vw, vh, dark, inView);

    // Glow pass: lights and anything that must stay readable at night
    enter();
    this.drawNightBuildings(ctx, blds, dark);
    this.drawLamps(ctx, inView, dark);
    this.drawSignals(ctx, inView, true);
    for (const car of this.cars) if (inView(car.x, car.y, 240)) this.drawCarLights(ctx, car, dark);
    for (const coin of this.coins) if (inView(coin.x, coin.y)) this.drawCoin(ctx, coin);
    for (const job of this.jobs) {
      if (job.stage === 'pickup' && inView(job.x, job.y)) this.drawPickup(ctx, job);
      if (job.stage === 'carry' && inView(job.dx, job.dy)) this.drawDrop(ctx, job);
    }
    for (const pl of this.players) if (inView(pl.x, pl.y)) this.drawTags(ctx, pl);
    this.particles.render(ctx);
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
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(a);
        ctx.shadowColor = goal.color;
        ctx.shadowBlur = 16;
        ctx.fillStyle = goal.color;
        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(-10, -15);
        ctx.lineTo(-4, 0);
        ctx.lineTo(-10, 15);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        const meters = Math.round(dist(p.x, p.y, goal.x, goal.y) / 10);
        text(ctx, `${goal.label} ${meters}m`, ax - Math.cos(a) * 46, ay - Math.sin(a) * 30, {
          size: 13,
          font: 'Inter',
          weight: 800,
          color: goal.color,
        });
      }
    }

    this.drawLabel(ctx, view, p);
    this.drawRadar(ctx, view, p, goal, route);
  }

  drawLabel(ctx, view, p) {
    const ly = view.y + (view.y === 0 ? 76 : 12); // clear of the centre timer
    const rows = p.cargo.length;
    ctx.fillStyle = 'rgba(9,7,32,0.75)';
    ctx.beginPath();
    ctx.roundRect(view.x + 12, ly, 256, 34 + rows * 20, 9);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(view.x + 30, ly + 17, 7, 0, TAU);
    ctx.fill();
    const nearCar = this.cars.some((c) => !c.driver && !c.wrecked && dist(c.x, c.y, p.x, p.y) < 70);
    const full = p.cargo.length >= this.capacity(p);
    const hint = p.car
      ? `${VEHICLES[p.car.kind].label} · B: out · A: boost`
      : nearCar
        ? 'B: get in the car'
        : full
          ? 'Deliver the package!'
          : 'A: sprint';
    text(ctx, p.name, view.x + 44, ly + 10, { size: 13, font: 'Inter', weight: 800, align: 'left' });
    text(ctx, hint, view.x + 44, ly + 25, { size: 11, font: 'Inter', weight: 600, align: 'left', color: '#c4bdf5' });
    if (p.car) {
      const spec = VEHICLES[p.car.kind];
      const hp = p.car.hp / spec.hp;
      text(ctx, `${Math.round(Math.hypot(p.car.vx, p.car.vy) * 0.3)} km/h`, view.x + 258, ly + 9, { size: 11, font: 'Inter', weight: 800, align: 'right', color: '#fff' });
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(view.x + 206, ly + 17, 52, 5);
      ctx.fillRect(view.x + 206, ly + 25, 52, 5);
      ctx.fillStyle = '#38d9ff';
      ctx.fillRect(view.x + 206, ly + 17, 52 * p.boost, 5);
      ctx.fillStyle = hp > 0.55 ? '#22d36b' : hp > 0.25 ? '#facc15' : '#ff3b5c';
      ctx.fillRect(view.x + 206, ly + 25, 52 * hp, 5);
    }
    p.cargo.forEach((job, k) => {
      const y = ly + 44 + k * 20;
      const color = jobColor(job);
      ctx.fillStyle = color;
      ctx.fillRect(view.x + 24, y - 5, 10, 10);
      let status = JOB_TYPES[job.type].label;
      if (job.type === 'express') status += `  ${Math.ceil(job.timer)}s`;
      if (job.type === 'fragile') status += `  ${Math.round(job.integrity)}%`;
      const urgent = job.type === 'express' && job.timer < 8 && Math.floor(this.time * 4) % 2;
      text(ctx, status, view.x + 44, y, { size: 11, font: 'Inter', weight: 800, align: 'left', color: urgent ? '#ff3b5c' : color });
    });
  }

  drawRoute(ctx, pts, color) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([2, 18]);
    ctx.lineDashOffset = -this.time * 40;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.stroke();
    ctx.restore();
  }

  // Buildings as extruded blocks: the roof leans away from the camera,
  // revealing the walls that face it. Farthest drawn first.
  drawBuildings(ctx, camX, camY, cx, cy, vw, vh) {
    const list = [];
    for (const b of this.buildings) {
      if (b.x + b.w < cx - 160 || b.x > cx + vw + 160 || b.y + b.h < cy - 160 || b.y > cy + vh + 160) continue;
      const dx = b.x + b.w / 2 - camX;
      const dy = b.y + b.h / 2 - camY;
      list.push({ b, ox: dx * b.h3, oy: dy * b.h3, d: Math.abs(dx) + Math.abs(dy) });
    }
    list.sort((a, c) => c.d - a.d);
    for (const { b, ox, oy } of list) {
      const sx = ox > 0 ? b.x : b.x + b.w;
      const sy = oy > 0 ? b.y : b.y + b.h;
      ctx.fillStyle = b.wallV;
      ctx.beginPath();
      ctx.moveTo(sx, b.y);
      ctx.lineTo(sx, b.y + b.h);
      ctx.lineTo(sx + ox, b.y + b.h + oy);
      ctx.lineTo(sx + ox, b.y + oy);
      ctx.fill();
      ctx.fillStyle = b.wallH;
      ctx.beginPath();
      ctx.moveTo(b.x, sy);
      ctx.lineTo(b.x + b.w, sy);
      ctx.lineTo(b.x + b.w + ox, sy + oy);
      ctx.lineTo(b.x + ox, sy + oy);
      ctx.fill();
      // Floor lines
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let f = 1; f < b.floors; f++) {
        const t = f / b.floors;
        ctx.moveTo(sx + ox * t, b.y + oy * t);
        ctx.lineTo(sx + ox * t, b.y + b.h + oy * t);
        ctx.moveTo(b.x + ox * t, sy + oy * t);
        ctx.lineTo(b.x + b.w + ox * t, sy + oy * t);
      }
      ctx.stroke();
      ctx.drawImage(this.world, b.x, b.y, b.w, b.h, b.x + ox, b.y + oy, b.w, b.h);
    }
    return list;
  }

  drawNightBuildings(ctx, list, dark) {
    // Lit windows once the sun is down
    if (dark > 0.08) {
      ctx.save();
      ctx.setLineDash([6, 7]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(255,214,140,${Math.min(0.85, dark * 1.2)})`;
      ctx.beginPath();
      for (const { b, ox, oy } of list) {
        const sx = ox > 0 ? b.x : b.x + b.w;
        const sy = oy > 0 ? b.y : b.y + b.h;
        for (let f = 0; f < b.floors; f++) {
          const t = (f + 0.5) / b.floors;
          if (Math.abs(ox) > 14) {
            ctx.moveTo(sx + ox * t, b.y + 6 + oy * t);
            ctx.lineTo(sx + ox * t, b.y + b.h - 6 + oy * t);
          }
          if (Math.abs(oy) > 14) {
            ctx.moveTo(b.x + 6 + ox * t, sy + oy * t);
            ctx.lineTo(b.x + b.w - 6 + ox * t, sy + oy * t);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }
    // Neon roof trim
    for (const { b, ox, oy } of list) {
      if (!b.neon) continue;
      ctx.strokeStyle = b.neonCol;
      ctx.globalAlpha = 0.18 + dark * 0.4;
      ctx.lineWidth = 8;
      ctx.strokeRect(b.x + ox + 2, b.y + oy + 2, b.w - 4, b.h - 4);
      ctx.globalAlpha = 0.6 + dark * 0.5;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(b.x + ox + 2, b.y + oy + 2, b.w - 4, b.h - 4);
      ctx.globalAlpha = 1;
    }
  }

  drawDarkness(ctx, view, cx, cy, vw, vh, dark, inView) {
    const z = this.zoom;
    const lg = this.lightCtx;
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.globalCompositeOperation = 'source-over';
    lg.clearRect(0, 0, view.w, view.h);
    lg.fillStyle = `rgba(5,7,28,${dark})`;
    lg.fillRect(0, 0, view.w, view.h);
    // Punch out street lights, headlights and a halo around each player.
    lg.globalCompositeOperation = 'destination-out';
    lg.setTransform(z, 0, 0, z, -cx * z, -cy * z);
    lg.drawImage(this.lightMask, cx * MS, cy * MS, vw * MS, vh * MS, cx, cy, vw, vh);
    for (const car of this.cars) {
      if (car.wrecked || !(car.driver || car.npc) || !inView(car.x, car.y, 240)) continue;
      const c = Math.cos(car.angle);
      const s = Math.sin(car.angle);
      lg.setTransform(z * c, z * s, -z * s, z * c, (car.x - cx) * z, (car.y - cy) * z);
      lg.drawImage(this.beamCut, VEHICLES[car.kind].len / 2 - 4, -BEAM_H / 2);
    }
    lg.setTransform(z, 0, 0, z, -cx * z, -cy * z);
    for (const pl of this.players) if (inView(pl.x, pl.y)) lg.drawImage(this.halo, pl.x - 90, pl.y - 90);
    lg.globalCompositeOperation = 'source-over';
    lg.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.lightCanvas, 0, 0, view.w, view.h, view.x, view.y, view.w, view.h);
  }

  drawLamps(ctx, inView, dark) {
    for (const l of this.lamps) {
      if (!inView(l.x, l.y, 20)) continue;
      ctx.fillStyle = '#0d0b1c';
      ctx.beginPath();
      ctx.arc(l.x, l.y, 4.5, 0, TAU);
      ctx.fill();
      if (dark > 0.05) {
        ctx.globalAlpha = dark * 0.6;
        ctx.fillStyle = '#ffd696';
        ctx.beginPath();
        ctx.arc(l.x, l.y, 11, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = dark > 0.05 ? '#fff1cf' : '#8a86a8';
      ctx.beginPath();
      ctx.arc(l.x, l.y, 3, 0, TAU);
      ctx.fill();
    }
  }

  drawSignals(ctx, inView, glow) {
    for (let ix = 0; ix < ROADS_X.length; ix++) {
      for (let iy = 0; iy < ROADS_Y.length; iy++) {
        const x = ROADS_X[ix];
        const y = ROADS_Y[iy];
        if (!inView(x, y, 120)) continue;
        for (const d of approaches(ix, iy)) {
          const r = rightOf(d);
          const px = x - d.x * (HALF + 8) + r.x * (HALF + 8);
          const py = y - d.y * (HALF + 8) + r.y * (HALF + 8);
          if (!glow) {
            ctx.fillStyle = '#0a0918';
            ctx.fillRect(px - 6, py - 6, 12, 12);
            continue;
          }
          const s = this.signal(ix, iy, d.x ? 'ew' : 'ns');
          ctx.fillStyle = s === 'g' ? '#3dff8a' : s === 'y' ? '#ffd23d' : '#ff3b4f';
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(px, py, 9, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  drawSmoke(ctx, inView) {
    for (const s of this.smoke) {
      if (!inView(s.x, s.y, 40)) continue;
      ctx.globalAlpha = s.alpha * (s.life / s.max);
      ctx.fillStyle = `rgb(${s.tone},${s.tone},${s.tone + 12})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawCoin(ctx, coin) {
    const sx = Math.abs(Math.cos(coin.t * 3));
    ctx.save();
    ctx.translate(coin.x, coin.y);
    ctx.scale(Math.max(0.15, sx), 1);
    ctx.shadowColor = '#ffd166';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffc53d';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#b7791f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawPackage(ctx, x, y, job, s = 1) {
    const color = jobColor(job);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = job.type === 'fragile' ? '#d9c2a0' : '#b07a3c';
    ctx.fillRect(-11, -9, 22, 18);
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

  drawPickup(ctx, job) {
    const color = jobColor(job);
    const pulse = (this.time * 1.4) % 1;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 1 - pulse;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(job.x, job.y, 24 + pulse * 40, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillStyle = 'rgba(9,7,32,0.75)';
    ctx.beginPath();
    ctx.arc(job.x, job.y, 22, 0, TAU);
    ctx.fill();
    ctx.restore();
    this.drawPackage(ctx, job.x, job.y + Math.sin(this.time * 4) * 2, job);
    text(ctx, JOB_TYPES[job.type].label, job.x, job.y - 38, { size: 13, font: 'Inter', weight: 800, color });
  }

  drawDrop(ctx, job) {
    const color = jobColor(job);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    for (let k = 0; k < 3; k++) {
      ctx.globalAlpha = 0.9 - k * 0.25;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(job.dx, job.dy, 18 + k * 18 + Math.sin(this.time * 4) * 3, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    const bob = Math.sin(this.time * 5) * 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(job.dx, job.dy - 34 + bob);
    ctx.lineTo(job.dx - 12, job.dy - 54 + bob);
    ctx.lineTo(job.dx + 12, job.dy - 54 + bob);
    ctx.fill();
    text(ctx, 'DROP-OFF', job.dx, job.dy - 70 + bob, { size: 13, font: 'Inter', weight: 800, color });
  }

  drawCar(ctx, car) {
    const v = VEHICLES[car.kind];
    // Shadow (sun from the top-left)
    ctx.save();
    ctx.translate(car.x + 5, car.y + 7);
    ctx.rotate(car.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.roundRect(-v.len / 2, -v.wid / 2, v.len, v.wid, 8);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    if (car.driver) {
      ctx.strokeStyle = car.driver.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-v.len / 2 - 5, -v.wid / 2 - 5, v.len + 10, v.wid + 10, 11);
      ctx.stroke();
    }
    ctx.drawImage(this.sprite(car.kind, car.color), -v.len / 2 - 4, -v.wid / 2 - 4);
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
      ctx.fillStyle = 'rgba(12,10,16,0.6)';
      ctx.beginPath();
      ctx.roundRect(-v.len / 2, -v.wid / 2, v.len, v.wid, 8);
      ctx.fill();
    }
    ctx.restore();
  }

  drawCarLights(ctx, car, dark) {
    if (car.wrecked || !(car.driver || car.npc)) return;
    const v = VEHICLES[car.kind];
    const L = v.len / 2;
    const Wd = v.wid / 2;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    if (dark > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = dark * 0.35;
      ctx.drawImage(this.beamGlow, L - 4, -BEAM_H / 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = '#fff6c2';
    ctx.fillRect(L - 4, -Wd + 2, 4, 6);
    ctx.fillRect(L - 4, Wd - 8, 4, 6);
    if (car.braking || dark > 0.1) {
      ctx.fillStyle = car.braking ? '#ff3355' : 'rgba(255,40,70,0.8)';
      ctx.fillRect(-L, -Wd + 2, 3, 6);
      ctx.fillRect(-L, Wd - 8, 3, 6);
      if (car.braking) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(-L, -Wd + 5, 8, 0, TAU);
        ctx.arc(-L, Wd - 5, 8, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // Turn signals
    if (car.blink && Math.floor(this.time * 3) % 2) {
      const y = car.blink > 0 ? Wd - 3 : -Wd - 1;
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(L - 7, y, 5, 4);
      ctx.fillRect(-L + 1, y, 5, 4);
    }
    ctx.restore();
  }

  drawPed(ctx, ped) {
    ctx.save();
    ctx.translate(ped.x, ped.y);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(2, 3, 7, 5, 0, 0, TAU);
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
    ctx.fillStyle = '#1a1726';
    ctx.beginPath();
    ctx.arc(sw, -3, 2.2, 0, TAU);
    ctx.arc(-sw, 3, 2.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = ped.shirt;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 7, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = ped.skin;
    ctx.beginPath();
    ctx.arc(0.5, 0, 3.8, 0, TAU);
    ctx.fill();
    ctx.restore();
    if (ped.scared > 0.6) text(ctx, '!', ped.x, ped.y - 16, { size: 14, font: 'Inter', weight: 900, color: '#ffd166' });
  }

  drawPerson(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(3, 5, PERSON_R + 1, PERSON_R * 0.75, 0, 0, TAU);
    ctx.fill();
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, PERSON_R, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(Math.cos(p.angle) * 7, Math.sin(p.angle) * 7, 4, 0, TAU);
    ctx.fill();
    if (p.stun > 0) {
      for (let k = 0; k < 3; k++) {
        const a = this.time * 6 + (k * TAU) / 3;
        text(ctx, '★', Math.cos(a) * 16, -20 + Math.sin(a) * 5, { size: 12, color: '#ffd166', font: 'Inter' });
      }
    }
    ctx.restore();
  }

  // Name, carried packages and bonus pop-ups above a player (or their car).
  drawTags(ctx, p) {
    const n = p.cargo.length;
    const top = p.car ? 34 : 28;
    p.cargo.forEach((job, k) => this.drawPackage(ctx, p.x + (k - (n - 1) / 2) * 22, p.y - top, job, 0.8));
    text(ctx, p.name, p.x, p.y - (n ? top + 18 : p.car ? 30 : 26), { size: 12, font: 'Inter', weight: 800 });
    if (p.flash) {
      const rise = (1.4 - p.flash.t) * 24;
      text(ctx, p.flash.msg, p.x, p.y - 64 - rise, { size: 15, font: 'Inter', weight: 900, color: p.flash.color, alpha: Math.min(1, p.flash.t * 2), glow: 8 });
    }
  }

  // Per-view radar: local street map with the GPS route.
  drawRadar(ctx, view, p, goal, route) {
    const n = this.views.length;
    const s = n === 1 ? 220 : n === 2 ? 190 : 138;
    const rx = view.x + view.w - s - 14;
    const ry = view.y + view.h - s - 14;
    const span = 1700;
    const k = s / span;
    const ox = p.x - span / 2;
    const oy = p.y - span / 2;
    const tx = (x) => rx + (x - ox) * k;
    const ty = (y) => ry + (y - oy) * k;
    const cl = (v, a) => clamp(v, a + 7, a + s - 7);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(rx, ry, s, s, 14);
    ctx.fillStyle = 'rgba(9,7,32,0.88)';
    ctx.fill();
    ctx.clip();
    const x0 = Math.max(0, ox);
    const y0 = Math.max(0, oy);
    const x1 = Math.min(WORLD_W, ox + span);
    const y1 = Math.min(WORLD_H, oy + span);
    if (x1 > x0 && y1 > y0) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.mini, x0 * MS, y0 * MS, (x1 - x0) * MS, (y1 - y0) * MS, tx(x0), ty(y0), (x1 - x0) * k, (y1 - y0) * k);
      ctx.globalAlpha = 1;
    }
    if (route) {
      ctx.strokeStyle = goal.color;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      route.forEach((q, i) => (i ? ctx.lineTo(tx(q.x), ty(q.y)) : ctx.moveTo(tx(q.x), ty(q.y))));
      ctx.stroke();
    }
    for (const job of this.jobs) {
      ctx.fillStyle = jobColor(job);
      if (job.stage === 'pickup') ctx.fillRect(cl(tx(job.x), rx) - 4, cl(ty(job.y), ry) - 4, 8, 8);
      else if (job.carrier === p) {
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
    ctx.restore();

    // You-are-here arrow
    ctx.save();
    ctx.translate(rx + s / 2, ry + s / 2);
    ctx.rotate(p.car ? p.car.angle : p.angle);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(139,108,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(rx, ry, s, s, 14);
    ctx.stroke();
    if (goal) {
      const meters = Math.round(dist(p.x, p.y, goal.x, goal.y) / 10);
      text(ctx, `GPS · ${goal.label} ${meters}m`, rx + s / 2, ry - 11, { size: 12, font: 'Inter', weight: 800, color: goal.color });
    }
  }

  // Whole-city map, shown in the spare quadrant with three players.
  drawMinimap(ctx) {
    ctx.fillStyle = '#0b0920';
    ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
    text(ctx, 'CITY MAP', W / 2 + 120, H / 2 + 36, { size: 18, align: 'left', color: '#c4bdf5' });
    const box = { x: W / 2 + 120, y: H / 2 + 60, w: 480, h: 360 };
    const sx = box.w / WORLD_W;
    const sy = box.h / WORLD_H;
    ctx.fillStyle = 'rgba(9,7,32,0.85)';
    ctx.beginPath();
    ctx.roundRect(box.x - 6, box.y - 6, box.w + 12, box.h + 12, 10);
    ctx.fill();
    ctx.drawImage(this.mini, box.x, box.y, box.w, box.h);
    for (const job of this.jobs) {
      const x = box.x + (job.stage === 'pickup' ? job.x : job.dx) * sx;
      const y = box.y + (job.stage === 'pickup' ? job.y : job.dy) * sy;
      ctx.fillStyle = jobColor(job);
      if (job.stage === 'pickup') ctx.fillRect(x - 4, y - 4, 8, 8);
      else {
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

  drawHud(ctx) {
    const low = this.clock <= 15 && this.intro <= 0;
    ctx.fillStyle = 'rgba(9,7,32,0.82)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 190, 10, 380, 56, 14);
    ctx.fill();
    ctx.strokeStyle = low ? '#ff3b5c' : 'rgba(139,108,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    const t = Math.ceil(this.clock);
    text(ctx, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, W / 2 - 110, 38, {
      size: 30,
      color: low && Math.floor(this.time * 4) % 2 ? '#ff3b5c' : '#fff',
    });
    text(ctx, money(this.team), W / 2 + 10, 31, { size: 22, color: '#facc15' });
    text(ctx, `${this.deliveries} delivered`, W / 2 + 10, 52, { size: 12, font: 'Inter', weight: 700, color: '#c4bdf5' });
    const night = this.darkness() > 0.3;
    text(ctx, night ? '☾' : '☀', W / 2 + 118, 30, { size: 18, font: 'Inter', color: night ? '#c4bdf5' : '#ffb347' });
    text(ctx, this.clockLabel(), W / 2 + 130, 52, { size: 12, font: 'Inter', weight: 800, color: '#c4bdf5' });

    let y = 92;
    if (this.combo > 1 && this.comboT > 0) {
      const mult = Math.min(2, 1 + 0.25 * (this.combo - 1));
      text(ctx, `COMBO x${mult.toFixed(2).replace(/\.?0+$/, '')}`, W / 2, 84, { size: 16, color: '#ff5fc8', glow: 10 });
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(W / 2 - 60, 96, 120, 4);
      ctx.fillStyle = '#ff5fc8';
      ctx.fillRect(W / 2 - 60, 96, (120 * this.comboT) / COMBO_TIME, 4);
      y = 120;
    }
    this.toasts.forEach((tt, k) => {
      text(ctx, tt.msg, W / 2, y + k * 26, { size: 17, font: 'Inter', weight: 800, color: tt.color, alpha: Math.min(1, tt.t * 2), glow: 8 });
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
  create: (opts) => new CityAdventure(opts),
};
