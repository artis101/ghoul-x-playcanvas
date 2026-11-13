import type {
  DeathClipId,
  GhoulZoneId,
  ShotSimulationReport,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { isLimbLossFatal } from '../trauma/limbLossDeathRule.ts';
import { isFallingReaction } from '../trauma/woundReactionTimings.ts';
import { copyVec3 } from '../vec3.ts';

/**
 * Dying on your feet. A combatant killed while it stands, walks, flinches, clutches or kneels does
 * not drop straight into the ragdoll: it plays one of the authored death clips, dead but still
 * animated, and the corpse ragdoll takes over from the clip's last pose (deathAnimationStep.ts).
 * A blast, a hit hard enough to knock the body over, a lost leg, and any body already on the floor
 * (seated, crawling, falling or ragdolled) still go straight to the ragdoll.
 */

/** Lengths of the death clips in ghoul_combatant.glb, in seconds. Keep in step with the bake. */
export const DEATH_CLIP_SECONDS: Readonly<Record<DeathClipId, number>> = {
  DeathFallBack: 1.5,
  DeathFallForward: 1.5,
  DeathCrumple: 1.0,
  DeathSpin: 1.37,
  DeathBleedOut: 3.17,
};

/** Horizontal hit impulse (N·s) that throws a body off its feet instead of letting it fall. */
export const KNOCKDOWN_IMPULSE_NS = 230.0;

const HEAD_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>(['HEAD_CRANIUM', 'HEAD_FACE_JAW', 'NECK_CERVICAL']);
const SIDE_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'SHOULDER_RIGHT', 'UPPER_ARM_RIGHT', 'SHOULDER_LEFT', 'UPPER_ARM_LEFT',
]);
const LEG_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'THIGH_RIGHT', 'KNEE_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT',
  'THIGH_LEFT', 'KNEE_LEFT', 'SHIN_LEFT', 'FOOT_LEFT',
]);
const ARM_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 'HAND_RIGHT', 'UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT',
]);

/** True while a dead body is still on its feet playing its death clip. */
export function isDyingAnimated(hs: TargetHealthState): boolean {
  return !hs.alive && !hs.isRagdollActive && hs.dying != null;
}

/** The death clip this body plays right now, or null when it is not dying on its feet. */
export function deathClipFor(hs: TargetHealthState): DeathClipId | null {
  return isDyingAnimated(hs) && hs.dying ? hs.dying.clip : null;
}

/**
 * True when a living body is upright and animated, so a death now can play a clip. Read it before
 * the killing blow is applied: a death clears the reaction it was playing.
 */
export function canAnimateDeath(hs: TargetHealthState): boolean {
  if (!hs.alive || hs.isRagdollActive) return false;
  if (!hs.rightLegFunctional || !hs.leftLegFunctional) return false;
  const phase = hs.woundedPhase;
  if (
    phase === 'SIT_DOWN' || phase === 'DOWNED_ENGAGE' || phase === 'DOWNED_AGONY' ||
    phase === 'DOWNED_CRAWL' || phase === 'FACE_DOWN'
  ) {
    return false;
  }
  const rx = hs.activeReaction.type;
  return rx === 'NONE' || !isFallingReaction(rx);
}

/** A blast, or a hit hard enough to throw the body: the ragdoll takes it at once. */
export function isKnockdownBlow(report: ShotSimulationReport): boolean {
  if (report.isExplosiveBlast) return true;
  const imp = report.ragdollPlan.netRootImpulseWorld;
  return Math.hypot(imp.x, imp.z) >= KNOCKDOWN_IMPULSE_NS;
}

/**
 * How a body this shot kills goes down: the death clip to play, or null for the ragdoll. Call it
 * with the body's state from before the shot is applied.
 */
export function planShotDeath(hs: TargetHealthState, report: ShotSimulationReport): DeathClipId | null {
  if (!canAnimateDeath(hs) || isKnockdownBlow(report)) return null;
  // A leg taken off cannot stand through a clip.
  if (report.dismembermentEvents.some((d) => LEG_ZONES.has(d.zone))) return null;
  return chooseShotDeathClip(hs, report);
}

/**
 * Picks the clip for a shot kill: a destroyed brain or spine, or any head or neck kill, drops the
 * body where it stands; losing the arms leaves it to bleed out; a shot from behind or into the gut
 * folds it forward; a shot from the side or into the shoulder spins it; anything else throws it
 * back.
 */
export function chooseShotDeathClip(hs: TargetHealthState, report: ShotSimulationReport): DeathClipId {
  const zone = report.ragdollPlan.primaryHitZone ?? report.woundEvents[0]?.ghoulZone ?? null;
  const cnsDestroyed =
    report.rupturedOrgans.includes('Brain (Cerebrum & Brainstem)') ||
    report.shatteredBones.includes('Cervical Spine (C1-C7)') ||
    report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP' || d.zone === 'NECK_CERVICAL');
  if (cnsDestroyed || (zone !== null && HEAD_ZONES.has(zone))) return 'DeathCrumple';

  if (report.dismembermentEvents.some((d) => ARM_ZONES.has(d.zone))) {
    const severed = new Set<GhoulZoneId>(hs.severedZones);
    for (const z of report.severedZones) severed.add(z);
    if (isLimbLossFatal(severed)) return 'DeathBleedOut';
  }

  const dir = report.woundEvents[0]?.impactDirectionWorld ?? report.aimDirectionWorld;
  const len = Math.hypot(dir.x, dir.z);
  const sinY = Math.sin(hs.yawRad);
  const cosY = Math.cos(hs.yawRad);
  // Along > 0: the round travels the way the body faces, so it came in from behind.
  const along = len > 1e-6 ? (dir.x * sinY + dir.z * cosY) / len : -1;
  const lateral = len > 1e-6 ? Math.abs(dir.x * cosY - dir.z * sinY) / len : 0;

  if (along > lateral) return 'DeathFallForward';
  const gutShot =
    zone === 'TORSO_LOWER_ABDOMEN' || report.dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED');
  if (gutShot) return 'DeathFallForward';
  if ((zone !== null && SIDE_ZONES.has(zone)) || lateral > Math.abs(along)) return 'DeathSpin';
  return 'DeathFallBack';
}

/**
 * Starts the death clip on a body that has just died (`alive` already false). The gun leaves the
 * hands at once and any reaction or status stops; the body stays out of the ragdoll until the
 * clip ends. The caller syncs the derived lifecycle state.
 */
export function startDeathAnimation(hs: TargetHealthState, clip: DeathClipId): void {
  hs.dying = { clip, timerS: 0, durationS: DEATH_CLIP_SECONDS[clip] };
  hs.weaponDropped = true;
  hs.activeReaction.type = 'NONE';
  hs.activeReaction.timerS = 0;
  hs.combatantStatusTag = null;
}

/** A hit on a body playing its death clip only jolts it; the clip carries on. */
export function joltDyingBody(hs: TargetHealthState, hitDirectionWorld: Vec3Like, energyJ: number): void {
  hs.joltEpoch = (hs.joltEpoch ?? 0) + 1;
  hs.lastJoltDirectionWorld = copyVec3(hitDirectionWorld);
  hs.lastJoltIntensity = Math.min(1.3, 0.5 + energyJ / 900);
}
