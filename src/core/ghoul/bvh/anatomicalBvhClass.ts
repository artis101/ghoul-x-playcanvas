import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  InternalOrganVolume,
  NeuralPlexusVolume,
  SkeletalBoneVolume,
  Tier1ArmorPlateVolume,
  Tier1OuterShellVolume,
  Tier2SpatialQueryResult,
  VascularSplineProximityHit,
} from '../../../contracts/physiology.ts';
import { lerp, vec3 } from '../../ballistics/vec3.ts';
import { TIER1_ARMOR_PLATES } from './armorPlatesData.ts';
import { buildOuterShellTree } from './bvhClusterTree.ts';
import { intersectTier1Broadphase, queryArmorPlatesAlongSegment, queryOuterShellAtPoint } from './bvhQueryOuterShell.ts';
import { queryTier2Step, queryVascularSplinesAlongSegment } from './bvhQueryTier2.ts';
import { computePrimitiveAabb, mergeAabbs } from './bvhRayAabb.ts';
import { bakeVascularSpline } from './bvhRayPrimitives.ts';
import { AxisAlignedBox, BakedVascularSpline, BvhGroupNode, RayIntervalHit } from './bvhTypes.ts';
import { TIER2_INTERNAL_ORGANS } from './internalOrgansData.ts';
import { TIER2_NEURAL_PLEXUSES } from './neuralPlexusData.ts';
import { TIER1_OUTER_SHELL_VOLUMES } from './outerShellLimbsData.ts';
import { TIER2_SKELETAL_BONES } from './skeletalBonesData.ts';
import { TIER2_VASCULAR_SPLINES } from './vascularSplinesData.ts';

export class AnatomicalBvh {
  public readonly rootAabb: AxisAlignedBox;
  public readonly outerShellTree: readonly BvhGroupNode<Tier1OuterShellVolume>[];
  public readonly armorPlates: readonly {
    readonly aabb: AxisAlignedBox;
    readonly plate: Tier1ArmorPlateVolume;
  }[];
  public readonly organs: readonly {
    readonly aabb: AxisAlignedBox;
    readonly organ: InternalOrganVolume;
  }[];
  public readonly bones: readonly {
    readonly aabb: AxisAlignedBox;
    readonly bone: SkeletalBoneVolume;
  }[];
  public readonly nerves: readonly {
    readonly aabb: AxisAlignedBox;
    readonly nerve: NeuralPlexusVolume;
  }[];
  public readonly vascularSplines: readonly BakedVascularSpline[];

  constructor() {
    this.outerShellTree = buildOuterShellTree(TIER1_OUTER_SHELL_VOLUMES);

    this.armorPlates = TIER1_ARMOR_PLATES.map((plate) => ({
      plate,
      aabb: computePrimitiveAabb(plate.shape, plate.localCenter, plate.halfExtents),
    }));

    this.organs = TIER2_INTERNAL_ORGANS.map((organ) => ({
      organ,
      aabb: computePrimitiveAabb(organ.shape, organ.localCenter, organ.halfExtents),
    }));

    this.bones = TIER2_SKELETAL_BONES.map((bone) => ({
      bone,
      aabb: computePrimitiveAabb(
        bone.shape,
        bone.localCenter,
        bone.halfExtents,
        bone.capsuleStart,
        bone.capsuleEnd,
        bone.capsuleRadiusM
      ),
    }));

    this.nerves = TIER2_NEURAL_PLEXUSES.map((nerve) => ({
      nerve,
      aabb: computePrimitiveAabb(
        'CAPSULE',
        lerp(nerve.capsuleStart, nerve.capsuleEnd, 0.5),
        vec3(0, 0, 0),
        nerve.capsuleStart,
        nerve.capsuleEnd,
        nerve.capsuleRadiusM
      ),
    }));

    this.vascularSplines = TIER2_VASCULAR_SPLINES.map((sp) => bakeVascularSpline(sp, 10));

    this.rootAabb = mergeAabbs([
      ...this.outerShellTree.map((n) => n.aabb),
      ...this.armorPlates.map((p) => p.aabb),
    ]);
  }

  public intersectTier1Broadphase(originLocal: Vec3Like, dirLocal: Vec3Like): RayIntervalHit {
    return intersectTier1Broadphase(originLocal, dirLocal, this.rootAabb, this.outerShellTree, this.armorPlates);
  }

  public queryOuterShellAtPoint(pointLocal: Vec3Like): {
    insideBody: boolean;
    shellVolumes: Tier1OuterShellVolume[];
    baseDensityKgM3: number;
  } {
    return queryOuterShellAtPoint(pointLocal, this.outerShellTree);
  }

  public queryArmorPlatesAlongSegment(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    enableArmorPlates = true,
    enableHelmet = true
  ): Tier1ArmorPlateVolume[] {
    return queryArmorPlatesAlongSegment(segStartLocal, segEndLocal, this.armorPlates, enableArmorPlates, enableHelmet);
  }

  public queryVascularSplinesAlongSegment(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    maxSearchRadiusM: number
  ): VascularSplineProximityHit[] {
    return queryVascularSplinesAlongSegment(segStartLocal, segEndLocal, maxSearchRadiusM, this.vascularSplines);
  }

  public queryTier2Step(
    segStartLocal: Vec3Like,
    segEndLocal: Vec3Like,
    crushRadiusM: number,
    stretchRadiusM: number,
    baseShellDensityKgM3: number
  ): Tier2SpatialQueryResult {
    return queryTier2Step(
      segStartLocal,
      segEndLocal,
      crushRadiusM,
      stretchRadiusM,
      baseShellDensityKgM3,
      this.organs,
      this.bones,
      this.nerves,
      this.vascularSplines
    );
  }
}

let defaultSingletonBvh: AnatomicalBvh | null = null;

export function getDefaultAnatomicalBvh(): AnatomicalBvh {
  if (!defaultSingletonBvh) {
    defaultSingletonBvh = new AnatomicalBvh();
  }
  return defaultSingletonBvh;
}
