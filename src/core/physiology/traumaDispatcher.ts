import {
  ArmorPlateId,
  ImmediatePostureReaction,
  InternalBallisticsReport,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import { copyVec3, vec3 } from '../ballistics/vec3.ts';
import { recomputeMotorAndReadability } from './motorReadability.ts';
import {
  escalatePostureReaction,
  escalateVocalCue,
  transitionAlertnessState,
  transitionVitalState,
} from './physiologyLifecycleFsm.ts';
import { applyBoneAndNerveTrauma } from './traumaBonesNerves.ts';
import { applyOrganTrauma } from './traumaOrgans.ts';
import { mergeOrAddVascularWound } from './vascularHelper.ts';

export function applyInternalBallisticsTrauma(
  state: PhysiologicalEntityState,
  report: InternalBallisticsReport
): PhysiologicalEntityState {
  for (const plateId of Object.keys(report.plateIntegrityAfter) as ArmorPlateId[]) {
    state.plateIntegrity[plateId] = Math.min(
      state.plateIntegrity[plateId],
      report.plateIntegrityAfter[plateId]
    );
  }

  // Terminal DEAD guard: post-mortem shots never overwrite latched causeOfDeath or vitals
  if (!report.hitOuterShell || !state.alive) {
    return state;
  }

  let reaction: ImmediatePostureReaction = 'NONE';
  let vocal: VocalTraumaCue = 'PAIN_GRUNT';
  let painSpike = 0;

  // 1. Backface Blunt Trauma
  if (report.stoppedByArmorPlate !== null && report.totalPenetrationDepthCm < 1.5) {
    painSpike += report.armorBackfaceBluntTraumaJ / 260;
    if (report.armorBackfaceBluntTraumaJ >= 65) {
      reaction = escalatePostureReaction(reaction, 'VIOLENT_CHEST_STAGGER');
      vocal = escalateVocalCue(vocal, 'SHARP_GASP');
      state.diaphragmIntegrity = Math.max(0.76, state.diaphragmIntegrity - 0.15);
    }
  }

  // 2 & 3. Bones & Nerves
  const bn = applyBoneAndNerveTrauma(
    state,
    report.boneTrauma,
    report.nervesSevered,
    reaction,
    vocal
  );
  reaction = bn.reaction;
  vocal = bn.vocal;
  painSpike += bn.painSpike;

  // 4. Organs
  const org = applyOrganTrauma(state, report.organTrauma, reaction, vocal);
  reaction = org.reaction;
  vocal = org.vocal;
  painSpike += org.painSpike;

  // 5. Major Vascular Wounds
  for (const vw of report.vascularWounds) {
    mergeOrAddVascularWound(state, vw);
  }

  if (
    state.vascularWounds.length === 0 &&
    report.woundTractMuscleBleedMlPerSec > 0 &&
    report.entryPointLocal &&
    report.entryPointWorld
  ) {
    mergeOrAddVascularWound(state, {
      vesselId: 'VENA_CAVA_JUGULAR_FEMORAL',
      vesselKind: 'VENOUS',
      ghoulZone: 'TORSO_UPPER_THORAX',
      positionLocal: copyVec3(report.entryPointLocal),
      positionWorld: copyVec3(report.entryPointWorld),
      sprayDirectionWorld: vec3(0, -0.5, 0.85),
      severity: 0.35,
      baseBleedMlPerSec: report.woundTractMuscleBleedMlPerSec,
    });
  }

  let totalVascularBleed = 0;
  for (const w of state.vascularWounds) {
    totalVascularBleed += w.baseBleedMlPerSec;
  }
  state.baseBleedRateMlPerSec =
    totalVascularBleed +
    Math.max(0, org.organBleedMlPerSec) +
    (report.vascularWounds.length > 0 ? report.woundTractMuscleBleedMlPerSec * 0.4 : 0);

  const mapRatio = Math.max(
    0.08,
    state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG
  );
  state.effectiveBleedRateMlPerSec = state.alive ? state.baseBleedRateMlPerSec * mapRatio : 0;

  // 6. Neurogenic Pain Shock vs Adrenaline Buffer
  painSpike += Math.min(0.65, report.totalEnergyDepositedJ / 950);
  state.painShockLevel = Math.min(2.0, state.painShockLevel + painSpike);

  const isTorsoHit =
    report.entryPointLocal !== null &&
    report.entryPointLocal.y >= 0.92 &&
    report.entryPointLocal.y <= 1.54 &&
    Math.abs(report.entryPointLocal.x) <= 0.21;

  const isDefeatedAtOuterArmor =
    report.stoppedByArmorPlate !== null && report.totalPenetrationDepthCm < 1.5;
  const adrenalineBuffer = 0.14 + state.adrenalineLevel * 1.65;
  if (
    state.alive &&
    state.conscious &&
    state.alertnessState === 'UNSUSPECTING' &&
    isTorsoHit &&
    !isDefeatedAtOuterArmor &&
    painSpike > adrenalineBuffer
  ) {
    transitionVitalState(state, { kind: 'FALL_UNCONSCIOUS', neurogenicShock: true });
    reaction = escalatePostureReaction(reaction, 'NEUROGENIC_DROP');
    vocal = escalateVocalCue(vocal, 'SHARP_GASP');
  } else if (state.alive && state.conscious && isTorsoHit && reaction === 'NONE') {
    reaction = escalatePostureReaction(reaction, 'VIOLENT_CHEST_STAGGER');
  }

  // Surviving ballistic trauma transitions UNSUSPECTING -> COMBAT_ALERT
  if (state.alive && state.conscious && state.alertnessState === 'UNSUSPECTING') {
    transitionAlertnessState(state, 'COMBAT_ALERT');
  }

  recomputeMotorAndReadability(state, reaction, vocal);
  return state;
}
