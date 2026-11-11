import * as pc from 'playcanvas';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { createGleamingBrassCasingMaterial, createShotgunHullMaterial } from '../materials/casingMaterials.ts';
import { createBloodSplatterMaterial } from '../materials/decalMaterials.ts';
import { createStreakGlowTexture } from '../materials/transientFxMaterials.ts';
import { buildCrossedStreakZMesh, buildLoftedDrumMesh } from './fxMeshBuilders.ts';

export interface MayhemPools {
  brassCasingPool: HardwareInstancedPool;
  shotgunHullPool: HardwareInstancedPool;
  shrapnelPool: HardwareInstancedPool;
  bloodSplatterPool: HardwareInstancedPool;
  tracerCorePool: HardwareInstancedPool;
  tracerHaloPool: HardwareInstancedPool;
  impactSparkPool: HardwareInstancedPool;
}

export interface MayhemPoolLimits {
  maxBrassCasings?: number;
  maxShotgunHulls?: number;
  maxShrapnelShards?: number;
  maxBloodSplatters?: number;
}

export function createMayhemInstancedPools(
  app: pc.Application,
  unitQuadMesh: pc.Mesh,
  limits: MayhemPoolLimits = {},
): MayhemPools {
  const dev = app.graphicsDevice;

  const casingCylinderMesh = buildLoftedDrumMesh(
    dev,
    [
      { y: -0.5, r: 0.54, v: 0.0 },
      { y: -0.44, r: 0.46, v: 0.06 },
      { y: -0.39, r: 0.51, v: 0.11 },
      { y: 0.18, r: 0.49, v: 0.68 },
      { y: 0.34, r: 0.38, v: 0.84 },
      { y: 0.5, r: 0.37, v: 1.0 },
    ],
    14,
    0,
  );
  const hullCylinderMesh = buildLoftedDrumMesh(
    dev,
    [
      { y: -0.5, r: 0.56, v: 0.0 },
      { y: -0.44, r: 0.52, v: 0.06 },
      { y: -0.2, r: 0.51, v: 0.3 },
      { y: 0.44, r: 0.5, v: 0.94 },
      { y: 0.5, r: 0.46, v: 1.0 },
    ],
    14,
    0,
  );

  const brassMat = createGleamingBrassCasingMaterial(dev);
  const hullMat = createShotgunHullMaterial(dev);

  const brassCasingPool = new HardwareInstancedPool(app, casingCylinderMesh, brassMat, limits.maxBrassCasings ?? 1536, 'MayhemBrassCasingPool', false);
  const shotgunHullPool = new HardwareInstancedPool(app, hullCylinderMesh, hullMat, limits.maxShotgunHulls ?? 512, 'MayhemShotgunHullPool', false);

  const shrapnelBoxMesh = pc.Mesh.fromGeometry(dev, new pc.BoxGeometry());
  const shrapnelMat = new pc.StandardMaterial();
  shrapnelMat.name = 'mayhemHotShrapnelMat';
  shrapnelMat.diffuse = new pc.Color(0.24, 0.2, 0.18);
  shrapnelMat.emissive = new pc.Color(1.0, 0.38, 0.08);
  shrapnelMat.emissiveIntensity = 2.2;
  shrapnelMat.useMetalness = true;
  shrapnelMat.metalness = 0.82;
  shrapnelMat.gloss = 0.65;
  shrapnelMat.fresnelModel = pc.FRESNEL_SCHLICK;
  shrapnelMat.update();

  const shrapnelPool = new HardwareInstancedPool(app, shrapnelBoxMesh, shrapnelMat, limits.maxShrapnelShards ?? 256, 'MayhemShrapnelPool', false);
  const splatterMat = createBloodSplatterMaterial(dev);
  const bloodSplatterPool = new HardwareInstancedPool(app, unitQuadMesh, splatterMat, limits.maxBloodSplatters ?? 384, 'MayhemBloodSplatterPool', false);

  const streakMesh = buildCrossedStreakZMesh(dev);
  const streakGlowTex = createStreakGlowTexture(dev);

  const tracerCoreMat = new pc.StandardMaterial();
  tracerCoreMat.name = 'mayhemTracerHotCoreMat';
  tracerCoreMat.diffuse = new pc.Color(1.0, 0.98, 0.88);
  tracerCoreMat.emissive = new pc.Color(1.0, 0.93, 0.72);
  tracerCoreMat.emissiveMap = streakGlowTex;
  tracerCoreMat.emissiveIntensity = 4.2;
  tracerCoreMat.opacityMap = streakGlowTex;
  tracerCoreMat.opacityMapChannel = 'a';
  tracerCoreMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerCoreMat.depthWrite = false;
  tracerCoreMat.cull = pc.CULLFACE_NONE;
  tracerCoreMat.update();

  const tracerHaloMat = new pc.StandardMaterial();
  tracerHaloMat.name = 'mayhemTracerPlasmaHaloMat';
  tracerHaloMat.diffuse = new pc.Color(1.0, 0.66, 0.22);
  tracerHaloMat.emissive = new pc.Color(1.0, 0.52, 0.12);
  tracerHaloMat.emissiveMap = streakGlowTex;
  tracerHaloMat.emissiveIntensity = 2.4;
  tracerHaloMat.opacity = 0.72;
  tracerHaloMat.opacityMap = streakGlowTex;
  tracerHaloMat.opacityMapChannel = 'a';
  tracerHaloMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerHaloMat.depthWrite = false;
  tracerHaloMat.cull = pc.CULLFACE_NONE;
  tracerHaloMat.update();

  const impactSparkMat = new pc.StandardMaterial();
  impactSparkMat.name = 'mayhemRicochetSparkMat';
  impactSparkMat.diffuse = new pc.Color(1.0, 0.88, 0.48);
  impactSparkMat.emissive = new pc.Color(1.0, 0.72, 0.22);
  impactSparkMat.emissiveMap = streakGlowTex;
  impactSparkMat.emissiveIntensity = 3.8;
  impactSparkMat.opacityMap = streakGlowTex;
  impactSparkMat.opacityMapChannel = 'a';
  impactSparkMat.blendType = pc.BLEND_ADDITIVEALPHA;
  impactSparkMat.depthWrite = false;
  impactSparkMat.cull = pc.CULLFACE_NONE;
  impactSparkMat.update();

  const tracerCorePool = new HardwareInstancedPool(app, streakMesh, tracerCoreMat, 128, 'MayhemTracerCorePool', false);
  const tracerHaloPool = new HardwareInstancedPool(app, streakMesh, tracerHaloMat, 128, 'MayhemTracerHaloPool', false);
  const impactSparkPool = new HardwareInstancedPool(app, streakMesh, impactSparkMat, 320, 'MayhemImpactSparkPool', false);

  return {
    brassCasingPool,
    shotgunHullPool,
    shrapnelPool,
    bloodSplatterPool,
    tracerCorePool,
    tracerHaloPool,
    impactSparkPool,
  };
}

export function destroyMayhemPools(pools: MayhemPools): void {
  pools.brassCasingPool.destroy();
  pools.shotgunHullPool.destroy();
  pools.shrapnelPool.destroy();
  pools.bloodSplatterPool.destroy();
  pools.tracerCorePool.destroy();
  pools.tracerHaloPool.destroy();
  pools.impactSparkPool.destroy();
}
