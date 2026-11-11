import * as pc from 'playcanvas';
import {
  GLASS_DIR_E,
  GLASS_DIR_N,
  GLASS_DIR_NE,
  GLASS_DIR_NW,
  GLASS_DIR_S,
  GLASS_DIR_SE,
  GLASS_DIR_SW,
  GLASS_DIR_W,
  MARCHING_ATLAS_GRID_DIM,
} from '../../../core/destruction/glassMarchingTiles.ts';
import { jaggedCrystallineTeethProfile, triangleWave } from './glassSystemTypes.ts';

export function generateMarchingGlassAtlasRgba8(atlasSize = 512): Uint8Array {
  const tilePx = Math.max(8, Math.floor(atlasSize / MARCHING_ATLAS_GRID_DIM));
  const size = tilePx * MARCHING_ATLAS_GRID_DIM;
  const rgba = new Uint8Array(size * size * 4);

  for (let mask = 0; mask < 256; mask++) {
    const tileCol = mask % MARCHING_ATLAS_GRID_DIM;
    const tileRow = Math.floor(mask / MARCHING_ATLAS_GRID_DIM);
    const basePxX = tileCol * tilePx;
    const basePxY = tileRow * tilePx;

    const missN = (mask & GLASS_DIR_N) === 0;
    const missNE = (mask & GLASS_DIR_NE) === 0;
    const missE = (mask & GLASS_DIR_E) === 0;
    const missSE = (mask & GLASS_DIR_SE) === 0;
    const missS = (mask & GLASS_DIR_S) === 0;
    const missSW = (mask & GLASS_DIR_SW) === 0;
    const missW = (mask & GLASS_DIR_W) === 0;
    const missNW = (mask & GLASS_DIR_NW) === 0;

    let crackOriginX = 0.5;
    let crackOriginY = 0.5;
    let missingWeight = 0;
    const accumOrigin = (ox: number, oy: number): void => {
      crackOriginX += ox;
      crackOriginY += oy;
      missingWeight++;
    };
    if (missN) accumOrigin(0.5, 1.0);
    if (missNE) accumOrigin(1.0, 1.0);
    if (missE) accumOrigin(1.0, 0.5);
    if (missSE) accumOrigin(1.0, 0.0);
    if (missS) accumOrigin(0.5, 0.0);
    if (missSW) accumOrigin(0.0, 0.0);
    if (missW) accumOrigin(0.0, 0.5);
    if (missNW) accumOrigin(0.0, 1.0);

    if (missingWeight > 0) {
      crackOriginX /= missingWeight + 1;
      crackOriginY /= missingWeight + 1;
    }

    const maskPhase = ((mask * 2654435761) >>> 0) * 2.3283064365386963e-10;

    for (let ly = 0; ly < tilePx; ly++) {
      const v = (ly + 0.5) / tilePx;
      const py = basePxY + ly;

      for (let lx = 0; lx < tilePx; lx++) {
        const u = (lx + 0.5) / tilePx;
        const px = basePxX + lx;
        const outIdx = (py * size + px) * 4;

        let minMargin = 10.0;
        if (missN) minMargin = Math.min(minMargin, 1 - v - (0.13 + 0.24 * jaggedCrystallineTeethProfile(u, 0.11)));
        if (missS) minMargin = Math.min(minMargin, v - (0.13 + 0.24 * jaggedCrystallineTeethProfile(u, 0.61)));
        if (missE) minMargin = Math.min(minMargin, 1 - u - (0.13 + 0.24 * jaggedCrystallineTeethProfile(v, 0.37)));
        if (missW) minMargin = Math.min(minMargin, u - (0.13 + 0.24 * jaggedCrystallineTeethProfile(v, 0.87)));

        if (missNE) minMargin = Math.min(minMargin, (1 - u + (1 - v) - (0.22 + 0.17 * jaggedCrystallineTeethProfile(u - v + 1, 0.19))) * 0.72);
        if (missSE) minMargin = Math.min(minMargin, (1 - u + v - (0.22 + 0.17 * jaggedCrystallineTeethProfile(u + v, 0.43))) * 0.72);
        if (missSW) minMargin = Math.min(minMargin, (u + v - (0.22 + 0.17 * jaggedCrystallineTeethProfile(u - v + 1, 0.71))) * 0.72);
        if (missNW) minMargin = Math.min(minMargin, (u + (1 - v) - (0.22 + 0.17 * jaggedCrystallineTeethProfile(u + v, 0.93))) * 0.72);

        if (minMargin < 0) {
          rgba[outIdx] = 0;
          rgba[outIdx + 1] = 0;
          rgba[outIdx + 2] = 0;
          rgba[outIdx + 3] = 0;
          continue;
        }

        let r = 158, g = 214, b = 230, a = 74;
        if (mask !== 255) {
          const dx = u - crackOriginX;
          const dy = v - crackOriginY;
          const radialDist = Math.hypot(dx, dy);
          const angle01 = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
          const radialSpokeWave = triangleWave(angle01 * (5 + (mask % 3)) + radialDist * 0.55 + maskPhase);
          const radialCrack = radialSpokeWave < 0.064 ? (1 - radialSpokeWave / 0.064) * Math.max(0.25, 1 - radialDist * 0.65) : 0;
          const rimWidth = 2.8 / tilePx;

          if (radialCrack > 0) {
            r = r + (232 - r) * radialCrack;
            g = g + (250 - g) * radialCrack;
            b = b + (255 - b) * radialCrack;
            a = Math.max(a, 96 + radialCrack * 120);
          }
          if (minMargin < rimWidth) {
            const rimT = 1 - minMargin / rimWidth;
            const sharpRim = rimT * (0.45 + 0.55 * rimT);
            r = r + (246 - r) * sharpRim;
            g = g + (254 - g) * sharpRim;
            b = b + (255 - b) * sharpRim;
            a = Math.max(a, 145 + sharpRim * 105);
          }
        }

        rgba[outIdx] = Math.max(0, Math.min(255, Math.round(r)));
        rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
        rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
        rgba[outIdx + 3] = Math.max(0, Math.min(255, Math.round(a)));
      }
    }
  }

  return rgba;
}

export function createMarchingGlassAtlasTexture(
  device: pc.GraphicsDevice,
  atlasSize = 512,
): pc.Texture {
  const tilePx = Math.max(8, Math.floor(atlasSize / MARCHING_ATLAS_GRID_DIM));
  const size = tilePx * MARCHING_ATLAS_GRID_DIM;
  const rgba = generateMarchingGlassAtlasRgba8(size);

  return new pc.Texture(device, {
    name: 'MarchingGlassAtlas256',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    flipY: false,
    levels: [rgba],
  });
}
