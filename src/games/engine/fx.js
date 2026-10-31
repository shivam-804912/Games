import { TAU, makeCanvas } from './util.js';

/*
 * Shared rendering helpers for the "modern" look: cached glow sprites,
 * a low-res light map for dynamic lighting, soft shadows and sleek HUD panels.
 * Everything here is plain 2D canvas; the WebGL post pass (postfx.js) adds
 * bloom and grading on top, so bright additive glows here will bloom.
 */

export const HUD_FONT = 'Rajdhani';

/* --------------------------------------------------------------- Colour */

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex, a = 1) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// Mix a colour toward white (t > 0) or black (t < 0).
export function shade(hex, t) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/* ---------------------------------------------------------------- Glows */

const glowCache = new Map();

// A soft radial sprite (white core fading through `color`), cached per colour.
export function glowSprite(color, size = 128, core = 0.15) {
  const key = `${color}|${size}|${core}`;
  let c = glowCache.get(key);
  if (c) return c;
  c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(core, rgba(color, 0.9));
  grad.addColorStop(0.45, rgba(color, 0.28));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowCache.set(key, c);
  return c;
}

// Additive glow centred on (x, y) with the given radius.
export function drawGlow(ctx, x, y, radius, color, alpha = 1, core = 0.15) {
  if (alpha <= 0 || radius <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha *= alpha;
  ctx.drawImage(glowSprite(color, 128, core), x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

/* ------------------------------------------------------------- Lighting */

/*
 * Light map: fill with an ambient colour, add lights, then multiply over the
 * scene. Rendered at reduced resolution so it is cheap and naturally soft.
 *
 *   lights.begin(viewW, viewH, '#202438');   // lights.ctx is now in view-local units
 *   lights.ctx.translate(...camera...);      // optional: match your camera
 *   lights.light(x, y, 260, '#ffcc88', 1);
 *   lights.cone(x, y, angle, 0.6, 500, '#ffffff', 0.9);
 *   lights.apply(ctx, viewX, viewY, viewW, viewH);
 */
export class LightMap {
  constructor(scale = 0.4) {
    this.scale = scale;
    this.canvas = makeCanvas(4, 4);
    this.ctx = this.canvas.getContext('2d');
  }

  begin(w, h, ambient) {
    const cw = Math.max(4, Math.ceil(w * this.scale));
    const ch = Math.max(4, Math.ceil(h * this.scale));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = ambient;
    g.fillRect(0, 0, cw, ch);
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    g.globalCompositeOperation = 'lighter';
    this.w = w;
    this.h = h;
    return g;
  }

  light(x, y, radius, color, intensity = 1) {
    const g = this.ctx;
    g.globalAlpha = Math.min(1, intensity);
    g.drawImage(glowSprite(color, 128, 0.02), x - radius, y - radius, radius * 2, radius * 2);
    g.globalAlpha = 1;
  }

  // Spot light / headlight: a wedge of light fading with distance.
  cone(x, y, angle, spread, length, color, intensity = 1) {
    const g = this.ctx;
    g.save();
    g.globalAlpha = Math.min(1, intensity);
    const grad = g.createRadialGradient(x, y, 0, x, y, length);
    grad.addColorStop(0, rgba(color, 0.95));
    grad.addColorStop(0.5, rgba(color, 0.4));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, length, angle - spread / 2, angle + spread / 2);
    g.closePath();
    g.fill();
    g.restore();
  }

  apply(ctx, x = 0, y = 0, w = this.w, h = this.h) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, 0, 0, this.canvas.width, this.canvas.height, x, y, w, h);
    ctx.restore();
  }
}

/* -------------------------------------------------------------- Shadows */

// Run `draw` with a soft drop shadow (blur in logical px).
export function withShadow(ctx, draw, { blur = 18, x = 0, y = 8, color = 'rgba(0,0,0,0.5)' } = {}) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = x;
  ctx.shadowOffsetY = y;
  draw(ctx);
  ctx.restore();
}

// Soft elliptical contact shadow under an object.
export function contactShadow(ctx, x, y, rx, ry, alpha = 0.45) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.6, `rgba(0,0,0,${alpha * 0.45})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ HUD */

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/*
 * Frosted "glass" HUD panel in the style of current console games:
 * dark translucent body, faint top highlight, hairline border and an
 * optional accent bar on one edge.
 */
export function glassPanel(ctx, x, y, w, h, { r = 10, alpha = 0.62, accent = null, accentSide = 'left', border = 0.14 } = {}) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `rgba(22,24,38,${alpha})`);
  g.addColorStop(1, `rgba(8,9,18,${alpha + 0.12})`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.clip();
  const hl = ctx.createLinearGradient(0, y, 0, y + Math.min(h, 40));
  hl.addColorStop(0, 'rgba(255,255,255,0.09)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(x, y, w, Math.min(h, 40));
  if (accent) {
    ctx.fillStyle = accent;
    if (accentSide === 'left') ctx.fillRect(x, y, 3, h);
    else if (accentSide === 'right') ctx.fillRect(x + w - 3, y, 3, h);
    else if (accentSide === 'top') ctx.fillRect(x, y, w, 3);
    else ctx.fillRect(x, y + h - 3, w, 3);
  }
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = `rgba(255,255,255,${border})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/*
 * Segmented bar (health, boost, ammo…). `value` 0..1, optional `ghost`
 * shows recent damage as a lighter trailing segment.
 */
export function meter(ctx, x, y, w, h, value, color, { ghost = null, segments = 0, skew = 0, back = 'rgba(255,255,255,0.08)', glow = true } = {}) {
  const v = Math.max(0, Math.min(1, value));
  ctx.save();
  if (skew) ctx.transform(1, 0, skew, 1, -skew * y, 0);
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);
  if (ghost !== null && ghost > v) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x + w * v, y, w * (Math.min(1, ghost) - v), h);
  }
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, shade(color, 0.35));
  g.addColorStop(0.5, color);
  g.addColorStop(1, shade(color, -0.25));
  ctx.fillStyle = g;
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
  }
  ctx.fillRect(x, y, w * v, h);
  ctx.shadowBlur = 0;
  if (segments > 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 1; i < segments; i++) ctx.fillRect(x + (w * i) / segments - 1, y, 2, h);
  }
  ctx.restore();
}
