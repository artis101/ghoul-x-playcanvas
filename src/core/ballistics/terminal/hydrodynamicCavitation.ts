import { AmmoSpec, Vec3Like } from '../../../contracts/ballistics.ts';
import { SecondaryFragmentTrajectory } from '../../../contracts/physiology.ts';
import { AnatomicalBvh } from '../../ghoul/bvhVolumes.ts';
import { buildConeRayDirection, ProjectileTerminalBehavior } from './projectileBehavior.ts';
import { traceSecondarySubRay } from './secondaryFragments.ts';

export interface CavitationStepState {
  yawAngleDeg: number;
  peakYawAngleDeg: number;
  effectiveCaliberM: number;
  crushRadiusM: number;
  stepEnergyLossJ: number;
  projectileMassKg: number;
  projectileLengthM: number;
  spitzerJacketFragmented: boolean;
  stepFragmentSpawned: boolean;
}

export function computeCavitationStep(
  ammo: AmmoSpec,
  behavior: ProjectileTerminalBehavior,
  softTissueDepthM: number,
  stepSizeM: number,
  prevDepthCm: number,
  yawAngleDeg: number,
  peakYawAngleDeg: number,
  effectiveCaliberM: number,
  projectileLengthM: number,
  projectileMassKg: number,
  currentVelocityMs: number,
  currentEnergyJ: number,
  rho: number,
  spitzerJacketFragmented: boolean,
  spitzerFragmentVelocityThresholdMs: number,
  seed: number,
  stepIndex: number,
  currentDirLocal: Vec3Like,
  midLocal: Vec3Like,
  bvh: AnatomicalBvh,
  secondaryFragments: SecondaryFragmentTrajectory[]
): CavitationStepState {
  const depthCm = softTissueDepthM * 100;
  let newYawAngle = yawAngleDeg;
  let newCaliber = effectiveCaliberM;

  if (behavior === 'EXPANDING_JHP_MUSHROOM') {
    const expandProgress = Math.min(1.0, softTissueDepthM / 0.06);
    const smoothExpand = expandProgress * expandProgress * (3 - 2 * expandProgress);
    newCaliber = ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * smoothExpand);
    newYawAngle = Math.min(22, newYawAngle + 0.9 * (stepSizeM / 0.012));
  } else if (behavior === 'SPITZER_HIGH_VEL_YAW') {
    if (depthCm < 11.2) {
      newYawAngle = Math.min(18, newYawAngle + 1.25 * (stepSizeM / 0.012));
    } else if (depthCm < 17.2) {
      newYawAngle = Math.min(176, newYawAngle + 29.0 * (stepSizeM / 0.012));
    } else {
      newYawAngle = Math.min(180, newYawAngle + 6.0 * (stepSizeM / 0.012));
    }
    newCaliber =
      newYawAngle > 65
        ? ammo.diameterM * Math.min(1.22, ammo.tissueExpansionFactor)
        : ammo.diameterM;
  } else if (behavior === 'RIFLE_FMJ_OTM_YAW') {
    if (depthCm < 13.5) {
      newYawAngle = Math.min(20, newYawAngle + 1.15 * (stepSizeM / 0.012));
    } else if (depthCm < 22.0) {
      newYawAngle = Math.min(165, newYawAngle + 21.0 * (stepSizeM / 0.012));
    }
    const expandFrac = Math.min(1, Math.max(0, (depthCm - 8) / 12));
    newCaliber =
      ammo.diameterM * (1.0 + (Math.min(1.35, ammo.tissueExpansionFactor) - 1.0) * expandFrac);
  } else if (behavior === 'AP_PENETRATOR_STABLE') {
    newCaliber = ammo.diameterM * Math.min(1.03, ammo.tissueExpansionFactor);
    newYawAngle = Math.min(12, newYawAngle + 0.32 * (stepSizeM / 0.012));
  } else {
    const expandFrac = Math.min(1.0, softTissueDepthM / 0.08);
    newCaliber = ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * 0.65 * expandFrac);
    newYawAngle = Math.min(28, newYawAngle + 1.0 * (stepSizeM / 0.012));
  }

  const newPeakYaw = Math.max(peakYawAngleDeg, newYawAngle);
  const thetaRad = (newYawAngle * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(thetaRad));
  const absSin = Math.abs(Math.sin(thetaRad));

  const crushRadiusM = 0.5 * (newCaliber * absCos + projectileLengthM * absSin);

  const frontalAreaM2 = Math.PI * 0.25 * newCaliber * newCaliber;
  const broadsideAreaM2 = newCaliber * projectileLengthM;
  const effectiveAreaM2 = frontalAreaM2 * absCos + broadsideAreaM2 * absSin * absSin;

  let cdTissue = 0.30;
  if (behavior === 'EXPANDING_JHP_MUSHROOM') {
    cdTissue = 0.58 + 0.42 * Math.min(1, softTissueDepthM / 0.06);
  } else if (behavior === 'AP_PENETRATOR_STABLE') {
    cdTissue = 0.22 + 0.35 * absSin * absSin;
  } else {
    cdTissue = 0.27 + 0.92 * absSin * absSin;
  }

  let stepEnergyLossJ =
    0.5 * cdTissue * rho * effectiveAreaM2 * currentVelocityMs * currentVelocityMs * stepSizeM;

  let jacketFrag = spitzerJacketFragmented;
  let fragSpawned = false;
  let newMass = projectileMassKg;
  let newLen = projectileLengthM;

  if (
    behavior === 'SPITZER_HIGH_VEL_YAW' &&
    !jacketFrag &&
    newYawAngle >= 52 &&
    currentVelocityMs > spitzerFragmentVelocityThresholdMs
  ) {
    jacketFrag = true;
    fragSpawned = true;

    const fragCount = currentVelocityMs > 815 ? 3 : 2;
    const totalFragEnergyJ = currentEnergyJ * 0.22;
    const perFragEnergyJ = totalFragEnergyJ / fragCount;
    const perFragMassKg = (projectileMassKg * 0.24) / fragCount;

    for (let fIdx = 0; fIdx < fragCount; fIdx++) {
      const coneDeg = 13 + ((fIdx * 4 + (seed % 5)) % 9);
      const azimuthRad = ((fIdx * 2.094395 + seed * 0.17) % (2 * Math.PI));
      const fragDir = buildConeRayDirection(
        currentDirLocal,
        (coneDeg * Math.PI) / 180,
        azimuthRad
      );
      const fragVelMs = Math.sqrt((2 * perFragEnergyJ) / perFragMassKg);
      const subTrack = traceSecondarySubRay(
        bvh,
        `jacket_frag_${stepIndex}_${fIdx}`,
        'JACKET_FRAGMENT',
        midLocal,
        fragDir,
        coneDeg,
        fragVelMs,
        perFragEnergyJ,
        perFragMassKg,
        ammo.diameterM * 0.55
      );
      secondaryFragments.push(subTrack);
    }

    stepEnergyLossJ += totalFragEnergyJ;
    newMass *= 0.76;
    newLen *= 0.72;
  }

  return {
    yawAngleDeg: newYawAngle,
    peakYawAngleDeg: newPeakYaw,
    effectiveCaliberM: newCaliber,
    crushRadiusM,
    stepEnergyLossJ,
    projectileMassKg: newMass,
    projectileLengthM: newLen,
    spitzerJacketFragmented: jacketFrag,
    stepFragmentSpawned: fragSpawned,
  };
}
