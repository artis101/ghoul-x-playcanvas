import * as pc from 'playcanvas';
import type { TargetHealthState, GhoulZoneId } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { GlbZoneMaterialPair } from './types.ts';
import { createArchetypeAndBloodyGlbMaterials } from './combatantGlbMaterials.ts';

const sharedSwatGearMatCache = new WeakMap<pc.Material, pc.StandardMaterial>();

export function setupCombatantGlbInstance(
  glbRegistry: GlbModelRegistry,
  healthState: TargetHealthState,
  materials: EngineMaterialPalette,
  glbZoneMaterialPairs: Map<GhoulZoneId, GlbZoneMaterialPair[]>,
  glbGearOriginalMaterials: Map<pc.MeshInstance, pc.Material>
): CombatantGlbInstance | null {
  if (!glbRegistry.isLoaded('ghoul_combatant')) return null;

  try {
    const inst = glbRegistry.instantiateCombatant({
      castShadows: true,
      receiveShadows: true,
      initialClip: 'CombatReadyIdle',
      southpaw: healthState.isLeftHanded,
    });

    const forearmSampleMat =
      inst.zoneEntities.get('FOREARM_LEFT')?.render?.meshInstances?.[0]?.material ?? null;

    for (const [zone, zEnt] of inst.zoneEntities) {
      if (!zEnt.render) continue;
      const pairs: GlbZoneMaterialPair[] = [];
      zEnt.render.meshInstances.forEach((mi, idx) => {
        const orig = mi.material;
        if (orig) {
          const { intactMat, laceratedMat } = createArchetypeAndBloodyGlbMaterials(
            orig,
            zone,
            idx,
            forearmSampleMat,
            healthState.archetype,
            materials
          );
          mi.material = intactMat;
          pairs.push({ meshInstance: mi, intactMat, laceratedMat });
        }
      });
      glbZoneMaterialPairs.set(zone, pairs);
    }

    const gearList = [
      inst.esapiPlateCarrier,
      inst.pasgtHelmet,
      inst.tacticalVisor,
      inst.spetsnazBeret,
      inst.punkMohawk,
      inst.evisceratedGut,
    ];

    for (const gearEnt of gearList) {
      if (!gearEnt?.render) continue;
      for (const mi of gearEnt.render.meshInstances) {
        if (!mi.material) continue;
        let gearMat = mi.material;
        if (
          healthState.archetype === 'HEAVY_ENFORCER' &&
          (gearEnt === inst.pasgtHelmet || gearEnt === inst.esapiPlateCarrier) &&
          gearMat instanceof pc.StandardMaterial
        ) {
          let swatGear = sharedSwatGearMatCache.get(gearMat);
          if (!swatGear) {
            swatGear = gearMat.clone();
            swatGear.diffuse.set(0.55, 0.62, 0.72);
            swatGear.update();
            sharedSwatGearMatCache.set(gearMat, swatGear);
          }
          mi.material = swatGear;
          gearMat = swatGear;
        }
        glbGearOriginalMaterials.set(mi, gearMat);
      }
    }

    return inst;
  } catch {
    return null;
  }
}
