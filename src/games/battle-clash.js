import { mulberry32, shade } from '../utils/random.js';
import { HUD_FONT, contactShadow, drawGlow, glassPanel, glowSprite, meter, rgba } from './engine/fx.js';
import { H, IDLE, Particles, TAU, W, clamp, lerp, makeCanvas, rand } from './engine/util.js';

/*
 * Battle Clash — 1v1 side-view fighter. Jab/cross/roundhouse chains, launchers
 * and juggles, sweeps, throws, a guard meter that can break, and a super
 * fireball with A+B once the meter is full. Best of 3.
 *
 * Fighters are a 2-bone IK skeleton: each state picks a target pose (hips,
 * neck, head, hands, feet), the joints ease toward it, and knees/elbows are
 * solved every frame so limbs never stretch. The camera pans and zooms to keep
 * both fighters framed over a parallax arena.
 *
 * Presentation is layered on top and never feeds back into the simulation:
 * cel-shaded, rim-lit fighters keyed to the setting sun, a cached multi-layer
 * rooftop stage, impact frames, smears and afterimages, and a post-process
 * grade (bloom, flashes, KO desaturation) driven through `this.post`.
 */

const GROUND = 770;
const STAGE_L = 80;
const STAGE_R = W - 80;
const GRAVITY = 2600;
const WALK = 330;
const WALK_BACK = 250;
const JUMP_V = -1000;
const ROUND_TIME = 60;
const WINS_NEEDED = 2;
const SCALE = 1.2; // fighter size; reaches and hit heights scale with it
const GUARD_MAX = 100;
const THROW_RANGE = 140;
const MAX_JUGGLE = 4;
const GETUP = 0.42;
const LEG = 56; // thigh and shin length
const ARM1 = 42; // upper arm
const ARM2 = 40; // forearm
const ZOOM_MIN = 1.04;
const ZOOM_MAX = 1.3;
const CAM_MARGIN = 24; // keeps screen shake from revealing the canvas edge

const MOVES = {
  punch: { startup: 0.06, active: 0.08, recovery: 0.16, dmg: 5, reach: 86, knock: 130, stun: 0.3, hitY: 162, sfx: 'punch', chain: { a: 'cross', b: 'kick' } },
  cross: { startup: 0.07, active: 0.08, recovery: 0.2, dmg: 7, reach: 96, knock: 170, stun: 0.34, hitY: 160, sfx: 'punch', lunge: 150, chain: { b: 'roundhouse' } },
  kick: { startup: 0.12, active: 0.1, recovery: 0.26, dmg: 10, reach: 112, knock: 340, stun: 0.34, hitY: 112, sfx: 'kick' },
  roundhouse: { startup: 0.16, active: 0.1, recovery: 0.34, dmg: 12, reach: 118, knock: 760, stun: 0.5, hitY: 150, sfx: 'kick', launch: -420, wallBounce: true },
  uppercut: { startup: 0.09, active: 0.1, recovery: 0.34, dmg: 9, reach: 80, knock: 110, stun: 0.6, hitY: 196, sfx: 'kick', launch: -1050, jumpCancel: true, antiAir: true },
  sweep: { startup: 0.1, active: 0.12, recovery: 0.34, dmg: 8, reach: 124, knock: 160, stun: 0.4, hitY: 16, sfx: 'kick', knockdown: true },
  airkick: { startup: 0.05, active: 0.3, recovery: 0.08, dmg: 9, reach: 104, knock: 300, stun: 0.34, hitY: 60, sfx: 'kick', air: true },
  throw: { startup: 0.08, active: 0.04, recovery: 0.3 },
  special: { startup: 0.28, active: 0.02, recovery: 0.32 },
};

/* ------------------------------------------------------------------- Look */

// Everything below is presentation only; the simulation never reads it.
const BLEED = 120; // stage art extends past the frame so shake and camera roll never show an edge
const SUN = [W / 2, 420]; // the setting sun is the key light for the whole stage
const RIM = '#ffb987'; // warm rim light from the sun
const BOUNCE = '#8f7cff'; // cool sky bounce on the shadow side
const INK = '#0d0612';
const HAIR_L = '#3a2a42';
const HAIR_D = '#150e1b';
const GUARD_SPARK = '#7dd3fc';
const TRAIL_LIFE = 0.11;
const GHOST_LIFE = 0.16;
const IMPACT = 0.07; // impact-frame length on heavy hits
const WHITE = [1, 1, 1];

// Grade for the WebGL post pass: warm highlights, violet shadows, lanterns and sparks bloom.
const POST = {
  bloom: 0.7,
  threshold: 0.62,
  knee: 0.3,
  exposure: 1.03,
  contrast: 1.08,
  saturation: 1.1,
  shoulder: 0.8,
  vignette: 0.42,
  aberration: 0.0014,
  grain: 0.035,
  shadows: [0.035, 0.0, 0.075],
  highlights: [0.06, 0.025, -0.035],
};

// The hand or foot that leads each strike, for motion smears.
const STRIKER = { punch: 'handF', cross: 'handB', kick: 'footF', roundhouse: 'footF', uppercut: 'handF', sweep: 'footF', airkick: 'footF' };
const GHOST_MOVES = new Set(['cross', 'roundhouse', 'uppercut', 'airkick']);

// Spiky hair outline around the head centre (fighter faces +x).
const HAIR = [[17, -7], [15, -17], [7, -24], [3, -33], [-5, -26], [-13, -32], [-16, -21], [-29, -20], [-21, -10], [-31, -4], [-20, 1], [-17, 12], [-9, 5], [1, -5]];

// Hex colour blend (t = 0 → a, 1 → b).
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

const rgb01 = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// Cel-shading ramp per fighter: lit / shadow pairs, back limbs a step darker for depth.
function palette(color) {
  const top = shade(color, -0.32);
  const leg = shade(color, -0.55);
  return {
    topL: top,
    topD: mix(shade(color, -0.66), '#2a1150', 0.35),
    topHi: mix(color, '#ffffff', 0.35),
    legL: leg,
    legD: mix(shade(color, -0.8), '#170a2c', 0.4),
    legBL: shade(leg, -0.25),
    legBD: mix(shade(color, -0.86), '#120824', 0.4),
    accL: mix(color, '#ffffff', 0.12),
    accD: mix(shade(color, -0.45), '#3a1060', 0.3),
    accBL: shade(color, -0.2),
    accBD: mix(shade(color, -0.6), '#2a0c4a', 0.3),
    skinL: '#f4c6a0',
    skinD: '#b57472',
    skinBL: '#d9a382',
    skinBD: '#93585e',
  };
}

// Draw at a fraction of the size and let the upscale blur it: cheap depth of field for static art.
function soft(w, h, k, draw) {
  const c = makeCanvas(Math.ceil(w * k), Math.ceil(h * k));
  const g = c.getContext('2d');
  g.scale(k, k);
  draw(g);
  return c;
}

// Closed polygon with rounded corners, offset by (dx, dy); adds to the current path.
function roundPoly(ctx, pts, r, dx, dy) {
  const n = pts.length;
  const last = pts[n - 1];
  ctx.moveTo((pts[0][0] + last[0]) / 2 + dx, (pts[0][1] + last[1]) / 2 + dy);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    ctx.arcTo(a[0] + dx, a[1] + dy, (a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dy, r);
  }
  ctx.closePath();
}

function hairPath(ctx, head, dx, dy) {
  const hx = head[0] + dx;
  const hy = head[1] + dy;
  ctx.moveTo(hx + HAIR[0][0], hy + HAIR[0][1]);
  for (let k = 1; k < HAIR.length; k++) ctx.lineTo(hx + HAIR[k][0], hy + HAIR[k][1]);
  ctx.closePath();
}

// Parallelogram path whose bottom edge is shifted sideways by skew * h.
function slant(ctx, x, y, w, h, skew) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w + skew * h, y + h);
  ctx.lineTo(x + skew * h, y + h);
  ctx.closePath();
}

// HUD lettering with an optional dark keyline (crisper than a blurred glow).
function label(ctx, str, x, y, { size = 24, fill = '#fff', stroke = 'rgba(5,3,12,0.85)', sw = 0, align = 'center', weight = 700, spacing = 0, alpha = 1 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px "${HUD_FONT}", system-ui, sans-serif`;
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (sw) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = sw;
    ctx.strokeStyle = stroke;
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function textWidth(ctx, str, size, spacing = 0, weight = 700) {
  ctx.save();
  ctx.font = `${weight} ${size}px "${HUD_FONT}", system-ui, sans-serif`;
  if (spacing) ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

// Four-point flare: long arm l1 along angle a, short arm l2 across it.
function flare(ctx, x, y, l1, l2, w, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts = [[l1, 0], [w, w], [0, l2], [-w, w], [-l1, 0], [-w, -w], [0, -l2], [w, -w]];
  ctx.beginPath();
  pts.forEach(([u, v], i) => {
    const px = x + c * u - s * v;
    const py = y + s * u + c * v;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
}

// Tapered cloth strip along a quadratic curve (belt and headband tails).
function ribbon(ctx, x0, y0, cx, cy, x1, y1, w0, w1, color, outline) {
  const N = 6;
  const side = [];
  const back = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const u = 1 - t;
    const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
    const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
    let tx = 2 * u * (cx - x0) + 2 * t * (x1 - cx);
    let ty = 2 * u * (cy - y0) + 2 * t * (y1 - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const w = (w0 + (w1 - w0) * t) / 2;
    side.push(x - ty * w, y + tx * w);
    back.push(x + ty * w, y - tx * w);
  }
  ctx.beginPath();
  ctx.moveTo(side[0], side[1]);
  for (let k = 2; k < side.length; k += 2) ctx.lineTo(side[k], side[k + 1]);
  for (let k = back.length - 2; k >= 0; k -= 2) ctx.lineTo(back[k], back[k + 1]);
  ctx.closePath();
  if (outline) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.fill();
}

function speedRays(n) {
  const rays = [];
  for (let i = 0; i < n; i++) rays.push({ a: rand(TAU), w: rand(0.003, 0.011), d: rand(0.8, 1.6) });
  return rays;
}

// Frozen copy of a fighter's skeleton and placement, for afterimages.
function snapshot(f) {
  const d = {};
  for (const k in f.d) d[k] = [f.d[k][0], f.d[k][1]];
  return { d, x: f.x, y: f.y, facing: f.facing, tilt: f.tilt, spinX: f.spinX, sq: f.sq };
}

// Torso, neck and boot geometry derived from a solved skeleton (local space).
function bodyGeom(d) {
  const sx = d.neck[0] - d.hip[0];
  const sy = d.neck[1] - d.hip[1];
  const sl = Math.hypot(sx, sy) || 1;
  const ux = sx / sl;
  const uy = sy / sl;
  // u runs up the spine from the hips, v across it toward the chest.
  const at = (u, v) => [d.hip[0] + ux * u - uy * v, d.hip[1] + uy * u + ux * v];
  const top = sl - 4;
  return {
    sl,
    at,
    torso: [at(-4, -15), at(top, -21), at(top, 21), at(-4, 15)],
    neckTop: [lerp(d.neck[0], d.head[0], 0.6), lerp(d.neck[1], d.head[1], 0.6)],
    boots: [
      [d.kneeB, d.footB],
      [d.kneeF, d.footF],
    ].map(([k, f]) => ({ x: f[0] + 6, y: f[1] - 4, a: Math.atan2(f[1] - k[1], f[0] - k[0]) - Math.PI / 2 })),
  };
}

// Bones as [from, to, width]; thighs and upper arms are thicker than shins and forearms.
function limbSegs(d, geo) {
  return [
    [d.neck, geo.neckTop, 12],
    [d.sB, d.elbowB, 14],
    [d.elbowB, d.handB, 12],
    [d.hip, d.kneeB, 22],
    [d.kneeB, d.footB, 17],
    [d.hip, d.kneeF, 22],
    [d.kneeF, d.footF, 17],
    [d.sF, d.elbowF, 14],
    [d.elbowF, d.handF, 12],
  ];
}

// Drifting petals and embers at three depths: 0 behind the rail, 1 with the fighters, 2 near the lens.
function makeMotes() {
  const list = [];
  const add = (kind, depth, n) => {
    for (let k = 0; k < n; k++) {
      const ember = kind === 'ember';
      const fg = depth === 2;
      list.push({
        kind,
        depth,
        x: rand(-BLEED, W + BLEED),
        y: ember ? rand(200, H) : rand(-40, H),
        vx: ember ? rand(-12, 12) : rand(-60, -20) * (fg ? 2.2 : 1),
        vy: ember ? -rand(18, 46) : rand(26, 60) * (fg ? 2 : 1),
        sway: ember ? rand(6, 16) : rand(14, 30),
        rot: rand(TAU),
        vr: rand(-3, 3),
        size: ember ? rand(1.4, 3) : fg ? rand(14, 22) : rand(3.5, 6.5) * (depth ? 1.15 : 0.8),
        ph: rand(TAU),
      });
    }
  };
  add('petal', 0, 14);
  add('petal', 1, 14);
  add('petal', 2, 5);
  add('ember', 0, 12);
  add('ember', 1, 16);
  return list;
}

/* ------------------------------------------------------------------ Stage */

// Sky with the setting sun and soft, sun-lit cloud banks. Pinned behind everything.
function buildSky() {
  const w = W + BLEED * 2;
  const h = H + BLEED * 2;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.translate(BLEED, BLEED);
  const sky = g.createLinearGradient(0, -BLEED, 0, 660);
  sky.addColorStop(0, '#070418');
  sky.addColorStop(0.28, '#1c0a36');
  sky.addColorStop(0.55, '#541542');
  sky.addColorStop(0.78, '#a8343f');
  sky.addColorStop(0.92, '#dc6a46');
  sky.addColorStop(1, '#ee9258');
  g.fillStyle = sky;
  g.fillRect(-BLEED, -BLEED, w, h);

  const rnd = mulberry32(3);
  for (let k = 0; k < 170; k++) {
    const y = -BLEED + rnd() * 420;
    const fade = 1 - (y + BLEED) / 420;
    g.fillStyle = `rgba(255,236,250,${((0.15 + rnd() * 0.6) * fade).toFixed(3)})`;
    const s = rnd() < 0.12 ? 2.2 : 1.2;
    g.fillRect(-BLEED + rnd() * w, y, s, s);
  }

  // Atmospheric glow around the sun
  g.globalCompositeOperation = 'lighter';
  const halo = g.createRadialGradient(SUN[0], SUN[1], 0, SUN[0], SUN[1], 860);
  halo.addColorStop(0, 'rgba(255,176,110,0.55)');
  halo.addColorStop(0.25, 'rgba(255,110,90,0.22)');
  halo.addColorStop(1, 'rgba(255,80,100,0)');
  g.fillStyle = halo;
  g.fillRect(-BLEED, -BLEED, w, h);
  g.globalCompositeOperation = 'source-over';

  // Sun disc with a hot core so the bloom pass picks it up
  const sun = g.createRadialGradient(SUN[0], SUN[1] - 24, 8, SUN[0], SUN[1], 168);
  sun.addColorStop(0, '#fffdf0');
  sun.addColorStop(0.5, '#ffe7b0');
  sun.addColorStop(0.86, '#ffb675');
  sun.addColorStop(1, 'rgba(255,150,100,0)');
  g.fillStyle = sun;
  g.beginPath();
  g.arc(SUN[0], SUN[1], 168, 0, TAU);
  g.fill();

  // Cloud banks, drawn small and upscaled so their edges come out soft; undersides catch the sun.
  const clouds = soft(w, h, 0.25, (cg) => {
    cg.translate(BLEED, BLEED);
    const r2 = mulberry32(21);
    for (const [cx, cy, len, th] of [[320, 200, 760, 26], [1260, 160, 820, 22], [800, 300, 1200, 16], [140, 380, 560, 15], [1440, 350, 640, 17], [700, 110, 560, 13]]) {
      for (let k = 0; k < 16; k++) {
        const x = cx + (r2() - 0.5) * len;
        const y = cy + (r2() - 0.5) * th * 1.6;
        const rx = 60 + r2() * 130;
        const ry = th * (0.5 + r2() * 0.7);
        const near = 1 - Math.min(1, Math.hypot(x - SUN[0], y - SUN[1]) / 900);
        const grad = cg.createLinearGradient(0, y - ry, 0, y + ry);
        grad.addColorStop(0, 'rgba(44,14,54,0.78)');
        grad.addColorStop(1, `rgba(255,${Math.round(120 + near * 80)},${Math.round(100 + near * 50)},${(0.3 + near * 0.5).toFixed(2)})`);
        cg.fillStyle = grad;
        cg.beginPath();
        cg.ellipse(x, y, rx, ry, 0, 0, TAU);
        cg.fill();
      }
    }
  });
  g.drawImage(clouds, -BLEED, -BLEED, w, h);
  return c;
}

// Crepuscular rays fanning out of the sun (additive, slowly breathing).
function buildRays() {
  const w = W + BLEED * 2;
  const h = H + BLEED * 2;
  return soft(w, h, 0.25, (g) => {
    g.translate(BLEED, BLEED);
    const rnd = mulberry32(17);
    for (let k = 0; k < 22; k++) {
      const a = rnd() * TAU;
      const spread = 0.02 + rnd() * 0.06;
      const len = 700 + rnd() * 500;
      const grad = g.createRadialGradient(SUN[0], SUN[1], 120, SUN[0], SUN[1], len);
      grad.addColorStop(0, `rgba(255,196,140,${(0.12 + rnd() * 0.14).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(255,150,120,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(SUN[0], SUN[1]);
      g.arc(SUN[0], SUN[1], len, a - spread, a + spread);
      g.closePath();
      g.fill();
    }
  });
}

// Distant ridge and towers washed into the horizon haze, drawn soft for depth of field.
function buildFar() {
  const w = W + BLEED * 2;
  return soft(w, H, 0.5, (g) => {
    g.translate(BLEED, 0);
    const rnd = mulberry32(5);
    g.fillStyle = '#44173f';
    g.beginPath();
    g.moveTo(-BLEED, 700);
    for (let x = -BLEED; x <= W + BLEED; x += 30) g.lineTo(x, 488 + Math.sin(x * 0.0042) * 36 + Math.sin(x * 0.013 + 2) * 18 + rnd() * 8);
    g.lineTo(W + BLEED, 700);
    g.closePath();
    g.fill();
    for (let x = -BLEED; x < W + BLEED; x += 16 + rnd() * 28) {
      const tw = 12 + rnd() * 26;
      const th = 24 + rnd() * rnd() * 170 * (0.35 + 0.65 * Math.min(1, Math.abs(x - SUN[0]) / 600));
      g.fillStyle = '#331034';
      g.fillRect(x, 610 - th, tw, th + 90);
      if (rnd() < 0.3) g.fillRect(x + tw / 2 - 1, 610 - th - 18, 2, 18);
      g.fillStyle = 'rgba(255,196,150,0.55)';
      for (let wy = 610 - th + 5; wy < 600; wy += 8) if (rnd() < 0.18) g.fillRect(x + 2 + rnd() * (tw - 5), wy, 2, 2);
    }
    // Haze: thicker toward the horizon and around the sun
    g.globalCompositeOperation = 'source-atop';
    const haze = g.createLinearGradient(0, 400, 0, 640);
    haze.addColorStop(0, 'rgba(160,60,100,0.25)');
    haze.addColorStop(1, 'rgba(236,116,98,0.8)');
    g.fillStyle = haze;
    g.fillRect(-BLEED, 0, w, H);
    const glow = g.createRadialGradient(SUN[0], SUN[1] + 100, 0, SUN[0], SUN[1] + 100, 520);
    glow.addColorStop(0, 'rgba(255,190,130,0.6)');
    glow.addColorStop(1, 'rgba(255,190,130,0)');
    g.fillStyle = glow;
    g.fillRect(-BLEED, 0, w, H);
  });
}

function pagoda(g, cx, base, s) {
  for (let k = 0; k < 4; k++) {
    const wd = (200 - k * 38) * s;
    const y = base - k * 64 * s;
    const L = cx - wd / 2;
    const R = cx + wd / 2;
    // Wall with lit paper windows
    g.fillStyle = '#240a1c';
    g.fillRect(L + 16 * s, y - 36 * s, wd - 32 * s, 36 * s);
    g.fillStyle = 'rgba(255,182,112,0.8)';
    for (let wx = L + 26 * s; wx < R - 32 * s; wx += 15 * s) g.fillRect(wx, y - 28 * s, 7 * s, 15 * s);
    // Sweeping eave, its ridge catching the sun
    const eave = () => {
      g.moveTo(L - 36 * s, y - 52 * s);
      g.quadraticCurveTo(L + 6 * s, y - 38 * s, cx - wd * 0.22, y - 60 * s);
      g.lineTo(cx + wd * 0.22, y - 60 * s);
      g.quadraticCurveTo(R - 6 * s, y - 38 * s, R + 36 * s, y - 52 * s);
    };
    g.fillStyle = '#15040e';
    g.beginPath();
    eave();
    g.lineTo(R + 18 * s, y - 34 * s);
    g.lineTo(L - 18 * s, y - 34 * s);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,160,116,0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    eave();
    g.stroke();
    g.fillStyle = '#ffb066';
    g.fillRect(L - 35 * s, y - 50 * s, 4 * s, 7 * s);
    g.fillRect(R + 31 * s, y - 50 * s, 4 * s, 7 * s);
  }
  // Finial
  g.fillStyle = '#15040e';
  const peak = base - 3 * 64 * s - 60 * s;
  g.fillRect(cx - 2 * s, peak - 50 * s, 4 * s, 54 * s);
  for (let k = 0; k < 4; k++) g.fillRect(cx - 7 * s, peak - 40 * s + k * 10 * s, 14 * s, 3 * s);
}

// City blocks, neon and two pagodas, rim-lit by the sun and sunk into street haze.
function buildMid() {
  const w = W + BLEED * 2;
  return soft(w, H, 0.75, (g) => {
    g.translate(BLEED, 0);
    const rnd = mulberry32(11);
    const base = 650;
    for (let x = -BLEED; x < W + BLEED; ) {
      const bw = 50 + Math.floor(rnd() * 46);
      // Blocks near the sun stay low so it can set between them.
      const away = Math.min(1, Math.abs(x + bw / 2 - SUN[0]) / 700);
      const bh = 60 + rnd() * 190 * (0.3 + 0.7 * away);
      const top = base - bh;
      const body = g.createLinearGradient(0, top, 0, base);
      body.addColorStop(0, '#36122c');
      body.addColorStop(1, '#1c0817');
      g.fillStyle = body;
      g.fillRect(x, top, bw, bh + 40);
      g.fillStyle = 'rgba(255,150,112,0.55)';
      g.fillRect(x + bw / 2 < SUN[0] ? x + bw - 2 : x, top, 2, bh);
      g.fillStyle = 'rgba(255,176,128,0.5)';
      g.fillRect(x, top, bw, 1.5);
      for (let wy = top + 10; wy < base - 12; wy += 14) {
        for (let wx = x + 6; wx < x + bw - 9; wx += 11) {
          const r = rnd();
          if (r < 0.2) {
            g.fillStyle = r < 0.12 ? 'rgba(255,198,132,0.85)' : r < 0.16 ? 'rgba(150,205,255,0.6)' : 'rgba(255,120,160,0.6)';
            g.fillRect(wx, wy, 5, 7);
          }
        }
      }
      if (rnd() < 0.35) {
        // Water tank on stilts
        const tx = x + 8 + rnd() * (bw - 30);
        g.fillStyle = '#28091f';
        g.fillRect(tx, top - 22, 18, 14);
        g.fillRect(tx + 2, top - 8, 2, 8);
        g.fillRect(tx + 14, top - 8, 2, 8);
      }
      if (rnd() < 0.3) {
        g.fillStyle = '#28091f';
        g.fillRect(x + bw * 0.7, top - 44, 2, 44);
      }
      if (rnd() < 0.32) {
        // Vertical neon sign
        const nx = x + (rnd() < 0.5 ? 4 : bw - 16);
        const ny = top + 14 + rnd() * 30;
        g.fillStyle = ['#ff4fa3', '#3ee8ff', '#ffd166', '#b46bff'][Math.floor(rnd() * 4)];
        g.globalAlpha = 0.22;
        g.fillRect(nx - 5, ny - 5, 22, 62);
        g.globalAlpha = 1;
        g.fillRect(nx, ny, 12, 52);
        g.fillStyle = 'rgba(40,8,30,0.75)';
        for (let k = 0; k < 4; k++) g.fillRect(nx + 3, ny + 4 + k * 12, 6, 7);
      }
      x += bw + 4 + Math.floor(rnd() * 10);
    }
    pagoda(g, 220, 660, 1.05);
    pagoda(g, 1380, 660, 1.05);
    // Street haze rising between the blocks
    g.globalCompositeOperation = 'source-atop';
    const haze = g.createLinearGradient(0, 440, 0, 660);
    haze.addColorStop(0, 'rgba(255,120,110,0)');
    haze.addColorStop(1, 'rgba(250,120,110,0.55)');
    g.fillStyle = haze;
    g.fillRect(-BLEED, 0, w, H);
  });
}

// Horizontal haze band, stretched across the gap between the city and the crowd.
function buildHaze() {
  const c = makeCanvas(8, 256);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,130,120,0)');
  grad.addColorStop(0.62, 'rgba(255,130,120,0.3)');
  grad.addColorStop(1, 'rgba(255,130,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  return c;
}

// Three rows of backlit spectators, each its own strip so rows can bounce independently.
function buildCrowd() {
  const rnd = mulberry32(7);
  const rows = [];
  const body = ['#3a1430', '#270b22', '#180616'];
  const rim = [0.32, 0.45, 0.55];
  const w = W + BLEED * 2;
  for (let row = 0; row < 3; row++) {
    const c = makeCanvas(w, 140);
    const g = c.getContext('2d');
    g.translate(BLEED, 0);
    g.lineCap = 'round';
    const base = 132;
    for (let x = -BLEED - 10 + row * 13; x < W + BLEED + 20; x += 22 + rnd() * 9) {
      const h = rnd() * 14;
      const s = 0.9 + rnd() * 0.22;
      const arm = rnd() < 0.3;
      const ax = 14 + rnd() * 10;
      const side = x < SUN[0] ? 1 : -1;
      const person = (ox, oy, col) => {
        g.fillStyle = col;
        g.strokeStyle = col;
        g.beginPath();
        g.arc(x + ox, base - 62 - h + oy, 11 * s, 0, TAU);
        g.fill();
        g.beginPath();
        g.roundRect(x - 17 * s + ox, base - 50 - h + oy, 34 * s, 80, 11);
        g.fill();
        if (arm) {
          g.lineWidth = 7;
          g.beginPath();
          g.moveTo(x + 11 + ox, base - 42 - h + oy);
          g.lineTo(x + ax + ox, base - 90 - h + oy);
          g.stroke();
        }
      };
      // Backlit by the sun: a warm rim peeks out above and on the sun side of each silhouette.
      person(side * 1.6, -2.2, `rgba(255,150,110,${rim[row]})`);
      person(0, 0, body[row]);
      if (arm && rnd() < 0.55) {
        g.fillStyle = ['#38d9ff', '#ffd166', '#ff5fc8', '#ffffff'][Math.floor(rnd() * 4)];
        g.fillRect(x + ax - 2, base - 110 - h, 4, 20);
      }
    }
    rows.push(c);
  }
  return rows;
}

// Lacquered rooftop railing in front of the crowd, with lamp posts.
const RAIL_Y = 620;
const RAIL_POSTS = [];
for (let x = -BLEED + 20; x < W + BLEED; x += 150) RAIL_POSTS.push(x);

function buildRail() {
  const w = W + BLEED * 2;
  const c = makeCanvas(w, 140);
  const g = c.getContext('2d');
  g.translate(BLEED, -RAIL_Y);
  const lacquer = (y0, y1) => {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, '#7a1a26');
    gr.addColorStop(0.35, '#4a0d18');
    gr.addColorStop(1, '#22050c');
    return gr;
  };
  const wall = g.createLinearGradient(0, 684, 0, 760);
  wall.addColorStop(0, '#2a0a16');
  wall.addColorStop(1, '#0e0308');
  g.fillStyle = wall;
  g.fillRect(-BLEED, 684, w, 76);
  g.fillStyle = 'rgba(255,160,120,0.35)';
  g.fillRect(-BLEED, 684, w, 1.5);
  g.fillStyle = '#2c0810';
  for (let x = -BLEED; x < W + BLEED; x += 22) g.fillRect(x, 656, 4, 28);
  g.fillStyle = lacquer(646, 656);
  g.fillRect(-BLEED, 646, w, 10);
  g.fillStyle = lacquer(674, 680);
  g.fillRect(-BLEED, 674, w, 6);
  g.fillStyle = 'rgba(255,170,120,0.6)';
  g.fillRect(-BLEED, 646, w, 1.5);
  for (const x of RAIL_POSTS) {
    g.fillStyle = lacquer(636, 690);
    g.fillRect(x - 8, 638, 16, 50);
    g.fillStyle = 'rgba(255,160,110,0.5)';
    g.fillRect(x < SUN[0] ? x + 6 : x - 8, 638, 2, 50);
    g.fillStyle = '#c99a4a';
    g.fillRect(x - 11, 632, 22, 6);
    g.fillStyle = '#ffe2b0';
    g.beginPath();
    g.arc(x, 627, 4.5, 0, TAU);
    g.fill();
  }
  return c;
}

// Paper lantern, drawn at 2x for crisp edges.
function buildLantern() {
  const c = makeCanvas(120, 192);
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.strokeStyle = '#1a0510';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(30, 0);
  g.lineTo(30, 14);
  g.stroke();
  const body = g.createRadialGradient(27, 44, 3, 30, 50, 32);
  body.addColorStop(0, '#fff4cf');
  body.addColorStop(0.35, '#ffb15a');
  body.addColorStop(0.75, '#e0342c');
  body.addColorStop(1, '#7a0a1c');
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(30, 50, 24, 32, 0, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(90,8,20,0.5)';
  g.lineWidth = 1.2;
  for (const k of [-16, -8, 8, 16]) {
    g.beginPath();
    g.ellipse(30, 50, Math.abs(k), 32, 0, 0, TAU);
    g.stroke();
  }
  for (const y of [30, 40, 60, 70]) {
    const hw = 24 * Math.sqrt(1 - ((y - 50) / 32) ** 2);
    g.beginPath();
    g.ellipse(30, y, hw, 2.5, 0, 0, Math.PI);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.ellipse(21, 38, 4, 9, -0.3, 0, TAU);
  g.fill();
  const brass = g.createLinearGradient(18, 0, 42, 0);
  brass.addColorStop(0, '#7a5520');
  brass.addColorStop(0.5, '#f2c46a');
  brass.addColorStop(1, '#7a5520');
  g.fillStyle = brass;
  g.beginPath();
  g.roundRect(19, 14, 22, 7, 2);
  g.roundRect(19, 79, 22, 7, 2);
  g.fill();
  g.strokeStyle = '#c42030';
  g.lineWidth = 1.2;
  g.beginPath();
  for (let k = -4; k <= 4; k += 2) {
    g.moveTo(30, 86);
    g.lineTo(30 + k, 96);
  }
  g.stroke();
  return c;
}

// Arena floor, drawn in world space from FLOOR_Y down. A base layer goes under the
// fighter reflections and a top coat (grout and a fade) goes over them.
const FLOOR_Y = 690;
const FS = 2; // floor art is drawn at 2x: it sits right under the fighters
const floorX = (k, y) => W / 2 + k * (60 + ((y - 704) * 130) / 196);
const FLOOR_ROWS = [0, 1, 2, 3, 4, 5, 6, 7].map((r) => 704 + Math.pow(r / 5, 1.6) * 196);

function buildFloor() {
  const w = W + BLEED * 2;
  const h = H - FLOOR_Y + BLEED;
  const base = makeCanvas(w * FS, h * FS);
  const coat = makeCanvas(w * FS, h * FS);
  const g = base.getContext('2d');
  g.scale(FS, FS);
  g.translate(BLEED, -FLOOR_Y);
  // Back lip of the roof, its edge catching the sun
  const lip = g.createLinearGradient(0, FLOOR_Y, 0, 704);
  lip.addColorStop(0, '#3c0f20');
  lip.addColorStop(0.25, '#1d0611');
  lip.addColorStop(1, '#0c0308');
  g.fillStyle = lip;
  g.fillRect(-BLEED, FLOOR_Y, w, 14);
  g.fillStyle = 'rgba(255,170,120,0.6)';
  g.fillRect(-BLEED, FLOOR_Y, w, 1.5);
  g.fillStyle = 'rgba(255,196,130,0.75)';
  for (let x = -140; x < W + BLEED; x += 80) g.fillRect(x, FLOOR_Y + 5, 10, 3);
  // Polished stone
  const floor = g.createLinearGradient(0, 704, 0, H + BLEED);
  floor.addColorStop(0, '#3a1222');
  floor.addColorStop(0.22, '#240a17');
  floor.addColorStop(1, '#090207');
  g.fillStyle = floor;
  g.fillRect(-BLEED, 704, w, H + BLEED - 704);
  const rnd = mulberry32(9);
  for (let r = 0; r < FLOOR_ROWS.length - 1; r++) {
    const y0 = FLOOR_ROWS[r];
    const y1 = FLOOR_ROWS[r + 1];
    for (let k = -18; k < 18; k++) {
      const v = rnd();
      g.fillStyle = v < 0.5 ? `rgba(255,190,200,${(v * 0.06).toFixed(3)})` : `rgba(0,0,0,${((v - 0.5) * 0.24).toFixed(3)})`;
      g.beginPath();
      g.moveTo(floorX(k, y0), y0);
      g.lineTo(floorX(k + 1, y0), y0);
      g.lineTo(floorX(k + 1, y1), y1);
      g.lineTo(floorX(k, y1), y1);
      g.closePath();
      g.fill();
    }
  }
  // Reflected sky and a long streak of reflected sun
  g.globalCompositeOperation = 'lighter';
  const sheen = g.createLinearGradient(0, 704, 0, 820);
  sheen.addColorStop(0, 'rgba(255,120,110,0.24)');
  sheen.addColorStop(1, 'rgba(255,120,110,0)');
  g.fillStyle = sheen;
  g.fillRect(-BLEED, 704, w, 116);
  g.save();
  g.translate(W / 2, 706);
  g.scale(1, 2.4);
  const sun = g.createRadialGradient(0, 0, 0, 0, 0, 220);
  sun.addColorStop(0, 'rgba(255,196,140,0.42)');
  sun.addColorStop(1, 'rgba(255,140,110,0)');
  g.fillStyle = sun;
  g.fillRect(-220, 0, 440, 220);
  g.restore();

  const t = coat.getContext('2d');
  t.scale(FS, FS);
  t.translate(BLEED, -FLOOR_Y);
  const fade = t.createLinearGradient(0, GROUND, 0, H);
  fade.addColorStop(0, 'rgba(18,5,12,0)');
  fade.addColorStop(1, 'rgba(9,2,7,0.62)');
  t.fillStyle = fade;
  t.fillRect(-BLEED, GROUND, w, H + BLEED - GROUND);
  const grid = (dy) => {
    t.beginPath();
    for (let k = -18; k <= 18; k++) {
      t.moveTo(floorX(k, 704), 704 + dy);
      t.lineTo(floorX(k, H + BLEED), H + BLEED + dy);
    }
    for (const y of FLOOR_ROWS) {
      t.moveTo(-BLEED, y + dy);
      t.lineTo(W + BLEED, y + dy);
    }
    t.stroke();
  };
  t.strokeStyle = 'rgba(0,0,0,0.4)';
  t.lineWidth = 1.5;
  grid(0);
  t.strokeStyle = 'rgba(255,160,150,0.08)';
  t.lineWidth = 1;
  grid(1.2);
  // Painted ring line in front of the fighters
  t.beginPath();
  t.moveTo(STAGE_L - 40, GROUND + 28);
  t.lineTo(STAGE_R + 40, GROUND + 28);
  t.strokeStyle = 'rgba(255,170,120,0.16)';
  t.lineWidth = 9;
  t.stroke();
  t.strokeStyle = 'rgba(255,200,150,0.8)';
  t.lineWidth = 2;
  t.stroke();
  return { base, coat };
}

// Out-of-focus lights right in front of the lens, peeking up from the bottom edge.
function buildBokeh() {
  const w = W + BLEED * 2;
  return soft(w, 300, 0.5, (g) => {
    g.translate(BLEED, -760);
    const rnd = mulberry32(31);
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 18; k++) {
      const x = -BLEED + rnd() * w;
      const y = 885 + rnd() * 60;
      const r = 26 + rnd() * 46;
      const col = rnd() < 0.6 ? '255,150,90' : '255,110,160';
      const a = 0.1 + rnd() * 0.12;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${col},${(a * 0.75).toFixed(3)})`);
      grad.addColorStop(0.82, `rgba(${col},${a.toFixed(3)})`);
      grad.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
  });
}

function buildPuff() {
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(214,160,150,1)');
  grad.addColorStop(0.5, 'rgba(190,130,125,0.5)');
  grad.addColorStop(1, 'rgba(190,130,125,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

// Stage art is identical for every match, so it is built once and shared.
let ART = null;
function stageArt() {
  if (ART) return ART;
  const floor = buildFloor();
  ART = {
    sky: buildSky(),
    rays: buildRays(),
    far: buildFar(),
    mid: buildMid(),
    haze: buildHaze(),
    crowd: buildCrowd(),
    rail: buildRail(),
    lantern: buildLantern(),
    floor: floor.base,
    coat: floor.coat,
    bokeh: buildBokeh(),
    puff: buildPuff(),
    petal: soft(64, 40, 0.25, (g) => {
      g.fillStyle = '#ffb7cf';
      g.beginPath();
      g.ellipse(32, 20, 22, 12, 0, 0, TAU);
      g.fill();
    }),
  };
  return ART;
}

const CROWD_ROWS = [652, 678, 704]; // bottom edge of each crowd row
const LANTERNS = [140, 400, 660, 940, 1200, 1460];

/* ------------------------------------------------------------- Skeleton */

// A pose is the seven "driver" points; knees and elbows come from IK.
const KEYS = ['hip', 'neck', 'head', 'footB', 'footF', 'handB', 'handF'];
const P = (hip, neck, head, footB, footF, handB, handF) => ({ hip, neck, head, footB, footF, handB, handF });

const STAND = P([0, -96], [6, -166], [8, -194], [-28, 0], [32, 0], [30, -150], [50, -160]);
const CROUCH = P([-4, -66], [8, -134], [12, -162], [-36, 0], [36, 0], [34, -146], [42, -136]);
const AIR = P([0, -104], [6, -170], [8, -198], [-26, -44], [16, -50], [26, -172], [46, -178]);
const HURT_HIGH = P([-6, -94], [-14, -160], [-22, -184], [-32, 0], [28, 0], [-30, -120], [-6, -112]);
const HURT_LOW = P([-8, -90], [18, -148], [26, -172], [-34, 0], [28, 0], [12, -112], [22, -106]);
const JUGGLE = P([0, -96], [-4, -166], [-8, -192], [-30, -26], [24, -14], [-40, -196], [-16, -206]);
const DOWN = P([0, -96], [4, -168], [6, -196], [6, 0], [16, -6], [14, -118], [24, -136]);
const STAGGER = P([-6, -94], [-14, -162], [-20, -188], [-34, 0], [30, 0], [-40, -200], [44, -210]);
const THROWING = P([6, -98], [24, -168], [30, -194], [-36, 0], [40, 0], [70, -196], [84, -204]);
const WIN = P([0, -98], [4, -170], [10, -200], [-34, 0], [34, 0], [-6, -104], [22, -264]);

// Wind-up and strike frames for every move; recovery blends back to the base.
const ATTACK_POSES = {
  punch: { base: STAND, wind: P([-2, -96], [2, -166], [4, -194], [-28, 0], [32, 0], [30, -150], [34, -156]), hit: P([4, -96], [14, -164], [18, -192], [-30, 0], [34, 0], [24, -152], [100, -162]) },
  cross: { base: STAND, wind: P([-4, -96], [0, -166], [2, -194], [-30, 0], [32, 0], [8, -150], [46, -160]), hit: P([8, -94], [20, -162], [24, -190], [-36, 0], [38, 0], [104, -160], [30, -148]) },
  kick: { base: STAND, wind: P([0, -98], [-2, -166], [-2, -192], [-22, 0], [30, -60], [16, -152], [36, -164]), hit: P([-4, -102], [-12, -164], [-18, -190], [-16, 0], [118, -118], [2, -148], [28, -166]) },
  roundhouse: { base: STAND, wind: P([0, -100], [0, -168], [0, -196], [-20, 0], [10, -70], [-10, -150], [30, -170]), hit: P([-6, -106], [-22, -158], [-30, -182], [-14, 0], [122, -178], [-24, -146], [8, -172]) },
  uppercut: { base: STAND, wind: P([0, -74], [12, -140], [18, -166], [-34, 0], [34, 0], [30, -130], [30, -110]), hit: P([6, -106], [14, -178], [18, -206], [-26, 0], [26, -4], [24, -150], [40, -262]) },
  sweep: { base: CROUCH, wind: CROUCH, hit: P([-14, -48], [6, -104], [14, -130], [-34, 0], [126, -8], [-30, -6], [40, -112]) },
  airkick: { base: AIR, wind: AIR, hit: P([0, -100], [-6, -164], [-10, -190], [-26, -60], [104, -40], [8, -168], [28, -176]) },
  special: { base: STAND, wind: P([-6, -84], [-4, -152], [-2, -180], [-34, 0], [36, 0], [-24, -108], [-14, -112]), hit: P([4, -94], [18, -160], [22, -188], [-36, 0], [40, 0], [92, -150], [96, -140]) },
  throw: { base: STAND, wind: STAND, hit: P([4, -96], [16, -164], [20, -192], [-30, 0], [36, 0], [84, -150], [88, -140]) },
};

function copyPose(p) {
  const o = {};
  for (const k of KEYS) o[k] = [p[k][0], p[k][1]];
  return o;
}

function mixPose(a, b, t) {
  const o = {};
  for (const k of KEYS) o[k] = [lerp(a[k][0], b[k][0], t), lerp(a[k][1], b[k][1], t)];
  return o;
}

// Two-bone IK: returns the middle joint; clamps `b` in place if out of reach.
// s = +1 bends to the right of a→b (elbows), -1 to the left (knees forward).
function ik(a, b, l1, l2, s) {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  let d = Math.hypot(dx, dy) || 1;
  const max = l1 + l2 - 0.5;
  if (d > max) {
    b[0] = a[0] + (dx / d) * max;
    b[1] = a[1] + (dy / d) * max;
    dx = b[0] - a[0];
    dy = b[1] - a[1];
    d = max;
  }
  const x = (d * d + l1 * l1 - l2 * l2) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const ux = dx / d;
  const uy = dy / d;
  return [a[0] + ux * x - uy * h * s, a[1] + uy * x + ux * h * s];
}

/* ------------------------------------------------------------------- Game */

class BattleClash {
  constructor({ players, host }) {
    this.host = host;
    this.art = stageArt();
    this.particles = new Particles();
    this.sparks = [];
    this.dust = [];
    this.flashes = [];
    this.time = 0;
    this.shake = 0;
    this.hitstop = 0;
    this.slowmo = 0;
    this.superFlash = 0;
    this.screenFlash = 0;
    this.zoomKick = 0;
    this.hype = 0;
    this.swing = 0; // extra lantern sway after big hits
    this.focus = null;
    this.focusT = 0;
    this.cam = { x: W / 2, y: H / 2, zoom: ZOOM_MIN };
    this.round = 0;
    this.result = null;
    this.fighters = players.slice(0, 2).map((p, i) => ({
      ...p,
      i,
      wins: 0,
      dealt: 0,
      meter: 0,
      pal: palette(p.color),
    }));
    // Render-only state; the simulation never reads any of it.
    this.vis = this.fighters.map(() => ({ trail: [], ghosts: [], snapT: 0 }));
    this.motes = makeMotes();
    this.punch = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 }; // spring-loaded camera punch
    this.vfx = { flash: 0, flashColor: WHITE, ab: 0, desat: 0 };
    this.post = { flash: 0, flashColor: WHITE, aberration: POST.aberration, desaturate: 0, vignette: POST.vignette };
    this.speed = null; // radial speed lines
    this.impact = 0;
    this.vState = null;
    this.titleKey = '';
    this.titleT = 0;
    this.prevSuper = 0;
    this.startRound();
  }

  startRound() {
    this.round++;
    this.projectiles = [];
    this.state = 'intro';
    this.stateT = 2.2;
    this.clock = ROUND_TIME;
    this.roundWinner = null;
    this.koTitle = '';
    this.slowmo = 0;
    this.focus = null;
    this.fighters.forEach((f, i) => {
      Object.assign(f, {
        x: i === 0 ? 560 : W - 560,
        y: GROUND,
        vx: 0,
        vy: 0,
        facing: i === 0 ? 1 : -1,
        hp: 100,
        shownHp: 100,
        drainT: 0,
        guard: GUARD_MAX,
        guardDelay: 0,
        st: 'idle',
        stT: 0,
        attack: null,
        grab: null,
        buf: null,
        crouch: false,
        onGround: true,
        ko: false,
        koT: 0,
        flash: 0,
        prevUp: true,
        walkT: 0,
        juggles: 0,
        wallBounce: false,
        bounced: false,
        groundBounced: false,
        hurtHigh: true,
        combo: 0,
        comboT: 0,
        comboDmg: 0,
        comboPop: 0,
        callout: null,
        j: copyPose(STAND),
        d: null,
        tilt: 0,
        sq: 0,
        spinX: 1,
        cloth: 0,
        clothV: 0,
        brain: null,
      });
      this.solve(f);
    });
    this.host.sfx('count');
  }

  update(dt, inputs) {
    this.time += dt;
    this.updateFx(dt);
    this.updateCamera(dt);
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      // Still buffer presses made during the freeze so chains don't drop them.
      for (const f of this.fighters) {
        const inp = inputs[f.i];
        if (!inp || this.state !== 'fight') continue;
        if (inp.aPressed) f.buf = { k: 'a', t: 0.2 };
        else if (inp.bPressed) f.buf = { k: 'b', t: 0.2 };
      }
      return;
    }
    if (this.slowmo > 0) {
      this.slowmo -= dt;
      dt *= 0.3;
    }
    this.particles.update(dt);

    const [a, b] = this.fighters;
    const fighting = this.state === 'fight';

    if (this.state === 'intro') {
      this.stateT -= dt;
      if (this.stateT <= 0.8 && !this.saidGo) {
        this.saidGo = true;
        this.host.sfx('go');
      }
      if (this.stateT <= 0) {
        this.state = 'fight';
        this.saidGo = false;
      }
    } else if (this.state === 'fight') {
      this.clock -= dt;
      if (this.clock <= 0) this.timeOver();
    } else if (this.state === 'ko') {
      this.stateT -= dt;
      const w = this.roundWinner;
      if (w && this.stateT < 2.4 && !w.ko && w.onGround && w.st !== 'win') {
        this.releaseGrab(w);
        w.st = 'win';
        w.attack = null;
      }
      if (this.stateT <= 0) {
        const champ = this.fighters.find((f) => f.wins >= WINS_NEEDED);
        if (champ) this.finish(champ);
        else this.startRound();
      }
    }

    for (const f of this.fighters) {
      const o = f === a ? b : a;
      const inp = fighting ? (inputs[f.i] ?? (f.cpu ? this.bot(f, o, dt) : IDLE)) : IDLE;
      this.updateFighter(f, o, inp, dt, fighting);
    }

    // Keep fighters from overlapping (you can step over someone lying down).
    const solid = (f) => !f.ko && f.st !== 'down' && f.st !== 'grabbed';
    if (a && b && solid(a) && solid(b)) {
      const gap = Math.abs(a.x - b.x);
      const vertical = Math.abs(a.y - b.y) < 160;
      if (gap < 92 && vertical) {
        const push = (92 - gap) / 2;
        const s = a.x <= b.x ? -1 : 1;
        a.x = clamp(a.x + s * push, STAGE_L, STAGE_R);
        b.x = clamp(b.x - s * push, STAGE_L, STAGE_R);
      }
    }
    this.updateProjectiles(dt);
  }

  // Effects run in real time so sparks and the camera keep moving during hit-stop.
  updateFx(dt) {
    this.shake = Math.max(0, this.shake - dt * 45);
    this.superFlash = Math.max(0, this.superFlash - dt * 1.6);
    this.screenFlash = Math.max(0, this.screenFlash - dt * 2.5);
    this.zoomKick = Math.max(0, this.zoomKick - dt * 0.4);
    this.hype = Math.max(0, this.hype - dt * 0.18);
    this.swing = Math.max(0, this.swing - dt * 0.12);
    this.focusT -= dt;
    this.sparks = this.sparks.filter((s) => (s.t += dt) < s.max);
    for (const d of this.dust) {
      d.life -= dt;
      const k = Math.max(0, 1 - dt * 3);
      d.vx *= k;
      d.vy *= k;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.r += dt * 26;
    }
    this.dust = this.dust.filter((d) => d.life > 0);
    if (Math.random() < 0.02 + this.hype * 0.35) this.flashes.push({ x: rand(0, W), y: rand(560, 680), t: 0.1 });
    this.flashes = this.flashes.filter((fl) => (fl.t -= dt) > 0);
    for (const f of this.fighters) {
      if (f.drainT > 0) f.drainT -= dt;
      else f.shownHp = Math.max(f.hp, f.shownHp - dt * 45);
      f.comboT -= dt;
      f.comboPop = Math.max(0, f.comboPop - dt * 5);
      if (f.callout) f.callout.t -= dt;
    }
    this.updateVisuals(dt);
  }

  updateCamera(dt) {
    const [a, b] = this.fighters;
    const cam = this.cam;
    let tx = b ? (a.x + b.x) / 2 : a.x;
    const gap = b ? Math.abs(a.x - b.x) : 0;
    let tz = ZOOM_MAX - ((gap - 180) / 900) * (ZOOM_MAX - ZOOM_MIN);
    tz = clamp(Math.min(tz, W / (gap + 260)), ZOOM_MIN, ZOOM_MAX);
    if (this.focus && this.focusT > 0) {
      tx = lerp(tx, this.focus.x, 0.6);
      tz = Math.min(ZOOM_MAX + 0.1, tz + 0.14);
    }
    tz += this.zoomKick;
    const k = 1 - Math.exp(-dt * 4.5);
    cam.zoom = lerp(cam.zoom, tz, k);
    cam.x = lerp(cam.x, tx, k);
    const half = W / (2 * cam.zoom);
    cam.x = clamp(cam.x, half + CAM_MARGIN, W - half - CAM_MARGIN);
    cam.y = H - H / (2 * cam.zoom) - CAM_MARGIN;
  }

  updateFighter(f, o, inp, dt, fighting) {
    f.flash -= dt;
    if (f.buf && (f.buf.t -= dt) <= 0) f.buf = null;
    // Buffer presses made mid-move so chains and reversals come out on time.
    if (fighting && f.st !== 'idle') {
      if (inp.aPressed) f.buf = { k: 'a', t: 0.2 };
      else if (inp.bPressed) f.buf = { k: 'b', t: 0.2 };
    }
    f.guardDelay -= dt;
    if (f.guardDelay <= 0) f.guard = Math.min(GUARD_MAX, f.guard + 28 * dt);
    const up = inp.y < -0.55;
    f.stT -= dt;
    if (f.st !== 'idle') f.crouch = false;

    switch (f.st) {
      case 'ko':
        f.koT += dt;
        break;
      case 'hurt':
      case 'blockstun':
      case 'guardbreak':
        if (f.stT <= 0) f.st = 'idle';
        break;
      case 'down':
        if (f.stT <= 0) {
          f.st = 'getup';
          f.stT = GETUP;
        }
        break;
      case 'getup':
        if (f.stT <= 0) f.st = 'idle';
        break;
      case 'grab':
        this.advanceGrab(f, dt);
        break;
      case 'attack':
        this.advanceAttack(f, o, inp, dt);
        break;
      case 'idle':
        if (fighting) this.control(f, o, inp, dt, up);
        else {
          f.crouch = false;
          if (f.onGround) f.vx = 0;
        }
        break;
      default:
        break;
    }
    f.prevUp = up;

    if (f.st === 'grabbed') {
      this.animate(f, dt);
      return;
    }

    // Friction for everything that isn't player-driven walking.
    const walking = f.st === 'idle' && fighting;
    if (f.onGround && !walking) f.vx *= Math.max(0, 1 - dt * (f.st === 'hurt' || f.st === 'blockstun' || f.ko ? 5 : 9));
    if (!f.onGround) f.vy += GRAVITY * dt * (f.st === 'juggle' || f.ko ? 0.9 : 1);
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    if (f.x < STAGE_L || f.x > STAGE_R) {
      if ((f.wallBounce || (f.ko && !f.bounced)) && !f.onGround && Math.abs(f.vx) > 250) this.bounceWall(f);
      f.x = clamp(f.x, STAGE_L, STAGE_R);
    }
    if (f.y >= GROUND && !f.onGround) this.land(f);
    if (f.onGround) f.y = GROUND;
    this.animate(f, dt);
  }

  control(f, o, inp, dt, up) {
    if (f.onGround) f.facing = o.x >= f.x ? 1 : -1;
    const down = inp.y > 0.55;
    const toward = inp.x * f.facing > 0.4;
    let aP = inp.aPressed;
    let bP = inp.bPressed;
    if (f.buf) {
      if (f.buf.k === 'a') aP = true;
      else bP = true;
      f.buf = null;
    }
    f.crouch = down && f.onGround;
    if (f.onGround) {
      if (down) f.vx = 0;
      else if (Math.abs(inp.x) > 0.2) {
        const fwd = Math.sign(inp.x) === f.facing;
        f.vx = Math.sign(inp.x) * (fwd ? WALK : WALK_BACK) * Math.min(1, Math.abs(inp.x) * 1.4);
      } else f.vx = 0;
      if (up && !f.prevUp && !down) this.jump(f, inp);
    } else {
      f.vx = clamp(f.vx + inp.x * 900 * dt, -WALK, WALK);
    }

    const special = f.meter >= 100 && f.onGround && ((inp.a && inp.bPressed) || (inp.b && inp.aPressed));
    if (special) this.startAttack(f, 'special');
    else if (aP) {
      if (!f.onGround) this.startAttack(f, 'airkick');
      else if (toward && !down && this.canThrow(f, o)) this.startAttack(f, 'throw');
      else this.startAttack(f, down ? 'uppercut' : 'punch');
    } else if (bP) {
      if (!f.onGround) this.startAttack(f, 'airkick');
      else this.startAttack(f, down ? 'sweep' : 'kick');
    }
  }

  jump(f, inp) {
    f.vy = JUMP_V;
    f.onGround = false;
    f.crouch = false;
    f.vx = Math.abs(inp.x) > 0.2 ? Math.sign(inp.x) * WALK * 1.05 : 0;
    f.sq = -0.2;
    this.puff(f.x, 5, 90);
    this.host.sfx('jump');
  }

  land(f) {
    const impact = f.vy;
    f.y = GROUND;
    // Bodies bounce once off the floor before settling.
    if ((f.st === 'juggle' || f.ko) && impact > 650 && !f.groundBounced) {
      f.groundBounced = true;
      f.vy = -impact * 0.3;
      f.vx *= 0.6;
      f.juggles = 99; // no more juggling after a ground bounce
      this.puff(f.x - f.facing * 60, 14, 220);
      this.shake = Math.max(this.shake, 7);
      this.host.sfx('crash');
      return;
    }
    f.vy = 0;
    f.onGround = true;
    f.groundBounced = false;
    if (f.st === 'juggle') {
      f.st = 'down';
      f.stT = 0.7;
      f.juggles = 0;
      f.wallBounce = false;
      f.bounced = false;
      this.puff(f.x - f.facing * 60, 10, 160);
      return;
    }
    if (f.ko) {
      this.puff(f.x - f.facing * 60, 8, 120);
      return;
    }
    f.sq = clamp(impact / 3000, 0.06, 0.3);
    this.puff(f.x, 6 + Math.round(impact / 200), 60 + impact * 0.08);
    if (f.attack?.name === 'airkick') {
      f.attack = null;
      f.st = 'idle';
    }
  }

  bounceWall(f) {
    const wx = f.x < W / 2 ? STAGE_L - 10 : STAGE_R + 10;
    f.vx = -f.vx * 0.45;
    f.vy = Math.min(f.vy, -520);
    f.wallBounce = false;
    f.bounced = true;
    this.shake = Math.max(this.shake, 12);
    this.hitstop = Math.max(this.hitstop, 0.06);
    this.swing = Math.min(1, this.swing + 0.4);
    this.spark(wx, f.y - 120, 14, '#ffb38a');
    this.particles.burst(wx, f.y - 120, { count: 20, color: '#ffd166', speed: 380, life: 0.45, size: 3 });
    this.host.sfx('crash');
    if (f.lastHitBy && !f.ko) this.callout(f.lastHitBy, 'WALL BOUNCE!', '#ff9d5c');
  }

  canThrow(f, o) {
    return o.onGround && !o.ko && (o.st === 'idle' || o.st === 'attack') && Math.abs(o.x - f.x) < THROW_RANGE && Math.abs(o.y - f.y) < 10;
  }

  startAttack(f, name) {
    f.st = 'attack';
    f.attack = { name, t: 0, hit: false, blocked: false, fired: false };
    f.crouch = false;
    if (f.onGround) f.vx = 0;
    if (name === 'special') {
      f.meter = 0;
      this.superFlash = 1;
      this.hitstop = 0.28;
      this.focus = f;
      this.focusT = 0.6;
      this.host.sfx('special');
    } else this.host.sfx('whiff');
  }

  advanceAttack(f, o, inp, dt) {
    const a = f.attack;
    const m = MOVES[a.name];
    a.t += dt;
    if (m.lunge && f.onGround && a.t < m.startup + m.active) f.vx = f.facing * m.lunge;
    if (a.name === 'special') {
      if (!a.fired && a.t >= m.startup) {
        a.fired = true;
        this.projectiles.push({ x: f.x + f.facing * 100 * SCALE, y: f.y - 150 * SCALE, vx: f.facing * 780, owner: f, t: 0 });
      }
    } else if (a.name === 'throw') {
      if (!a.fired && a.t >= m.startup) {
        a.fired = true;
        if (this.canThrow(f, o)) {
          this.startGrab(f, o);
          return;
        }
      }
    } else if (!a.hit && !a.blocked && a.t >= m.startup && a.t <= m.startup + m.active) {
      const box = this.hurtbox(o);
      const dx = (o.x - f.x) * f.facing;
      const hy = f.y - m.hitY * SCALE;
      if (box && dx > -10 && dx < m.reach * SCALE + 26 && hy >= box.top - (m.antiAir ? 60 : 20) && hy <= box.bottom + (m.antiAir ? 120 : m.air ? 30 : 0)) {
        const res = this.landHit(f, o, { ...m, dir: f.facing, melee: true, x: f.x + f.facing * m.reach * SCALE * 0.85, y: hy });
        a.hit = res === 'hit';
        a.blocked = res === 'block';
      }
    }

    // Cancel windows: chain into the next move, or jump out of a launcher.
    if ((a.hit || a.blocked) && a.t >= m.startup + 0.03) {
      const next = f.buf && m.chain?.[f.buf.k];
      if (next) {
        f.buf = null;
        this.startAttack(f, next);
        return;
      }
      if (a.hit && m.jumpCancel && inp.y < -0.55 && f.onGround) {
        f.attack = null;
        f.st = 'idle';
        this.jump(f, { x: f.facing });
        return;
      }
    }
    if (a.t >= m.startup + m.active + m.recovery) {
      f.attack = null;
      f.st = 'idle';
    }
  }

  startGrab(f, o) {
    f.st = 'grab';
    f.attack = null;
    f.grab = { t: 0, tossed: false, victim: o };
    o.st = 'grabbed';
    o.attack = null;
    o.crouch = false;
    o.facing = -f.facing;
    o.vx = o.vy = 0;
    this.releaseGrab(o);
    this.host.sfx('punch');
    this.host.buzz(o.i, 60);
  }

  advanceGrab(f, dt) {
    const g = f.grab;
    const o = g.victim;
    g.t += dt;
    if (!g.tossed) {
      o.x = clamp(f.x + f.facing * 78, STAGE_L, STAGE_R);
      o.y = GROUND - Math.min(1, g.t / 0.2) * 34;
      if (g.t >= 0.22) {
        g.tossed = true;
        o.st = 'juggle';
        o.onGround = false;
        o.vx = f.facing * 540;
        o.vy = -760;
        o.juggles = 99; // throws can't be followed up
        o.lastHitBy = f;
        o.flash = 0.1;
        f.combo = 1;
        f.comboDmg = 12;
        o.hp -= 12;
        f.dealt += 12;
        o.drainT = 0.7;
        f.meter = Math.min(100, f.meter + 12);
        this.hitstop = 0.07;
        this.shake = 9;
        this.hype = Math.min(1, this.hype + 0.35);
        this.spark(o.x, o.y - 140, 14, '#ffd166');
        this.callout(f, 'THROW!', '#ffd166');
        this.host.sfx('kick');
        this.host.buzz(o.i, 120);
        if (o.hp <= 0) this.knockout(o, f, f.facing);
      }
    }
    if (g.t >= 0.5) {
      f.grab = null;
      f.st = 'idle';
    }
  }

  // A grabber that gets interrupted lets go of their victim.
  releaseGrab(f) {
    if (!f.grab) return;
    const v = f.grab.victim;
    if (v.st === 'grabbed') {
      v.st = 'idle';
      v.y = GROUND;
      v.onGround = true;
    }
    f.grab = null;
  }

  hurtbox(o) {
    if (o.ko || o.st === 'down' || o.st === 'getup' || o.st === 'grabbed') return null;
    if (o.st === 'juggle') return { top: o.y - 150, bottom: o.y + 40 };
    if (o.crouch || o.st === 'blockstun') return { top: o.y - 170 * SCALE, bottom: o.y };
    return { top: o.y - 215 * SCALE, bottom: o.y };
  }

  landHit(f, o, hit) {
    if (!this.hurtbox(o) || o.juggles >= MAX_JUGGLE) return null;
    const dir = hit.dir;
    const atWall = o.x <= STAGE_L + 4 || o.x >= STAGE_R - 4;
    const guarding = o.onGround && (o.st === 'blockstun' || (o.st === 'idle' && o.crouch));
    if (guarding && o.facing === -dir) {
      const chip = hit.dmg * 0.15;
      o.hp -= chip;
      f.dealt += chip;
      o.drainT = 0.4;
      o.st = 'blockstun';
      o.stT = hit.stun * 0.75;
      o.vx = dir * hit.knock * 0.6;
      o.guard -= hit.dmg * 2.6;
      o.guardDelay = 0.9;
      f.meter = Math.min(100, f.meter + 4);
      o.meter = Math.min(100, o.meter + 8);
      if (hit.melee && atWall) f.vx = -dir * hit.knock * 0.5;
      this.hitstop = 0.04;
      this.shake = Math.max(this.shake, 2);
      this.spark(hit.x, hit.y, 6 + hit.dmg * 0.6, '#7dd3fc');
      this.particles.burst(hit.x, hit.y, { count: 10, color: '#7dd3fc', speed: 220, life: 0.3, size: 2.5 });
      this.host.sfx('block');
      if (o.guard <= 0) this.guardBreak(o, f, dir);
      if (o.hp <= 0) this.knockout(o, f, dir);
      return 'block';
    }

    const counter = o.st === 'attack';
    const comboing = (o.st === 'hurt' || o.st === 'juggle' || o.st === 'guardbreak') && f.comboT > 0;
    f.combo = comboing ? f.combo + 1 : 1;
    if (!comboing) f.comboDmg = 0;
    const dmg = hit.dmg * Math.max(0.4, 1 - 0.12 * (f.combo - 1)) * (counter ? 1.25 : 1);
    f.comboDmg += dmg;
    f.comboT = 1.6;
    f.comboPop = 1;

    this.releaseGrab(o);
    o.hp -= dmg;
    f.dealt += dmg;
    o.drainT = 0.7;
    o.attack = null;
    o.crouch = false;
    o.flash = 0.1;
    o.hurtHigh = hit.hitY > 130;
    o.lastHitBy = f;
    o.vx = dir * hit.knock;
    if (hit.launch || hit.knockdown || !o.onGround) {
      if (o.st === 'juggle') o.juggles++;
      o.vy = hit.launch ?? (o.onGround ? -300 : Math.min(o.vy, -420 + o.juggles * 70));
      o.onGround = false;
      o.st = 'juggle';
      o.wallBounce = !!hit.wallBounce && !o.bounced;
    } else {
      o.st = 'hurt';
      o.stT = hit.stun * (counter ? 1.3 : 1);
      if (hit.melee && atWall) f.vx = -dir * hit.knock * 0.6;
    }
    f.meter = Math.min(100, f.meter + 10);
    o.meter = Math.min(100, o.meter + 6);
    this.hype = Math.min(1, this.hype + dmg * 0.03);
    this.swing = Math.min(1, this.swing + dmg * 0.02);
    this.hitstop = 0.045 + dmg * 0.005 + (counter ? 0.03 : 0);
    this.shake = Math.max(this.shake, 3 + dmg * 0.9);
    this.zoomKick = Math.min(0.08, this.zoomKick + dmg * 0.003);
    this.spark(hit.x, hit.y, 10 + dmg * 2.2, '#ffd166');
    this.particles.burst(hit.x, hit.y, { count: 8 + Math.round(dmg), color: '#ffd166', speed: 220 + dmg * 14, life: 0.35, size: 3 });
    this.particles.burst(hit.x, hit.y, { count: 8, color: o.color, speed: 200, life: 0.4, size: 4 });
    this.host.sfx(hit.sfx ?? 'hit');
    this.host.buzz(o.i, 60 + dmg * 6);
    if (counter) this.callout(f, 'COUNTER!', '#ff5f7a');
    else if (hit.launch && hit.jumpCancel) this.callout(f, 'LAUNCH!', '#38d9ff');
    if (o.hp <= 0) this.knockout(o, f, dir);
    return 'hit';
  }

  guardBreak(o, f, dir) {
    o.st = 'guardbreak';
    o.stT = 1;
    o.guard = 35;
    o.guardDelay = 1.2;
    o.vx = dir * 220;
    this.hitstop = 0.14;
    this.shake = Math.max(this.shake, 12);
    this.spark(o.x, o.y - 160, 34, '#7dd3fc');
    this.particles.burst(o.x, o.y - 160, { count: 36, color: '#7dd3fc', speed: 420, life: 0.6, size: 3.5 });
    this.callout(f, 'GUARD BREAK!', '#7dd3fc');
    this.host.sfx('shield');
    this.host.sfx('crash');
    this.host.buzz(o.i, 220);
  }

  updateProjectiles(dt) {
    const keep = [];
    for (const p of this.projectiles) {
      p.x += p.vx * dt;
      p.t += dt;
      if (Math.random() < 0.8) this.particles.burst(p.x, p.y, { count: 1, color: p.owner.color, speed: 40, life: 0.35, size: 6 });
      if (p.x < -60 || p.x > W + 60) continue;
      const clash = this.projectiles.find((q) => q !== p && q.owner !== p.owner && Math.abs(q.x - p.x) < 40);
      if (clash) {
        this.particles.burst(p.x, p.y, { count: 30, color: '#fff3c4', speed: 300, life: 0.5 });
        this.spark(p.x, p.y, 40, '#fff3c4');
        this.host.sfx('smallExplode');
        clash.x = Infinity;
        continue;
      }
      const o = this.fighters.find((f) => f !== p.owner);
      const box = o && this.hurtbox(o);
      if (box && Math.abs(p.x - o.x) < 50 && p.y > box.top && p.y < box.bottom + 10 && this.state === 'fight') {
        const res = this.landHit(p.owner, o, { dmg: 16, knock: 420, stun: 0.42, hitY: 150, launch: -480, wallBounce: true, dir: Math.sign(p.vx), x: p.x, y: p.y, sfx: 'explode' });
        if (res) {
          this.particles.burst(p.x, p.y, { count: 30, color: p.owner.color, speed: 360, life: 0.6, size: 4 });
          continue;
        }
      }
      keep.push(p);
    }
    this.projectiles = keep.filter((p) => Number.isFinite(p.x));
  }

  knockout(o, f, dir) {
    this.releaseGrab(o);
    o.hp = 0;
    o.ko = true;
    o.koT = 0;
    o.st = 'ko';
    o.attack = null;
    o.crouch = false;
    o.vx = dir * 560;
    o.vy = -680;
    o.onGround = false;
    o.groundBounced = false;
    f.wins++;
    this.roundWinner = f;
    this.koTitle = 'K.O.!';
    this.state = 'ko';
    this.stateT = 3.2;
    this.hitstop = 0.25;
    this.slowmo = 1.4;
    this.focus = o;
    this.focusT = 1.8;
    this.screenFlash = 0.7;
    this.shake = 20;
    this.hype = 1;
    this.swing = 1;
    this.host.sfx('ko');
    this.host.buzz(o.i, 450);
  }

  timeOver() {
    const [a, b] = this.fighters;
    const winner = a.hp === b.hp ? null : a.hp > b.hp ? a : b;
    if (winner) winner.wins++;
    this.roundWinner = winner;
    this.koTitle = 'TIME!';
    this.state = 'ko';
    this.stateT = 3;
    this.host.sfx('ko');
  }

  finish(champ) {
    this.state = 'over';
    this.host.sfx('win');
    const rows = [...this.fighters]
      .sort((x, y) => y.wins - x.wins)
      .map((f) => ({ name: f.name, color: f.color, values: [f.wins, Math.round(f.dealt)] }));
    this.result = {
      title: `${champ.name} wins!`,
      color: champ.color,
      subtitle: `Best of ${WINS_NEEDED * 2 - 1} rounds`,
      columns: ['Rounds', 'Damage'],
      rows,
    };
  }

  /* ------------------------------------------------------------- Effects */
  spark(x, y, size, color) {
    // Guard sparks are the cyan ones; everything else is an impact. Bigger hits get bigger sparks.
    const kind = color === GUARD_SPARK ? 'guard' : 'hit';
    const heavy = size >= 29;
    const v = this.victimNear(x);
    // Hits spray along the knockback; guard sparks glance back toward the attacker.
    const dir = !v ? 1 : kind === 'guard' ? v.facing : Math.sign(v.vx) || -v.facing;
    const fwd = dir > 0 ? 0 : Math.PI;
    const n = heavy ? 16 : kind === 'guard' ? 8 : 11;
    const rays = [];
    for (let i = 0; i < n; i++) rays.push({ a: i < n * 0.65 ? fwd + rand(-0.85, 0.85) : rand(TAU), len: rand(0.6, 1.35), w: rand(0.6, 1.2) });
    this.sparks.push({ x, y, size, color, t: 0, max: heavy ? 0.34 : 0.26, rot: rand(TAU), kind, heavy, dir, rays });

    // Screen response: camera punch, lens fringing, and a flash + speed lines on heavy hits.
    const fx = this.vfx;
    if (kind === 'guard') {
      this.kickCam(dir * 2, 1);
      fx.ab = Math.max(fx.ab, heavy ? 0.006 : 0.0015);
      if (heavy) {
        fx.flash = Math.max(fx.flash, 0.16);
        fx.flashColor = [0.55, 0.85, 1];
        this.speed = { x, y, t: 0, max: 0.3, color: '#d6f3ff', rays: speedRays(40) };
      }
      return;
    }
    const k = Math.min(1, size / 45);
    this.kickCam(-dir * size * 0.3, size * 0.12, -dir * k * 0.01);
    fx.ab = Math.max(fx.ab, 0.0015 + k * 0.004);
    if (heavy) {
      fx.flash = Math.max(fx.flash, 0.06 + k * 0.1);
      fx.flashColor = [1, 0.86, 0.64];
    }
    // Only the big ones (roundhouse, counter kicks, fireballs) get an impact frame and speed lines.
    if (size >= 34) {
      this.impact = IMPACT;
      this.speed = { x, y, t: 0, max: 0.28, color: '#fff6e8', rays: speedRays(44) };
    }
  }

  // The fighter a spark belongs to: the one just hit (white flash) or blocking, nearest the spark.
  victimNear(x) {
    let best = null;
    let bestD = Infinity;
    for (const f of this.fighters) {
      const struck = f.flash > 0.05 || f.st === 'blockstun' || f.st === 'guardbreak';
      const dd = Math.abs(f.x - x) + (struck ? 0 : 1000);
      if (dd < bestD) {
        bestD = dd;
        best = f;
      }
    }
    return best;
  }

  kickCam(x, y, r = 0) {
    const pu = this.punch;
    pu.vx += x * 30;
    pu.vy += y * 30;
    pu.vr += r * 30;
  }

  puff(x, count, power) {
    for (let k = 0; k < count; k++) {
      const s = k % 2 ? 1 : -1;
      this.dust.push({ x: x + rand(-24, 24), y: GROUND - rand(2, 10), vx: s * rand(0.3, 1) * power, vy: -rand(5, 40), r: rand(5, 11), life: rand(0.35, 0.6), max: 0.6 });
    }
  }

  callout(f, str, color) {
    f.callout = { str, color, t: 1.3 };
    // Counter hits tint the screen flash red.
    if (str === 'COUNTER!') {
      this.vfx.flash = Math.max(this.vfx.flash, 0.18);
      this.vfx.flashColor = [1, 0.3, 0.38];
    }
  }

  // Render-only state: camera punch, smears, ambient motes, titles and the post-process mix.
  updateVisuals(dt) {
    const pu = this.punch;
    pu.vx += (-pu.x * 400 - pu.vx * 24) * dt;
    pu.vy += (-pu.y * 400 - pu.vy * 24) * dt;
    pu.vr += (-pu.r * 400 - pu.vr * 24) * dt;
    pu.x += pu.vx * dt;
    pu.y += pu.vy * dt;
    pu.r += pu.vr * dt;
    this.impact = Math.max(0, this.impact - dt);
    if (this.speed && (this.speed.t += dt) >= this.speed.max) this.speed = null;
    this.updateMotes(dt);
    this.updateTrails(dt);

    // State edges: knockouts and supers kick off their screen effects once.
    const v = this.vfx;
    if (this.state !== this.vState) {
      this.vState = this.state;
      if (this.state === 'ko' && this.koTitle === 'K.O.!' && this.focus) {
        const o = this.focus;
        const dir = Math.sign(o.vx) || 1;
        this.speed = { x: o.x, y: o.y - 140, t: 0, max: 0.6, color: '#ffffff', rays: speedRays(64) };
        v.flash = 0.3;
        v.flashColor = WHITE;
        v.ab = 0.009;
        this.kickCam(-dir * 16, 8, -dir * 0.012);
      }
    }
    if (this.superFlash > this.prevSuper + 0.01) {
      const f = this.superUser();
      v.flash = Math.max(v.flash, 0.22);
      v.flashColor = f ? rgb01(f.color) : WHITE;
      v.ab = Math.max(v.ab, 0.006);
    }
    this.prevSuper = this.superFlash;

    // Title animations run on their own clock so they ignore KO slow-mo.
    const key = this.state === 'intro' ? `${this.round}${this.stateT <= 0.8 ? 'go' : ''}` : `${this.state}${this.round}`;
    if (key !== this.titleKey) {
      this.titleKey = key;
      this.titleT = 0;
    }
    this.titleT += dt;

    v.flash = Math.max(0, v.flash - dt * 3.2);
    v.ab = Math.max(0, v.ab - dt * 0.025);
    // KO slow-mo drains the colour out of the frame, then it floods back.
    const koSlow = this.state === 'ko' && this.koTitle === 'K.O.!' ? clamp(this.slowmo / 0.5, 0, 1) : 0;
    v.desat = lerp(v.desat, koSlow * 0.78, 1 - Math.exp(-dt * (koSlow > v.desat ? 14 : 3)));
    const p = this.post;
    const ko = this.screenFlash * 0.45;
    p.flash = Math.min(0.85, v.flash + ko);
    p.flashColor = v.flash >= ko ? v.flashColor : WHITE;
    p.aberration = POST.aberration + v.ab + this.superFlash * 0.002;
    p.desaturate = v.desat;
    p.vignette = POST.vignette + this.superFlash * 0.22 + v.desat * 0.18;
  }

  updateMotes(dt) {
    const k = this.slowmo > 0 ? 0.3 : 1;
    const t = this.time;
    for (const m of this.motes) {
      m.x += (m.vx + Math.sin(t * 0.9 + m.ph) * m.sway) * dt * k;
      m.y += m.vy * dt * k;
      m.rot += m.vr * dt * k;
      if (m.x < -BLEED) m.x += W + BLEED * 2;
      else if (m.x > W + BLEED) m.x -= W + BLEED * 2;
      if (m.kind === 'petal' && m.y > H + 40) {
        m.y = -40;
        m.x = rand(-BLEED, W + BLEED);
      } else if (m.kind === 'ember' && m.y < 120) {
        m.y = H + 20;
        m.x = rand(-BLEED, W + BLEED);
      }
    }
  }

  // Record smear points for the striking limb and afterimage snapshots of fast moves.
  updateTrails(dt) {
    if (this.hitstop > 0) return; // smears hang in the air on the impact frame
    for (const f of this.fighters) {
      const v = this.vis[f.i];
      for (const p of v.trail) p.age += dt;
      while (v.trail.length && v.trail[0].age > TRAIL_LIFE) v.trail.shift();
      for (const g of v.ghosts) g.age += dt;
      while (v.ghosts.length && v.ghosts[0].age > GHOST_LIFE) v.ghosts.shift();
      v.snapT -= dt;
      const a = f.st === 'attack' ? f.attack : null;
      const m = a && MOVES[a.name];
      if (a && STRIKER[a.name] && a.t >= m.startup * 0.4 && a.t <= m.startup + m.active + 0.03) {
        if (v.trail.length && v.trail[v.trail.length - 1].move !== a) v.trail.length = 0;
        const p = this.toWorld(f, f.d[STRIKER[a.name]]);
        v.trail.push({ x: p[0], y: p[1], age: 0, move: a, kick: STRIKER[a.name][0] === 'f' });
        if (v.trail.length > 10) v.trail.shift();
      }
      const fast = (a && GHOST_MOVES.has(a.name) && a.t < m.startup + m.active + 0.06) || (f.ko && !f.onGround) || (f.st === 'juggle' && f.vy < -650);
      if (fast && v.snapT <= 0) {
        // Only leave an afterimage if the body actually moved since the last one.
        const last = v.ghosts[v.ghosts.length - 1]?.snap;
        const moved = !last || Math.abs(last.x - f.x) + Math.abs(last.y - f.y) + Math.abs(last.d.handF[0] - f.d.handF[0]) + Math.abs(last.d.footF[0] - f.d.footF[0]) + Math.abs(last.d.footF[1] - f.d.footF[1]) > 14;
        if (moved) {
          v.snapT = 0.035;
          v.ghosts.push({ snap: snapshot(f), age: 0 });
          if (v.ghosts.length > 4) v.ghosts.shift();
        }
      }
    }
  }

  /* --------------------------------------------------------- Animation */
  poseTarget(f) {
    const t = this.time;
    switch (f.st) {
      case 'attack': {
        const a = f.attack;
        const m = MOVES[a.name];
        const A = ATTACK_POSES[a.name];
        if (a.t < m.startup) return mixPose(A.base, A.wind, Math.min(1, a.t / m.startup + 0.35));
        if (a.t < m.startup + m.active) return copyPose(A.hit);
        const r = clamp((a.t - m.startup - m.active) / m.recovery, 0, 1);
        return mixPose(A.hit, A.base, r * r);
      }
      case 'hurt':
      case 'grabbed':
        return copyPose(f.hurtHigh || f.st === 'grabbed' ? HURT_HIGH : HURT_LOW);
      case 'blockstun': {
        const p = copyPose(CROUCH);
        for (const k of ['neck', 'head', 'handB', 'handF']) p[k][0] -= 8;
        return p;
      }
      case 'juggle': {
        const p = copyPose(JUGGLE);
        p.handB[1] += Math.sin(t * 22) * 10;
        p.handF[1] += Math.cos(t * 19) * 10;
        p.footF[0] += Math.sin(t * 17) * 8;
        return p;
      }
      case 'ko':
        return copyPose(f.onGround ? DOWN : JUGGLE);
      case 'down':
        return copyPose(DOWN);
      case 'getup':
        return copyPose(CROUCH);
      case 'guardbreak': {
        const p = copyPose(STAGGER);
        p.head[0] += Math.sin(t * 9) * 6;
        return p;
      }
      case 'grab':
        return copyPose(f.grab?.tossed ? THROWING : ATTACK_POSES.throw.hit);
      case 'win': {
        const p = copyPose(WIN);
        const pump = Math.max(0, Math.sin(t * 6));
        p.handF[1] -= pump * 10;
        p.hip[1] -= pump * 3;
        p.neck[1] -= pump * 4;
        p.head[1] -= pump * 4;
        return p;
      }
      default:
        break;
    }
    if (!f.onGround) {
      // Knees tuck tighter at the apex of the jump.
      const tuck = clamp(1 - Math.abs(f.vy) / 900, 0, 1);
      const p = copyPose(AIR);
      p.footB[1] -= tuck * 22;
      p.footF[1] -= tuck * 26;
      p.footF[0] += tuck * 8;
      return p;
    }
    if (f.crouch) return copyPose(CROUCH);
    const p = copyPose(STAND);
    // Breathing and a bouncy guard.
    const breath = Math.sin(t * 2.6 + f.i * 1.3);
    for (const k of ['neck', 'head', 'handB', 'handF']) p[k][1] += breath * 2.4;
    p.hip[1] += breath * 0.8;
    p.handF[0] += Math.sin(t * 1.3 + f.i) * 3;
    if (Math.abs(f.vx) > 10) {
      const s = Math.sin(f.walkT);
      const c = Math.cos(f.walkT);
      p.footB = [-28 + s * 26, -Math.max(0, c) * 16];
      p.footF = [32 - s * 26, -Math.max(0, -c) * 16];
      const bob = -Math.abs(c) * 5 + 2;
      for (const k of ['hip', 'neck', 'head', 'handB', 'handF']) p[k][1] += bob;
      p.handB[0] += s * 10;
      p.handF[0] -= s * 8;
    }
    return p;
  }

  animate(f, dt) {
    const target = this.poseTarget(f);
    const snappy = f.st === 'attack' || f.st === 'hurt' || f.st === 'grab' || f.st === 'grabbed';
    const rate = snappy ? 38 : f.st === 'juggle' || f.st === 'ko' ? 10 : 16;
    const k = 1 - Math.exp(-rate * dt);
    for (const key of KEYS) {
      f.j[key][0] = lerp(f.j[key][0], target[key][0], k);
      f.j[key][1] = lerp(f.j[key][1], target[key][1], k);
    }

    // Whole-body lean: recoil, falling back, lying down, getting up.
    let tilt = 0;
    if (f.st === 'hurt' || f.st === 'grabbed') tilt = f.hurtHigh ? -0.16 : 0.14;
    else if (f.st === 'juggle') tilt = -1.25;
    else if (f.st === 'down' || (f.ko && f.onGround)) tilt = -1.5;
    else if (f.ko) tilt = -1.3;
    else if (f.st === 'guardbreak') tilt = -0.12 + Math.sin(this.time * 9) * 0.06;
    else if (f.st === 'idle' && f.onGround) tilt = f.vx * f.facing * 0.00022;
    if (f.st === 'getup') f.tilt = -1.5 * clamp(f.stT / GETUP, 0, 1);
    else f.tilt = lerp(f.tilt, tilt, 1 - Math.exp(-(tilt < -1 ? 7 : 14) * dt));

    f.sq = lerp(f.sq, 0, 1 - Math.exp(-10 * dt));

    // Roundhouse wind-up spins the body around.
    f.spinX = 1;
    if (f.st === 'attack' && f.attack.name === 'roundhouse' && f.attack.t < MOVES.roundhouse.startup) {
      const c = Math.cos((f.attack.t / MOVES.roundhouse.startup) * TAU);
      f.spinX = Math.sign(c || 1) * Math.max(0.25, Math.abs(c));
    }

    // Belt and headband tails trail behind movement on a spring.
    const ct = clamp(f.vx * f.facing * 0.0016 + f.vy * 0.0005, -0.7, 1.4);
    f.clothV += ((ct - f.cloth) * 80 - f.clothV * 9) * dt;
    f.cloth += f.clothV * dt;

    if (f.onGround && f.st === 'idle' && !f.crouch && Math.abs(f.vx) > 10) f.walkT += dt * f.vx * f.facing * 0.034;
    this.solve(f);
  }

  // Turn the eased driver points into a full drawable skeleton.
  solve(f) {
    const j = f.j;
    const d = {
      hip: j.hip,
      neck: j.neck,
      head: j.head,
      footB: [...j.footB],
      footF: [...j.footF],
      handB: [...j.handB],
      handF: [...j.handF],
      sB: [j.neck[0] - 6, j.neck[1] + 8],
      sF: [j.neck[0] + 4, j.neck[1] + 8],
    };
    d.kneeB = ik(d.hip, d.footB, LEG, LEG, -1);
    d.kneeF = ik(d.hip, d.footF, LEG, LEG, -1);
    d.elbowB = ik(d.sB, d.handB, ARM1, ARM2, 1);
    d.elbowF = ik(d.sF, d.handF, ARM1, ARM2, 1);
    f.d = d;
  }

  /* --------------------------------------------------------------- CPU */
  bot(f, o, dt) {
    const b = (f.brain ??= { t: 0, blockT: 0, react: 0, seen: null, fb: null, chainSeen: null, want: 160, wantT: 0, plan: null, planT: 0 });
    b.t -= dt;
    b.blockT -= dt;
    b.wantT -= dt;
    b.planT -= dt;
    const inp = { x: 0, y: 0, a: false, b: false, aPressed: false, bPressed: false };
    const press = (k) => {
      inp[k] = true;
      inp[`${k}Pressed`] = true;
    };
    const d = Math.abs(o.x - f.x);
    const dir = Math.sign(o.x - f.x) || 1;

    // Hit-confirm into the next link of the chain.
    if (f.st === 'attack') {
      const a = f.attack;
      if (a.hit && b.chainSeen !== a) {
        b.chainSeen = a;
        if (Math.random() < 0.75) {
          if (a.name === 'punch') press('a');
          else if (a.name === 'cross') press('b');
          else if (a.name === 'uppercut') {
            b.plan = 'juggle';
            b.planT = 1.2;
          }
        }
      }
      if (b.plan === 'juggle') inp.y = -1;
      return inp;
    }

    // Airborne plans: jump-ins and juggles end in a flying kick.
    if (b.plan && !f.onGround) {
      inp.x = dir;
      if (d < 180 && f.vy > -350 && f.st === 'idle') {
        press('b');
        b.plan = null;
      }
      return inp;
    }
    if (b.plan === 'hop' && f.onGround && f.st === 'idle') {
      inp.y = -1;
      inp.x = dir;
      b.plan = 'jumpin';
      b.planT = 1;
      return inp;
    }
    if (b.planT <= 0) b.plan = null;
    if (f.st !== 'idle') return inp;

    // React to the opponent's swings — not instantly, and not every time.
    if (o.st === 'attack' && o.attack !== b.seen) {
      b.seen = o.attack;
      if (o.attack.name !== 'throw' && d < 300 && f.guard > 20 && Math.random() < 0.62) b.react = rand(0.03, 0.13);
    }
    if (b.react > 0 && (b.react -= dt) <= 0) b.blockT = rand(0.35, 0.6);
    const fireball = this.projectiles.find((p) => p.owner === o && Math.sign(f.x - p.x) === Math.sign(p.vx) && Math.abs(p.x - f.x) < 420);
    if (fireball && b.fb !== fireball) {
      b.fb = fireball;
      if (Math.random() < 0.45 && Math.abs(fireball.x - f.x) > 220) {
        b.plan = 'hop';
        b.planT = 0.5;
      } else b.blockT = 0.8;
    }
    if (b.blockT > 0) {
      inp.y = 1;
      return inp;
    }

    // Anti-air a jump-in with the uppercut.
    if (!o.onGround && o.st === 'idle' && d < 210 && o.vy > -150 && Math.random() < 0.15) {
      inp.y = 1;
      press('a');
      return inp;
    }
    if (f.meter >= 100 && d > 280 && Math.random() < 0.02) {
      inp.a = inp.b = inp.aPressed = inp.bPressed = true;
      return inp;
    }

    // Footsies: pick a preferred distance now and then and hold it.
    if (b.wantT <= 0) {
      b.wantT = rand(0.7, 2);
      b.want = [110, 120, 170, 240, 330][Math.floor(Math.random() * 5)];
    }
    if (o.st === 'down' || o.st === 'getup') b.want = 170;
    if (d > b.want + 30) inp.x = dir;
    else if (d < b.want - 40) inp.x = -dir;
    if (d > 180 && d < 340 && o.onGround && Math.random() < 0.004) {
      inp.y = -1;
      inp.x = dir;
      b.plan = 'jumpin';
      b.planT = 1;
      return inp;
    }

    if (d < 150 && b.t <= 0 && o.st !== 'down' && o.st !== 'getup') {
      b.t = rand(0.22, 0.55);
      const r = Math.random();
      inp.x = 0;
      if (o.crouch && d < THROW_RANGE - 10 && r < 0.55) {
        inp.x = dir; // throw beats a turtling opponent
        press('a');
      } else if (r < 0.5) press('a');
      else if (r < 0.72) press('b');
      else if (r < 0.86) {
        inp.y = 1;
        press('b');
      } else inp.x = -dir;
    }
    return inp;
  }

  /* ------------------------------------------------------------ Render */
  render(ctx) {
    const cam = this.cam;
    const art = this.art;
    const t = this.time;
    const pu = this.punch;
    // Smooth high-frequency shake plus a spring-loaded punch on big hits. Visual only:
    // none of this feeds back into the simulation.
    const sh = Math.min(this.shake, CAM_MARGIN - 2);
    const sx = sh * (Math.sin(t * 83.1) * 0.6 + Math.sin(t * 131.7 + 1.3) * 0.4) + clamp(pu.x, -16, 16);
    const sy = sh * 0.6 * (Math.sin(t * 97.3 + 2.1) * 0.6 + Math.sin(t * 151.9 + 0.7) * 0.4) + clamp(pu.y, -10, 10);
    const roll = clamp(pu.r, -0.014, 0.014);
    // Draw with a parallax factor p: 0 = pinned to screen, 1 = moves with the world.
    const layer = (p, fn) => {
      const z = 1 + (cam.zoom - 1) * p;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(z, z);
      ctx.translate(-(W / 2 + (cam.x + sx - W / 2) * p), -(H / 2 + (cam.y + sy - H / 2) * p));
      fn();
      ctx.restore();
    };

    ctx.save();
    if (roll) {
      ctx.translate(W / 2, H / 2);
      ctx.rotate(roll);
      ctx.translate(-W / 2, -H / 2);
    }
    layer(0.04, () => {
      ctx.drawImage(art.sky, -BLEED, -BLEED);
      this.drawRays(ctx);
    });
    layer(0.15, () => ctx.drawImage(art.far, -BLEED, 0, W + BLEED * 2, H));
    layer(0.35, () => ctx.drawImage(art.mid, -BLEED, 0, W + BLEED * 2, H));
    layer(0.45, () => ctx.drawImage(art.haze, -BLEED, 430, W + BLEED * 2, 250));
    layer(0.6, () => {
      this.drawCrowd(ctx);
      this.drawMotes(ctx, 0);
    });
    layer(0.8, () => this.drawRail(ctx));
    layer(0.85, () => this.drawLanterns(ctx));
    layer(1, () => {
      const fh = H - FLOOR_Y + BLEED;
      ctx.drawImage(art.floor, -BLEED, FLOOR_Y, W + BLEED * 2, fh);
      this.drawFloorLights(ctx);
      this.drawReflections(ctx);
      ctx.drawImage(art.coat, -BLEED, FLOOR_Y, W + BLEED * 2, fh);
      this.drawSpotlights(ctx);
      for (const f of this.fighters) this.drawShadow(ctx, f);
      this.drawDust(ctx);
      // Supers and heavy hits drop the stage into darkness so the fighters pop.
      const dim = Math.max(Math.min(0.68, this.superFlash * 0.78), (this.impact / IMPACT) * 0.5);
      if (dim > 0) {
        ctx.fillStyle = `rgba(6,0,12,${dim})`;
        ctx.fillRect(-BLEED * 2, -BLEED * 2, W + BLEED * 4, H + BLEED * 4);
      }
      if (this.superFlash > 0) this.drawSuperBurst(ctx);
      // Draw the attacker on top so strikes read clearly.
      const busy = (f) => (f.st === 'attack' || f.st === 'grab' ? 1 : 0);
      const order = [...this.fighters].sort((x, y) => busy(x) - busy(y));
      for (const f of order) this.drawFighter(ctx, f);
      for (const p of this.projectiles) this.drawProjectile(ctx, p);
      this.drawSparks(ctx);
      this.drawParticles(ctx);
      this.drawSpeedLines(ctx);
      this.drawMotes(ctx, 1);
    });
    layer(1.35, () => this.drawForeground(ctx));
    ctx.restore();

    if (this.screenFlash > 0) {
      ctx.fillStyle = `rgba(255,245,230,${this.screenFlash * 0.35})`;
      ctx.fillRect(0, 0, W, H);
    }
    this.drawSuperCutIn(ctx);
    this.drawHud(ctx);
    this.drawTitles(ctx);
  }

  drawRays(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + Math.sin(this.time * 0.45) * 0.15;
    ctx.translate(SUN[0], SUN[1]);
    ctx.rotate(Math.sin(this.time * 0.06) * 0.04);
    ctx.translate(-SUN[0], -SUN[1]);
    ctx.drawImage(this.art.rays, -BLEED, -BLEED, W + BLEED * 2, H + BLEED * 2);
    ctx.restore();
  }

  drawCrowd(ctx) {
    const seg = 100;
    const amp = 1.5 + this.hype * 9;
    for (let row = 0; row < 3; row++) {
      const img = this.art.crowd[row];
      const y0 = CROWD_ROWS[row] - 132;
      for (let x = -BLEED; x < W + BLEED; x += seg) {
        const sw = Math.min(seg, W + BLEED - x);
        const ph = this.time * (5 + this.hype * 5) + x * 0.017 + row * 1.9;
        const bob = -Math.abs(Math.sin(ph)) * amp;
        ctx.drawImage(img, x + BLEED, 0, sw, 140, x, y0 + bob, sw, 140);
      }
    }
    // Camera flashes from the stands
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const spr = glowSprite('#ffffff', 128, 0.2);
    for (const fl of this.flashes) {
      ctx.globalAlpha = fl.t / 0.1;
      ctx.drawImage(spr, fl.x - 28, fl.y - 28, 56, 56);
    }
    ctx.restore();
  }

  drawRail(ctx) {
    ctx.drawImage(this.art.rail, -BLEED, RAIL_Y);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const spr = glowSprite('#ffb066', 128, 0.12);
    RAIL_POSTS.forEach((x, k) => {
      ctx.globalAlpha = 0.5 + Math.sin(this.time * 2.3 + k * 1.7) * 0.08;
      ctx.drawImage(spr, x - 40, RAIL_Y + 7 - 40, 80, 80);
    });
    ctx.restore();
  }

  drawLanterns(ctx) {
    const hookY = 250; // low enough to hang clear of the HUD names
    ctx.strokeStyle = '#1a0510';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-BLEED - 60, hookY - 30);
    for (const x of LANTERNS) ctx.quadraticCurveTo(x - 130, hookY + 30, x, hookY);
    ctx.quadraticCurveTo(W - 30, hookY + 30, W + BLEED + 60, hookY - 30);
    ctx.stroke();
    const halo = glowSprite('#ff7a3a', 128, 0.1);
    const core = glowSprite('#ffc27a', 128, 0.3);
    LANTERNS.forEach((x, i) => {
      const ang = Math.sin(this.time * 1.6 + i * 1.3) * 0.05 + Math.sin(this.time * 7 + i) * this.swing * 0.25;
      const flick = 0.88 + Math.sin(this.time * 3 + i * 2) * 0.08 + Math.sin(this.time * 11 + i) * 0.04;
      ctx.save();
      ctx.translate(x, hookY);
      ctx.rotate(ang);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * flick;
      ctx.drawImage(halo, -130, 50 - 130, 260, 260);
      ctx.restore();
      ctx.drawImage(this.art.lantern, -30, 0, 60, 96);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * flick;
      ctx.drawImage(core, -24, 50 - 32, 48, 64);
      ctx.restore();
      ctx.restore();
    });
  }

  // Additive light pools on the polished floor: lantern streaks, the fireball, hit flashes.
  drawFloorLights(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const streak = glowSprite('#ff8a48', 128, 0.05);
    LANTERNS.forEach((x, i) => {
      ctx.globalAlpha = 0.22 + Math.sin(this.time * 3 + i * 2) * 0.03;
      ctx.drawImage(streak, x - 30, 708, 60, 170);
    });
    for (const p of this.projectiles) {
      ctx.globalAlpha = 0.6;
      ctx.drawImage(glowSprite(p.owner.color, 128, 0.05), p.x - 220, GROUND - 30, 440, 80);
      ctx.globalAlpha = 0.35;
      const ry = GROUND + 8 + (GROUND + 8 - p.y) * 0.55;
      ctx.drawImage(glowSprite(p.owner.color, 128, 0.2), p.x - 50, ry - 30, 100, 60);
    }
    for (const s of this.sparks) {
      ctx.globalAlpha = (1 - s.t / s.max) * 0.5 * Math.min(1, s.size / 30);
      ctx.drawImage(glowSprite(s.color, 128, 0.05), s.x - s.size * 5, GROUND - 20, s.size * 10, 56);
    }
    ctx.restore();
  }

  // Sweeping stadium spotlights: nested wedges fake a soft volumetric edge.
  drawSpotlights(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const heat = 0.045 + this.hype * 0.04;
    const beam = ctx.createLinearGradient(0, -40, 0, GROUND + 20);
    beam.addColorStop(0, `rgba(255,224,190,${heat + 0.035})`);
    beam.addColorStop(0.7, `rgba(255,214,180,${heat * 0.5})`);
    beam.addColorStop(1, 'rgba(255,214,180,0)');
    const pool = glowSprite('#ffd9b0', 128, 0.02);
    [[300, 0.0], [1300, 2.1]].forEach(([bx, off]) => {
      const tx = bx + Math.sin(this.time * 0.6 + off) * 360;
      ctx.globalAlpha = 1;
      ctx.fillStyle = beam;
      for (const k of [1, 0.66, 0.33]) {
        ctx.beginPath();
        ctx.moveTo(bx - 24 * k, -40);
        ctx.lineTo(bx + 24 * k, -40);
        ctx.lineTo(tx + 240 * k, GROUND + 20);
        ctx.lineTo(tx - 240 * k, GROUND + 20);
        ctx.fill();
      }
      ctx.globalAlpha = 0.45 + this.hype * 0.3;
      ctx.drawImage(pool, tx - 280, GROUND - 22, 560, 76);
    });
    ctx.restore();
  }

  // Mirror the fighters into the polished floor (flat colours, faded by the floor coat).
  drawReflections(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-BLEED, GROUND + 4, W + BLEED * 2, H);
    ctx.clip();
    ctx.globalAlpha = 0.2;
    ctx.translate(0, GROUND + 8);
    ctx.scale(1, -0.55);
    ctx.translate(0, -(GROUND + 8));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of this.fighters) {
      ctx.save();
      this.place(ctx, f, 0);
      this.drawBody(ctx, f, true);
      ctx.restore();
    }
    ctx.restore();
  }

  drawShadow(ctx, f) {
    const h = clamp((GROUND - f.y) / 300, 0, 1);
    const lying = Math.abs(Math.sin(f.tilt));
    const x = f.x - f.facing * lying * 100 * SCALE;
    const rx = (64 + lying * 70) * (1 - h * 0.4);
    contactShadow(ctx, x, GROUND + 5, rx * 1.15, 14, 0.55 - h * 0.3);
    // Tight occlusion right under the feet
    contactShadow(ctx, x, GROUND + 2, rx * 0.55, 5, 0.5 * (1 - h));
  }

  drawDust(ctx) {
    const spr = this.art.puff;
    ctx.save();
    for (const d of this.dust) {
      ctx.globalAlpha = (d.life / d.max) * 0.42;
      const r = d.r * 2.2;
      ctx.drawImage(spr, d.x - r, d.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  // Hit particles drawn as velocity streaks rather than dots.
  drawParticles(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.particles.list) {
      const k = Math.max(0, p.life / p.max);
      ctx.globalAlpha = k;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size * (0.5 + k * 0.7);
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * 0.028, p.y - p.vy * 0.028);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawMotes(ctx, depth) {
    const t = this.time;
    const ember = glowSprite('#ff9a50', 128, 0.25);
    ctx.save();
    for (const m of this.motes) {
      if (m.depth !== depth) continue;
      if (m.kind === 'ember') {
        const a = (0.55 + Math.sin(t * 8 + m.ph * 5) * 0.45) * clamp((m.y - 180) / 260, 0, 1);
        if (a <= 0.01) continue;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        const r = m.size * 5;
        ctx.drawImage(ember, m.x - r, m.y - r, r * 2, r * 2);
        continue;
      }
      // Petals tumble: squashing one axis by cos() fakes the 3D flip.
      const flip = Math.cos(m.rot * 0.8 + m.ph);
      ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.rot);
      ctx.scale(1, Math.abs(flip) < 0.08 ? 0.08 : flip);
      if (depth === 2) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(this.art.petal, -m.size * 1.6, -m.size, m.size * 3.2, m.size * 2);
      } else {
        ctx.globalAlpha = depth ? 0.95 : 0.75;
        ctx.fillStyle = flip > 0 ? '#ffb7cf' : '#d9708f';
        ctx.beginPath();
        ctx.ellipse(0, 0, m.size, m.size * 0.55, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  drawForeground(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.8;
    ctx.drawImage(this.art.bokeh, -BLEED, 760, W + BLEED * 2, 300);
    ctx.restore();
    this.drawMotes(ctx, 2);
  }

  drawSparks(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.sparks) {
      const k = s.t / s.max;
      const e = 1 - Math.pow(1 - k, 3);
      ctx.globalAlpha = 1;
      if (s.kind === 'guard') this.drawGuardSpark(ctx, s, k, e);
      else this.drawHitSpark(ctx, s, k, e);
    }
    ctx.restore();
  }

  // Sharp spikes from the spark centre: a coloured body with a white-hot core.
  rayBurst(ctx, s, r, k, e, lenK, wK) {
    const r0 = r * 0.22 * e;
    for (let pass = 0; pass < 2; pass++) {
      const lk = pass ? 0.62 : 1;
      const wk = pass ? 0.4 : 1;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = pass ? '#ffffff' : s.color;
      ctx.beginPath();
      for (const ray of s.rays) {
        const len = r * ray.len * lenK * lk;
        const w = s.size * 0.1 * ray.w * wK * wk * (1 - k * 0.6);
        const ca = Math.cos(ray.a);
        const sa = Math.sin(ray.a);
        ctx.moveTo(s.x + ca * r0 - sa * w, s.y + sa * r0 + ca * w);
        ctx.lineTo(s.x + ca * len, s.y + sa * len);
        ctx.lineTo(s.x + ca * r0 + sa * w, s.y + sa * r0 - ca * w);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  drawHitSpark(ctx, s, k, e) {
    const r = s.size * (0.7 + e * 1.1);
    const fwd = s.dir > 0 ? 0 : Math.PI;
    drawGlow(ctx, s.x, s.y, s.size * (2.6 - k * 1.2), s.color, (1 - k) * 0.9);
    if (s.t < 0.08) {
      // Impact flare along the line of the hit, only on the first frames
      ctx.globalAlpha = 1 - s.t / 0.08;
      ctx.fillStyle = '#ffffff';
      flare(ctx, s.x, s.y, s.size * (s.heavy ? 3.4 : 2.4), s.size * 0.9, s.size * 0.12, fwd + (s.rot - Math.PI) * 0.06);
    }
    this.rayBurst(ctx, s, r, k, e, s.heavy ? 1.5 : 1.15, 1);
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.heavy ? 5 : 3) * (1 - k) + 0.6;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.2, r * 0.9, fwd, 0, TAU);
    ctx.stroke();
    if (s.heavy) {
      ctx.globalAlpha = (1 - k) * 0.6;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(s.x + Math.cos(fwd) * r * 0.3, s.y, r * 2, r * 0.7, fwd, 0, TAU);
      ctx.stroke();
    }
  }

  // Blocks read differently from hits: a faceted cyan shield arc and sparks glancing back.
  drawGuardSpark(ctx, s, k, e) {
    const face = s.dir > 0 ? 0 : Math.PI;
    const r = s.size * (1.1 + e * 1.3);
    drawGlow(ctx, s.x, s.y, s.size * 2.4, s.color, (1 - k) * 0.75);
    ctx.strokeStyle = s.color;
    for (let ring = 0; ring < 3; ring++) {
      const rr = r * (1 - ring * 0.22);
      const cx = s.x - Math.cos(face) * rr * 0.55;
      ctx.globalAlpha = (1 - k) * (1 - ring * 0.3);
      ctx.lineWidth = (ring ? 2 : 4.5) * (1 - k) + 0.8;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = face + (i / 6 - 0.5) * 1.9;
        const px = cx + Math.cos(a) * rr;
        const py = s.y + Math.sin(a) * rr;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    this.rayBurst(ctx, s, r * 0.8, k, e, 0.9, 0.7);
    if (s.heavy) {
      // Guard break: the shield shatters into shards
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      for (const ray of s.rays) {
        const d = r * (0.6 + e * 1.6) * ray.len;
        const px = s.x + Math.cos(ray.a) * d;
        const py = s.y + Math.sin(ray.a) * d;
        const sz = 7 * ray.w * (1 - k * 0.5);
        const rot = ray.a + k * 6 * ray.w;
        ctx.moveTo(px + Math.cos(rot) * sz, py + Math.sin(rot) * sz);
        ctx.lineTo(px + Math.cos(rot + 2.3) * sz * 0.7, py + Math.sin(rot + 2.3) * sz * 0.7);
        ctx.lineTo(px + Math.cos(rot + 4.1) * sz * 0.8, py + Math.sin(rot + 4.1) * sz * 0.8);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  // Radial speed lines bursting from a heavy hit or a knockout.
  drawSpeedLines(ctx) {
    const s = this.speed;
    if (!s) return;
    const k = s.t / s.max;
    ctx.save();
    ctx.globalAlpha = Math.pow(1 - k, 1.5) * 0.5;
    ctx.fillStyle = s.color;
    const r0 = 140 + k * 160;
    ctx.beginPath();
    for (const r of s.rays) {
      const a0 = r0 * r.d;
      ctx.moveTo(s.x + Math.cos(r.a) * a0, s.y + Math.sin(r.a) * a0);
      ctx.lineTo(s.x + Math.cos(r.a - r.w) * 1900, s.y + Math.sin(r.a - r.w) * 1900);
      ctx.lineTo(s.x + Math.cos(r.a + r.w) * 1900, s.y + Math.sin(r.a + r.w) * 1900);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  superUser() {
    return this.fighters.find((f) => f.attack?.name === 'special') ?? this.focus;
  }

  // Aura burst behind the fighter activating a super, over the darkened stage.
  drawSuperBurst(ctx) {
    const f = this.superUser();
    if (!f) return;
    const s = this.superFlash;
    const cx = f.x;
    const cy = f.y - 130 * SCALE;
    drawGlow(ctx, cx, cy, 380 + (1 - s) * 320, f.color, s * 0.75, 0.05);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 60, cx, cy, 1100);
    g.addColorStop(0, rgba(f.color, 0.55 * s));
    g.addColorStop(1, rgba(f.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    const spin = this.time * 0.5;
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU + spin;
      const w = 0.025 + (i % 3) * 0.012;
      ctx.moveTo(cx + Math.cos(a) * 80, cy + Math.sin(a) * 80);
      ctx.lineTo(cx + Math.cos(a - w) * 1300, cy + Math.sin(a - w) * 1300);
      ctx.lineTo(cx + Math.cos(a + w) * 1300, cy + Math.sin(a + w) * 1300);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  // Same transform for every fighter draw, so effects can find a hand or foot in world space.
  place(ctx, f, jx) {
    ctx.translate(f.x + jx, f.y);
    ctx.scale(f.facing * SCALE * f.spinX * (1 + f.sq * 0.7), SCALE * (1 - f.sq));
    ctx.rotate(f.tilt);
  }

  toWorld(f, p) {
    const c = Math.cos(f.tilt);
    const s = Math.sin(f.tilt);
    return [f.x + (p[0] * c - p[1] * s) * f.facing * SCALE * f.spinX * (1 + f.sq * 0.7), f.y + (p[0] * s + p[1] * c) * SCALE * (1 - f.sq)];
  }

  // Key light (the sun, behind the middle of the stage) as a direction in the fighter's local space.
  lightDir(f) {
    const wx = clamp((W / 2 - f.x) / 260, -1, 1) * 0.8;
    const wy = -0.62;
    const ux = wx * f.facing * (f.spinX < 0 ? -1 : 1);
    const c = Math.cos(f.tilt);
    const s = Math.sin(f.tilt);
    const x = ux * c + wy * s;
    const y = -ux * s + wy * c;
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  }

  drawFighter(ctx, f) {
    const vis = this.vis[f.i];
    // Afterimages trail fast moves and knockdowns.
    if (vis.ghosts.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const g of vis.ghosts) {
        ctx.save();
        ctx.globalAlpha = (1 - g.age / GHOST_LIFE) * 0.3;
        this.place(ctx, g.snap, 0);
        this.silhouette(ctx, g.snap.d, f.color, null);
        ctx.restore();
      }
      ctx.restore();
    }

    ctx.save();
    // The victim shudders during hit-stop.
    const jx = this.hitstop > 0 && f.flash > 0 ? rand(-5, 5) : 0;
    this.place(ctx, f, jx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Impact frame: a flat white silhouette while the hit freezes, fading back after.
    const white = f.flash > 0 ? (this.hitstop > 0 ? 1 : clamp(f.flash / 0.1, 0, 1)) : 0;
    if (white >= 1) this.silhouette(ctx, f.d, '#ffffff', INK);
    else {
      this.drawBody(ctx, f, false);
      if (white > 0) {
        ctx.globalAlpha = white * 0.8;
        this.silhouette(ctx, f.d, '#ffffff', null);
      }
    }
    ctx.restore();

    this.drawTrail(ctx, f);

    // Charging super: energy pulled into the palm
    if (f.attack?.name === 'special' && !f.attack.fired) {
      const [hx, hy] = this.toWorld(f, [f.d.handF[0] + 10, f.d.handF[1] + 4]);
      const at = f.attack.t;
      drawGlow(ctx, hx, hy, 50 + at * 300, f.color, 0.85);
      drawGlow(ctx, hx, hy, 18 + at * 60, '#ffffff', 0.9, 0.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = k * 0.785 + this.time * 3;
        const ph = (this.time * 3.2 + k * 0.37) % 1;
        const r0 = 150 * (1 - ph) + 20;
        ctx.moveTo(hx + Math.cos(a) * r0, hy + Math.sin(a) * r0);
        ctx.lineTo(hx + Math.cos(a) * r0 * 0.6, hy + Math.sin(a) * r0 * 0.6);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Motion smear: a tapered ribbon along the recent path of the striking hand or foot.
  drawTrail(ctx, f) {
    const pts = this.vis[f.i].trail;
    if (pts.length < 2) return;
    const path = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      // Catmull-Rom so arcs (roundhouse, uppercut) stay round
      for (let s = 0; s < 4; s++) {
        const t = s / 4;
        const t2 = t * t;
        const t3 = t2 * t;
        const cr = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
        path.push([cr(p0.x, p1.x, p2.x, p3.x), cr(p0.y, p1.y, p2.y, p3.y), lerp(p1.age, p2.age, t)]);
      }
    }
    const last = pts[pts.length - 1];
    path.push([last.x, last.y, last.age]);
    const maxW = last.kick ? 30 : 20;
    const fade = 1 - last.age / TRAIL_LIFE;
    const n = path.length - 1;
    const left = [];
    const right = [];
    for (let i = 0; i <= n; i++) {
      const a = path[Math.max(0, i - 1)];
      const b = path[Math.min(n, i + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const w = maxW * 0.5 * (i / n) * fade;
      left.push(path[i][0] - ty * w, path[i][1] + tx * w);
      right.push(path[i][0] + ty * w, path[i][1] - tx * w);
    }
    const head = path[n];
    const tail = path[0];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1]);
    g.addColorStop(0, rgba(f.color, 0));
    g.addColorStop(0.6, rgba(f.color, 0.45 * fade));
    g.addColorStop(1, `rgba(255,255,255,${(0.85 * fade).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(left[0], left[1]);
    for (let i = 2; i < left.length; i += 2) ctx.lineTo(left[i], left[i + 1]);
    for (let i = right.length - 2; i >= 0; i -= 2) ctx.lineTo(right[i], right[i + 1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Flat one-colour body (impact frames, afterimages), optionally with an ink keyline.
  silhouette(ctx, d, color, outline) {
    const geo = bodyGeom(d);
    const segs = limbSegs(d, geo);
    const pass = (grow, col) => {
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      for (const [a, b, w] of segs) {
        ctx.lineWidth = w + grow;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.lineWidth = grow;
      const shape = (trace) => {
        ctx.beginPath();
        trace();
        ctx.fill();
        if (grow) ctx.stroke();
      };
      shape(() => roundPoly(ctx, geo.torso, 8, 0, 0));
      shape(() => hairPath(ctx, d.head, 0, 0));
      shape(() => {
        for (const [c, r] of [[d.head, 20], [d.handB, 12], [d.handF, 12]]) {
          ctx.moveTo(c[0] + r, c[1]);
          ctx.arc(c[0], c[1], r, 0, TAU);
        }
        for (const b of geo.boots) {
          ctx.moveTo(b.x + Math.cos(b.a) * 15, b.y + Math.sin(b.a) * 15);
          ctx.ellipse(b.x, b.y, 15, 8, b.a, 0, TAU);
        }
      });
    };
    if (outline) pass(5, outline);
    pass(0, color);
  }

  /*
   * Cel-shaded fighter in local space. Every part gets an ink keyline, a two-tone
   * shadow/lit split facing the key light, a warm rim on the lit edge and a cool
   * bounce rim on the shadow edge. `simple` draws flat colours (floor reflection).
   */
  drawBody(ctx, f, simple) {
    const d = f.d;
    const pal = f.pal;
    const geo = bodyGeom(d);
    const [lx, ly] = this.lightDir(f);

    const seg = (a, b, w, ox, oy) => {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a[0] + ox, a[1] + oy);
      ctx.lineTo(b[0] + ox, b[1] + oy);
      ctx.stroke();
    };
    // Limbs are round-capped strokes: the lit band is a narrower stroke nudged toward the light.
    const limb = (segs, lit, dark) => {
      if (!simple) {
        ctx.strokeStyle = INK;
        for (const [a, b, w] of segs) seg(a, b, w + 5, 0, 0);
      }
      ctx.strokeStyle = simple ? lit : dark;
      for (const [a, b, w] of segs) seg(a, b, w, 0, 0);
      if (simple) return;
      ctx.strokeStyle = lit;
      for (const [a, b, w] of segs) seg(a, b, w * 0.62, lx * w * 0.19, ly * w * 0.19);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= 0.8;
      ctx.strokeStyle = RIM;
      for (const [a, b, w] of segs) seg(a, b, w * 0.16, lx * w * 0.41, ly * w * 0.41);
      ctx.globalAlpha *= 0.35;
      ctx.strokeStyle = BOUNCE;
      for (const [a, b, w] of segs) seg(a, b, w * 0.14, -lx * w * 0.42, -ly * w * 0.42);
      ctx.restore();
    };
    // Closed shapes: `trace(dx, dy)` adds the outline offset by (dx, dy). The lit area is the
    // shape intersected with itself shifted toward the light; rims are even-odd crescents.
    const solid = (trace, lit, dark, depth, rim) => {
      ctx.beginPath();
      trace(0, 0);
      ctx.fillStyle = simple ? lit : dark;
      ctx.fill();
      if (simple) return;
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      trace(lx * depth, ly * depth);
      ctx.fillStyle = lit;
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= 0.8;
      ctx.beginPath();
      trace(0, 0);
      trace(-lx * rim, -ly * rim);
      ctx.fillStyle = RIM;
      ctx.fill('evenodd');
      ctx.globalAlpha *= 0.35;
      ctx.beginPath();
      trace(0, 0);
      trace(lx * rim, ly * rim);
      ctx.fillStyle = BOUNCE;
      ctx.fill('evenodd');
      ctx.restore();
      ctx.beginPath();
      trace(0, 0);
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
    };
    const circle = (c, r) => (dx, dy) => {
      ctx.moveTo(c[0] + dx + r, c[1] + dy);
      ctx.arc(c[0] + dx, c[1] + dy, r, 0, TAU);
    };
    const boot = (b) => (dx, dy) => {
      ctx.moveTo(b.x + dx + Math.cos(b.a) * 15, b.y + dy + Math.sin(b.a) * 15);
      ctx.ellipse(b.x + dx, b.y + dy, 15, 8, b.a, 0, TAU);
    };
    // Gloves get a glossy highlight on the lit side.
    const glove = (hand, lit, dark) => {
      solid(circle(hand, 12), lit, dark, 6, 4.5);
      if (simple) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(hand[0] + lx * 5, hand[1] + ly * 5, 3.6, 2.4, Math.atan2(ly, lx) + Math.PI / 2, 0, TAU);
      ctx.fill();
      ctx.restore();
    };

    limb([[d.sB, d.elbowB, 14], [d.elbowB, d.handB, 12]], pal.skinBL, pal.skinBD);
    glove(d.handB, pal.accBL, pal.accBD);
    limb([[d.hip, d.kneeB, 22], [d.kneeB, d.footB, 17]], pal.legBL, pal.legBD);
    solid(boot(geo.boots[0]), pal.accBL, pal.accBD, 5, 4.5);
    limb([[d.neck, geo.neckTop, 12]], pal.skinL, pal.skinD);

    // Gi jacket with an open collar
    solid((dx, dy) => roundPoly(ctx, geo.torso, 8, dx, dy), pal.topL, pal.topD, 10, 5.5);
    if (!simple) {
      const top = geo.sl - 4;
      const c0 = geo.at(top + 1, 2);
      const c1 = geo.at(top + 1, 18);
      const c2 = geo.at(geo.sl * 0.52, 11);
      ctx.fillStyle = pal.skinD;
      ctx.beginPath();
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c1[0], c1[1]);
      ctx.lineTo(c2[0], c2[1]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pal.topHi;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c2[0], c2[1]);
      ctx.lineTo(c1[0], c1[1]);
      ctx.stroke();
    }

    // Belt with trailing tails
    const b0 = geo.at(5, 17.5);
    const b1 = geo.at(5, -17.5);
    ctx.lineCap = 'butt';
    if (!simple) {
      ctx.strokeStyle = INK;
      seg(b0, b1, 12, 0, 0);
    }
    ctx.strokeStyle = simple ? pal.accL : pal.accD;
    seg(b0, b1, 8, 0, 0);
    if (!simple) {
      ctx.strokeStyle = pal.accL;
      seg(b0, b1, 3.5, lx * 2, ly * 2);
    }
    ctx.lineCap = 'round';
    const knot = geo.at(5, 13);
    for (const [len, off] of [[30, 0.25], [24, 0.55]]) {
      const ang = Math.PI / 2 + off + f.cloth + Math.sin(this.time * 9 + off * 7 + f.i) * 0.08;
      ribbon(
        ctx,
        knot[0],
        knot[1],
        knot[0] + Math.cos(ang - 0.25) * len * 0.5,
        knot[1] + Math.sin(ang - 0.25) * len * 0.5,
        knot[0] + Math.cos(ang) * len,
        knot[1] + Math.sin(ang) * len,
        5.5,
        2.2,
        pal.accL,
        !simple && INK,
      );
    }

    limb([[d.hip, d.kneeF, 22], [d.kneeF, d.footF, 17]], pal.legL, pal.legD);
    solid(boot(geo.boots[1]), pal.accL, pal.accD, 5, 4.5);

    // Head, ear, hair, headband
    const hx = d.head[0];
    const hy = d.head[1];
    solid(circle(d.head, 20), pal.skinL, pal.skinD, 8, 5.5);
    if (!simple) {
      ctx.fillStyle = pal.skinD;
      ctx.beginPath();
      ctx.ellipse(hx - 4, hy + 4, 4, 5, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    solid((dx, dy) => hairPath(ctx, d.head, dx, dy), HAIR_L, HAIR_D, 6, 4.5);
    // Headband tails stream behind on the cloth spring.
    const wave = Math.sin(this.time * 14 + f.i) * (4 + Math.abs(f.cloth) * 4);
    const lift = f.cloth * 16;
    ribbon(ctx, hx - 19, hy - 11, hx - 39, hy - 9 + wave - lift * 0.5, hx - 60 - lift * 0.3, hy + 1 - wave - lift, 7, 2.5, pal.accL, !simple && INK);
    ribbon(ctx, hx - 19, hy - 8, hx - 37, hy + 6 - wave - lift * 0.5, hx - 52 - lift * 0.3, hy + 19 + wave - lift, 6, 2, pal.accD, !simple && INK);
    if (!simple) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect(hx - 22.5, hy - 15.5, 45, 12, 4);
      ctx.fill();
    }
    ctx.fillStyle = simple ? pal.accL : pal.accD;
    ctx.beginPath();
    ctx.roundRect(hx - 21, hy - 14, 42, 9, 3);
    ctx.fill();
    if (!simple) {
      ctx.fillStyle = pal.accL;
      ctx.fillRect(hx - 20, hy - 14, 40, 3.5);
      // Face: a set brow and one eye in profile
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(hx + 6, hy - 3);
      ctx.lineTo(hx + 17, hy);
      ctx.stroke();
      if (f.ko || f.st === 'down') {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(hx + 9, hy + 5);
        ctx.lineTo(hx + 16, hy + 5);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#f4f0ff';
        ctx.beginPath();
        ctx.ellipse(hx + 12.5, hy + 4, 3.6, 2.4, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(hx + 14, hy + 4, 1.8, 2.2, 0, 0, TAU);
        ctx.fill();
      }
    }

    limb([[d.sF, d.elbowF, 14], [d.elbowF, d.handF, 12]], pal.skinL, pal.skinD);
    glove(d.handF, pal.accL, pal.accD);
  }

  // Super fireball: layered glow, spinning rings, flame tongues trailing behind.
  drawProjectile(ctx, p) {
    const c = p.owner.color;
    const dir = Math.sign(p.vx) || 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) {
      const len = 160 - k * 38;
      const wob = Math.sin(p.t * (34 + k * 9) + k) * 10;
      const grad = ctx.createLinearGradient(p.x, 0, p.x - dir * len, 0);
      grad.addColorStop(0, rgba(c, 0.75));
      grad.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 30 + k * 8);
      ctx.quadraticCurveTo(p.x - dir * len * 0.5, p.y - 14 + wob, p.x - dir * len, p.y + wob * 0.5);
      ctx.quadraticCurveTo(p.x - dir * len * 0.5, p.y + 14 + wob, p.x, p.y + 30 - k * 8);
      ctx.closePath();
      ctx.fill();
    }
    drawGlow(ctx, p.x, p.y, 130, c, 0.85, 0.05);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 34 + k * 10, 14 + k * 6, p.t * (8 + k * 5) * dir, 0, TAU);
      ctx.stroke();
    }
    drawGlow(ctx, p.x, p.y, 54 + Math.sin(p.t * 30) * 4, c, 1, 0.35);
    drawGlow(ctx, p.x, p.y, 26, '#ffffff', 1, 0.6);
    ctx.restore();
  }

  drawSuperCutIn(ctx) {
    const s = this.superFlash;
    if (s <= 0) return;
    // Letterbox bars slide in for the super freeze.
    const bars = 64 * clamp(s * 2.5, 0, 1);
    ctx.fillStyle = '#030107';
    ctx.fillRect(0, 0, W, bars);
    ctx.fillRect(0, H - bars, W, bars);
    const f = this.superUser();
    const a = clamp((s - 0.3) / 0.2, 0, 1);
    if (!f || a <= 0) return;
    const left = f.i === 0;
    const age = (1 - s) / 1.6;
    const slide = 1 - Math.pow(1 - clamp(age / 0.12, 0, 1), 3);
    const y = 230;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate((1 - slide) * W * 0.6 * (left ? -1 : 1), 0);
    const g = ctx.createLinearGradient(left ? 0 : W, 0, left ? W : 0, 0);
    g.addColorStop(0, rgba(f.color, 0.92));
    g.addColorStop(0.5, rgba(f.color, 0.5));
    g.addColorStop(1, rgba(f.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, y - 50);
    ctx.lineTo(W, y - 38);
    ctx.lineTo(W, y + 42);
    ctx.lineTo(0, y + 54);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(0, y - 58, W, 2);
    ctx.fillRect(0, y + 58, W, 2);
    const tx = left ? 110 : W - 110;
    const align = left ? 'left' : 'right';
    ctx.save();
    ctx.translate(tx, y - 6);
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    label(ctx, 'SUPER ART', 0, 0, { size: 66, sw: 6, stroke: 'rgba(0,0,0,0.45)', align, spacing: 10 });
    ctx.restore();
    label(ctx, f.name.toUpperCase(), tx + (left ? 6 : -6), y + 34, { size: 20, weight: 600, fill: 'rgba(255,255,255,0.88)', align, spacing: 5 });
    ctx.restore();
  }

  drawHud(ctx) {
    const [a, b] = this.fighters;
    // Soft scrim so the HUD reads over the bright sky
    const scrim = ctx.createLinearGradient(0, 0, 0, 170);
    scrim.addColorStop(0, 'rgba(4,2,10,0.6)');
    scrim.addColorStop(1, 'rgba(4,2,10,0)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, 170);
    if (a) this.drawPlayerHud(ctx, a, true);
    if (b) this.drawPlayerHud(ctx, b, false);

    // Timer: a glass trapezoid the two bars lean into
    const cx = W / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - 80, 22);
    ctx.lineTo(cx + 80, 22);
    ctx.lineTo(cx + 50, 98);
    ctx.lineTo(cx - 50, 98);
    ctx.closePath();
    const tg = ctx.createLinearGradient(0, 22, 0, 98);
    tg.addColorStop(0, 'rgba(30,26,52,0.86)');
    tg.addColorStop(1, 'rgba(8,6,18,0.92)');
    ctx.fillStyle = tg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(cx - 80, 22, 160, 3);
    ctx.restore();
    const urgent = this.clock < 10 && this.state === 'fight';
    const beat = urgent ? Math.max(0, Math.sin(this.clock * TAU)) : 0;
    label(ctx, String(Math.max(0, Math.ceil(this.clock))).padStart(2, '0'), cx, 58, { size: Math.round(54 * (1 + beat * 0.08)), fill: urgent ? '#ff4d6a' : '#ffffff' });
    label(ctx, `ROUND ${this.round}`, cx, 87, { size: 14, weight: 600, fill: 'rgba(220,214,255,0.7)', spacing: 3 });
  }

  drawPlayerHud(ctx, f, left) {
    const sgn = left ? -1 : 1;
    const IN = 86; // centre line to the inner end of the bar
    const BW = 620;
    const BY = 36;
    const BH = 24;
    const SK = -0.4; // bars lean in toward the timer
    const t = this.time;
    const X = (lx) => W / 2 + sgn * (IN + lx);
    const align = left ? 'left' : 'right';
    const ny = 90;
    const nlx = BW + SK * (ny - BY) - 22;

    // Bars live in a mirrored local space where +x runs outward from the timer.
    ctx.save();
    ctx.translate(W / 2 + sgn * IN, 0);
    ctx.scale(sgn, 1);
    slant(ctx, -12, BY - 8, BW + 24, BH + 24, SK);
    const pg = ctx.createLinearGradient(0, BY - 8, 0, BY + BH + 16);
    pg.addColorStop(0, 'rgba(24,20,40,0.7)');
    pg.addColorStop(1, 'rgba(6,5,14,0.8)');
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    slant(ctx, -12, BY - 8, BW + 24, 2, SK);
    ctx.fillStyle = f.color;
    ctx.fill();
    // Health, with recent damage as a ghost segment that drains after a beat
    const low = f.hp <= 30;
    const hc = low && Math.floor(t * 6) % 2 ? '#ffb020' : low ? '#ff7a3d' : f.color;
    meter(ctx, 0, BY, BW, BH, f.hp / 100, hc, { ghost: f.shownHp / 100, skew: SK, back: 'rgba(255,255,255,0.06)' });
    ctx.save();
    ctx.transform(1, 0, SK, 1, -SK * BY, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, BY, BW * clamp(f.hp / 100, 0, 1), BH * 0.32);
    ctx.restore();
    // Guard meter
    const gy = BY + BH + 5;
    const gc = f.st === 'guardbreak' ? '#ff3b5c' : f.guard < 35 && Math.floor(t * 8) % 2 ? '#ffb020' : GUARD_SPARK;
    meter(ctx, SK * (gy - BY), gy, BW * 0.62, 6, f.guard / GUARD_MAX, gc, { skew: SK, glow: false, back: 'rgba(255,255,255,0.08)' });
    // Round pips by the timer
    ctx.lineWidth = 1;
    for (let k = 0; k < WINS_NEEDED; k++) {
      const won = k < f.wins;
      slant(ctx, k * 30 - 12, ny - 6, 22, 10, SK);
      ctx.fillStyle = won ? '#ffd166' : 'rgba(255,255,255,0.1)';
      ctx.fill();
      ctx.strokeStyle = won ? 'rgba(255,240,200,0.9)' : 'rgba(255,255,255,0.25)';
      ctx.stroke();
    }
    // Player-colour chip beside the name
    slant(ctx, nlx + 8, ny - 8, 9, 16, SK);
    ctx.fillStyle = f.color;
    ctx.fill();
    ctx.restore();

    for (let k = 0; k < Math.min(f.wins, WINS_NEEDED); k++) drawGlow(ctx, X(k * 30 - 3), ny - 1, 24, '#ffd166', 0.5);
    const name = f.name.toUpperCase();
    label(ctx, name, X(nlx), ny, { size: 24, align, spacing: 2 });
    if (f.cpu) {
      const nw = textWidth(ctx, name, 24, 2);
      label(ctx, 'CPU', X(nlx) - sgn * (nw + 10), ny + 1, { size: 14, weight: 600, fill: 'rgba(200,196,240,0.65)', align, spacing: 2 });
    }

    // Super meter in the bottom corner: four segments, glowing when ready
    const full = f.meter >= 100;
    const edge = left ? 52 : W - 52;
    const SY = H - 46;
    glassPanel(ctx, left ? edge : edge - 344, SY - 40, 344, 62, { r: 8, accent: f.color, accentSide: left ? 'left' : 'right' });
    ctx.save();
    ctx.translate(edge, 0);
    ctx.scale(-sgn, 1);
    meter(ctx, 18, SY, 300, 13, f.meter / 100, full ? '#ffd166' : '#38d9ff', { segments: 4, skew: -0.5, back: 'rgba(255,255,255,0.07)' });
    ctx.restore();
    const lx0 = edge - sgn * 18;
    label(ctx, 'SUPER', lx0, SY - 20, { size: 15, weight: 600, fill: full ? '#ffe6a8' : 'rgba(205,200,245,0.75)', align, spacing: 4 });
    if (full) {
      const pulse = 0.5 + Math.sin(t * 7) * 0.5;
      drawGlow(ctx, edge - sgn * 168, SY + 6, 120, '#ffd166', 0.25 + pulse * 0.25, 0.05);
      label(ctx, 'READY  ·  A+B', edge - sgn * 318, SY - 20, { size: 15, fill: '#ffd166', align: left ? 'right' : 'left', spacing: 3, alpha: 0.7 + pulse * 0.3 });
    }

    // Combo counter and callouts on the attacker's side
    const cx = left ? 64 : W - 64;
    if (f.combo >= 2 && f.comboT > 0) {
      const alpha = clamp(f.comboT / 0.4, 0, 1);
      const pop = 1 + f.comboPop * 0.35;
      const num = String(f.combo);
      const nw = textWidth(ctx, num, 84);
      ctx.save();
      ctx.translate(cx, 248);
      ctx.transform(1, 0, -0.18, 1, 0, 0);
      ctx.scale(pop, pop);
      const grad = ctx.createLinearGradient(0, -34, 0, 34);
      grad.addColorStop(0, '#fff6d6');
      grad.addColorStop(1, '#ffb020');
      label(ctx, num, 0, 0, { size: 84, fill: grad, align, sw: 8, alpha });
      label(ctx, 'HITS', -sgn * (nw + 10), 16, { size: 30, align, sw: 6, spacing: 3, alpha });
      ctx.restore();
      label(ctx, `${Math.round(f.comboDmg)} DMG`, cx, 298, { size: 20, weight: 600, fill: 'rgba(255,240,200,0.92)', align, sw: 4, spacing: 2, alpha });
    }
    if (f.callout && f.callout.t > 0) {
      const c = f.callout;
      const slide = 1 - Math.pow(1 - clamp((1.3 - c.t) / 0.14, 0, 1), 3);
      const alpha = clamp(c.t / 0.3, 0, 1) * slide;
      const x = cx + sgn * (1 - slide) * 80;
      const tw = textWidth(ctx, c.str, 32, 3);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, 0);
      ctx.scale(-sgn, 1);
      slant(ctx, -10, 316, tw + 34, 38, -0.35);
      ctx.fillStyle = 'rgba(6,3,14,0.72)';
      ctx.fill();
      slant(ctx, -10, 316, 5, 38, -0.35);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.restore();
      label(ctx, c.str, x - sgn * 12, 336, { size: 32, fill: c.color, align, spacing: 3, alpha });
    }
  }

  drawTitles(ctx) {
    const age = this.titleT;
    if (this.state === 'intro') {
      if (this.stateT <= 0.8) this.drawTitle(ctx, 'FIGHT!', '', '#ffd166', age, clamp(this.stateT / 0.22, 0, 1));
      else {
        const final = this.round > 1 && this.fighters.every((f) => f.wins === WINS_NEEDED - 1);
        this.drawTitle(ctx, `ROUND ${this.round}`, final ? 'Final round' : 'Get ready', '#ffffff', age, clamp((this.stateT - 0.8) / 0.18, 0, 1));
      }
    } else if (this.state === 'ko') {
      const w = this.roundWinner;
      const ko = this.koTitle === 'K.O.!';
      this.drawTitle(ctx, this.koTitle, w ? `${w.name} takes round ${this.round}` : 'Draw — nobody scores', ko ? '#ff3b5c' : '#ffd166', age, clamp(this.stateT / 0.3, 0, 1));
    } else if (this.state === 'over') {
      const w = this.fighters.find((f) => f.wins >= WINS_NEEDED);
      this.drawTitle(ctx, `${w?.name ?? ''} WINS`, '', w?.color ?? '#ffffff', age, 1);
    }
  }

  // Broadcast-style title: a slanted band wipes in and the word slams down from oversized.
  drawTitle(ctx, main, sub, color, age, fade) {
    if (fade <= 0) return;
    const y = 372;
    const ease = 1 - Math.pow(1 - clamp(age / 0.22, 0, 1), 3);
    ctx.save();
    ctx.globalAlpha = fade;
    const half = (W / 2 + 120) * ease;
    if (half > 1) {
      const band = ctx.createLinearGradient(W / 2 - half, 0, W / 2 + half, 0);
      band.addColorStop(0, 'rgba(6,3,14,0)');
      band.addColorStop(0.2, 'rgba(6,3,14,0.74)');
      band.addColorStop(0.8, 'rgba(6,3,14,0.74)');
      band.addColorStop(1, 'rgba(6,3,14,0)');
      ctx.fillStyle = band;
      ctx.beginPath();
      ctx.moveTo(W / 2 - half + 36, y - 88);
      ctx.lineTo(W / 2 + half + 36, y - 88);
      ctx.lineTo(W / 2 + half - 36, y + 88);
      ctx.lineTo(W / 2 - half - 36, y + 88);
      ctx.closePath();
      ctx.fill();
      const lw = 600 * ease;
      const line = ctx.createLinearGradient(W / 2 - lw, 0, W / 2 + lw, 0);
      line.addColorStop(0, rgba(color, 0));
      line.addColorStop(0.5, rgba(color, 0.95));
      line.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = line;
      ctx.fillRect(W / 2 - lw + 34, y - 88, lw * 2, 2);
      ctx.fillRect(W / 2 - lw - 34, y + 86, lw * 2, 2);
    }
    ctx.restore();

    const slam = 1 + Math.pow(1 - ease, 2) * 0.9;
    const size = main.length > 9 ? 108 : 136;
    ctx.save();
    ctx.translate(W / 2, y - (sub ? 14 : 0));
    ctx.transform(1, 0, -0.17, 1, 0, 0);
    ctx.scale(slam, slam);
    const grad = ctx.createLinearGradient(0, -size * 0.42, 0, size * 0.42);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.45, mix(color, '#ffffff', 0.45));
    grad.addColorStop(1, color);
    label(ctx, main.toUpperCase(), 0, 0, { size, fill: grad, sw: 10, spacing: 6, alpha: fade * clamp(age / 0.05, 0, 1) });
    ctx.restore();
    if (age < 0.32) drawGlow(ctx, W / 2, y, 560 * (0.5 + age * 2), color, (1 - age / 0.32) * 0.45 * fade, 0.05);
    if (sub) label(ctx, sub.toUpperCase(), W / 2, y + 58, { size: 26, weight: 600, fill: 'rgba(236,232,255,0.92)', spacing: 6, alpha: fade * clamp((age - 0.1) / 0.25, 0, 1) });
  }
}

export default {
  id: 'battle-clash',
  title: 'Battle Clash',
  art: 'fight',
  genre: 'Fighting',
  accent: '#ff4d6d',
  tagline: 'Choose your fighter and battle it out, 1v1. Best of three rounds.',
  minPlayers: 2,
  maxPlayers: 2,
  cpu: true,
  controls: { move: 'Walk · up jump · down block', a: 'Punch · ↓ uppercut', b: 'Kick · ↓ sweep' },
  howTo: [
    'Left/right to walk, up to jump, hold down to crouch-block. Blocking still chips you and drains your GUARD bar — let it empty and your guard breaks.',
    'Chain A → A → B on hit for a combo that ends in a wall-bouncing roundhouse.',
    'Down + A launches with an uppercut — hold up to jump after it and juggle. Down + B sweeps. Toward + A up close throws, which beats blocking.',
    'Landing hits fills SUPER — then press A + B for a fireball. KO them or lead on health when the clock hits zero.',
  ],
  post: POST,
  create: (opts) => new BattleClash(opts),
};
