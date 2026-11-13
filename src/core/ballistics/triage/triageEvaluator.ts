import { TargetHealthState } from '../../../contracts/ballistics.ts';
import { RED_HEALTH_HP_FRACTION } from '../../../contracts/combatantHealthBands.ts';

/**
 * Organs whose rupture alone means dying without surgery. A punctured lung or gut is serious but
 * survivable in the short run, so it reads as wounded unless the bleeding says otherwise.
 * Matches both the shot solver's collider labels and the physiology march's organ ids.
 */
const VITAL_ORGAN_MARKERS = ['HEART', 'BRAIN', 'LIVER', 'AORTA', 'CAROTID'];

function isVitalOrgan(organ: string): boolean {
  const upper = organ.toUpperCase();
  return VITAL_ORGAN_MARKERS.some((m) => upper.includes(m));
}

export type CombatantTriageStatus = 'HEALTHY' | 'WOUNDED' | 'MORTALLY_WOUNDED' | 'DEAD';

/**
 * Classifies a combatant's physiological & structural medical triage state:
 * - HEALTHY: Uninjured & combat-ready
 * - WOUNDED: Injured / crippled / downed on ground, but stable enough to survive short-term
 * - MORTALLY_WOUNDED: Critical HP, major arterial/organ hemorrhage, or major amputation — actively dying
 * - DEAD: Deceased (zero muscle tone)
 */
export function computeCombatantTriageStatus(target: TargetHealthState): CombatantTriageStatus {
  if (!target.alive || target.currentHp <= 0) {
    return 'DEAD';
  }

  const hpRatio = target.currentHp / Math.max(1, target.maxHp);
  const hasMajorAmputation =
    target.severedZones.has('THIGH_RIGHT') ||
    target.severedZones.has('THIGH_LEFT') ||
    target.severedZones.has('KNEE_RIGHT') ||
    target.severedZones.has('KNEE_LEFT') ||
    target.severedZones.has('SHIN_RIGHT') ||
    target.severedZones.has('SHIN_LEFT') ||
    target.severedZones.has('UPPER_ARM_RIGHT') ||
    target.severedZones.has('UPPER_ARM_LEFT');

  if (
    hpRatio <= RED_HEALTH_HP_FRACTION ||
    target.bloodVolumeMl <= 3550 ||
    target.bloodLossRateMlPerSec >= 24 ||
    [...target.rupturedOrgans].some(isVitalOrgan) ||
    hasMajorAmputation
  ) {
    return 'MORTALLY_WOUNDED';
  }

  const isAnyWound =
    hpRatio < 0.98 ||
    target.bloodLossRateMlPerSec > 0.5 ||
    target.severedZones.size > 0 ||
    target.fracturedBones.size > 0 ||
    !target.rightLegFunctional ||
    !target.leftLegFunctional ||
    !target.rightArmFunctional ||
    !target.leftArmFunctional ||
    target.rupturedOrgans.size > 0 ||
    target.surfaceWounds.some((sw) => !sw.armorDent);

  return isAnyWound ? 'WOUNDED' : 'HEALTHY';
}
