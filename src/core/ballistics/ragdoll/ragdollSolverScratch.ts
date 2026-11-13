import type {
  AuxParticleId,
  AuxRagdollParticle,
  GhoulZoneId,
  RagdollBoneState,
  RagdollDistanceConstraint,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';

export type RagdollParticle = RagdollBoneState | AuxRagdollParticle;

/** A distance constraint with both ends looked up, and the bone that decides if each end is live. */
export interface ResolvedConstraint {
  constraint: RagdollDistanceConstraint;
  a: RagdollParticle;
  b: RagdollParticle;
  /** The bone itself, or the bone an auxiliary particle (fingertip, toe) hangs off. */
  gateA: RagdollBoneState;
  gateB: RagdollBoneState;
}

/**
 * One body's particles and constraints as plain arrays. The solver visits every constraint
 * 14 times a sub-step; finding each end by name there cost more than the solve itself.
 */
export interface RagdollSolverScratch {
  constraints: ResolvedConstraint[];
  constraintCount: number;
  bones: RagdollBoneState[];
  aux: AuxRagdollParticle[];
}

const shared: RagdollSolverScratch = { constraints: [], constraintCount: 0, bones: [], aux: [] };

/** Same rule as `isRagdollBoneParticleActive`, for a bone or an auxiliary particle and its bone. */
export function isResolvedParticleActive(
  target: TargetHealthState,
  particle: RagdollParticle,
  gate: RagdollBoneState
): boolean {
  if (gate.attachmentState === 'OBLITERATED_HIDDEN' || gate.goreMode === 'CRANIAL_POP') return false;
  return (
    target.isRagdollActive ||
    gate.attachmentState === 'DETACHED_LIMB' ||
    particle.componentId !== 'BODY'
  );
}

/**
 * Looks up `target`'s particles once. The result is a single reused buffer: it is valid until
 * the next call, which is as long as one body's solver step needs it.
 */
export function resolveRagdollSolverScratch(target: TargetHealthState): RagdollSolverScratch {
  const bones = target.ragdollBones;
  const aux = target.auxParticles;

  shared.bones.length = 0;
  for (const z of ALL_GHOUL_ZONES) shared.bones.push(bones[z]);
  shared.aux.length = 0;
  for (const id of ALL_AUX_PARTICLES) shared.aux.push(aux[id]);

  const source = target.ragdollConstraints;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const aIsBone = c.nodeA in bones;
    const bIsBone = c.nodeB in bones;
    const a = aIsBone ? bones[c.nodeA as GhoulZoneId] : aux[c.nodeA as AuxParticleId];
    const b = bIsBone ? bones[c.nodeB as GhoulZoneId] : aux[c.nodeB as AuxParticleId];
    const gateA = aIsBone ? (a as RagdollBoneState) : bones[(a as AuxRagdollParticle).parentZone];
    const gateB = bIsBone ? (b as RagdollBoneState) : bones[(b as AuxRagdollParticle).parentZone];
    const slot = shared.constraints[i];
    if (slot) {
      slot.constraint = c;
      slot.a = a;
      slot.b = b;
      slot.gateA = gateA;
      slot.gateB = gateB;
    } else {
      shared.constraints.push({ constraint: c, a, b, gateA, gateB });
    }
  }
  shared.constraintCount = source.length;
  return shared;
}
