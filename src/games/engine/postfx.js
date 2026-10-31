/*
 * Post-processing pass that turns the flat 2D canvas frame into a modern,
 * "rendered" image: HDR-style bloom, filmic shoulder, colour grading with
 * split toning, chromatic aberration, vignette and film grain.
 *
 * Games keep drawing with the 2D canvas API into an offscreen scene canvas;
 * this module uploads that frame to WebGL every frame and composites it.
 * Tuning comes from the game definition (`def.post`) and can be nudged per
 * frame by the running game (`game.post`, e.g. a red flash when hit).
 */

export const POST_DEFAULTS = Object.freeze({
  bloom: 0.55, // bloom strength
  threshold: 0.6, // luma where bloom starts
  knee: 0.25, // softness of the threshold
  exposure: 1,
  contrast: 1.06,
  saturation: 1.1,
  shoulder: 0.78, // highlights above this roll off instead of clipping
  vignette: 0.32,
  aberration: 0.0012, // lens fringing at the screen edges (fraction of width)
  grain: 0.03,
  shadows: [0.0, 0.03, 0.06], // split toning: added to dark tones…
  highlights: [0.05, 0.02, -0.02], // …and to bright tones
  flash: 0, // 0..1 full-screen flash (hits, explosions)
  flashColor: [1, 1, 1],
  desaturate: 0, // 0..1 (e.g. when a player is knocked out)
});

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Downsample with a 4-tap box filter and keep only what is above the threshold.
const BRIGHT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
uniform float uFlipY;
vec3 tap(vec2 uv) {
  uv.y = mix(uv.y, 1.0 - uv.y, uFlipY);
  return texture2D(uTex, uv).rgb;
}
void main() {
  vec3 c = (tap(vUv + uTexel * vec2(-1.0, -1.0)) + tap(vUv + uTexel * vec2(1.0, -1.0)) +
            tap(vUv + uTexel * vec2(-1.0, 1.0)) + tap(vUv + uTexel * vec2(1.0, 1.0))) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb +
           texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

// 9-tap gaussian using linear sampling (5 fetches).
const BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.2270270270;
  c += texture2D(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene, uB1, uB2, uB3;
uniform float uBloom, uExposure, uContrast, uSat, uShoulder, uVig, uCA, uGrain, uTime, uFlash, uDesat;
uniform vec3 uShadows, uHighlights, uFlashColor;
uniform vec2 uAspect;

float shoulder(float x) {
  float k = uShoulder;
  if (x <= k) return x;
  float r = 1.0 - k;
  float t = (x - k) / r;
  return k + r * t / (1.0 + t);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 d = uv - 0.5;
  float r2 = dot(d * uAspect, d * uAspect);

  // Chromatic aberration grows toward the edges.
  vec2 off = d * uCA * (0.4 + r2 * 2.5);
  vec3 col;
  col.r = texture2D(uScene, uv + off).r;
  col.g = texture2D(uScene, uv).g;
  col.b = texture2D(uScene, uv - off).b;

  vec3 bloom = texture2D(uB1, vUv).rgb * 0.55 + texture2D(uB2, vUv).rgb * 0.75 + texture2D(uB3, vUv).rgb * 1.0;
  col += bloom * uBloom;

  col *= uExposure;
  col = vec3(shoulder(col.r), shoulder(col.g), shoulder(col.b));

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat * (1.0 - uDesat));
  col = (col - 0.5) * uContrast + 0.5;

  // Split toning: cool shadows, warm highlights (or whatever the game asks for).
  float hw = smoothstep(0.25, 0.9, l);
  col += uShadows * (1.0 - hw) * (1.0 - l) + uHighlights * hw;

  col += uFlashColor * uFlash;

  float vig = smoothstep(0.15, 0.95, r2 * 1.6);
  col *= 1.0 - vig * uVig;

  float g = hash(uv * 1000.0 + fract(uTime) * 61.0) - 0.5;
  col += g * uGrain * (1.0 - l * 0.5);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, vs, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function target(gl, w, h) {
  const tex = texture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}

// Returns null when WebGL is unavailable; the host then falls back to plain 2D.
export function createPostFX(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;

  let progs;
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    progs = {
      bright: program(gl, vs, BRIGHT),
      down: program(gl, vs, DOWN),
      blur: program(gl, vs, BLUR),
      comp: program(gl, vs, COMPOSITE),
    };
  } catch (err) {
    console.warn('PostFX disabled:', err);
    return null;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const scene = texture(gl);
  let levels = null;
  let size = '';

  const ensure = (w, h) => {
    const key = `${w}x${h}`;
    if (key === size) return;
    size = key;
    if (levels) {
      for (const l of levels) {
        for (const t of [l.a, l.b]) {
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fb);
        }
      }
    }
    levels = [4, 8, 16].map((div) => {
      const lw = Math.max(2, Math.round(w / div));
      const lh = Math.max(2, Math.round(h / div));
      return { a: target(gl, lw, lh), b: target(gl, lw, lh) };
    });
  };

  const draw = (fb, w, h) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const bindTex = (unit, tex) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  };

  const blur = (l) => {
    const { blur: b } = progs;
    gl.useProgram(b.p);
    gl.uniform1i(b.u.uTex, 0);
    bindTex(0, l.a.tex);
    gl.uniform2f(b.u.uDir, 1 / l.a.w, 0);
    draw(l.b.fb, l.b.w, l.b.h);
    bindTex(0, l.b.tex);
    gl.uniform2f(b.u.uDir, 0, 1 / l.a.h);
    draw(l.a.fb, l.a.w, l.a.h);
  };

  return {
    /*
     * src: canvas holding the finished 2D frame.
     * view: where the frame goes on the output canvas, in device pixels.
     */
    render(src, view, params, time) {
      const p = params;
      ensure(src.width, src.height);

      bindTex(0, scene);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

      // Bright pass straight to 1/4 res (the 4 taps sit on the 1/2 res texel grid).
      const { bright, down, comp } = progs;
      gl.useProgram(bright.p);
      gl.uniform1i(bright.u.uTex, 0);
      gl.uniform2f(bright.u.uTexel, 1.5 / src.width, 1.5 / src.height);
      gl.uniform1f(bright.u.uThreshold, p.threshold);
      gl.uniform1f(bright.u.uKnee, p.knee);
      gl.uniform1f(bright.u.uFlipY, 1);
      draw(levels[0].a.fb, levels[0].a.w, levels[0].a.h);
      blur(levels[0]);

      for (let i = 1; i < levels.length; i++) {
        const prev = levels[i - 1].a;
        gl.useProgram(down.p);
        gl.uniform1i(down.u.uTex, 0);
        bindTex(0, prev.tex);
        gl.uniform2f(down.u.uTexel, 0.75 / prev.w, 0.75 / prev.h);
        draw(levels[i].a.fb, levels[i].a.w, levels[i].a.h);
        blur(levels[i]);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.02, 0.016, 0.05, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(view.x, canvas.height - view.y - view.h, view.w, view.h);

      gl.useProgram(comp.p);
      bindTex(0, scene);
      bindTex(1, levels[0].a.tex);
      bindTex(2, levels[1].a.tex);
      bindTex(3, levels[2].a.tex);
      const u = comp.u;
      gl.uniform1i(u.uScene, 0);
      gl.uniform1i(u.uB1, 1);
      gl.uniform1i(u.uB2, 2);
      gl.uniform1i(u.uB3, 3);
      gl.uniform1f(u.uBloom, p.bloom);
      gl.uniform1f(u.uExposure, p.exposure);
      gl.uniform1f(u.uContrast, p.contrast);
      gl.uniform1f(u.uSat, p.saturation);
      gl.uniform1f(u.uShoulder, p.shoulder);
      gl.uniform1f(u.uVig, p.vignette);
      gl.uniform1f(u.uCA, p.aberration);
      gl.uniform1f(u.uGrain, p.grain);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uFlash, p.flash);
      gl.uniform1f(u.uDesat, p.desaturate);
      gl.uniform3fv(u.uShadows, p.shadows);
      gl.uniform3fv(u.uHighlights, p.highlights);
      gl.uniform3fv(u.uFlashColor, p.flashColor);
      gl.uniform2f(u.uAspect, view.w / view.h, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      bindTex(0, null);
    },

    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
