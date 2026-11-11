import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  ArmorPlateId,
  BoneTraumaRecord,
  CharacterTransform,
  InternalBallisticsReport,
  InternalOrganId,
  NeuralPlexusId,
  OrganTraumaRecord,
  RayMarchStepRecord,
  SecondaryFragmentTrajectory,
  SkeletalStructureId,
  VascularVesselId,
  VascularWoundRecord,
} from '../../../contracts/physiology.ts';
import { AnatomicalBvh, characterLocalPointToWorld } from '../../ghoul/bvhVolumes.ts';

export function assembleInternalBallisticsReport(
  enteredTissue: boolean,
  stoppedByArmorPlate: ArmorPlateId | null,
  currentEnergyJ: number,
  currentVelocityMs: number,
  entryEnergyJ: number,
  entryVelocityMs: number,
  entryPointLocal: Vec3Like | null,
  lastInsidePointLocal: Vec3Like | null,
  softTissueDepthM: number,
  effectiveCaliberM: number,
  armorPlatesIntersected: ArmorPlateId[],
  armorBackfaceBluntTraumaJ: number,
  plateIntegrityAfter: Record<ArmorPlateId, number>,
  peakYawAngleDeg: number,
  narrowNeckDepthCm: number | null,
  steps: RayMarchStepRecord[],
  secondaryFragments: SecondaryFragmentTrajectory[],
  organTraumaMap: Map<InternalOrganId, any>,
  boneTraumaMap: Map<SkeletalStructureId, BoneTraumaRecord>,
  nervesSeveredSet: Set<NeuralPlexusId>,
  vascularWoundMap: Map<VascularVesselId, VascularWoundRecord>,
  bvh: AnatomicalBvh,
  transform: CharacterTransform
): InternalBallisticsReport {
  const hitOuterShell = enteredTissue || stoppedByArmorPlate !== null;
  const overPenetrated = enteredTissue && stoppedByArmorPlate === null && currentEnergyJ > 2.0;
  const exitEnergyJ = stoppedByArmorPlate ? 0 : currentEnergyJ;
  const exitVelocityMs = stoppedByArmorPlate ? 0 : currentVelocityMs;
  const totalEnergyDepositedJ = Math.max(0, entryEnergyJ - exitEnergyJ);

  const organTrauma: OrganTraumaRecord[] = Array.from(organTraumaMap.entries()).map(([organId, rec]) => {
    const orgDef = bvh.organs.find((o) => o.organ.id === organId)?.organ;
    return {
      organId,
      isInelastic: rec.isInelastic,
      directCrushLacerated: rec.directCrushLacerated,
      stretchCavitationRuptured: rec.stretchCavitationRuptured,
      energyDepositedJ: rec.energyDepositedJ,
      severity: rec.severity,
      positionLocal: rec.positionLocal,
      positionWorld: characterLocalPointToWorld(rec.positionLocal, transform, orgDef?.ghoulZone),
    };
  });

  const woundTractMuscleBleedMlPerSec = enteredTissue
    ? Math.min(16, Math.max(3.5, softTissueDepthM * 28 * (effectiveCaliberM / 0.009)))
    : 0;

  return {
    hitOuterShell,
    entryPointLocal,
    exitPointLocal: overPenetrated ? lastInsidePointLocal : null,
    entryPointWorld: entryPointLocal ? characterLocalPointToWorld(entryPointLocal, transform) : null,
    exitPointWorld: overPenetrated && lastInsidePointLocal ? characterLocalPointToWorld(lastInsidePointLocal, transform) : null,
    entryVelocityMs,
    exitVelocityMs,
    entryEnergyJ,
    exitEnergyJ,
    totalEnergyDepositedJ,
    totalPenetrationDepthCm: softTissueDepthM * 100,
    overPenetrated,
    stoppedByArmorPlate,
    armorPlatesIntersected,
    armorBackfaceBluntTraumaJ,
    plateIntegrityAfter,
    peakYawAngleDeg,
    narrowNeckDepthCm,
    steps,
    secondaryFragments,
    organTrauma,
    boneTrauma: Array.from(boneTraumaMap.values()),
    nervesSevered: Array.from(nervesSeveredSet),
    vascularWounds: Array.from(vascularWoundMap.values()),
    woundTractMuscleBleedMlPerSec,
  };
}
