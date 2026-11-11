import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  BoneTraumaRecord,
  SecondaryFragmentTrajectory,
  SkeletalBoneVolume,
  SkeletalStructureId,
} from '../../../contracts/physiology.ts';
import { AnatomicalBvh } from '../../ghoul/bvhVolumes.ts';
import { copyVec3 } from '../vec3.ts';
import { buildConeRayDirection, ProjectileTerminalBehavior } from './projectileBehavior.ts';
import { traceSecondarySubRay } from './secondaryFragments.ts';

export function evaluateBoneTraumaStep(
  prelimTier2HitBones: SkeletalBoneVolume[],
  currentEnergyJ: number,
  behavior: ProjectileTerminalBehavior,
  seed: number,
  stepIndex: number,
  currentDirLocal: Vec3Like,
  midLocal: Vec3Like,
  bvh: AnatomicalBvh,
  evaluatedBones: Set<SkeletalStructureId>,
  boneTraumaMap: Map<SkeletalStructureId, BoneTraumaRecord>,
  secondaryFragments: SecondaryFragmentTrajectory[]
): {
  stepEnergyLossJ: number;
  newDirLocal: Vec3Like;
  yawDeltaDeg: number;
  stepBonesHit: SkeletalStructureId[];
  stepFragmentSpawned: boolean;
} {
  let stepEnergyLossJ = 0;
  let newDir = currentDirLocal;
  let yawDeltaDeg = 0;
  let fragSpawned = false;
  const stepBonesHit: SkeletalStructureId[] = [];

  for (const bone of prelimTier2HitBones) {
    stepBonesHit.push(bone.id);
    if (evaluatedBones.has(bone.id)) continue;
    evaluatedBones.add(bone.id);

    const structuralBoneWorkJ = Math.min(
      currentEnergyJ * 0.65,
      bone.fractureThresholdJ * (behavior === 'AP_PENETRATOR_STABLE' ? 0.48 : 0.78)
    );
    stepEnergyLossJ += structuralBoneWorkJ;

    const fractured = currentEnergyJ >= bone.fractureThresholdJ;
    const shattered = currentEnergyJ >= bone.shatterThresholdJ;
    let deflectionDeg = 0;
    let spawnedShardCount = 0;

    if (fractured) {
      deflectionDeg =
        behavior === 'AP_PENETRATOR_STABLE'
          ? 2.2
          : shattered
            ? 6.5
            : 4.2;
      const deflectAzimuth = ((seed * 0.31 + stepIndex * 1.9) % (2 * Math.PI));
      newDir = buildConeRayDirection(
        newDir,
        (deflectionDeg * Math.PI) / 180,
        deflectAzimuth
      );
      yawDeltaDeg += behavior === 'AP_PENETRATOR_STABLE' ? 5 : 22;

      spawnedShardCount = shattered ? 3 : currentEnergyJ > bone.fractureThresholdJ * 1.6 ? 2 : 1;
      fragSpawned = true;
      const shardTotalEnergyJ = Math.min(currentEnergyJ * 0.12, shattered ? 85 : 42);
      const perShardEnergyJ = Math.max(8, shardTotalEnergyJ / spawnedShardCount);
      const perShardMassKg = 0.0014;

      for (let sIdx = 0; sIdx < spawnedShardCount; sIdx++) {
        const coneDeg = 12 + ((sIdx * 5 + stepIndex * 3) % 10);
        const azRad = ((sIdx * 2.39996 + stepIndex * 0.7) % (2 * Math.PI));
        const shardDir = buildConeRayDirection(
          newDir,
          (coneDeg * Math.PI) / 180,
          azRad
        );
        const shardVelMs = Math.sqrt((2 * perShardEnergyJ) / perShardMassKg);
        const shardTrack = traceSecondarySubRay(
          bvh,
          `bone_shard_${bone.id}_${sIdx}`,
          'CORTICAL_BONE_SHARD',
          midLocal,
          shardDir,
          coneDeg,
          shardVelMs,
          perShardEnergyJ,
          perShardMassKg,
          0.0055,
          bone.id
        );
        secondaryFragments.push(shardTrack);
      }
    }

    boneTraumaMap.set(bone.id, {
      boneId: bone.id,
      fractured,
      shattered,
      energyDepositedJ: structuralBoneWorkJ,
      deflectionAngleDeg: deflectionDeg,
      spawnedShardCount,
      positionLocal: copyVec3(midLocal),
    });
  }

  return {
    stepEnergyLossJ,
    newDirLocal: newDir,
    yawDeltaDeg,
    stepBonesHit,
    stepFragmentSpawned: fragSpawned,
  };
}
