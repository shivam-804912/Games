import { mulberry32, shade } from '../utils/random.js';
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

// Mown grass: two-tone stripes plus a little noise.
function grassTile(a, b, rnd) {
  const c = makeCanvas(192, 192);
  const g = c.getContext('2d');
  g.fillStyle = a;
  g.fillRect(0, 0, 192, 192);
  g.fillStyle = b;
  g.fillRect(96, 0, 96, 192);
  for (let k = 0; k < 2600; k++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(160,220,140,${0.07 * rnd()})` : `rgba(0,0,0,${0.16 * rnd()})`;
    g.fillRect(rnd() * 192, rnd() * 192, 1 + rnd() * 2, 2 + rnd() * 3);
  }
  return c;
}

function paintCar(color) {
  const c = makeCanvas(76, 40);
  const g = c.getContext('2d');
  g.translate(38, 20);
  // Rear tyres (the fronts are drawn live so they can steer)
  g.fillStyle = '#101014';
  g.beginPath();
  g.roundRect(-27, -17.5, 14, 7, 2);
  g.roundRect(-27, 10.5, 14, 7, 2);
  g.fill();
  // Body with a rounded-top shading
  const body = g.createLinearGradient(0, -15, 0, 15);
  body.addColorStop(0, shade(color, -0.5));
  body.addColorStop(0.22, color);
  body.addColorStop(0.5, shade(color, 0.3));
  body.addColorStop(0.78, color);
  body.addColorStop(1, shade(color, -0.5));
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(-30, -11);
  g.quadraticCurveTo(-31, -14, -26, -14);
  g.lineTo(-6, -14);
  g.quadraticCurveTo(2, -12, 14, -13);
  g.quadraticCurveTo(30, -12, 32, -4);
  g.lineTo(32, 4);
  g.quadraticCurveTo(30, 12, 14, 13);
  g.quadraticCurveTo(2, 12, -6, 14);
  g.lineTo(-26, 14);
  g.quadraticCurveTo(-31, 14, -30, 11);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 1.5;
  g.stroke();
  // Racing stripes
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(-30, -4.5, 62, 3);
  g.fillRect(-30, 1.5, 62, 3);
  // Cabin, glass and a roof highlight
  g.fillStyle = shade(color, -0.2);
  g.beginPath();
  g.roundRect(-15, -11, 28, 22, 6);
  g.fill();
  g.fillStyle = '#16203a';
  g.beginPath();
  g.moveTo(5, -10);
  g.lineTo(14, -8);
  g.lineTo(14, 8);
  g.lineTo(5, 10);
  g.closePath();
  g.fill();
  g.fillRect(-16, -8, 4, 16);
  g.strokeStyle = 'rgba(170,210,255,0.55)';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(8, -7);
  g.lineTo(12, 3);
  g.stroke();
  const roof = g.createLinearGradient(-10, -9, 4, 9);
  roof.addColorStop(0, shade(color, 0.35));
  roof.addColorStop(1, shade(color, -0.1));
  g.fillStyle = roof;
  g.beginPath();
  g.roundRect(-11, -8.5, 15, 17, 4);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(-11, -4.5, 15, 3);
  g.fillRect(-11, 1.5, 15, 3);
  // Rear wing, mirrors, lamps
  g.fillStyle = '#15151b';
  g.fillRect(-34, -15, 5, 30);
  g.fillStyle = shade(color, -0.35);
  g.fillRect(6, -16, 4, 3);
  g.fillRect(6, 13, 4, 3);
  g.fillStyle = '#fff6d6';
  g.fillRect(29, -11, 3, 5);
  g.fillRect(29, 6, 3, 5);
  g.fillStyle = '#7a0f1e';
  g.fillRect(-31, -12, 2, 5);
  g.fillRect(-31, 7, 2, 5);
  return c;
}

function paintLightSprites() {
  // Headlight beam, drawn additively in front of every car.
  const head = makeCanvas(300, 150);
  let g = head.getContext('2d');
  let grd = g.createRadialGradient(0, 75, 4, 0, 75, 300);
  grd.addColorStop(0, 'rgba(255,240,205,0.32)');
  grd.addColorStop(1, 'rgba(255,240,205,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, 58);
  g.lineTo(300, 0);
  g.lineTo(300, 150);
  g.lineTo(0, 92);
  g.closePath();
  g.fill();

  const brake = makeCanvas(40, 40);
  g = brake.getContext('2d');
  grd = g.createRadialGradient(20, 20, 1, 20, 20, 20);
  grd.addColorStop(0, 'rgba(255,70,70,0.95)');
  grd.addColorStop(0.3, 'rgba(255,30,40,0.45)');
  grd.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 40, 40);

  // Nitro flame, anchored at its right edge (the exhaust).
  const flame = makeCanvas(80, 28);
  g = flame.getContext('2d');
  grd = g.createLinearGradient(80, 0, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.25, 'rgba(120,220,255,0.9)');
  grd.addColorStop(0.6, 'rgba(60,110,255,0.5)');
  grd.addColorStop(1, 'rgba(255,90,40,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(80, 4);
  g.quadraticCurveTo(30, 6, 0, 14);
  g.quadraticCurveTo(30, 22, 80, 24);
  g.closePath();
  g.fill();
  return { head, brake, flame };
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
      ctx.globalAlpha = p.alpha * (p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ HUD */

function panel(ctx, x, y, w, h, r = 12) {
  ctx.fillStyle = 'rgba(9,7,32,0.78)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

// Small pill label; returns its width so several can be stacked in a row.
function tag(ctx, label, x, y, color) {
  ctx.font = '800 14px "Inter", system-ui, sans-serif';
  const w = ctx.measureText(label).width + 24;
  panel(ctx, x, y - 14, w, 28, 14);
  ctx.fillStyle = color;
  ctx.fillRect(x + 8, y - 6, 3, 12);
  text(ctx, label, x + 16, y + 1, { size: 14, font: 'Inter', weight: 800, align: 'left', color });
  return w;
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
    this.tiles = this.sliceTiles(this.paintWorld());
    this.mini = this.paintMini();
    this.sprites = paintLightSprites();
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
        sprite: paintCar(p.color),
      };
    });
    this.humans = this.cars.filter((c) => !c.cpu);
    this.views = splitViews(this.humans.length);
    this.zoom = this.humans.length === 1 ? 0.85 : this.humans.length === 2 ? 0.7 : 0.55;
  }

  dispose() {
    // Free the world textures right away.
    for (const t of this.tiles) {
      t.c.width = 0;
      t.c.height = 0;
    }
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
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Rough grass everywhere
    g.fillStyle = g.createPattern(grassTile('#142a19', '#16301c', rnd), 'repeat');
    g.fillRect(0, 0, WORLD_W, WORLD_H);

    // Tyre walls: stacks of tyres with red/white belts
    let k = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      for (const t of [0, 0.5]) {
        for (const side of [-1, 1]) {
          const [ax, ay] = off(i, side * (wallD[i] + 7));
          const [bx, by] = off(j, side * (wallD[j] + 7));
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          g.fillStyle = 'rgba(0,0,0,0.4)';
          g.beginPath();
          g.arc(x + 3, y + 4, 8, 0, TAU);
          g.fill();
          g.fillStyle = '#0e0e11';
          g.beginPath();
          g.arc(x, y, 7.5, 0, TAU);
          g.fill();
          g.fillStyle = k++ % 6 < 3 ? '#d6283a' : '#eeeeee';
          g.beginPath();
          g.arc(x, y, 4.8, 0, TAU);
          g.fill();
          g.fillStyle = '#0e0e11';
          g.beginPath();
          g.arc(x, y, 2.2, 0, TAU);
          g.fill();
        }
      }
    }

    // Run-off: freshly cut, lighter grass inside the walls
    g.fillStyle = g.createPattern(grassTile('#1d3d22', '#214527', rnd), 'repeat');
    g.beginPath();
    for (let i = 0; i < N; i++) {
      g.moveTo(pts[i].x + wallD[i], pts[i].y);
      g.arc(pts[i].x, pts[i].y, wallD[i], 0, TAU);
    }
    g.fill();

    // Gravel traps on the outside of the big corners
    g.fillStyle = g.createPattern(noiseTile(64, '#9a8257', 900, rnd, { light: 0.25, dark: 0.35 }), 'repeat');
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const side = this.sandSide[i];
      if (!side) continue;
      const r = (wallD[i] - HALF - CURB_W) / 2 - 4;
      const [x, y] = off(i, side * (HALF + CURB_W + 4 + r));
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
    g.fill();

    // Asphalt with white edge lines
    g.strokeStyle = '#dcdcdc';
    g.lineWidth = TRACK_W;
    path();
    g.stroke();
    g.strokeStyle = g.createPattern(noiseTile(128, '#38393f', 2600, rnd), 'repeat');
    g.lineWidth = TRACK_W - 10;
    path();
    g.stroke();

    // Rubbered-in racing line
    g.strokeStyle = 'rgba(0,0,0,0.07)';
    g.lineWidth = 90;
    path((i) => this.line[i]);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = 40;
    path((i) => this.line[i]);
    g.stroke();

    // Rumble-strip curbs on both edges through the corners
    g.lineCap = 'butt';
    for (const run of runs(N, (i) => this.curb[i])) {
      const ext = [(run[0] - 1 + N) % N, ...run, (run.at(-1) + 1) % N];
      for (const side of [-1, 1]) {
        g.lineWidth = CURB_W;
        g.strokeStyle = '#f2f2f2';
        g.setLineDash([]);
        path(() => side * (HALF + CURB_W / 2 - 3), ext);
        g.stroke();
        g.strokeStyle = '#d42a3c';
        g.setLineDash([20, 20]);
        path(() => side * (HALF + CURB_W / 2 - 3), ext);
        g.stroke();
        g.setLineDash([]);
        g.strokeStyle = 'rgba(0,0,0,0.3)';
        g.lineWidth = 2;
        path(() => side * (HALF + CURB_W - 3), ext);
        g.stroke();
      }
    }
    g.lineCap = 'round';

    // Starting grid boxes
    g.strokeStyle = '#f2f2f2';
    g.fillStyle = '#f2f2f2';
    g.font = '800 16px "Inter", system-ui, sans-serif';
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

    // Start / finish
    const s = pts[0];
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.angle);
    const sq = (TRACK_W - 10) / 10;
    for (let row = 0; row < 2; row++) {
      for (let q = 0; q < 10; q++) {
        g.fillStyle = (row + q) % 2 ? '#111' : '#f4f4f4';
        g.fillRect(-sq + row * sq, -HALF + 5 + q * sq, sq, sq);
      }
    }
    g.restore();

    // Boost pads
    for (const p of this.pads) {
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.angle);
      g.shadowColor = '#38d9ff';
      g.shadowBlur = 18;
      g.fillStyle = 'rgba(56,217,255,0.22)';
      g.fillRect(-46, -40, 92, 80);
      g.fillStyle = '#38d9ff';
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

    this.paintScenery(g, rnd, off);
    return c;
  }

  paintScenery(g, rnd, off) {
    const { pts, N, wallD } = this;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x / N;
      my += p.y / N;
    }

    // Grandstands on the outside of the start straight and two big corners
    for (const at of [N - 7, Math.floor(N * 0.27), Math.floor(N * 0.6)]) {
      const p = pts[at];
      const sides = [-1, 1].map((side) => {
        const [x, y] = off(at, side * (wallD[at] + 80));
        return { side, x, y, d: dist(x, y, mx, my) };
      });
      const { x, y } = sides[0].d > sides[1].d ? sides[0] : sides[1];
      for (const len of [420, 300, 200]) {
        const fx = Math.cos(p.angle);
        const fy = Math.sin(p.angle);
        const ok = [-1, 1].every((e) => [-1, 1].every((d) => this.clear(x + fx * e * len * 0.5 - fy * d * 48, y + fy * e * len * 0.5 + fx * d * 48, 10)));
        if (!ok) continue;
        g.save();
        g.translate(x, y);
        g.rotate(p.angle);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(-len / 2 + 10, -42, len, 96);
        g.fillStyle = '#2a2c36';
        g.fillRect(-len / 2, -48, len, 96);
        for (let r = 0; r < 6; r++) {
          const ry = -40 + r * 14;
          g.fillStyle = '#3a3d4a';
          g.fillRect(-len / 2 + 6, ry, len - 12, 10);
          for (let cx = -len / 2 + 8; cx < len / 2 - 10; cx += 7) {
            if (rnd() < 0.18) continue;
            g.fillStyle = ['#ff3b5c', '#4f8bff', '#ffd166', '#f4f4f4', '#22d36b', '#ff8a2b', '#b26bff'][Math.floor(rnd() * 7)];
            g.fillRect(cx, ry + 2, 5, 6);
          }
        }
        g.fillStyle = '#1b1c24';
        g.fillRect(-len / 2, -48, len, 6);
        g.fillRect(-len / 2, 42, len, 6);
        g.restore();
        break;
      }
    }

    // Floodlight towers with warm pools of light spilling onto the track
    for (let i = 0; i < N; i += 34) {
      const side = (i / 34) % 2 ? 1 : -1;
      const [x, y] = off(i, side * (wallD[i] + 34));
      if (!this.clear(x, y, 12)) continue;
      const [lx, ly] = off(i, side * (wallD[i] - 120));
      g.save();
      g.globalCompositeOperation = 'lighter';
      const grd = g.createRadialGradient(lx, ly, 10, lx, ly, 380);
      grd.addColorStop(0, 'rgba(255,236,190,0.13)');
      grd.addColorStop(1, 'rgba(255,236,190,0)');
      g.fillStyle = grd;
      g.fillRect(lx - 380, ly - 380, 760, 760);
      g.restore();
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(x - 6, y - 4, 22, 22);
      g.fillStyle = '#6b6f7d';
      g.fillRect(x - 9, y - 9, 18, 18);
      g.fillStyle = '#fff4cf';
      g.fillRect(x - 6, y - 6, 12, 12);
    }

    // Woods: clusters of trees beyond the walls
    const tree = (x, y, r) => {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(x + r * 0.35, y + r * 0.45, r, 0, TAU);
      g.fill();
      g.fillStyle = '#0f2d17';
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      g.fillStyle = '#17401f';
      g.beginPath();
      g.arc(x - r * 0.15, y - r * 0.15, r * 0.72, 0, TAU);
      g.fill();
      g.fillStyle = '#24582d';
      g.beginPath();
      g.arc(x - r * 0.32, y - r * 0.32, r * 0.36, 0, TAU);
      g.fill();
    };
    for (let k = 0; k < 70; k++) {
      const cx = rnd() * WORLD_W;
      const cy = rnd() * WORLD_H;
      const count = 4 + Math.floor(rnd() * 9);
      for (let t = 0; t < count; t++) {
        const r = 16 + rnd() * 16;
        const x = cx + (rnd() - 0.5) * 220;
        const y = cy + (rnd() - 0.5) * 220;
        if (this.clear(x, y, r + 26)) tree(x, y, r);
      }
    }
  }

  paintMini() {
    const c = makeCanvas(260, 188);
    const g = c.getContext('2d');
    g.scale(260 / WORLD_W, 188 / WORLD_H);
    g.lineJoin = 'round';
    const path = () => {
      g.beginPath();
      this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
    };
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 110;
    path();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 70;
    path();
    g.stroke();
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
    this.humans.forEach((c, k) => this.renderView(ctx, this.views[k], c, order));

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

    if (this.views.length === 3) this.drawBoard(ctx, order);
    if (this.views.length === 1) this.drawStandings(ctx, order, W - 290, 34);
    if (this.state === 'countdown') this.drawLights(ctx);
    else if (this.raceTime < 1) {
      this.drawLights(ctx, 1 - this.raceTime);
      text(ctx, 'GO!', W / 2, H / 2 + 130, { size: 110, color: '#22d36b', glow: 30, alpha: 1 - this.raceTime });
    }
  }

  renderView(ctx, view, car, order) {
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

    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x, view.y, view.w, view.h);
    ctx.clip();
    ctx.translate(view.x, view.y);
    ctx.save();
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    for (const t of this.tilesIn(cx, cy, cx + vw, cy + vh)) ctx.drawImage(t.c, t.x, t.y);
    const vis = this.cars.filter((c) => c.x > cx - 80 && c.x < cx + vw + 80 && c.y > cy - 80 && c.y < cy + vh + 80);
    this.smoke.render(ctx, cx, cy, cx + vw, cy + vh);
    for (const c of vis) this.drawCar(ctx, c);
    this.particles.render(ctx);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const c of vis) this.drawCarLights(ctx, c);
    ctx.restore();
    for (const c of vis) {
      if (c !== car) text(ctx, c.name, c.x, c.y - 42, { size: 13, font: 'Inter', weight: 800, color: '#fff', alpha: 0.85 });
    }
    ctx.restore();
    this.speedLines(ctx, view.w, view.h, car, spd);
    ctx.restore();

    this.drawHud(ctx, view, car, order);
  }

  drawCar(ctx, c) {
    // Shadow, cast down-right by the floodlights
    ctx.save();
    ctx.translate(c.x + 5, c.y + 7);
    ctx.rotate(c.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.roundRect(-32, -16, 64, 32, 10);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#101014';
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(17, side * 13.5);
      ctx.rotate(c.steer * 0.45);
      ctx.fillRect(-6.5, -3.5, 13, 7);
      ctx.restore();
    }
    ctx.drawImage(c.sprite, -38, -20);
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

  // Additive lights: headlight beams, brake lights, nitro flame, draft streaks.
  drawCarLights(ctx, c) {
    const { head, brake, flame } = this.sprites;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.drawImage(head, 30, -75);
    if (c.braking || c.reverse) {
      ctx.globalAlpha = c.reverse ? 0.6 : 1;
      ctx.drawImage(brake, -50, -29);
      ctx.drawImage(brake, -50, -11);
      ctx.globalAlpha = 1;
    }
    if (c.boosting) {
      const len = 0.6 + Math.random() * 0.6;
      ctx.save();
      ctx.translate(-33, 0);
      ctx.scale(len, 0.8 + Math.random() * 0.3);
      ctx.drawImage(flame, -80, -14);
      ctx.restore();
    }
    if (c.draft > 0.25) {
      ctx.strokeStyle = `rgba(200,235,255,${0.35 * c.draft})`;
      ctx.lineWidth = 2;
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

  speedLines(ctx, w, h, car, spd) {
    const k = clamp((spd - MAX * 0.75) / (BOOST_MAX - MAX * 0.75), 0, 1) + (car.boosting ? 0.35 : 0);
    if (k < 0.05) return;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.globalAlpha = Math.min(0.45, k * 0.4);
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

    // Position, lap, lap timer, best lap, gap to the car ahead
    const pos = car.finishTime !== null ? car.place : order.indexOf(car) + 1;
    const x0 = 18;
    const y0 = 16;
    panel(ctx, x0, y0, 290, 112);
    ctx.fillStyle = car.color;
    ctx.fillRect(x0, y0 + 10, 4, 92);
    text(ctx, ordinal(pos), x0 + 16, y0 + 38, { size: 42, align: 'left', color: pos === 1 ? '#ffd166' : '#fff' });
    text(ctx, `/ ${this.cars.length}`, x0 + 104, y0 + 46, { size: 16, align: 'left', color: '#c4bdf5' });
    const lap = clamp(Math.floor(car.progress / this.N) + 1, 1, LAPS);
    text(ctx, car.finishTime !== null ? 'FINISHED' : `LAP ${lap}/${LAPS}`, x0 + 274, y0 + 22, { size: 16, align: 'right' });
    const cur = this.state === 'race' && car.finishTime === null ? this.raceTime - car.lapStart : 0;
    text(ctx, formatTime(cur), x0 + 274, y0 + 48, { size: 20, align: 'right', font: 'Inter', weight: 800 });
    text(ctx, `BEST ${car.best !== null ? formatTime(car.best) : '—'}`, x0 + 274, y0 + 72, { size: 13, align: 'right', font: 'Inter', weight: 800, color: '#c4bdf5' });
    if (pos > 1 && car.finishTime === null && this.state === 'race') {
      const ahead = order[pos - 2];
      const g = this.gap(car, ahead);
      if (g !== null) text(ctx, `▲ ${ahead.name}  +${g.toFixed(1)}s`, x0 + 16, y0 + 94, { size: 13, align: 'left', font: 'Inter', weight: 800, color: ahead.color });
    } else if (pos === 1 && order[1] && car.finishTime === null && this.state === 'race') {
      const g = this.gap(order[1], car);
      if (g !== null) text(ctx, `▼ ${order[1].name}  −${g.toFixed(1)}s`, x0 + 16, y0 + 94, { size: 13, align: 'left', font: 'Inter', weight: 800, color: order[1].color });
    }
    text(ctx, car.name, VW - 20, 30, { size: 14, align: 'right', font: 'Inter', weight: 800, color: car.color });

    // Sector / lap split vs. personal best
    if (car.split) {
      const s = car.split;
      const a = Math.min(1, s.t * 3);
      ctx.save();
      ctx.globalAlpha = a;
      panel(ctx, VW / 2 - 130, 18, 260, 40, 20);
      ctx.restore();
      text(ctx, `${s.label}  ${formatTime(s.time)}`, VW / 2 - 112, 39, { size: 15, align: 'left', font: 'Inter', weight: 800, alpha: a });
      if (s.delta !== null) {
        text(ctx, `${s.delta < 0 ? '−' : '+'}${Math.abs(s.delta).toFixed(2)}`, VW / 2 + 112, 39, { size: 17, align: 'right', font: 'Inter', weight: 800, color: s.delta < 0 ? '#22d36b' : '#ffd166', alpha: a });
      }
    }

    // Speedometer + nitro ring
    this.drawGauge(ctx, 100, VH - 96, car);
    let tx = 192;
    const ty = VH - 40;
    if (car.driftT > 0.15) tx += tag(ctx, 'DRIFT · NITRO +', tx, ty, '#ff5fc8') + 8;
    if (car.draft > 0.35) tx += tag(ctx, 'SLIPSTREAM', tx, ty, '#38d9ff') + 8;
    if (car.surface === 'sand') tx += tag(ctx, 'GRAVEL', tx, ty, '#d9b77a') + 8;
    else if (car.surface === 'grass' && Math.abs(car.speed) > 60) tx += tag(ctx, 'GRASS', tx, ty, '#7fd36b') + 8;
    if (car.nitro >= 0.999 && car.finishTime === null) tag(ctx, 'NITRO FULL', tx, ty, '#ffd166');

    // Personal minimap
    this.drawMinimap(ctx, { x: VW - 236, y: VH - 175, w: 220, h: 159 }, car);

    // Centre messages
    if (car.holdT > 0) {
      text(ctx, `PENALTY ${car.holdT.toFixed(1)}`, VW / 2, VH * 0.3, { size: 46, color: '#ff3b5c' });
    } else if (car.note) {
      const n = car.note;
      const a = Math.min(1, n.t * 2.5, (n.dur - n.t) * 8 + 0.2);
      text(ctx, n.title, VW / 2, VH * 0.3, { size: 50, color: n.color, alpha: a });
      if (n.sub) text(ctx, n.sub, VW / 2, VH * 0.3 + 44, { size: 20, font: 'Inter', weight: 800, color: '#e6e2ff', alpha: a });
    }
    if (car.wrongT > 1 && car.finishTime === null) {
      const blink = Math.floor(this.time * 4) % 2 ? 1 : 0.4;
      text(ctx, 'WRONG WAY', VW / 2, VH / 2 - 90, { size: 46, color: '#ff3b5c', alpha: blink });
      const p = this.pts[car.idx];
      ctx.save();
      ctx.translate(VW / 2, VH / 2 - 150);
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
      text(ctx, `${ordinal(car.place)} place!`, VW / 2, VH / 2 - 60, { size: 54, color: car.place === 1 ? '#ffd166' : '#fff' });
      text(ctx, formatTime(car.finishTime), VW / 2, VH / 2, { size: 24, font: 'Inter', weight: 800, color: '#c4bdf5' });
    }
    ctx.restore();
  }

  drawGauge(ctx, x, y, car) {
    const spd = Math.max(0, car.speed);
    ctx.fillStyle = 'rgba(9,7,32,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, 78, 0, TAU);
    ctx.fill();
    const a0 = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    ctx.lineCap = 'round';
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(x, y, 62, a0, a0 + sweep);
    ctx.stroke();
    const f = clamp(spd / BOOST_MAX, 0, 1);
    if (f > 0.005) {
      ctx.strokeStyle = car.boosting ? '#38d9ff' : f > (MAX / BOOST_MAX) * 0.93 ? '#ff8a2b' : '#1fd1a5';
      ctx.beginPath();
      ctx.arc(x, y, 62, a0, a0 + sweep * f);
      ctx.stroke();
    }
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(x, y, 48, a0, a0 + sweep);
    ctx.stroke();
    if (car.nitro > 0.005) {
      ctx.strokeStyle = car.nitro >= 0.999 ? '#ffd166' : car.nitroOn ? '#ffffff' : '#b26bff';
      ctx.beginPath();
      ctx.arc(x, y, 48, a0, a0 + sweep * car.nitro);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    text(ctx, String(Math.round(spd / 3)), x, y - 4, { size: 32 });
    text(ctx, 'KM/H', x, y + 22, { size: 11, font: 'Inter', weight: 800, color: '#c4bdf5' });
    text(ctx, 'NITRO', x, y + 56, { size: 10, font: 'Inter', weight: 800, color: '#b26bff' });
  }

  drawMinimap(ctx, box, focus = null) {
    panel(ctx, box.x - 8, box.y - 8, box.w + 16, box.h + 16);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.mini, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
    const s0 = this.pts[0];
    ctx.fillStyle = '#111';
    ctx.fillRect(box.x + (s0.x / WORLD_W) * box.w - 2, box.y + (s0.y / WORLD_H) * box.h - 6, 4, 12);
    const list = [...this.cars].reverse();
    if (focus) list.push(focus);
    for (const c of list) {
      const x = box.x + (c.x / WORLD_W) * box.w;
      const y = box.y + (c.y / WORLD_H) * box.h;
      ctx.fillStyle = c.color;
      ctx.strokeStyle = c === focus ? '#fff' : '#05040d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, c === focus ? 7 : 5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawStandings(ctx, order, x, y0) {
    order.forEach((c, k) => {
      const y = y0 + 30 + k * 28;
      panel(ctx, x, y - 12, 260, 24, 6);
      text(ctx, ordinal(k + 1), x + 10, y, { size: 13, align: 'left', color: '#c4bdf5' });
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(x + 54, y, 5, 0, TAU);
      ctx.fill();
      text(ctx, c.name, x + 66, y, { size: 13, font: 'Inter', weight: 800, align: 'left' });
      const g = k > 0 && c.finishTime === null && this.state === 'race' ? this.gap(c, order[0]) : null;
      if (g !== null) text(ctx, `+${g.toFixed(1)}`, x + 250, y, { size: 12, font: 'Inter', weight: 800, align: 'right', color: '#c4bdf5' });
    });
  }

  // Fourth quadrant in 3-player games: big map + timing tower.
  drawBoard(ctx, order) {
    ctx.fillStyle = '#0b0920';
    ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
    this.drawMinimap(ctx, { x: W / 2 + 50, y: H / 2 + 70, w: 380, h: 275 });
    text(ctx, 'TIMING', W / 2 + 470, H / 2 + 60, { size: 18, align: 'left', color: '#c4bdf5' });
    this.drawStandings(ctx, order, W / 2 + 470, H / 2 + 70);
  }

  drawLights(ctx, fade = 1) {
    const x0 = W / 2 - 270;
    const y0 = H / 2 - 75;
    ctx.save();
    ctx.globalAlpha = fade;
    panel(ctx, x0, y0, 540, 150, 24);
    ctx.fillStyle = '#1a1626';
    ctx.fillRect(x0 + 20, y0 + 70, 500, 10);
    for (let k = 0; k < 5; k++) {
      const on = k < this.lights;
      const x = W / 2 - 200 + k * 100;
      ctx.fillStyle = '#100d1c';
      ctx.beginPath();
      ctx.roundRect(x - 40, y0 + 18, 80, 114, 16);
      ctx.fill();
      for (const dy of [-26, 26]) {
        if (on) {
          // Pre-rendered glow sprite instead of shadowBlur
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(this.sprites.brake, x - 40, H / 2 + dy - 40, 80, 80);
          ctx.restore();
        }
        ctx.fillStyle = on ? '#ff3b5c' : '#2a2140';
        ctx.beginPath();
        ctx.arc(x, H / 2 + dy, 22, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
    if (this.state === 'countdown') {
      text(ctx, 'Hands off the stick — go when the lights go OUT', W / 2, y0 + 176, { size: 20, font: 'Inter', weight: 800, color: '#e6e2ff' });
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
  controls: { move: 'Point to steer (point back to reverse)', a: 'Nitro', b: 'Brake / drift' },
  howTo: [
    'Five red lights, then GO when they go out — move early and you get a stall penalty, react fast for a perfect launch.',
    'Push the stick the way you want to go. Tyres have limited grip: carry too much speed and the car slides wide.',
    'Hold B to brake; flick B while turning at speed to drift. Drifting refills nitro — hold A to burn it.',
    'Tuck in behind a rival for a slipstream boost. Curbs rumble, grass and gravel slow you, tyre walls bite back.',
    `Sector splits show you vs. your best lap. First across the line after ${LAPS} laps wins.`,
  ],
  create: (opts) => new RacingRivals(opts),
};
