import {
  AmmoSpec,
  DismembermentEvent,
  GhoulZoneId,
  RagdollActivationPlan,
  TargetHealthState,
  Vec3Like,
  WeaponSpec,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { add, length, scale, vec3 } from '../vec3.ts';
import { isLimbLossFatal } from '../trauma/limbLossDeathRule.ts';
import type { DelayedLethality } from '../../../contracts/combatantConstitution.ts';
import { borrowedTimeHp, rollDelayedLethality } from './lethalityRoll.ts';
import { weakEnoughForKnockdown } from './archetypeToughness.ts';
import { isSeatedAnimated } from '../triage/seatedLastStand.ts';
import { KNOCKDOWN_IMPULSE_NS } from '../lifecycle/deathAnimation.ts';

export function evaluateLethalityAndRagdollPlan(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  target: TargetHealthState,
  targetDistanceM: number,
  normAimDir: Vec3Like,
  hasHitTarget: boolean,
  primaryHitZone: GhoulZoneId | null,
  firstImpactTime: number,
  totalEnergyDepositedJ: number,
  initialDamageHp: number,
  allWoundEvents: WoundChannelEvent[],
  dismembermentEvents: DismembermentEvent[],
  severedZonesSet: ReadonlySet<GhoulZoneId>,
  shatteredBonesSet: ReadonlySet<string>,
  rupturedOrgansSet: ReadonlySet<string>,
  zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>>,
  netRootImpulseWorld: Vec3Like,
  netTorqueWorld: Vec3Like
): {
  totalDamageHp: number;
  isLethalKill: boolean;
  delayedLethality: DelayedLethality | null;
  ragdollPlan: RagdollActivationPlan;
} {
  let totalDamageHp = initialDamageHp;

  const heartRuptured = rupturedOrgansSet.has('Heart (Myocardium & Ventricles)');
  if (heartRuptured) {
    totalDamageHp += 68.0;
  }

  const isLimbZone = (z: GhoulZoneId): boolean =>
    z === 'SHOULDER_RIGHT' || z === 'UPPER_ARM_RIGHT' || z === 'FOREARM_RIGHT' || z === 'HAND_RIGHT' ||
    z === 'SHOULDER_LEFT' || z === 'UPPER_ARM_LEFT' || z === 'FOREARM_LEFT' || z === 'HAND_LEFT' ||
    z === 'THIGH_RIGHT' || z === 'KNEE_RIGHT' || z === 'SHIN_RIGHT' || z === 'FOOT_RIGHT' ||
    z === 'THIGH_LEFT' || z === 'KNEE_LEFT' || z === 'SHIN_LEFT' || z === 'FOOT_LEFT';

  const isPureLimbShot =
    hasHitTarget &&
    allWoundEvents.length > 0 &&
    allWoundEvents.every((w) => isLimbZone(w.ghoulZone));

  if (isPureLimbShot && target.currentHp > 32.0) {
    totalDamageHp = Math.min(totalDamageHp, Math.min(52.0, target.currentHp - 25.0));
  }

  const closeRangeCutoffM = weapon.role === 'SHOTGUN' ? 6.5 : 3.8;
  if (hasHitTarget && targetDistanceM < closeRangeCutoffM) {
    const closeFactor = Math.pow(Math.max(0, 1.0 - targetDistanceM / closeRangeCutoffM), 1.45);
    const roleBlastScale = weapon.role === 'SHOTGUN' ? 0.19 : 0.09;
    const closeBlastNs =
      totalEnergyDepositedJ * roleBlastScale * closeFactor * ammo.ragdollImpulseMultiplier;
    const blastVec = scale(normAimDir, closeBlastNs);
    netRootImpulseWorld = add(netRootImpulseWorld, blastVec);
    if (primaryHitZone) {
      zoneImpulses[primaryHitZone] = add(zoneImpulses[primaryHitZone] || vec3(0, 0, 0), blastVec);
    }
  }

  const isCranialExploded = dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP');
  const isNeckSevered = dismembermentEvents.some((d) => d.zone === 'NECK_CERVICAL');
  const isGutEviscerated = dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED');
  const isPelvisShattered = allWoundEvents.some(
    (w) => w.boneFractured && w.ghoulZone === 'PELVIS_GROIN'
  );
  const isCnsDestroyed =
    rupturedOrgansSet.has('Brain (Cerebrum & Brainstem)') ||
    shatteredBonesSet.has('Cervical Spine (C1-C7)');

  // A second lost limb kills even from a pure limb shot, unless it leaves one arm and one leg.
  const isFatalLimbLoss =
    hasHitTarget && dismembermentEvents.length > 0 && isLimbLossFatal(severedZonesSet);

  const isInstantKill =
    hasHitTarget &&
    (isFatalLimbLoss ||
      (!isPureLimbShot && (isCranialExploded || isNeckSevered || isGutEviscerated || isCnsDestroyed)));
  const isTraumaKill = hasHitTarget && !isPureLimbShot && totalDamageHp >= target.currentHp;

  // A kill through accumulated trauma may take a few seconds to land; the combatant fights on meanwhile.
  let delayedLethality: DelayedLethality | null = null;
  if (isTraumaKill && !isInstantKill && target.alive) {
    delayedLethality = rollDelayedLethality({
      target,
      overkillRatio: 1 + (totalDamageHp - target.currentHp) / Math.max(1, target.maxHp),
      heartRuptured,
    });
    if (delayedLethality) {
      totalDamageHp = Math.max(0, target.currentHp - borrowedTimeHp(target));
    }
  }

  const isLethalKill = isInstantKill || (isTraumaKill && delayedLethality === null);

  const rightLegSeveredAfter =
    severedZonesSet.has('THIGH_RIGHT') ||
    severedZonesSet.has('KNEE_RIGHT') ||
    severedZonesSet.has('SHIN_RIGHT') ||
    severedZonesSet.has('FOOT_RIGHT');
  const leftLegSeveredAfter =
    severedZonesSet.has('THIGH_LEFT') ||
    severedZonesSet.has('KNEE_LEFT') ||
    severedZonesSet.has('SHIN_LEFT') ||
    severedZonesSet.has('FOOT_LEFT');
  const bothLegsSevered = rightLegSeveredAfter && leftLegSeveredAfter;

  const bodyMassKg = 82.0;
  const horizontalImpulseMag = length(vec3(netRootImpulseWorld.x, 0, netRootImpulseWorld.z));

  // A shove or a broken pelvis only puts a body on the floor once it is spent: a healthy tough guy
  // rocks under a close blast and keeps standing, and a high-HP pelvis fracture plays the leg-buckle
  // fall instead (reactionAgonyApplicator). A body already sitting in its last stand is past being
  // knocked down; only a kill moves it. Both legs gone is fatal anyway.
  const weakEnough = !isSeatedAnimated(target) && weakEnoughForKnockdown(target, target.currentHp - totalDamageHp);
  const isImmediateKnockdown =
    hasHitTarget &&
    (bothLegsSevered ||
      (weakEnough && (isPelvisShattered || (!isPureLimbShot && horizontalImpulseMag >= KNOCKDOWN_IMPULSE_NS))));

  const willEnableRagdoll = target.isRagdollActive || isLethalKill || isImmediateKnockdown;

  let launchLiftVelocityMs = 0;
  let estimatedLaunchDistanceM = 0;

  if (willEnableRagdoll && hasHitTarget) {
    launchLiftVelocityMs =
      horizontalImpulseMag > 110.0
        ? Math.min(1.15, (horizontalImpulseMag - 110.0) / 340.0)
        : 0.0;
    const horizSpeed = Math.min(5.6, horizontalImpulseMag / bodyMassKg);
    estimatedLaunchDistanceM = Math.min(3.8, horizSpeed * 0.62);
  }

  const ragdollPlan: RagdollActivationPlan = {
    willEnableRagdoll,
    activationTimeS: firstImpactTime,
    primaryHitZone,
    netRootImpulseWorld,
    launchLiftVelocityMs,
    estimatedLaunchDistanceM,
    zoneImpulses,
    netTorqueWorld,
    dismembermentEvents,
  };

  return { totalDamageHp, isLethalKill, delayedLethality, ragdollPlan };
}
