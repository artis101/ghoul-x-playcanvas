import type {
  GhoulZoneId,
  PainReactionType,
  StandingCombatPosture,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
import { copyVec3 } from '../vec3.ts';
import { WOUND_CLIP_SECONDS, isCommittedWoundReaction } from './woundReactionTimings.ts';
import type { WoundSeverity } from './woundSeverity.ts';
import { isSeatedAnimated } from '../triage/seatedLastStand.ts';

/** What one surviving hit did, as far as choosing the body's reaction goes. */
export interface WoundReactionInput {
  readonly hitZone: GhoulZoneId;
  readonly severity: WoundSeverity;
  readonly newlySeveredLegSide: 'RIGHT' | 'LEFT' | null;
  /** Hand, forearm or upper arm newly cut off. */
  readonly newlySeveredArmSide: 'RIGHT' | 'LEFT' | null;
  /** Energy deposited by this hit. */
  readonly energyJ: number;
  readonly hitDirectionWorld: Vec3Like;
}

interface ChosenReaction {
  type: PainReactionType;
  durationS: number;
  posture: StandingCombatPosture | undefined;
  /** The clip throws the arms out or the body goes down, so the long gun leaves the hands. */
  dropsWeapon: boolean;
}

const LEG_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'THIGH_RIGHT', 'KNEE_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT',
  'THIGH_LEFT', 'KNEE_LEFT', 'SHIN_LEFT', 'FOOT_LEFT',
]);

function isRightArmZone(zone: GhoulZoneId): boolean {
  return zone === 'SHOULDER_RIGHT' || zone === 'UPPER_ARM_RIGHT' || zone === 'FOREARM_RIGHT' || zone === 'HAND_RIGHT';
}

function isLeftArmZone(zone: GhoulZoneId): boolean {
  return zone === 'SHOULDER_LEFT' || zone === 'UPPER_ARM_LEFT' || zone === 'FOREARM_LEFT' || zone === 'HAND_LEFT';
}

/** Same scale the reactions have always used: harder and deeper hits jolt harder, up to 1.3. */
export function woundReactionIntensity(severity: WoundSeverity, energyJ: number): number {
  const severityScale = severity === 'GRAZE' ? 0.45 : severity === 'CRITICAL' ? 1.15 : 0.85;
  return Math.min(1.3, (0.6 + energyJ / 450) * severityScale);
}

function chooseReaction(target: TargetHealthState, input: WoundReactionInput): ChosenReaction {
  const { hitZone, severity } = input;

  // A leg gone: the long clip hops on the good leg and topples into a seat.
  if (input.newlySeveredLegSide) {
    return {
      type: input.newlySeveredLegSide === 'RIGHT' ? 'LEG_LOST_RIGHT' : 'LEG_LOST_LEFT',
      durationS: WOUND_CLIP_SECONDS.LEG_LOSS,
      posture: 'LEG_BUCKLED',
      dropsWeapon: true,
    };
  }
  // An arm gone: recoil and clutch the stump. The arm-loss disarm has already dropped the gun.
  if (input.newlySeveredArmSide) {
    return {
      type: input.newlySeveredArmSide === 'RIGHT' ? 'ARM_LOST_RIGHT' : 'ARM_LOST_LEFT',
      durationS: WOUND_CLIP_SECONDS.ARM_LOSS,
      posture: 'DISARMED',
      dropsWeapon: false,
    };
  }
  // A leg that will not bear weight any more: the knee gives and the body falls on its hip.
  if (!target.rightLegFunctional || !target.leftLegFunctional) {
    return {
      type: !target.rightLegFunctional ? 'LEG_BUCKLE_RIGHT' : 'LEG_BUCKLE_LEFT',
      durationS: WOUND_CLIP_SECONDS.LEG_SHOT_FALL,
      posture: 'LEG_BUCKLED',
      dropsWeapon: true,
    };
  }

  let type: PainReactionType = 'CHEST_STAGGER';
  let posture: StandingCombatPosture | undefined;
  if (LEG_ZONES.has(hitZone)) {
    // Hurt but still working: the knee dips and the body limps back into its stance.
    type = hitZone.endsWith('RIGHT') ? 'LEG_FLINCH_RIGHT' : 'LEG_FLINCH_LEFT';
    posture = 'STAGGERED';
  } else if (hitZone === 'NECK_CERVICAL' && severity === 'CRITICAL') {
    // An opened artery or airway: they grab at the throat, on their feet, while it pumps out.
    type = 'THROAT_CLUTCH';
    posture = 'STAGGERED';
  } else if (hitZone === 'TORSO_LOWER_ABDOMEN' && severity === 'CRITICAL') {
    // A burst gut makes them hunch and clutch it, but adrenaline keeps them standing.
    type = 'GUT_FOLD';
    posture = 'STAGGERED';
  } else if (hitZone === 'HEAD_CRANIUM' || hitZone === 'HEAD_FACE_JAW') {
    type = 'HEAD_SNAP';
    posture = 'STAGGERED';
  } else if (isRightArmZone(hitZone)) {
    type = 'ARM_WRENCH_RIGHT';
    if (target.weaponDropped) posture = 'DISARMED';
  } else if (isLeftArmZone(hitZone)) {
    type = 'ARM_WRENCH_LEFT';
    if (target.weaponDropped) posture = 'DISARMED';
  }

  // How long a flinch lasts follows the wound, not the body part: a pellet graze is a twitch,
  // a deep channel a real stagger, a cut artery or burst organ a long clutch.
  let durationS = 0.65;
  if (severity === 'GRAZE') {
    durationS = 0.22;
    if (posture === 'STAGGERED') posture = undefined;
  } else if (severity === 'CRITICAL') {
    durationS = type === 'THROAT_CLUTCH' || type === 'GUT_FOLD' ? 1.1 : 0.8;
  }
  return { type, durationS, posture, dropsWeapon: false };
}

/** Every surviving hit bumps the jolt counter, so the pose layer can spring the body on it. */
function bumpJolt(target: TargetHealthState, input: WoundReactionInput, intensity: number): void {
  target.joltEpoch = (target.joltEpoch ?? 0) + 1;
  target.lastJoltDirectionWorld = copyVec3(input.hitDirectionWorld);
  target.lastJoltIntensity = intensity;
}

/**
 * A body already crawling on the floor, sinking onto its knees, or sitting in its last stand has
 * nowhere further to fall. A new reaction clip would pop it back up to replay a stand-and-fall
 * (and the fall would replan the crawler as a shooter), so a hit on it only jolts. That holds for a
 * newly severed limb on a seated body too: gore and a jolt, and it stays sitting.
 */
function onlyJoltsWhenHit(target: TargetHealthState): boolean {
  const phase = target.woundedPhase;
  return phase === 'DOWNED_CRAWL' || phase === 'KNEEL_DOWN' || isSeatedAnimated(target);
}

/**
 * Picks and starts the body's reaction to one surviving hit (see docs/wound-movement.md).
 * A fall, loss or collapse already playing is not restarted by a lesser hit; it only jolts.
 * Only a newly lost leg cuts in on it, because the hop-and-topple is the one clip that must win.
 */
export function startWoundReaction(target: TargetHealthState, input: WoundReactionInput): void {
  if (!target.alive || target.isRagdollActive) return;
  const intensity = woundReactionIntensity(input.severity, input.energyJ);
  bumpJolt(target, input, intensity);
  if (onlyJoltsWhenHit(target)) return;

  const active = target.activeReaction.type;
  if (active !== 'NONE' && isCommittedWoundReaction(active) && !input.newlySeveredLegSide) return;

  const chosen = chooseReaction(target, input);
  if (chosen.dropsWeapon) {
    // A plain drop, like a knockdown: the weapon mount turns it into a prop on the floor and
    // publishes where it lies. The arms still work, so it is not an arm disarm.
    target.weaponDropped = true;
  }
  transitionTargetLifecycle(target, {
    kind: 'START_PAIN_REACTION',
    reactionType: chosen.type,
    durationS: chosen.durationS,
    intensity,
    hitDirectionWorld: input.hitDirectionWorld,
    postureOverride: chosen.posture,
  });
}

/**
 * The organ and nerve model can take a leg out a moment after the shot report chose a flinch
 * (a femoral nerve cut, a shattered femur it found deeper in). Turn that flinch into the fall,
 * unless a fall, loss or collapse is already playing.
 */
export function buckleOnLateLegCripple(target: TargetHealthState): void {
  if (!target.alive || target.isRagdollActive) return;
  if (target.rightLegFunctional && target.leftLegFunctional) return;
  if (onlyJoltsWhenHit(target)) return;
  const rx = target.activeReaction;
  if (rx.type !== 'NONE' && isCommittedWoundReaction(rx.type)) return;
  target.weaponDropped = true;
  transitionTargetLifecycle(target, {
    kind: 'START_PAIN_REACTION',
    reactionType: !target.rightLegFunctional ? 'LEG_BUCKLE_RIGHT' : 'LEG_BUCKLE_LEFT',
    durationS: WOUND_CLIP_SECONDS.LEG_SHOT_FALL,
    intensity: rx.intensity > 0 ? rx.intensity : 0.8,
    hitDirectionWorld: rx.hitDirectionWorld,
    postureOverride: 'LEG_BUCKLED',
  });
}
