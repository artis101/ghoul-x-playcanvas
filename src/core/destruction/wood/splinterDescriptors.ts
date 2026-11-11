import { Clipper, Paths64 } from 'clipper2-js';
import {
  INV_WOOD_CLIPPER_SCALE,
  type SplinterSpawnDescriptor,
} from './woodClipperTypes.ts';
import { createSeededRng } from './jaggedHoleStamp.ts';

export function buildPerimeterSplinterDescriptors(
  cutWoodPaths: Paths64,
  stampCenterU: number,
  stampCenterV: number,
  desiredCount: number,
  shotSeed: number,
): SplinterSpawnDescriptor[] {
  const segments: Array<{
    u0: number;
    v0: number;
    tu: number;
    tv: number;
    len: number;
  }> = [];

  let totalLen = 0;
  for (let p = 0; p < cutWoodPaths.length; p++) {
    const ring = cutWoodPaths[p];
    if (ring.length < 3 || Clipper.area(ring) <= 0) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const u0 = a.x * INV_WOOD_CLIPPER_SCALE;
      const v0 = a.y * INV_WOOD_CLIPPER_SCALE;
      const u1 = b.x * INV_WOOD_CLIPPER_SCALE;
      const v1 = b.y * INV_WOOD_CLIPPER_SCALE;
      const du = u1 - u0;
      const dv = v1 - v0;
      const len = Math.hypot(du, dv);
      if (len > 1e-4) {
        segments.push({ u0, v0, tu: du / len, tv: dv / len, len });
        totalLen += len;
      }
    }
  }

  if (segments.length === 0 || totalLen <= 1e-4) return [];

  const clampedCount = Math.max(2, Math.min(28, Math.round(desiredCount)));
  const rng = createSeededRng((shotSeed * 747796405 + 2891336453) >>> 0);
  const startArc = rng() * (totalLen / clampedCount);
  const stepArc = totalLen / clampedCount;

  const descriptors: SplinterSpawnDescriptor[] = [];
  let segIdx = 0;
  let segAccumStart = 0;

  for (let k = 0; k < clampedCount; k++) {
    const targetS = (startArc + k * stepArc) % totalLen;
    while (
      segIdx < segments.length - 1 &&
      segAccumStart + segments[segIdx].len < targetS
    ) {
      segAccumStart += segments[segIdx].len;
      segIdx++;
    }
    if (segAccumStart > targetS) {
      segIdx = 0;
      segAccumStart = 0;
      while (
        segIdx < segments.length - 1 &&
        segAccumStart + segments[segIdx].len < targetS
      ) {
        segAccumStart += segments[segIdx].len;
        segIdx++;
      }
    }

    const seg = segments[segIdx];
    const localDist = Math.max(0, Math.min(seg.len, targetS - segAccumStart));
    const su = seg.u0 + seg.tu * localDist;
    const sv = seg.v0 + seg.tv * localDist;

    let ru = su - stampCenterU;
    let rv = sv - stampCenterV;
    const rLen = Math.hypot(ru, rv);
    if (rLen > 1e-5) {
      ru /= rLen;
      rv /= rLen;
    } else {
      ru = seg.tv;
      rv = -seg.tu;
    }

    const signFlip = (k & 1) === 0 ? 1 : -1;
    const splinterLenM = Math.max(
      0.045,
      Math.min(0.22, (totalLen / clampedCount) * (0.65 + 0.55 * rng())),
    );

    descriptors.push({
      u: su,
      v: sv,
      tangentU: seg.tu * signFlip,
      tangentV: seg.tv * signFlip,
      radialU: ru,
      radialV: rv,
      lengthM: splinterLenM,
    });
  }

  return descriptors;
}
