import type { GhoulZoneId, WeaponSpec, WoundChannelEvent } from '../../../contracts/ballistics.ts';
import { GHOUL_ZONE_HIERARCHY } from '../../ghoul/anatomy.ts';

/**
 * A sniper round carrying this much energy into a limb takes it off: 7.62 NATO (~3.7 kJ) does not
 * qualify, .50 BMG (~16 kJ at the muzzle, well above this out to arena ranges) always does.
 */
export const ANTI_MATERIEL_SEVER_ENERGY_J = 6000;

/** Zones a direct anti-materiel hit removes. Torso and pelvis stay on; a lower-belly hit eviscerates. */
const SEVERABLE_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'HEAD_CRANIUM',
  'HEAD_FACE_JAW',
  'NECK_CERVICAL',
  'TORSO_LOWER_ABDOMEN',
  'UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT',
  'UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT',
  'THIGH_RIGHT', 'KNEE_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT',
  'THIGH_LEFT', 'KNEE_LEFT', 'SHIN_LEFT', 'FOOT_LEFT',
]);

/** A hit through the shoulder tears the whole arm off there. */
const REDIRECTED_ZONES: Partial<Record<GhoulZoneId, GhoulZoneId>> = {
  SHOULDER_RIGHT: 'UPPER_ARM_RIGHT',
  SHOULDER_LEFT: 'UPPER_ARM_LEFT',
};

function hasAncestorIn(zone: GhoulZoneId, zones: ReadonlySet<GhoulZoneId>): boolean {
  let parent = GHOUL_ZONE_HIERARCHY[zone].parent;
  while (parent) {
    if (zones.has(parent)) return true;
    parent = GHOUL_ZONE_HIERARCHY[parent].parent;
  }
  return false;
}

/**
 * Zones a sniper's anti-materiel round crossed with enough energy to remove. Where the bullet crossed
 * several zones of one limb, only the one closest to the body is kept, so the limb comes off once.
 */
export function collectAntiMaterielSeverZones(
  weapon: WeaponSpec,
  woundEvents: readonly WoundChannelEvent[]
): Set<GhoulZoneId> {
  const zones = new Set<GhoulZoneId>();
  if (weapon.role !== 'SNIPER') return zones;
  for (const we of woundEvents) {
    if (we.armorStopped || we.entryEnergyJ < ANTI_MATERIEL_SEVER_ENERGY_J) continue;
    const zone = REDIRECTED_ZONES[we.ghoulZone] ?? we.ghoulZone;
    if (SEVERABLE_ZONES.has(zone)) zones.add(zone);
  }
  for (const zone of [...zones]) {
    if (hasAncestorIn(zone, zones)) zones.delete(zone);
  }
  return zones;
}
