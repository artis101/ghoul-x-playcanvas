import {
  AuxParticleId,
  GhoulZoneId,
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

export function getRagdollParticleRef(
  target: TargetHealthState,
  id: GhoulZoneId | AuxParticleId
): RagdollParticleRef {
  if (id in target.ragdollBones) {
    const b = target.ragdollBones[id as GhoulZoneId];
    const active =
      (target.isRagdollActive || b.componentId !== 'BODY') && b.goreMode !== 'CRANIAL_POP';
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
    (target.isRagdollActive || a.componentId !== 'BODY') &&
    parentBone.goreMode !== 'CRANIAL_POP';
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
