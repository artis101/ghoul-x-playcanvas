import * as pc from 'playcanvas';
import type { ViewmodelMuzzleFxAssets } from './arsenalTypes.ts';
import {
  createMuzzleStarTexture,
  createMuzzleCoronaTexture,
  createBarrelSmokeTexture,
  createMachinedGrainNormalTexture,
} from './muzzleFxTextures.ts';

const muzzleFxAssetCache = new WeakMap<pc.GraphicsDevice, ViewmodelMuzzleFxAssets>();

function createQuadMesh(device: pc.GraphicsDevice): pc.Mesh {
  const quadMesh = new pc.Mesh(device);
  quadMesh.setPositions([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  quadMesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  quadMesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
  quadMesh.setIndices([0, 1, 2, 0, 2, 3]);
  quadMesh.update(pc.PRIMITIVE_TRIANGLES);
  quadMesh.incRefCount();
  return quadMesh;
}

export function getOrCreateViewmodelFxAssets(device: pc.GraphicsDevice): ViewmodelMuzzleFxAssets {
  const cached = muzzleFxAssetCache.get(device);
  if (cached) return cached;

  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const quadMesh = createQuadMesh(device);
  const starTex = createMuzzleStarTexture(device);
  const coronaTex = createMuzzleCoronaTexture(device);
  const smokeTex = createBarrelSmokeTexture(device);
  const grainNormalTex = createMachinedGrainNormalTexture(device, maxAniso);

  const starPetalMat = new pc.StandardMaterial();
  starPetalMat.name = 'vmAaaMuzzleStarPetalMat';
  starPetalMat.diffuse = new pc.Color(1.0, 0.9, 0.55);
  starPetalMat.emissive = new pc.Color(1.0, 0.82, 0.38);
  starPetalMat.emissiveMap = starTex;
  starPetalMat.emissiveIntensity = 4.6;
  starPetalMat.opacityMap = starTex;
  starPetalMat.opacityMapChannel = 'a';
  starPetalMat.blendType = pc.BLEND_ADDITIVEALPHA;
  starPetalMat.depthWrite = false;
  starPetalMat.cull = pc.CULLFACE_NONE;
  starPetalMat.update();

  const coreSpearMat = new pc.StandardMaterial();
  coreSpearMat.name = 'vmAaaMuzzleCoreSpearMat';
  coreSpearMat.diffuse = new pc.Color(1.0, 0.97, 0.85);
  coreSpearMat.emissive = new pc.Color(1.0, 0.92, 0.68);
  coreSpearMat.emissiveIntensity = 5.2;
  coreSpearMat.opacity = 0.95;
  coreSpearMat.blendType = pc.BLEND_ADDITIVEALPHA;
  coreSpearMat.depthWrite = false;
  coreSpearMat.cull = pc.CULLFACE_NONE;
  coreSpearMat.update();

  const coronaHaloMat = new pc.StandardMaterial();
  coronaHaloMat.name = 'vmAaaMuzzleCoronaMat';
  coronaHaloMat.diffuse = new pc.Color(1.0, 0.78, 0.32);
  coronaHaloMat.emissive = new pc.Color(1.0, 0.68, 0.22);
  coronaHaloMat.emissiveMap = coronaTex;
  coronaHaloMat.emissiveIntensity = 3.5;
  coronaHaloMat.opacityMap = coronaTex;
  coronaHaloMat.opacityMapChannel = 'a';
  coronaHaloMat.blendType = pc.BLEND_ADDITIVEALPHA;
  coronaHaloMat.depthWrite = false;
  coronaHaloMat.cull = pc.CULLFACE_NONE;
  coronaHaloMat.update();

  const barrelSmokeTemplateMat = new pc.StandardMaterial();
  barrelSmokeTemplateMat.name = 'vmBarrelSmokeWispMat';
  barrelSmokeTemplateMat.diffuse = new pc.Color(0.74, 0.76, 0.8);
  barrelSmokeTemplateMat.emissive = new pc.Color(0.11, 0.11, 0.12);
  barrelSmokeTemplateMat.opacity = 0.24;
  barrelSmokeTemplateMat.opacityMap = smokeTex;
  barrelSmokeTemplateMat.opacityMapChannel = 'a';
  barrelSmokeTemplateMat.blendType = pc.BLEND_NORMAL;
  barrelSmokeTemplateMat.depthWrite = false;
  barrelSmokeTemplateMat.cull = pc.CULLFACE_NONE;
  barrelSmokeTemplateMat.update();

  const assets: ViewmodelMuzzleFxAssets = {
    quadMesh,
    starPetalMat,
    coreSpearMat,
    coronaHaloMat,
    barrelSmokeTemplateMat,
    machinedGrainNormalTex: grainNormalTex,
  };
  muzzleFxAssetCache.set(device, assets);
  return assets;
}
