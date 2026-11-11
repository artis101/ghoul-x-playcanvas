import * as pc from 'playcanvas';
import {
  createShockwaveRingTexture,
  createSoftCloudTexture,
} from '../materials/transientFxMaterials.ts';
import type { ExplosionTemplateMaterials } from './explosionTypes.ts';

export function createExplosionTemplateMaterials(
  device: pc.GraphicsDevice,
): ExplosionTemplateMaterials {
  const dustCloudTex = createSoftCloudTexture(device, 'mayhemDustPlumeTex', 3109);
  const smokeCloudTex = createSoftCloudTexture(device, 'mayhemDarkSmokeTex', 4211);
  const shockRingTex = createShockwaveRingTexture(device);

  const dustPlumeTemplateMat = new pc.StandardMaterial();
  dustPlumeTemplateMat.name = 'mayhemConcreteDustPlumeMat';
  dustPlumeTemplateMat.diffuse = new pc.Color(0.66, 0.64, 0.6);
  dustPlumeTemplateMat.emissive = new pc.Color(0.08, 0.075, 0.07);
  dustPlumeTemplateMat.opacity = 0.52;
  dustPlumeTemplateMat.opacityMap = dustCloudTex;
  dustPlumeTemplateMat.opacityMapChannel = 'a';
  dustPlumeTemplateMat.blendType = pc.BLEND_NORMAL;
  dustPlumeTemplateMat.depthWrite = false;
  dustPlumeTemplateMat.cull = pc.CULLFACE_NONE;
  dustPlumeTemplateMat.update();

  const brickDustTemplateMat = dustPlumeTemplateMat.clone();
  brickDustTemplateMat.name = 'mayhemBrickDustPlumeMat';
  brickDustTemplateMat.diffuse = new pc.Color(0.64, 0.44, 0.36);
  brickDustTemplateMat.update();

  const woodDustTemplateMat = dustPlumeTemplateMat.clone();
  woodDustTemplateMat.name = 'mayhemWoodDustPlumeMat';
  woodDustTemplateMat.diffuse = new pc.Color(0.68, 0.56, 0.38);
  woodDustTemplateMat.update();

  const metalDustTemplateMat = dustPlumeTemplateMat.clone();
  metalDustTemplateMat.name = 'mayhemMetalDustPlumeMat';
  metalDustTemplateMat.diffuse = new pc.Color(0.52, 0.54, 0.58);
  metalDustTemplateMat.opacity = 0.32;
  metalDustTemplateMat.update();

  const darkSmokeTemplateMat = new pc.StandardMaterial();
  darkSmokeTemplateMat.name = 'mayhemDetonationSmokeMat';
  darkSmokeTemplateMat.diffuse = new pc.Color(0.11, 0.1, 0.1);
  darkSmokeTemplateMat.emissive = new pc.Color(0.03, 0.015, 0.008);
  darkSmokeTemplateMat.opacity = 0.72;
  darkSmokeTemplateMat.opacityMap = smokeCloudTex;
  darkSmokeTemplateMat.opacityMapChannel = 'a';
  darkSmokeTemplateMat.blendType = pc.BLEND_NORMAL;
  darkSmokeTemplateMat.depthWrite = false;
  darkSmokeTemplateMat.cull = pc.CULLFACE_NONE;
  darkSmokeTemplateMat.update();

  const shockwaveRingTemplateMat = new pc.StandardMaterial();
  shockwaveRingTemplateMat.name = 'mayhemGroundShockwaveRingMat';
  shockwaveRingTemplateMat.diffuse = new pc.Color(1.0, 0.85, 0.58);
  shockwaveRingTemplateMat.emissive = new pc.Color(1.0, 0.68, 0.28);
  shockwaveRingTemplateMat.emissiveIntensity = 2.4;
  shockwaveRingTemplateMat.opacity = 0.86;
  shockwaveRingTemplateMat.opacityMap = shockRingTex;
  shockwaveRingTemplateMat.opacityMapChannel = 'a';
  shockwaveRingTemplateMat.blendType = pc.BLEND_ADDITIVEALPHA;
  shockwaveRingTemplateMat.depthWrite = false;
  shockwaveRingTemplateMat.cull = pc.CULLFACE_NONE;
  shockwaveRingTemplateMat.update();

  const flashCoreTemplateMat = new pc.StandardMaterial();
  flashCoreTemplateMat.name = 'mayhemBlindingFlashCoreMat';
  flashCoreTemplateMat.diffuse = new pc.Color(1.0, 0.96, 0.82);
  flashCoreTemplateMat.emissive = new pc.Color(1.0, 0.9, 0.62);
  flashCoreTemplateMat.emissiveIntensity = 5.5;
  flashCoreTemplateMat.opacity = 0.96;
  flashCoreTemplateMat.blendType = pc.BLEND_ADDITIVEALPHA;
  flashCoreTemplateMat.depthWrite = false;
  flashCoreTemplateMat.update();

  const fireballLobeTemplateMat = new pc.StandardMaterial();
  fireballLobeTemplateMat.name = 'mayhemFireballLobeSharedMat';
  fireballLobeTemplateMat.diffuse = new pc.Color(1.0, 0.86, 0.45);
  fireballLobeTemplateMat.emissive = new pc.Color(1.0, 0.72, 0.24);
  fireballLobeTemplateMat.emissiveIntensity = 1.0;
  fireballLobeTemplateMat.opacity = 0.94;
  fireballLobeTemplateMat.blendType = pc.BLEND_NORMAL;
  fireballLobeTemplateMat.depthWrite = false;
  fireballLobeTemplateMat.update();

  return {
    dustPlumeTemplateMat,
    brickDustTemplateMat,
    woodDustTemplateMat,
    metalDustTemplateMat,
    darkSmokeTemplateMat,
    shockwaveRingTemplateMat,
    flashCoreTemplateMat,
    fireballLobeTemplateMat,
  };
}

export function destroyExplosionTemplateMaterials(templates: ExplosionTemplateMaterials): void {
  templates.dustPlumeTemplateMat.destroy();
  templates.brickDustTemplateMat.destroy();
  templates.woodDustTemplateMat.destroy();
  templates.metalDustTemplateMat.destroy();
  templates.darkSmokeTemplateMat.destroy();
  templates.shockwaveRingTemplateMat.destroy();
  templates.flashCoreTemplateMat.destroy();
  templates.fireballLobeTemplateMat.destroy();
}
