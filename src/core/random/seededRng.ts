/** Small, fast seeded PRNG (mulberry32-style). Same seed, same sequence: tests and replays stay reproducible. */
export function createSeededRng(seedInt: number): () => number {
  let state = seedInt >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes two integers into a well-spread 32-bit seed. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform value in [min, max). */
export function rollRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** FNV-1a hash of a string to a 32-bit seed, e.g. a combatant id. */
export function hashStringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
