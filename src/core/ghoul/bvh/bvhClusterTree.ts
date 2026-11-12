import { Tier1OuterShellVolume } from '../../../contracts/physiology.ts';
import { computePrimitiveAabb, mergeAabbs } from './bvhRayAabb.ts';
import { AxisAlignedBox, BvhGroupNode } from './bvhTypes.ts';

export function buildOuterShellTree(
  outerShellVolumes: readonly Tier1OuterShellVolume[]
): readonly BvhGroupNode<Tier1OuterShellVolume>[] {
  const shellEntries = outerShellVolumes.map((item) => ({
    item,
    aabb: computePrimitiveAabb(
      item.shape,
      item.localCenter,
      item.halfExtents,
      item.capsuleStart,
      item.capsuleEnd,
      item.capsuleRadiusM
    ),
  }));

  // Partition Tier-1 outer shell into 4 anatomical BVH child clusters (Upper Axial, Lower Axial, Left Arm, Right Arm)
  const upperAxial = shellEntries.filter((e) =>
    [
      'HEAD_SCALP_SHELL',
      'NECK_SHELL',
      'SUPRACLAVICULAR_COLLAR_SHELL',
      'TACTICAL_CLOTHING_TORSO',
      'THORAX_SKIN_MUSCLE',
    ].includes(e.item.id)
  );
  const lowerAxial = shellEntries.filter((e) =>
    [
      'ABDOMEN_SKIN_MUSCLE',
      'PELVIS_SKIN_MUSCLE',
      'THIGH_RIGHT_SHELL',
      'THIGH_LEFT_SHELL',
      'CALF_RIGHT_SHELL',
      'CALF_LEFT_SHELL',
    ].includes(e.item.id)
  );
  const rightArm = shellEntries.filter((e) =>
    ['AXILLARY_GAP_RIGHT', 'UPPER_ARM_RIGHT_SHELL', 'FOREARM_RIGHT_SHELL'].includes(e.item.id)
  );
  const leftArm = shellEntries.filter((e) =>
    ['AXILLARY_GAP_LEFT', 'UPPER_ARM_LEFT_SHELL', 'FOREARM_LEFT_SHELL'].includes(e.item.id)
  );

  return [upperAxial, lowerAxial, rightArm, leftArm]
    .filter((group) => group.length > 0)
    .map((group) => ({
      aabb: mergeAabbs(group.map((g) => g.aabb)),
      items: group,
    }));
}
