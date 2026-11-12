import type { GhoulZoneId, TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES } from '../../ghoul/anatomy/ghoulHierarchyTypes.ts';
import { computePelvisFrame } from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { add, cross, scale, sub, vec3 } from '../vec3.ts';
import { isRagdollBoneParticleActive } from './ragdollParticles.ts';

const GRAVITY_MS2 = 9.81;
const POSE_STIFFNESS = 42.0;
const POSE_DAMPING = 8.5;
const MAX_POSE_ACCEL_MS2 = 28.0;
const SEAT_ZONES: readonly GhoulZoneId[] = ['PELVIS_GROIN', 'THIGH_RIGHT', 'THIGH_LEFT'];
const MAX_SEAT_REACTION_MS2 = 4.5;

export type MuscleDrive = Partial<Record<GhoulZoneId, Vec3Like>>;

/**
 * Accelerations that pull a living downed body toward its pose targets, scaled by muscle tone.
 * Muscles can only pull one part of the body against another, so every horizontal pull is
 * matched by a push on the pelvis and hips: the body can hold itself up, but it cannot row
 * itself along the floor.
 */
export function computeMuscleDrive(
  target: TargetHealthState,
  poseTargets: Partial<Record<GhoulZoneId, Vec3Like>>,
  muscleTone: number
): MuscleDrive {
  const drive: MuscleDrive = {};
  let netForceX = 0;
  let netForceZ = 0;
  let drivenMassKg = 0;

  for (const zone of Object.keys(poseTargets) as GhoulZoneId[]) {
    const desired = poseTargets[zone];
    const bone = target.ragdollBones[zone];
    if (!desired || bone.componentId !== 'BODY' || !isRagdollBoneParticleActive(target, bone)) continue;

    const accel = vec3(
      ((desired.x - bone.position.x) * POSE_STIFFNESS - bone.velocity.x * POSE_DAMPING) * muscleTone,
      ((desired.y - bone.position.y) * POSE_STIFFNESS - bone.velocity.y * POSE_DAMPING) * muscleTone,
      ((desired.z - bone.position.z) * POSE_STIFFNESS - bone.velocity.z * POSE_DAMPING) * muscleTone
    );
    const magnitude = Math.hypot(accel.x, accel.y, accel.z);
    if (magnitude > MAX_POSE_ACCEL_MS2) {
      const s = MAX_POSE_ACCEL_MS2 / magnitude;
      accel.x *= s;
      accel.y *= s;
      accel.z *= s;
    }
    // Holding a posture carries part of the limb's own weight.
    accel.y += GRAVITY_MS2 * muscleTone;

    drive[zone] = accel;
    netForceX += accel.x * bone.massKg;
    netForceZ += accel.z * bone.massKg;
    drivenMassKg += bone.massKg;
  }

  // The pulls are braced against the seat of the body: the pelvis and hips take the equal and
  // opposite push. It is kept below what their grip on the floor can hold, so posing never
  // slides the body along.
  const seat = SEAT_ZONES.map((zone) => target.ragdollBones[zone]).filter(
    (bone) => bone.componentId === 'BODY' && isRagdollBoneParticleActive(target, bone)
  );
  const seatMassKg = seat.reduce((sum, bone) => sum + bone.massKg, 0);
  if (drivenMassKg <= 0 || seatMassKg <= 0) return drive;

  const netForce = Math.hypot(netForceX, netForceZ);
  const holdable = seatMassKg * MAX_SEAT_REACTION_MS2;
  const ease = netForce > holdable ? holdable / netForce : 1;
  for (const zone of Object.keys(drive) as GhoulZoneId[]) {
    drive[zone]!.x *= ease;
    drive[zone]!.z *= ease;
  }
  for (const bone of seat) {
    const braced = drive[bone.zone] ?? (drive[bone.zone] = vec3(0, 0, 0));
    braced.x -= (netForceX * ease) / seatMassKg;
    braced.z -= (netForceZ * ease) / seatMassKg;
  }
  return drive;
}

const LEG_ZONE_PREFIXES = ['THIGH_', 'KNEE_', 'SHIN_', 'FOOT_'];
const SLUMP_TURN_RATE_RAD_S = 3.2;
const PROPPED_UP_HEIGHT_M = 0.3;

/**
 * The moment a downed combatant dies, the muscles propping the torso up let go. A body sitting
 * over its hips is balanced and would stay sitting, so everything above the hips is set turning
 * backward about the hip line, as one piece, and gravity does the rest. A body already lying
 * down is left alone.
 */
export function releaseMuscleTone(target: TargetHealthState): void {
  const bones = target.ragdollBones;
  const pelvis = bones.PELVIS_GROIN;
  const frame = computePelvisFrame(target);
  if (!frame || bones.HEAD_CRANIUM.position.y - pelvis.position.y < PROPPED_UP_HEIGHT_M) return;

  const hips = [bones.THIGH_RIGHT, bones.THIGH_LEFT].filter((hip) => hip.componentId === 'BODY');
  const pivot = hips.length
    ? scale(hips.reduce((sum, hip) => add(sum, hip.position), vec3(0, 0, 0)), 1 / hips.length)
    : pelvis.position;

  const turn = (particle: { position: Vec3Like; velocity: Vec3Like; componentId: string }): void => {
    if (particle.componentId !== 'BODY') return;
    const swing = cross(frame.right, sub(particle.position, pivot));
    particle.velocity.x -= swing.x * SLUMP_TURN_RATE_RAD_S;
    particle.velocity.y -= swing.y * SLUMP_TURN_RATE_RAD_S;
    particle.velocity.z -= swing.z * SLUMP_TURN_RATE_RAD_S;
  };
  for (const zone of ALL_GHOUL_ZONES) {
    if (!LEG_ZONE_PREFIXES.some((prefix) => zone.startsWith(prefix))) turn(bones[zone]);
  }
  for (const id of ['HEAD_TOP', 'HAND_TIP_RIGHT', 'HAND_TIP_LEFT'] as const) turn(target.auxParticles[id]);
}
