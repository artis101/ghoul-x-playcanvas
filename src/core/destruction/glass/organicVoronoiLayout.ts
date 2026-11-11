import { createDeterministicPrng } from '../glassMarchingTiles.ts';
import type {
  OrganicVoronoiLayoutOptions,
  Point2D,
  VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import { buildVoronoiCellsFromInteriorSeeds } from './voronoiWindowShatter.ts';

export function generateOrganicVoronoiCells2D(
  options: OrganicVoronoiLayoutOptions,
): VoronoiWindowShatterResult {
  const widthM = Math.max(0.1, options.widthM);
  const heightM = Math.max(0.1, options.heightM);
  const targetCells = Math.max(16, Math.min(128, Math.round(options.cellCount ?? 68)));
  const thicknessM = options.thicknessM ?? 0.024;
  const rand = createDeterministicPrng(options.seed ?? 0x474c4153);

  const avgCellArea = (widthM * heightM) / targetCells;
  const approxPitch = Math.sqrt(avgCellArea);
  const minSep = approxPitch * 0.56;
  const minSepSq = minSep * minSep;
  const marginX = Math.min(widthM * 0.05, approxPitch * 0.32);
  const marginY = Math.min(heightM * 0.05, approxPitch * 0.32);

  const seeds: Point2D[] = [];
  const tryAdd = (x: number, y: number, sepSq: number): boolean => {
    const cx = Math.max(marginX, Math.min(widthM - marginX, x));
    const cy = Math.max(marginY, Math.min(heightM - marginY, y));
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - cx;
      const dy = seeds[i].y - cy;
      if (dx * dx + dy * dy < sepSq) {
        return false;
      }
    }
    seeds.push({ x: cx, y: cy });
    return true;
  };

  const phi1 = 0.7548776662466927;
  const phi2 = 0.5698402909980532;
  const phaseX = rand();
  const phaseY = rand();

  for (let i = 0; i < targetCells * 4 && seeds.length < targetCells; i++) {
    const qx = (phaseX + (i + 1) * phi1) % 1;
    const qy = (phaseY + (i + 1) * phi2) % 1;
    const jx = (rand() - 0.5) * approxPitch * 0.65;
    const jy = (rand() - 0.5) * approxPitch * 0.65;
    const x = marginX + qx * (widthM - 2 * marginX) + jx;
    const y = marginY + qy * (heightM - 2 * marginY) + jy;
    tryAdd(x, y, minSepSq);
  }

  let fallback = 0;
  while (seeds.length < targetCells && fallback < 320) {
    fallback++;
    tryAdd(
      marginX + rand() * (widthM - 2 * marginX),
      marginY + rand() * (heightM - 2 * marginY),
      minSepSq * 0.45,
    );
  }

  return buildVoronoiCellsFromInteriorSeeds(
    seeds,
    widthM,
    heightM,
    widthM * 0.5,
    heightM * 0.5,
    thicknessM,
  );
}
