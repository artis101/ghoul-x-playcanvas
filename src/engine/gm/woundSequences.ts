import type { EnemyArchetypeId, GhoulZoneId, ShotSimulationReport, TargetHealthState } from '../../contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../../core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../../core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { applyDismembermentTree } from '../../core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { startWoundReaction } from '../../core/ballistics/trauma/woundReactionSelector.ts';
import type { WoundSeverity } from '../../core/ballistics/trauma/woundSeverity.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { WOUND_CLIP_SECONDS } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import { getSubtreeZones } from '../../core/ghoul/anatomy/ghoulHierarchy.ts';
import { supportSide, triggerSide } from '../../core/ghoul/anatomy/handedness.ts';
import type { FortitudeChoice, PlayerStandIn } from './woundedLabStandIn.ts';
import type { LabAct } from './labActs.ts';
import {
  applyDeathSequenceHit, DEAGLE_SEQUENCES, DEATH_SEQUENCES, isDeathSequenceHit, type DeathSequenceHit,
} from './deathSequences.ts';

/**
 * Character Lab wound sequences: scripted hits that go through the same core calls a real shot
 * ends in, so every wound clip and its hand-offs can be watched without playing the game. This
 * file holds no engine code, so the scripts can be checked headlessly.
 */

/** A zone, or the gun or support arm, which depends on the character's handedness. */
export type SequenceZone = GhoulZoneId | 'GUN_ARM' | 'SUPPORT_ARM';

export type SequenceHit =
  /** A bullet that stays in the body. `crippleLeg` breaks that leg so it can no longer stand. */
  | {
      readonly kind: 'HIT';
      readonly zone: SequenceZone;
      readonly severity: WoundSeverity;
      readonly energyJ: number;
      readonly crippleLeg?: 'RIGHT' | 'LEFT';
    }
  /** A limb shot off at this zone, with everything below it. */
  | { readonly kind: 'SEVER'; readonly zone: GhoulZoneId; readonly energyJ: number }
  /** Bled down to this share of max HP, which lets the lifecycle start its last-stand collapse. */
  | { readonly kind: 'DRAIN'; readonly hpFraction: number }
  /** Knocked off its feet into the living ragdoll, pitched forward so it lands on its face. */
  | { readonly kind: 'KNOCKDOWN_FORWARD' }
  /** Not a hit: the player stand-in walks to this spot (to step in front of a downed body). */
  | { readonly kind: 'STAND_IN'; readonly to: PlayerStandIn }
  /** Not a hit: something the AI would do with the body (walk, aim, drop or pick up its gun). */
  | { readonly kind: 'ACT'; readonly act: LabAct }
  /** A kill on its feet, a bleed-out, or a support arm put out of action (deathSequences.ts). */
  | DeathSequenceHit;

export interface SequenceStep {
  /** Seconds after the combatant has stood ready. */
  readonly atS: number;
  readonly hit: SequenceHit;
}

/** Panel settings a sequence needs to show its branch; the run sets the controls to these. */
export interface SequencePreset {
  readonly fortitude?: FortitudeChoice;
  readonly standIn?: PlayerStandIn;
  readonly sidearm?: boolean;
  /** The character to run it on, when the sequence needs its gun (the Desert Eagle is the punk's). */
  readonly archetype?: EnemyArchetypeId;
}

export interface WoundSequenceDef {
  readonly id: string;
  readonly label: string;
  readonly steps: readonly SequenceStep[];
  readonly preset?: SequencePreset;
}

/** How long the combatant holds the combat-ready pose with its rifle before the first hit. */
export const STAND_READY_S = 0.8;

const hit = (zone: SequenceZone, severity: WoundSeverity, energyJ: number, atS = 0): SequenceStep =>
  ({ atS, hit: { kind: 'HIT', zone, severity, energyJ } });
const sever = (zone: GhoulZoneId, atS = 0): SequenceStep => ({ atS, hit: { kind: 'SEVER', zone, energyJ: 1400 } });
const standInTo = (to: PlayerStandIn, atS: number): SequenceStep => ({ atS, hit: { kind: 'STAND_IN', to } });
/** In "step in front later", how long the body lies in agony before you walk round in front of it. */
export const STEP_IN_AFTER_LANDING_S = 3;
const act = (what: LabAct, atS = 0): SequenceStep => ({ atS, hit: { kind: 'ACT', act: what } });
const cripple = (side: 'RIGHT' | 'LEFT'): SequenceStep =>
  ({ atS: 0, hit: { kind: 'HIT', zone: `THIGH_${side}`, severity: 'CRITICAL', energyJ: 320, crippleLeg: side } });

/**
 * The wounded-sequence branches (docs/wound-movement.md). The support arm comes off so the gun
 * hand is left for the pistol; each one runs the real phase stepping and armament rules.
 */
const BRANCH_SEQUENCES: readonly WoundSequenceDef[] = [
  { id: 'arm-blaze', label: 'Arm off → blaze', steps: [sever('UPPER_ARM_LEFT')],
    preset: { fortitude: 'HIGH', sidearm: true, standIn: 'FRONT' } },
  { id: 'arm-kneel', label: 'Arm off → kneel and fire', steps: [sever('UPPER_ARM_LEFT')],
    preset: { fortitude: 'MIDDLING', sidearm: true, standIn: 'FRONT' } },
  { id: 'arm-sit', label: 'Arm off → sit and fight', steps: [sever('UPPER_ARM_LEFT')],
    preset: { fortitude: 'LOW', sidearm: true, standIn: 'FRONT' } },
  { id: 'arm-no-sidearm', label: 'Arm off, no sidearm', steps: [sever('UPPER_ARM_LEFT')],
    preset: { fortitude: 'HIGH', sidearm: false, standIn: 'FRONT' } },
  { id: 'leg-front', label: 'Leg off, you in front', steps: [sever('SHIN_RIGHT')],
    preset: { sidearm: true, standIn: 'FRONT' } },
  { id: 'leg-side', label: 'Leg off, you to the side', steps: [sever('SHIN_RIGHT')],
    preset: { fortitude: 'MIDDLING', sidearm: true, standIn: 'LEFT' } },
  // Too gritty to crawl and with you off to the side, it sits in agony; 3 s after it lands you
  // step in front, and it leans back, draws from the hip and aims at you from the floor.
  { id: 'leg-later', label: 'Leg off, you step in front later',
    steps: [sever('SHIN_RIGHT'), standInTo('FRONT', WOUND_CLIP_SECONDS.LEG_LOSS + STEP_IN_AFTER_LANDING_S)],
    preset: { fortitude: 'HIGH', sidearm: true, standIn: 'LEFT' } },
  { id: 'face-down', label: 'Face-down knockdown', steps: [{ atS: 0, hit: { kind: 'KNOCKDOWN_FORWARD' } }],
    preset: { sidearm: true, standIn: 'FRONT' } },
  // A crippled leg that is still attached: it rolls onto its belly and drags that leg behind.
  { id: 'crawl-drag', label: 'Crawl dragging leg', steps: [cripple('RIGHT')],
    preset: { fortitude: 'LOW', sidearm: false, standIn: 'LEFT' } },
];

/** Standing behaviour the AI asks for: clips for empty hands, the pickup, a hurt walk, aiming on the move. */
const MOVEMENT_SEQUENCES: readonly WoundSequenceDef[] = [
  { id: 'disarmed', label: 'Disarmed (unarmed idle/walk)',
    steps: [act('DROP_GUN'), act('WALK', 2), act('STOP', 8)], preset: { sidearm: false } },
  { id: 'pickup', label: 'Pick up weapon', steps: [act('DROP_GUN'), act('PICK_UP_GUN', 1.5)], preset: { sidearm: false } },
  { id: 'hurt-walk', label: 'Hurt walk',
    steps: [hit('TORSO_LOWER_ABDOMEN', 'PENETRATING', 450), act('HURT'), act('WALK', 2)] },
  { id: 'aim-walk', label: 'Aim while walking', steps: [act('AIM'), act('WALK', 0.5)] },
];

export const WOUND_SEQUENCES: readonly WoundSequenceDef[] = [
  ...BRANCH_SEQUENCES,
  ...MOVEMENT_SEQUENCES,
  ...DEATH_SEQUENCES,
  ...DEAGLE_SEQUENCES,
  { id: 'chest', label: 'Chest hit', steps: [hit('TORSO_UPPER_THORAX', 'PENETRATING', 450)] },
  { id: 'head', label: 'Head hit', steps: [hit('HEAD_CRANIUM', 'PENETRATING', 300)] },
  { id: 'gut', label: 'Gut hit (critical)', steps: [hit('TORSO_LOWER_ABDOMEN', 'CRITICAL', 620)] },
  { id: 'throat', label: 'Throat hit (critical)', steps: [hit('NECK_CERVICAL', 'CRITICAL', 420)] },
  { id: 'gun-arm', label: 'Gun-arm hit', steps: [hit('GUN_ARM', 'PENETRATING', 260)] },
  { id: 'support-arm', label: 'Support-arm hit', steps: [hit('SUPPORT_ARM', 'PENETRATING', 260)] },
  { id: 'leg-r', label: 'Leg hit R', steps: [hit('THIGH_RIGHT', 'PENETRATING', 220)] },
  { id: 'leg-l', label: 'Leg hit L', steps: [hit('THIGH_LEFT', 'PENETRATING', 220)] },
  { id: 'graze', label: 'Graze', steps: [hit('TORSO_UPPER_THORAX', 'GRAZE', 40)] },
  { id: 'cripple-r', label: 'Leg crippled R (fall)', steps: [cripple('RIGHT')] },
  { id: 'cripple-l', label: 'Leg crippled L', steps: [cripple('LEFT')] },
  { id: 'leg-off-r', label: 'Leg blown off R (hop + fall)', steps: [sever('SHIN_RIGHT')] },
  { id: 'leg-off-l', label: 'Leg blown off L', steps: [sever('SHIN_LEFT')] },
  { id: 'hand-off-r', label: 'Hand off R', steps: [sever('HAND_RIGHT')] },
  { id: 'hand-off-l', label: 'Hand off L', steps: [sever('HAND_LEFT')] },
  { id: 'forearm-off-r', label: 'Forearm off R', steps: [sever('FOREARM_RIGHT')] },
  { id: 'arm-off-l', label: 'Arm off L', steps: [sever('UPPER_ARM_LEFT')] },
  {
    id: 'last-stand',
    label: 'Last stand collapse',
    // The HP drop lands once the arm-loss clip has had time to show the stump clutch.
    steps: [sever('FOREARM_LEFT'), { atS: 2.6, hit: { kind: 'DRAIN', hpFraction: 0.3 } }],
  },
  {
    id: 'double',
    label: 'Double hit',
    steps: [hit('TORSO_UPPER_THORAX', 'PENETRATING', 450), hit('HEAD_CRANIUM', 'PENETRATING', 300, 0.3)],
  },
  {
    id: 'hit-during-fall',
    label: 'Hit during fall',
    steps: [sever('SHIN_RIGHT'), hit('TORSO_UPPER_THORAX', 'PENETRATING', 450, 1)],
  },
];

export function findWoundSequence(id: string): WoundSequenceDef | undefined {
  return WOUND_SEQUENCES.find((def) => def.id === id);
}

export function resolveSequenceZone(zone: SequenceZone, isLeftHanded: boolean): GhoulZoneId {
  if (zone === 'GUN_ARM') return `UPPER_ARM_${triggerSide(isLeftHanded)}`;
  if (zone === 'SUPPORT_ARM') return `UPPER_ARM_${supportSide(isLeftHanded)}`;
  return zone;
}

/** The shooter stands in front of the combatant, so every bullet travels toward -Z. */
const HIT_DIRECTION = vec3(0, 0, -1);

/** Lands one scripted hit on the target through the core wound path. Returns a short log line. */
export function applySequenceHit(hs: TargetHealthState, step: SequenceHit): string {
  // The preview moves the stand-in and runs the acts itself; the body is not touched here.
  if (step.kind === 'STAND_IN') return `you step ${step.to.toLowerCase()}`;
  if (step.kind === 'ACT') return step.act.toLowerCase().replace(/_/g, ' ');
  if (isDeathSequenceHit(step)) return applyDeathSequenceHit(hs, step);
  if (step.kind === 'KNOCKDOWN_FORWARD') {
    knockDownForward(hs);
    return 'knocked down forward';
  }
  if (step.kind === 'DRAIN') {
    hs.currentHp = Math.min(hs.currentHp, hs.maxHp * step.hpFraction);
    return `HP → ${Math.round(step.hpFraction * 100)} %`;
  }
  if (step.kind === 'HIT') {
    const zone = resolveSequenceZone(step.zone, hs.isLeftHanded);
    if (step.crippleLeg === 'RIGHT') hs.rightLegFunctional = false;
    if (step.crippleLeg === 'LEFT') hs.leftLegFunctional = false;
    startWoundReaction(hs, {
      hitZone: zone, severity: step.severity, newlySeveredLegSide: null, newlySeveredArmSide: null,
      energyJ: step.energyJ, hitDirectionWorld: HIT_DIRECTION,
    });
    return `${step.severity.toLowerCase()} ${zone}`;
  }
  const severed = applyDismembermentTree(hs, buildSeverReport(hs, [step.zone]));
  // Kept alive and still bleeding-free so the clip, not blood loss, decides what happens next.
  hs.bloodLossRateMlPerSec = 0;
  if (!hs.alive) return `severed ${step.zone} (fatal)`;
  startWoundReaction(hs, {
    hitZone: step.zone,
    severity: 'CRITICAL',
    newlySeveredLegSide: severed.newlySeveredRightLeg ? 'RIGHT' : severed.newlySeveredLeftLeg ? 'LEFT' : null,
    newlySeveredArmSide: severed.newlySeveredRightArm ? 'RIGHT' : severed.newlySeveredLeftArm ? 'LEFT' : null,
    energyJ: step.energyJ,
    hitDirectionWorld: HIT_DIRECTION,
  });
  return `severed ${step.zone}`;
}

/** The dismemberment part of a shot report, as the shot pass hands it over for clean cuts. */
export function buildSeverReport(hs: TargetHealthState, zones: readonly GhoulZoneId[]): ShotSimulationReport {
  const dismembermentEvents = zones.map((zone) => ({
    zone,
    goreMode: 'CLEAN_SEVER' as const,
    detachedSubtree: getSubtreeZones(zone),
    stumpWorldPosition: hs.ragdollBones[zone].position,
    arterialSprayDirection: vec3(0, 1, 0),
    // Thrown outward, away from the side of the body it came off.
    severedLimbVelocity: vec3(zone.endsWith('RIGHT') ? -1.6 : 1.6, 1.8, -0.6),
    severedLimbAngularVelocity: vec3(3, 2, -4),
    gibCount: 0,
    // Torn mid-bone, as a bullet through the middle of the limb would leave it.
    cut: { alongFraction: 0.55, entryLocal: vec3(0, 0.1, 0.05), shotDirLocal: vec3(0.3, 0, -1), seed: 0x5eed + zone.length * 7919 },
  }));
  return { dismembermentEvents } as unknown as ShotSimulationReport;
}

/**
 * Throws a standing body into the living ragdoll so it pitches onto its face: the upper body is
 * sent forward faster than the feet, the way a shove in the back or a blast from behind tips it.
 * It keeps enough health to live, so the face-down rule (no gun, no damage) can be watched.
 */
export function knockDownForward(hs: TargetHealthState): void {
  hs.currentHp = Math.min(hs.currentHp, hs.maxHp * 0.45);
  hs.bloodLossRateMlPerSec = 0;
  transitionTargetLifecycle(hs, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  stabilizeRagdollPoseForTransition(hs, 0);
  const fx = Math.sin(hs.yawRad);
  const fz = Math.cos(hs.yawRad);
  hs.ragdollRootVelocity = vec3(fx * 1.6, 0, fz * 1.6);
  hs.ragdollAngularVelocity = vec3(fz * 3, 0, -fx * 3);
  for (const bone of Object.values(hs.ragdollBones)) {
    if (bone.componentId !== 'BODY') continue;
    const height = Math.max(0, Math.min(1, bone.position.y / 1.6));
    const speed = 3.4 * height - 0.5;
    bone.velocity = vec3(fx * speed, -0.3 * height, fz * speed);
  }
  for (const aux of Object.values(hs.auxParticles)) {
    if (aux.componentId === 'BODY') aux.velocity = { ...hs.ragdollBones[aux.parentZone].velocity };
  }
}
