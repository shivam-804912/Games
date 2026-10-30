// Every game draws in this logical resolution; the host scales it to the screen.
export const W = 1600;
export const H = 900;
export const TAU = Math.PI * 2;

export const PLAYER_COLORS = ['#4f8bff', '#ff3b5c', '#22d36b', '#facc15', '#b26bff', '#ff8a2b', '#22d3ee', '#ff5fc8'];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export function angleDiff(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function turnToward(angle, target, maxStep) {
  const d = angleDiff(angle, target);
  return angle + clamp(d, -maxStep, maxStep);
}

export const pointInRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// Push vector that moves a circle out of a rect, or null if they don't touch.
export function circleRect(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 === 0) {
    const left = cx - rect.x;
    const right = rect.x + rect.w - cx;
    const top = cy - rect.y;
    const bottom = rect.y + rect.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: -(left + r), y: 0 };
    if (m === right) return { x: right + r, y: 0 };
    if (m === top) return { x: 0, y: -(top + r) };
    return { x: 0, y: bottom + r };
  }
  const d = Math.sqrt(d2);
  const k = (r - d) / d;
  return { x: dx * k, y: dy * k };
}

// Resolve a circle body against a list of rects. Returns true if it hit anything.
export function collideRects(body, r, rects) {
  let hit = false;
  for (const rect of rects) {
    const push = circleRect(body.x, body.y, r, rect);
    if (push) {
      body.x += push.x;
      body.y += push.y;
      hit = true;
    }
  }
  return hit;
}

export function lineBlocked(x1, y1, x2, y2, rects, step = 12) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.ceil(len / step);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (const r of rects) if (pointInRect(x, y, r)) return true;
  }
  return false;
}

// Viewport rectangles for split-screen games.
export function splitViews(n) {
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) {
    return [
      { x: 0, y: 0, w: W / 2, h: H },
      { x: W / 2, y: 0, w: W / 2, h: H },
    ];
  }
  const q = [
    { x: 0, y: 0, w: W / 2, h: H / 2 },
    { x: W / 2, y: 0, w: W / 2, h: H / 2 },
    { x: 0, y: H / 2, w: W / 2, h: H / 2 },
    { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
  ];
  return q.slice(0, n);
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function text(ctx, str, x, y, { size = 32, color = '#fff', align = 'center', baseline = 'middle', font = 'Russo One', weight = '', glow = 0, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px "${font}", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.restore();
}

// Full-width title strip used for countdowns, round results, etc.
export function banner(ctx, title, sub, { color = '#fff', alpha = 1, y = H / 2 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(9,7,32,0)');
  g.addColorStop(0.5, 'rgba(9,7,32,0.85)');
  g.addColorStop(1, 'rgba(9,7,32,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 90, W, 180);
  ctx.restore();
  text(ctx, title, W / 2, y - (sub ? 18 : 0), { size: 84, color, glow: 30, alpha });
  if (sub) text(ctx, sub, W / 2, y + 50, { size: 26, font: 'Inter', weight: 700, color: '#d6d2f3', alpha });
}

export class Particles {
  constructor() {
    this.list = [];
  }

  burst(x, y, { count = 12, color = '#fff', speed = 220, life = 0.6, size = 3, angle = 0, spread = TAU, drag = 3, gravity = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.list.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.4),
        max: life,
        size: size * (0.6 + Math.random() * 0.8),
        color,
        drag,
        gravity,
      });
    }
  }

  update(dt) {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  render(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.list) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Zero input for idle or disconnected players.
export const IDLE = Object.freeze({ x: 0, y: 0, a: false, b: false, aPressed: false, bPressed: false });
