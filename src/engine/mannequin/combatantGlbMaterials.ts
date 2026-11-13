import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { SKIN_MATERIAL_PREFIX } from '../assets/combatantFactory.ts';
import { getBloodSoakDetailTexture } from './bloodSoakDetailTexture.ts';

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
    bloody.name = `${intactMat.name}_bloodSoaked`;
    // Keep the painted texture and multiply a blood-soak stain over it, so the part reads as
    // injured cloth and skin instead of being glazed in one glossy red coat.
    const device = intactMat.diffuseMap?.device;
    if (device) {
      bloody.diffuseDetailMap = getBloodSoakDetailTexture(device);
      bloody.diffuseDetailMode = pc.DETAILMODE_MUL;
      bloody.diffuseDetailMapTiling = new pc.Vec2(2, 2);
    } else {
      bloody.diffuse.set(0.36, 0.05, 0.05);
    }
    // Soaked fabric goes slightly darker and only faintly wet; no emissive glow.
    bloody.diffuse.set(bloody.diffuse.r * 0.9, bloody.diffuse.g * 0.86, bloody.diffuse.b * 0.86);
    bloody.emissive.set(0, 0, 0);
    bloody.gloss = bloody.glossInvert ? 0.62 : 0.38;
    if (bloody.useMetalness) bloody.metalness = 0;
    else bloody.specular.set(0.07, 0.04, 0.04);
    bloody.update();
    laceratedMat = bloody;
    bloodyBySkin.set(intactMat, bloody);
  }
  return { intactMat, laceratedMat };
}
