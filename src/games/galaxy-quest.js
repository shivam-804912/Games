import {
  H,
  IDLE,
  Particles,
  TAU,
  W,
  angleDiff,
  banner,
  clamp,
  dist,
  makeCanvas,
  rand,
  text,
  turnToward,
} from './engine/util.js';

/*
 * Galaxy Quest — co-op space shooter. Point your ship where you want to fly,
 * blast asteroids and alien craft, grab crystals and weapon pods, and survive
 * the waves together. Every fifth wave is a mothership with destructible
 * turrets, three phases and a gravity well.
 */

const SHIP_R = 16;
const MAX_SPEED = 560;
const THRUST = 720;
const SIZES = { 3: { r: 56, hp: 4, score: 20 }, 2: { r: 34, hp: 2, score: 50 }, 1: { r: 18, hp: 1, score: 100 } };
const ROCK_FRAMES = 16; // pre-rendered rotation steps per rock (lighting stays fixed)
const ROCK_VARIANTS = 4;
const LIGHT = { x: -0.6, y: -0.8 }; // the sun sits up and to the left
const WEAPON_TIME = 15;
const REVIVE_TIME = 1.4; // seconds of one teammate hovering nearby
const REVIVE_R = 90;
const DOWN_TIME = 8;
const BANK_LIFE = 15; // team crystals per extra life
const TURRET_R = 18;

const ENEMY = {
  drone: { r: 20, hp: 3, score: 150, color: '#ff3b5c' },
  kamikaze: { r: 16, hp: 2, score: 200, color: '#ff9f1c' },
  sniper: { r: 22, hp: 4, score: 250, color: '#a3e635' },
  shield: { r: 24, hp: 7, score: 300, color: '#38bdf8' },
};

const WEAPONS = {
  spread: { color: '#facc15', label: 'S', name: 'SPREAD' },
  homing: { color: '#fb923c', label: 'M', name: 'MISSILES' },
  laser: { color: '#f472b6', label: 'L', name: 'LASER' },
};

const TURRETS = [
  [-100, 10],
  [-50, 32],
  [50, 32],
  [100, 10],
];

const wrap = (e, m = 0) => {
  if (e.x < -m) e.x += W + m * 2;
  else if (e.x > W + m) e.x -= W + m * 2;
  if (e.y < -m) e.y += H + m * 2;
  else if (e.y > H + m) e.y -= H + m * 2;
};

// Drop dead entries (life <= 0) in place.
const sweep = (arr) => {
  let j = 0;
  for (const o of arr) if (o.life > 0) arr[j++] = o;
  arr.length = j;
};

/* ------------------------------------------------------------ Colour helpers */
function hexRgb(hex) {
  if (typeof hex !== 'string' || hex[0] !== '#') return [255, 255, 255];
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;

// amt > 0 mixes toward white, amt < 0 toward black.
function shade(hex, amt) {
  const t = amt > 0 ? 255 : 0;
  const k = Math.abs(amt);
  const [r, g, b] = hexRgb(hex).map((c) => Math.round(c + (t - c) * k));
  return `rgb(${r},${g},${b})`;
}

// Soft additive glow sprite, cached per colour. Draw with 'lighter'.
const glowCache = new Map();
function glowSprite(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, rgba(color, 0.9));
    gr.addColorStop(0.5, rgba(color, 0.25));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}

function drawGlow(ctx, color, x, y, r, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
}

/* ------------------------------------------------------------ Pre-rendered art */
function buildNebula() {
  const M = 60;
  const c = makeCanvas(W + M * 2, H + M * 2);
  const g = c.getContext('2d');
  const bg = g.createRadialGradient(W * 0.4, H * 0.45, 50, W * 0.5, H * 0.5, 1050);
  bg.addColorStop(0, '#1d1048');
  bg.addColorStop(0.6, '#0b0826');
  bg.addColorStop(1, '#04030d');
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.save();
  g.filter = 'blur(60px)';
  for (const [x, y, r, col, a] of [
    [380, 320, 260, '#6d28d9', 0.45],
    [1100, 620, 300, '#be185d', 0.4],
    [1350, 220, 200, '#1d4ed8', 0.4],
    [700, 760, 180, '#0e7490', 0.4],
    [200, 800, 220, '#4c1d95', 0.35],
    [900, 260, 160, '#9d174d', 0.25],
  ]) {
    g.globalAlpha = a;
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(x + M, y + M, r * 1.3, r * 0.8, rand(TAU), 0, TAU);
    g.fill();
  }
  // Dark dust lanes crossing the glow
  g.filter = 'blur(40px)';
  g.globalAlpha = 0.55;
  g.fillStyle = '#05030f';
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    g.ellipse(rand(W) + M, rand(H) + M, rand(160, 320), rand(30, 60), rand(TAU), 0, TAU);
    g.fill();
  }
  g.restore();
  // Far stars, too distant to parallax much
  for (let k = 0; k < 520; k++) {
    g.fillStyle = `rgba(${200 + rand(55)},${200 + rand(55)},255,${0.1 + Math.random() * 0.45})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  return c;
}

function buildStars(count, rMin, rMax, aMin, aMax, glare) {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const tints = ['#ffffff', '#cfe0ff', '#fff1d6', '#ffd6e7'];
  for (let k = 0; k < count; k++) {
    const x = rand(W);
    const y = rand(H);
    const r = rand(rMin, rMax);
    g.globalAlpha = rand(aMin, aMax);
    g.fillStyle = tints[k % tints.length];
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    if (glare && r > rMax * 0.75) {
      g.globalAlpha *= 0.5;
      g.fillRect(x - r * 5, y - 0.5, r * 10, 1);
      g.fillRect(x - 0.5, y - r * 5, 1, r * 10);
    }
  }
  return c;
}

function buildPlanet() {
  const c = makeCanvas(440, 320);
  const g = c.getContext('2d');
  const cx = 220;
  const cy = 160;
  const R = 96;
  const ring = (from, to) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.28);
    for (const [rx, ry, w, a] of [
      [190, 40, 10, 0.35],
      [172, 36, 6, 0.5],
      [156, 33, 4, 0.3],
    ]) {
      g.strokeStyle = `rgba(255,214,170,${a})`;
      g.lineWidth = w;
      g.beginPath();
      g.ellipse(0, 0, rx, ry, 0, from, to);
      g.stroke();
    }
    g.restore();
  };
  ring(Math.PI, TAU);
  // Atmosphere halo
  const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.25);
  halo.addColorStop(0, 'rgba(255,170,110,0.4)');
  halo.addColorStop(1, 'rgba(255,170,110,0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(cx, cy, R * 1.25, 0, TAU);
  g.fill();
  // Body
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.clip();
  const body = g.createRadialGradient(cx + LIGHT.x * 40, cy + LIGHT.y * 40, 8, cx, cy, R * 1.05);
  body.addColorStop(0, '#ffd8a8');
  body.addColorStop(0.35, '#e0793a');
  body.addColorStop(0.75, '#8a2f12');
  body.addColorStop(1, '#2a0c05');
  g.fillStyle = body;
  g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.translate(cx, cy);
  g.rotate(-0.28);
  for (let k = 0; k < 9; k++) {
    g.fillStyle = k % 2 ? 'rgba(255,230,200,0.10)' : 'rgba(90,25,5,0.18)';
    g.fillRect(-R, -R + k * 22 + rand(-4, 4), R * 2, rand(6, 16));
  }
  g.rotate(0.28);
  const term = g.createLinearGradient(LIGHT.x * R, LIGHT.y * R, -LIGHT.x * R, -LIGHT.y * R);
  term.addColorStop(0, 'rgba(0,0,0,0)');
  term.addColorStop(0.5, 'rgba(0,0,0,0.15)');
  term.addColorStop(1, 'rgba(5,2,10,0.88)');
  g.fillStyle = term;
  g.fillRect(-R, -R, R * 2, R * 2);
  g.restore();
  ring(0, Math.PI);
  return c;
}

// One rock shape rendered at ROCK_FRAMES rotations with a fixed sun direction.
function buildRock(r) {
  const n = 12 + Math.floor(r / 12);
  const verts = Array.from({ length: n }, (_, k) => [(k / n) * TAU + rand(-0.12, 0.12), rand(0.78, 1.05)]);
  const craters = Array.from({ length: 2 + Math.floor(r / 12) }, () => [rand(TAU), rand(0, 0.62), rand(0.1, 0.22)]);
  const specks = Array.from({ length: Math.floor(r * 0.8) }, () => [rand(TAU), rand(0, 0.85), Math.random() < 0.5]);
  const hue = rand(-12, 12);
  const S = Math.ceil(r * 2.3);
  const away = Math.atan2(-LIGHT.y, -LIGHT.x);
  const frames = [];
  for (let f = 0; f < ROCK_FRAMES; f++) {
    const th = (f / ROCK_FRAMES) * TAU;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.translate(S / 2, S / 2);
    const outline = () => {
      g.beginPath();
      verts.forEach(([a, k], i) => {
        const x = Math.cos(a + th) * r * k;
        const y = Math.sin(a + th) * r * k;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
    };
    outline();
    const base = g.createRadialGradient(LIGHT.x * r * 0.45, LIGHT.y * r * 0.45, r * 0.05, 0, 0, r * 1.1);
    base.addColorStop(0, `hsl(${255 + hue},22%,62%)`);
    base.addColorStop(0.45, `hsl(${255 + hue},25%,34%)`);
    base.addColorStop(1, `hsl(${255 + hue},35%,10%)`);
    g.fillStyle = base;
    g.fill();
    g.save();
    g.clip();
    for (const [a, d, light] of specks) {
      g.fillStyle = light ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.18)';
      g.fillRect(Math.cos(a + th) * d * r, Math.sin(a + th) * d * r, 2, 2);
    }
    for (const [a, d, s] of craters) {
      const x = Math.cos(a + th) * d * r;
      const y = Math.sin(a + th) * d * r;
      const cr = s * r;
      g.fillStyle = 'rgba(14,8,30,0.45)';
      g.beginPath();
      g.arc(x, y, cr, 0, TAU);
      g.fill();
      // Inner wall facing the sun is shadowed, the far rim catches light
      g.lineWidth = Math.max(1, cr * 0.28);
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.beginPath();
      g.arc(x, y, cr * 0.8, away + Math.PI - 1.1, away + Math.PI + 1.1);
      g.stroke();
      g.strokeStyle = 'rgba(225,215,255,0.28)';
      g.beginPath();
      g.arc(x, y, cr, away - 1.1, away + 1.1);
      g.stroke();
    }
    const term = g.createLinearGradient(LIGHT.x * r, LIGHT.y * r, -LIGHT.x * r, -LIGHT.y * r);
    term.addColorStop(0, 'rgba(0,0,0,0)');
    term.addColorStop(0.55, 'rgba(0,0,0,0.12)');
    term.addColorStop(1, 'rgba(4,2,12,0.75)');
    g.fillStyle = term;
    g.fillRect(-S / 2, -S / 2, S, S);
    g.restore();
    // Rim light on the sunny edge
    outline();
    const rim = g.createLinearGradient(LIGHT.x * r, LIGHT.y * r, 0, 0);
    rim.addColorStop(0, 'rgba(235,225,255,0.7)');
    rim.addColorStop(1, 'rgba(235,225,255,0)');
    g.strokeStyle = rim;
    g.lineWidth = 1.6;
    g.stroke();
    frames.push(c);
  }
  return { frames, S };
}

let rockCache = null;
function rockSprites() {
  if (!rockCache) {
    rockCache = {};
    for (const size of [1, 2, 3]) rockCache[size] = Array.from({ length: ROCK_VARIANTS }, () => buildRock(SIZES[size].r));
  }
  return rockCache;
}

// Player ship, nose pointing +x, lit from the top of the sprite.
function buildShip(color) {
  const S = 72;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  // Wings
  g.beginPath();
  g.moveTo(22, 0);
  g.lineTo(2, -7);
  g.lineTo(-10, -21);
  g.lineTo(-17, -19);
  g.lineTo(-12, -6);
  g.lineTo(-12, 6);
  g.lineTo(-17, 19);
  g.lineTo(-10, 21);
  g.lineTo(2, 7);
  g.closePath();
  const wing = g.createLinearGradient(0, -21, 0, 21);
  wing.addColorStop(0, shade(color, 0.45));
  wing.addColorStop(0.45, color);
  wing.addColorStop(1, shade(color, -0.65));
  g.fillStyle = wing;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 1.2;
  g.stroke();
  // Wing stripes
  g.strokeStyle = shade(color, -0.4);
  g.lineWidth = 2;
  for (const sy of [-1, 1]) {
    g.beginPath();
    g.moveTo(-2, sy * 9);
    g.lineTo(-11, sy * 18);
    g.stroke();
  }
  // Fuselage
  g.beginPath();
  g.moveTo(27, 0);
  g.quadraticCurveTo(10, -8, -15, -5.5);
  g.lineTo(-15, 5.5);
  g.quadraticCurveTo(10, 8, 27, 0);
  const body = g.createLinearGradient(0, -8, 0, 8);
  body.addColorStop(0, '#f4f6ff');
  body.addColorStop(0.5, '#8d93b8');
  body.addColorStop(1, '#262942');
  g.fillStyle = body;
  g.fill();
  // Nozzles
  g.fillStyle = '#1a1b2c';
  g.fillRect(-18, -5, 5, 4);
  g.fillRect(-18, 1, 5, 4);
  // Cockpit glass with a specular glint
  const glass = g.createLinearGradient(0, -4, 0, 4);
  glass.addColorStop(0, '#d9fbff');
  glass.addColorStop(1, '#0f3f6e');
  g.fillStyle = glass;
  g.beginPath();
  g.ellipse(9, 0, 7, 3.6, 0, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.ellipse(11, -1.4, 2.6, 0.9, 0, 0, TAU);
  g.fill();
  return c;
}

let enemyCache = null;
function enemySprites() {
  if (enemyCache) return enemyCache;
  const make = (rim, path, extra) => {
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    g.translate(32, 32);
    path(g);
    const gr = g.createLinearGradient(-16, -20, 16, 20);
    gr.addColorStop(0, '#6a6394');
    gr.addColorStop(0.5, '#251c42');
    gr.addColorStop(1, '#0a0716');
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = rim;
    g.lineWidth = 2.5;
    g.lineJoin = 'round';
    g.stroke();
    extra?.(g);
    return c;
  };
  enemyCache = {
    drone: make('#ff3b5c', (g) => {
      g.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        g.lineTo(Math.cos(a) * 21, Math.sin(a) * 21);
        g.lineTo(Math.cos(a + TAU / 8) * 10, Math.sin(a + TAU / 8) * 10);
      }
      g.closePath();
    }),
    kamikaze: make(
      '#ff9f1c',
      (g) => {
        g.beginPath();
        g.moveTo(21, 0);
        g.lineTo(-12, -14);
        g.lineTo(-6, 0);
        g.lineTo(-12, 14);
        g.closePath();
      },
      (g) => {
        g.fillStyle = '#ffd166';
        g.beginPath();
        g.moveTo(14, 0);
        g.lineTo(2, -4);
        g.lineTo(2, 4);
        g.fill();
      },
    ),
    sniper: make(
      '#a3e635',
      (g) => {
        g.beginPath();
        g.moveTo(16, 0);
        g.lineTo(2, -9);
        g.lineTo(-15, -15);
        g.lineTo(-10, 0);
        g.lineTo(-15, 15);
        g.lineTo(2, 9);
        g.closePath();
      },
      (g) => {
        g.fillStyle = '#3f4a2a';
        g.fillRect(10, -2.5, 20, 5);
        g.fillStyle = '#a3e635';
        g.fillRect(26, -2.5, 4, 5);
      },
    ),
    shield: make('#38bdf8', (g) => {
      g.beginPath();
      for (let k = 0; k < 6; k++) g.lineTo(Math.cos((k / 6) * TAU) * 22, Math.sin((k / 6) * TAU) * 22);
      g.closePath();
    }),
  };
  return enemyCache;
}

function buildBoss() {
  const c = makeCanvas(300, 150);
  const g = c.getContext('2d');
  g.translate(150, 75);
  const hull = g.createLinearGradient(0, -46, 0, 46);
  hull.addColorStop(0, '#c4b5fd');
  hull.addColorStop(0.3, '#6d28d9');
  hull.addColorStop(0.7, '#2e1065');
  hull.addColorStop(1, '#0c0420');
  g.fillStyle = hull;
  g.beginPath();
  g.ellipse(0, 0, 128, 46, 0, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(216,180,254,0.6)';
  g.lineWidth = 2;
  g.stroke();
  // Panel seams
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 1.5;
  for (const [rx, ry] of [
    [100, 34],
    [70, 24],
  ]) {
    g.beginPath();
    g.ellipse(0, 4, rx, ry, 0, 0, TAU);
    g.stroke();
  }
  for (let k = -3; k <= 3; k++) {
    g.beginPath();
    g.moveTo(k * 22, 30);
    g.lineTo(k * 34, 44);
    g.stroke();
  }
  // Specular sheen
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.ellipse(-34, -26, 58, 7, -0.08, 0, TAU);
  g.fill();
  // Command dome
  const dome = g.createLinearGradient(0, -58, 0, -20);
  dome.addColorStop(0, 'rgba(207,250,254,0.95)');
  dome.addColorStop(1, 'rgba(8,145,178,0.55)');
  g.fillStyle = dome;
  g.beginPath();
  g.ellipse(0, -24, 48, 32, 0, Math.PI, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.beginPath();
  g.ellipse(-16, -42, 14, 4, -0.3, 0, TAU);
  g.fill();
  return c;
}

/* ------------------------------------------------------------ Game */
class GalaxyQuest {
  constructor({ players, host }) {
    this.host = host;
    this.nebula = buildNebula();
    this.planet = buildPlanet();
    this.starsMid = buildStars(260, 0.6, 1.4, 0.3, 0.7, false);
    this.starsNear = buildStars(70, 1, 2.2, 0.5, 0.95, true);
    this.bossArt = buildBoss();
    rockSprites();
    enemySprites();
    this.twinkles = Array.from({ length: 50 }, () => ({ x: rand(W), y: rand(H), p: rand(TAU), r: rand(0.8, 1.8) }));
    this.cam = { x: 0, y: 0 };
    this.particles = new Particles();
    this.rings = [];
    this.flashes = [];
    this.debris = [];
    this.popups = [];
    this.time = 0;
    this.shake = 0;
    this.result = null;
    const n = players.length;
    this.ships = players.map((p, i) => ({
      ...p,
      i,
      sprite: buildShip(p.color),
      x: W / 2 + (i - (n - 1) / 2) * 90,
      y: H / 2 + 140,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      alive: true,
      down: false,
      out: false,
      downT: 0,
      revive: 0,
      wreck: null,
      helpers: [],
      inv: 2.5,
      cooldown: 0,
      missileCd: 0,
      shieldT: 0,
      shieldCd: 0,
      thrust: 0,
      flame: 0,
      muzzle: 0,
      weapon: null,
      weaponT: 0,
      beam: null,
      chain: 0,
      chainT: 0,
      mult: 1,
      score: 0,
      kills: 0,
      crystals: 0,
    }));
    this.lives = 3 + n;
    this.bank = 0; // team crystals toward the next extra life
    this.wave = 0;
    this.asteroids = [];
    this.enemies = [];
    this.bullets = [];
    this.missiles = [];
    this.orbs = [];
    this.crystals = [];
    this.pods = [];
    this.boss = null;
    this.well = null;
    this.phaseBanner = null;
    this.nextWave();
  }

  get teamScore() {
    return this.ships.reduce((s, p) => s + p.score, 0);
  }

  waveRoster(w, n) {
    const list = [];
    const add = (type, count) => {
      for (let k = 0; k < count; k++) list.push(type);
    };
    if (w >= 2) add('drone', Math.min(Math.floor(w / 2) + n - 1, 6));
    if (w >= 3) add('kamikaze', Math.min(1 + Math.floor((w - 3) / 2) + (n > 2 ? 1 : 0), 5));
    if (w >= 4) add('sniper', Math.min(1 + Math.floor((w - 4) / 3), 3));
    if (w >= 6) add('shield', Math.min(1 + Math.floor((w - 6) / 3), 3));
    for (let k = list.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [list[k], list[j]] = [list[j], list[k]];
    }
    return list;
  }

  waveHint() {
    const w = this.wave;
    if (w % 5 === 0) return 'Mothership incoming — shoot out its turrets to drop the shield!';
    if (w === 1) return 'Point the stick to fly · A to fire · B for a shield blast';
    if (w === 2) return 'Hostile drones inbound';
    if (w === 3) return 'Kamikazes flash orange right before they dash';
    if (w === 4) return 'Snipers paint you with a red laser — keep moving';
    if (w === 6) return 'Shielded drones block shots from the front — flank them';
    return 'Clear the sector';
  }

  nextWave() {
    this.wave++;
    this.state = 'intro';
    this.stateT = 2.6;
    const n = this.ships.length;
    this.queue = [];
    if (this.wave % 5 === 0) {
      const hp = 140 + 60 * n + this.wave * 10;
      const thp = 26 + n * 8;
      this.boss = {
        x: W / 2,
        y: -160,
        hp,
        max: hp,
        t: 0,
        phase: 1,
        ringCd: 3,
        spiralA: 0,
        spiralCd: 0,
        spawnCd: 7,
        flash: 0,
        shieldHit: 0,
        dying: 0,
        boomCd: 0,
        turrets: TURRETS.map(([ox, oy]) => ({ ox, oy, hp: thp, max: thp, angle: Math.PI / 2, cd: rand(1, 2.5), flash: 0, dead: false })),
      };
    } else {
      const big = Math.min(2 + Math.ceil(this.wave * 0.8) + Math.floor(n / 2), 9);
      for (let k = 0; k < big; k++) this.spawnRock(3);
      this.queue = this.waveRoster(this.wave, n);
    }
    this.spawnTimer = 2.5;
    this.host.sfx('count');
  }

  edgePoint() {
    for (let k = 0; k < 20; k++) {
      const side = Math.floor(Math.random() * 4);
      const x = side === 0 ? -40 : side === 1 ? W + 40 : rand(W);
      const y = side === 2 ? -40 : side === 3 ? H + 40 : rand(H);
      if (this.ships.every((s) => !s.alive || dist(s.x, s.y, x, y) > 260)) return { x, y };
    }
    return { x: -40, y: rand(H) };
  }

  spawnRock(size, at, vel) {
    const p = at ?? this.edgePoint();
    const a = rand(TAU);
    const speed = (size === 3 ? rand(35, 75) : size === 2 ? rand(70, 120) : rand(110, 170)) * (1 + this.wave * 0.04);
    this.asteroids.push({
      x: p.x,
      y: p.y,
      vx: vel ? vel.x : Math.cos(a) * speed,
      vy: vel ? vel.y : Math.sin(a) * speed,
      size,
      r: SIZES[size].r,
      hp: SIZES[size].hp,
      rot: rand(TAU),
      spin: rand(-1.2, 1.2) * (4 - size) * 0.6,
      variant: Math.floor(Math.random() * ROCK_VARIANTS),
      flash: 0,
      nocol: at ? 0.3 : 0,
    });
  }

  spawnEnemy(type, at) {
    const p = at ?? this.edgePoint();
    const d = ENEMY[type];
    this.enemies.push({
      type,
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      r: d.r,
      hp: d.hp + Math.floor(this.wave / 6),
      t: rand(TAU),
      flash: 0,
      fireCd: type === 'sniper' ? rand(2.5, 4) : rand(1.5, 3),
      angle: rand(TAU),
      aim: 0,
      mode: 'seek',
      modeT: 1,
    });
    this.rings.push({ x: p.x, y: p.y, r: 0, max: 60, life: 0.4, maxLife: 0.4, color: d.color, w: 3 });
  }

  nearestShip(x, y) {
    let best = null;
    let bd = Infinity;
    for (const s of this.ships) {
      if (!s.alive) continue;
      const d = dist(s.x, s.y, x, y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  addShake(v) {
    this.shake = Math.min(26, Math.max(this.shake, v));
  }

  popup(x, y, str, color = '#fff', size = 16) {
    if (this.popups.length > 30) this.popups.shift();
    this.popups.push({ x, y, str, color, size, life: 1, max: 1 });
  }

  // Score with the player's chain multiplier; every kill feeds the chain.
  award(s, base, x, y) {
    if (!s) return;
    const pts = base * s.mult;
    s.score += pts;
    s.chain++;
    s.chainT = 3;
    const m = Math.min(5, 1 + Math.floor(s.chain / 6));
    if (m > s.mult) {
      this.popup(s.x, s.y - 50, `x${m} MULTIPLIER`, s.color, 20);
      this.host.sfx('pickup');
    }
    s.mult = m;
    this.popup(x, y, `+${pts}`, s.mult > 1 ? '#ffd166' : '#fff');
  }

  // Shared explosion: particles, glow flash, shockwave ring, tumbling debris.
  explode(x, y, { r = 30, color = '#ffb347', debris = 5, debrisColor = '#4a4166', shake = 0, sound = 'smallExplode', vx = 0, vy = 0 } = {}) {
    this.particles.burst(x, y, { count: Math.round(10 + r * 0.5), color, speed: 120 + r * 5, life: 0.7, size: 3 });
    this.particles.burst(x, y, { count: Math.round(6 + r * 0.25), color: '#fff3c4', speed: 80 + r * 3, life: 0.4, size: 2.5 });
    this.flashes.push({ x, y, r: r * 2.4, life: 0.32, max: 0.32, color });
    this.rings.push({ x, y, r: 0, max: r * 3, life: 0.55, maxLife: 0.55, color, w: Math.min(8, 2 + r / 10) });
    for (let k = 0; k < debris; k++) {
      const a = rand(TAU);
      const sp = rand(40, 120 + r * 3);
      const n = 4 + Math.floor(Math.random() * 2);
      this.debris.push({
        x,
        y,
        vx: vx * 0.6 + Math.cos(a) * sp,
        vy: vy * 0.6 + Math.sin(a) * sp,
        rot: rand(TAU),
        spin: rand(-8, 8),
        size: rand(3, 3 + r * 0.16),
        life: rand(0.8, 1.6),
        max: 1.6,
        color: debrisColor,
        pts: Array.from({ length: n }, (_, k2) => [(k2 / n) * TAU + rand(-0.3, 0.3), rand(0.6, 1)]),
      });
    }
    if (this.debris.length > 160) this.debris.splice(0, this.debris.length - 160);
    if (shake) this.addShake(shake);
    if (sound) this.host.sfx(sound);
  }

  applyWell(o, dt, k) {
    const w = this.well;
    if (!w) return;
    const dx = w.x - o.x;
    const dy = w.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d < 30) return;
    const a = w.g * k * (0.35 + 0.65 * clamp(1 - d / 900, 0, 1));
    o.vx += (dx / d) * a * dt;
    o.vy += (dy / d) * a * dt;
  }

  /* ------------------------------------------------------------ Update */
  update(dt, inputs) {
    this.time += dt;
    this.particles.update(dt);
    this.updateFx(dt);
    this.shake = Math.max(0, this.shake - dt * (10 + this.shake * 4));
    if (this.phaseBanner) {
      this.phaseBanner.t -= dt;
      if (this.phaseBanner.t <= 0) this.phaseBanner = null;
    }

    // Parallax camera follows the team's centre of mass, gently.
    const live = this.ships.filter((s) => s.alive);
    if (live.length) {
      const ax = live.reduce((t, s) => t + s.x, 0) / live.length - W / 2;
      const ay = live.reduce((t, s) => t + s.y, 0) / live.length - H / 2;
      this.cam.x += (ax - this.cam.x) * Math.min(1, dt * 1.5);
      this.cam.y += (ay - this.cam.y) * Math.min(1, dt * 1.5);
    }
    if (this.result) return;

    if (this.state === 'intro') {
      this.stateT -= dt;
      if (this.stateT <= 0) this.state = 'play';
    } else if (this.state === 'clear') {
      this.stateT -= dt;
      if (this.stateT <= 0) this.nextWave();
    }

    for (const s of this.ships) this.updateShip(s, inputs[s.i] ?? IDLE, dt);

    this.updateRocks(dt);

    if (this.state === 'play' && this.queue.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnEnemy(this.queue.shift());
        this.spawnTimer = 1.4;
      }
    }
    this.updateEnemies(dt);
    if (this.boss) this.updateBoss(dt);
    this.updateMissiles(dt);
    this.updateShots(dt);
    this.updatePickups(dt);
    this.shipCollisions();

    if (this.state === 'play' && !this.asteroids.length && !this.enemies.length && !this.queue.length && !this.boss) {
      this.state = 'clear';
      this.stateT = 2.4;
      const bonus = 250;
      this.ships.forEach((s) => (s.score += Math.round(bonus / this.ships.length)));
      this.host.sfx('win');
    }

    if (this.ships.every((s) => s.out)) this.finish();
  }

  updateFx(dt) {
    for (const r of this.rings) {
      r.life -= dt;
      const p = 1 - Math.max(0, r.life) / r.maxLife;
      r.r = r.max * (1 - (1 - p) ** 3);
    }
    for (const f of this.flashes) f.life -= dt;
    for (const d of this.debris) {
      d.life -= dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= 1 - dt * 0.8;
      d.vy *= 1 - dt * 0.8;
      d.rot += d.spin * dt;
    }
    for (const p of this.popups) {
      p.life -= dt;
      p.y -= 40 * dt;
    }
    sweep(this.rings);
    sweep(this.flashes);
    sweep(this.debris);
    sweep(this.popups);
  }

  updateShip(s, inp, dt) {
    if (s.down) {
      this.updateDown(s, dt);
      return;
    }
    s.beam = null;
    if (!s.alive) return;
    s.inv -= dt;
    s.cooldown -= dt;
    s.missileCd -= dt;
    s.shieldT -= dt;
    s.shieldCd -= dt;
    s.muzzle -= dt;
    if (s.weapon) {
      s.weaponT -= dt;
      if (s.weaponT <= 0) s.weapon = null;
    }
    if (s.chain > 0) {
      s.chainT -= dt;
      if (s.chainT <= 0) {
        s.chain = 0;
        s.mult = 1;
      }
    }

    const m = Math.min(1, Math.hypot(inp.x, inp.y));
    if (m > 0.3) {
      const target = Math.atan2(inp.y, inp.x);
      s.angle = turnToward(s.angle, target, 7 * dt);
      s.thrust = m * (Math.abs(angleDiff(s.angle, target)) < 1.2 ? 1 : 0.3);
    } else s.thrust = 0;
    s.flame += (s.thrust - s.flame) * Math.min(1, dt * 12); // engine spools up and down

    s.vx += Math.cos(s.angle) * THRUST * s.thrust * dt;
    s.vy += Math.sin(s.angle) * THRUST * s.thrust * dt;
    this.applyWell(s, dt, 1);
    const drag = Math.max(0, 1 - 0.75 * dt);
    s.vx *= drag;
    s.vy *= drag;
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > MAX_SPEED) {
      s.vx *= MAX_SPEED / sp;
      s.vy *= MAX_SPEED / sp;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    wrap(s, 10);

    if (s.flame > 0.1 && Math.random() < s.flame) {
      const bx = s.x - Math.cos(s.angle) * 20;
      const by = s.y - Math.sin(s.angle) * 20;
      this.particles.burst(bx, by, { count: 1, color: Math.random() < 0.5 ? '#ffb347' : s.color, speed: 160, life: 0.35, angle: s.angle + Math.PI, spread: 0.5, size: 3 });
    }

    // Weapons
    if (inp.a) {
      if (s.weapon === 'laser') this.fireLaser(s, dt);
      else if (s.cooldown <= 0) {
        const spread = s.weapon === 'spread';
        s.cooldown = spread ? 0.2 : 0.15;
        for (const da of spread ? [-0.26, -0.13, 0, 0.13, 0.26] : [0]) {
          const cx = Math.cos(s.angle + da);
          const cy = Math.sin(s.angle + da);
          this.bullets.push({ x: s.x + cx * 24, y: s.y + cy * 24, vx: cx * 940 + s.vx * 0.4, vy: cy * 940 + s.vy * 0.4, owner: s, life: spread ? 0.6 : 0.85 });
        }
        // Recoil
        s.vx -= Math.cos(s.angle) * (spread ? 10 : 5);
        s.vy -= Math.sin(s.angle) * (spread ? 10 : 5);
        s.muzzle = 0.05;
        this.host.sfx('laser');
      }
      if (s.weapon === 'homing' && s.missileCd <= 0) {
        s.missileCd = 0.5;
        for (const side of [-1, 1]) {
          const a = s.angle + side * 0.9;
          this.missiles.push({
            x: s.x + Math.cos(s.angle + side * 1.6) * 14,
            y: s.y + Math.sin(s.angle + side * 1.6) * 14,
            vx: s.vx + Math.cos(a) * 160,
            vy: s.vy + Math.sin(a) * 160,
            angle: a,
            speed: 160,
            owner: s,
            life: 2.6,
            target: null,
          });
        }
        this.host.sfx('shoot');
      }
    }
    if (s.beam && !s.beamWas) this.host.sfx('boost');
    s.beamWas = !!s.beam;

    if (inp.bPressed && s.shieldCd <= 0) this.shieldBlast(s);
  }

  // Ray-cast beam that pierces everything except front shields and the mothership hull.
  fireLaser(s, dt) {
    const cx = Math.cos(s.angle);
    const cy = Math.sin(s.angle);
    const x1 = s.x + cx * 24;
    const y1 = s.y + cy * 24;
    const len = 1100;
    const hits = [];
    const ray = (ox, oy, r, kind, obj) => {
      const fx = x1 - ox;
      const fy = y1 - oy;
      const b = fx * cx + fy * cy;
      const c = fx * fx + fy * fy - r * r;
      const disc = b * b - c;
      if (disc < 0) return;
      let t = -b - Math.sqrt(disc);
      if (t < 0) {
        if (c >= 0) return;
        t = 0;
      }
      if (t <= len) hits.push({ t, kind, obj });
    };
    for (const a of this.asteroids) ray(a.x, a.y, a.r * 0.85, 'rock', a);
    for (const e of this.enemies) ray(e.x, e.y, e.r, 'enemy', e);
    const b = this.boss;
    if (b && !b.dying && this.state === 'play') {
      for (const t of b.turrets) if (!t.dead) ray(b.x + t.ox, b.y + t.oy, TURRET_R, 'turret', t);
      ray(b.x, b.y + 4, 46, 'core', b);
    }
    hits.sort((p, q) => p.t - q.t);
    let end = len;
    for (const h of hits) {
      const hx = x1 + cx * h.t;
      const hy = y1 + cy * h.t;
      if (h.kind === 'enemy' && this.shieldFacing(h.obj, hx, hy)) {
        end = h.t;
        if (Math.random() < 0.5) this.particles.burst(hx, hy, { count: 2, color: '#7dd3fc', speed: 260, life: 0.2, size: 2 });
        break;
      }
      this.damage(h, 9 * dt, s, cx * 300, cy * 300);
      if (Math.random() < 0.35) this.particles.burst(hx, hy, { count: 2, color: '#f9a8d4', speed: 220, life: 0.25, size: 2 });
      if (h.kind === 'core') {
        end = h.t;
        break;
      }
    }
    s.beam = { x1, y1, x2: x1 + cx * end, y2: y1 + cy * end };
    s.vx -= cx * 40 * dt;
    s.vy -= cy * 40 * dt;
  }

  shieldBlast(s) {
    s.shieldT = 2;
    s.shieldCd = 8;
    this.host.sfx('shield');
    this.particles.burst(s.x, s.y, { count: 36, color: '#22d3ee', speed: 420, life: 0.45, size: 3, drag: 1 });
    this.rings.push({ x: s.x, y: s.y, r: 0, max: 190, life: 0.45, maxLife: 0.45, color: '#22d3ee', w: 6 });
    for (const a of [...this.asteroids]) {
      const d = dist(a.x, a.y, s.x, s.y);
      if (d < 180 + a.r) {
        // Same impulse for every rock, so light ones get flung much further
        const k = 260 * (34 * 34) / (a.r * a.r);
        a.vx += ((a.x - s.x) / (d || 1)) * Math.min(420, k);
        a.vy += ((a.y - s.y) / (d || 1)) * Math.min(420, k);
        if (a.size === 1) this.destroyRock(a, s);
      }
    }
    for (const e of [...this.enemies]) {
      const d = dist(e.x, e.y, s.x, s.y);
      if (d < 180) {
        e.vx += ((e.x - s.x) / (d || 1)) * 380;
        e.vy += ((e.y - s.y) / (d || 1)) * 380;
        e.hp -= 2;
        e.flash = 0.1;
        if (e.hp <= 0) this.destroyEnemy(e, s);
      }
    }
    this.orbs = this.orbs.filter((o) => dist(o.x, o.y, s.x, s.y) > 180);
  }

  // A downed pilot drifts as a wreck; teammates hovering close bring them back for free.
  updateDown(s, dt) {
    const w = s.wreck;
    w.x += w.vx * dt;
    w.y += w.vy * dt;
    w.vx *= 1 - dt * 0.8;
    w.vy *= 1 - dt * 0.8;
    w.rot += w.spin * dt;
    wrap(w, 10);
    if (Math.random() < dt * 6) this.particles.burst(w.x, w.y, { count: 2, color: '#ffb347', speed: 90, life: 0.4, size: 2 });

    s.helpers = this.ships.filter((o) => o.alive && dist(o.x, o.y, w.x, w.y) < REVIVE_R);
    if (s.helpers.length) {
      s.revive += (dt * s.helpers.length) / REVIVE_TIME;
      if (Math.random() < 0.5) {
        const h = s.helpers[0];
        const t = Math.random();
        this.particles.burst(h.x + (w.x - h.x) * t, h.y + (w.y - h.y) * t, { count: 1, color: '#5eead4', speed: 40, life: 0.3, size: 2 });
      }
    } else s.revive = Math.max(0, s.revive - dt * 0.6);

    if (s.revive >= 1) {
      Object.assign(s, { alive: true, down: false, x: w.x, y: w.y, vx: 0, vy: 0, inv: 2, revive: 0, angle: w.rot, shieldCd: 0 });
      this.rings.push({ x: w.x, y: w.y, r: 0, max: 120, life: 0.5, maxLife: 0.5, color: '#5eead4', w: 5 });
      this.particles.burst(w.x, w.y, { count: 30, color: '#5eead4', speed: 260, life: 0.6, size: 3 });
      for (const h of s.helpers) {
        h.score += 100;
        this.popup(h.x, h.y - 30, 'RESCUE +100', '#5eead4');
      }
      this.popup(w.x, w.y - 40, 'REVIVED!', s.color, 22);
      this.host.sfx('deliver');
      this.host.buzz(s.i, 120);
      return;
    }

    if (!this.ships.some((o) => o.alive)) s.downT = Math.min(s.downT, 1.6); // nobody left to help
    s.downT -= dt;
    if (s.downT <= 0) {
      s.down = false;
      if (this.lives > 0) {
        this.lives--;
        Object.assign(s, { alive: true, x: W / 2, y: H / 2, vx: 0, vy: 0, inv: 2.5, angle: -Math.PI / 2, revive: 0 });
        this.rings.push({ x: s.x, y: s.y, r: 0, max: 90, life: 0.5, maxLife: 0.5, color: s.color, w: 4 });
      } else s.out = true;
    }
  }

  updateRocks(dt) {
    const rocks = this.asteroids;
    for (const a of rocks) {
      this.applyWell(a, dt, 0.5);
      const sp = Math.hypot(a.vx, a.vy);
      if (sp > 340) {
        a.vx *= 340 / sp;
        a.vy *= 340 / sp;
      }
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += a.spin * dt;
      a.flash -= dt;
      a.nocol -= dt;
      wrap(a, a.r);
    }
    // Elastic rock-on-rock collisions, mass ~ r²
    for (let i = 0; i < rocks.length; i++) {
      const a = rocks[i];
      for (let j = i + 1; j < rocks.length; j++) {
        const b = rocks[j];
        if (a.nocol > 0 || b.nocol > 0) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = (a.r + b.r) * 0.82;
        if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
        const d = Math.hypot(dx, dy);
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        const ma = a.r * a.r;
        const mb = b.r * b.r;
        const over = min - d;
        a.x -= nx * over * (mb / (ma + mb));
        a.y -= ny * over * (mb / (ma + mb));
        b.x += nx * over * (ma / (ma + mb));
        b.y += ny * over * (ma / (ma + mb));
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn >= 0) continue;
        const jmp = (-(1 + 0.85) * vn) / (1 / ma + 1 / mb);
        a.vx -= (jmp / ma) * nx;
        a.vy -= (jmp / ma) * ny;
        b.vx += (jmp / mb) * nx;
        b.vy += (jmp / mb) * ny;
        // A glancing blow sets them spinning
        const tang = (b.vx - a.vx) * -ny + (b.vy - a.vy) * nx;
        a.spin += tang * 0.004 * (b.r / a.r);
        b.spin -= tang * 0.004 * (a.r / b.r);
        if (vn < -50) {
          const cx = a.x + nx * a.r * 0.82;
          const cy = a.y + ny * a.r * 0.82;
          this.particles.burst(cx, cy, { count: 5, color: '#8b7cc8', speed: 90, life: 0.5, size: 2.5 });
          if (vn < -120) this.host.sfx('crash');
        }
      }
    }
  }

  updateEnemies(dt) {
    const play = this.state === 'play';
    for (const e of this.enemies) {
      e.t += dt;
      e.flash -= dt;
      e.fireCd -= dt;
      e.modeT -= dt;
      e.shieldHit = (e.shieldHit || 0) - dt;
      const target = this.nearestShip(e.x, e.y);
      const ta = target ? Math.atan2(target.y - e.y, target.x - e.x) : e.angle;
      const td = target ? dist(target.x, target.y, e.x, e.y) : 999;
      const steer = (speed, k) => {
        e.vx += (Math.cos(ta) * speed - e.vx) * dt * k;
        e.vy += (Math.sin(ta) * speed - e.vy) * dt * k;
      };

      if (e.type === 'drone') {
        if (target) steer(150 + this.wave * 6, 1.4);
        if (target && this.wave >= 3 && e.fireCd <= 0 && play) {
          e.fireCd = rand(2, 3);
          this.orbs.push({ x: e.x, y: e.y, vx: Math.cos(ta) * 280, vy: Math.sin(ta) * 280, life: 4 });
        }
      } else if (e.type === 'kamikaze') {
        if (e.mode === 'seek') {
          if (target) steer(180 + this.wave * 5, 1.6);
          e.angle = Math.atan2(e.vy, e.vx);
          if (target && td < 360 && e.modeT <= 0 && play) {
            e.mode = 'lock';
            e.modeT = 0.6;
            this.host.sfx('block');
          }
        } else if (e.mode === 'lock') {
          e.vx *= 1 - dt * 5;
          e.vy *= 1 - dt * 5;
          e.angle = turnToward(e.angle, ta, 5 * dt);
          if (e.modeT <= 0) {
            e.mode = 'dash';
            e.modeT = 1.1;
            e.vx = Math.cos(e.angle) * 780;
            e.vy = Math.sin(e.angle) * 780;
            this.host.sfx('dash');
          }
        } else {
          if (Math.random() < 0.8) this.particles.burst(e.x, e.y, { count: 1, color: '#ff9f1c', speed: 60, life: 0.35, angle: e.angle + Math.PI, spread: 0.6, size: 3 });
          if (e.modeT <= 0) {
            e.mode = 'seek';
            e.modeT = 1.4;
          }
        }
      } else if (e.type === 'sniper') {
        if (target) {
          // Hold position ~480px away, slowly circling
          const away = Math.atan2(e.y - target.y, e.x - target.x) + 0.25;
          const gx = target.x + Math.cos(away) * 480;
          const gy = target.y + Math.sin(away) * 480;
          const ga = Math.atan2(gy - e.y, gx - e.x);
          const gs = Math.min(170, dist(gx, gy, e.x, e.y) * 1.5);
          e.vx += (Math.cos(ga) * gs - e.vx) * dt * 1.5;
          e.vy += (Math.sin(ga) * gs - e.vy) * dt * 1.5;
          if (e.fireCd > 0.3) e.aim = turnToward(e.aim, ta, 3 * dt); // locks for the last 0.3s
        }
        if (e.fireCd <= 0) {
          e.fireCd = rand(3, 4.2);
          if (target && play) {
            this.orbs.push({ x: e.x + Math.cos(e.aim) * 28, y: e.y + Math.sin(e.aim) * 28, vx: Math.cos(e.aim) * 980, vy: Math.sin(e.aim) * 980, life: 2, bolt: true });
            this.host.sfx('laser');
          }
        }
      } else if (e.type === 'shield') {
        e.angle = turnToward(e.angle, ta, 1.6 * dt);
        if (target) steer(95, 1);
        if (target && e.fireCd <= 0 && play) {
          e.fireCd = rand(2.5, 3.5);
          this.orbs.push({ x: e.x, y: e.y, vx: Math.cos(e.angle) * 260, vy: Math.sin(e.angle) * 260, life: 4 });
        }
      }
      if (e.type !== 'kamikaze' || e.mode !== 'dash') {
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 420) {
          e.vx *= 420 / sp;
          e.vy *= 420 / sp;
        }
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      wrap(e, 30);
    }
  }

  shieldFacing(e, x, y) {
    return e.type === 'shield' && Math.abs(angleDiff(e.angle, Math.atan2(y - e.y, x - e.x))) < 1.2;
  }

  updateBoss(dt) {
    const b = this.boss;
    b.t += dt;
    b.flash -= dt;
    b.shieldHit -= dt;
    const fast = b.phase === 1 ? 1 : 1.35;
    const tx = W / 2 + Math.sin(b.t * 0.45 * fast) * 480;
    const ty = 210 + Math.sin(b.t * 0.9 * fast) * 60;
    const k = Math.min(1, dt * (b.t < 2.5 ? 1.2 : 3));
    b.x += (tx - b.x) * k;
    b.y += (ty - b.y) * k;
    for (const t of b.turrets) {
      t.flash -= dt;
      if (t.dead && Math.random() < dt * 4) this.particles.burst(b.x + t.ox, b.y + t.oy, { count: 1, color: '#6b6280', speed: 40, life: 0.8, angle: -Math.PI / 2, spread: 0.8, size: 4, drag: 1 });
    }

    if (b.dying > 0) {
      b.dying -= dt;
      b.boomCd -= dt;
      if (b.boomCd <= 0) {
        b.boomCd = 0.13;
        this.explode(b.x + rand(-110, 110), b.y + rand(-36, 36), { r: rand(20, 40), color: Math.random() < 0.5 ? '#ff5fc8' : '#ffd166', debris: 3, debrisColor: '#4c1d95', shake: 6 });
      }
      if (b.dying <= 0) {
        this.explode(b.x, b.y, { r: 110, color: '#ff5fc8', debris: 24, debrisColor: '#4c1d95', shake: 26, sound: 'explode' });
        for (let k = 0; k < 12; k++) this.dropCrystal(b.x + rand(-80, 80), b.y + rand(-30, 30));
        this.dropPod(b.x, b.y);
        this.boss = null;
        this.well = null;
      }
      return;
    }
    if (this.state !== 'play') return;

    const ratio = b.hp / b.max;
    if ((b.phase === 1 && ratio < 0.66) || (b.phase === 2 && ratio < 0.33)) {
      b.phase++;
      this.phaseBanner = { title: `PHASE ${b.phase}`, sub: b.phase === 2 ? 'Spiral barrage · kamikaze escorts' : 'Gravity well — burn hard to escape the pull!', t: 2 };
      this.rings.push({ x: b.x, y: b.y, r: 0, max: 380, life: 0.8, maxLife: 0.8, color: '#ff5fc8', w: 8 });
      this.addShake(12);
      this.host.sfx('special');
    }
    this.well = b.phase === 3 ? { x: b.x, y: b.y + 6, g: 330 } : null;

    // Turrets track and fire on their own
    for (const t of b.turrets) {
      if (t.dead) continue;
      const tx2 = b.x + t.ox;
      const ty2 = b.y + t.oy;
      const s = this.nearestShip(tx2, ty2);
      if (!s) continue;
      const a = Math.atan2(s.y - ty2, s.x - tx2);
      t.angle = turnToward(t.angle, a, 2.5 * dt);
      t.cd -= dt;
      if (t.cd <= 0 && Math.abs(angleDiff(t.angle, a)) < 0.3) {
        t.cd = b.phase === 1 ? 1.8 : 1.3;
        this.orbs.push({ x: tx2 + Math.cos(t.angle) * 22, y: ty2 + Math.sin(t.angle) * 22, vx: Math.cos(t.angle) * 320, vy: Math.sin(t.angle) * 320, life: 4 });
      }
    }

    b.ringCd -= dt;
    if (b.ringCd <= 0) {
      b.ringCd = b.phase === 3 ? 2.4 : 3.2;
      const count = b.phase === 3 ? 22 : 16;
      const off = rand(TAU);
      for (let i = 0; i < count; i++) {
        const a = off + (i / count) * TAU;
        this.orbs.push({ x: b.x, y: b.y, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220, life: 5 });
      }
    }
    if (b.phase >= 2 && b.t % 6 < 2.2) {
      b.spiralCd -= dt;
      if (b.spiralCd <= 0) {
        b.spiralCd = 0.1;
        b.spiralA += 0.33;
        for (const off of [0, Math.PI]) {
          const a = b.spiralA + off;
          this.orbs.push({ x: b.x, y: b.y + 20, vx: Math.cos(a) * 250, vy: Math.sin(a) * 250, life: 4.5 });
        }
      }
    }
    b.spawnCd -= dt;
    if (b.spawnCd <= 0) {
      b.spawnCd = 8;
      const type = b.phase === 1 ? 'drone' : 'kamikaze';
      this.spawnEnemy(type, { x: b.x - 90, y: b.y + 20 });
      this.spawnEnemy(type, { x: b.x + 90, y: b.y + 20 });
    }
  }

  // First thing a projectile at (x, y) with radius rad touches.
  findHit(x, y, rad) {
    for (const e of this.enemies) if (Math.abs(e.x - x) < e.r + rad && dist(e.x, e.y, x, y) < e.r + rad) return { kind: 'enemy', obj: e };
    const b = this.boss;
    if (b && !b.dying && this.state === 'play') {
      for (const t of b.turrets) if (!t.dead && dist(b.x + t.ox, b.y + t.oy, x, y) < TURRET_R + rad) return { kind: 'turret', obj: t };
      const ex = (x - b.x) / (128 + rad);
      const ey = (y - b.y) / (46 + rad);
      if (ex * ex + ey * ey < 1) return { kind: 'core', obj: b };
    }
    for (const a of this.asteroids) if (Math.abs(a.x - x) < a.r + rad && dist(a.x, a.y, x, y) < a.r * 0.9 + rad) return { kind: 'rock', obj: a };
    return null;
  }

  damage(hit, amt, by, vx = 0, vy = 0) {
    const o = hit.obj;
    if (hit.kind === 'rock') {
      o.hp -= amt;
      o.flash = 0.06;
      const k = (11 * amt) / (o.r * o.r); // shots carry momentum: small rocks get knocked about
      o.vx += vx * k;
      o.vy += vy * k;
      if (o.hp <= 0) this.destroyRock(o, by);
    } else if (hit.kind === 'enemy') {
      o.hp -= amt;
      o.flash = 0.06;
      o.vx += vx * 0.04 * amt;
      o.vy += vy * 0.04 * amt;
      if (o.hp <= 0) this.destroyEnemy(o, by);
    } else if (hit.kind === 'turret') {
      o.hp -= amt;
      o.flash = 0.06;
      if (o.hp <= 0) this.destroyTurret(o, by);
    } else {
      const shielded = o.turrets.some((t) => !t.dead);
      o.hp -= shielded ? amt * 0.2 : amt;
      o.flash = 0.05;
      if (shielded) o.shieldHit = 0.15;
      if (o.hp <= 0) this.killBoss(by);
    }
  }

  updateMissiles(dt) {
    for (const m of this.missiles) {
      m.life -= dt;
      const tgt = m.target;
      if (!tgt || tgt.dead) m.target = this.acquire(m);
      if (m.target) {
        const p = this.targetPos(m.target);
        m.angle = turnToward(m.angle, Math.atan2(p.y - m.y, p.x - m.x), 5.5 * dt);
      }
      m.speed = Math.min(760, m.speed + 1100 * dt);
      m.vx = Math.cos(m.angle) * m.speed;
      m.vy = Math.sin(m.angle) * m.speed;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      wrap(m);
      if (Math.random() < 0.9) this.particles.burst(m.x, m.y, { count: 1, color: Math.random() < 0.5 ? '#9ca3af' : '#fb923c', speed: 30, life: 0.45, size: 2.5, drag: 2 });
      const hit = this.findHit(m.x, m.y, 6);
      if (hit) {
        m.life = 0;
        if (hit.kind === 'enemy' && this.shieldFacing(hit.obj, m.x, m.y)) {
          this.explode(m.x, m.y, { r: 14, color: '#7dd3fc', debris: 0, sound: 'block' });
          continue;
        }
        this.damage(hit, 3, m.owner, m.vx, m.vy);
        this.explode(m.x, m.y, { r: 18, color: '#fb923c', debris: 1, shake: 2 });
        // Splash
        for (const a of [...this.asteroids]) if (dist(a.x, a.y, m.x, m.y) < 50 + a.r * 0.5) this.damage({ kind: 'rock', obj: a }, 1, m.owner);
        for (const e of [...this.enemies]) if (dist(e.x, e.y, m.x, m.y) < 60) this.damage({ kind: 'enemy', obj: e }, 1, m.owner);
      } else if (m.life <= 0) this.explode(m.x, m.y, { r: 10, color: '#fb923c', debris: 0, sound: null });
    }
    sweep(this.missiles);
  }

  acquire(m) {
    let best = null;
    let bd = 1000;
    const consider = (o, x, y, bias) => {
      const d = dist(x, y, m.x, m.y) * bias;
      if (d < bd) {
        bd = d;
        best = o;
      }
    };
    for (const e of this.enemies) consider(e, e.x, e.y, 0.7);
    const b = this.boss;
    if (b && !b.dying) {
      for (const t of b.turrets) if (!t.dead) consider(t, b.x + t.ox, b.y + t.oy, 0.6);
      if (b.turrets.every((t) => t.dead)) consider(b, b.x, b.y, 0.8);
    }
    for (const a of this.asteroids) consider(a, a.x, a.y, 1);
    return best;
  }

  targetPos(o) {
    if (o.ox !== undefined && this.boss) return { x: this.boss.x + o.ox, y: this.boss.y + o.oy };
    return o;
  }

  updateShots(dt) {
    const keep = [];
    for (const bl of this.bullets) {
      if (this.well) this.applyWell(bl, dt, 1.6); // shots bend around the gravity well
      bl.x += bl.vx * dt;
      bl.y += bl.vy * dt;
      bl.life -= dt;
      wrap(bl);
      if (bl.life <= 0) continue;
      const hit = this.findHit(bl.x, bl.y, 2);
      if (hit) {
        if (hit.kind === 'enemy' && !bl.deflected && this.shieldFacing(hit.obj, bl.x, bl.y)) {
          // Ricochet off the energy shield
          const e = hit.obj;
          const d = dist(e.x, e.y, bl.x, bl.y) || 1;
          const nx = (bl.x - e.x) / d;
          const ny = (bl.y - e.y) / d;
          const dot = bl.vx * nx + bl.vy * ny;
          bl.vx -= 2 * dot * nx;
          bl.vy -= 2 * dot * ny;
          bl.x = e.x + nx * (e.r + 8);
          bl.y = e.y + ny * (e.r + 8);
          bl.deflected = true;
          bl.life = Math.min(bl.life, 0.4);
          e.shieldHit = 0.12;
          this.particles.burst(bl.x, bl.y, { count: 4, color: '#7dd3fc', speed: 180, life: 0.25, size: 2 });
          this.host.sfx('block');
          keep.push(bl);
          continue;
        }
        this.damage(hit, 1, bl.owner, bl.vx, bl.vy);
        const col = hit.kind === 'rock' ? '#c4b5fd' : hit.kind === 'core' && hit.obj.shieldHit > 0 ? '#22d3ee' : '#ff8fd8';
        this.particles.burst(bl.x, bl.y, { count: 4, color: col, speed: 160, life: 0.25, size: 2, angle: Math.atan2(-bl.vy, -bl.vx), spread: 1.6 });
        continue;
      }
      keep.push(bl);
    }
    this.bullets = keep;

    for (const o of this.orbs) {
      if (this.well && !o.bolt) this.applyWell(o, dt, 0.4);
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.life -= dt;
      if (o.x < -40 || o.x > W + 40 || o.y < -40 || o.y > H + 40) o.life = 0;
    }
    sweep(this.orbs);
  }

  destroyRock(a, by) {
    const idx = this.asteroids.indexOf(a);
    if (idx === -1) return;
    this.asteroids.splice(idx, 1);
    a.dead = true;
    if (by) {
      this.award(by, SIZES[a.size].score, a.x, a.y);
      by.kills++;
    }
    this.explode(a.x, a.y, {
      r: a.r * 0.7,
      color: '#a78bfa',
      debris: a.size * 4,
      debrisColor: '#4a3f72',
      shake: a.size === 3 ? 7 : a.size === 2 ? 3 : 0,
      sound: a.size === 3 ? 'explode' : 'smallExplode',
      vx: a.vx,
      vy: a.vy,
    });
    if (a.size > 1) {
      // Split with equal and opposite kicks so total momentum is conserved
      const base = Math.atan2(a.vy, a.vx) + rand(-0.6, 0.6);
      const px = -Math.sin(base);
      const py = Math.cos(base);
      const kick = rand(60, 110);
      for (const s of [-1, 1]) {
        const off = a.r * 0.4 * s;
        this.spawnRock(a.size - 1, { x: a.x + px * off, y: a.y + py * off }, { x: a.vx + px * kick * s, y: a.vy + py * kick * s });
      }
    }
    if (Math.random() < (a.size === 1 ? 0.3 : 0.55)) this.dropCrystal(a.x, a.y);
    if (a.size === 3 && Math.random() < 0.1) this.dropPod(a.x, a.y);
  }

  destroyEnemy(e, by) {
    const idx = this.enemies.indexOf(e);
    if (idx === -1) return;
    this.enemies.splice(idx, 1);
    e.dead = true;
    const d = ENEMY[e.type];
    if (by) {
      this.award(by, d.score, e.x, e.y);
      by.kills++;
    }
    this.explode(e.x, e.y, { r: e.type === 'kamikaze' ? 34 : 26, color: d.color, debris: 6, debrisColor: '#3a2f5a', shake: 4, vx: e.vx, vy: e.vy });
    if (Math.random() < 0.6) this.dropCrystal(e.x, e.y);
    if (Math.random() < (e.type === 'drone' ? 0.12 : 0.25)) this.dropPod(e.x, e.y);
  }

  destroyTurret(t, by) {
    if (t.dead) return;
    t.dead = true;
    const b = this.boss;
    if (by) {
      this.award(by, 300, b.x + t.ox, b.y + t.oy);
      by.kills++;
    }
    this.explode(b.x + t.ox, b.y + t.oy, { r: 34, color: '#ffd166', debris: 8, debrisColor: '#4c1d95', shake: 8, sound: 'explode' });
    this.dropPod(b.x + t.ox, b.y + t.oy + 20);
    if (b.turrets.every((o) => o.dead)) {
      this.phaseBanner = { title: 'SHIELD DOWN', sub: 'Hit the core!', t: 1.6 };
      this.rings.push({ x: b.x, y: b.y, r: 0, max: 260, life: 0.6, maxLife: 0.6, color: '#22d3ee', w: 6 });
    }
  }

  killBoss(by) {
    const b = this.boss;
    if (b.dying > 0) return;
    b.dying = 2.2;
    b.hp = 0;
    b.dead = true; // lets homing missiles let go
    b.turrets.forEach((t) => (t.dead = true));
    if (by) {
      this.award(by, 2000, b.x, b.y - 60);
      by.kills++;
    }
    this.orbs = [];
    this.well = null;
    this.ships.forEach((s) => this.host.buzz(s.i, 300));
  }

  dropCrystal(x, y) {
    const a = rand(TAU);
    this.crystals.push({ x, y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, t: rand(TAU), life: 10 });
  }

  dropPod(x, y) {
    const kinds = Object.keys(WEAPONS);
    const a = rand(TAU);
    this.pods.push({ x, y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, t: 0, life: 12, kind: kinds[Math.floor(Math.random() * kinds.length)] });
  }

  updatePickups(dt) {
    const move = (c, magnet) => {
      c.t += dt;
      c.life -= dt;
      const s = this.nearestShip(c.x, c.y);
      if (s) {
        const d = dist(s.x, s.y, c.x, c.y);
        if (d < 30) return s;
        if (d < magnet) {
          c.vx += ((s.x - c.x) / d) * 900 * dt;
          c.vy += ((s.y - c.y) / d) * 900 * dt;
        }
      }
      this.applyWell(c, dt, 0.6);
      c.vx *= 1 - dt * 1.5;
      c.vy *= 1 - dt * 1.5;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      wrap(c);
      return null;
    };
    for (const c of this.crystals) {
      const s = move(c, 150);
      if (!s) continue;
      c.life = 0;
      this.award(s, 50, c.x, c.y);
      s.crystals++;
      this.bank++;
      this.host.sfx('coin');
      this.particles.burst(c.x, c.y, { count: 8, color: '#5eead4', speed: 140, life: 0.35 });
      if (this.bank >= BANK_LIFE) {
        this.bank = 0;
        this.lives++;
        this.popup(s.x, s.y - 50, '+1 LIFE', '#5eead4', 24);
        this.host.sfx('deliver');
      }
    }
    for (const p of this.pods) {
      const s = move(p, 90);
      if (!s) continue;
      p.life = 0;
      const wpn = WEAPONS[p.kind];
      s.weapon = p.kind;
      s.weaponT = WEAPON_TIME;
      this.popup(s.x, s.y - 50, wpn.name, wpn.color, 22);
      this.rings.push({ x: s.x, y: s.y, r: 0, max: 70, life: 0.4, maxLife: 0.4, color: wpn.color, w: 4 });
      this.host.sfx('pickup');
      this.host.buzz(s.i, 60);
    }
    sweep(this.crystals);
    sweep(this.pods);
  }

  shipCollisions() {
    for (const s of this.ships) {
      if (!s.alive) continue;
      const shielded = s.shieldT > 0;
      for (const a of this.asteroids) {
        const d = dist(a.x, a.y, s.x, s.y);
        if (d < a.r * 0.85 + SHIP_R) {
          if (shielded) {
            // Bounce: ship counts as a mid-size mass
            const nx = (a.x - s.x) / (d || 1);
            const ny = (a.y - s.y) / (d || 1);
            const vn = (a.vx - s.vx) * nx + (a.vy - s.vy) * ny;
            if (vn < 0) {
              const ms = 900;
              const ma = a.r * a.r;
              const j = (-1.8 * vn) / (1 / ms + 1 / ma);
              s.vx -= (j / ms) * nx;
              s.vy -= (j / ms) * ny;
              a.vx += (j / ma) * nx;
              a.vy += (j / ma) * ny;
              this.host.sfx('block');
            }
          } else if (s.inv <= 0) {
            this.killShip(s);
            break;
          }
        }
      }
      if (!s.alive) continue;
      for (const e of this.enemies) {
        if (dist(e.x, e.y, s.x, s.y) < e.r + SHIP_R - 4) {
          if (shielded) this.destroyEnemy(e, s);
          else if (s.inv <= 0) {
            if (e.type === 'kamikaze') this.destroyEnemy(e, null);
            this.killShip(s);
          }
          break;
        }
      }
      if (!s.alive) continue;
      const hitOrb = this.orbs.find((o) => o.life > 0 && dist(o.x, o.y, s.x, s.y) < (o.bolt ? 6 : 8) + SHIP_R * 0.85);
      if (hitOrb) {
        hitOrb.life = 0;
        if (!shielded && s.inv <= 0) this.killShip(s);
      }
      const b = this.boss;
      if (s.alive && b && !b.dying) {
        const ex = (s.x - b.x) / 132;
        const ey = (s.y - b.y) / 50;
        if (ex * ex + ey * ey < 1) {
          if (shielded) {
            const d = dist(b.x, b.y, s.x, s.y) || 1;
            s.vx = ((s.x - b.x) / d) * 420;
            s.vy = ((s.y - b.y) / d) * 420;
          } else if (s.inv <= 0) this.killShip(s);
        }
      }
    }
  }

  killShip(s) {
    s.alive = false;
    s.down = true;
    s.beam = null;
    s.wreck = { x: s.x, y: s.y, vx: s.vx * 0.3, vy: s.vy * 0.3, rot: s.angle, spin: rand(-3, 3) };
    s.downT = DOWN_TIME;
    s.revive = 0;
    s.weapon = null;
    s.chain = 0;
    s.mult = 1;
    this.explode(s.x, s.y, { r: 40, color: s.color, debris: 8, debrisColor: shade(s.color, -0.5), shake: 12, sound: 'explode', vx: s.vx, vy: s.vy });
    this.host.buzz(s.i, 400);
  }

  finish() {
    this.host.sfx('lose');
    const rows = [...this.ships]
      .sort((a, b) => b.score - a.score)
      .map((s) => ({ name: s.name, color: s.color, values: [s.score, s.kills, s.crystals] }));
    this.result = {
      title: 'Mission over',
      color: '#22d3ee',
      subtitle: `Reached wave ${this.wave} · Team score ${this.teamScore}`,
      columns: ['Score', 'Kills', 'Crystals'],
      rows,
    };
  }

  /* ------------------------------------------------------------ Render */
  render(ctx) {
    ctx.save();
    if (this.shake > 0) ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
    this.drawBackground(ctx);
    if (this.well) this.drawWell(ctx, this.well);

    for (const c of this.crystals) this.drawCrystal(ctx, c);
    for (const p of this.pods) this.drawPod(ctx, p);
    this.drawDebris(ctx);
    for (const a of this.asteroids) this.drawRock(ctx, a);
    for (const e of this.enemies) this.drawEnemy(ctx, e);
    if (this.boss) this.drawBoss(ctx, this.boss);
    for (const s of this.ships) if (s.down) this.drawWreck(ctx, s);
    for (const s of this.ships) if (s.alive) this.drawShip(ctx, s);

    this.drawShots(ctx);
    this.particles.render(ctx);
    for (const p of this.popups) text(ctx, p.str, p.x, p.y, { size: p.size, color: p.color, alpha: Math.min(1, p.life * 2) });
    ctx.restore();

    this.drawHud(ctx);
    if (this.state === 'intro') {
      const boss = this.wave % 5 === 0;
      const el = 2.6 - this.stateT;
      const alpha = Math.min(1, el * 4, this.stateT * 3);
      banner(ctx, `WAVE ${this.wave}`, this.waveHint(), { color: boss ? '#ff5fc8' : '#22d3ee', alpha, y: H / 2 + (1 - Math.min(1, el * 3)) ** 2 * 50 });
    } else if (this.state === 'clear') {
      banner(ctx, 'SECTOR CLEAR', '+250 team bonus', { color: '#5eead4', alpha: Math.min(1, this.stateT * 3, (2.4 - this.stateT) * 4) });
    }
    if (this.phaseBanner) {
      const pb = this.phaseBanner;
      const al = Math.min(1, pb.t * 2);
      text(ctx, pb.title, W / 2, H / 2 - 150, { size: 56, color: '#ff5fc8', glow: 24, alpha: al });
      text(ctx, pb.sub, W / 2, H / 2 - 108, { size: 20, font: 'Inter', weight: 700, color: '#ffd6ef', alpha: al });
    }
  }

  drawBackground(ctx) {
    const cx = this.cam.x;
    const cy = this.cam.y;
    ctx.drawImage(this.nebula, -60 - cx * 0.02, -60 - cy * 0.02);
    ctx.drawImage(this.planet, 1210 - cx * 0.04, -20 - cy * 0.04);
    const tile = (img, ox, oy) => {
      const x = ((ox % W) + W) % W;
      const y = ((oy % H) + H) % H;
      ctx.drawImage(img, x - W, y - H);
      ctx.drawImage(img, x, y - H);
      ctx.drawImage(img, x - W, y);
      ctx.drawImage(img, x, y);
    };
    tile(this.starsMid, -cx * 0.07 - this.time * 6, -cy * 0.07 - this.time * 2);
    tile(this.starsNear, -cx * 0.15 - this.time * 14, -cy * 0.15 - this.time * 5);
    ctx.fillStyle = '#fff';
    for (const t of this.twinkles) {
      ctx.globalAlpha = 0.35 + Math.sin(this.time * 2 + t.p) * 0.35;
      ctx.fillRect(t.x - t.r / 2, t.y - t.r / 2, t.r, t.r);
    }
    ctx.globalAlpha = 1;
  }

  drawWell(ctx, w) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(w.x, w.y);
    ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const r = 300 - ((this.time * 90 + k * 60) % 300); // rings contract inward
      ctx.strokeStyle = `rgba(168,85,247,${0.25 * (1 - r / 300) + 0.04})`;
      for (let q = 0; q < 3; q++) {
        const a = this.time * 1.5 + q * (TAU / 3) + k;
        ctx.beginPath();
        ctx.arc(0, 0, r, a, a + 1.2);
        ctx.stroke();
      }
    }
    drawGlow(ctx, '#a855f7', 0, 0, 120, 0.35);
    ctx.restore();
  }

  drawShots(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Explosion flashes
    for (const f of this.flashes) drawGlow(ctx, f.color, f.x, f.y, f.r * (1.2 - f.life / f.max * 0.4), f.life / f.max);
    ctx.globalAlpha = 1;
    // Shockwave rings
    for (const r of this.rings) {
      ctx.globalAlpha = Math.max(0, r.life / r.maxLife);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.w * (0.4 + (r.life / r.maxLife) * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Enemy fire
    for (const o of this.orbs) {
      if (o.bolt) {
        ctx.strokeStyle = '#bef264';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x - o.vx * 0.03, o.y - o.vy * 0.03);
        ctx.stroke();
        drawGlow(ctx, '#a3e635', o.x, o.y, 14, 1);
        ctx.globalAlpha = 1;
      } else drawGlow(ctx, '#ff3fa4', o.x, o.y, 15, 1);
    }
    ctx.globalAlpha = 1;
    // Player bolts
    ctx.lineCap = 'round';
    for (const b of this.bullets) {
      ctx.strokeStyle = b.owner.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025);
      ctx.stroke();
      drawGlow(ctx, b.owner.color, b.x, b.y, 9, 0.8);
      ctx.globalAlpha = 1;
    }
    for (const m of this.missiles) drawGlow(ctx, '#fb923c', m.x, m.y, 12, 1);
    ctx.globalAlpha = 1;
    // Laser beams
    for (const s of this.ships) {
      if (!s.beam) continue;
      const { x1, y1, x2, y2 } = s.beam;
      const wob = 1 + Math.sin(this.time * 60) * 0.15;
      for (const [w, col, a] of [
        [20 * wob, WEAPONS.laser.color, 0.22],
        [9 * wob, s.color, 0.6],
        [3, '#ffffff', 1],
      ]) {
        ctx.globalAlpha = a;
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      drawGlow(ctx, WEAPONS.laser.color, x2, y2, 26 * wob, 0.9);
      drawGlow(ctx, s.color, x1, y1, 18, 0.9);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawShip(ctx, s) {
    const blink = s.inv > 0 && Math.floor(this.time * 10) % 2 === 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    if (s.shieldT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const fade = Math.min(1, s.shieldT * 2);
      drawGlow(ctx, '#22d3ee', 0, 0, 44, 0.35 * fade);
      ctx.globalAlpha = (0.6 + Math.sin(this.time * 14) * 0.25) * fade;
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 32, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    ctx.rotate(s.angle);
    if (blink) ctx.globalAlpha = 0.35;
    // Engine plume scales with thrust
    if (s.flame > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const len = 10 + 30 * s.flame * (0.8 + Math.random() * 0.4);
      for (const ny of [-3, 3]) {
        const fl = ctx.createLinearGradient(-16, 0, -16 - len, 0);
        fl.addColorStop(0, '#fff7d6');
        fl.addColorStop(0.3, '#ffb347');
        fl.addColorStop(0.7, rgba(s.color, 0.6));
        fl.addColorStop(1, rgba(s.color, 0));
        ctx.fillStyle = fl;
        ctx.beginPath();
        ctx.moveTo(-16, ny - 3);
        ctx.quadraticCurveTo(-16 - len * 0.4, ny, -16 - len, ny);
        ctx.quadraticCurveTo(-16 - len * 0.4, ny, -16, ny + 3);
        ctx.fill();
      }
      drawGlow(ctx, '#ffb347', -18, 0, 14 + 10 * s.flame, 0.7 * s.flame);
      ctx.restore();
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, s.color, 0, 0, 34, blink ? 0.08 : 0.2);
    ctx.restore();
    ctx.globalAlpha = blink ? 0.35 : 1;
    ctx.drawImage(s.sprite, -36, -36);
    if (s.muzzle > 0) {
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, s.color, 28, 0, 16, 1);
    }
    ctx.restore();
    text(ctx, s.name, s.x, s.y - 36, { size: 12, font: 'Inter', weight: 800, color: '#fff', alpha: blink ? 0.4 : 0.9 });
    if (s.mult > 1) text(ctx, `x${s.mult}`, s.x + 30, s.y - 22, { size: 14, color: '#ffd166', glow: 8 });
  }

  drawWreck(ctx, s) {
    const w = s.wreck;
    ctx.save();
    ctx.translate(w.x, w.y);
    // Revive ring: progress in the player's colour, time left as a faint outer arc
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, TAU);
    ctx.stroke();
    if (s.revive > 0) {
      ctx.strokeStyle = '#5eead4';
      ctx.beginPath();
      ctx.arc(0, 0, 34, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, s.revive));
      ctx.stroke();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(s.color, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, 42, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, s.downT / DOWN_TIME));
    ctx.stroke();
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = 'rgba(94,234,212,0.25)';
    ctx.beginPath();
    ctx.arc(0, 0, REVIVE_R, this.time, this.time + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.rotate(w.rot);
    ctx.globalAlpha = 0.45 + Math.sin(this.time * 8) * 0.15;
    ctx.drawImage(s.sprite, -36, -36);
    ctx.restore();
    // Tethers from rescuers
    if (s.helpers.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(94,234,212,0.6)';
      ctx.lineWidth = 2 + Math.sin(this.time * 30);
      for (const h of s.helpers) {
        ctx.beginPath();
        ctx.moveTo(h.x, h.y);
        ctx.lineTo(w.x, w.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const others = this.ships.some((o) => o.alive);
    text(ctx, others ? 'FLY CLOSE TO REVIVE' : s.name, w.x, w.y - 54, { size: 12, font: 'Inter', weight: 800, color: '#5eead4', alpha: 0.6 + Math.sin(this.time * 6) * 0.3 });
  }

  drawRock(ctx, a) {
    const set = rockSprites()[a.size][a.variant];
    const step = TAU / ROCK_FRAMES;
    const rot = ((a.rot % TAU) + TAU) % TAU;
    const i = Math.round(rot / step) % ROCK_FRAMES;
    const h = set.S / 2;
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(rot - i * step); // residual twist only; the light stays put
    ctx.drawImage(set.frames[i], -h, -h);
    if (a.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7;
      ctx.drawImage(set.frames[i], -h, -h);
    }
    ctx.restore();
  }

  drawDebris(ctx) {
    for (const d of this.debris) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, d.life / 0.4);
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.fillStyle = d.color;
      ctx.beginPath();
      d.pts.forEach(([a, k], i) => (i ? ctx.lineTo(Math.cos(a) * d.size * k, Math.sin(a) * d.size * k) : ctx.moveTo(Math.cos(a) * d.size * k, Math.sin(a) * d.size * k)));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,180,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawEnemy(ctx, e) {
    const spr = enemySprites()[e.type];
    const col = ENEMY[e.type].color;
    const rot = e.type === 'drone' ? e.t * 2 : e.type === 'sniper' ? e.aim : e.angle;

    // Sniper targeting laser while charging
    if (e.type === 'sniper' && e.fireCd < 1.1 && this.state === 'play') {
      const locked = e.fireCd < 0.3;
      ctx.save();
      ctx.globalAlpha = locked ? (Math.floor(this.time * 30) % 2 ? 0.9 : 0.4) : 0.15 + (1.1 - e.fireCd) * 0.4;
      ctx.strokeStyle = locked ? '#ffffff' : '#ef4444';
      ctx.lineWidth = locked ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + Math.cos(e.aim) * 1800, e.y + Math.sin(e.aim) * 1800);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const warn = e.type === 'kamikaze' && e.mode === 'lock';
    drawGlow(ctx, col, 0, 0, warn ? 40 + Math.sin(this.time * 40) * 8 : 28, warn ? 0.8 : 0.3);
    ctx.restore();
    ctx.rotate(rot);
    ctx.drawImage(spr, -32, -32);
    if (e.flash > 0 || (warn && Math.floor(this.time * 20) % 2)) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(spr, -32, -32);
      ctx.drawImage(spr, -32, -32);
    }
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, col, 0, 0, 8 + Math.sin(this.time * 10) * 2, 1);
    if (e.type === 'shield') {
      // Front energy shield
      ctx.globalAlpha = e.shieldHit > 0 ? 1 : 0.6 + Math.sin(this.time * 8) * 0.15;
      ctx.strokeStyle = e.shieldHit > 0 ? '#ffffff' : '#7dd3fc';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, e.r + 8, -1.2, 1.2);
      ctx.stroke();
      ctx.globalAlpha *= 0.35;
      ctx.lineWidth = 10;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBoss(ctx, b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.dying > 0) ctx.translate(rand(-4, 4), rand(-4, 4));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#c026d3', 0, 10, 190, 0.35);
    ctx.restore();
    ctx.drawImage(this.bossArt, -150, -75);
    if (b.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this.bossArt, -150, -75);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    // Running lights
    for (let k = -4; k <= 4; k++) {
      ctx.fillStyle = Math.floor(this.time * 6 + k) % 3 === 0 ? '#ffd166' : '#ff3fa4';
      ctx.beginPath();
      ctx.arc(k * 24, 12, 4, 0, TAU);
      ctx.fill();
    }
    // Turrets
    for (const t of b.turrets) {
      ctx.save();
      ctx.translate(t.ox, t.oy);
      if (t.dead) {
        ctx.fillStyle = '#140a1f';
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, TAU);
        ctx.fill();
        ctx.fillStyle = Math.random() < 0.5 ? '#ff9f43' : '#ff3b5c';
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(rand(-3, 3), rand(-3, 3), 3, 0, TAU);
        ctx.fill();
      } else {
        ctx.save();
        ctx.rotate(t.angle);
        ctx.fillStyle = '#2a1840';
        ctx.fillRect(0, -3.5, 24, 7);
        ctx.fillStyle = '#ff8fd8';
        ctx.fillRect(20, -3.5, 4, 7);
        ctx.restore();
        const g = ctx.createRadialGradient(-5, -6, 1, 0, 0, 15);
        g.addColorStop(0, t.flash > 0 ? '#ffffff' : '#c4b5fd');
        g.addColorStop(1, '#2e1065');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = '#ff8fd8';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Turret health arc
        ctx.strokeStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(0, 0, 19, -Math.PI / 2, -Math.PI / 2 + TAU * (t.hp / t.max));
        ctx.stroke();
      }
      ctx.restore();
    }
    // Core and shield bubble
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 1 + Math.sin(this.time * (b.phase * 4)) * 0.15;
    drawGlow(ctx, b.phase === 3 ? '#a855f7' : '#ff3b5c', 0, 30, 34 * pulse, 1);
    if (b.turrets.some((t) => !t.dead) && !b.dying) {
      ctx.globalAlpha = b.shieldHit > 0 ? 0.9 : 0.25 + Math.sin(this.time * 3) * 0.08;
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = b.shieldHit > 0 ? 5 : 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, 150, 66, 0, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawCrystal(ctx, c) {
    const blink = c.life < 2 && Math.floor(c.t * 10) % 2 === 0;
    if (blink) return;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#5eead4', 0, 0, 20, 0.6);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(c.t * 2);
    // Two-tone facets read as a cut gem
    ctx.fillStyle = '#99f6e4';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 0);
    ctx.lineTo(0, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#14b8a6';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(-7, 0);
    ctx.lineTo(0, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawPod(ctx, p) {
    if (p.life < 2.5 && Math.floor(p.t * 10) % 2 === 0) return;
    const w = WEAPONS[p.kind];
    const bob = Math.sin(p.t * 4) * 3;
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, w.color, 0, 0, 34, 0.7);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(p.t * 1.5);
    ctx.fillStyle = 'rgba(15,10,35,0.85)';
    ctx.strokeStyle = w.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) ctx.lineTo(Math.cos((k / 6) * TAU) * 15, Math.sin((k / 6) * TAU) * 15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    text(ctx, w.label, p.x, p.y + bob + 1, { size: 16, color: w.color });
  }

  drawHud(ctx) {
    // Lives
    text(ctx, 'LIVES', 28, 30, { size: 14, align: 'left', color: '#c4bdf5' });
    for (let k = 0; k < Math.min(this.lives, 12); k++) {
      ctx.save();
      ctx.translate(100 + k * 24, 30);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-7, -7);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-7, 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Crystal bank toward the next life
    text(ctx, 'CRYSTALS', 28, 56, { size: 11, font: 'Inter', weight: 800, align: 'left', color: '#5eead4' });
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(96, 52, 120, 8);
    ctx.fillStyle = '#5eead4';
    ctx.fillRect(96, 52, (120 * this.bank) / BANK_LIFE, 8);
    text(ctx, '+1', 226, 56, { size: 11, font: 'Inter', weight: 800, align: 'left', color: '#5eead4', alpha: 0.7 });

    text(ctx, `WAVE ${this.wave}`, W / 2, 30, { size: 24, color: '#fff', glow: 10 });
    text(ctx, String(this.teamScore).padStart(6, '0'), W - 28, 30, { size: 26, align: 'right', color: '#ffd166', glow: 10 });

    // Per-player status
    const n = this.ships.length;
    this.ships.forEach((s, i) => {
      const x = W / 2 + (i - (n - 1) / 2) * 220;
      ctx.globalAlpha = s.alive ? 1 : 0.5;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x - 74, 70, 6, 0, TAU);
      ctx.fill();
      text(ctx, `${s.name}  ${s.score}`, x - 62, 70, { size: 14, font: 'Inter', weight: 800, align: 'left' });
      if (s.mult > 1) text(ctx, `x${s.mult}`, x + 90, 70, { size: 14, align: 'left', color: '#ffd166' });
      if (s.down) text(ctx, `DOWN · ${Math.ceil(s.downT)}s`, x - 62, 88, { size: 11, font: 'Inter', weight: 700, align: 'left', color: '#5eead4' });
      else if (s.out) text(ctx, 'out', x - 62, 88, { size: 11, font: 'Inter', weight: 600, align: 'left', color: '#ff8fa3' });
      else if (s.weapon) {
        const wpn = WEAPONS[s.weapon];
        text(ctx, wpn.name, x - 62, 88, { size: 11, font: 'Inter', weight: 800, align: 'left', color: wpn.color });
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(x + 8, 85, 70, 5);
        ctx.fillStyle = wpn.color;
        ctx.fillRect(x + 8, 85, (70 * s.weaponT) / WEAPON_TIME, 5);
      }
      // Shield cooldown pip
      const ready = s.shieldCd <= 0;
      ctx.strokeStyle = ready ? '#22d3ee' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x - 74, 70, 11, -Math.PI / 2, -Math.PI / 2 + TAU * (ready ? 1 : 1 - s.shieldCd / 8));
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    if (this.boss) {
      const b = this.boss;
      const w = 520;
      ctx.fillStyle = 'rgba(10,6,24,0.8)';
      ctx.fillRect(W / 2 - w / 2, 106, w, 12);
      ctx.fillStyle = b.turrets.some((t) => !t.dead) ? '#7c5fa8' : '#ff5fc8';
      ctx.fillRect(W / 2 - w / 2, 106, (w * Math.max(0, b.hp)) / b.max, 12);
      // Phase notches
      ctx.fillStyle = '#fff';
      for (const f of [0.33, 0.66]) ctx.fillRect(W / 2 - w / 2 + w * f - 1, 104, 2, 16);
      const left = b.turrets.filter((t) => !t.dead).length;
      text(ctx, `MOTHERSHIP · PHASE ${b.phase}${left ? ` · ${left} TURRETS SHIELDING CORE` : ' · CORE EXPOSED'}`, W / 2, 132, { size: 13, font: 'Inter', weight: 800, color: '#ff8fd8' });
    }
  }
}

export default {
  id: 'galaxy-quest',
  title: 'Galaxy Quest',
  art: 'space',
  genre: 'Space',
  accent: '#4d7cff',
  tagline: 'Fly together, blast asteroids and alien drones, and survive wave after wave.',
  minPlayers: 1,
  maxPlayers: 4,
  cpu: false,
  controls: { move: 'Point to fly', a: 'Fire', b: 'Shield blast' },
  howTo: [
    'Push the stick in any direction — your ship turns and thrusts that way, and keeps drifting with real momentum.',
    'Hold A to fire. Big asteroids split, collide and carry their momentum — shots knock small ones around.',
    'Grab S / M / L pods for a spread shot, homing missiles or a piercing laser beam. Chain kills for up to x5 score.',
    'B fires a shield blast (8s cooldown). Shielded drones block shots from the front, so flank them.',
    'A downed teammate drifts as a wreck — fly close to revive them for free. Every 15 crystals earns the team a life.',
    'Every 5th wave a mothership attacks: destroy its turrets to drop the core shield, and beware its gravity well.',
  ],
  create: (opts) => new GalaxyQuest(opts),
};
