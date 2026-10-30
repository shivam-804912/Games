import { mulberry32, shade } from '../utils/random.js';
import { H, IDLE, Particles, TAU, W, banner, clamp, lerp, makeCanvas, rand, text } from './engine/util.js';

/*
 * Battle Clash — 1v1 side-view fighter. Jab/cross/roundhouse chains, launchers
 * and juggles, sweeps, throws, a guard meter that can break, and a super
 * fireball with A+B once the meter is full. Best of 3.
 *
 * Fighters are a 2-bone IK skeleton: each state picks a target pose (hips,
 * neck, head, hands, feet), the joints ease toward it, and knees/elbows are
 * solved every frame so limbs never stretch. The camera pans and zooms to keep
 * both fighters framed over a parallax arena.
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

const SKIN = '#e9b48f';

/* ------------------------------------------------------------------ Stage */

// Far sky: never moves.
function buildSky() {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 700);
  sky.addColorStop(0, '#12020a');
  sky.addColorStop(0.5, '#5c0b1c');
  sky.addColorStop(1, '#d4332a');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  const rnd = mulberry32(3);
  for (let k = 0; k < 120; k++) {
    g.fillStyle = `rgba(255,230,220,${0.2 + rnd() * 0.5})`;
    g.fillRect(rnd() * W, rnd() * 300, 2, 2);
  }

  // Striped sun
  g.save();
  const sun = g.createLinearGradient(0, 160, 0, 520);
  sun.addColorStop(0, '#ffd36b');
  sun.addColorStop(1, '#ff2e5a');
  g.shadowColor = '#ff7a4d';
  g.shadowBlur = 80;
  g.fillStyle = sun;
  g.beginPath();
  g.arc(W / 2, 400, 190, 0, TAU);
  g.fill();
  g.shadowBlur = 0;
  g.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 6; k++) g.fillRect(0, 420 + k * 24, W, 4 + k * 2.5);
  g.restore();

  // Thin cloud bands across the sun
  g.fillStyle = 'rgba(40,4,14,0.55)';
  for (const [x, y, w] of [[380, 300, 420], [900, 350, 520], [200, 470, 380], [1100, 250, 300]]) {
    g.beginPath();
    g.ellipse(x, y, w / 2, 9, 0, 0, TAU);
    g.fill();
  }
  return c;
}

// Mid layer: city blocks and pagodas.
function buildSkyline() {
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const rnd = mulberry32(11);
  g.fillStyle = '#2a0610';
  for (let x = -20; x < W + 20; x += 70) {
    const h = 80 + ((x * 37) % 140);
    g.fillRect(x, 610 - h, 64, h);
    for (let wy = 610 - h + 12; wy < 590; wy += 18) {
      for (let wx = x + 8; wx < x + 58; wx += 14) {
        if (rnd() < 0.22) {
          g.fillStyle = rnd() < 0.5 ? 'rgba(255,190,110,0.55)' : 'rgba(255,120,90,0.4)';
          g.fillRect(wx, wy, 6, 8);
        }
      }
    }
    g.fillStyle = '#2a0610';
  }
  g.fillStyle = '#1a0309';
  const pagoda = (cx, base, s) => {
    for (let k = 0; k < 3; k++) {
      const w = (220 - k * 50) * s;
      const y = base - k * 70 * s;
      g.beginPath();
      g.moveTo(cx - w / 2 - 30 * s, y - 40 * s);
      g.quadraticCurveTo(cx, y - 70 * s, cx + w / 2 + 30 * s, y - 40 * s);
      g.lineTo(cx + w / 2, y - 30 * s);
      g.lineTo(cx + w / 2, y);
      g.lineTo(cx - w / 2, y);
      g.lineTo(cx - w / 2, y - 30 * s);
      g.closePath();
      g.fill();
    }
  };
  pagoda(220, 630, 1);
  pagoda(1380, 630, 1);
  return c;
}

// Three rows of spectators, each its own strip so rows can bounce independently.
function buildCrowd() {
  const rnd = mulberry32(7);
  const rows = [];
  const cols = ['#2e0813', '#1e040c', '#120208'];
  for (let row = 0; row < 3; row++) {
    const c = makeCanvas(W, 120);
    const g = c.getContext('2d');
    const base = 112;
    g.lineCap = 'round';
    for (let x = -10 + row * 13; x < W + 20; x += 24 + rnd() * 8) {
      const h = rnd() * 12;
      g.fillStyle = cols[row];
      g.strokeStyle = cols[row];
      g.beginPath();
      g.arc(x, base - 58 - h, 11, 0, TAU);
      g.fill();
      g.beginPath();
      g.roundRect(x - 16, base - 48 - h, 32, 56, 10);
      g.fill();
      if (rnd() < 0.3) {
        g.lineWidth = 7;
        g.beginPath();
        g.moveTo(x + 11, base - 40 - h);
        g.lineTo(x + 18, base - 84 - h);
        g.stroke();
        if (rnd() < 0.4) {
          g.fillStyle = ['#38d9ff', '#ffd166', '#ff5fc8'][Math.floor(rnd() * 3)];
          g.fillRect(x + 16, base - 104 - h, 4, 20);
        }
      }
      // Rim light from the arena lamps
      g.fillStyle = 'rgba(255,140,100,0.14)';
      g.beginPath();
      g.arc(x - 2, base - 61 - h, 9, Math.PI, Math.PI * 1.7);
      g.fill();
    }
    rows.push(c);
  }
  return rows;
}

// Arena floor, drawn in world space at y = FLOOR_Y.
const FLOOR_Y = 690;
function buildFloor() {
  const c = makeCanvas(W, H - FLOOR_Y);
  const g = c.getContext('2d');
  g.translate(0, -FLOOR_Y);
  g.fillStyle = '#0d0206';
  g.fillRect(0, FLOOR_Y, W, 14);
  for (let x = 20; x < W; x += 80) {
    g.fillStyle = 'rgba(255,190,120,0.6)';
    g.fillRect(x, FLOOR_Y + 5, 10, 4);
  }
  const floor = g.createLinearGradient(0, 704, 0, H);
  floor.addColorStop(0, '#3e0c19');
  floor.addColorStop(0.35, '#26060f');
  floor.addColorStop(1, '#0c0206');
  g.fillStyle = floor;
  g.fillRect(0, 704, W, H - 704);
  // Polished sheen
  const sheen = g.createLinearGradient(0, GROUND, 0, H);
  sheen.addColorStop(0, 'rgba(255,140,110,0.1)');
  sheen.addColorStop(1, 'rgba(255,140,110,0)');
  g.fillStyle = sheen;
  g.fillRect(0, GROUND, W, H - GROUND);
  g.strokeStyle = 'rgba(255,120,120,0.1)';
  g.lineWidth = 2;
  for (let k = -12; k <= 12; k++) {
    g.beginPath();
    g.moveTo(W / 2 + k * 60, 704);
    g.lineTo(W / 2 + k * 190, H);
    g.stroke();
  }
  for (let k = 0; k < 5; k++) {
    const y = 704 + Math.pow(k / 5, 1.6) * 196;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  g.save();
  g.shadowColor = '#ff6b3d';
  g.shadowBlur = 20;
  g.strokeStyle = '#ff8a5c';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(STAGE_L - 30, GROUND + 14);
  g.lineTo(STAGE_R + 30, GROUND + 14);
  g.stroke();
  g.restore();
  return c;
}

function buildLantern() {
  const c = makeCanvas(60, 96);
  const g = c.getContext('2d');
  g.strokeStyle = '#2a0610';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(30, 0);
  g.lineTo(30, 14);
  g.stroke();
  const body = g.createRadialGradient(26, 46, 4, 30, 50, 30);
  body.addColorStop(0, '#ffe2a0');
  body.addColorStop(0.45, '#ff5a3c');
  body.addColorStop(1, '#8a0f1e');
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(30, 50, 24, 32, 0, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(80,6,16,0.6)';
  g.lineWidth = 1.5;
  for (const k of [-14, -5, 5, 14]) {
    g.beginPath();
    g.ellipse(30, 50, Math.abs(k), 32, 0, 0, TAU);
    g.stroke();
  }
  g.fillStyle = '#d9a441';
  g.fillRect(20, 14, 20, 6);
  g.fillRect(20, 80, 20, 6);
  g.strokeStyle = '#d9a441';
  g.beginPath();
  g.moveTo(30, 86);
  g.lineTo(30, 96);
  g.stroke();
  return c;
}

function buildGlow(color, r) {
  const c = makeCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
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
    this.sky = buildSky();
    this.skyline = buildSkyline();
    this.crowd = buildCrowd();
    this.floor = buildFloor();
    this.lantern = buildLantern();
    this.lanternGlow = buildGlow('rgba(255,140,70,0.5)', 70);
    this.flashGlow = buildGlow('rgba(255,255,255,0.9)', 24);
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
      pal: { dark: shade(p.color, -0.55), light: shade(p.color, -0.3), skinB: shade(SKIN, -0.25) },
    }));
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
    this.sparks.push({ x, y, size, color, t: 0, max: 0.24, rot: rand(TAU) });
  }

  puff(x, count, power) {
    for (let k = 0; k < count; k++) {
      const s = k % 2 ? 1 : -1;
      this.dust.push({ x: x + rand(-24, 24), y: GROUND - rand(2, 10), vx: s * rand(0.3, 1) * power, vy: -rand(5, 40), r: rand(5, 11), life: rand(0.35, 0.6), max: 0.6 });
    }
  }

  callout(f, str, color) {
    f.callout = { str, color, t: 1.3 };
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
    const sh = Math.min(this.shake, CAM_MARGIN - 2);
    const sx = sh ? rand(-sh, sh) : 0;
    const sy = sh ? rand(-sh, sh) * 0.6 : 0;
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

    ctx.drawImage(this.sky, 0, 0);
    layer(0.3, () => ctx.drawImage(this.skyline, 0, 0));
    layer(0.6, () => this.drawCrowd(ctx));
    layer(0.85, () => this.drawLanterns(ctx));
    layer(1, () => {
      ctx.drawImage(this.floor, 0, FLOOR_Y);
      this.drawSpotlights(ctx);
      this.drawReflections(ctx);
      for (const f of this.fighters) this.drawShadow(ctx, f);
      this.drawDust(ctx);
      if (this.superFlash > 0) {
        ctx.fillStyle = `rgba(6,0,10,${Math.min(0.65, this.superFlash * 0.75)})`;
        ctx.fillRect(-50, -50, W + 100, H + 100);
      }
      // Draw the attacker on top so strikes read clearly.
      const busy = (f) => (f.st === 'attack' || f.st === 'grab' ? 1 : 0);
      const order = [...this.fighters].sort((x, y) => busy(x) - busy(y));
      for (const f of order) this.drawFighter(ctx, f, false);
      for (const p of this.projectiles) this.drawProjectile(ctx, p);
      this.drawSparks(ctx);
      this.particles.render(ctx);
    });

    if (this.screenFlash > 0) {
      ctx.fillStyle = `rgba(255,245,230,${this.screenFlash * 0.6})`;
      ctx.fillRect(0, 0, W, H);
    }

    this.drawHud(ctx);

    if (this.state === 'intro') {
      const go = this.stateT <= 0.8;
      banner(ctx, go ? 'FIGHT!' : `ROUND ${this.round}`, go ? '' : 'Get ready', { color: go ? '#ffd166' : '#fff', y: 380 });
    } else if (this.state === 'ko') {
      const w = this.roundWinner;
      banner(ctx, this.koTitle, w ? `${w.name} takes round ${this.round}` : 'Draw — nobody scores', { color: '#ff3b5c', y: 380 });
    } else if (this.state === 'over') {
      const w = this.fighters.find((f) => f.wins >= WINS_NEEDED);
      banner(ctx, `${w?.name ?? ''} WINS`, '', { color: w?.color ?? '#fff', y: 380 });
    }
  }

  drawCrowd(ctx) {
    const seg = 100;
    const amp = 1.5 + this.hype * 9;
    for (let row = 0; row < 3; row++) {
      const img = this.crowd[row];
      const y0 = CROWD_ROWS[row] - 112;
      for (let x = 0; x < W; x += seg) {
        const ph = this.time * (5 + this.hype * 5) + x * 0.017 + row * 1.9;
        const bob = -Math.abs(Math.sin(ph)) * amp;
        ctx.drawImage(img, x, 0, seg, 120, x, y0 + bob, seg, 120);
      }
    }
    // Camera flashes from the stands
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const fl of this.flashes) {
      ctx.globalAlpha = fl.t / 0.1;
      ctx.drawImage(this.flashGlow, fl.x - 24, fl.y - 24);
    }
    ctx.restore();
  }

  drawLanterns(ctx) {
    const hookY = 170;
    ctx.strokeStyle = '#2a0610';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-60, hookY - 20);
    for (const x of LANTERNS) ctx.quadraticCurveTo(x - 130, hookY + 30, x, hookY);
    ctx.quadraticCurveTo(W - 30, hookY + 30, W + 60, hookY - 20);
    ctx.stroke();
    LANTERNS.forEach((x, i) => {
      const ang = Math.sin(this.time * 1.6 + i * 1.3) * 0.05 + Math.sin(this.time * 7 + i) * this.swing * 0.25;
      ctx.save();
      ctx.translate(x, hookY);
      ctx.rotate(ang);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.6 + Math.sin(this.time * 3 + i * 2) * 0.1;
      ctx.drawImage(this.lanternGlow, -70, -20);
      ctx.restore();
      ctx.drawImage(this.lantern, -30, 0);
      ctx.restore();
    });
  }

  drawSpotlights(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const heat = 0.1 + this.hype * 0.08;
    [[300, 0.0], [1300, 2.1]].forEach(([sx, off]) => {
      const tx = sx + Math.sin(this.time * 0.6 + off) * 360;
      const beam = ctx.createLinearGradient(sx, -40, tx, GROUND);
      beam.addColorStop(0, `rgba(255,220,180,${heat + 0.06})`);
      beam.addColorStop(1, 'rgba(255,220,180,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(sx - 26, -40);
      ctx.lineTo(sx + 26, -40);
      ctx.lineTo(tx + 230, GROUND + 20);
      ctx.lineTo(tx - 230, GROUND + 20);
      ctx.fill();
      ctx.fillStyle = `rgba(255,220,180,${heat * 0.8})`;
      ctx.beginPath();
      ctx.ellipse(tx, GROUND + 16, 230, 26, 0, 0, TAU);
      ctx.fill();
    });
    ctx.restore();
  }

  // Mirror the fighters into the polished floor.
  drawReflections(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, GROUND + 4, W, H);
    ctx.clip();
    ctx.globalAlpha = 0.16;
    ctx.translate(0, GROUND + 8);
    ctx.scale(1, -0.55);
    ctx.translate(0, -(GROUND + 8));
    for (const f of this.fighters) this.drawFighter(ctx, f, true);
    ctx.restore();
  }

  drawShadow(ctx, f) {
    const h = clamp((GROUND - f.y) / 300, 0, 1);
    const lying = Math.abs(Math.sin(f.tilt));
    ctx.fillStyle = `rgba(0,0,0,${0.45 - h * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(f.x - f.facing * lying * 100 * SCALE, GROUND + 6, (60 + lying * 70) * (1 - h * 0.4), 11, 0, 0, TAU);
    ctx.fill();
  }

  drawDust(ctx) {
    for (const d of this.dust) {
      ctx.fillStyle = `rgba(190,130,115,${(d.life / d.max) * 0.35})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      ctx.fill();
    }
  }

  drawSparks(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.sparks) {
      const k = s.t / s.max;
      const r = s.size * (0.5 + k * 0.9);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2 + 4 * (1 - k);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = s.rot + (i * TAU) / 8;
        const outer = r * (i % 2 ? 0.7 : 1.25);
        ctx.moveTo(s.x + Math.cos(a) * r * 0.3, s.y + Math.sin(a) * r * 0.3);
        ctx.lineTo(s.x + Math.cos(a) * outer, s.y + Math.sin(a) * outer);
      }
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 1.1, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.28 * (1 - k), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawFighter(ctx, f, reflect) {
    const d = f.d;
    const white = f.flash > 0 && !reflect;
    const gi = white ? '#ffffff' : f.pal.dark;
    const giLight = white ? '#ffffff' : f.pal.light;
    const accent = white ? '#ffffff' : f.color;
    const skin = white ? '#ffffff' : SKIN;
    const skinB = white ? '#ffffff' : f.pal.skinB;
    const ink = '#07050f';

    ctx.save();
    // The victim shudders during hit-stop.
    const jx = this.hitstop > 0 && f.flash > 0 ? rand(-5, 5) : 0;
    ctx.translate(f.x + jx, f.y);
    ctx.scale(f.facing * SCALE * f.spinX * (1 + f.sq * 0.7), SCALE * (1 - f.sq));
    ctx.rotate(f.tilt);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const limb = (pts, width, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
    };
    // Torso: tapered from hips to chest along the spine.
    const sx = d.neck[0] - d.hip[0];
    const sy = d.neck[1] - d.hip[1];
    const sl = Math.hypot(sx, sy) || 1;
    const nx = -sy / sl;
    const ny = sx / sl;
    const chest = [d.neck[0] - (sx / sl) * 4, d.neck[1] - (sy / sl) * 4];
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(d.hip[0] + nx * 15, d.hip[1] + ny * 15);
      ctx.lineTo(chest[0] + nx * 21, chest[1] + ny * 21);
      ctx.lineTo(chest[0] - nx * 21, chest[1] - ny * 21);
      ctx.lineTo(d.hip[0] - nx * 15, d.hip[1] - ny * 15);
      ctx.closePath();
    };
    const parts = [
      { pts: [d.sB, d.elbowB, d.handB], w: 13, c: skinB },
      { pts: [d.hip, d.kneeB, d.footB], w: 19, c: gi },
      { torso: true },
      { pts: [d.hip, d.kneeF, d.footF], w: 19, c: giLight },
      { pts: [d.sF, d.elbowF, d.handF], w: 13, c: skin },
    ];

    // Glowing outline pass, then colour pass.
    ctx.save();
    if (!reflect) {
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 18;
    }
    for (const p of parts) {
      if (p.torso) {
        torso();
        ctx.lineWidth = 15;
        ctx.strokeStyle = ink;
        ctx.stroke();
      } else limb(p.pts, p.w + 7, ink);
    }
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(d.head[0], d.head[1], 24, 0, TAU);
    ctx.fill();
    ctx.restore();

    for (const p of parts) {
      if (p.torso) {
        torso();
        ctx.fillStyle = giLight;
        ctx.fill();
        ctx.lineWidth = 8;
        ctx.strokeStyle = giLight;
        ctx.stroke();
        // Lapel
        ctx.strokeStyle = gi;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(chest[0] - nx * 10, chest[1] - ny * 10);
        ctx.lineTo(lerp(d.hip[0], chest[0], 0.45), lerp(d.hip[1], chest[1], 0.45));
        ctx.lineTo(chest[0] + nx * 8, chest[1] + ny * 8);
        ctx.stroke();
      } else limb(p.pts, p.w, p.c);
    }

    // Belt with trailing tails
    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(d.hip[0] + nx * 17, d.hip[1] + ny * 17 - 4);
    ctx.lineTo(d.hip[0] - nx * 17, d.hip[1] - ny * 17 - 4);
    ctx.stroke();
    ctx.lineWidth = 4;
    const knot = [d.hip[0] + 6, d.hip[1] - 2];
    for (const [len, off] of [[28, 0.25], [22, 0.55]]) {
      const ang = Math.PI / 2 + off + f.cloth + Math.sin(this.time * 9 + off * 7 + f.i) * 0.08;
      ctx.beginPath();
      ctx.moveTo(knot[0], knot[1]);
      ctx.lineTo(knot[0] + Math.cos(ang) * len, knot[1] + Math.sin(ang) * len);
      ctx.stroke();
    }

    // Boots angled along the shin, gloves on the hands.
    ctx.fillStyle = accent;
    for (const [knee, foot] of [[d.kneeB, d.footB], [d.kneeF, d.footF]]) {
      const ang = Math.atan2(foot[1] - knee[1], foot[0] - knee[0]) - Math.PI / 2;
      ctx.beginPath();
      ctx.ellipse(foot[0] + 6, foot[1] - 4, 15, 8, ang, 0, TAU);
      ctx.fill();
    }
    for (const hand of [d.handB, d.handF]) {
      ctx.beginPath();
      ctx.arc(hand[0], hand[1], 12, 0, TAU);
      ctx.fill();
    }

    // Head + headband with tails
    const hx = d.head[0];
    const hy = d.head[1];
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(hx, hy, 20, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1b1020';
    ctx.beginPath();
    ctx.arc(hx - 2, hy - 6, 20, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.fillRect(hx - 20, hy - 8, 40, 7);
    const wave = Math.sin(this.time * 14 + f.i) * (4 + Math.abs(f.cloth) * 4);
    const lift = f.cloth * 16;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(hx - 18, hy - 5);
    ctx.quadraticCurveTo(hx - 36, hy - 4 + wave - lift * 0.5, hx - 52 - lift * 0.3, hy + 4 - wave - lift);
    ctx.moveTo(hx - 18, hy - 3);
    ctx.quadraticCurveTo(hx - 34, hy + 10 - wave - lift * 0.5, hx - 46 - lift * 0.3, hy + 20 + wave - lift);
    ctx.stroke();
    ctx.fillStyle = '#1b1020';
    if (f.ko || f.st === 'down') ctx.fillRect(hx + 8, hy - 1, 7, 2);
    else ctx.fillRect(hx + 9, hy - 2, 5, 4);

    // Charging special
    if (!reflect && f.attack?.name === 'special' && !f.attack.fired) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 30;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(d.handF[0] + 10, d.handF[1] + 4, 8 + f.attack.t * 50, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  drawProjectile(ctx, p) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 46);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, p.owner.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 46 + Math.sin(p.t * 30) * 4, 0, TAU);
    ctx.fill();
    // Flame tail
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = p.owner.color;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 26);
    ctx.quadraticCurveTo(p.x - Math.sign(p.vx) * 70, p.y + Math.sin(p.t * 40) * 8, p.x - Math.sign(p.vx) * 120, p.y);
    ctx.quadraticCurveTo(p.x - Math.sign(p.vx) * 70, p.y - Math.sin(p.t * 40) * 8, p.x, p.y + 26);
    ctx.fill();
    ctx.restore();
  }

  drawHud(ctx) {
    const [a, b] = this.fighters;
    const bar = (f, left) => {
      const x0 = left ? 60 : W / 2 + 100;
      const w = W / 2 - 160;
      const y = 36;
      const h = 30;
      const skew = 16;
      const outline = () => {
        ctx.beginPath();
        ctx.moveTo(x0 + skew, y);
        ctx.lineTo(x0 + w, y);
        ctx.lineTo(x0 + w - skew, y + h);
        ctx.lineTo(x0, y + h);
        ctx.closePath();
      };
      // Bars drain toward the outer edge, like classic fighters.
      const fill = (frac, color, yy = y, hh = h) => {
        const fw = w * clamp(frac, 0, 1);
        ctx.fillStyle = color;
        ctx.fillRect(left ? x0 + w - fw : x0, yy, fw, hh);
      };
      ctx.save();
      outline();
      ctx.clip();
      fill(1, 'rgba(10,4,12,0.8)');
      // Recent damage shows as a red chunk that drains after a beat.
      fill(f.shownHp / 100, '#ff3b5c');
      const low = f.hp <= 30;
      fill(f.hp / 100, low && Math.floor(this.time * 6) % 2 ? '#ffb020' : low ? '#ff7a3d' : f.color);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x0, y, w, h / 3);
      ctx.restore();
      outline();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Guard meter
      const gy = y + h + 5;
      ctx.fillStyle = 'rgba(10,4,12,0.8)';
      ctx.fillRect(x0 + (left ? skew : 0), gy, w - skew, 6);
      const gf = (f.guard / GUARD_MAX) * (w - skew);
      const weak = f.guard < 35;
      ctx.fillStyle = f.st === 'guardbreak' ? '#ff3b5c' : weak && Math.floor(this.time * 8) % 2 ? '#ffb020' : '#7dd3fc';
      ctx.fillRect(left ? x0 + w - gf : x0, gy, gf, 6);

      text(ctx, f.name, left ? x0 : x0 + w, y + h + 28, { size: 18, align: left ? 'left' : 'right', color: '#fff', glow: 6 });
      for (let k = 0; k < WINS_NEEDED; k++) {
        const cx = left ? x0 + w - 14 - k * 26 : x0 + 14 + k * 26;
        ctx.beginPath();
        ctx.arc(cx, y + h + 28, 8, 0, TAU);
        ctx.fillStyle = k < f.wins ? '#ffd166' : 'rgba(255,255,255,0.15)';
        ctx.fill();
      }
      // Super meter
      const my = y + h + 48;
      const mw = 240;
      const mx = left ? x0 : x0 + w - mw;
      ctx.fillStyle = 'rgba(10,4,12,0.8)';
      ctx.fillRect(mx, my, mw, 10);
      const full = f.meter >= 100;
      ctx.fillStyle = full ? (Math.floor(this.time * 8) % 2 ? '#ffd166' : '#ffffff') : '#38d9ff';
      ctx.fillRect(left ? mx : mx + mw - (mw * f.meter) / 100, my, (mw * f.meter) / 100, 10);
      text(ctx, full ? 'SUPER READY — A+B' : 'SUPER', left ? mx + mw + 10 : mx - 10, my + 5, {
        size: 12,
        font: 'Inter',
        weight: 800,
        align: left ? 'left' : 'right',
        color: full ? '#ffd166' : '#c4bdf5',
      });

      // Combo counter and callouts on the attacker's side
      const cx = left ? 70 : W - 70;
      const align = left ? 'left' : 'right';
      if (f.combo >= 2 && f.comboT > 0) {
        const alpha = clamp(f.comboT / 0.4, 0, 1);
        text(ctx, `${f.combo} HITS`, cx, 240, { size: Math.round(54 * (1 + f.comboPop * 0.3)), align, color: '#ffd166', glow: 18, alpha });
        text(ctx, `${Math.round(f.comboDmg)} damage`, cx, 284, { size: 18, font: 'Inter', weight: 800, align, color: '#fff1c2', alpha });
      }
      if (f.callout && f.callout.t > 0) {
        const c = f.callout;
        text(ctx, c.str, cx, 326, { size: 32, align, color: c.color, glow: 16, alpha: clamp(c.t / 0.3, 0, 1) });
      }
    };
    if (a) bar(a, true);
    if (b) bar(b, false);

    ctx.fillStyle = 'rgba(10,4,12,0.85)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - 50, 22, 100, 66, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,209,102,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    text(ctx, String(Math.max(0, Math.ceil(this.clock))), W / 2, 56, { size: 40, color: this.clock < 10 ? '#ff3b5c' : '#fff' });
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
  create: (opts) => new BattleClash(opts),
};
