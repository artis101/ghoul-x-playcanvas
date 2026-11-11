import { GhoulZoneId } from '../../../contracts/ballistics.ts';
import { GhoulZoneNode } from './ghoulHierarchyTypes.ts';
import { GHOUL_HEAD_TORSO_HIERARCHY } from './ghoulHierarchyTorso.ts';
import { GHOUL_LIMB_HIERARCHY } from './ghoulHierarchyLimbs.ts';

/**
 * Kinematic & PBD ragdoll tree for Soldier of Fortune GHOUL dismemberment.
 * Standing height ~1.80m, feet grounded at y = 0, facing +Z.
 */
export const GHOUL_ZONE_HIERARCHY: Record<GhoulZoneId, GhoulZoneNode> = {
  ...GHOUL_HEAD_TORSO_HIERARCHY,
  ...GHOUL_LIMB_HIERARCHY,
};

/**
 * Returns all zones in the kinematic subtree rooted at `zone`, including `zone` itself.
 */
export function getSubtreeZones(zone: GhoulZoneId): GhoulZoneId[] {
  const result: GhoulZoneId[] = [];
  const queue: GhoulZoneId[] = [zone];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    const node = GHOUL_ZONE_HIERARCHY[current];
    if (node && node.children) {
      for (const child of node.children) {
        queue.push(child);
      }
    }
  }
  return result;
}
