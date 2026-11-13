import type * as pc from 'playcanvas';
import type { BodyBuildWeights } from '../../core/ghoul/anatomy/archetypeBodyBuild.ts';
import { BODY_BUILD_MORPHS } from '../../core/ghoul/anatomy/archetypeBodyBuild.ts';

/**
 * Sets the body-build morph weights on every body zone of one combatant. Zones share the weights,
 * so the surface stays continuous across the zone cuts.
 */
export function applyCombatantBodyBuild(zoneEntities: Iterable<pc.Entity>, weights: BodyBuildWeights): void {
  for (const zone of zoneEntities) {
    for (const mi of zone.render?.meshInstances ?? []) {
      const morph = mi.morphInstance;
      if (!morph) continue;
      for (const name of BODY_BUILD_MORPHS) {
        // Older GLBs without a target just ignore the name.
        if (morph.morph.targets.some((target) => target.name === name)) morph.setWeight(name, weights[name]);
      }
    }
  }
}
