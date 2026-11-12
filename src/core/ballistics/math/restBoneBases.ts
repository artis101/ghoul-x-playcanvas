import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { copyVec3, vec3 } from '../vec3.ts';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  AUX_PARTICLE_REST_LOCAL,
  buildAnatomicalColliders,
  GHOUL_ZONE_HIERARCHY,
  recomputeRagdollBasisVectors,
} from '../../ghoul/anatomy.ts';

// Cache colliders statically for performance
export const ALL_ANATOMICAL_COLLIDERS = buildAnatomicalColliders();

// Precompute standing rest-pose basis for each bone
export const REST_BONE_BASES: Record<
  GhoulZoneId,
  { right: Vec3Like; up: Vec3Like; forward: Vec3Like; jointPos: Vec3Like }
> = (() => {
  const dummy = {
    yawRad: 0,
    ragdollBones: {} as TargetHealthState['ragdollBones'],
    auxParticles: {} as TargetHealthState['auxParticles'],
  } as TargetHealthState;

  for (const z of ALL_GHOUL_ZONES) {
    const p = GHOUL_ZONE_HIERARCHY[z].jointLocalPos;
    dummy.ragdollBones[z] = {
      zone: z,
      position: copyVec3(p),
      prevPosition: copyVec3(p),
      velocity: vec3(0, 0, 0),
      angularVelocity: vec3(0, 0, 0),
      rotationEuler: vec3(0, 0, 0),
      basisRight: vec3(1, 0, 0),
      basisUp: vec3(0, 1, 0),
      basisForward: vec3(0, 0, 1),
      distalPosition: copyVec3(p),
      massKg: 1,
      radiusM: 0.05,
      componentId: 'BODY',
      severed: false,
      goreMode: 'INTACT',
      attachmentState: 'ATTACHED',
      grounded: false,
    };
  }
  for (const a of ALL_AUX_PARTICLES) {
    const spec = AUX_PARTICLE_REST_LOCAL[a];
    dummy.auxParticles[a] = {
      id: a,
      parentZone: spec.parentZone,
      position: copyVec3(spec.localPos),
      prevPosition: copyVec3(spec.localPos),
      velocity: vec3(0, 0, 0),
      massKg: spec.massKg,
      radiusM: spec.radiusM,
      componentId: 'BODY',
    };
  }
  recomputeRagdollBasisVectors(dummy);

  const out = {} as Record<
    GhoulZoneId,
    { right: Vec3Like; up: Vec3Like; forward: Vec3Like; jointPos: Vec3Like }
  >;
  for (const z of ALL_GHOUL_ZONES) {
    const b = dummy.ragdollBones[z];
    out[z] = {
      right: copyVec3(b.basisRight),
      up: copyVec3(b.basisUp),
      forward: copyVec3(b.basisForward),
      jointPos: copyVec3(GHOUL_ZONE_HIERARCHY[z].jointLocalPos),
    };
  }
  return out;
})();
