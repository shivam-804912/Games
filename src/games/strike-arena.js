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
const WALL_H = 12; // visible height of a wall's front face

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

/* ----------------------------------------------------- Pre-rendered art */
const glowCache = new Map();
// Soft additive light blob, tinted per colour and cached.
function glow(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(color, 0.9));
    grad.addColorStop(0.35, rgba(color, 0.3));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}

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

function drawWall(g, w) {
  const border = w.x === 0 || w.y === TOP || w.x + w.w === W || w.y + w.h === H;
  // Front (south) face
  g.fillStyle = '#1c1e26';
  g.fillRect(w.x, w.y + w.h - WALL_H, w.w, WALL_H);
  g.fillStyle = 'rgba(139,147,255,0.45)';
  g.fillRect(w.x, w.y + w.h - WALL_H, w.w, 2);
  // Top face
  const th = w.h - WALL_H;
  const grad = g.createLinearGradient(w.x, w.y, w.x + w.w * 0.3, w.y + th);
  grad.addColorStop(0, border ? '#3d414d' : '#5b6070');
  grad.addColorStop(1, border ? '#2c2f38' : '#40444f');
  g.fillStyle = grad;
  g.fillRect(w.x, w.y, w.w, th);
  // Panel seams and bolts
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  const horizontal = w.w >= w.h;
  for (let k = 40; k < (horizontal ? w.w : th); k += 40) {
    g.beginPath();
    if (horizontal) {
      g.moveTo(w.x + k + 0.5, w.y);
      g.lineTo(w.x + k + 0.5, w.y + th);
    } else {
      g.moveTo(w.x, w.y + k + 0.5);
      g.lineTo(w.x + w.w, w.y + k + 0.5);
    }
    g.stroke();
  }
  if (!border) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const [bx, by] of [
      [w.x + 5, w.y + 5],
      [w.x + w.w - 7, w.y + 5],
      [w.x + 5, w.y + th - 7],
      [w.x + w.w - 7, w.y + th - 7],
    ])
      g.fillRect(bx, by, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, th - 1);
}

function buildFloor() {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#20232b';
  g.fillRect(0, 0, W, H);

  // Concrete slabs with slight tone variation
  const T = 80;
  for (let y = TOP; y < H; y += T) {
    for (let x = 0; x < W; x += T) {
      const v = Math.round(rand(-7, 7));
      g.fillStyle = `rgb(${42 + v},${45 + v},${54 + v})`;
      g.fillRect(x + 1, y + 1, T - 2, T - 2);
    }
  }
  // Grit speckles
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.55 ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rand(W), rand(TOP, H), rand(1, 2.5), rand(1, 2.5));
  }
  // Grime and oil stains
  for (let i = 0; i < 28; i++) {
    const x = rand(W);
    const y = rand(TOP, H);
    const r = rand(20, 80);
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, 'rgba(8,8,12,0.35)');
    s.addColorStop(1, 'rgba(8,8,12,0)');
    g.fillStyle = s;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Faded paint markings
  const cy = (H + TOP) / 2;
  g.strokeStyle = 'rgba(250,204,21,0.2)';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(W / 2, cy, 150, 0, TAU);
  g.stroke();
  g.lineWidth = 3;
  g.setLineDash([14, 14]);
  g.beginPath();
  g.arc(W / 2, cy, 190, 0, TAU);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.lineWidth = 3;
  for (const [x, y] of SPAWNS) {
    g.beginPath();
    g.arc(x, y, 30, 0, TAU);
    g.stroke();
    g.beginPath();
    g.moveTo(x - 10, y);
    g.lineTo(x + 10, y);
    g.moveTo(x, y - 10);
    g.lineTo(x, y + 10);
    g.stroke();
  }

  // Overhead lamps: warm pools of light
  g.globalCompositeOperation = 'lighter';
  for (const [x, y] of [
    [400, 290],
    [1200, 290],
    [400, 660],
    [1200, 660],
    [800, cy],
    [120, cy],
    [1480, cy],
  ]) {
    const l = g.createRadialGradient(x, y, 0, x, y, 300);
    l.addColorStop(0, 'rgba(255,214,160,0.11)');
    l.addColorStop(1, 'rgba(255,214,160,0)');
    g.fillStyle = l;
    g.fillRect(x - 300, y - 300, 600, 600);
  }
  g.globalCompositeOperation = 'source-over';

  // Wall drop shadows, then the walls themselves
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.7)';
  g.shadowBlur = 20;
  g.shadowOffsetX = 10;
  g.shadowOffsetY = 16;
  g.fillStyle = '#000';
  for (const w of WALLS) g.fillRect(w.x, w.y, w.w, w.h);
  g.restore();
  for (const w of WALLS) drawWall(g, w);

  // HUD strip
  const hud = g.createLinearGradient(0, 0, 0, TOP);
  hud.addColorStop(0, '#0d0a26');
  hud.addColorStop(1, '#151137');
  g.fillStyle = hud;
  g.fillRect(0, 0, W, TOP);
  return c;
}

// Darkens the arena edges on top of everything so the lamps read as light.
function buildShade() {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const cy = (H + TOP) / 2;
  const v = g.createRadialGradient(W / 2, cy, 260, W / 2, cy, 960);
  v.addColorStop(0, 'rgba(0,0,8,0)');
  v.addColorStop(1, 'rgba(0,0,8,0.55)');
  g.fillStyle = v;
  g.fillRect(0, TOP, W, H - TOP);
  return c;
}

// Top-down soldier facing +x: backpack, shoulders, arms reaching for the gun, helmet.
function buildSoldier(color, flash) {
  const S = 72;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  const dark = shade(color, -0.5);
  const light = shade(color, 0.4);

  g.fillStyle = '#2a2e37';
  rr(g, -18, -9, 10, 18, 3);
  g.fill();

  // Arms
  g.strokeStyle = shade(color, -0.25);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(0, 13);
  g.lineTo(9, 11);
  g.lineTo(14, 4);
  g.moveTo(0, -13);
  g.lineTo(13, -8);
  g.lineTo(23, -1);
  g.stroke();
  g.fillStyle = '#1b1d22';
  for (const [hx, hy] of [
    [14, 4],
    [23, -1],
  ]) {
    g.beginPath();
    g.arc(hx, hy, 3.6, 0, TAU);
    g.fill();
  }

  // Torso / vest
  const body = g.createRadialGradient(-4, -6, 2, 0, 0, 20);
  body.addColorStop(0, light);
  body.addColorStop(0.6, color);
  body.addColorStop(1, dark);
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(-1, 0, 11, 17, 0, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 2;
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-6, -11);
  g.lineTo(-6, 11);
  g.stroke();

  // Helmet
  const helm = g.createRadialGradient(-2, -3, 1, 1, 0, 11);
  helm.addColorStop(0, '#f4f4f6');
  helm.addColorStop(0.35, light);
  helm.addColorStop(1, dark);
  g.fillStyle = helm;
  g.beginPath();
  g.arc(1, 0, 9.5, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.5;
  g.stroke();

  if (flash) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(-S / 2, -S / 2, S, S);
  }
  return c;
}

function buildCrate(damaged) {
  const P = 12;
  const c = makeCanvas(CRATE + P * 2, CRATE + P * 2);
  const g = c.getContext('2d');
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.65)';
  g.shadowBlur = 10;
  g.shadowOffsetX = 6;
  g.shadowOffsetY = 8;
  g.fillStyle = '#000';
  g.fillRect(P, P, CRATE, CRATE);
  g.restore();
  g.translate(P, P);
  g.fillStyle = '#4a2f16';
  g.fillRect(0, 0, CRATE, CRATE);
  const top = CRATE - 8;
  const grad = g.createLinearGradient(0, 0, CRATE, top);
  grad.addColorStop(0, '#b98446');
  grad.addColorStop(1, '#8a5a2b');
  g.fillStyle = grad;
  g.fillRect(0, 0, CRATE, top);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  for (let y = 9; y < top; y += 9) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(CRATE, y + 0.5);
    g.stroke();
  }
  g.strokeStyle = '#5e3b1b';
  g.lineWidth = 4;
  g.strokeRect(2, 2, CRATE - 4, top - 4);
  g.beginPath();
  g.moveTo(4, 4);
  g.lineTo(CRATE - 4, top - 4);
  g.moveTo(CRATE - 4, 4);
  g.lineTo(4, top - 4);
  g.stroke();
  if (damaged) {
    g.strokeStyle = 'rgba(20,10,4,0.85)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(8, 3);
    g.lineTo(15, 14);
    g.lineTo(12, 22);
    g.lineTo(20, 33);
    g.moveTo(CRATE - 6, 10);
    g.lineTo(CRATE - 16, 18);
    g.lineTo(CRATE - 12, 28);
    g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, CRATE, top);
  }
  return c;
}

function buildBarrel() {
  const P = 12;
  const S = (BARREL_R + P) * 2;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.65)';
  g.shadowBlur = 10;
  g.shadowOffsetX = 6;
  g.shadowOffsetY = 8;
  g.fillStyle = '#000';
  g.beginPath();
  g.arc(0, 0, BARREL_R, 0, TAU);
  g.fill();
  g.restore();
  const grad = g.createRadialGradient(-5, -6, 2, 0, 0, BARREL_R);
  grad.addColorStop(0, '#ff7a6b');
  grad.addColorStop(0.55, '#d6372b');
  grad.addColorStop(1, '#7f1515');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, BARREL_R, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 2;
  for (const r of [BARREL_R - 1, BARREL_R - 6]) {
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.stroke();
  }
  // Hazard mark
  g.fillStyle = '#facc15';
  g.beginPath();
  g.moveTo(0, -7);
  g.lineTo(6.5, 5);
  g.lineTo(-6.5, 5);
  g.closePath();
  g.fill();
  g.fillStyle = '#1b1b1b';
  g.fillRect(-1, -3, 2, 5);
  g.fillRect(-1, 3, 2, 1.5);
  // Bung cap
  g.fillStyle = '#5c1010';
  g.beginPath();
  g.arc(9, -8, 2.5, 0, TAU);
  g.fill();
  return c;
}

// Gun drawn along +x in the player's rotated frame.
function drawGun(g, w, kick) {
  const x = 10 - kick;
  const hw = w.width / 2;
  if (w.id === 'shotgun') {
    g.fillStyle = '#6b3f1d';
    g.fillRect(x - 6, -hw + 1, 10, w.width - 2);
  }
  g.fillStyle = '#16181e';
  g.fillRect(x, -hw, w.len, w.width);
  g.fillStyle = '#454b58';
  g.fillRect(x + 3, -1, w.len - 7, 2);
  if (w.id === 'rifle') {
    g.fillStyle = '#0d0e12';
    g.fillRect(x + 8, hw - 1, 5, 6);
  } else if (w.id === 'smg') {
    g.fillStyle = '#0d0e12';
    g.fillRect(x + 6, hw - 1, 4, 9);
  } else if (w.id === 'shotgun') {
    g.fillStyle = '#8a5428';
    g.fillRect(x + 13, -hw - 1, 9, w.width + 2);
  } else if (w.id === 'sniper') {
    g.fillStyle = '#2c313b';
    g.fillRect(x + 8, -3, 15, 6);
    g.fillStyle = '#7dd3fc';
    g.fillRect(x + 22, -1.5, 2, 3);
  }
  g.fillStyle = '#0b0c10';
  g.fillRect(x + w.len - 1, -hw * 0.6, 4, w.width * 0.6);
}

/* -------------------------------------------------------------- Game */
class StrikeArena {
  constructor({ players, host }) {
    this.host = host;
    this.floor = buildFloor();
    this.shadeLayer = buildShade();
    this.decals = makeCanvas(W, H);
    this.dctx = this.decals.getContext('2d');
    this.crateArt = [buildCrate(false), buildCrate(true)];
    this.barrelArt = buildBarrel();
    this.shadowArt = blob('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)');
    this.smokeArt = blob('rgba(120,122,132,0.55)', 'rgba(120,122,132,0)');
    this.particles = new Particles();
    this.players = players.map((p, i) => ({
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
      sprite: buildSoldier(p.color, false),
      flashSprite: buildSoldier(p.color, true),
    }));
    this.round = 0;
    this.result = null;
    this.shake = 0;
    this.flashT = 0;
    this.time = 0;
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
    this.pickupTimer = 4;
    this.dctx.clearRect(0, 0, W, H);
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
      this.smoke.push({ x: x + rand(-10, 10), y: y + rand(-10, 10), vx: vx + rand(-25, 25), vy: vy + rand(-25, 25), r: rand(14, 26), life: rand(0.8, 1.4), max: 1.4 });
    }
    if (this.smoke.length > 120) this.smoke.splice(0, this.smoke.length - 120);
  }

  popText(x, y, txt, color, size) {
    this.numbers.push({ p: null, x, y, vy: -50, life: 1.1, value: 0, txt, color, size });
  }

  stampHole(x, y) {
    const g = this.dctx;
    g.fillStyle = 'rgba(8,8,10,0.75)';
    g.beginPath();
    g.arc(x, y, rand(1.6, 2.6), 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(x - 3, y - 3, 1.5, 1.5);
  }

  stampScorch(x, y, r, tint) {
    const g = this.dctx;
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, 'rgba(5,5,6,0.75)');
    s.addColorStop(0.6, 'rgba(10,10,12,0.4)');
    s.addColorStop(1, 'rgba(10,10,12,0)');
    g.fillStyle = s;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    g.strokeStyle = tint ? rgba(tint, 0.35) : 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const a = rand(TAU);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
      g.lineTo(x + Math.cos(a) * r * rand(0.8, 1.2), y + Math.sin(a) * r * rand(0.8, 1.2));
      g.stroke();
    }
  }

  stampDebris(x, y) {
    const g = this.dctx;
    for (let i = 0; i < 9; i++) {
      g.save();
      g.translate(x + rand(-26, 26), y + rand(-26, 26));
      g.rotate(rand(TAU));
      g.fillStyle = pick(['#8a5a2b', '#6b4423', '#b98446']);
      g.fillRect(-rand(4, 10), -2, rand(8, 20), rand(3, 5));
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
      g.globalAlpha = 0.8;
      g.fillStyle = c.color;
      g.fillRect(-c.len / 2, -1.2, c.len, 2.4);
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
  render(ctx) {
    ctx.save();
    if (this.shake > 0) ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
    ctx.drawImage(this.floor, 0, 0);
    ctx.drawImage(this.decals, 0, 0);

    // Sniper smoke trails
    ctx.lineCap = 'round';
    for (const t of this.trails) {
      ctx.strokeStyle = `rgba(200,220,255,${0.25 * (t.life / 0.5)})`;
      ctx.lineWidth = 3 + (0.5 - t.life) * 10;
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }

    for (const k of this.pickups) this.drawPickup(ctx, k);

    // Props
    const P = 12;
    for (const c of this.crates) {
      ctx.drawImage(this.crateArt[c.hp < CRATE_HP / 2 ? 1 : 0], c.x - P + (c.hit > 0 ? rand(-1.5, 1.5) : 0), c.y - P);
    }
    for (const k of this.barrels) {
      const s = this.barrelArt.width;
      const j = k.hit > 0 || k.armed ? rand(-2, 2) : 0;
      ctx.drawImage(this.barrelArt, k.x - s / 2 + j, k.y - s / 2);
      if (k.armed) {
        ctx.fillStyle = 'rgba(255,240,200,0.6)';
        ctx.beginPath();
        ctx.arc(k.x, k.y, BARREL_R, 0, TAU);
        ctx.fill();
      }
    }

    this.drawCasings(ctx);

    // Dash afterimages
    for (const g of this.ghosts) {
      ctx.save();
      ctx.globalAlpha = (g.life / 0.28) * 0.4;
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.drawImage(g.sprite, -36, -36);
      ctx.restore();
    }

    for (const p of this.players) if (p.alive) this.drawPlayer(ctx, p);

    // Smoke
    for (const s of this.smoke) {
      ctx.globalAlpha = Math.min(1, s.life / s.max) * 0.8;
      ctx.drawImage(this.smokeArt, s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    }
    ctx.globalAlpha = 1;

    // Bullets, muzzle flashes and dynamic light — all additive.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of this.bullets) {
      const sp = Math.hypot(b.vx, b.vy);
      const tail = Math.min(b.travel, b.weapon === 'sniper' ? 90 : 24);
      const tx = b.x - (b.vx / sp) * tail;
      const ty = b.y - (b.vy / sp) * tail;
      ctx.strokeStyle = b.owner.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.strokeStyle = WEAPONS[b.weapon].color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.drawImage(glow(b.owner.color), b.x - 14, b.y - 14, 28, 28);
    }
    for (const p of this.players) if (p.alive && p.muzzle > 0) this.drawMuzzle(ctx, p);
    for (const l of this.lights) {
      ctx.globalAlpha = l.life / l.max;
      ctx.drawImage(glow(l.color), l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    ctx.restore();

    this.particles.render(ctx);
    ctx.drawImage(this.shadeLayer, 0, 0);

    for (const p of this.players) if (p.alive) this.drawTags(ctx, p);
    for (const n of this.numbers) {
      text(ctx, n.txt, n.x, n.y, { size: n.size, color: n.color, alpha: clamp(n.life * 2.5, 0, 1) });
    }
    ctx.restore();

    if (this.flashT > 0) {
      ctx.fillStyle = `rgba(255,236,200,${this.flashT * 2})`;
      ctx.fillRect(0, TOP, W, H - TOP);
    }

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

  drawPickup(ctx, k) {
    const info = PICKUPS[k.type];
    const bob = Math.sin(k.t * 4) * 3;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + Math.sin(k.t * 5) * 0.15;
    ctx.drawImage(glow(info.color), k.x - 34, k.y - 34, 68, 68);
    ctx.restore();

    ctx.drawImage(this.shadowArt, k.x - 16 + 4, k.y - 12 + 6, 32, 24);
    ctx.save();
    ctx.translate(k.x, k.y + bob * 0.3 - 2);
    ctx.fillStyle = 'rgba(10,10,18,0.85)';
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.fill();
    ctx.stroke();
    if (info.weapon) {
      const w = WEAPONS[k.type];
      ctx.rotate(-0.5);
      ctx.translate(-(10 + w.len / 2), 0);
      drawGun(ctx, w, 0);
    }
    ctx.restore();
    if (info.weapon) text(ctx, WEAPONS[k.type].label, k.x, k.y + 30, { size: 11, color: info.color, font: 'Inter', weight: 800 });
    else text(ctx, info.label, k.x, k.y - 1, { size: 18, color: info.color, font: 'Inter', weight: 800 });
  }

  drawPlayer(ctx, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.drawImage(this.shadowArt, -R - 8 + 6, -R - 8 + 8, (R + 8) * 2, (R + 8) * 2);

    ctx.save();
    ctx.rotate(p.angle);
    const w = WEAPONS[p.weapon];
    if (p.reloadT > 0) {
      // Gun dips while reloading.
      ctx.save();
      ctx.rotate(0.5);
      drawGun(ctx, w, 3);
      ctx.restore();
    } else drawGun(ctx, w, p.kick);
    ctx.drawImage(p.flash > 0 ? p.flashSprite : p.sprite, -36, -36);
    ctx.restore();

    if (p.shield > 0) {
      ctx.strokeStyle = '#22d3ee';
      ctx.globalAlpha = 0.45 + Math.sin(this.time * 10) * 0.2;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, R + 9, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (p.reloadT > 0) {
      const t = 1 - p.reloadT / w.reload;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, R + 13, -Math.PI / 2, -Math.PI / 2 + t * TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawMuzzle(ctx, p) {
    const w = WEAPONS[p.weapon];
    const big = w.id === 'shotgun' || w.id === 'sniper';
    const mx = 12 + w.len;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    const s = big ? 70 : 46;
    ctx.drawImage(glow('#ffb347'), mx - s / 2, -s / 2, s, s);
    ctx.fillStyle = '#fff3c4';
    const len = (big ? 30 : 18) * rand(0.8, 1.2);
    ctx.beginPath();
    ctx.moveTo(mx, -4);
    ctx.lineTo(mx + len, 0);
    ctx.lineTo(mx, 4);
    ctx.lineTo(mx + len * 0.35, 0);
    ctx.closePath();
    ctx.moveTo(mx + 2, 0);
    ctx.lineTo(mx + len * 0.4, -len * 0.35);
    ctx.lineTo(mx + 6, 0);
    ctx.lineTo(mx + len * 0.4, len * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawTags(ctx, p) {
    const bw = 46;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(p.x - bw / 2, p.y - R - 18, bw, 6);
    ctx.fillStyle = p.hp > 50 ? '#22d36b' : p.hp > 25 ? '#facc15' : '#ff3b5c';
    ctx.fillRect(p.x - bw / 2, p.y - R - 18, (bw * clamp(p.hp, 0, 100)) / 100, 6);
    if (p.shield > 0) {
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(p.x - bw / 2, p.y - R - 23, (bw * p.shield) / 50, 3);
    }
    text(ctx, p.name, p.x, p.y - R - 32, { size: 13, font: 'Inter', weight: 700, color: '#fff' });

    // Ammo readout under special weapons, or when running low.
    const w = WEAPONS[p.weapon];
    let ammo = null;
    if (p.reloadT > 0) ammo = 'RELOADING';
    else if (p.weapon !== 'rifle') ammo = `${w.label} ${p.mag}/${p.reserve}`;
    else if (p.mag <= 4) ammo = `${p.mag}/${w.mag}`;
    if (ammo) text(ctx, ammo, p.x, p.y + R + 16, { size: 11, font: 'Inter', weight: 800, color: p.mag <= 2 && p.reloadT <= 0 ? '#ff8a8a' : '#d6d2f3' });
  }

  drawHud(ctx) {
    text(ctx, `ROUND ${this.round}`, W / 2, TOP / 2, { size: 26, color: '#fff', glow: 12 });
    const n = this.players.length;
    const slot = Math.min(170, (W / 2 - 160) / Math.ceil(n / 2));
    this.players.forEach((p, i) => {
      const left = i % 2 === 0;
      const k = Math.floor(i / 2);
      const x = left ? 30 + k * slot : W - 30 - (k + 1) * slot;
      ctx.globalAlpha = p.alive || this.state !== 'fight' ? 1 : 0.4;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x + 8, TOP / 2 - 9, 7, 0, TAU);
      ctx.fill();
      text(ctx, p.name, x + 22, TOP / 2 - 9, { size: 14, font: 'Inter', weight: 700, align: 'left' });
      for (let w = 0; w < WINS_NEEDED; w++) {
        ctx.beginPath();
        ctx.arc(x + 8 + w * 18, TOP / 2 + 14, 6, 0, TAU);
        ctx.fillStyle = w < p.wins ? p.color : 'rgba(255,255,255,0.12)';
        ctx.fill();
      }
      if (p.alive && p.weapon !== 'rifle') {
        text(ctx, WEAPONS[p.weapon].label, x + 8 + WINS_NEEDED * 18, TOP / 2 + 14, { size: 10, font: 'Inter', weight: 800, align: 'left', color: PICKUPS[p.weapon].color });
      }
      ctx.globalAlpha = 1;
    });
  }

  drawFeed(ctx) {
    if (!this.feed.length) return;
    ctx.save();
    ctx.font = '700 15px "Inter", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let y = TOP + 44;
    for (const f of this.feed) {
      const parts = f.killer && f.killer !== f.victim ? [[f.killer.name, f.killer.color], [`  ${f.label}  `, '#9aa3b8'], [f.victim.name, f.victim.color]] : [[`${f.label}  `, '#9aa3b8'], [f.victim.name, f.victim.color]];
      const widths = parts.map(([s]) => ctx.measureText(s).width);
      const total = widths.reduce((s, v) => s + v, 0);
      let x = W - 44 - total;
      const a = clamp(f.t, 0, 1);
      ctx.globalAlpha = a * 0.65;
      ctx.fillStyle = '#05040d';
      rr(ctx, x - 12, y - 14, total + 24, 28, 8);
      ctx.fill();
      ctx.globalAlpha = a;
      parts.forEach(([s, c], k) => {
        ctx.fillStyle = c;
        ctx.fillText(s, x, y);
        x += widths[k];
      });
      y += 34;
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
  create: (opts) => new StrikeArena(opts),
};
