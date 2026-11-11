import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  InternalOrganId,
  NeuralPlexusId,
  SecondaryFragmentTrajectory,
  SkeletalStructureId,
  VascularVesselId,
} from '../../../contracts/physiology.ts';
import { AnatomicalBvh } from '../../ghoul/bvhVolumes.ts';
import { add, copyVec3, scale } from '../vec3.ts';

/**
 * Traces a secondary jacket fragment or cortical bone shard sub-ray inside soft tissue.
 */
export function traceSecondarySubRay(
  bvh: AnatomicalBvh,
  fragmentId: string,
  kind: 'JACKET_FRAGMENT' | 'CORTICAL_BONE_SHARD',
  originLocal: Vec3Like,
  directionLocal: Vec3Like,
  coneAngleDeg: number,
  initialVelocityMs: number,
  initialEnergyJ: number,
  fragmentMassKg: number,
  fragmentDiameterM: number,
  sourceBoneId?: SkeletalStructureId
): SecondaryFragmentTrajectory {
  const stepM = 0.012;
  const maxSteps = 12; // Up to ~14.4 cm secondary splinter track
  let pos = copyVec3(originLocal);
  let energyJ = initialEnergyJ;
  let velMs = initialVelocityMs;
  let traveledM = 0;

  const organsSet = new Set<InternalOrganId>();
  const vesselsSet = new Set<VascularVesselId>();
  const nervesSet = new Set<NeuralPlexusId>();

  const fragArea = Math.PI * 0.25 * fragmentDiameterM * fragmentDiameterM;
  const crushRad = Math.max(0.0025, fragmentDiameterM * 0.65);

  for (let s = 0; s < maxSteps && energyJ > 2.5 && velMs > 35; s++) {
    const nextPos = add(pos, scale(directionLocal, stepM));
    const shell = bvh.queryOuterShellAtPoint(nextPos);
    if (!shell.insideBody) {
      break;
    }

    const t2 = bvh.queryTier2Step(pos, nextPos, crushRad, 0, shell.baseDensityKgM3);
    for (const org of t2.crushOrgans) {
      organsSet.add(org.id);
    }
    for (const nv of t2.crushNerves) {
      nervesSet.add(nv.id);
    }
    for (const vs of t2.crushVessels) {
      vesselsSet.add(vs.spline.id);
    }

    // Irregular high-drag splinter retardation
    const dragDeltaJ = Math.min(
      energyJ,
      0.5 * 1.35 * t2.localTissueDensityKgM3 * fragArea * velMs * velMs * stepM * 2.4
    );
    energyJ = Math.max(0, energyJ - dragDeltaJ);
    velMs = fragmentMassKg > 0 ? Math.sqrt((2 * energyJ) / fragmentMassKg) : 0;
    traveledM += stepM;
    pos = nextPos;
  }

  return {
    fragmentId,
    kind,
    sourceBoneId,
    originLocal: copyVec3(originLocal),
    directionLocal: copyVec3(directionLocal),
    coneAngleDeg,
    initialVelocityMs,
    initialEnergyJ,
    travelDistanceCm: traveledM * 100,
    organsLacerated: Array.from(organsSet),
    vesselsLacerated: Array.from(vesselsSet),
    nervesLacerated: Array.from(nervesSet),
  };
}
