import { TargetHealthState } from '../../../contracts/ballistics.ts';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  recomputeRagdollBasisVectors,
} from '../../ghoul/anatomy.ts';
import { copyVec3, vec3 } from '../vec3.ts';
import { projectConstraintsAndAnatomyOnce } from './ragdollConstraintsProjector.ts';

export function stabilizeRagdollPoseForTransition(target: TargetHealthState, floorY: number): void {
  for (let pass = 0; pass < 10; pass++) {
    projectConstraintsAndAnatomyOnce(target, floorY);
  }
  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.componentId === 'BODY') {
      b.prevPosition = copyVec3(b.position);
      b.velocity = vec3(0, 0, 0);
    }
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (a.componentId === 'BODY') {
      a.prevPosition = copyVec3(a.position);
      a.velocity = vec3(0, 0, 0);
    }
  }
  recomputeRagdollBasisVectors(target);
}
