import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { SKIN_MATERIAL_PREFIX } from '../assets/combatantFactory.ts';

const bloodyBySkin = new WeakMap<pc.Material, pc.Material>();

/**
 * Picks the material a body zone wears for an archetype, and its blood-soaked twin.
 * Zones ship with the default character's painted skin page; every other archetype swaps in its own page.
 */
export function createArchetypeAndBloodyGlbMaterials(
  srcMat: pc.Material,
  archetype: EnemyArchetypeId,
  skinMaterials: ReadonlyMap<string, pc.Material>,
  engineMats: EngineMaterialPalette
): { intactMat: pc.Material; laceratedMat: pc.Material } {
  const intactMat = srcMat.name.startsWith(SKIN_MATERIAL_PREFIX) ? (skinMaterials.get(archetype) ?? srcMat) : srcMat;
  if (!(intactMat instanceof pc.StandardMaterial)) {
    return { intactMat, laceratedMat: engineMats.goreStumpMat };
  }

  let laceratedMat = bloodyBySkin.get(intactMat);
  if (!laceratedMat) {
    const bloody = intactMat.clone();
    bloody.diffuse.set(0.42, 0.04, 0.05);
    bloody.emissive.set(0.04, 0.004, 0.005);
    bloody.gloss = bloody.glossInvert ? 0.16 : 0.86;
    if (bloody.useMetalness) bloody.metalness = 0.08;
    else bloody.specular.set(0.24, 0.08, 0.08);
    bloody.fresnelModel = pc.FRESNEL_SCHLICK;
    bloody.update();
    laceratedMat = bloody;
    bloodyBySkin.set(intactMat, bloody);
  }
  return { intactMat, laceratedMat };
}
