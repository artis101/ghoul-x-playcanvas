export function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function hash2d(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 999999937) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise2d(x: number, y: number, period: number, seed: number): number {
  const gx = (x % period + period) % period;
  const gy = (y % period + period) % period;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;

  const sx = gx - x0;
  const sy = gy - y0;
  const fx = sx * sx * (3 - 2 * sx);
  const fy = sy * sy * (3 - 2 * sy);

  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x1, y0, seed);
  const n01 = hash2d(x0, y1, seed);
  const n11 = hash2d(x1, y1, seed);

  const ix0 = n00 * (1 - fx) + n10 * fx;
  const ix1 = n01 * (1 - fx) + n11 * fx;
  return ix0 * (1 - fy) + ix1 * fy;
}
