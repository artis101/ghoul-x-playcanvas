import * as pc from 'playcanvas';
import { hash2d, valueNoise2d } from './proceduralNoise.ts';
import { createProceduralNormalAndGlossMaps } from './proceduralNormalGloss.ts';
import { createTacticalAlbedoTexture } from './proceduralAlbedo.ts';

interface CachedEnvMaps {
  floorDiffuse: pc.Texture;
  floorNormal: pc.Texture;
  floorGloss: pc.Texture;
  wallDiffuse: pc.Texture;
  wallNormal: pc.Texture;
  wallGloss: pc.Texture;
}

const cachedEnvMapsByDevice = new WeakMap<pc.GraphicsDevice, CachedEnvMaps>();

/**
 * Applies high-resolution PBR albedo, tangent-space normal, and gloss/roughness maps
 * to the firing-range concrete slab floor and reinforced jersey barriers.
 */
export function applyRetroEnvironmentTextures(
  device: pc.GraphicsDevice,
  floorMat: pc.StandardMaterial,
  concreteMat: pc.StandardMaterial
): void {
  let envMaps = cachedEnvMapsByDevice.get(device);
  if (!envMaps) {
    const S = 128;

    const floorDiffuse = createTacticalAlbedoTexture(device, 'pbr_range_floor_albedo', S, (x, y, u, v) => {
      const fine = (hash2d(x, y, 901) - 0.5) * 10;
      const macro = (valueNoise2d(u * 6, v * 6, 6, 903) - 0.5) * 16;
      const half = S >> 1;
      const dxSeam = Math.min(x, S - x, Math.abs(x - half));
      const dySeam = Math.min(y, S - y, Math.abs(y - half));
      const seamDist = Math.min(dxSeam, dySeam);

      if (seamDist === 0) return [16, 19, 24];
      if (seamDist === 1) return [48, 54, 62];
      const scuff = valueNoise2d(u * 12, v * 12, 12, 907) > 0.72 ? -8 : 0;
      return [38 + fine + macro + scuff, 43 + fine + macro + scuff, 50 + fine + macro + scuff];
    });

    const { normalMap: floorNormal, glossMap: floorGloss } = createProceduralNormalAndGlossMaps(
      device,
      'pbr_range_floor',
      S,
      (x, y, u, v) => {
        const half = S >> 1;
        const dxSeam = Math.min(x, S - x, Math.abs(x - half));
        const dySeam = Math.min(y, S - y, Math.abs(y - half));
        const seamDist = Math.min(dxSeam, dySeam);
        const seamGroove = seamDist === 0 ? -0.65 : seamDist === 1 ? -0.22 : 0.0;
        const brush = Math.sin(v * Math.PI * 32) * 0.04;
        const pitting = (valueNoise2d(u * 24, v * 24, 24, 911) - 0.5) * 0.24;
        const polishPatch = valueNoise2d(u * 5, v * 5, 5, 913);
        const gloss = seamDist <= 1 ? 0.16 : 0.34 + polishPatch * 0.36;
        return { height: seamGroove + brush + pitting, gloss };
      },
      2.6
    );

    const wallDiffuse = createTacticalAlbedoTexture(device, 'pbr_concrete_barrier_albedo', S, (x, y, u, v) => {
      const fine = (hash2d(x, y, 919) - 0.5) * 12;
      const mottling = (valueNoise2d(u * 8, v * 8, 8, 923) - 0.5) * 20;

      if (v < 0.16) {
        const stripePhase = Math.floor((u * 8 + v * 6) * 2) & 1;
        const wear = valueNoise2d(u * 20, v * 20, 20, 929) > 0.76 ? -28 : 0;
        if (stripePhase === 0) return [198 + fine * 0.5 + wear, 152 + fine * 0.5 + wear, 28];
        return [26 + fine * 0.4, 28 + fine * 0.4, 31 + fine * 0.4];
      }

      const formLine = y % 32 === 0 ? -18 : y % 32 === 1 ? 8 : 0;
      const tieX = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75));
      const tieY = Math.min(Math.abs(v - 0.42), Math.abs(v - 0.76));
      const tieDist = Math.hypot(tieX * 2.2, tieY);
      const tieShade = tieDist < 0.032 ? -28 : 0;

      const base = 92 + fine + mottling + formLine + tieShade;
      return [base, base + 3, base + 7];
    });

    const { normalMap: wallNormal, glossMap: wallGloss } = createProceduralNormalAndGlossMaps(
      device,
      'pbr_concrete_barrier',
      S,
      (_x, y, u, v) => {
        const pores = (valueNoise2d(u * 28, v * 28, 28, 937) - 0.5) * 0.34;
        const coarse = (valueNoise2d(u * 8, v * 8, 8, 941) - 0.5) * 0.22;
        const formSeam = y % 32 === 0 ? -0.55 : 0.0;
        const tieX = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75));
        const tieY = Math.min(Math.abs(v - 0.42), Math.abs(v - 0.76));
        const tieDent = Math.hypot(tieX * 2.2, tieY) < 0.032 ? -0.6 : 0.0;
        const gloss = v < 0.16 ? 0.44 : 0.22 + valueNoise2d(u * 10, v * 10, 10, 947) * 0.18;
        return { height: pores + coarse + formSeam + tieDent, gloss };
      },
      2.8
    );

    envMaps = { floorDiffuse, floorNormal, floorGloss, wallDiffuse, wallNormal, wallGloss };
    cachedEnvMapsByDevice.set(device, envMaps);
  }

  const floorTiling = new pc.Vec2(20, 80);
  floorMat.diffuse = new pc.Color(1, 1, 1);
  floorMat.diffuseMap = envMaps.floorDiffuse;
  floorMat.diffuseMapTiling = floorTiling;
  floorMat.normalMap = envMaps.floorNormal;
  floorMat.normalMapTiling = floorTiling.clone();
  floorMat.bumpiness = 1.15;
  floorMat.glossMap = envMaps.floorGloss;
  floorMat.glossMapChannel = 'g';
  floorMat.glossMapTiling = floorTiling.clone();
  floorMat.gloss = 0.85;
  floorMat.useMetalness = true;
  floorMat.metalness = 0.06;
  floorMat.enableGGXSpecular = true;
  floorMat.fresnelModel = pc.FRESNEL_SCHLICK;
  floorMat.update();

  const wallTiling = new pc.Vec2(3, 1);
  concreteMat.diffuse = new pc.Color(1, 1, 1);
  concreteMat.diffuseMap = envMaps.wallDiffuse;
  concreteMat.diffuseMapTiling = wallTiling;
  concreteMat.normalMap = envMaps.wallNormal;
  concreteMat.normalMapTiling = wallTiling.clone();
  concreteMat.bumpiness = 1.25;
  concreteMat.glossMap = envMaps.wallGloss;
  concreteMat.glossMapChannel = 'g';
  concreteMat.glossMapTiling = wallTiling.clone();
  concreteMat.gloss = 0.78;
  concreteMat.useMetalness = true;
  concreteMat.metalness = 0.04;
  concreteMat.enableGGXSpecular = true;
  concreteMat.fresnelModel = pc.FRESNEL_SCHLICK;
  concreteMat.update();
}
