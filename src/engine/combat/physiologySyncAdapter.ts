import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { stabilizeRagdollPoseForTransition } from '../../core/ballistics/solver.ts';
import { scale, vec3 } from '../../core/ballistics/vec3.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';

export function syncPhysiologyToHealthState(
  physio: PhysiologicalEntityState,
  hs: TargetHealthState,
  tacticalAi?: TacticalCombatAiSystem | null
): void {
  if (hs.bloodLossRateMlPerSec > physio.baseBleedRateMlPerSec) {
    physio.baseBleedRateMlPerSec = hs.bloodLossRateMlPerSec;
  }

  if (!hs.alive && physio.alive) {
    physio.alive = false;
    physio.conscious = false;
    if (physio.causeOfDeath === 'NONE') {
      physio.causeOfDeath =
        hs.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP'
          ? 'CNS_BRAINSTEM_DESTRUCTION'
          : 'CARDIAC_DESTRUCTION';
    }
    physio.heartRateBpm = 0;
    physio.meanArterialPressureMmHg = 0;
    physio.systolicBpMmHg = 0;
    physio.diastolicBpMmHg = 0;
    physio.effectiveBleedRateMlPerSec = 0;
    return;
  }

  if (!physio.alive && hs.alive) {
    hs.alive = false;
    hs.currentHp = 0;
    hs.consciousness = 0;
    hs.heartRateBpm = 0;
    hs.systolicBpMmHg = 0;
    hs.weaponDropped = true;
    hs.activeReaction.type = 'NONE';
    hs.activeReaction.timerS = 0;
    if (!hs.isRagdollActive) {
      hs.isRagdollActive = true;
      hs.posture = 'AIRBORNE_RAGDOLL';
      stabilizeRagdollPoseForTransition(hs, 0.0);
      const slump = vec3(
        Math.sin(hs.yawRad) * 0.25,
        -0.35,
        Math.cos(hs.yawRad) * 0.35
      );
      hs.ragdollBones.TORSO_UPPER_THORAX.velocity = slump;
      hs.ragdollBones.PELVIS_GROIN.velocity = scale(slump, 0.8);
      hs.ragdollBones.HEAD_CRANIUM.velocity = scale(slump, 1.1);
    }
  }

  if (physio.biologicalTicksExecuted > 0 || physio.vascularWounds.length > 0) {
    hs.bloodVolumeMl = Math.min(hs.bloodVolumeMl, physio.bloodVolumeMl);
  }
  hs.bloodLossRateMlPerSec = Math.max(
    hs.bloodLossRateMlPerSec,
    physio.effectiveBleedRateMlPerSec > 0
      ? physio.effectiveBleedRateMlPerSec
      : physio.baseBleedRateMlPerSec
  );
  hs.systolicBpMmHg = physio.systolicBpMmHg;
  hs.heartRateBpm = physio.heartRateBpm;
  hs.oxygenSaturationPct = Math.round(physio.oxygenSaturationPct);
  hs.painShock = Math.max(hs.painShock, physio.painShockLevel);

  if (!physio.conscious) {
    const aiAgent = tacticalAi?.getAgent(hs.targetId);
    if (
      physio.neurogenicShockCollapsed &&
      hs.alive &&
      aiAgent &&
      aiAgent.neurogenicShockTimerS <= 0 &&
      physio.bloodVolumeMl > 2650 &&
      physio.oxygenSaturationPct >= 58
    ) {
      physio.neurogenicShockCollapsed = false;
      physio.conscious = true;
      physio.alertnessState = 'COMBAT_ALERT';
      physio.adrenalineLevel = Math.max(physio.adrenalineLevel, 0.92);
      hs.consciousness = Math.max(hs.consciousness, 0.52);
    } else {
      hs.consciousness = Math.min(hs.consciousness, 0.18);
    }
  }

  if (!physio.rightLegFunctional) hs.rightLegFunctional = false;
  if (!physio.leftLegFunctional) hs.leftLegFunctional = false;
  if (!physio.rightArmFunctional) hs.rightArmFunctional = false;
  if (!physio.leftArmFunctional) hs.leftArmFunctional = false;
  if (physio.weaponDropped) {
    hs.weaponDropped = true;
    hs.primaryArmDisarmed = true;
  }

  if (!hs.isRagdollActive && hs.alive) {
    if (physio.readability.immediatePostureReaction === 'DIAPHRAGM_DROP_KNEEL') {
      hs.posture = 'GUT_HURT';
    } else if (physio.readability.immediatePostureReaction === 'LEG_COLLAPSE_PRONE') {
      hs.posture = 'LEG_BUCKLED';
    }
  }
}
