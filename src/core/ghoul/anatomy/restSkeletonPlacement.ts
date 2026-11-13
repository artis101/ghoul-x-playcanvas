import type { TargetHealthState } from '../../../contracts/ballistics/targetHealthContracts';
import type { Vec3Like } from '../../ballistics/vec3';
import { ALL_GHOUL_ZONES } from './ghoulHierarchyTypes';
import { ALL_AUX_PARTICLES, AUX_PARTICLE_REST_LOCAL } from './ghoulAuxParticles';
import { GHOUL_ZONE_HIERARCHY } from './ghoulHierarchy';
import { recomputeRagdollBasisVectors } from './ragdollBasis';

/**
 * Sets a living, unanimated body's hit skeleton rigidly to its rest pose at its root and yaw.
 *
 * This is placement, not animation: nothing bends, breathes or sways. In the game the animated
 * GLB writes every bone each frame (`poseFromAnimation`), so this only matters where there is no
 * animated body yet, such as a combatant just moved to its cover station before its first frame,
 * or a headless test that moves a body and then shoots at it.
 */
export function placeRestSkeleton(target: TargetHealthState): void {
  if (target.isRagdollActive || !target.alive || target.poseFromAnimation) return;
  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const root = target.worldPosition;
  const toWorld = (l: Vec3Like): Vec3Like => ({
    x: root.x + (l.x * cosY + l.z * sinY),
    y: root.y + l.y,
    z: root.z + (-l.x * sinY + l.z * cosY),
  });
  for (const zone of ALL_GHOUL_ZONES) {
    const bone = target.ragdollBones[zone];
    if (bone.severed || bone.componentId !== 'BODY') continue;
    const p = toWorld(GHOUL_ZONE_HIERARCHY[zone].jointLocalPos);
    bone.position = p;
    bone.prevPosition = { ...p };
  }
  for (const auxId of ALL_AUX_PARTICLES) {
    const aux = target.auxParticles[auxId];
    if (aux.componentId !== 'BODY') continue;
    const p = toWorld(AUX_PARTICLE_REST_LOCAL[auxId].localPos);
    aux.position = p;
    aux.prevPosition = { ...p };
  }
  recomputeRagdollBasisVectors(target);
}
