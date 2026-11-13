import type { RagdollBoneState, TargetHealthState } from '../../../contracts/ballistics.ts';

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
