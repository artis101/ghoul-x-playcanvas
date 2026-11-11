import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { ActiveFiringHand, EnemyAimProfile, EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import {
  ARCHETYPE_TUNING,
  DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
  MIN_CONSCIOUSNESS_TO_FIGHT,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
  SIDEARM_M9_TUNING,
} from './archetypeTuning.ts';
import {
  getPreferredPrimaryHand,
  isArmChainIntactAndFunctional,
  resolveDefaultCombatantProfile,
  selectIntactFiringHand,
} from './combatantArmEvaluation.ts';

export function computeEnemyAimProfile(
  target: TargetHealthState,
  agent?: EnemyAiAgentRuntime,
  externalAccuracyMultiplier?: number
): EnemyAimProfile {
  const tuning = ARCHETYPE_TUNING[target.archetype];

  if (!target.alive || target.currentHp <= 0 || target.consciousness <= MIN_CONSCIOUSNESS_TO_FIGHT) {
    return {
      baseSpreadRad: tuning.baseSpreadRad,
      spreadMultiplier: 10.0,
      effectiveSpreadRad: tuning.baseSpreadRad * 10.0,
      aimAccuracyMultiplier: 0,
      canReturnFire: false,
      isOneHandedDownedFire: false,
      clutchingWound: false,
      usingBackupSidearm: false,
      sidearmDrawing: false,
      activeFiringHand: null,
    };
  }

  if (target.isRagdollActive && target.posture === 'AIRBORNE_RAGDOLL') {
    return {
      baseSpreadRad: tuning.baseSpreadRad,
      spreadMultiplier: 9.0,
      effectiveSpreadRad: tuning.baseSpreadRad * 9.0,
      aimAccuracyMultiplier: 0.08,
      canReturnFire: false,
      isOneHandedDownedFire: false,
      clutchingWound: false,
      usingBackupSidearm: false,
      sidearmDrawing: false,
      activeFiringHand: null,
    };
  }

  const leftIntact = isArmChainIntactAndFunctional(target, 'LEFT');
  const rightIntact = isArmChainIntactAndFunctional(target, 'RIGHT');
  const bothArmsLost = !leftIntact && !rightIntact;
  const anyArmLost = !leftIntact || !rightIntact;

  if (bothArmsLost) {
    return {
      baseSpreadRad: tuning.baseSpreadRad,
      spreadMultiplier: 8.5,
      effectiveSpreadRad: tuning.baseSpreadRad * 8.5,
      aimAccuracyMultiplier: 0.08,
      canReturnFire: false,
      isOneHandedDownedFire: false,
      clutchingWound: true,
      usingBackupSidearm: false,
      sidearmDrawing: false,
      activeFiringHand: null,
    };
  }

  const preferredHand = getPreferredPrimaryHand(target);
  const intactHand = selectIntactFiringHand(target, agent?.activeFiringHand ?? preferredHand);

  const sidearmActive =
    agent !== undefined &&
    agent.sidearmActive &&
    intactHand !== null &&
    isArmChainIntactAndFunctional(target, agent.activeFiringHand);
  const sidearmDrawing =
    agent !== undefined && agent.sidearmDrawing && !sidearmActive && intactHand !== null;

  const groundedWithUnbrokenArms =
    target.isRagdollActive &&
    target.posture !== 'AIRBORNE_RAGDOLL' &&
    !target.primaryArmDisarmed &&
    intactHand !== null;

  const primaryWeaponUsable =
    !anyArmLost && !target.primaryArmDisarmed && (!target.weaponDropped || groundedWithUnbrokenArms);

  if (!primaryWeaponUsable && !sidearmActive) {
    if (sidearmDrawing) {
      return {
        baseSpreadRad: SIDEARM_M9_TUNING.baseSpreadRad,
        spreadMultiplier: OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
        effectiveSpreadRad: SIDEARM_M9_TUNING.baseSpreadRad * OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
        aimAccuracyMultiplier: 1.0 / OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
        canReturnFire: false,
        isOneHandedDownedFire: !target.leftLegFunctional || !target.rightLegFunctional,
        clutchingWound: false,
        usingBackupSidearm: false,
        sidearmDrawing: true,
        activeFiringHand: agent?.activeFiringHand ?? intactHand,
      };
    }

    return {
      baseSpreadRad: tuning.baseSpreadRad,
      spreadMultiplier: 8.5,
      effectiveSpreadRad: tuning.baseSpreadRad * 8.5,
      aimAccuracyMultiplier: 0.08,
      canReturnFire: false,
      isOneHandedDownedFire: false,
      clutchingWound: true,
      usingBackupSidearm: false,
      sidearmDrawing: false,
      activeFiringHand: null,
    };
  }

  const inNeurogenicOrStagger =
    agent !== undefined && (agent.neurogenicShockTimerS > 0 || agent.state === 'SUPPRESSED_STAGGERED');

  const resolveProfile =
    agent?.resolveProfile ??
    target.resolveProfile ??
    resolveDefaultCombatantProfile(target.targetId, target.archetype).resolveProfile;
  const triage = computeCombatantTriageStatus(target);

  const legCrippled =
    !target.leftLegFunctional || !target.rightLegFunctional || target.isRagdollActive || agent?.state === 'DOWNED_CRAWLING';

  const baseSpreadRad = sidearmActive ? SIDEARM_M9_TUNING.baseSpreadRad : tuning.baseSpreadRad;
  let spreadMultiplier = 1.0;

  if (legCrippled) spreadMultiplier *= DOWNED_ONE_HANDED_SPREAD_MULTIPLIER;
  if (sidearmActive || anyArmLost) spreadMultiplier *= OFFHAND_SIDEARM_SPREAD_MULTIPLIER;

  const painMitigationFactor =
    resolveProfile === 'HARDENED_VETERAN' ? 0.62 : resolveProfile === 'FANATIC_BERSERKER' ? 0.55 : 0.35;
  const adrenalineVal = agent ? agent.adrenaline : resolveProfile === 'HARDENED_VETERAN' ? 0.85 : 0;
  const effectiveShock = Math.max(0, target.painShock - adrenalineVal * painMitigationFactor);
  spreadMultiplier *= 1.0 + effectiveShock * 2.2;

  if (target.rupturedOrgans.size > 0 || triage === 'MORTALLY_WOUNDED') {
    const organPenalty =
      resolveProfile === 'HARDENED_VETERAN'
        ? 1.38 + Math.min(0.75, target.rupturedOrgans.size * 0.28)
        : 1.55 + Math.min(0.95, target.rupturedOrgans.size * 0.35);
    spreadMultiplier *= organPenalty;
  }

  if (target.systolicBpMmHg < 105) spreadMultiplier *= 1.0 + ((105 - target.systolicBpMmHg) / 45) * 2.0;
  if (target.oxygenSaturationPct < 94) spreadMultiplier *= 1.0 + ((94 - target.oxygenSaturationPct) / 25) * 1.9;
  if (target.consciousness < 0.9) spreadMultiplier *= 1.0 + (0.9 - target.consciousness) * 2.5;

  if (
    resolveProfile === 'PANICKED_SCRAPPER' &&
    (target.currentHp < target.maxHp * 0.8 || target.painShock > 0.22 || (agent?.suppression ?? 0) > 0.45)
  ) {
    spreadMultiplier *= 1.32;
  }

  if (externalAccuracyMultiplier !== undefined && externalAccuracyMultiplier > 0) {
    spreadMultiplier *= 1 / Math.max(0.08, Math.min(1.0, externalAccuracyMultiplier));
  }

  if (agent?.isOffScreen) {
    spreadMultiplier *= 4.0; // 0.25x off-screen accuracy nerf
  }

  const aimAccuracyMultiplier = Math.max(0.08, Math.min(1.0, 1.0 / spreadMultiplier));
  const activeHand: ActiveFiringHand = sidearmActive
    ? agent!.activeFiringHand
    : intactHand ?? preferredHand;

  return {
    baseSpreadRad,
    spreadMultiplier,
    effectiveSpreadRad: baseSpreadRad * spreadMultiplier,
    aimAccuracyMultiplier,
    canReturnFire: !inNeurogenicOrStagger && agent?.state !== 'PATROL_GUARD',
    isOneHandedDownedFire: legCrippled,
    clutchingWound: false,
    usingBackupSidearm: sidearmActive,
    sidearmDrawing: false,
    activeFiringHand: activeHand,
  };
}
