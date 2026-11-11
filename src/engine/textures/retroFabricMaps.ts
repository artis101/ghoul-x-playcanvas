import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import { createProceduralNormalAndGlossMaps } from './proceduralNormalGloss.ts';

export interface ArchetypeRetroMaterialSet {
  headMat: pc.StandardMaterial;
  headBloodyMat: pc.StandardMaterial;
  jawMat: pc.StandardMaterial;
  jawBloodyMat: pc.StandardMaterial;
  torsoMat: pc.StandardMaterial;
  torsoBloodyMat: pc.StandardMaterial;
  abdomenMat: pc.StandardMaterial;
  abdomenBloodyMat: pc.StandardMaterial;
  pelvisMat: pc.StandardMaterial;
  pelvisBloodyMat: pc.StandardMaterial;
  upperArmMat: pc.StandardMaterial;
  upperArmBloodyMat: pc.StandardMaterial;
  forearmMat: pc.StandardMaterial;
  forearmBloodyMat: pc.StandardMaterial;
  handMat: pc.StandardMaterial;
  legsMat: pc.StandardMaterial;
  legsBloodyMat: pc.StandardMaterial;
  kneePadMat: pc.StandardMaterial;
  bootMat: pc.StandardMaterial;
  headgearMat: pc.StandardMaterial;
  visorMat: pc.StandardMaterial;
  pouchWebbingMat: pc.StandardMaterial;
  weaponMetalMat: pc.StandardMaterial;
  weaponFurnitureMat: pc.StandardMaterial;
}

const cachedArchetypeByDevice = new WeakMap<
  pc.GraphicsDevice,
  Map<EnemyArchetypeId, ArchetypeRetroMaterialSet>
>();

function buildMat(name: string, diff: pc.Color, gloss = 0.3, metal = 0.0): pc.StandardMaterial {
  const m = new pc.StandardMaterial();
  m.name = name;
  m.diffuse = diff;
  m.gloss = gloss;
  m.useMetalness = metal > 0;
  m.metalness = metal;
  m.enableGGXSpecular = true;
  m.fresnelModel = pc.FRESNEL_SCHLICK;
  m.update();
  return m;
}

/**
 * Returns PBR tactical fallback materials for each enemy archetype.
 */
export function getArchetypeRetroMaterials(
  device: pc.GraphicsDevice,
  archetype: EnemyArchetypeId
): ArchetypeRetroMaterialSet {
  let deviceMap = cachedArchetypeByDevice.get(device);
  if (!deviceMap) {
    deviceMap = new Map<EnemyArchetypeId, ArchetypeRetroMaterialSet>();
    cachedArchetypeByDevice.set(device, deviceMap);
  }
  const existing = deviceMap.get(archetype);
  if (existing) return existing;

  const skin = new pc.Color(0.72, 0.55, 0.44);
  const gore = new pc.Color(0.55, 0.08, 0.09);
  const gear = archetype === 'HEAVY_ENFORCER'
    ? new pc.Color(0.18, 0.20, 0.22)
    : archetype === 'SNIPER_OPERATIVE'
      ? new pc.Color(0.28, 0.26, 0.20)
      : new pc.Color(0.24, 0.27, 0.22);
  const dark = new pc.Color(0.12, 0.12, 0.13);
  const metalCol = new pc.Color(0.25, 0.26, 0.28);

  const set: ArchetypeRetroMaterialSet = {
    headMat: buildMat(`${archetype}_head`, skin, 0.36),
    headBloodyMat: buildMat(`${archetype}_head_gore`, gore, 0.84),
    jawMat: buildMat(`${archetype}_jaw`, skin, 0.36),
    jawBloodyMat: buildMat(`${archetype}_jaw_gore`, gore, 0.84),
    torsoMat: buildMat(`${archetype}_torso`, gear, 0.25),
    torsoBloodyMat: buildMat(`${archetype}_torso_gore`, gore, 0.84),
    abdomenMat: buildMat(`${archetype}_abd`, gear, 0.25),
    abdomenBloodyMat: buildMat(`${archetype}_abd_gore`, gore, 0.84),
    pelvisMat: buildMat(`${archetype}_pelvis`, gear, 0.25),
    pelvisBloodyMat: buildMat(`${archetype}_pelvis_gore`, gore, 0.84),
    upperArmMat: buildMat(`${archetype}_uarm`, gear, 0.25),
    upperArmBloodyMat: buildMat(`${archetype}_uarm_gore`, gore, 0.84),
    forearmMat: buildMat(`${archetype}_farm`, gear, 0.25),
    forearmBloodyMat: buildMat(`${archetype}_farm_gore`, gore, 0.84),
    handMat: buildMat(`${archetype}_hand`, skin, 0.34),
    legsMat: buildMat(`${archetype}_legs`, gear, 0.25),
    legsBloodyMat: buildMat(`${archetype}_legs_gore`, gore, 0.84),
    kneePadMat: buildMat(`${archetype}_kneepad`, dark, 0.46),
    bootMat: buildMat(`${archetype}_boot`, dark, 0.42),
    headgearMat: buildMat(`${archetype}_headgear`, gear, 0.34),
    visorMat: buildMat(`${archetype}_visor`, new pc.Color(0.6, 0.5, 0.2), 0.90, 0.65),
    pouchWebbingMat: buildMat(`${archetype}_pouch`, gear, 0.25),
    weaponMetalMat: buildMat(`${archetype}_wmetal`, metalCol, 0.68, 0.85),
    weaponFurnitureMat: buildMat(`${archetype}_wfurn`, new pc.Color(0.4, 0.25, 0.15), 0.38),
  };

  deviceMap.set(archetype, set);
  return set;
}
