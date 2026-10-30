// Small seeded PRNG so the generated artwork looks the same on every render.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour.
export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  return (
    '#' +
    [n >> 16, (n >> 8) & 255, n & 255]
      .map((c) => Math.round(Math.min(255, Math.max(0, c * (1 + amount)))))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

export const svgId = (reactId) => reactId.replace(/[^a-zA-Z0-9]/g, '');
