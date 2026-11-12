import {
  CombatAlertnessState,
  ImmediatePostureReaction,
  LocomotionMode,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  PhysiologicalVitalPhase,
  PneumothoraxEvent,
  VitalTransitionEvent,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';

export type {
  PhysiologicalVitalPhase,
  PneumothoraxEvent,
  VitalTransitionEvent,
};

export const POSTURE_REACTION_PRIORITY: Readonly<Record<ImmediatePostureReaction, number>> = {
  NONE: 0,
  WEAPON_WRENCH_DROP: 1,
  VIOLENT_CHEST_STAGGER: 2,
  DIAPHRAGM_DROP_KNEEL: 3,
  LEG_COLLAPSE_PRONE: 4,
  NEUROGENIC_DROP: 5,
};

export const VOCAL_CUE_PRIORITY: Readonly<Record<VocalTraumaCue, number>> = {
  NONE: 0,
  PAIN_GRUNT: 1,
  SHARP_GASP: 2,
  AGUNAL_WHEEZE: 3,
  WET_HEMOTHORAX_COUGH: 4,
};

export function escalatePostureReaction(
  current: ImmediatePostureReaction,
  candidate: ImmediatePostureReaction
): ImmediatePostureReaction {
  return POSTURE_REACTION_PRIORITY[candidate] >= POSTURE_REACTION_PRIORITY[current]
    ? candidate
    : current;
}

export function escalateVocalCue(
  current: VocalTraumaCue,
  candidate: VocalTraumaCue
): VocalTraumaCue {
  return VOCAL_CUE_PRIORITY[candidate] >= VOCAL_CUE_PRIORITY[current]
    ? candidate
    : current;
}

export function deriveVitalPhase(state: PhysiologicalEntityState): PhysiologicalVitalPhase {
  if (!state.alive) {
    const cause =
      state.causeOfDeath !== 'NONE' ? state.causeOfDeath : 'CARDIAC_DESTRUCTION';
    return { kind: 'DEAD', causeOfDeath: cause };
  }
  if (!state.conscious) {
    return { kind: 'UNCONSCIOUS', neurogenicShock: state.neurogenicShockCollapsed };
  }
  return { kind: 'CONSCIOUS' };
}

/**
 * Transitions entity vital & consciousness state.
 * Enforces terminal `DEAD` immutability so `causeOfDeath` is latched once on death and never overwritten post-mortem.
 */
export function transitionVitalState(
  state: PhysiologicalEntityState,
  event: VitalTransitionEvent
): void {
  if (!state.alive) {
    return;
  }

  switch (event.kind) {
    case 'LETHAL_ARREST': {
      state.alive = false;
      state.conscious = false;
      if (state.causeOfDeath === 'NONE') {
        state.causeOfDeath = event.cause;
      }
      state.canStand = false;
      state.canPullTrigger = false;
      state.locomotionMode = 'PARALYZED';
      state.heartRateBpm = 0;
      state.meanArterialPressureMmHg = 0;
      state.systolicBpMmHg = 0;
      state.diastolicBpMmHg = 0;
      state.cardiacOutputRatio = 0;
      state.effectiveBleedRateMlPerSec = 0;
      break;
    }

    case 'FALL_UNCONSCIOUS': {
      state.conscious = false;
      if (event.neurogenicShock) {
        state.neurogenicShockCollapsed = true;
      }
      state.canStand = false;
      state.canPullTrigger = false;
      state.locomotionMode = 'PARALYZED';
      break;
    }

    case 'RECOVER_CONSCIOUS': {
      state.conscious = true;
      state.neurogenicShockCollapsed = false;
      if (state.rightLegFunctional && state.leftLegFunctional) {
        state.canStand = true;
      }
      state.locomotionMode = evaluateLocomotionMode(state);
      break;
    }
  }
}

/**
 * Explicit pneumothorax state machine handling initial perforation, tension escalation,
 * chest-seal/needle decompression, re-injury after decompression, and biological tick healing/collapse.
 */
export function transitionPneumothorax(
  state: PhysiologicalEntityState,
  event: PneumothoraxEvent
): boolean {
  if (!state.alive) return false;

  switch (event.kind) {
    case 'LUNG_HIT': {
      state.lungIntegrity = Math.max(0.08, state.lungIntegrity - 0.32 * event.severity);
      if (
        state.pneumothoraxState === 'NONE' ||
        state.pneumothoraxState === 'OPEN_PNEUMOTHORAX' ||
        state.pneumothoraxState === 'DECOMPRESSED_SEALED'
      ) {
        state.pneumothoraxState =
          event.severity >= 0.35 ? 'TENSION_PNEUMOTHORAX' : 'OPEN_PNEUMOTHORAX';
      }
      return true;
    }

    case 'SEAL_DECOMPRESS': {
      if (
        state.pneumothoraxState === 'TENSION_PNEUMOTHORAX' ||
        state.pneumothoraxState === 'OPEN_PNEUMOTHORAX'
      ) {
        state.pneumothoraxState = 'DECOMPRESSED_SEALED';
        state.lungIntegrity = Math.max(state.lungIntegrity, 0.78);
        return true;
      }
      return false;
    }

    case 'TICK': {
      if (state.pneumothoraxState === 'TENSION_PNEUMOTHORAX') {
        state.lungIntegrity = Math.max(0.04, state.lungIntegrity - 0.095 * event.dt);
      } else if (state.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
        state.lungIntegrity = Math.max(0.45, state.lungIntegrity - 0.03 * event.dt);
      } else if (state.pneumothoraxState === 'DECOMPRESSED_SEALED') {
        state.lungIntegrity = Math.min(0.92, state.lungIntegrity + 0.065 * event.dt);
      }
      return true;
    }
  }
}

/**
 * Transitions alertness state (e.g. `UNSUSPECTING -> COMBAT_ALERT` on surviving ballistic trauma),
 * raising adrenaline to combat-alert baseline.
 */
export function transitionAlertnessState(
  state: PhysiologicalEntityState,
  nextAlertness: CombatAlertnessState
): void {
  if (!state.alive) return;
  if (state.alertnessState === nextAlertness) return;
  state.alertnessState = nextAlertness;
  if (nextAlertness === 'COMBAT_ALERT') {
    state.adrenalineLevel = Math.max(
      state.adrenalineLevel,
      PHYSIOLOGY_CONSTANTS.COMBAT_ALERT_ADRENALINE
    );
  }
}

/**
 * Pure total evaluator for `LocomotionMode`.
 * Allows recovery back to `'STANDING_MOBILE'` when standing capability is intact and organ/shock thresholds clear.
 */
export function evaluateLocomotionMode(state: PhysiologicalEntityState): LocomotionMode {
  if (!state.alive || !state.conscious || state.neurogenicShockCollapsed) {
    return 'PARALYZED';
  }
  if (
    state.fracturedBones.has('SPINE_CERVICAL') ||
    state.shatteredBones.has('SPINE_CERVICAL')
  ) {
    return 'PARALYZED';
  }
  if (!state.canStand || !state.rightLegFunctional || !state.leftLegFunctional) {
    return state.locomotionMode === 'PARALYZED' ? 'PARALYZED' : 'PRONE_CRAWL';
  }
  if (state.diaphragmIntegrity < 0.72 || state.liverIntegrity < 0.68) {
    return 'KNEELING_WINDED';
  }
  if (
    state.shockStage === 'CLASS_III' ||
    state.lungIntegrity < 0.75 ||
    state.heartIntegrity < 0.85
  ) {
    return 'STAGGERED_LIMP';
  }
  return 'STANDING_MOBILE';
}
