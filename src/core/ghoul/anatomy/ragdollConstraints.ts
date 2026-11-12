import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import {
  AuxParticleId,
  RagdollDistanceConstraint,
} from '../../../contracts/ballistics/targetHealthContracts';
import { Vec3Like, distance } from '../../ballistics/vec3';
import { GHOUL_ZONE_HIERARCHY } from './ghoulHierarchy';
import { AUX_PARTICLE_REST_LOCAL } from './ghoulAuxParticles';

export function getRestLocalPosition(id: GhoulZoneId | AuxParticleId): Vec3Like {
  if (id in GHOUL_ZONE_HIERARCHY) {
    return GHOUL_ZONE_HIERARCHY[id as GhoulZoneId].jointLocalPos;
  }
  return AUX_PARTICLE_REST_LOCAL[id as AuxParticleId].localPos;
}

/**
 * Builds the Position-Based Dynamics (PBD) structural + anatomical joint-angle constraints
 * for the 27-point ragdoll so corpses maintain cohesive human skeletal rigidity.
 */
export function buildRagdollConstraints(): RagdollDistanceConstraint[] {
  const constraints: RagdollDistanceConstraint[] = [];

  const addExactLink = (
    a: GhoulZoneId | AuxParticleId,
    b: GhoulZoneId | AuxParticleId,
    stiffness = 1.0
  ) => {
    const rest = distance(getRestLocalPosition(a), getRestLocalPosition(b));
    constraints.push({
      id: `link_${a}_${b}`,
      nodeA: a,
      nodeB: b,
      restLength: rest,
      minLength: rest,
      maxLength: rest,
      stiffness,
    });
  };

  const addRangeLimit = (
    a: GhoulZoneId | AuxParticleId,
    b: GhoulZoneId | AuxParticleId,
    minScale: number,
    maxScale: number,
    stiffness = 0.75
  ) => {
    const rest = distance(getRestLocalPosition(a), getRestLocalPosition(b));
    constraints.push({
      id: `limit_${a}_${b}`,
      nodeA: a,
      nodeB: b,
      restLength: rest,
      minLength: rest * minScale,
      maxLength: rest * maxScale,
      stiffness,
    });
  };

  const addMeterBounds = (
    a: GhoulZoneId | AuxParticleId,
    b: GhoulZoneId | AuxParticleId,
    minMeters: number,
    maxMeters: number,
    stiffness = 0.75
  ) => {
    const rest = distance(getRestLocalPosition(a), getRestLocalPosition(b));
    constraints.push({
      id: `bounds_${a}_${b}`,
      nodeA: a,
      nodeB: b,
      restLength: rest,
      minLength: minMeters,
      maxLength: maxMeters,
      stiffness,
    });
  };

  // 1. Primary Skeleton Bone Segments
  addExactLink('PELVIS_GROIN', 'TORSO_LOWER_ABDOMEN', 1.0);
  addExactLink('TORSO_LOWER_ABDOMEN', 'TORSO_UPPER_THORAX', 1.0);
  addExactLink('TORSO_UPPER_THORAX', 'NECK_CERVICAL', 1.0);
  addExactLink('NECK_CERVICAL', 'HEAD_CRANIUM', 1.0);
  addExactLink('HEAD_CRANIUM', 'HEAD_TOP', 1.0);
  addExactLink('HEAD_CRANIUM', 'HEAD_FACE_JAW', 1.0);
  addExactLink('NECK_CERVICAL', 'HEAD_FACE_JAW', 1.0);
  addExactLink('HEAD_TOP', 'HEAD_FACE_JAW', 1.0);

  // 2. Rigid 3D Thoracic Ribcage + Natural Articulated Shoulder Sockets
  addExactLink('TORSO_UPPER_THORAX', 'SHOULDER_RIGHT', 1.0);
  addExactLink('TORSO_UPPER_THORAX', 'SHOULDER_LEFT', 1.0);
  addExactLink('NECK_CERVICAL', 'SHOULDER_RIGHT', 1.0);
  addExactLink('NECK_CERVICAL', 'SHOULDER_LEFT', 1.0);
  addExactLink('SHOULDER_RIGHT', 'SHOULDER_LEFT', 1.0);
  addExactLink('SHOULDER_RIGHT', 'UPPER_ARM_RIGHT', 1.0);
  addExactLink('SHOULDER_LEFT', 'UPPER_ARM_LEFT', 1.0);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'SHOULDER_RIGHT', 0.92, 1.08, 0.85);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'SHOULDER_LEFT', 0.92, 1.08, 0.85);
  addRangeLimit('TORSO_UPPER_THORAX', 'UPPER_ARM_RIGHT', 0.68, 1.18, 0.45);
  addRangeLimit('TORSO_UPPER_THORAX', 'UPPER_ARM_LEFT', 0.68, 1.18, 0.45);
  addRangeLimit('NECK_CERVICAL', 'UPPER_ARM_RIGHT', 0.72, 1.22, 0.45);
  addRangeLimit('NECK_CERVICAL', 'UPPER_ARM_LEFT', 0.72, 1.22, 0.45);
  addRangeLimit('UPPER_ARM_RIGHT', 'UPPER_ARM_LEFT', 0.62, 1.18, 0.42);

  // 3. Rigid 3D Pelvic Girdle + Hip Sockets
  addExactLink('PELVIS_GROIN', 'THIGH_RIGHT', 1.0);
  addExactLink('PELVIS_GROIN', 'THIGH_LEFT', 1.0);
  addExactLink('THIGH_RIGHT', 'THIGH_LEFT', 1.0);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'THIGH_RIGHT', 0.94, 1.06, 0.95);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'THIGH_LEFT', 0.94, 1.06, 0.95);

  // 4. Arm Bone Chains
  addExactLink('UPPER_ARM_RIGHT', 'FOREARM_RIGHT', 1.0);
  addExactLink('FOREARM_RIGHT', 'HAND_RIGHT', 1.0);
  addExactLink('HAND_RIGHT', 'HAND_TIP_RIGHT', 1.0);
  addRangeLimit('FOREARM_RIGHT', 'HAND_TIP_RIGHT', 0.94, 1.01, 0.92);

  addExactLink('UPPER_ARM_LEFT', 'FOREARM_LEFT', 1.0);
  addExactLink('FOREARM_LEFT', 'HAND_LEFT', 1.0);
  addExactLink('HAND_LEFT', 'HAND_TIP_LEFT', 1.0);
  addRangeLimit('FOREARM_LEFT', 'HAND_TIP_LEFT', 0.94, 1.01, 0.92);

  // 5. Leg Bone Chains
  addExactLink('THIGH_RIGHT', 'KNEE_RIGHT', 1.0);
  addExactLink('KNEE_RIGHT', 'SHIN_RIGHT', 1.0);
  addExactLink('SHIN_RIGHT', 'FOOT_RIGHT', 1.0);
  addExactLink('KNEE_RIGHT', 'FOOT_RIGHT', 1.0);
  addExactLink('FOOT_RIGHT', 'FOOT_TOE_RIGHT', 1.0);
  addRangeLimit('SHIN_RIGHT', 'FOOT_TOE_RIGHT', 0.94, 1.05, 0.92);

  addExactLink('THIGH_LEFT', 'KNEE_LEFT', 1.0);
  addExactLink('KNEE_LEFT', 'SHIN_LEFT', 1.0);
  addExactLink('SHIN_LEFT', 'FOOT_LEFT', 1.0);
  addExactLink('KNEE_LEFT', 'FOOT_LEFT', 1.0);
  addExactLink('FOOT_LEFT', 'FOOT_TOE_LEFT', 1.0);
  addRangeLimit('SHIN_LEFT', 'FOOT_TOE_LEFT', 0.94, 1.05, 0.92);

  // 6. Anatomical Bounds
  addRangeLimit('PELVIS_GROIN', 'TORSO_UPPER_THORAX', 0.85, 1.02, 0.85);
  addRangeLimit('TORSO_LOWER_ABDOMEN', 'NECK_CERVICAL', 0.90, 1.02, 0.85);
  addRangeLimit('THIGH_RIGHT', 'SHOULDER_RIGHT', 0.82, 1.08, 0.78);
  addRangeLimit('THIGH_LEFT', 'SHOULDER_LEFT', 0.82, 1.08, 0.78);
  addRangeLimit('THIGH_RIGHT', 'SHOULDER_LEFT', 0.84, 1.10, 0.78);
  addRangeLimit('THIGH_LEFT', 'SHOULDER_RIGHT', 0.84, 1.10, 0.78);

  addRangeLimit('TORSO_UPPER_THORAX', 'HEAD_CRANIUM', 0.88, 1.04, 0.82);
  addRangeLimit('TORSO_UPPER_THORAX', 'HEAD_TOP', 0.88, 1.04, 0.78);
  addRangeLimit('SHOULDER_RIGHT', 'HEAD_CRANIUM', 0.84, 1.16, 0.75);
  addRangeLimit('SHOULDER_LEFT', 'HEAD_CRANIUM', 0.84, 1.16, 0.75);
  addRangeLimit('SHOULDER_RIGHT', 'HEAD_FACE_JAW', 0.84, 1.16, 0.78);
  addRangeLimit('SHOULDER_LEFT', 'HEAD_FACE_JAW', 0.84, 1.16, 0.78);

  addMeterBounds('THIGH_RIGHT', 'FOOT_RIGHT', 0.32, 0.80, 0.48);
  addMeterBounds('THIGH_LEFT', 'FOOT_LEFT', 0.32, 0.80, 0.48);
  addMeterBounds('TORSO_UPPER_THORAX', 'KNEE_RIGHT', 0.42, 0.88, 0.45);
  addMeterBounds('TORSO_UPPER_THORAX', 'KNEE_LEFT', 0.42, 0.88, 0.45);
  addMeterBounds('KNEE_RIGHT', 'KNEE_LEFT', 0.11, 0.58, 0.55);
  addMeterBounds('FOOT_RIGHT', 'FOOT_LEFT', 0.11, 0.64, 0.50);

  addMeterBounds('UPPER_ARM_RIGHT', 'HAND_RIGHT', 0.20, 0.52, 0.50);
  addMeterBounds('UPPER_ARM_LEFT', 'HAND_LEFT', 0.20, 0.52, 0.50);
  addMeterBounds('PELVIS_GROIN', 'FOREARM_RIGHT', 0.16, 0.78, 0.35);
  addMeterBounds('PELVIS_GROIN', 'FOREARM_LEFT', 0.16, 0.78, 0.35);

  return constraints;
}
