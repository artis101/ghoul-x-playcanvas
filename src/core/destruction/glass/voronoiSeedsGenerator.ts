import { createDeterministicPrng } from '../glassMarchingTiles.ts';
import type { Point2D } from './glassShardTypes.ts';

export function generateWindowShatterSeeds(
  widthM: number,
  heightM: number,
  hitX: number,
  hitY: number,
  targetShardCount: number,
  seedInt: number,
): Point2D[] {
  const rand = createDeterministicPrng(seedInt);
  const minDimM = Math.min(widthM, heightM);
  const minSepSq = Math.pow(minDimM * 0.018, 2);
  const marginX = widthM * 0.025;
  const marginY = heightM * 0.025;
  const seeds: Point2D[] = [];

  const tryPushInteriorSeed = (x: number, y: number): boolean => {
    const cx = Math.max(marginX * 0.5, Math.min(widthM - marginX * 0.5, x));
    const cy = Math.max(marginY * 0.5, Math.min(heightM - marginY * 0.5, y));
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - cx;
      const dy = seeds[i].y - cy;
      if (dx * dx + dy * dy < minSepSq) {
        return false;
      }
    }
    seeds.push({ x: cx, y: cy });
    return true;
  };

  tryPushInteriorSeed(
    hitX + (rand() - 0.5) * minDimM * 0.015,
    hitY + (rand() - 0.5) * minDimM * 0.015,
  );

  if (targetShardCount <= 30) {
    const spokeCount = Math.max(5, Math.min(7, Math.round(targetShardCount * 0.28)));
    const spokeBaseAngle = rand() * Math.PI * 2;
    const spokeAngles: number[] = [];
    for (let s = 0; s < spokeCount; s++) {
      spokeAngles.push(
        spokeBaseAngle +
          (s / spokeCount) * Math.PI * 2 +
          (rand() - 0.5) * ((Math.PI * 0.65) / spokeCount),
      );
    }

    const innerCount = Math.max(3, Math.round((targetShardCount - 1) * 0.28));
    const midCount = Math.max(4, Math.round((targetShardCount - 1) * 0.36));
    const outerCount = Math.max(0, targetShardCount - 1 - innerCount - midCount);

    for (let i = 0; i < innerCount; i++) {
      const spoke = spokeAngles[i % spokeCount];
      const angle = spoke + (rand() - 0.5) * 0.34;
      const radius = (0.055 + rand() * 0.115) * minDimM;
      if (!tryPushInteriorSeed(hitX + Math.cos(angle) * radius, hitY + Math.sin(angle) * radius)) {
        tryPushInteriorSeed(marginX + rand() * (widthM - 2 * marginX), marginY + rand() * (heightM - 2 * marginY));
      }
    }

    for (let i = 0; i < midCount; i++) {
      const spoke = spokeAngles[(i + 2) % spokeCount];
      const angle = spoke + (rand() - 0.5) * 0.42;
      const radius = (0.19 + Math.pow(rand(), 0.85) * 0.26) * minDimM;
      if (!tryPushInteriorSeed(hitX + Math.cos(angle) * radius, hitY + Math.sin(angle) * radius)) {
        tryPushInteriorSeed(marginX + rand() * (widthM - 2 * marginX), marginY + rand() * (heightM - 2 * marginY));
      }
    }

    const perimeterBase = rand() * Math.PI * 2;
    for (let i = 0; i < outerCount; i++) {
      const theta = perimeterBase + (i / Math.max(1, outerCount)) * Math.PI * 2 + (rand() - 0.5) * 0.38;
      const rx = widthM * (0.35 + rand() * 0.12);
      const ry = heightM * (0.35 + rand() * 0.12);
      const px = widthM * 0.5 + Math.cos(theta) * rx;
      const py = heightM * 0.5 + Math.sin(theta) * ry;
      if (!tryPushInteriorSeed(px, py)) {
        tryPushInteriorSeed(marginX + rand() * (widthM - 2 * marginX), marginY + rand() * (heightM - 2 * marginY));
      }
    }
  } else {
    const innerRingCount = Math.round((targetShardCount - 1) * 0.34);
    const midRingCount = Math.round((targetShardCount - 1) * 0.36);
    const outerFrameCount = targetShardCount - 1 - innerRingCount - midRingCount;

    const populateRing = (count: number, minRadiusFrac: number, maxRadiusFrac: number): void => {
      const baseAngle = rand() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const frac = count > 1 ? i / count : 0;
        const angle = baseAngle + frac * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 1.3) / count);
        const rFrac = minRadiusFrac + Math.pow(rand(), 0.85) * (maxRadiusFrac - minRadiusFrac);
        const radius = rFrac * minDimM;
        const sx = hitX + Math.cos(angle) * radius;
        const sy = hitY + Math.sin(angle) * radius;
        if (!tryPushInteriorSeed(sx, sy)) {
          for (let attempt = 0; attempt < 12; attempt++) {
            const fallbackX = marginX + rand() * (widthM - 2 * marginX);
            const fallbackY = marginY + rand() * (heightM - 2 * marginY);
            if (tryPushInteriorSeed(fallbackX, fallbackY)) break;
          }
        }
      }
    };

    populateRing(innerRingCount, 0.04, 0.16);
    populateRing(midRingCount, 0.17, 0.42);

    const perimeterBaseAngle = rand() * Math.PI * 2;
    for (let i = 0; i < outerFrameCount; i++) {
      const theta = perimeterBaseAngle + (i / Math.max(1, outerFrameCount)) * Math.PI * 2 + (rand() - 0.5) * 0.35;
      const rx = widthM * (0.36 + rand() * 0.12);
      const ry = heightM * (0.36 + rand() * 0.12);
      const px = widthM * 0.5 + Math.cos(theta) * rx;
      const py = heightM * 0.5 + Math.sin(theta) * ry;
      if (!tryPushInteriorSeed(px, py)) {
        for (let attempt = 0; attempt < 16; attempt++) {
          const fx = marginX + rand() * (widthM - 2 * marginX);
          const fy = marginY + rand() * (heightM - 2 * marginY);
          if (tryPushInteriorSeed(fx, fy)) break;
        }
      }
    }
  }

  let safetyGuard = 0;
  while (seeds.length < targetShardCount && safetyGuard < 256) {
    safetyGuard++;
    const fx = marginX + rand() * (widthM - 2 * marginX);
    const fy = marginY + rand() * (heightM - 2 * marginY);
    tryPushInteriorSeed(fx, fy);
  }

  return seeds;
}
