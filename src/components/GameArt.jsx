import { memo, useId } from 'react';
import { mulberry32, shade, svgId } from '../utils/random.js';

/*
 * Procedurally drawn SVG key art for each game, so the page ships with
 * no image assets. Every scene is laid out relative to the viewBox
 * (W × H), so the same scene works as a wide banner or a portrait tile.
 */

const WINDOW_COLORS = ['#ffd166', '#ff7ad9', '#67e8f9'];

function GlowFilter({ id, blur = 2 }) {
  return (
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation={blur} result="b" />
      <feMerge>
        <feMergeNode in="b" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}

// Coloured outline glow for silhouettes.
function RimFilter({ id, color, radius = 1.3 }) {
  return (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feMorphology in="SourceAlpha" operator="dilate" radius={radius} result="d" />
      <feFlood floodColor={color} />
      <feComposite in2="d" operator="in" result="o" />
      <feGaussianBlur in="o" stdDeviation={radius} result="ob" />
      <feMerge>
        <feMergeNode in="ob" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}

function BlurFilter({ id, blur }) {
  return (
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation={blur} />
    </filter>
  );
}

/* ---------------------------------------------------------------- City */

function sportsCar(x, y, scale, fill, glow) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="62" cy="34" rx="68" ry="5" fill="#000" opacity=".6" />
      <path d="M124 17 L230 4 L230 36 L124 22Z" fill="#fff6c2" opacity=".08" />
      <path
        d="M0 26 Q0 18 8 16 L30 12 Q42 2 58 1 L80 1 Q92 2 104 12 L116 15 Q124 17 124 24 L124 28 L0 28 Z"
        fill={fill}
      />
      <path d="M34 12 Q44 4.5 57 4 L64 4 L64 12 Z M68 4 L79 4 Q90 5 99 12 L68 12 Z" fill="#1a1440" />
      <path d="M8 18 L116 17" stroke="#fff" strokeOpacity=".35" strokeWidth="1" />
      <circle cx="26" cy="27" r="8.5" fill="#07060f" />
      <circle cx="26" cy="27" r="3.5" fill="#9aa0b8" />
      <circle cx="100" cy="27" r="8.5" fill="#07060f" />
      <circle cx="100" cy="27" r="3.5" fill="#9aa0b8" />
      <rect x="0" y="17" width="5" height="3.5" rx="1" fill="#ff2a4a" filter={`url(#${glow})`} />
      <rect x="119" y="17" width="5" height="3" rx="1" fill="#fff6c2" filter={`url(#${glow})`} />
    </g>
  );
}

function hoodedFigure(x, y, scale, rim) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} filter={`url(#${rim})`}>
      <path d="M-62 0 Q-60 -64 -26 -82 L26 -82 Q60 -64 62 0Z" fill="#0b0618" />
      <path d="M-27 -80 Q-34 -132 0 -138 Q34 -132 27 -80Z" fill="#0b0618" />
      <path d="M0 -62 L9 -50 L0 -38 L-9 -50Z" fill="#e11d48" opacity=".9" />
    </g>
  );
}

function cityScene({ W, H, id, seed, figure = false }) {
  const rand = mulberry32(seed);
  const s = H / 250;
  const hz = H * 0.76;
  const sun = { x: W * (figure ? 0.6 : 0.66), y: hz - H * 0.24, r: H * 0.22 };

  const far = [];
  for (let x = -8; x < W; ) {
    const w = (14 + rand() * 24) * s;
    const h = H * (0.16 + rand() * 0.34);
    far.push(<rect key={x} x={x} y={hz - h} width={w} height={h} />);
    x += w + s;
  }

  const near = [];
  const neon = [];
  const windows = [];
  for (let x = -10; x < W; ) {
    const w = (22 + rand() * 34) * s;
    const tall = rand() > 0.72;
    const h = H * (tall ? 0.4 + rand() * 0.28 : 0.1 + rand() * 0.24);
    const top = hz - h;
    near.push(<rect key={x} x={x} y={top} width={w} height={h + 1} />);
    if (tall) {
      near.push(<rect key={`${x}a`} x={x + w / 2 - s} y={top - 14 * s} width={2 * s} height={14 * s} />);
      neon.push(
        <rect
          key={x}
          x={x + 3 * s}
          y={top + 10 * s}
          width={2.5 * s}
          height={h * 0.32}
          fill={rand() > 0.5 ? '#ff3fa4' : '#38d9ff'}
        />,
      );
    }
    for (let wy = top + 6 * s; wy < hz - 6 * s; wy += 7 * s) {
      for (let wx = x + 4 * s; wx < x + w - 5 * s; wx += 6 * s) {
        if (rand() > 0.66) {
          windows.push(
            <rect
              key={windows.length}
              x={wx}
              y={wy}
              width={2.6 * s}
              height={3.4 * s}
              fill={WINDOW_COLORS[Math.floor(rand() * 3)]}
              opacity={0.4 + rand() * 0.6}
            />,
          );
        }
      }
    }
    x += w + 2 * s;
  }

  const grid = [];
  for (let i = -14; i <= 14; i++) {
    grid.push(<line key={`v${i}`} x1={W / 2 + i * 10 * s} y1={hz} x2={W / 2 + i * 60 * s} y2={H} />);
  }
  for (let j = 1; j <= 6; j++) {
    const y = hz + (H - hz) * Math.pow(j / 6, 1.8);
    grid.push(<line key={`h${j}`} x1="0" y1={y} x2={W} y2={y} />);
  }

  const carScale = 0.95 * s;
  const carX = figure ? W * 0.48 : W / 2 - 62 * carScale;

  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d0726" />
          <stop offset=".45" stopColor="#3b1782" />
          <stop offset=".75" stopColor="#b5179e" />
          <stop offset="1" stopColor="#ff6b3d" />
        </linearGradient>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe066" />
          <stop offset="1" stopColor="#ff2e88" />
        </linearGradient>
        <mask id={`${id}-sunmask`}>
          <rect width={W} height={H} fill="#fff" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect
              key={i}
              x="0"
              y={sun.y + sun.r * (0.15 + i * 0.16)}
              width={W}
              height={sun.r * (0.03 + i * 0.022)}
              fill="#000"
            />
          ))}
        </mask>
        <linearGradient id={`${id}-car`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff4d7d" />
          <stop offset="1" stopColor="#8a1040" />
        </linearGradient>
        <GlowFilter id={`${id}-glow`} blur={2 * s} />
        <RimFilter id={`${id}-rim`} color="#ff4fb0" radius={1.4 * s} />
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <circle cx={sun.x} cy={sun.y} r={sun.r} fill={`url(#${id}-sun)`} mask={`url(#${id}-sunmask)`} />
      <g fill="#3a1a7a" opacity=".6">{far}</g>
      <g fill="#140a30">{near}</g>
      <g filter={`url(#${id}-glow)`} opacity=".9">{neon}</g>
      <g>{windows}</g>
      <rect y={hz} width={W} height={H - hz} fill="#0b0620" />
      <g stroke="#ff3fa4" strokeWidth={0.8 * s} opacity=".45">{grid}</g>
      <line x1="0" y1={hz} x2={W} y2={hz} stroke="#ff6bd0" strokeWidth={1.5 * s} filter={`url(#${id}-glow)`} />
      {sportsCar(carX, H - 40 * carScale, carScale, `url(#${id}-car)`, `${id}-glow`)}
      {figure && hoodedFigure(W * 0.83, H + 4, s * 1.4, `${id}-rim`)}
    </>
  );
}

/* --------------------------------------------------------------- Space */

function spaceScene({ W, H, id, seed }) {
  const rand = mulberry32(seed);
  const s = H / 250;
  const stars = [];
  const count = Math.round((W * H) / 900);
  for (let i = 0; i < count; i++) {
    stars.push(
      <circle key={i} cx={rand() * W} cy={rand() * H} r={(0.3 + rand() * 1.1) * s} opacity={0.25 + rand() * 0.75} />,
    );
  }
  const p = { x: W * 0.78, y: H * 0.3, r: H * 0.24 };
  const ring = { rx: p.r * 1.75, ry: p.r * 0.34 };

  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="40%" cy="45%" r="75%">
          <stop offset="0" stopColor="#24124f" />
          <stop offset=".55" stopColor="#0d0a2b" />
          <stop offset="1" stopColor="#04030d" />
        </radialGradient>
        <radialGradient id={`${id}-planet`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset=".45" stopColor="#3b5bdb" />
          <stop offset="1" stopColor="#0b1440" />
        </radialGradient>
        <radialGradient id={`${id}-moon`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#fdba74" />
          <stop offset=".5" stopColor="#c2410c" />
          <stop offset="1" stopColor="#431407" />
        </radialGradient>
        <linearGradient id={`${id}-flame`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#fff7d6" />
          <stop offset=".3" stopColor="#ff9f43" />
          <stop offset="1" stopColor="#ff3d71" stopOpacity="0" />
        </linearGradient>
        <BlurFilter id={`${id}-blur`} blur={18 * s} />
        <GlowFilter id={`${id}-glow`} blur={2.5} />
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-bg)`} />
      <g filter={`url(#${id}-blur)`} opacity=".75">
        <ellipse cx={W * 0.28} cy={H * 0.38} rx={W * 0.26} ry={H * 0.22} fill="#6d28d9" />
        <ellipse cx={W * 0.6} cy={H * 0.78} rx={W * 0.24} ry={H * 0.16} fill="#be185d" opacity=".55" />
        <ellipse cx={W * 0.9} cy={H * 0.62} rx={W * 0.16} ry={H * 0.22} fill="#1d4ed8" opacity=".6" />
      </g>
      <g fill="#fff">{stars}</g>
      <circle cx={W * 0.12} cy={H * 0.2} r={H * 0.055} fill={`url(#${id}-moon)`} />
      <g transform={`rotate(-16 ${p.x} ${p.y})`} fill="none" strokeWidth={4 * s}>
        <ellipse cx={p.x} cy={p.y} rx={ring.rx} ry={ring.ry} stroke="#a5b4fc" strokeOpacity=".5" />
        <circle cx={p.x} cy={p.y} r={p.r} fill={`url(#${id}-planet)`} />
        <path
          d={`M${p.x - ring.rx} ${p.y} A${ring.rx} ${ring.ry} 0 0 0 ${p.x + ring.rx} ${p.y}`}
          stroke="#c7d2fe"
          strokeOpacity=".8"
        />
      </g>
      <g transform={`translate(${W * 0.42} ${H * 0.62}) rotate(-22) scale(${1.15 * s})`}>
        <g stroke="#fff" strokeOpacity=".22" strokeWidth="1.2">
          <line x1="-60" y1="-22" x2="-150" y2="-22" />
          <line x1="-70" y1="16" x2="-170" y2="16" />
          <line x1="-56" y1="28" x2="-120" y2="28" />
        </g>
        <path d="M-36 -6 L-96 0 L-36 6Z" fill={`url(#${id}-flame)`} filter={`url(#${id}-glow)`} />
        <path d="M-8 -9 L-36 -40 L-48 -40 L-32 -8Z" fill="#8a93b8" />
        <path d="M-8 9 L-36 40 L-48 40 L-32 8Z" fill="#646d92" />
        <path d="M64 0 Q42 -13 6 -12 L-36 -8 L-36 8 L6 12 Q42 13 64 0Z" fill="#eef1fb" />
        <path d="M-30 3 L50 3 Q40 9 6 10 L-30 7Z" fill="#b8c0dc" />
        <path d="M10 -1 L52 -1" stroke="#ff3d71" strokeWidth="2" />
        <ellipse cx="26" cy="-3.5" rx="13" ry="4.5" fill="#38bdf8" />
        <rect x="-40" y="-7" width="6" height="14" rx="2" fill="#2b2f45" />
        <circle cx="-44" cy="-40" r="2.2" fill="#38d9ff" filter={`url(#${id}-glow)`} />
        <circle cx="-44" cy="40" r="2.2" fill="#ff3fa4" filter={`url(#${id}-glow)`} />
      </g>
    </>
  );
}

/* -------------------------------------------------------------- Racing */

function rearCar(x, y, scale, color, glow) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="2" rx="50" ry="6" fill="#000" opacity=".5" />
      <rect x="-42" y="-12" width="14" height="14" rx="3" fill="#07060f" />
      <rect x="28" y="-12" width="14" height="14" rx="3" fill="#07060f" />
      <path d="M-30 -32 L-22 -47 Q-20 -50 -15 -50 L15 -50 Q20 -50 22 -47 L30 -32Z" fill={shade(color, -0.45)} />
      <path d="M-24 -33 L-18 -45 L18 -45 L24 -33Z" fill="#141b33" />
      <path
        d="M-46 -8 L-44 -26 Q-42 -33 -32 -33 L32 -33 Q42 -33 44 -26 L46 -8 Q46 -3 41 -3 L-41 -3 Q-46 -3 -46 -8Z"
        fill={color}
      />
      <path d="M-44 -26 L44 -26" stroke="#fff" strokeOpacity=".3" strokeWidth="1.5" />
      <rect x="-41" y="-23" width="20" height="6" rx="2" fill="#ff2a4a" filter={`url(#${glow})`} />
      <rect x="21" y="-23" width="20" height="6" rx="2" fill="#ff2a4a" filter={`url(#${glow})`} />
      <rect x="-11" y="-16" width="22" height="7" rx="1.5" fill="#e8eaf2" />
      <rect x="-46" y="-9" width="92" height="4" fill="#000" opacity=".3" />
    </g>
  );
}

function palm(key, x, y, h, dir) {
  const tx = x + dir * h * 0.14;
  const ty = y - h;
  const fronds = [195, 220, 250, 290, 320, 345].map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const len = h * (0.42 + (i % 2) * 0.1);
    const ex = tx + Math.cos(a) * len;
    const ey = ty + Math.sin(a) * len + len * 0.45;
    const cx = tx + Math.cos(a) * len * 0.55;
    const cy = ty + Math.sin(a) * len * 0.55 - len * 0.2;
    return <path key={i} d={`M${tx} ${ty} Q${cx} ${cy} ${ex} ${ey}`} strokeWidth={h * 0.035} />;
  });
  return (
    <g key={key} fill="none" stroke="#0c0618" strokeLinecap="round">
      <path d={`M${x} ${y} Q${x + dir * h * 0.02} ${y - h * 0.55} ${tx} ${ty}`} strokeWidth={h * 0.05} />
      {fronds}
    </g>
  );
}

function racingScene({ W, H, id, seed, palette = ['#2f6bff', '#ff3b5c'] }) {
  const rand = mulberry32(seed);
  const s = H / 250;
  const hz = H * 0.44;
  const vp = W / 2;

  const skyline = [];
  for (let x = 0; x < W; ) {
    const w = (8 + rand() * 18) * s;
    const h = (4 + rand() * 26) * s;
    skyline.push(<rect key={x} x={x} y={hz - h} width={w} height={h + 1} />);
    x += w + 1;
  }

  const dashes = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const a = Math.pow(i / N, 1.7);
    const b = Math.pow((i + 0.45) / N, 1.7);
    const ya = hz + (H - hz) * a;
    const yb = hz + (H - hz) * b;
    const wa = (1 + 7 * a) * s;
    const wb = (1 + 7 * b) * s;
    dashes.push(
      <polygon key={i} points={`${vp - wa / 2},${ya} ${vp + wa / 2},${ya} ${vp + wb / 2},${yb} ${vp - wb / 2},${yb}`} />,
    );
  }

  const top = 6 * s;
  const roadL = -W * 0.08;
  const roadR = W * 1.08;

  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#120a35" />
          <stop offset=".5" stopColor="#4c1d95" />
          <stop offset=".85" stopColor="#db2777" />
          <stop offset="1" stopColor="#fb923c" />
        </linearGradient>
        <linearGradient id={`${id}-road`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1330" />
          <stop offset="1" stopColor="#2c2244" />
        </linearGradient>
        <radialGradient id={`${id}-sun`}>
          <stop offset="0" stopColor="#ffd166" stopOpacity=".9" />
          <stop offset="1" stopColor="#ff3fa4" stopOpacity="0" />
        </radialGradient>
        <GlowFilter id={`${id}-glow`} blur={2 * s} />
      </defs>
      <rect width={W} height={hz + 1} fill={`url(#${id}-sky)`} />
      <ellipse cx={vp} cy={hz} rx={W * 0.35} ry={H * 0.16} fill={`url(#${id}-sun)`} />
      <g fill="#2a1052">{skyline}</g>
      <rect y={hz} width={W} height={H - hz} fill="#0e0820" />
      <polygon points={`${vp - top},${hz} ${vp + top},${hz} ${roadR},${H} ${roadL},${H}`} fill={`url(#${id}-road)`} />
      <g filter={`url(#${id}-glow)`} strokeWidth={2 * s}>
        <line x1={vp - top} y1={hz} x2={roadL} y2={H} stroke="#38d9ff" />
        <line x1={vp + top} y1={hz} x2={roadR} y2={H} stroke="#ff3fa4" />
      </g>
      <g fill="#ffe8a3" opacity=".85">{dashes}</g>
      {palm('p1', W * 0.06, hz + 34 * s, 120 * s, 1)}
      {palm('p2', W * 0.95, hz + 28 * s, 112 * s, -1)}
      {palm('p3', W * 0.2, hz + 8 * s, 56 * s, 1)}
      {palm('p4', W * 0.8, hz + 6 * s, 50 * s, -1)}
      {rearCar(vp + 30 * s, hz + (H - hz) * 0.42, 0.5 * s, palette[1], `${id}-glow`)}
      {rearCar(vp - 26 * s, H - 14 * s, 1.05 * s, palette[0], `${id}-glow`)}
    </>
  );
}

/* ------------------------------------------------------------ Fighting */

function fighter(x, y, scale, flip, fill) {
  const limb = { stroke: fill, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <polyline points="-22,0 -16,-40 -6,-72" strokeWidth="16" {...limb} />
      <polyline points="28,0 22,-38 8,-72" strokeWidth="16" {...limb} />
      <path d="M-18 -70 L18 -70 L26 -118 Q2 -128 -24 -118Z" fill={fill} />
      <circle cx="4" cy="-138" r="14" fill={fill} />
      <polyline points="-16,-114 -2,-94 18,-108" strokeWidth="11" {...limb} />
      <circle cx="20" cy="-109" r="8" fill={fill} />
      <polyline points="20,-116 46,-114 70,-116" strokeWidth="11" {...limb} />
      <circle cx="76" cy="-116" r="9.5" fill={fill} />
    </g>
  );
}

function fightScene({ W, H, id, seed }) {
  const rand = mulberry32(seed);
  const s = H / 250;
  const cx = W / 2;
  const base = H - 8 * s;
  const hitY = base - 116 * s;
  const R = Math.max(W, H) * 1.5;

  const rays = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rand() * 0.2;
    const b = a + 0.08;
    rays.push(
      <polygon
        key={i}
        points={`${cx},${hitY} ${cx + Math.cos(a) * R},${hitY + Math.sin(a) * R} ${cx + Math.cos(b) * R},${hitY + Math.sin(b) * R}`}
      />,
    );
  }

  const sparks = [];
  for (let i = 0; i < 36; i++) {
    const a = rand() * Math.PI * 2;
    const d = (20 + rand() * 120) * s;
    sparks.push(
      <circle
        key={i}
        cx={cx + Math.cos(a) * d * 1.4}
        cy={hitY + Math.sin(a) * d * 0.7}
        r={(0.6 + rand() * 1.8) * s}
        fill={rand() > 0.5 ? '#ffd166' : '#ff7a3d'}
        opacity={0.5 + rand() * 0.5}
      />,
    );
  }

  const burst = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r = (i % 2 ? 9 : 26) * s;
    burst.push(`${cx + Math.cos(a) * r},${hitY + Math.sin(a) * r}`);
  }

  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx="50%" cy="50%" r="70%">
          <stop offset="0" stopColor="#ff5a36" />
          <stop offset=".3" stopColor="#c81d25" />
          <stop offset=".65" stopColor="#4a0909" />
          <stop offset="1" stopColor="#140303" />
        </radialGradient>
        <radialGradient id={`${id}-floor`}>
          <stop offset="0" stopColor="#ff6a3d" stopOpacity=".6" />
          <stop offset="1" stopColor="#ff6a3d" stopOpacity="0" />
        </radialGradient>
        <GlowFilter id={`${id}-glow`} blur={3 * s} />
        <RimFilter id={`${id}-rim`} color="#ffb347" radius={1.3 * s} />
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-bg)`} />
      <g fill="#ffb27a" opacity=".1">{rays}</g>
      <ellipse cx={cx} cy={base} rx={W * 0.45} ry={18 * s} fill={`url(#${id}-floor)`} />
      <g filter={`url(#${id}-rim)`}>
        {fighter(cx - 82 * s, base, s, false, '#1a0505')}
        {fighter(cx + 82 * s, base, s, true, '#1a0505')}
      </g>
      <polygon points={burst.join(' ')} fill="#fff4c2" filter={`url(#${id}-glow)`} />
      {sparks}
    </>
  );
}

/* ------------------------------------------------------------- Shooter */

function soldier(x, y, scale, flip, fill, visor) {
  const arm = { stroke: fill, strokeWidth: 12, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <path d="M-40 0 L-36 -58 Q-32 -80 -14 -84 L14 -84 Q32 -80 36 -58 L40 0Z" fill={fill} />
      <rect x="-9" y="-92" width="18" height="12" fill={fill} />
      <circle cx="0" cy="-104" r="16" fill={fill} />
      <path d="M-21 -102 Q-22 -128 0 -129 Q22 -128 21 -102 L26 -100 L-26 -100Z" fill={fill} />
      <rect x="-13" y="-105" width="26" height="4" rx="2" fill={visor} opacity=".9" />
      <rect x="-26" y="-30" width="14" height="16" rx="2" fill="#000" opacity=".35" />
      <rect x="12" y="-30" width="14" height="16" rx="2" fill="#000" opacity=".35" />
      <g transform="rotate(-14 0 -42)" fill={fill}>
        <rect x="-58" y="-46" width="122" height="9" rx="2" />
        <rect x="-4" y="-38" width="9" height="18" rx="1.5" />
        <rect x="-64" y="-49" width="16" height="14" rx="2" />
      </g>
      <polyline points="-32,-74 -38,-52 -23,-37" {...arm} />
      <polyline points="32,-74 36,-58 29,-50" {...arm} />
    </g>
  );
}

function shooterScene({ W, H, id, seed }) {
  const rand = mulberry32(seed);
  const s = H / 250;
  const hz = H * 0.62;

  const ruins = [`0,${H}`, `0,${hz}`];
  for (let x = 0; x < W; ) {
    const w = (20 + rand() * 34) * s;
    const h = H * (0.06 + rand() * 0.2);
    ruins.push(
      `${x},${hz - h}`,
      `${x + w * 0.35},${hz - h - rand() * 10 * s}`,
      `${x + w * 0.6},${hz - h + rand() * 14 * s}`,
      `${x + w},${hz - h * 0.5}`,
    );
    x += w;
  }
  ruins.push(`${W},${hz}`, `${W},${H}`);

  const embers = [];
  for (let i = 0; i < 40; i++) {
    embers.push(
      <circle
        key={i}
        cx={rand() * W}
        cy={rand() * H * 0.9}
        r={(0.5 + rand() * 1.4) * s}
        fill={rand() > 0.4 ? '#ffb347' : '#ff6a2b'}
        opacity={0.4 + rand() * 0.6}
      />,
    );
  }

  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#160d08" />
          <stop offset=".35" stopColor="#4a1c0b" />
          <stop offset=".68" stopColor="#b4410f" />
          <stop offset=".9" stopColor="#f59e0b" />
        </linearGradient>
        <BlurFilter id={`${id}-blur`} blur={14 * s} />
        <RimFilter id={`${id}-rim`} color="#ff9a3d" radius={1.2 * s} />
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-sky)`} />
      <g filter={`url(#${id}-blur)`} opacity=".75">
        <ellipse cx={W * 0.2} cy={H * 0.35} rx={W * 0.25} ry={H * 0.14} fill="#2b130a" />
        <ellipse cx={W * 0.75} cy={H * 0.25} rx={W * 0.3} ry={H * 0.12} fill="#3a1a0c" />
        <ellipse cx={W * 0.5} cy={hz} rx={W * 0.4} ry={H * 0.08} fill="#ffb35c" opacity=".6" />
      </g>
      <polygon points={ruins.join(' ')} fill="#2a160c" />
      <rect y={H * 0.82} width={W} height={H * 0.18} fill="#140b06" />
      {embers}
      <g filter={`url(#${id}-rim)`}>
        {soldier(W / 2 - 92 * s, H + 6 * s, 0.92 * s, true, '#120a06', '#ffb347')}
        {soldier(W / 2 + 92 * s, H + 6 * s, 0.92 * s, false, '#120a06', '#ffb347')}
        {soldier(W / 2, H + 4 * s, 1.18 * s, false, '#120a06', '#ffd166')}
      </g>
    </>
  );
}

/* ------------------------------------------------------------- Export */

const SCENES = {
  city: cityScene,
  space: spaceScene,
  racing: racingScene,
  fight: fightScene,
  shooter: shooterScene,
};

function GameArt({ variant, seed = 1, width = 400, height = 250, className = '', ...options }) {
  const id = `ga${svgId(useId())}`;
  const scene = SCENES[variant] ?? SCENES.city;
  return (
    <svg
      className={`game-art ${className}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {scene({ W: width, H: height, id, seed, ...options })}
    </svg>
  );
}

export default memo(GameArt);

// Uses a real image when one is provided, otherwise the drawn scene.
export function Cover({ image, art, title, seed, width, height }) {
  if (image) return <img className="game-art" src={image} alt={title} loading="lazy" />;
  return <GameArt variant={art} seed={seed} width={width} height={height} />;
}
