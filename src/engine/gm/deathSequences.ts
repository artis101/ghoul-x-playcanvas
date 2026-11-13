import type { GhoulZoneId, ShotSimulationReport, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { chooseShotDeathClip, startDeathAnimation } from '../../core/ballistics/lifecycle/deathAnimation.ts';
import { transitionTargetLifecycle } from '../../core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { startWoundReaction } from '../../core/ballistics/trauma/woundReactionSelector.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { supportSide } from '../../core/ghoul/anatomy/handedness.ts';
import type { LabAct } from './labActs.ts';
import type { SequenceStep, WoundSequenceDef } from './woundSequences.ts';

/**
 * Character Lab sequences for dying on your feet and for the Desert Eagle's holds. The kills go
 * through the core's own clip choice (`chooseShotDeathClip`) and death start, and the bleed-out
 * through the real lifecycle, so each button shows what the game would play. No engine code.
 */

/** Where the shooter stands relative to the way the body faces. */
export type ShotFrom = 'FRONT' | 'BEHIND' | 'LEFT';

export type DeathSequenceHit =
  /** A killing round from `from` into `zone`: the body plays the death clip the core picks. */
  | { readonly kind: 'SHOT_DEAD'; readonly zone: GhoulZoneId; readonly from: ShotFrom }
  /** Bleeding fast while standing: the lifecycle runs the health out and plays DeathBleedOut. */
  | { readonly kind: 'BLEED_OUT' }
  /** A round that puts the support arm out of action (attached, but it no longer works). */
  | { readonly kind: 'CRIPPLE_SUPPORT_ARM' };

/** Fast enough to empty a standing body's health in two or three seconds. */
const BLEED_OUT_ML_PER_S = 400;

const at = (atS: number, hit: DeathSequenceHit | { readonly kind: 'ACT'; readonly act: LabAct }): SequenceStep =>
  ({ atS, hit });
const shotDead = (zone: GhoulZoneId, from: ShotFrom, atS = 0) => at(atS, { kind: 'SHOT_DEAD', zone, from });
const act = (what: LabAct, atS = 0) => at(atS, { kind: 'ACT', act: what });

export const DEATH_SEQUENCES: readonly WoundSequenceDef[] = [
  { id: 'dead-front', label: 'Shot dead: front', steps: [act('AIM'), shotDead('TORSO_UPPER_THORAX', 'FRONT', 0.6)] },
  { id: 'dead-behind', label: 'Shot dead: from behind', steps: [shotDead('TORSO_UPPER_THORAX', 'BEHIND', 0.3)] },
  { id: 'dead-head', label: 'Shot dead: head', steps: [act('AIM'), shotDead('HEAD_CRANIUM', 'FRONT', 0.6)] },
  { id: 'dead-shoulder', label: 'Shot dead: shoulder', steps: [act('AIM'), shotDead('SHOULDER_RIGHT', 'FRONT', 0.6)] },
  { id: 'bleed-out', label: 'Bleeds out standing', steps: [at(0, { kind: 'BLEED_OUT' })] },
  { id: 'dead-walking', label: 'Shot dead while walking',
    steps: [act('WALK'), shotDead('TORSO_UPPER_THORAX', 'FRONT', 1.6)] },
];

/** The Desert Eagle: two hands while both arms work, one extended arm once the support arm is out. */
export const DEAGLE_SEQUENCES: readonly WoundSequenceDef[] = [
  { id: 'deagle-aim', label: 'Desert Eagle: aim two-handed', steps: [act('AIM', 0.5)],
    preset: { archetype: 'SKINHEAD_PUNK', sidearm: false } },
  { id: 'deagle-one-hand', label: 'Desert Eagle: lose arm -> one-handed',
    steps: [act('AIM', 0.5), at(2, { kind: 'CRIPPLE_SUPPORT_ARM' })],
    preset: { archetype: 'SKINHEAD_PUNK', sidearm: false } },
  { id: 'deagle-walk-aim', label: 'Desert Eagle: walk and aim', steps: [act('WALK'), act('AIM', 1.5)],
    preset: { archetype: 'SKINHEAD_PUNK', sidearm: false } },
];

export function isDeathSequenceHit(hit: { readonly kind: string }): hit is DeathSequenceHit {
  return hit.kind === 'SHOT_DEAD' || hit.kind === 'BLEED_OUT' || hit.kind === 'CRIPPLE_SUPPORT_ARM';
}

/** The direction a round travels, in the world, for a shooter standing `from` the body. */
export function shotTravelDirection(hs: TargetHealthState, from: ShotFrom): Vec3Like {
  const fx = Math.sin(hs.yawRad);
  const fz = Math.cos(hs.yawRad);
  if (from === 'BEHIND') return vec3(fx, 0, fz);
  // From the body's left, travelling toward its right.
  if (from === 'LEFT') return vec3(-fz, 0, fx);
  return vec3(-fx, 0, -fz);
}

/** The parts of a killing shot's report the death-clip choice reads. */
export function buildKillReport(hs: TargetHealthState, zone: GhoulZoneId, dir: Vec3Like): ShotSimulationReport {
  const head = zone === 'HEAD_CRANIUM';
  return {
    aimDirectionWorld: dir,
    woundEvents: [{ ghoulZone: zone, impactDirectionWorld: dir }],
    ragdollPlan: { primaryHitZone: zone, willEnableRagdoll: false, netRootImpulseWorld: vec3(0, 0, 0) },
    rupturedOrgans: head ? ['Brain (Cerebrum & Brainstem)'] : [],
    shatteredBones: [],
    dismembermentEvents: [],
    severedZones: [],
    isLethalKill: true,
  } as unknown as ShotSimulationReport;
}

/** Lands one death or Desert Eagle step. Returns a short log line. */
export function applyDeathSequenceHit(hs: TargetHealthState, hit: DeathSequenceHit): string {
  if (hit.kind === 'BLEED_OUT') {
    hs.bloodLossRateMlPerSec = BLEED_OUT_ML_PER_S;
    return 'bleeding out';
  }
  if (hit.kind === 'CRIPPLE_SUPPORT_ARM') {
    const side = supportSide(hs.isLeftHanded);
    if (side === 'RIGHT') hs.rightArmFunctional = false;
    else hs.leftArmFunctional = false;
    startWoundReaction(hs, {
      hitZone: `UPPER_ARM_${side}`, severity: 'PENETRATING', newlySeveredLegSide: null, newlySeveredArmSide: null,
      energyJ: 260, hitDirectionWorld: shotTravelDirection(hs, 'FRONT'),
    });
    return `support arm (${side.toLowerCase()}) put out of action`;
  }
  const dir = shotTravelDirection(hs, hit.from);
  const clip = chooseShotDeathClip(hs, buildKillReport(hs, hit.zone, dir));
  hs.currentHp = 0;
  transitionTargetLifecycle(hs, { kind: 'LETHAL_DEATH' });
  startDeathAnimation(hs, clip);
  return `shot dead in ${hit.zone} from ${hit.from.toLowerCase()}: ${clip}`;
}
