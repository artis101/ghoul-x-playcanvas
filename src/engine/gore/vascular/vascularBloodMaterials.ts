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
  arterialJetMat.diffuse = new pc.Color(ar, ag, ab);
  arterialJetMat.emissive = new pc.Color(0.055, 0.002, 0.004);
  arterialJetMat.useMetalness = true;
  arterialJetMat.metalness = 0.09;
  arterialJetMat.gloss = palette ? Math.max(0.88, (palette.bloodDropMat.shininess || 88) / 100) : 0.9;
  arterialJetMat.clearCoat = 0.86;
  arterialJetMat.clearCoatGloss = 0.95;
  arterialJetMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    arterialJetMat.normalMap = maps.dropletNormalMap;
    arterialJetMat.bumpiness = 0.45;
  }
  arterialJetMat.update();

  const arterialPoolMat = new pc.StandardMaterial();
  arterialPoolMat.name = 'vascularArterialPoolMat';
  arterialPoolMat.diffuse = maps ? new pc.Color(0.88, 0.82, 0.82) : new pc.Color(ar * 0.48, ag * 0.35, ab * 0.38);
  arterialPoolMat.emissive = new pc.Color(0.025, 0.001, 0.002);
  arterialPoolMat.useMetalness = true;
  arterialPoolMat.metalness = 0.12;
  arterialPoolMat.gloss = palette ? Math.max(0.91, (palette.bloodPoolMat.shininess || 90) / 100) : 0.92;
  arterialPoolMat.clearCoat = 0.92;
  arterialPoolMat.clearCoatGloss = 0.96;
  arterialPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  arterialPoolMat.opacity = 0.94;
  arterialPoolMat.blendType = pc.BLEND_NORMAL;
  arterialPoolMat.depthWrite = false;
  if (maps) {
    arterialPoolMat.diffuseMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMap = maps.poolAlbedoAlphaArterial;
    arterialPoolMat.opacityMapChannel = 'a';
    arterialPoolMat.normalMap = maps.poolMeniscusNormalMap;
    arterialPoolMat.bumpiness = 1.15;
  }
  arterialPoolMat.update();

  const venousOozeMat = new pc.StandardMaterial();
  venousOozeMat.name = 'vascularVenousOozeMat';
  venousOozeMat.diffuse = new pc.Color(vr, vg, vb);
  venousOozeMat.emissive = new pc.Color(0.018, 0.0, 0.003);
  venousOozeMat.useMetalness = true;
  venousOozeMat.metalness = 0.1;
  venousOozeMat.gloss = 0.88;
  venousOozeMat.clearCoat = 0.84;
  venousOozeMat.clearCoatGloss = 0.94;
  venousOozeMat.fresnelModel = pc.FRESNEL_SCHLICK;
  if (maps) {
    venousOozeMat.normalMap = maps.dropletNormalMap;
    venousOozeMat.bumpiness = 0.4;
  }
  venousOozeMat.update();

  const venousPoolMat = new pc.StandardMaterial();
  venousPoolMat.name = 'vascularVenousPoolMat';
  venousPoolMat.diffuse = maps ? new pc.Color(0.84, 0.8, 0.82) : new pc.Color(vr * 0.68, vg * 0.6, vb * 0.68);
  venousPoolMat.emissive = new pc.Color(0.012, 0.0, 0.002);
  venousPoolMat.useMetalness = true;
  venousPoolMat.metalness = 0.13;
  venousPoolMat.gloss = palette ? Math.max(0.92, (palette.bloodPoolMat.shininess || 90) / 100) : 0.94;
  venousPoolMat.clearCoat = 0.94;
  venousPoolMat.clearCoatGloss = 0.97;
  venousPoolMat.fresnelModel = pc.FRESNEL_SCHLICK;
  venousPoolMat.opacity = 0.95;
  venousPoolMat.blendType = pc.BLEND_NORMAL;
  venousPoolMat.depthWrite = false;
  if (maps) {
    venousPoolMat.diffuseMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMap = maps.poolAlbedoAlphaVenous;
    venousPoolMat.opacityMapChannel = 'a';
    venousPoolMat.normalMap = maps.poolMeniscusNormalMap;
    venousPoolMat.bumpiness = 1.2;
  }
  venousPoolMat.update();

  return { arterialJetMat, arterialPoolMat, venousOozeMat, venousPoolMat };
}
