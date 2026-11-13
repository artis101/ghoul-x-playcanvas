import * as pc from 'playcanvas';
import type { WetGoreMaterialSuite } from './goreTypes.ts';
import { buildFloorQuadMesh } from './goreMeshHelpers.ts';
import { createDropletNormalTexture, createBloodPoolTextures } from './textures/bloodPoolTexture.ts';
import { createBloodMistTexture } from './textures/bloodMistTexture.ts';
import { createFleshMuscleTextures } from './textures/fleshMuscleTexture.ts';

const goreSuiteCache = new WeakMap<pc.GraphicsDevice, WetGoreMaterialSuite>();

export function createWetGoreMaterialSuite(device: pc.GraphicsDevice | null): WetGoreMaterialSuite {
  if (device) {
    const cached = goreSuiteCache.get(device);
    if (cached) return cached;
  }

  const maxAniso = device ? Math.min(device.maxAnisotropy || 4, 8) : 1;

  const wetBloodDropMat = new pc.StandardMaterial();
  wetBloodDropMat.name = 'goreWetArterialDropPbrMat';
  wetBloodDropMat.diffuse = new pc.Color(0.3, 0.03, 0.026);
  wetBloodDropMat.emissive = new pc.Color(0.02, 0.002, 0.002);
  wetBloodDropMat.useMetalness = true;
  wetBloodDropMat.metalness = 0;
  wetBloodDropMat.gloss = 0.55;
  wetBloodDropMat.fresnelModel = pc.FRESNEL_SCHLICK;

  // Floor blood: dark and flat with a soft sheen. No clear-coat or meniscus normals, which made
  // every overlapping blob catch its own rim highlight and read as a pile of red jelly.
  const wetBloodPoolMat = new pc.StandardMaterial();
  wetBloodPoolMat.name = 'goreWetArterialPoolPbrMat';
  wetBloodPoolMat.diffuse = new pc.Color(0.26, 0.035, 0.028);
  wetBloodPoolMat.useMetalness = true;
  wetBloodPoolMat.metalness = 0;
  wetBloodPoolMat.gloss = 0.5;
  wetBloodPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  wetBloodPoolMat.blendType = pc.BLEND_NORMAL;
  wetBloodPoolMat.depthWrite = false;

  const wetBloodMistBaseMat = new pc.StandardMaterial();
  wetBloodMistBaseMat.name = 'goreBacklitMistMat';
  wetBloodMistBaseMat.diffuse = new pc.Color(0.3, 0.04, 0.03);
  wetBloodMistBaseMat.emissive = new pc.Color(0.03, 0.004, 0.003);
  wetBloodMistBaseMat.opacity = 0.54;
  wetBloodMistBaseMat.blendType = pc.BLEND_NORMAL;
  wetBloodMistBaseMat.depthWrite = false;
  wetBloodMistBaseMat.cull = pc.CULLFACE_NONE;

  const wetFleshGibMat = new pc.StandardMaterial();
  wetFleshGibMat.name = 'goreWetMuscleGibPbrMat';
  wetFleshGibMat.diffuse = new pc.Color(0.34, 0.05, 0.045);
  wetFleshGibMat.useMetalness = true;
  wetFleshGibMat.metalness = 0;
  wetFleshGibMat.gloss = 0.45;
  wetFleshGibMat.fresnelModel = pc.FRESNEL_SCHLICK;

  const wetCorticalBoneMat = new pc.StandardMaterial();
  wetCorticalBoneMat.name = 'goreWetCorticalBonePbrMat';
  wetCorticalBoneMat.diffuse = new pc.Color(0.64, 0.55, 0.44);
  wetCorticalBoneMat.useMetalness = true;
  wetCorticalBoneMat.metalness = 0;
  wetCorticalBoneMat.gloss = 0.4;
  wetCorticalBoneMat.fresnelModel = pc.FRESNEL_SCHLICK;

  const wetMarrowCapMat = new pc.StandardMaterial();
  wetMarrowCapMat.name = 'goreTrabecularMarrowMat';
  wetMarrowCapMat.diffuse = new pc.Color(0.24, 0.04, 0.03);
  wetMarrowCapMat.useMetalness = true;
  wetMarrowCapMat.metalness = 0;
  wetMarrowCapMat.gloss = 0.45;
  wetMarrowCapMat.fresnelModel = pc.FRESNEL_SCHLICK;

  const incandescentSparkMat = new pc.StandardMaterial();
  incandescentSparkMat.name = 'goreIncandescentSparkMat';
  incandescentSparkMat.diffuse = new pc.Color(1.0, 0.84, 0.42);
  incandescentSparkMat.emissive = new pc.Color(1.0, 0.66, 0.18);
  incandescentSparkMat.emissiveIntensity = 2.8;
  incandescentSparkMat.blendType = pc.BLEND_ADDITIVEALPHA;
  incandescentSparkMat.depthWrite = false;

  const tracerTailMat = new pc.StandardMaterial();
  tracerTailMat.name = 'goreProjectileTracerTailMat';
  tracerTailMat.diffuse = new pc.Color(1.0, 0.92, 0.62);
  tracerTailMat.emissive = new pc.Color(1.0, 0.72, 0.24);
  tracerTailMat.emissiveIntensity = 3.2;
  tracerTailMat.opacity = 0.88;
  tracerTailMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerTailMat.depthWrite = false;
  tracerTailMat.cull = pc.CULLFACE_NONE;

  let floorQuadMesh: pc.Mesh | null = null;
  if (device) {
    floorQuadMesh = buildFloorQuadMesh(device);
    wetBloodDropMat.normalMap = createDropletNormalTexture(device, maxAniso);
    wetBloodDropMat.bumpiness = 0.38;

    const { poolTex } = createBloodPoolTextures(device, maxAniso);
    wetBloodPoolMat.diffuse = new pc.Color(1, 1, 1);
    wetBloodPoolMat.diffuseMap = poolTex;
    wetBloodPoolMat.opacityMap = poolTex;
    wetBloodPoolMat.opacityMapChannel = 'a';

    const mistTex = createBloodMistTexture(device);
    wetBloodMistBaseMat.diffuse = new pc.Color(1, 1, 1);
    wetBloodMistBaseMat.diffuseMap = mistTex;
    wetBloodMistBaseMat.opacityMap = mistTex;
    wetBloodMistBaseMat.opacityMapChannel = 'a';

    const { fleshTex, fleshNormalTex } = createFleshMuscleTextures(device, maxAniso);
    wetFleshGibMat.diffuse = new pc.Color(1, 1, 1);
    wetFleshGibMat.diffuseMap = fleshTex;
    wetFleshGibMat.normalMap = fleshNormalTex;
    wetFleshGibMat.bumpiness = 0.85;
  }

  wetBloodDropMat.update();
  wetBloodPoolMat.update();
  wetBloodMistBaseMat.update();
  wetFleshGibMat.update();
  wetCorticalBoneMat.update();
  wetMarrowCapMat.update();
  incandescentSparkMat.update();
  tracerTailMat.update();

  const suite: WetGoreMaterialSuite = {
    wetBloodDropMat, wetBloodPoolMat, wetBloodMistBaseMat, wetFleshGibMat,
    wetCorticalBoneMat, wetMarrowCapMat, incandescentSparkMat, tracerTailMat, floorQuadMesh,
  };
  if (device) goreSuiteCache.set(device, suite);
  return suite;
}
