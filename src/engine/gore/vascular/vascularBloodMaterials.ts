import * as pc from 'playcanvas';
import { PHYSIOLOGY_CONSTANTS } from '../../../contracts/physiology.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import { getOrCreateWetBloodMaps } from './vascularBloodMaps.ts';
import type { VascularBloodMaterials } from './vascularBloodTypes.ts';

export function createVascularBloodMaterials(
  palette?: EngineMaterialPalette,
  device?: pc.GraphicsDevice | null
): VascularBloodMaterials {
  const [ar, ag, ab] = PHYSIOLOGY_CONSTANTS.ARTERIAL_CRIMSON_RGB;
  const [vr, vg, vb] = PHYSIOLOGY_CONSTANTS.VENOUS_MAROON_RGB;
  const maps = device ? getOrCreateWetBloodMaps(device) : null;

  const arterialJetMat = new pc.StandardMaterial();
  arterialJetMat.name = 'vascularArterialJetMat';
  arterialJetMat.diffuse = new pc.Color(ar * 0.6, ag * 0.8, ab * 0.6);
  arterialJetMat.emissive = new pc.Color(0.055, 0.002, 0.004);
  arterialJetMat.useMetalness = true;
  arterialJetMat.metalness = 0;
  arterialJetMat.gloss = 0.55;
  arterialJetMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    arterialJetMat.normalMap = maps.dropletNormalMap;
    arterialJetMat.bumpiness = 0.45;
  }
  arterialJetMat.update();

  // Gritty floor blood to match the painted room: dark, mottled, a dull sheen, no clear-coat.
  // The texture is a white mottle mask; this colour carries the hue.
  const arterialPoolMat = new pc.StandardMaterial();
  arterialPoolMat.name = 'vascularArterialPoolMat';
  arterialPoolMat.diffuse = new pc.Color(0.27, 0.035, 0.028);
  arterialPoolMat.useMetalness = true;
  arterialPoolMat.metalness = 0;
  arterialPoolMat.gloss = 0.48;
  arterialPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  arterialPoolMat.opacity = 0.95;
  arterialPoolMat.blendType = pc.BLEND_NORMAL;
  arterialPoolMat.depthWrite = false;
  if (maps) {
    arterialPoolMat.diffuseMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMapChannel = 'a';
  }
  arterialPoolMat.update();

  const venousOozeMat = new pc.StandardMaterial();
  venousOozeMat.name = 'vascularVenousOozeMat';
  venousOozeMat.diffuse = new pc.Color(vr, vg, vb);
  venousOozeMat.emissive = new pc.Color(0.018, 0.0, 0.003);
  venousOozeMat.useMetalness = true;
  venousOozeMat.metalness = 0;
  venousOozeMat.gloss = 0.55;
  venousOozeMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    venousOozeMat.normalMap = maps.dropletNormalMap;
    venousOozeMat.bumpiness = 0.4;
  }
  venousOozeMat.update();

  // Gritty floor blood to match the painted room: dark, mottled, a dull sheen, no clear-coat.
  // The texture is a white mottle mask; this colour carries the hue.
  const venousPoolMat = new pc.StandardMaterial();
  venousPoolMat.name = 'vascularVenousPoolMat';
  venousPoolMat.diffuse = new pc.Color(0.2, 0.028, 0.024);
  venousPoolMat.useMetalness = true;
  venousPoolMat.metalness = 0;
  venousPoolMat.gloss = 0.48;
  venousPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  venousPoolMat.opacity = 0.95;
  venousPoolMat.blendType = pc.BLEND_NORMAL;
  venousPoolMat.depthWrite = false;
  if (maps) {
    venousPoolMat.diffuseMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMapChannel = 'a';
  }
  venousPoolMat.update();

  return { arterialJetMat, arterialPoolMat, venousOozeMat, venousPoolMat };
}
