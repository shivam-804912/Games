import { glassPanel, glowSprite, hexToRgb, meter, rgba, shade } from './engine/fx.js';
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
const SUN_ANGLE = Math.atan2(LIGHT.y, LIGHT.x); // direction toward the sun
const SUN = { x: -180, y: -240 }; // off-screen sun position, for the wash and lens flare
const ROCK_RES = 1.5; // rock frames are baked above 1x so they stay crisp on big screens
const HULL_RES = 2; // ships, enemies and the mothership are baked at 2x
const STAR_TINTS = ['#9db4ff', '#b5c7ff', '#dfe6ff', '#fff8f0', '#fff8f0', '#ffeeda', '#ffd9a8', '#ffc078'];
// Lens ghosts along the sun→centre axis: [position along axis, radius, colour, alpha]
const FLARE = [
  [0.55, 70, '#ffb070', 0.05],
  [0.9, 24, '#7c9cff', 0.08],
  [1.3, 100, '#c084fc', 0.03],
  [1.75, 40, '#5eead4', 0.05],
];
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

// Post pass tuning: generous bloom for engines and fire, indigo shadows, warm starlight.
const POST = {
  bloom: 0.8,
  threshold: 0.56,
  knee: 0.3,
  exposure: 1.04,
  contrast: 1.08,
  saturation: 1.12,
  shoulder: 0.74,
  vignette: 0.4,
  aberration: 0.0014,
  grain: 0.035,
  shadows: [0.012, 0.0, 0.075],
  highlights: [0.07, 0.035, -0.025],
};

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

/* ------------------------------------------------------------ Drawing helpers */
// Fast additive glow (caller sets 'lighter'); no save/restore so it is cheap in tight loops.
function drawGlow(ctx, color, x, y, r, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(color, 64, 0.18), x - r, y - r, r * 2, r * 2);
}

// Small soft dot used for particles, sparks and motes.
const dotCache = new Map();
function dotSprite(color) {
  let c = dotCache.get(color);
  if (!c) {
    c = glowSprite(color, 32, 0.3);
    dotCache.set(color, c);
  }
  return c;
}

// Add a closed polygon as one sub-path, optionally offset.
function poly(g, pts, ox = 0, oy = 0) {
  pts.forEach(([x, y], i) => (i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy)));
  g.closePath();
}

const circlePath = (x, y, r) => (g, ox = 0, oy = 0) => {
  g.moveTo(x + ox + r, y + oy);
  g.arc(x + ox, y + oy, r, 0, TAU);
};

const ellipsePath = (x, y, rx, ry) => (g, ox = 0, oy = 0) => {
  g.moveTo(x + ox + rx, y + oy);
  g.ellipse(x + ox, y + oy, rx, ry, 0, 0, TAU);
};

/*
 * Fill the part of a shape that is not covered by itself shifted by (dx, dy):
 * a crescent on the edge facing away from the shift. Used for rim lights,
 * crater walls and atmosphere limbs. `path(g, ox, oy)` adds one simple sub-path.
 */
function crescent(g, path, dx, dy, fill) {
  g.save();
  g.beginPath();
  path(g, 0, 0);
  g.clip();
  g.beginPath();
  path(g, 0, 0);
  path(g, dx, dy);
  g.fillStyle = fill;
  g.fill('evenodd');
  g.restore();
}

// Value-noise fbm, only used while baking textures (never per frame).
function makeNoise() {
  const p = new Uint8Array(512);
  const v = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
    v[i] = Math.random();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  const at = (x, y) => v[p[p[x & 255] + (y & 255)]];
  const n2 = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const w = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
  return (x, y, oct = 4) => {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      s += n2(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return s / norm;
  };
}

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------ Pre-rendered art */
const NEBULA_RAMP = [
  [96, 40, 210],
  [176, 30, 120],
  [40, 70, 210],
  [16, 120, 150],
];

/*
 * Far backdrop: deep-space gradient, volumetric nebula clouds (fbm density
 * baked at low res, colourised and upscaled smooth), dark dust lanes,
 * glowing star-forming knots and a dense field of faint far stars.
 */
function buildNebula() {
  const M = 60;
  const cw = W + M * 2;
  const ch = H + M * 2;
  const c = makeCanvas(cw, ch);
  const g = c.getContext('2d');
  const bg = g.createRadialGradient(cw * 0.3, ch * 0.28, 40, cw * 0.5, ch * 0.5, 1150);
  bg.addColorStop(0, '#170d3a');
  bg.addColorStop(0.55, '#0a0722');
  bg.addColorStop(1, '#030209');
  g.fillStyle = bg;
  g.fillRect(0, 0, cw, ch);

  const lw = 288;
  const lh = 170;
  const low = makeCanvas(lw, lh);
  const lg = low.getContext('2d');
  const img = lg.createImageData(lw, lh);
  const dens = makeNoise();
  const fil = makeNoise();
  const dust = makeNoise();
  const hue = makeNoise();
  const slope = rand(-0.7, -0.4); // the cloud band runs bottom-left to top-right
  const off = rand(-0.08, 0.08);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const u = x / lw;
      const v = y / lh;
      const arm = Math.abs(v - 0.5 - (u - 0.5) * slope - off);
      const mask = clamp(1 - arm * 2.4, 0, 1);
      let d = smooth(0.4, 0.74, dens(u * 4.2, v * 2.6, 5)) * (0.25 + 0.75 * mask);
      const ridge = 1 - Math.abs(fil(u * 6 + 11, v * 3.6 + 7, 4) * 2 - 1); // filaments
      d *= 0.55 + ridge * 0.7;
      d *= 1 - smooth(0.52, 0.7, dust(u * 7 + 31, v * 4.5 + 5, 4)) * 0.85; // dust lanes
      const t = clamp((hue(u * 2, v * 1.4, 3) - 0.3) / 0.4, 0, 0.999) * (NEBULA_RAMP.length - 1);
      const i = Math.floor(t);
      const f = t - i;
      const a = NEBULA_RAMP[i];
      const b = NEBULA_RAMP[i + 1];
      const k = (y * lw + x) * 4;
      const br = d * d * 0.62 + d * 0.12;
      img.data[k] = (a[0] + (b[0] - a[0]) * f) * br;
      img.data[k + 1] = (a[1] + (b[1] - a[1]) * f) * br;
      img.data[k + 2] = (a[2] + (b[2] - a[2]) * f) * br;
      img.data[k + 3] = 255;
    }
  }
  lg.putImageData(img, 0, 0);
  // Upscale in two steps so the bilinear filter stays smooth
  const mid = makeCanvas(lw * 3, lh * 3);
  const mg = mid.getContext('2d');
  mg.imageSmoothingQuality = 'high';
  mg.drawImage(low, 0, 0, mid.width, mid.height);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.imageSmoothingQuality = 'high';
  g.drawImage(mid, 0, 0, cw, ch);
  // Star-forming knots: hot cores inside the brightest clouds
  for (let k = 0; k < 7; k++) {
    const u = rand(0.1, 0.9);
    const x = u * cw;
    const y = (0.5 + (u - 0.5) * slope + off + rand(-0.12, 0.12)) * ch;
    const r = rand(40, 120);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const col = Math.random() < 0.5 ? '255,140,210' : '140,180,255';
    gr.addColorStop(0, `rgba(${col},0.22)`);
    gr.addColorStop(0.3, `rgba(${col},0.08)`);
    gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
  // Far stars, too distant to parallax much, in a spread of colour temperatures
  for (let k = 0; k < 1100; k++) {
    g.globalAlpha = 0.12 + Math.random() ** 2 * 0.6;
    g.fillStyle = STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)];
    const s = Math.random() < 0.08 ? 1.5 : 1;
    g.fillRect(Math.random() * cw, Math.random() * ch, s, s);
  }
  g.globalAlpha = 1;
  return c;
}

// Off-screen sun (up-left, matching LIGHT): warm wash and soft god-rays, drawn additively.
function buildSunWash() {
  const s = 0.25; // smooth gradients survive a 4x upscale untouched
  const c = makeCanvas(W * s, H * s);
  const g = c.getContext('2d');
  g.scale(s, s);
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 8; k++) {
    const a = rand(0.25, 1.3);
    const w = rand(0.015, 0.05);
    const len = rand(1300, 2000);
    const gr = g.createRadialGradient(SUN.x, SUN.y, 0, SUN.x, SUN.y, len);
    gr.addColorStop(0, 'rgba(255,214,160,0.09)');
    gr.addColorStop(0.5, 'rgba(255,190,150,0.03)');
    gr.addColorStop(1, 'rgba(255,190,150,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(SUN.x, SUN.y);
    g.arc(SUN.x, SUN.y, len, a - w, a + w);
    g.closePath();
    g.fill();
  }
  const wash = g.createRadialGradient(SUN.x, SUN.y, 0, SUN.x, SUN.y, 1250);
  wash.addColorStop(0, 'rgba(255,226,180,0.6)');
  wash.addColorStop(0.22, 'rgba(255,170,110,0.2)');
  wash.addColorStop(0.55, 'rgba(140,90,200,0.06)');
  wash.addColorStop(1, 'rgba(80,60,160,0)');
  g.fillStyle = wash;
  g.fillRect(0, 0, W, H);
  return c;
}

// A tiling star layer; brighter stars get a soft halo, the brightest diffraction spikes.
function buildStars(count, rMin, rMax, aMin, aMax, glare) {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  for (let k = 0; k < count; k++) {
    const x = rand(W);
    const y = rand(H);
    const r = rMin + (rMax - rMin) * Math.random() ** 2;
    const a = rand(aMin, aMax);
    const tint = STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)];
    if (r > rMax * 0.55) {
      g.globalAlpha = a * 0.4;
      g.drawImage(glowSprite(tint, 32, 0.2), x - r * 5, y - r * 5, r * 10, r * 10);
    }
    g.globalAlpha = a;
    g.fillStyle = tint;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    if (glare && r > rMax * 0.78) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const L = r * 9;
        const gr = g.createLinearGradient(x - dx * L, y - dy * L, x + dx * L, y + dy * L);
        gr.addColorStop(0, rgba(tint, 0));
        gr.addColorStop(0.5, rgba(tint, 0.55 * a));
        gr.addColorStop(1, rgba(tint, 0));
        g.globalAlpha = 1;
        g.fillStyle = gr;
        g.fillRect(x - dx * L - dy * 0.5, y - dy * L - dx * 0.5, dx * L * 2 + dy, dy * L * 2 + dx);
      }
    }
  }
  g.globalAlpha = 1;
  return c;
}

// Gas giant baked once at 2x: turbulent bands, terminator, ring shadows and a scattering limb.
let planetCache = null;
function buildPlanet() {
  if (planetCache) return planetCache;
  const S = 2;
  const PW = 440;
  const PH = 320;
  const c = makeCanvas(PW * S, PH * S);
  const g = c.getContext('2d');
  g.scale(S, S);
  const cx = 220;
  const cy = 160;
  const R = 96;
  const TILT = -0.28;
  const lx = LIGHT.x;
  const ly = LIGHT.y;
  const bands = [
    [196, 41, 4, 0.16, '#e9d3b5'],
    [188, 39.4, 7, 0.3, '#ffe1bd'],
    [178.5, 37.6, 4, 0.5, '#f3c79a'],
    [171, 36, 2.5, 0.2, '#c79a77'],
    [163, 34.2, 6, 0.42, '#ffd9b0'],
    [154, 32.4, 3, 0.2, '#b98a6a'],
  ];
  // Each ring half gets its own layer so shadow can be cut into the bands only
  const ring = (from, to) => {
    const rc = makeCanvas(PW * S, PH * S);
    const rg = rc.getContext('2d');
    rg.setTransform(S, 0, 0, S, cx * S, cy * S);
    rg.rotate(TILT);
    for (const [rx, ry, w, a, col] of bands) {
      rg.strokeStyle = rgba(col, a);
      rg.lineWidth = w;
      rg.beginPath();
      rg.ellipse(0, 0, rx, ry, 0, from, to);
      rg.stroke();
    }
    if (from === Math.PI) {
      // The planet's shadow falls across the far rings on the side away from the sun
      rg.globalCompositeOperation = 'source-atop';
      const sh = rg.createLinearGradient(R * 0.3, 0, R * 1.8, 0);
      sh.addColorStop(0, 'rgba(3,2,8,0.92)');
      sh.addColorStop(0.55, 'rgba(3,2,8,0.8)');
      sh.addColorStop(1, 'rgba(3,2,8,0)');
      rg.fillStyle = sh;
      rg.fillRect(R * 0.3, -60, R * 1.5, 60);
    }
    g.drawImage(rc, 0, 0, PW, PH);
  };
  ring(Math.PI, TAU);

  // Cool scattering haze just outside the sunlit limb
  const hc = makeCanvas(PW * S, PH * S);
  const hg = hc.getContext('2d');
  hg.scale(S, S);
  const haze = hg.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.22);
  haze.addColorStop(0, 'rgba(170,190,255,0.42)');
  haze.addColorStop(0.35, 'rgba(150,160,255,0.14)');
  haze.addColorStop(1, 'rgba(120,130,255,0)');
  hg.fillStyle = haze;
  hg.beginPath();
  hg.arc(cx, cy, R * 1.22, 0, TAU);
  hg.fill();
  hg.globalCompositeOperation = 'destination-in';
  const side = hg.createLinearGradient(cx + lx * R, cy + ly * R, cx - lx * R, cy - ly * R);
  side.addColorStop(0, 'rgba(0,0,0,1)');
  side.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  side.addColorStop(1, 'rgba(0,0,0,0.04)');
  hg.fillStyle = side;
  hg.fillRect(0, 0, PW, PH);
  g.drawImage(hc, 0, 0, PW, PH);

  // Body texture: turbulent latitude bands, sampled in the ring's tilted frame
  const tw = R * 2 * S;
  const tex = makeCanvas(tw, tw);
  const tg = tex.getContext('2d');
  const img = tg.createImageData(tw, tw);
  const turb = makeNoise();
  const cosT = Math.cos(-TILT);
  const sinT = Math.sin(-TILT);
  const PAL = [
    [248, 220, 176],
    [228, 140, 74],
    [178, 78, 36],
    [112, 42, 20],
    [238, 186, 124],
  ];
  for (let py = 0; py < tw; py++) {
    for (let px = 0; px < tw; px++) {
      const x = (px + 0.5) / S - R;
      const y = (py + 0.5) / S - R;
      if (x * x + y * y > (R + 1) * (R + 1)) continue;
      const ux = x * cosT - y * sinT;
      const uy = x * sinT + y * cosT;
      const lat = Math.asin(clamp(uy / R, -1, 1)); // bands bunch up toward the poles
      const lon = ux / R;
      const w = turb(lon * 3 + 5, lat * 9, 4);
      const b = lat * 5.2 + (w - 0.5) * 2.4;
      const t = (Math.sin(b * 2.3) * 0.5 + 0.5) * 0.65 + (Math.sin(b * 6.1 + 1.3) * 0.5 + 0.5) * 0.35;
      const ft = clamp(t, 0, 0.999) * (PAL.length - 1);
      const i = Math.floor(ft);
      const f = ft - i;
      const grit = 0.9 + turb(lon * 14 + 40, lat * 30, 2) * 0.2;
      const k = (py * tw + px) * 4;
      img.data[k] = (PAL[i][0] + (PAL[i + 1][0] - PAL[i][0]) * f) * grit;
      img.data[k + 1] = (PAL[i][1] + (PAL[i + 1][1] - PAL[i][1]) * f) * grit;
      img.data[k + 2] = (PAL[i][2] + (PAL[i + 1][2] - PAL[i][2]) * f) * grit;
      img.data[k + 3] = 255;
    }
  }
  tg.putImageData(img, 0, 0);

  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.clip();
  g.drawImage(tex, cx - R, cy - R, R * 2, R * 2);
  // The near rings cast their bands across the face, offset away from the sun
  g.save();
  g.translate(cx - lx * 10, cy - ly * 10);
  g.rotate(TILT);
  for (const [rx, ry, w, a] of bands) {
    g.strokeStyle = `rgba(12,4,2,${a * 0.9})`;
    g.lineWidth = w * 1.3;
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, Math.PI);
    g.stroke();
  }
  g.restore();
  // Limb darkening
  const limb = g.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(1, 'rgba(20,6,2,0.55)');
  g.fillStyle = limb;
  g.fillRect(cx - R, cy - R, R * 2, R * 2);
  // Terminator: day side toward the sun, night side falls off fast
  const tx0 = cx + lx * R;
  const ty0 = cy + ly * R;
  const tx1 = cx - lx * R;
  const ty1 = cy - ly * R;
  const term = g.createLinearGradient(tx0, ty0, tx1, ty1);
  term.addColorStop(0, 'rgba(0,0,0,0)');
  term.addColorStop(0.4, 'rgba(0,0,0,0.04)');
  term.addColorStop(0.58, 'rgba(10,4,16,0.62)');
  term.addColorStop(0.74, 'rgba(4,2,10,0.92)');
  term.addColorStop(1, 'rgba(2,1,6,0.97)');
  g.fillStyle = term;
  g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.globalCompositeOperation = 'lighter';
  // Scattering where day meets night, plus the bright sub-solar cap
  const scat = g.createLinearGradient(tx0, ty0, tx1, ty1);
  scat.addColorStop(0.42, 'rgba(255,80,40,0)');
  scat.addColorStop(0.53, 'rgba(255,80,40,0.14)');
  scat.addColorStop(0.64, 'rgba(255,80,40,0)');
  g.fillStyle = scat;
  g.fillRect(cx - R, cy - R, R * 2, R * 2);
  const cap = g.createRadialGradient(cx + lx * R * 0.5, cy + ly * R * 0.5, 0, cx + lx * R * 0.5, cy + ly * R * 0.5, R * 0.8);
  cap.addColorStop(0, 'rgba(255,236,210,0.28)');
  cap.addColorStop(1, 'rgba(255,236,210,0)');
  g.fillStyle = cap;
  g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();
  // Atmospheric limb: thin bright fresnel rim on the sunlit edge
  const body = circlePath(cx, cy, R);
  crescent(g, body, -lx * 3, -ly * 3, 'rgba(255,232,200,0.8)');
  crescent(g, body, -lx * 9, -ly * 9, 'rgba(255,200,150,0.18)');
  ring(0, Math.PI);
  planetCache = c;
  return c;
}

/*
 * One rock shape rendered at ROCK_FRAMES rotations with a fixed sun direction:
 * warm sunlit face, cool bounce light in the shadow, craters, cracks and a
 * crisp rim light. Baked at ROCK_RES for sharp edges.
 */
function buildRock(r) {
  const n = 14 + Math.floor(r / 8);
  const p1 = rand(TAU);
  const p2 = rand(TAU);
  const k1 = rand(0.05, 0.1);
  const k2 = rand(0.025, 0.05);
  const verts = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * TAU + rand(-0.07, 0.07);
    return [a, 0.86 + Math.sin(a * 2 + p1) * k1 + Math.sin(a * 5 + p2) * k2 + rand(-0.05, 0.04)];
  });
  const craters = Array.from({ length: 2 + Math.floor(r / 14) }, () => [rand(TAU), rand(0, 0.6), rand(0.1, 0.24)]);
  const blotches = Array.from({ length: Math.floor(r * 0.6) }, () => [rand(TAU), rand(0, 0.9), rand(0.04, 0.16), Math.random() < 0.45]);
  const specks = Array.from({ length: Math.floor(r * 1.2) }, () => [rand(TAU), rand(0, 0.9), Math.random() < 0.5]);
  const cracks = Array.from({ length: r > 30 ? 2 : 1 }, () => {
    let x = rand(-0.4, 0.4) * r;
    let y = rand(-0.4, 0.4) * r;
    let a = rand(TAU);
    const pts = [];
    for (let k = 0; k < 5; k++) {
      pts.push([x, y]);
      a += rand(-0.6, 0.6);
      x += Math.cos(a) * r * 0.16;
      y += Math.sin(a) * r * 0.16;
    }
    return pts;
  });
  const iron = Math.random() < 0.3;
  const hue = rand(-10, 10);
  const lit = iron ? `hsl(${22 + hue},30%,62%)` : `hsl(${30 + hue},14%,66%)`;
  const midTone = iron ? `hsl(${14 + hue},22%,34%)` : `hsl(${248 + hue},12%,36%)`;
  const dark = `hsl(${255 + hue},30%,8%)`;
  const S = Math.ceil(r * 2.3);
  const px = Math.ceil(S * ROCK_RES);
  const frames = [];
  for (let f = 0; f < ROCK_FRAMES; f++) {
    const th = (f / ROCK_FRAMES) * TAU;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const pol = (a, d) => [Math.cos(a + th) * d * r, Math.sin(a + th) * d * r];
    const c = makeCanvas(px, px);
    const g = c.getContext('2d');
    g.setTransform(ROCK_RES, 0, 0, ROCK_RES, px / 2, px / 2);
    const pts = verts.map(([a, k]) => pol(a, k));
    // Lumpy outline: quadratic curves through the edge midpoints
    const outline = (gg, ox = 0, oy = 0) => {
      const mid = (i) => {
        const p = pts[i % n];
        const q = pts[(i + 1) % n];
        return [(p[0] + q[0]) / 2 + ox, (p[1] + q[1]) / 2 + oy];
      };
      const s0 = mid(n - 1);
      gg.moveTo(s0[0], s0[1]);
      for (let i = 0; i < n; i++) {
        const e = mid(i);
        gg.quadraticCurveTo(pts[i][0] + ox, pts[i][1] + oy, e[0], e[1]);
      }
      gg.closePath();
    };
    g.beginPath();
    outline(g);
    const base = g.createRadialGradient(LIGHT.x * r * 0.5, LIGHT.y * r * 0.5, r * 0.05, 0, 0, r * 1.15);
    base.addColorStop(0, lit);
    base.addColorStop(0.4, midTone);
    base.addColorStop(1, dark);
    g.fillStyle = base;
    g.fill();
    g.save();
    g.clip();
    for (const [a, d, s, light] of blotches) {
      const [x, y] = pol(a, d);
      g.fillStyle = light ? 'rgba(255,240,225,0.06)' : 'rgba(10,6,24,0.14)';
      g.beginPath();
      g.arc(x, y, s * r, 0, TAU);
      g.fill();
    }
    for (const [a, d, light] of specks) {
      const [x, y] = pol(a, d);
      g.fillStyle = light ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.22)';
      g.fillRect(x, y, 1.2, 1.2);
    }
    // Craters: dark bowl, the sun-side inner wall in shadow, the far wall catching light
    for (const [a, d, s] of craters) {
      const [x, y] = pol(a, d);
      const cr = s * r;
      const bowl = circlePath(x, y, cr);
      g.fillStyle = 'rgba(16,10,30,0.3)';
      g.beginPath();
      bowl(g);
      g.fill();
      crescent(g, bowl, -LIGHT.x * cr * 0.45, -LIGHT.y * cr * 0.45, 'rgba(6,3,14,0.55)');
      crescent(g, bowl, LIGHT.x * cr * 0.3, LIGHT.y * cr * 0.3, 'rgba(255,236,214,0.22)');
    }
    // Cracks: dark fissure with a sunlit lip
    g.lineWidth = 0.9;
    g.lineJoin = 'round';
    for (const ck of cracks) {
      for (const [col, o] of [
        ['rgba(4,2,12,0.5)', 0],
        ['rgba(255,236,214,0.13)', 0.9],
      ]) {
        g.strokeStyle = col;
        g.beginPath();
        ck.forEach(([x, y], i) => {
          const qx = x * cs - y * sn - LIGHT.x * o;
          const qy = x * sn + y * cs - LIGHT.y * o;
          if (i) g.lineTo(qx, qy);
          else g.moveTo(qx, qy);
        });
        g.stroke();
      }
    }
    // Terminator: the night side falls off into deep shadow
    const term = g.createLinearGradient(LIGHT.x * r, LIGHT.y * r, -LIGHT.x * r, -LIGHT.y * r);
    term.addColorStop(0, 'rgba(0,0,0,0)');
    term.addColorStop(0.5, 'rgba(0,0,0,0.1)');
    term.addColorStop(1, 'rgba(3,2,10,0.78)');
    g.fillStyle = term;
    g.fillRect(-S / 2, -S / 2, S, S);
    g.restore();
    // Cool bounce light on the shadow edge, warm rim light on the sunny edge
    crescent(g, outline, LIGHT.x * 2.5, LIGHT.y * 2.5, 'rgba(120,110,255,0.22)');
    crescent(g, outline, -LIGHT.x * 1.6, -LIGHT.y * 1.6, 'rgba(255,238,214,0.75)');
    crescent(g, outline, -LIGHT.x * 5, -LIGHT.y * 5, 'rgba(255,214,180,0.16)');
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

/* ------------------------------------------------------------ Hulls */
const RIM_DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/*
 * Bake a rotating hull at HULL_RES: base paint (direction-neutral shading), an
 * additive emissive layer, a white silhouette for hit flashes and four rim-light
 * layers that drawHull blends by where the sun sits relative to the heading.
 * `outline(g, ox, oy)` adds the silhouette as one simple sub-path.
 */
function buildHull(size, outline, paint, emissive) {
  const px = size * HULL_RES;
  const layer = () => {
    const c = makeCanvas(px, px);
    const g = c.getContext('2d');
    g.setTransform(HULL_RES, 0, 0, HULL_RES, px / 2, px / 2);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    return [c, g];
  };
  const [base, bg] = layer();
  paint(bg);
  const [emis, eg] = layer();
  eg.globalCompositeOperation = 'lighter';
  emissive(eg);
  const [flash, fg] = layer();
  fg.beginPath();
  outline(fg, 0, 0);
  fg.fillStyle = '#fff';
  fg.fill();
  const rims = RIM_DIRS.map(([dx, dy]) => {
    const [c, g] = layer();
    crescent(g, outline, -dx * 1.5, -dy * 1.5, 'rgba(255,238,214,0.85)');
    crescent(g, outline, -dx * 4, -dy * 4, 'rgba(255,220,190,0.2)');
    return c;
  });
  return { base, emis, flash, rims, size };
}

// Draw a hull (ctx already rotated to `angle`); the rim light tracks the sun.
function drawHull(ctx, h, angle, alpha = 1) {
  const s = h.size;
  const o = -s / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(h.base, o, o, s, s);
  const rel = SUN_ANGLE - angle;
  const cx = Math.cos(rel);
  const cy = Math.sin(rel);
  ctx.globalAlpha = alpha * Math.abs(cx);
  ctx.drawImage(h.rims[cx > 0 ? 0 : 2], o, o, s, s);
  ctx.globalAlpha = alpha * Math.abs(cy);
  ctx.drawImage(h.rims[cy > 0 ? 1 : 3], o, o, s, s);
  ctx.globalAlpha = alpha;
}

// Machined panel joint: dark seam with a hairline highlight beside it.
function seam(g, pts, w = 0.7) {
  for (const [col, o] of [
    ['rgba(0,0,0,0.5)', 0],
    ['rgba(255,255,255,0.14)', 0.6],
  ]) {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y + o) : g.moveTo(x, y + o)));
    g.stroke();
  }
}

// Soft emissive dot (white core into `color`), for lights, eyes and nozzles.
function emitDot(g, x, y, r, color) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.3, color);
  gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

// Player ship silhouette, nose pointing +x: needle nose, swept wings, twin nacelles.
const SHIP_PTS = [
  [30, 0],
  [16, -3.2],
  [6, -5.5],
  [0, -8],
  [-8, -19],
  [-13, -23],
  [-17, -22],
  [-15, -12],
  [-18, -9.2],
  [-21.5, -8.6],
  [-21.5, -3.4],
  [-17, -2.5],
  [-17, 2.5],
  [-21.5, 3.4],
  [-21.5, 8.6],
  [-18, 9.2],
  [-15, 12],
  [-17, 22],
  [-13, 23],
  [-8, 19],
  [0, 8],
  [6, 5.5],
  [16, 3.2],
];

function buildShip(color) {
  const outline = (g, ox, oy) => poly(g, SHIP_PTS, ox, oy);
  const paint = (g) => {
    // Wings: gunmetal, shading toward the tips in the player's colour
    g.beginPath();
    outline(g, 0, 0);
    const wing = g.createLinearGradient(0, -23, 0, 23);
    wing.addColorStop(0, shade(color, -0.35));
    wing.addColorStop(0.2, '#3b4058');
    wing.addColorStop(0.5, '#646a8a');
    wing.addColorStop(0.8, '#3b4058');
    wing.addColorStop(1, shade(color, -0.35));
    g.fillStyle = wing;
    g.fill();
    for (const sy of [-1, 1]) {
      // Player-colour wing panel
      g.beginPath();
      poly(g, [
        [-1, sy * 9],
        [-9, sy * 19.5],
        [-13, sy * 22],
        [-12.5, sy * 15],
        [-6, sy * 10.5],
      ]);
      const pg = g.createLinearGradient(0, sy * 9, 0, sy * 22);
      pg.addColorStop(0, shade(color, 0.15));
      pg.addColorStop(1, shade(color, -0.45));
      g.fillStyle = pg;
      g.fill();
      seam(g, [
        [3, sy * 6.5],
        [-14, sy * 11],
      ]);
      seam(g, [
        [-5, sy * 11.5],
        [-11, sy * 20.5],
      ]);
      // Engine nacelle with a dark nozzle
      const ng = g.createLinearGradient(0, sy * 6 - 3, 0, sy * 6 + 3);
      ng.addColorStop(0, '#9aa0bd');
      ng.addColorStop(0.45, '#3a3e55');
      ng.addColorStop(1, '#14151f');
      g.fillStyle = ng;
      g.beginPath();
      g.roundRect(-21, sy * 6 - 2.8, 10, 5.6, 2);
      g.fill();
      g.fillStyle = '#07080d';
      g.beginPath();
      g.ellipse(-20.6, sy * 6, 1.2, 2.3, 0, 0, TAU);
      g.fill();
    }
    // Fuselage: polished hull with a hard specular spine
    g.beginPath();
    g.moveTo(30, 0);
    g.quadraticCurveTo(12, -6.8, -16, -5);
    g.lineTo(-18, -2.6);
    g.lineTo(-18, 2.6);
    g.lineTo(-16, 5);
    g.quadraticCurveTo(12, 6.8, 30, 0);
    const body = g.createLinearGradient(0, -6, 0, 6);
    body.addColorStop(0, '#262a3e');
    body.addColorStop(0.28, '#9ea6c6');
    body.addColorStop(0.46, '#f4f6ff');
    body.addColorStop(0.56, '#c3c9e2');
    body.addColorStop(0.8, '#454a69');
    body.addColorStop(1, '#171927');
    g.fillStyle = body;
    g.fill();
    seam(
      g,
      [
        [-2, -4.6],
        [-2, 4.6],
      ],
      0.6,
    );
    seam(
      g,
      [
        [-11, -4.8],
        [-11, 4.8],
      ],
      0.6,
    );
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(24, -0.4);
    g.lineTo(-8, -0.9);
    g.stroke();
    // Canopy: tinted glass reflecting a sky gradient with a sharp horizon
    const glass = g.createLinearGradient(0, -3.4, 0, 3.4);
    glass.addColorStop(0, '#c8f3ff');
    glass.addColorStop(0.4, '#3d8fc6');
    glass.addColorStop(0.5, '#0a2440');
    glass.addColorStop(1, '#04101e');
    g.fillStyle = glass;
    g.beginPath();
    g.ellipse(9.5, 0, 8, 3.3, 0, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 0.6;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(12.5, -1.3, 2.4, 0.7, -0.08, 0, TAU);
    g.fill();
  };
  const emissive = (g) => {
    // Wingtip strips and leading-edge stripes in the player's colour
    g.strokeStyle = color;
    for (const sy of [-1, 1]) {
      g.lineWidth = 1.6;
      g.globalAlpha = 1;
      g.beginPath();
      g.moveTo(-9.5, sy * 20);
      g.lineTo(-13.5, sy * 22.6);
      g.stroke();
      g.lineWidth = 0.9;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(0.5, sy * 8.6);
      g.lineTo(-8.5, sy * 19);
      g.stroke();
      g.globalAlpha = 1;
      emitDot(g, -20.6, sy * 6, 3.4, color); // nozzle core
    }
    // Faint cockpit instrument glow
    const ck = g.createRadialGradient(8, 0, 0, 8, 0, 4);
    ck.addColorStop(0, rgba(color, 0.45));
    ck.addColorStop(1, rgba(color, 0));
    g.fillStyle = ck;
    g.fillRect(4, -4, 8, 8);
  };
  return buildHull(72, outline, paint, emissive);
}

let enemyCache = null;
function enemySprites() {
  if (enemyCache) return enemyCache;
  // Dark gunmetal armour shared by every alien hull
  const armour = (g, outline) => {
    g.beginPath();
    outline(g, 0, 0);
    const gr = g.createRadialGradient(0, 0, 2, 0, 0, 25);
    gr.addColorStop(0, '#5a5478');
    gr.addColorStop(0.6, '#272139');
    gr.addColorStop(1, '#0e0b19');
    g.fillStyle = gr;
    g.fill();
  };
  const make = (pts, color, detail, lights) => {
    const outline = (g, ox, oy) => poly(g, pts, ox, oy);
    return buildHull(
      64,
      outline,
      (g) => {
        armour(g, outline);
        detail(g);
      },
      (g) => lights(g, color),
    );
  };

  // Drone: four bladed arms around an armoured hub with a red eye
  const drone = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU;
    for (const [da, r] of [
      [0, 22],
      [0.3, 12.5],
      [Math.PI / 4, 9.5],
      [Math.PI / 2 - 0.3, 12.5],
    ]) {
      drone.push([Math.cos(a + da) * r, Math.sin(a + da) * r]);
    }
  }
  // Kamikaze: barbed arrowhead with a glowing warhead
  const kamikaze = [
    [22, 0],
    [8, -4.5],
    [-2, -14],
    [-13, -16],
    [-8, -6],
    [-12, 0],
    [-8, 6],
    [-13, 16],
    [-2, 14],
    [8, 4.5],
  ];
  // Sniper: swept body with a long rail barrel
  const sniper = [
    [31, -1.8],
    [31, 1.8],
    [14, 2],
    [4, 9],
    [-15, 15],
    [-11, 4],
    [-13, 0],
    [-11, -4],
    [-15, -15],
    [4, -9],
    [14, -2],
  ];
  const shieldPts = Array.from({ length: 6 }, (_, k) => [Math.cos((k / 6) * TAU) * 22, Math.sin((k / 6) * TAU) * 22]);

  enemyCache = {
    drone: make(
      drone,
      ENEMY.drone.color,
      (g) => {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * TAU;
          seam(g, [
            [Math.cos(a) * 9, Math.sin(a) * 9],
            [Math.cos(a) * 20, Math.sin(a) * 20],
          ]);
        }
        const hub = g.createRadialGradient(-2, -2, 0, 0, 0, 9);
        hub.addColorStop(0, '#77709c');
        hub.addColorStop(1, '#18132b');
        g.fillStyle = hub;
        g.beginPath();
        g.arc(0, 0, 8.5, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.2)';
        g.lineWidth = 0.8;
        g.stroke();
        g.fillStyle = '#08060f';
        g.beginPath();
        g.arc(0, 0, 5, 0, TAU);
        g.fill();
      },
      (g, col) => {
        emitDot(g, 0, 0, 7, col);
        for (let k = 0; k < 4; k++) emitDot(g, Math.cos((k / 4) * TAU) * 18.5, Math.sin((k / 4) * TAU) * 18.5, 2.6, col);
      },
    ),
    kamikaze: make(
      kamikaze,
      ENEMY.kamikaze.color,
      (g) => {
        g.beginPath();
        poly(g, [
          [20, 0],
          [4, -2.6],
          [-9, 0],
          [4, 2.6],
        ]);
        const sp = g.createLinearGradient(0, -2.6, 0, 2.6);
        sp.addColorStop(0, '#a49dc6');
        sp.addColorStop(1, '#221c36');
        g.fillStyle = sp;
        g.fill();
        for (const sy of [-1, 1]) {
          seam(g, [
            [2, sy * 6],
            [-9, sy * 13],
          ]);
        }
      },
      (g, col) => {
        g.fillStyle = 'rgba(255,209,102,0.9)';
        g.beginPath();
        poly(g, [
          [17, 0],
          [7, -2.8],
          [7, 2.8],
        ]);
        g.fill();
        emitDot(g, 14, 0, 4, col);
        emitDot(g, -10, 0, 5, col);
        for (const sy of [-1, 1]) emitDot(g, -12, sy * 15, 2, col);
      },
    ),
    sniper: make(
      sniper,
      ENEMY.sniper.color,
      (g) => {
        const bar = g.createLinearGradient(0, -1.8, 0, 1.8);
        bar.addColorStop(0, '#9a98b0');
        bar.addColorStop(1, '#1d1b2a');
        g.fillStyle = bar;
        g.fillRect(10, -1.8, 21, 3.6);
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(16, -1.8, 1, 3.6);
        g.fillRect(22, -1.8, 1, 3.6);
        for (const sy of [-1, 1]) {
          seam(g, [
            [3, sy * 7],
            [-12, sy * 13],
          ]);
        }
      },
      (g, col) => {
        emitDot(g, 3, 0, 4.5, col);
        emitDot(g, 30.5, 0, 3, col);
        for (const sy of [-1, 1]) emitDot(g, -13, sy * 13, 2, col);
      },
    ),
    shield: make(
      shieldPts,
      ENEMY.shield.color,
      (g) => {
        const inner = Array.from({ length: 6 }, (_, k) => [Math.cos((k / 6) * TAU) * 14, Math.sin((k / 6) * TAU) * 14]);
        inner.forEach(([x, y], k) => seam(g, [[x, y], shieldPts[k]]));
        g.beginPath();
        poly(g, inner);
        const pl = g.createRadialGradient(-3, -3, 0, 0, 0, 15);
        pl.addColorStop(0, '#5a537c');
        pl.addColorStop(1, '#181429');
        g.fillStyle = pl;
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.16)';
        g.lineWidth = 0.8;
        g.stroke();
      },
      (g, col) => {
        emitDot(g, 0, 0, 8, col);
        for (let k = 0; k < 6; k++) {
          const a = ((k + 0.5) / 6) * TAU;
          emitDot(g, Math.cos(a) * 17, Math.sin(a) * 17, 1.8, col);
        }
      },
    ),
  };
  return enemyCache;
}

// Mothership, lit directly from the sun (it never rotates): hull plus an emissive layer.
function buildBoss() {
  const mk = () => {
    const c = makeCanvas(300 * HULL_RES, 150 * HULL_RES);
    const g = c.getContext('2d');
    g.setTransform(HULL_RES, 0, 0, HULL_RES, 150 * HULL_RES, 75 * HULL_RES);
    return [c, g];
  };
  const [hull, g] = mk();
  const shell = ellipsePath(0, 0, 128, 46);
  g.beginPath();
  shell(g);
  const body = g.createRadialGradient(-50, -34, 6, -10, 0, 150);
  body.addColorStop(0, '#e9ddff');
  body.addColorStop(0.18, '#9b7be0');
  body.addColorStop(0.45, '#4c1d95');
  body.addColorStop(0.75, '#1e0b45');
  body.addColorStop(1, '#07021a');
  g.fillStyle = body;
  g.fill();
  g.save();
  g.clip();
  // Armour plating: concentric bands and radial seams
  for (const [rx, ry] of [
    [104, 35],
    [78, 26],
  ]) {
    for (const [col, o] of [
      ['rgba(0,0,0,0.45)', 0],
      ['rgba(255,255,255,0.12)', 0.8],
    ]) {
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(0, 4 + o, rx, ry, 0, 0, TAU);
      g.stroke();
    }
  }
  for (let k = -5; k <= 5; k++) {
    seam(
      g,
      [
        [k * 15, 26],
        [k * 25, 48],
      ],
      0.9,
    );
  }
  // Belly armour band and vents
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath();
  g.ellipse(0, 26, 116, 22, 0, 0, Math.PI);
  g.fill();
  g.fillStyle = '#0b0518';
  for (let k = -4; k <= 4; k++) {
    g.beginPath();
    g.roundRect(k * 22 - 6, 36, 12, 3, 1.5);
    g.fill();
  }
  // Greebles on the upper hull
  for (let k = 0; k < 30; k++) {
    const x = rand(-100, 100);
    const y = rand(-36, 10);
    if ((x / 120) ** 2 + (y / 42) ** 2 > 1) continue;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.25)';
    g.fillRect(x, y, rand(4, 12), rand(2, 4));
  }
  const term = g.createLinearGradient(-60, -50, 60, 50);
  term.addColorStop(0, 'rgba(0,0,0,0)');
  term.addColorStop(0.5, 'rgba(0,0,0,0.12)');
  term.addColorStop(1, 'rgba(4,1,12,0.6)');
  g.fillStyle = term;
  g.fillRect(-130, -50, 260, 100);
  g.restore();
  // Sun rim on the upper-left edge, cool nebula bounce underneath
  crescent(g, shell, -LIGHT.x * 2, -LIGHT.y * 2, 'rgba(255,236,214,0.8)');
  crescent(g, shell, -LIGHT.x * 6, -LIGHT.y * 6, 'rgba(255,214,190,0.18)');
  crescent(g, shell, LIGHT.x * 3, LIGHT.y * 3, 'rgba(120,100,255,0.25)');
  // Command dome: glass reflecting the sky, framed by ribs
  g.save();
  g.beginPath();
  g.ellipse(0, -24, 48, 32, 0, Math.PI, TAU);
  g.closePath();
  const dome = g.createLinearGradient(0, -56, 0, -24);
  dome.addColorStop(0, 'rgba(225,250,255,0.95)');
  dome.addColorStop(0.35, 'rgba(90,190,230,0.8)');
  dome.addColorStop(0.5, 'rgba(12,60,96,0.9)');
  dome.addColorStop(1, 'rgba(6,28,52,0.95)');
  g.fillStyle = dome;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  g.stroke();
  g.clip();
  g.strokeStyle = 'rgba(4,10,30,0.55)';
  g.lineWidth = 1.2;
  for (const k of [-0.6, -0.22, 0.22, 0.6]) {
    g.beginPath();
    g.moveTo(k * 48, -24);
    g.quadraticCurveTo(k * 40, -48, k * 12, -56);
    g.stroke();
  }
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.beginPath();
  g.ellipse(-18, -44, 14, 3.5, -0.35, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.beginPath();
  g.ellipse(16, -38, 4, 1.4, 0.3, 0, TAU);
  g.fill();
  const collar = g.createLinearGradient(0, -27, 0, -21);
  collar.addColorStop(0, '#d6c8fb');
  collar.addColorStop(1, '#2e1065');
  g.fillStyle = collar;
  g.beginPath();
  g.roundRect(-52, -27, 104, 6, 3);
  g.fill();

  // Emissive layer: window strips, core port ring, side thrusters, dome interior
  const [emis, e] = mk();
  e.globalCompositeOperation = 'lighter';
  e.fillStyle = 'rgba(255,143,216,0.85)';
  for (const [y, w, n] of [
    [-8, 92, 14],
    [6, 108, 16],
  ]) {
    for (let k = 0; k < n; k++) {
      const x = -w + ((k + 0.5) * (2 * w)) / n;
      if ((x / 124) ** 2 + (y / 44) ** 2 > 0.85) continue;
      e.fillRect(x - 2, y - 0.8, 4, 1.6);
    }
  }
  e.strokeStyle = 'rgba(255,95,200,0.7)';
  e.lineWidth = 2;
  e.beginPath();
  e.ellipse(0, 30, 20, 8, 0, 0, TAU);
  e.stroke();
  for (const sx of [-1, 1]) emitDot(e, sx * 121, 2, 10, '#c084fc');
  const glow = e.createRadialGradient(0, -30, 0, 0, -30, 30);
  glow.addColorStop(0, 'rgba(103,232,249,0.35)');
  glow.addColorStop(1, 'rgba(103,232,249,0)');
  e.fillStyle = glow;
  e.fillRect(-30, -60, 60, 60);
  return { hull, emis };
}

/* ------------------------------------------------------------ FX sprites */
const fxCache = new Map();
function cached(key, build) {
  let c = fxCache.get(key);
  if (!c) {
    c = build();
    fxCache.set(key, c);
  }
  return c;
}

// 2x canvas with a logical-size transform.
function hiCanvas(w, h) {
  const c = makeCanvas(w * 2, h * 2);
  const g = c.getContext('2d');
  g.scale(2, 2);
  return [c, g];
}

// Turret dome, sunlit from the upper left.
function turretSprite() {
  return cached('turret', () => {
    const [c, g] = hiCanvas(40, 40);
    g.translate(20, 20);
    const dome = circlePath(0, 0, 14);
    g.beginPath();
    dome(g);
    const gr = g.createRadialGradient(LIGHT.x * 7, LIGHT.y * 7, 1, 0, 0, 15);
    gr.addColorStop(0, '#e4dcff');
    gr.addColorStop(0.4, '#7c5fc0');
    gr.addColorStop(1, '#1a0838');
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = 'rgba(255,143,216,0.6)';
    g.lineWidth = 1.2;
    g.stroke();
    crescent(g, dome, -LIGHT.x * 1.5, -LIGHT.y * 1.5, 'rgba(255,236,214,0.8)');
    g.fillStyle = '#0d0420';
    g.beginPath();
    g.arc(0, 0, 5.5, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.lineWidth = 0.8;
    g.stroke();
    return c;
  });
}

// Player bolt: tapered streak with a white-hot head at x = 42 (of 48).
function boltSprite(color) {
  return cached(`bolt${color}`, () => {
    const [c, g] = hiCanvas(48, 12);
    const halo = g.createLinearGradient(0, 0, 48, 0);
    halo.addColorStop(0, rgba(color, 0));
    halo.addColorStop(0.7, rgba(color, 0.28));
    halo.addColorStop(1, rgba(color, 0.42));
    g.fillStyle = halo;
    g.beginPath();
    g.moveTo(0, 6);
    g.quadraticCurveTo(28, 1, 42, 1);
    g.arc(42, 6, 5, -Math.PI / 2, Math.PI / 2);
    g.quadraticCurveTo(28, 11, 0, 6);
    g.fill();
    const core = g.createLinearGradient(4, 0, 46, 0);
    core.addColorStop(0, rgba(color, 0));
    core.addColorStop(0.55, color);
    core.addColorStop(0.92, '#ffffff');
    g.fillStyle = core;
    g.beginPath();
    g.moveTo(4, 6);
    g.quadraticCurveTo(28, 4, 42, 4.2);
    g.arc(42, 6, 1.8, -Math.PI / 2, Math.PI / 2);
    g.quadraticCurveTo(28, 8, 4, 6);
    g.fill();
    return c;
  });
}

// Enemy plasma orb: white core, coloured body and a crisp ring that reads on any backdrop.
function orbSprite(color) {
  return cached(`orb${color}`, () => {
    const [c, g] = hiCanvas(40, 40);
    const gr = g.createRadialGradient(20, 20, 0, 20, 20, 20);
    gr.addColorStop(0, '#ffffff');
    gr.addColorStop(0.16, shade(color, 0.7));
    gr.addColorStop(0.32, color);
    gr.addColorStop(0.55, rgba(color, 0.26));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 40, 40);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(20, 20, 7.5, 0, TAU);
    g.stroke();
    return c;
  });
}

// Fireball: lumpy white-yellow-orange blob for the first beat of an explosion.
function fireSprite() {
  return cached('fire', () => {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'lighter';
    const puff = (x, y, r, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(255,244,214,${a})`);
      gr.addColorStop(0.3, `rgba(255,180,80,${a * 0.8})`);
      gr.addColorStop(0.7, `rgba(220,70,30,${a * 0.3})`);
      gr.addColorStop(1, 'rgba(120,20,10,0)');
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    puff(64, 64, 50, 0.9);
    for (let k = 0; k < 9; k++) {
      const a = rand(TAU);
      const d = rand(10, 24);
      puff(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, rand(18, 30), 0.45);
    }
    return c;
  });
}

// Smoke puff: soft violet-grey blob, sunlit on its upper-left edge.
function smokeSprite() {
  return cached('smoke', () => {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    const puff = (x, y, r, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(62,54,84,${a})`);
      gr.addColorStop(0.55, `rgba(40,34,60,${a * 0.55})`);
      gr.addColorStop(1, 'rgba(30,26,46,0)');
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    puff(64, 64, 52, 0.6);
    for (let k = 0; k < 6; k++) {
      const a = rand(TAU);
      const d = rand(8, 22);
      puff(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, rand(20, 32), 0.35);
    }
    g.globalCompositeOperation = 'source-atop';
    const lx = 64 + LIGHT.x * 30;
    const ly = 64 + LIGHT.y * 30;
    const lit = g.createRadialGradient(lx, ly, 0, lx, ly, 60);
    lit.addColorStop(0, 'rgba(255,200,160,0.35)');
    lit.addColorStop(1, 'rgba(255,200,160,0)');
    g.fillStyle = lit;
    g.fillRect(0, 0, 128, 128);
    return c;
  });
}

// Engine plume: white-hot at the nozzle (right edge) cooling into the player's colour.
function plumeSprite(color) {
  return cached(`plume${color}`, () => {
    const c = makeCanvas(128, 32);
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, rgba(color, 0));
    gr.addColorStop(0.35, rgba(color, 0.55));
    gr.addColorStop(0.7, '#ffa25a');
    gr.addColorStop(0.9, '#ffe9bd');
    gr.addColorStop(1, '#ffffff');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(128, 5);
    g.quadraticCurveTo(50, 10, 0, 16);
    g.quadraticCurveTo(50, 22, 128, 27);
    g.closePath();
    g.fill();
    const core = g.createLinearGradient(60, 0, 128, 0);
    core.addColorStop(0, 'rgba(255,255,255,0)');
    core.addColorStop(1, 'rgba(255,255,255,0.9)');
    g.fillStyle = core;
    g.beginPath();
    g.moveTo(128, 12);
    g.quadraticCurveTo(90, 14, 60, 16);
    g.quadraticCurveTo(90, 18, 128, 20);
    g.closePath();
    g.fill();
    return c;
  });
}

// Fresnel bubble: clear centre brightening to a hot edge.
function bubbleSprite(color) {
  return cached(`bubble${color}`, () => {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, rgba(color, 0));
    gr.addColorStop(0.55, rgba(color, 0.03));
    gr.addColorStop(0.8, rgba(color, 0.16));
    gr.addColorStop(0.92, rgba(color, 0.6));
    gr.addColorStop(0.965, 'rgba(255,255,255,0.85)');
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return c;
  });
}

// Crystal: a cut gem, four facets lit from the upper left, hairline edges.
function crystalSprite() {
  return cached('crystal', () => {
    const [c, g] = hiCanvas(28, 28);
    g.translate(14, 14);
    const T = [0, -11];
    const Rr = [7.5, -1];
    const B = [0, 11];
    const L = [-7.5, -1];
    const C = [0, -2.5];
    for (const [pts, col] of [
      [[T, L, C], '#d5fff6'],
      [[T, Rr, C], '#7ff0dc'],
      [[L, B, C], '#14b8a6'],
      [[Rr, B, C], '#0b7a70'],
    ]) {
      g.beginPath();
      poly(g, pts);
      g.fillStyle = col;
      g.fill();
    }
    g.beginPath();
    poly(g, [T, Rr, B, L]);
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.lineWidth = 0.6;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(-2.5, -5.5, 1.1, 0, TAU);
    g.fill();
    return c;
  });
}

// Four-point glint flare.
function sparkSprite() {
  return cached('spark', () => {
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    for (const [x0, y0, x1, y1] of [
      [0, 32, 64, 32],
      [32, 0, 32, 64],
    ]) {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, 'rgba(255,255,255,1)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      if (x0 === 0) g.fillRect(0, 31, 64, 2);
      else g.fillRect(31, 0, 2, 64);
    }
    const core = g.createRadialGradient(32, 32, 0, 32, 32, 10);
    core.addColorStop(0, 'rgba(255,255,255,0.9)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(22, 22, 20, 20);
    return c;
  });
}

// Weapon pod: glass hex capsule in a bevelled metal frame, tinted by the weapon.
function podSprite(color) {
  return cached(`pod${color}`, () => {
    const [c, g] = hiCanvas(44, 44);
    g.translate(22, 22);
    const hex = (r) => Array.from({ length: 6 }, (_, k) => [Math.cos((k / 6) * TAU) * r, Math.sin((k / 6) * TAU) * r]);
    g.beginPath();
    poly(g, hex(16));
    const glass = g.createRadialGradient(0, 0, 0, 0, 0, 17);
    glass.addColorStop(0, rgba(color, 0.55));
    glass.addColorStop(1, 'rgba(10,8,24,0.92)');
    g.fillStyle = glass;
    g.fill();
    const frame = g.createLinearGradient(0, -16, 0, 16);
    frame.addColorStop(0, '#eef0ff');
    frame.addColorStop(1, '#3e4262');
    g.strokeStyle = frame;
    g.lineWidth = 2.6;
    g.lineJoin = 'round';
    g.stroke();
    g.beginPath();
    poly(g, hex(12.5));
    g.strokeStyle = rgba(color, 0.85);
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    g.ellipse(-5, -8, 5, 1.6, -0.5, 0, TAU);
    g.fill();
    return c;
  });
}

/* ------------------------------------------------------------ Game */
class GalaxyQuest {
  constructor({ players, host }) {
    this.host = host;
    this.nebula = buildNebula();
    this.sunWash = buildSunWash();
    this.planet = buildPlanet();
    this.starsMid = buildStars(300, 0.5, 1.3, 0.3, 0.75, false);
    this.starsNear = buildStars(80, 0.9, 2.1, 0.55, 1, true);
    this.bossArt = buildBoss();
    rockSprites();
    enemySprites();
    this.twinkles = Array.from({ length: 50 }, () => ({ x: rand(W), y: rand(H), p: rand(TAU), r: rand(0.8, 1.8), c: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)] }));
    // Out-of-focus dust drifting at foreground depth (z = parallax factor)
    this.motes = Array.from({ length: 34 }, () => ({ x: rand(W), y: rand(H), z: rand(0.25, 0.6), r: rand(2, 7), a: rand(0.05, 0.15), p: rand(TAU) }));
    this.cam = { x: 0, y: 0 };
    this.particles = new Particles();
    this.rings = [];
    this.flashes = [];
    this.debris = [];
    this.popups = [];
    this.fires = []; // visual-only explosion layers
    this.smoke = [];
    this.fx = { flash: 0, ab: 0, phase: 0, ghost: 1 };
    this.post = { flash: 0, flashColor: [1, 0.8, 0.6], aberration: POST.aberration, desaturate: 0 };
    this.time = 0;
    this.shake = 0;
    this.result = null;
    const n = players.length;
    this.ships = players.map((p, i) => ({
      ...p,
      i,
      sprite: buildShip(p.color),
      trail: [],
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
    this.fxBurst(x, y, r, color, vx, vy);
    if (shake) this.addShake(shake);
    if (sound) this.host.sfx(sound);
  }

  // Visual-only layers of an explosion: fireballs, lingering smoke and a post flash on big ones.
  fxBurst(x, y, r, color, vx, vy) {
    const fires = Math.min(5, 1 + Math.floor(r / 22));
    for (let k = 0; k < fires; k++) {
      const a = rand(TAU);
      const d = k ? rand(r * 0.2, r * 0.6) : 0;
      const life = 0.4 + r * 0.004;
      this.fires.push({
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        vx: vx * 0.3 + Math.cos(a) * r * 0.8,
        vy: vy * 0.3 + Math.sin(a) * r * 0.8,
        r: r * (k ? rand(0.6, 0.9) : 1.1),
        life,
        max: life,
        rot: rand(TAU),
      });
    }
    const puffs = Math.min(8, 1 + Math.floor(r / 12));
    for (let k = 0; k < puffs; k++) {
      const a = rand(TAU);
      const sp = rand(10, 30 + r);
      const life = rand(0.9, 1.6);
      this.smoke.push({
        x: x + Math.cos(a) * r * 0.3,
        y: y + Math.sin(a) * r * 0.3,
        vx: vx * 0.25 + Math.cos(a) * sp,
        vy: vy * 0.25 + Math.sin(a) * sp,
        r: r * rand(0.6, 1.1),
        life,
        max: life,
        rot: rand(TAU),
        spin: rand(-1, 1),
      });
    }
    if (this.fires.length > 60) this.fires.splice(0, this.fires.length - 60);
    if (this.smoke.length > 140) this.smoke.splice(0, this.smoke.length - 140);
    if (r >= 30) {
      const fx = this.fx;
      fx.flash = Math.min(0.35, fx.flash + (r - 24) * 0.004);
      fx.ab = Math.min(0.006, fx.ab + r * 0.00003);
      const [cr, cg, cb] = hexToRgb(color);
      this.post.flashColor = [0.6 + (cr / 255) * 0.4, 0.5 + (cg / 255) * 0.4, 0.4 + (cb / 255) * 0.4];
    }
  }

  // Render-side state only (trails, fire, smoke, post-fx decay); never touches gameplay.
  updateVisuals(dt) {
    const fx = this.fx;
    fx.flash = Math.max(0, fx.flash - dt * 2.2);
    fx.ab *= Math.max(0, 1 - dt * 4);
    const b = this.boss;
    if (b && b.phase !== fx.phase) {
      if (fx.phase) {
        // Mothership phase change: magenta flash and a lens jolt
        fx.flash = Math.max(fx.flash, 0.3);
        fx.ab = 0.008;
        this.post.flashColor = [1, 0.45, 0.85];
      }
      fx.phase = b.phase;
    } else if (!b) fx.phase = 0;
    const v = b ? Math.max(0, b.hp) / b.max : 1;
    fx.ghost = v > fx.ghost ? v : Math.max(v, fx.ghost - dt * 0.35);
    // Downed pilots drain the colour a little; game over drains more
    const down = this.ships.filter((s) => !s.alive).length / this.ships.length;
    const desat = this.result ? 0.55 : down * 0.3;
    this.post.desaturate += (desat - this.post.desaturate) * Math.min(1, dt * 3);
    this.post.flash = fx.flash;
    this.post.aberration = POST.aberration + fx.ab;

    for (const s of this.ships) {
      if (!s.alive) {
        s.trail.length = 0;
        continue;
      }
      s.trail.push({ x: s.x - Math.cos(s.angle) * 21, y: s.y - Math.sin(s.angle) * 21, f: s.flame });
      if (s.trail.length > 22) s.trail.shift();
    }
    for (const f of this.fires) {
      f.life -= dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= 1 - dt * 3;
      f.vy *= 1 - dt * 3;
    }
    for (const m of this.smoke) {
      m.life -= dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.vx *= 1 - dt * 1.2;
      m.vy *= 1 - dt * 1.2;
      m.rot += m.spin * dt;
    }
    sweep(this.fires);
    sweep(this.smoke);
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
    this.updateVisuals(dt);
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
    this.drawTrails(ctx);
    for (const s of this.ships) if (s.alive) this.drawShip(ctx, s);

    this.drawSmoke(ctx);
    this.drawShots(ctx);
    this.drawParticles(ctx);
    for (const p of this.popups) {
      const pop = 1 + Math.max(0, p.life - 0.85) * 2.5; // quick scale-in
      text(ctx, p.str, p.x, p.y, { size: p.size * pop, color: p.color, alpha: Math.min(1, p.life * 2), spacing: 1 });
    }
    this.drawMotes(ctx);
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
      const y = H / 2 - 150;
      ctx.save();
      ctx.globalAlpha = al * 0.8;
      const line = ctx.createLinearGradient(W / 2 - 280, 0, W / 2 + 280, 0);
      line.addColorStop(0, 'rgba(255,95,200,0)');
      line.addColorStop(0.5, '#ff5fc8');
      line.addColorStop(1, 'rgba(255,95,200,0)');
      ctx.fillStyle = line;
      ctx.fillRect(W / 2 - 280, y + 24, 560, 1.5);
      ctx.restore();
      text(ctx, pb.title, W / 2, y - 6, { size: 60, color: '#ff5fc8', glow: 24, alpha: al, spacing: 8 });
      text(ctx, pb.sub.toUpperCase(), W / 2, y + 44, { size: 20, weight: 600, color: '#ffd6ef', alpha: al, spacing: 3 });
    }
  }

  drawBackground(ctx) {
    const cx = this.cam.x;
    const cy = this.cam.y;
    ctx.drawImage(this.nebula, -60 - cx * 0.02, -60 - cy * 0.02);
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Twinkling stars, each in its own colour temperature
    for (const t of this.twinkles) {
      const a = 0.35 + Math.sin(this.time * 2 + t.p) * 0.35;
      if (a < 0.03) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(dotSprite(t.c), t.x - t.r * 3, t.y - t.r * 3, t.r * 6, t.r * 6);
    }
    // Sun wash and god-rays sit almost at infinity
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sunWash, -20 - cx * 0.01, -20 - cy * 0.01, W + 40, H + 40);
    ctx.restore();
    ctx.drawImage(this.planet, 1190 - cx * 0.04, 110 - cy * 0.04, 440, 320);
  }

  // Foreground: out-of-focus dust drifting past and faint lens ghosts from the sun.
  drawMotes(ctx) {
    const cx = this.cam.x;
    const cy = this.cam.y;
    const wrapW = W + 40;
    const wrapH = H + 40;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const spr = glowSprite('#ffe6c7', 64, 0.02);
    for (const m of this.motes) {
      const x = ((((m.x - (cx + this.time * 18) * m.z) % wrapW) + wrapW) % wrapW) - 20;
      const y = ((((m.y - (cy + this.time * 6) * m.z) % wrapH) + wrapH) % wrapH) - 20;
      ctx.globalAlpha = m.a * (0.7 + Math.sin(this.time * 0.8 + m.p) * 0.3);
      ctx.drawImage(spr, x - m.r * 2, y - m.r * 2, m.r * 4, m.r * 4);
    }
    const sx = SUN.x - cx * 0.01;
    const sy = SUN.y - cy * 0.01;
    const ax = W / 2 - cx * 0.3 - sx;
    const ay = H / 2 - cy * 0.3 - sy;
    for (const [t, r, col, a] of FLARE) drawGlow(ctx, col, sx + ax * t, sy + ay * t, r, a);
    ctx.restore();
  }

  drawWell(ctx, w) {
    ctx.save();
    ctx.translate(w.x, w.y);
    // Dark lensing core
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 120);
    core.addColorStop(0, 'rgba(3,0,10,0.8)');
    core.addColorStop(0.45, 'rgba(18,4,36,0.4)');
    core.addColorStop(1, 'rgba(18,4,36,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let k = 0; k < 5; k++) {
      const r = 300 - ((this.time * 90 + k * 60) % 300); // rings contract inward
      const f = 1 - r / 300;
      ctx.strokeStyle = `rgba(192,132,252,${0.22 * f + 0.04})`;
      ctx.lineWidth = 1.5 + f * 2.5;
      for (let q = 0; q < 3; q++) {
        const a = this.time * 1.5 + q * (TAU / 3) + k + f * 1.5; // arcs spiral as they fall in
        ctx.beginPath();
        ctx.arc(0, 0, r, a, a + 1.2);
        ctx.stroke();
      }
    }
    drawGlow(ctx, '#a855f7', 0, 0, 120, 0.3);
    // Photon ring
    ctx.globalAlpha = 0.5 + Math.sin(this.time * 5) * 0.15;
    ctx.strokeStyle = '#e9d5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 38, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Ion trails: a fading ribbon behind each ship's engines.
  drawTrails(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.ships) {
      const tr = s.trail;
      if (tr.length < 2) continue;
      ctx.strokeStyle = s.color;
      for (let i = 1; i < tr.length; i++) {
        const p = tr[i - 1];
        const q = tr[i];
        if (Math.abs(p.x - q.x) > 80 || Math.abs(p.y - q.y) > 80) continue; // wrapped round the screen
        const k = i / tr.length; // 0 at the tail, 1 at the ship
        const a = k * q.f * 0.45;
        if (a < 0.02) continue;
        ctx.globalAlpha = a;
        ctx.lineWidth = 1 + k * 5 * q.f;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Smoke sits under the additive fire so explosions read as a hot core in a dark billow.
  drawSmoke(ctx) {
    if (!this.smoke.length) return;
    const spr = smokeSprite();
    const base = ctx.getTransform();
    ctx.save();
    for (const m of this.smoke) {
      const k = m.life / m.max;
      const r = m.r * (0.7 + (1 - k) * 1.3);
      ctx.globalAlpha = Math.min(1, k * 1.5) * 0.55;
      ctx.setTransform(base);
      ctx.translate(m.x, m.y);
      ctx.rotate(m.rot);
      ctx.drawImage(spr, -r, -r, r * 2, r * 2);
    }
    ctx.restore();
  }

  drawShots(ctx) {
    const base = ctx.getTransform();
    ctx.save();
    // Missile bodies are solid, so they go before the additive pass
    for (const m of this.missiles) {
      ctx.setTransform(base);
      ctx.translate(m.x, m.y);
      ctx.rotate(m.angle);
      ctx.fillStyle = '#3a3f55';
      ctx.beginPath();
      poly(ctx, [
        [-6, -1.6],
        [-9, -4.2],
        [-3.5, -1.6],
      ]);
      poly(ctx, [
        [-6, 1.6],
        [-9, 4.2],
        [-3.5, 1.6],
      ]);
      ctx.fill();
      ctx.fillStyle = '#c9cde0';
      ctx.fillRect(-6, -1.6, 10, 3.2);
      ctx.fillStyle = '#fb923c';
      ctx.fillRect(3, -1.6, 2.5, 3.2);
    }
    ctx.setTransform(base);
    ctx.globalCompositeOperation = 'lighter';
    // Fireballs swell and cool
    const fire = fireSprite();
    for (const f of this.fires) {
      const k = f.life / f.max;
      const r = f.r * (0.45 + (1 - k) * 0.8);
      ctx.globalAlpha = k ** 1.4;
      ctx.setTransform(base);
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.drawImage(fire, -r, -r, r * 2, r * 2);
    }
    ctx.setTransform(base);
    // Explosion flashes
    for (const f of this.flashes) drawGlow(ctx, f.color, f.x, f.y, f.r * (1.2 - (f.life / f.max) * 0.4), f.life / f.max);
    // Shockwave rings: soft colour band with a white-hot leading edge
    for (const r of this.rings) {
      const k = Math.max(0, r.life / r.maxLife);
      const w = r.w * (0.4 + k * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, TAU);
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = k * 0.25;
      ctx.lineWidth = w * 3;
      ctx.stroke();
      ctx.globalAlpha = k * 0.8;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = k * 0.6;
      ctx.lineWidth = Math.max(1, w * 0.3);
      ctx.stroke();
    }
    // Enemy fire
    const orb = orbSprite('#ff3fa4');
    const bolt = boltSprite('#a3e635');
    for (const o of this.orbs) {
      ctx.setTransform(base);
      if (o.bolt) {
        drawGlow(ctx, '#a3e635', o.x, o.y, 14, 0.8);
        ctx.globalAlpha = 1;
        ctx.translate(o.x, o.y);
        ctx.rotate(Math.atan2(o.vy, o.vx));
        ctx.drawImage(bolt, -60, -8, 68, 16);
      } else {
        const r = 17 + Math.sin(o.life * 18) * 1.5;
        ctx.globalAlpha = 1;
        ctx.drawImage(orb, o.x - r, o.y - r, r * 2, r * 2);
      }
    }
    // Player bolts
    ctx.globalAlpha = 1;
    for (const b of this.bullets) {
      ctx.setTransform(base);
      ctx.translate(b.x, b.y);
      ctx.rotate(Math.atan2(b.vy, b.vx));
      ctx.drawImage(boltSprite(b.owner.color), -40, -6, 46, 12);
    }
    ctx.setTransform(base);
    // Missile exhaust
    for (const m of this.missiles) {
      const ex = m.x - Math.cos(m.angle) * 7;
      const ey = m.y - Math.sin(m.angle) * 7;
      drawGlow(ctx, '#fb923c', ex, ey, 12, 1);
      drawGlow(ctx, '#ffffff', ex, ey, 4, 0.9);
    }
    // Laser beams: layered glow around a white core, with crackle along the length
    ctx.lineCap = 'round';
    for (const s of this.ships) {
      if (!s.beam) continue;
      const { x1, y1, x2, y2 } = s.beam;
      const wob = 1 + Math.sin(this.time * 60) * 0.15;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      for (const [w, col, a] of [
        [26 * wob, WEAPONS.laser.color, 0.12],
        [13 * wob, WEAPONS.laser.color, 0.3],
        [7 * wob, s.color, 0.7],
        [2.5, '#ffffff', 1],
      ]) {
        ctx.globalAlpha = a;
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.stroke();
      }
      for (let k = 0; k < 4; k++) {
        const t = Math.random();
        drawGlow(ctx, '#ffd1ec', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 6 + Math.random() * 8, 0.5);
      }
      drawGlow(ctx, WEAPONS.laser.color, x2, y2, 30 * wob, 0.9);
      drawGlow(ctx, '#ffffff', x2, y2, 10 * wob, 0.8);
      drawGlow(ctx, s.color, x1, y1, 20, 0.9);
    }
    ctx.restore();
  }

  // Additive soft sprites instead of flat circles: cheaper than arcs, and they bloom.
  drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles.list) {
      const k = p.life / p.max;
      if (k <= 0) continue;
      const r = p.size * (2 + (1 - k) * 0.8);
      ctx.globalAlpha = Math.min(1, k * 1.3);
      ctx.drawImage(dotSprite(p.color), p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  drawShip(ctx, s) {
    const blink = s.inv > 0 && Math.floor(this.time * 10) % 2 === 0;
    const hull = s.sprite;
    const vis = blink ? 0.35 : 1;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.save();
    ctx.rotate(s.angle);
    // Engine plumes: flickering length, white-hot at the nozzle, bloom glow behind
    ctx.globalCompositeOperation = 'lighter';
    if (s.flame > 0.05) {
      const plume = plumeSprite(s.color);
      const fl = s.flame;
      ctx.globalAlpha = vis * Math.min(1, fl * 1.4);
      for (const ny of [-6, 6]) {
        const len = (14 + 34 * fl) * (0.85 + Math.random() * 0.3);
        const h = 6 + 4 * fl;
        ctx.drawImage(plume, -20 - len, ny - h / 2, len, h);
      }
      drawGlow(ctx, '#ffb347', -22, 0, 16 + 14 * fl, 0.55 * fl * vis);
    }
    drawGlow(ctx, s.color, 0, 0, 34, blink ? 0.06 : 0.16);
    ctx.globalCompositeOperation = 'source-over';
    drawHull(ctx, hull, s.angle, vis);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = vis * (0.85 + Math.sin(this.time * 6 + s.i) * 0.15);
    ctx.drawImage(hull.emis, -36, -36, 72, 72);
    if (s.muzzle > 0) {
      drawGlow(ctx, s.color, 30, 0, 18, 1);
      drawGlow(ctx, '#ffffff', 30, 0, 8, 0.9);
    }
    ctx.restore();
    // Shield: fresnel bubble (clear centre, hot edge) with glints sweeping round it
    if (s.shieldT > 0) {
      const fade = Math.min(1, s.shieldT * 2);
      const r = 36 + Math.sin(this.time * 14) * 1.2;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (0.75 + Math.sin(this.time * 14) * 0.2) * fade;
      ctx.drawImage(bubbleSprite('#22d3ee'), -r, -r, r * 2, r * 2);
      ctx.globalAlpha = 0.6 * fade;
      ctx.strokeStyle = '#e0fbff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      const a = this.time * 4;
      ctx.beginPath();
      ctx.arc(0, 0, r - 3, a, a + 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r - 3, a + Math.PI, a + Math.PI + 0.5);
      ctx.stroke();
    }
    ctx.restore();
    text(ctx, String(s.name).toUpperCase(), s.x, s.y - 38, { size: 13, weight: 600, color: '#ffffff', alpha: blink ? 0.4 : 0.85, spacing: 1.5 });
    if (s.mult > 1) text(ctx, `x${s.mult}`, s.x + 30, s.y - 22, { size: 15, color: '#ffd166' });
  }

  drawWreck(ctx, s) {
    const w = s.wreck;
    ctx.save();
    ctx.translate(w.x, w.y);
    // Revive ring: progress in teal, time left as a thin outer arc in the player's colour
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, TAU);
    ctx.stroke();
    if (s.revive > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(0, 0, 34, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, s.revive));
      ctx.strokeStyle = '#5eead4';
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(s.color, 0.6);
    ctx.beginPath();
    ctx.arc(0, 0, 42, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, s.downT / DOWN_TIME));
    ctx.stroke();
    ctx.setLineDash([4, 10]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(94,234,212,0.25)';
    ctx.beginPath();
    ctx.arc(0, 0, REVIVE_R, this.time, this.time + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.rotate(w.rot);
    drawHull(ctx, s.sprite, w.rot, 0.45 + Math.sin(this.time * 8) * 0.15);
    // Sparking damage
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#ff9f43', rand(-8, 8), rand(-6, 6), 8 + Math.random() * 8, 0.5);
    ctx.restore();
    // Tethers from rescuers
    if (s.helpers.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const h of s.helpers) {
        ctx.beginPath();
        ctx.moveTo(h.x, h.y);
        ctx.lineTo(w.x, w.y);
        ctx.strokeStyle = '#5eead4';
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 2 + Math.sin(this.time * 30);
        ctx.stroke();
      }
      ctx.restore();
    }
    const others = this.ships.some((o) => o.alive);
    text(ctx, others ? 'FLY CLOSE TO REVIVE' : String(s.name).toUpperCase(), w.x, w.y - 54, { size: 13, weight: 700, color: '#5eead4', alpha: 0.6 + Math.sin(this.time * 6) * 0.3, spacing: 2 });
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
    ctx.drawImage(set.frames[i], -h, -h, set.S, set.S);
    if (a.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7;
      ctx.drawImage(set.frames[i], -h, -h, set.S, set.S);
    }
    ctx.restore();
  }

  // Tumbling fragments: dark chunk with a lit edge, glowing hot while fresh.
  drawDebris(ctx) {
    const base = ctx.getTransform();
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,224,190,0.4)';
    for (const d of this.debris) {
      ctx.setTransform(base);
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.globalAlpha = Math.min(1, d.life / 0.4);
      ctx.fillStyle = d.color;
      ctx.beginPath();
      d.pts.forEach(([a, k], i) => (i ? ctx.lineTo(Math.cos(a) * d.size * k, Math.sin(a) * d.size * k) : ctx.moveTo(Math.cos(a) * d.size * k, Math.sin(a) * d.size * k)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.setTransform(base);
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.debris) {
      const heat = (d.life - 0.8) / 0.8;
      if (heat > 0) drawGlow(ctx, '#ff8a3d', d.x, d.y, d.size * 1.8 + 3, heat * 0.6);
    }
    ctx.restore();
  }

  drawEnemy(ctx, e) {
    const hull = enemySprites()[e.type];
    const col = ENEMY[e.type].color;
    const rot = e.type === 'drone' ? e.t * 2 : e.type === 'sniper' ? e.aim : e.angle;

    // Sniper targeting laser while charging
    if (e.type === 'sniper' && e.fireCd < 1.1 && this.state === 'play') {
      const locked = e.fireCd < 0.3;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = locked ? (Math.floor(this.time * 30) % 2 ? 0.9 : 0.4) : 0.15 + (1.1 - e.fireCd) * 0.4;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + Math.cos(e.aim) * 1800, e.y + Math.sin(e.aim) * 1800);
      ctx.strokeStyle = locked ? '#ffffff' : '#ef4444';
      ctx.lineWidth = locked ? 2 : 1.2;
      ctx.stroke();
      ctx.globalAlpha *= 0.3;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = locked ? 7 : 4;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(e.x, e.y);
    const warn = e.type === 'kamikaze' && e.mode === 'lock';
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, col, 0, 0, warn ? 40 + Math.sin(this.time * 40) * 8 : 30, warn ? 0.8 : 0.22);
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(rot);
    drawHull(ctx, hull, rot);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85 + Math.sin(this.time * 10 + e.t) * 0.15;
    ctx.drawImage(hull.emis, -32, -32, 64, 64);
    if (e.flash > 0 || (warn && Math.floor(this.time * 20) % 2)) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(hull.flash, -32, -32, 64, 64);
    }
    drawGlow(ctx, col, 0, 0, 8 + Math.sin(this.time * 10) * 2, 0.5);
    if (e.type === 'shield') {
      // Front energy shield: soft band, bright core line, white-hot on impact
      const hit = e.shieldHit > 0;
      const k = hit ? 1 : 0.6 + Math.sin(this.time * 8) * 0.15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, e.r + 8, -1.2, 1.2);
      ctx.strokeStyle = '#38bdf8';
      ctx.globalAlpha = k * 0.22;
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = hit ? '#ffffff' : '#7dd3fc';
      ctx.globalAlpha = k * 0.75;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = k * 0.8;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBoss(ctx, b) {
    const art = this.bossArt;
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.dying > 0) ctx.translate(rand(-4, 4), rand(-4, 4));
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#c026d3', 0, 10, 190, 0.3);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(art.hull, -150, -75, 300, 150);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.75 + Math.sin(this.time * (2 + b.phase * 2)) * 0.25;
    ctx.drawImage(art.emis, -150, -75, 300, 150);
    if (b.flash > 0) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(art.hull, -150, -75, 300, 150);
    }
    // Running lights
    for (let k = -4; k <= 4; k++) {
      const on = Math.floor(this.time * 6 + k) % 3 === 0;
      drawGlow(ctx, on ? '#ffd166' : '#ff3fa4', k * 24, 12, on ? 9 : 6, on ? 1 : 0.7);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Turrets
    const dome = turretSprite();
    for (const t of b.turrets) {
      ctx.save();
      ctx.translate(t.ox, t.oy);
      if (t.dead) {
        // Burnt-out socket with flickering embers
        ctx.fillStyle = '#140a1f';
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, Math.random() < 0.5 ? '#ff9f43' : '#ff3b5c', rand(-3, 3), rand(-3, 3), 7 + Math.random() * 4, 0.7);
      } else {
        ctx.save();
        ctx.rotate(t.angle);
        ctx.fillStyle = '#2a1840';
        ctx.fillRect(0, -3.5, 24, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(4, -3.5, 16, 1.5);
        ctx.fillStyle = '#ff8fd8';
        ctx.fillRect(20, -3.5, 4, 7);
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, '#ff8fd8', 23, 0, 7, 0.8);
        ctx.restore();
        ctx.drawImage(dome, -20, -20, 40, 40);
        if (t.flash > 0) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.8;
          ctx.drawImage(dome, -20, -20, 40, 40);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
        // Turret health arc
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(0, 0, 19, 0, TAU);
        ctx.stroke();
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
    drawGlow(ctx, '#ffffff', 0, 30, 10 * pulse, 0.8);
    if (b.turrets.some((t) => !t.dead) && !b.dying) {
      const hit = b.shieldHit > 0;
      ctx.globalAlpha = hit ? 0.95 : 0.35 + Math.sin(this.time * 3) * 0.08;
      ctx.drawImage(bubbleSprite('#22d3ee'), -158, -72, 316, 144);
      if (hit) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#e0fbff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, 150, 66, 0, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawCrystal(ctx, c) {
    const blink = c.life < 2 && Math.floor(c.t * 10) % 2 === 0;
    if (blink) return;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, '#5eead4', 0, 0, 22, 0.5);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // The gem turns about its long axis (squash in x) while tilting
    ctx.save();
    ctx.rotate(Math.sin(c.t * 1.3) * 0.35);
    ctx.scale(Math.max(0.2, Math.abs(Math.cos(c.t * 2.5))), 1);
    ctx.drawImage(crystalSprite(), -14, -14, 28, 28);
    ctx.restore();
    // Periodic glint
    const gl = Math.sin(c.t * 3 + c.x * 0.01);
    if (gl > 0.9) {
      const r = 14 * ((gl - 0.9) / 0.1);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(sparkSprite(), -2 - r, -6 - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  drawPod(ctx, p) {
    if (p.life < 2.5 && Math.floor(p.t * 10) % 2 === 0) return;
    const w = WEAPONS[p.kind];
    const bob = Math.sin(p.t * 4) * 3;
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, w.color, 0, 0, 36, 0.6);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.rotate(p.t * 1.5);
    ctx.drawImage(podSprite(w.color), -22, -22, 44, 44);
    ctx.restore();
    text(ctx, w.label, p.x, p.y + bob + 1, { size: 18, color: '#ffffff' });
  }

  drawHud(ctx) {
    // Team panel: lives, and the crystal bank toward the next life
    glassPanel(ctx, 20, 16, 262, 68, { accent: '#22d3ee' });
    text(ctx, 'LIVES', 38, 32, { size: 12, align: 'left', color: 'rgba(200,210,255,0.6)', spacing: 2.5 });
    ctx.save();
    ctx.translate(46, 60);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    poly(ctx, [
      [9, 0],
      [-6, -6.5],
      [-3.5, 0],
      [-6, 6.5],
    ]);
    ctx.fill();
    ctx.restore();
    text(ctx, String(this.lives), 62, 60, { size: 30, align: 'left', color: '#ffffff' });
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(108, 28, 1, 44);
    text(ctx, 'CRYSTALS', 124, 32, { size: 12, align: 'left', color: 'rgba(94,234,212,0.85)', spacing: 2.5 });
    text(ctx, `${this.bank}/${BANK_LIFE}`, 264, 32, { size: 13, align: 'right', color: 'rgba(255,255,255,0.7)' });
    meter(ctx, 124, 48, 140, 8, this.bank / BANK_LIFE, '#5eead4', { segments: BANK_LIFE, glow: false });
    text(ctx, '+1 LIFE', 124, 70, { size: 11, weight: 600, align: 'left', color: 'rgba(200,210,255,0.45)', spacing: 2 });

    // Wave title with hairlines either side
    text(ctx, `WAVE ${this.wave}`, W / 2, 30, { size: 22, color: '#ffffff', spacing: 6 });
    ctx.save();
    for (const sx of [-1, 1]) {
      const x0 = W / 2 + sx * 80;
      const x1 = W / 2 + sx * 200;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(x0, x1), 30, 120, 1);
    }
    ctx.restore();

    // Team score, leading zeros dimmed
    glassPanel(ctx, W - 282, 16, 262, 68, { accent: '#ffd166', accentSide: 'right' });
    text(ctx, 'TEAM SCORE', W - 38, 32, { size: 12, align: 'right', color: 'rgba(255,220,160,0.7)', spacing: 2.5 });
    const str = String(this.teamScore);
    ctx.save();
    ctx.font = '700 38px "Rajdhani", system-ui, sans-serif';
    ctx.letterSpacing = '2px';
    const sw = ctx.measureText(str).width;
    ctx.restore();
    text(ctx, str, W - 38, 60, { size: 38, align: 'right', color: '#ffe3a3', spacing: 2 });
    if (str.length < 6) text(ctx, '0'.repeat(6 - str.length), W - 38 - sw, 60, { size: 38, align: 'right', color: 'rgba(255,227,163,0.22)', spacing: 2 });

    // Per-player cards
    const n = this.ships.length;
    const cw = 196;
    const stride = 208;
    const x0 = W / 2 - (n * stride - 12) / 2;
    this.ships.forEach((s, i) => {
      const x = x0 + i * stride;
      const y = 50;
      ctx.save();
      ctx.globalAlpha = s.alive ? 1 : 0.5;
      glassPanel(ctx, x, y, cw, 46, { r: 8, accent: s.color, alpha: 0.5 });
      // Shield pip: player-colour dot ringed by the cooldown arc
      const px = x + 24;
      const py = y + 23;
      const ready = s.shieldCd <= 0;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, TAU);
      ctx.fill();
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(px, py, 11, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = ready ? '#22d3ee' : 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(px, py, 11, -Math.PI / 2, -Math.PI / 2 + TAU * (ready ? 1 : 1 - s.shieldCd / 8));
      ctx.stroke();
      text(ctx, String(s.name).toUpperCase().slice(0, 10), x + 44, y + 15, { size: 14, align: 'left', color: '#ffffff', spacing: 0.5 });
      text(ctx, String(s.score), x + cw - 12, y + 15, { size: 16, align: 'right', color: '#ffe3a3' });
      if (s.down) text(ctx, `DOWN · ${Math.ceil(s.downT)}S`, x + 44, y + 33, { size: 12, align: 'left', color: '#5eead4', spacing: 1.5 });
      else if (s.out) text(ctx, 'OUT', x + 44, y + 33, { size: 12, align: 'left', color: '#ff8fa3', spacing: 1.5 });
      else if (s.weapon) {
        const wpn = WEAPONS[s.weapon];
        text(ctx, wpn.name, x + 44, y + 33, { size: 12, align: 'left', color: wpn.color, spacing: 1.5 });
        meter(ctx, x + 108, y + 31, 50, 4, s.weaponT / WEAPON_TIME, wpn.color, { glow: false });
      }
      if (s.mult > 1) text(ctx, `x${s.mult}`, x + cw - 12, y + 33, { size: 15, align: 'right', color: '#ffd166' });
      ctx.restore();
    });

    if (this.boss) {
      const b = this.boss;
      const bw = 560;
      const bx = W / 2 - bw / 2;
      const shielded = b.turrets.some((t) => !t.dead);
      const left = b.turrets.filter((t) => !t.dead).length;
      glassPanel(ctx, bx - 16, 104, bw + 32, 40, { r: 8, alpha: 0.5 });
      text(ctx, `MOTHERSHIP · PHASE ${b.phase}`, bx, 117, { size: 13, align: 'left', color: '#ff8fd8', spacing: 3 });
      text(ctx, left ? `${left} TURRETS SHIELDING CORE` : 'CORE EXPOSED', bx + bw, 117, { size: 13, align: 'right', color: shielded ? '#7dd3fc' : '#ffd166', spacing: 2 });
      meter(ctx, bx, 128, bw, 7, Math.max(0, b.hp) / b.max, shielded ? '#8b6fc0' : '#ff5fc8', { ghost: this.fx.ghost, glow: !shielded });
      // Phase notches
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const f of [0.33, 0.66]) ctx.fillRect(bx + bw * f - 1, 125, 2, 13);
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
  post: POST,
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
