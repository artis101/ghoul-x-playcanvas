import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { createMulberry32 } from './voronoi3DMath.ts';

export function generateStratifiedSeeds(
  width: number,
  height: number,
  depth: number,
  cellCount: number,
  seed: number,
): Vec3Like[] {
  const rng = createMulberry32(seed);
  const count = Math.max(2, Math.floor(cellCount));

  const nz = depth >= 0.45 && count >= 16 ? 2 : 1;
  const layerCount = Math.ceil(count / nz);
  const aspectXY = Math.max(0.25, width / Math.max(0.1, height));
  const nx = Math.max(1, Math.round(Math.sqrt(layerCount * aspectXY)));
  const ny = Math.max(1, Math.ceil(layerCount / nx));

  const candidates: { cellRank: number; jitterRank: number; pt: Vec3Like }[] = [];
  const x0 = -width * 0.5;
  const z0 = -depth * 0.5;
  const dx = width / nx;
  const dy = height / ny;
  const dz = depth / nz;

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const jx = 0.2 + rng() * 0.6;
        const jy = iy === 0 ? 0.14 + rng() * 0.42 : 0.2 + rng() * 0.6;
        const jz = nz === 1 ? 0.32 + rng() * 0.36 : 0.22 + rng() * 0.56;

        candidates.push({
          cellRank: iy === 0 ? 0 : 1,
          jitterRank: rng(),
          pt: {
            x: x0 + (ix + jx) * dx,
            y: (iy + jy) * dy,
            z: z0 + (iz + jz) * dz,
          },
        });
      }
    }
  }

  candidates.sort((a, b) =>
    a.cellRank !== b.cellRank ? a.cellRank - b.cellRank : a.jitterRank - b.jitterRank,
  );

  const seeds: Vec3Like[] = [];
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    seeds.push(candidates[i].pt);
  }
  while (seeds.length < count) {
    seeds.push({
      x: x0 + (0.12 + rng() * 0.76) * width,
      y: (0.12 + rng() * 0.76) * height,
      z: z0 + (0.2 + rng() * 0.6) * depth,
    });
  }

  return seeds;
}
