import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import {
  type BodyFrame,
  computeChestFrame,
  computePelvisFrame,
  rejectFromAxis,
} from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { Vec3Like, add, cross, dot, length, normalize, scale, sub } from '../vec3.ts';
import {
  DEG,
  type LimitEffort,
  type LimitParticle,
  type SwingLimits,
  clampConeDirection,
  clampSwingDirection,
  driveParticleBy,
  driveSegmentToward,
  turnAbout,
} from './ragdollJointLimitMath.ts';

// Approximate passive ranges of motion of an adult.
const LUMBAR: SwingLimits = { forward: 45 * DEG, back: 15 * DEG, outward: 20 * DEG, inward: 20 * DEG };
const THORACIC: SwingLimits = { forward: 30 * DEG, back: 10 * DEG, outward: 15 * DEG, inward: 15 * DEG };
const NECK: SwingLimits = { forward: 45 * DEG, back: 30 * DEG, outward: 30 * DEG, inward: 30 * DEG };
const SKULL: SwingLimits = { forward: 25 * DEG, back: 25 * DEG, outward: 20 * DEG, inward: 20 * DEG };
const HIP_MAX_FLEXION = 120 * DEG;
const HIP_MAX_EXTENSION = 15 * DEG;
const HIP_MAX_ABDUCTION = 50 * DEG;
const HIP_MAX_ADDUCTION = 25 * DEG;
const ANKLE: SwingLimits = { forward: 55 * DEG, back: 25 * DEG, outward: 30 * DEG, inward: 30 * DEG };
const KNEE_MAX_FLEX = 150 * DEG;
const KNEE_MAX_SWIVEL = 40 * DEG;
const SHOULDER_MAX_SWING = 110 * DEG;
const TORSO_MAX_TWIST = 40 * DEG;
const TORSO_MAX_TWIST_ONE_HIP = 12 * DEG;

const SIDES = ['LEFT', 'RIGHT'] as const;

function attached(...particles: { componentId: string }[]): boolean {
  return particles.every((p) => p.componentId === 'BODY');
}

function direction(from: LimitParticle, to: LimitParticle): Vec3Like {
  return normalize(sub(to.position, from.position));
}

/** Limits how far `child` swings about `pivot`, measured in a frame whose up is `axis`. */
function limitSwing(
  pivot: LimitParticle,
  child: LimitParticle,
  axis: Vec3Like,
  sideHint: Vec3Like,
  limits: SwingLimits,
  effort: LimitEffort
): void {
  const sideRaw = rejectFromAxis(sideHint, axis);
  if (length(sideRaw) < 0.2) return;
  const side = normalize(sideRaw);
  const clamped = clampSwingDirection(direction(pivot, child), axis, side, cross(side, axis), limits);
  if (clamped) driveSegmentToward(pivot, child, clamped, effort);
}

/**
 * A hip moves like a two-axis gimbal: the thigh swings forward and back in the body's sagittal
 * plane, and leans out of that plane to the side. Limiting the two angles separately allows a
 * deep squat with the knees apart, which a single cone around the standing leg would not.
 */
function clampHipDirection(
  thighDir: Vec3Like,
  outward: Vec3Like,
  down: Vec3Like,
  forward: Vec3Like
): Vec3Like | null {
  const lean = Math.asin(Math.max(-1, Math.min(1, dot(thighDir, outward))));
  const swing = Math.atan2(dot(thighDir, forward), dot(thighDir, down));
  const leanClamped = Math.max(-HIP_MAX_ADDUCTION, Math.min(HIP_MAX_ABDUCTION, lean));
  // Past the midpoint of the forbidden arc behind the body, folding forward is the nearer way out.
  const wrapPoint = (HIP_MAX_FLEXION - HIP_MAX_EXTENSION) / 2 - Math.PI;
  let swingClamped = swing;
  if (swing > HIP_MAX_FLEXION || swing < wrapPoint) swingClamped = HIP_MAX_FLEXION;
  else if (swing < -HIP_MAX_EXTENSION) swingClamped = -HIP_MAX_EXTENSION;
  if (Math.abs(leanClamped - lean) < 0.01 && Math.abs(swingClamped - swing) < 0.01) return null;
  const inPlane = Math.cos(leanClamped);
  return add(
    scale(outward, Math.sin(leanClamped)),
    add(scale(down, inPlane * Math.cos(swingClamped)), scale(forward, inPlane * Math.sin(swingClamped)))
  );
}

function limitSpineAndNeck(
  target: TargetHealthState,
  pelvis: BodyFrame | null,
  chest: BodyFrame | null,
  effort: LimitEffort
): void {
  const b = target.ragdollBones;
  const abdomen = b.TORSO_LOWER_ABDOMEN;
  const thorax = b.TORSO_UPPER_THORAX;
  const neck = b.NECK_CERVICAL;
  const head = b.HEAD_CRANIUM;
  if (pelvis && attached(b.PELVIS_GROIN, abdomen, thorax)) {
    limitSwing(abdomen, thorax, pelvis.up, pelvis.right, LUMBAR, effort);
  }
  if (!chest) return;
  if (attached(abdomen, thorax, neck)) {
    limitSwing(thorax, neck, direction(abdomen, thorax), chest.right, THORACIC, effort);
  }
  if (!attached(thorax, neck, head) || head.goreMode === 'CRANIAL_POP') return;
  limitSwing(neck, head, chest.up, chest.right, NECK, effort);
  const crown = target.auxParticles.HEAD_TOP;
  if (attached(crown)) limitSwing(head, crown, direction(neck, head), chest.right, SKULL, effort);
}

/** Ball-and-socket hips, hinge knees that only fold backward, and feet that follow the shin. */
function limitLegs(target: TargetHealthState, pelvis: BodyFrame, effort: LimitEffort): void {
  const b = target.ragdollBones;
  const down = scale(pelvis.up, -1);
  for (const side of SIDES) {
    const thigh = b[`THIGH_${side}`];
    const knee = b[`KNEE_${side}`];
    if (!attached(b.PELVIS_GROIN, thigh, knee)) continue;

    const outSign = dot(sub(thigh.position, b.PELVIS_GROIN.position), pelvis.right) >= 0 ? 1 : -1;
    const hipDir = clampHipDirection(direction(thigh, knee), scale(pelvis.right, outSign), down, pelvis.forward);
    if (hipDir) driveSegmentToward(thigh, knee, hipDir, effort);

    const shin = b[`SHIN_${side}`];
    const foot = b[`FOOT_${side}`];
    if (!attached(shin, foot)) continue;
    const thighDir = direction(thigh, knee);
    const hingeRaw = rejectFromAxis(pelvis.right, thighDir);
    if (length(hingeRaw) < 0.25) continue;
    const hinge = normalize(hingeRaw);
    const behind = cross(hinge, thighDir);

    // The shin folds back from the thigh by `flex`. Rotation at the hip swings a bent shin
    // sideways about the thigh, which a straight leg cannot show.
    const shinDir = direction(knee, foot);
    const along = Math.max(-1, Math.min(1, dot(shinDir, thighDir)));
    const flex = Math.acos(along);
    const offAxis = Math.sin(flex);
    const swivel = Math.atan2(dot(shinDir, hinge), dot(shinDir, behind));
    let wanted: Vec3Like | null = null;
    if (offAxis > 0.05 && Math.abs(swivel) > 90 * DEG) {
      // Bent the wrong way: straighten out.
      wanted = thighDir;
    } else if (offAxis > 0.05 && (Math.abs(swivel) > KNEE_MAX_SWIVEL || flex > KNEE_MAX_FLEX)) {
      const flexClamped = Math.min(flex, KNEE_MAX_FLEX);
      const swivelClamped = Math.max(-KNEE_MAX_SWIVEL, Math.min(KNEE_MAX_SWIVEL, swivel));
      const folded = add(scale(behind, Math.cos(swivelClamped)), scale(hinge, Math.sin(swivelClamped)));
      wanted = add(scale(thighDir, Math.cos(flexClamped)), scale(folded, Math.sin(flexClamped)));
    }
    if (wanted) {
      driveSegmentToward(knee, shin, wanted, effort);
      driveSegmentToward(knee, foot, wanted, effort);
    }

    const toe = target.auxParticles[`FOOT_TOE_${side}`];
    if (!attached(toe)) continue;
    const lowerLeg = direction(knee, foot);
    const toeAxis = normalize(cross(lowerLeg, hinge));
    const clamped = clampSwingDirection(direction(foot, toe), toeAxis, hinge, cross(hinge, toeAxis), ANKLE);
    if (clamped) driveSegmentToward(foot, toe, clamped, effort);
  }
}

/** Keeps each upper arm inside the shoulder's reach, out of the ribcage and the spine. */
function limitShoulders(target: TargetHealthState, chest: BodyFrame, effort: LimitEffort): void {
  const b = target.ragdollBones;
  for (const side of SIDES) {
    const upperArm = b[`UPPER_ARM_${side}`];
    const forearm = b[`FOREARM_${side}`];
    if (!attached(b.TORSO_UPPER_THORAX, upperArm, forearm)) continue;
    const outSign = dot(sub(upperArm.position, b.TORSO_UPPER_THORAX.position), chest.right) >= 0 ? 1 : -1;
    const reach = normalize(
      add(add(scale(chest.right, 0.7 * outSign), scale(chest.up, -0.25)), scale(chest.forward, 0.67))
    );
    const clamped = clampConeDirection(direction(upperArm, forearm), reach, SHOULDER_MAX_SWING);
    if (clamped) driveSegmentToward(upperArm, forearm, clamped, effort);
  }
}

/** The shoulder line may only turn so far against the hip line about the spine. */
function limitTorsoTwist(
  target: TargetHealthState,
  pelvis: BodyFrame,
  chest: BodyFrame,
  effort: LimitEffort
): void {
  const b = target.ragdollBones;
  const hips = SIDES.map((side) => b[`THIGH_${side}`]).filter((thigh) => attached(thigh));
  if (hips.length === 0 || !attached(b.PELVIS_GROIN, b.TORSO_UPPER_THORAX)) return;
  const spine = direction(b.PELVIS_GROIN, b.TORSO_UPPER_THORAX);
  const hipLine = rejectFromAxis(pelvis.right, spine);
  const shoulderLine = rejectFromAxis(chest.right, spine);
  if (length(hipLine) < 0.3 || length(shoulderLine) < 0.3) return;

  const twist = Math.atan2(dot(cross(hipLine, shoulderLine), spine), dot(hipLine, shoulderLine));
  // With a leg gone, one hip is all that carries the pelvis's heading, so it is held closer.
  const excess = Math.abs(twist) - (hips.length === 2 ? TORSO_MAX_TWIST : TORSO_MAX_TWIST_ONE_HIP);
  if (excess <= 0) return;
  const unwind = -Math.sign(twist) * excess;
  const shoulderMid = scale(add(b.SHOULDER_LEFT.position, b.SHOULDER_RIGHT.position), 0.5);
  for (const shoulder of [b.SHOULDER_LEFT, b.SHOULDER_RIGHT]) {
    driveParticleBy(shoulder, turnAbout(shoulder.position, shoulderMid, spine, unwind * 0.6), effort);
  }
  for (const thigh of hips) {
    driveParticleBy(thigh, turnAbout(thigh.position, b.PELVIS_GROIN.position, spine, -unwind * 0.4), effort);
  }
}

/**
 * One pass of the body's anatomical joint limits, applied to particle velocities after the
 * position solve. Distance constraints alone let a particle ragdoll fold knees forward, splay
 * hips flat and wring the torso; these keep every joint of the attached body inside a human
 * range of motion. `effort` sets how hard a joint already outside its range is pushed back;
 * a corpse that has come to rest is no longer pushed at all.
 */
export function applyAnatomicalJointLimits(target: TargetHealthState, effort: LimitEffort): void {
  const pelvis = computePelvisFrame(target);
  const chest = computeChestFrame(target);
  limitSpineAndNeck(target, pelvis, chest, effort);
  if (pelvis) limitLegs(target, pelvis, effort);
  if (chest) limitShoulders(target, chest, effort);
  if (pelvis && chest) limitTorsoTwist(target, pelvis, chest, effort);
}
