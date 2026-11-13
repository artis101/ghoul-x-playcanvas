import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { type BodySide, oppositeSide, sideSignX, triggerSide } from '../../ghoul/anatomy/handedness.ts';
import { add, cross, dot, normalize, scale, sub, vec3 } from '../vec3.ts';
import { MIN_LYING_SPAN_M } from './downedAimReach.ts';
import { isDownedArmUsable } from './downedGunSide.ts';
import { PELVIS_ON_FLOOR_M, isFaceDownShape } from './faceDownLanding.ts';

const DEG = Math.PI / 180;
interface LyingShape {
  /** How far the chest is raised off the floor, measured along the spine. */
  readonly reclineRad: number;
  /** Propped on an elbow, the body rolls toward it and that shoulder drops. */
  readonly rollRad: number;
  readonly lean: number;
}
// Down on its butt, braced on the free hand behind it; with no free hand it leans back further.
const SEATED: LyingShape = { reclineRad: 64 * DEG, rollRad: 0, lean: 0 };
const SEATED_UNBRACED: LyingShape = { reclineRad: 50 * DEG, rollRad: 0, lean: 0 };
const PRONE: LyingShape = { reclineRad: 24 * DEG, rollRad: 12 * DEG, lean: 0.12 };
// Distances along the spine from the pelvis, and across the body from its midline.
const ABDOMEN_M = 0.15;
const THORAX_M = 0.35;
const CHEST_TOP_M = 0.55;
const NECK_M = 0.6;
const HEAD_M = 0.11;
const SHOULDER_HALF_WIDTH_M = 0.2;
const HIP_HALF_WIDTH_M = 0.115;
// How far the head turns from where the body faces toward where the gun points.
const HEAD_FOLLOWS_AIM = 0.75;
const armUsable = isDownedArmUsable;

function legUsable(target: TargetHealthState, side: BodySide): boolean {
  const functional = side === 'RIGHT' ? target.rightLegFunctional : target.leftLegFunctional;
  return functional && target.ragdollBones[`KNEE_${side}`].componentId === 'BODY';
}

/**
 * Muscle-tone targets for a living combatant lying on the ground, posed the way a wounded
 * shooter lies to keep fighting. The pose follows how the body landed:
 *
 * - Fallen back, it sits up on its butt, braced on the free hand planted behind it, legs out in
 *   front, leaving the gun arm clear to point out over its legs.
 * - With only the gun arm left, it sits leaning further back with nothing to brace on.
 * - On its front, it pushes its chest up on the free elbow, legs trailing, head craned up.
 *
 * The head looks where the gun points. The gun arm itself is left alone: whatever holds the
 * weapon aims it.
 */
export function buildLivingGroundedPoseTargets(
  target: TargetHealthState,
  floorY: number,
  agonyTimeS: number
): Partial<Record<GhoulZoneId, Vec3Like>> | null {
  if (!target.alive || !target.isRagdollActive) return null;

  const pelvis = target.ragdollBones.PELVIS_GROIN;
  if (pelvis.componentId !== 'BODY' || pelvis.position.y > floorY + PELVIS_ON_FLOOR_M) {
    return null;
  }

  const up = vec3(0, 1, 0);
  // The pose is laid out along the way the body actually fell, so the muscles only ever lift it
  // and never try to swing it round on the floor.
  const yawForward = vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad));
  const thorax = target.ragdollBones.TORSO_UPPER_THORAX.position;
  const lie = vec3(thorax.x - pelvis.position.x, 0, thorax.z - pelvis.position.z);
  const lying = Math.hypot(lie.x, lie.z) > MIN_LYING_SPAN_M;
  const headW = lying ? normalize(lie) : scale(yawForward, -1);
  const feetW = scale(headW, -1);
  // The same test the wounded sequence uses to mark a body FACE_DOWN (no gun, no damage).
  const faceDown = lying && isFaceDownShape(target);
  const leftW = scale(cross(headW, up), faceDown ? -1 : 1);

  const preferredGunSide = triggerSide(target.isLeftHanded);
  const gunSide = armUsable(target, preferredGunSide) ? preferredGunSide : oppositeSide(preferredGunSide);
  const propSide = oppositeSide(gunSide);
  const propped = armUsable(target, propSide);
  // Points across the body toward the elbow it leans on.
  const propW = scale(leftW, sideSignX(propSide));
  const shape = faceDown ? PRONE : propped ? SEATED : SEATED_UNBRACED;

  const heave = Math.sin(agonyTimeS * 1.9) * 0.025;
  const recline = shape.reclineRad + heave;
  const lean = propped ? shape.lean : 0;
  const roll = propped ? shape.rollRad : 0;

  const anchorP = vec3(pelvis.position.x, floorY + pelvis.radiusM + 0.015, pelvis.position.z);
  const spineDir = normalize(add(add(scale(headW, Math.cos(recline)), scale(up, Math.sin(recline))), scale(propW, lean)));
  const along = (distanceM: number): Vec3Like => add(anchorP, scale(spineDir, distanceM));

  const neckPos = along(NECK_M);
  // Sitting, it looks out past its feet. On its front the head cranes up to look ahead. Either
  // way it turns to look down the gun, as far as a neck turns.
  const restingLook = faceDown ? normalize(add(headW, scale(up, 0.35))) : normalize(add(feetW, scale(up, 0.15)));
  const aim = target.downedAimDirWorld;
  const faceW =
    aim && dot(aim, restingLook) > -0.2
      ? normalize(add(scale(restingLook, 1 - HEAD_FOLLOWS_AIM), scale(normalize(aim), HEAD_FOLLOWS_AIM)))
      : restingLook;
  const lookW = faceDown
    ? add(scale(spineDir, 0.3), scale(up, 0.8))
    : add(scale(spineDir, 0.6), scale(faceW, 0.4));
  const headPos = add(neckPos, scale(normalize(lookW), HEAD_M));
  const chestTop = along(CHEST_TOP_M);
  const shoulderReach = scale(propW, SHOULDER_HALF_WIDTH_M * Math.cos(roll));
  const shoulderDrop = SHOULDER_HALF_WIDTH_M * Math.sin(roll);
  const propShoulder = add(add(chestTop, shoulderReach), vec3(0, -shoulderDrop, 0));
  const gunShoulder = add(add(chestTop, scale(shoulderReach, -1)), vec3(0, shoulderDrop, 0));

  const targets: Partial<Record<GhoulZoneId, Vec3Like>> = {
    TORSO_LOWER_ABDOMEN: along(ABDOMEN_M),
    TORSO_UPPER_THORAX: along(THORAX_M),
    NECK_CERVICAL: neckPos,
    HEAD_CRANIUM: headPos,
    HEAD_FACE_JAW: add(headPos, add(scale(faceW, 0.08), vec3(0, -0.05, 0))),
    [`SHOULDER_${propSide}`]: propShoulder,
    [`SHOULDER_${gunSide}`]: gunShoulder,
  };

  const onFloor = (point: Vec3Like, heightM: number): Vec3Like => vec3(point.x, floorY + heightM, point.z);

  if (propped && !faceDown) {
    // Arm braced straight back, hand planted on the floor behind and out from the hip.
    const hand = onFloor(add(add(anchorP, scale(propW, HIP_HALF_WIDTH_M + 0.14)), scale(headW, 0.2)), 0.045);
    targets[`HAND_${propSide}`] = hand;
    targets[`FOREARM_${propSide}`] = add(scale(add(propShoulder, hand), 0.5), scale(propW, 0.04));
  } else if (propped) {
    // Forearm flat on the floor by the shoulder, pointing the way the body faces.
    const elbow = onFloor(add(add(propShoulder, scale(propW, faceDown ? 0.06 : 0.1)), scale(headW, 0.05)), 0.05);
    targets[`FOREARM_${propSide}`] = elbow;
    targets[`HAND_${propSide}`] = onFloor(add(add(elbow, scale(headW, 0.24)), scale(propW, -0.07)), 0.045);
  }

  // The legs are laid out by the hips' own left and right, so a body that landed twisted does
  // not drag one leg across the other.
  const lb = target.ragdollBones;
  const hipsTwisted =
    lb.THIGH_LEFT.componentId === 'BODY' &&
    lb.THIGH_RIGHT.componentId === 'BODY' &&
    dot(sub(lb.THIGH_LEFT.position, lb.THIGH_RIGHT.position), leftW) < 0;
  const legW = hipsTwisted ? scale(propW, -1) : propW;
  const propHip = add(anchorP, scale(legW, HIP_HALF_WIDTH_M));
  const gunHip = add(anchorP, scale(legW, -HIP_HALF_WIDTH_M));
  if (!faceDown) {
    // Sat square on its butt: both hips level on the floor, not rolled onto one side.
    for (const [side, hip] of [[propSide, propHip], [gunSide, gunHip]] as const) {
      if (lb[`THIGH_${side}`].componentId === 'BODY') targets[`THIGH_${side}`] = vec3(hip.x, anchorP.y, hip.z);
    }
  }
  const layLeg = (side: BodySide, knee: Vec3Like, foot: Vec3Like): void => {
    if (target.ragdollBones[`KNEE_${side}`].componentId !== 'BODY') return;
    if (!legUsable(target, side)) {
      // A useless leg is not held anywhere, but it is not left doubled under the body either:
      // it lies out straight from the hip, the way a dragged leg trails.
      const hip = side === propSide ? propHip : gunHip;
      const splay = scale(legW, (side === propSide ? 1 : -1) * 0.06);
      knee = onFloor(add(add(hip, scale(feetW, 0.38)), splay), 0.065);
      foot = onFloor(add(add(knee, scale(feetW, 0.43)), splay), 0.065);
    }
    targets[`KNEE_${side}`] = knee;
    targets[`SHIN_${side}`] = scale(add(knee, foot), 0.5);
    targets[`FOOT_${side}`] = foot;
  };
  if (faceDown) {
    // Both legs trail flat behind, a little apart.
    for (const [side, hip, splay] of [[propSide, propHip, 0.05], [gunSide, gunHip, -0.05]] as const) {
      const knee = onFloor(add(add(hip, scale(feetW, 0.35)), scale(legW, splay)), 0.065);
      layLeg(side, knee, onFloor(add(add(knee, scale(feetW, 0.43)), scale(legW, splay)), 0.065));
    }
  } else {
    // The leg it lies on rests along the floor. The upper leg plants its foot, knee raised.
    const restingKnee = onFloor(add(add(propHip, scale(feetW, 0.33)), scale(legW, 0.12)), 0.065);
    layLeg(propSide, restingKnee, onFloor(add(add(restingKnee, scale(feetW, 0.42)), scale(legW, -0.1)), 0.065));
    layLeg(
      gunSide,
      onFloor(add(gunHip, scale(feetW, 0.36)), propped ? 0.27 : 0.2),
      onFloor(add(gunHip, scale(feetW, propped ? 0.74 : 0.76)), 0.065)
    );
  }

  return targets;
}
