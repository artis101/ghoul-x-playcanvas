import * as pc from 'playcanvas';
import type { EnemyArchetypeId, GhoulZoneId } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';

const sharedGlbZoneMatCache = new WeakMap<
  pc.Material,
  Map<string, { intactMat: pc.Material; laceratedMat: pc.Material }>
>();

export function createArchetypeAndBloodyGlbMaterials(
  srcMat: pc.Material,
  zone: GhoulZoneId,
  primIndex: number,
  bareArmMat: pc.Material | null,
  archetype: EnemyArchetypeId,
  engineMats: EngineMaterialPalette
): { intactMat: pc.Material; laceratedMat: pc.Material } {
  let baseSource = srcMat;
  if (
    archetype === 'SKINHEAD_PUNK' &&
    bareArmMat &&
    primIndex === 0 &&
    (zone === 'SHOULDER_LEFT' ||
      zone === 'SHOULDER_RIGHT' ||
      zone === 'UPPER_ARM_LEFT' ||
      zone === 'UPPER_ARM_RIGHT')
  ) {
    baseSource = bareArmMat;
  }

  if (!(baseSource instanceof pc.StandardMaterial)) {
    return { intactMat: baseSource, laceratedMat: engineMats.goreStumpMat };
  }

  const isTorsoShirt = zone === 'TORSO_UPPER_THORAX' || zone === 'TORSO_LOWER_ABDOMEN';
  const isSleeve =
    zone === 'SHOULDER_LEFT' ||
    zone === 'SHOULDER_RIGHT' ||
    zone === 'UPPER_ARM_LEFT' ||
    zone === 'UPPER_ARM_RIGHT';
  const isForearmSkin = zone === 'FOREARM_LEFT' || zone === 'FOREARM_RIGHT';
  const isTrousers =
    zone === 'PELVIS_GROIN' ||
    zone === 'THIGH_LEFT' ||
    zone === 'THIGH_RIGHT' ||
    zone === 'KNEE_LEFT' ||
    zone === 'KNEE_RIGHT' ||
    zone === 'SHIN_LEFT' ||
    zone === 'SHIN_RIGHT';

  const garmentRole =
    primIndex !== 0
      ? 'SECONDARY'
      : isTorsoShirt
        ? 'TORSO'
        : isSleeve
          ? 'SLEEVE'
          : isForearmSkin
            ? 'FOREARM'
            : isTrousers
              ? 'TROUSERS'
              : 'OTHER';
  const cacheKey = `${archetype}_${garmentRole}`;
  let byArchRole = sharedGlbZoneMatCache.get(baseSource);
  if (!byArchRole) {
    byArchRole = new Map();
    sharedGlbZoneMatCache.set(baseSource, byArchRole);
  }
  const cachedPair = byArchRole.get(cacheKey);
  if (cachedPair) return cachedPair;

  const intactClone = baseSource.clone();
  intactClone.fresnelModel = pc.FRESNEL_SCHLICK;
  if (intactClone.normalMap) {
    intactClone.bumpiness = Math.max(intactClone.bumpiness || 1.0, 1.15);
  }

  if (primIndex === 0) {
    if (archetype === 'SKINHEAD_PUNK') {
      if (isTorsoShirt) intactClone.diffuse.set(0.56, 0.56, 0.62);
      else if (isTrousers) intactClone.diffuse.set(0.76, 0.8, 0.86);
    } else if (archetype === 'HEAVY_ENFORCER') {
      if (isTorsoShirt || isSleeve || isTrousers) intactClone.diffuse.set(0.5, 0.58, 0.72);
      else if (isForearmSkin) {
        intactClone.diffuseMap = null;
        intactClone.diffuse.set(0.14, 0.17, 0.22);
      }
    } else if (archetype === 'SNIPER_OPERATIVE') {
      if (isTorsoShirt || isSleeve) intactClone.diffuse.set(0.92, 0.96, 1.02);
      else if (isTrousers) intactClone.diffuse.set(0.88, 0.85, 0.72);
    }
  }
  intactClone.update();

  const bloodyClone = intactClone.clone();
  bloodyClone.diffuse.set(0.42, 0.04, 0.05);
  bloodyClone.emissive.set(0.04, 0.004, 0.005);
  bloodyClone.gloss = bloodyClone.glossInvert ? 0.16 : 0.86;
  if (bloodyClone.useMetalness) bloodyClone.metalness = 0.08;
  else bloodyClone.specular.set(0.24, 0.08, 0.08);
  bloodyClone.fresnelModel = pc.FRESNEL_SCHLICK;
  bloodyClone.update();

  const pair = { intactMat: intactClone, laceratedMat: bloodyClone };
  byArchRole.set(cacheKey, pair);
  return pair;
}
