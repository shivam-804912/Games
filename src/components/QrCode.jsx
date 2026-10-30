import { mulberry32 } from '../utils/random.js';

// Decorative QR-style code (not scannable) with the three finder squares.
export default function QrCode({ seed = 7, size = 25 }) {
  const rand = mulberry32(seed);
  const inFinder = (x, y) => (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);

  let cells = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inFinder(x, y) && rand() > 0.52) cells += `M${x} ${y}h1v1h-1z`;
    }
  }
  const eyes = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];

  return (
    <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} shapeRendering="crispEdges" aria-hidden="true">
      <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" />
      <path d={cells} fill="#0b0a1a" />
      {eyes.map(([x, y]) => (
        <g key={`${x}-${y}`} fill="#0b0a1a">
          <path d={`M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z`} fillRule="evenodd" />
          <rect x={x + 2} y={y + 2} width="3" height="3" />
        </g>
      ))}
    </svg>
  );
}
