import {
  AuxParticleId,
  GhoulZoneId,
  RagdollBoneState,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';

export interface RagdollParticleRef {
  position: Vec3Like;
  prevPosition: Vec3Like;
  velocity: Vec3Like;
  massKg: number;
  radiusM: number;
  componentId: string;
  grounded?: boolean;
  active: boolean;
}

export function isRagdollBoneParticleActive(
  target: TargetHealthState,
  bone: RagdollBoneState
): boolean {
  if (bone.attachmentState === 'OBLITERATED_HIDDEN' || bone.goreMode === 'CRANIAL_POP') {
    return false;
  }
  return (
    target.isRagdollActive ||
    bone.attachmentState === 'DETACHED_LIMB' ||
    bone.componentId !== 'BODY'
  );
}

export function getRagdollParticleRef(
  target: TargetHealthState,
  id: GhoulZoneId | AuxParticleId
): RagdollParticleRef {
  if (id in target.ragdollBones) {
    const b = target.ragdollBones[id as GhoulZoneId];
    const active = isRagdollBoneParticleActive(target, b);
    return {
      position: b.position,
      prevPosition: b.prevPosition,
      velocity: b.velocity,
      massKg: b.massKg,
      radiusM: b.radiusM,
      componentId: b.componentId,
      grounded: b.grounded,
      active,
    };
  }
  const a = target.auxParticles[id as AuxParticleId];
  const parentBone = target.ragdollBones[a.parentZone];
  const active =
    parentBone.attachmentState !== 'OBLITERATED_HIDDEN' &&
    parentBone.goreMode !== 'CRANIAL_POP' &&
    (target.isRagdollActive ||
      parentBone.attachmentState === 'DETACHED_LIMB' ||
      a.componentId !== 'BODY');
  return {
    position: a.position,
    prevPosition: a.prevPosition,
    velocity: a.velocity,
    massKg: a.massKg,
    radiusM: a.radiusM,
    componentId: a.componentId,
    active,
  };
}
