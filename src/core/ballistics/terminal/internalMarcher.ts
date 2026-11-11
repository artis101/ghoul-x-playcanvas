import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  ArmorPlateId,
  BoneTraumaRecord,
  InternalBallisticsInput,
  InternalBallisticsReport,
  InternalOrganId,
  NeuralPlexusId,
  RayMarchStepRecord,
  SecondaryFragmentTrajectory,
  SkeletalStructureId,
  VascularVesselId,
  VascularWoundRecord,
} from '../../../contracts/physiology.ts';
import {
  AnatomicalBvh,
  characterLocalPointToWorld,
  getDefaultAnatomicalBvh,
} from '../../ghoul/bvhVolumes.ts';
import { add, copyVec3, lerp, scale } from '../vec3.ts';
import { evaluateArmorPlatesStep } from './armorPlateStep.ts';
import { evaluateBoneTraumaStep } from './boneTrauma.ts';
import { computeCavitationStep } from './hydrodynamicCavitation.ts';
import { evaluateOrganAndNerveTrauma } from './organNerveTrauma.ts';
import { assembleInternalBallisticsReport } from './terminalReportBuilder.ts';
import { initializeMarcherState } from './terminalSetup.ts';
import { evaluateVascularTraumaStep, foldSecondaryFragmentsTrauma } from './vascularDamage.ts';

export function marchInternalBallistics(
  input: InternalBallisticsInput,
  bvh: AnatomicalBvh = getDefaultAnatomicalBvh()
): InternalBallisticsReport {
  const init = initializeMarcherState(input, bvh);
  const { ammo } = input;
  const config = input.config ?? {};

  if (!init.broadphase.hit || init.entryEnergyJ <= 0.5) {
    return assembleInternalBallisticsReport(
      false, null, init.entryEnergyJ, init.entryVelocityMs, init.entryEnergyJ, init.entryVelocityMs,
      null, null, 0, ammo.diameterM, [], 0, init.plateIntegrityAfter as any,
      config.initialYawAngleDeg ?? 1.5, null, [], [], new Map(), new Map(), new Set(), new Map(), bvh, init.transform
    );
  }

  let {
    currentDirLocal, currentPosLocal, currentEnergyJ, currentVelocityMs,
    yawAngleDeg, peakYawAngleDeg, effectiveCaliberM, projectileLengthM, projectileMassKg,
  } = init;

  let enteredTissue = false;
  let entryPointLocal: Vec3Like | null = null;
  let lastInsidePointLocal: Vec3Like | null = null;
  let softTissueDepthM = 0;
  let narrowNeckDepthCm: number | null = null;
  let spitzerJacketFragmented = false;
  let stoppedByArmorPlate: ArmorPlateId | null = null;
  let armorBackfaceBluntTraumaJ = 0;

  const evaluatedPlates = new Set<ArmorPlateId>();
  const armorPlatesIntersected: ArmorPlateId[] = [];
  const steps: RayMarchStepRecord[] = [];
  const secondaryFragments: SecondaryFragmentTrajectory[] = [];
  const nervesSeveredSet = new Set<NeuralPlexusId>();
  const organTraumaMap = new Map<InternalOrganId, any>();
  const boneTraumaMap = new Map<SkeletalStructureId, BoneTraumaRecord>();
  const evaluatedBones = new Set<SkeletalStructureId>();
  const vascularWoundMap = new Map<VascularVesselId, VascularWoundRecord>();
  let stepIndex = 0;

  for (let iter = 0; iter < init.maxStepCount; iter++) {
    if (currentEnergyJ <= 1.0 || currentVelocityMs <= 12) break;
    const nextPosLocal = add(currentPosLocal, scale(currentDirLocal, init.stepSizeM));

    const armorRes = evaluateArmorPlatesStep(
      bvh, currentPosLocal, nextPosLocal, init.enableArmorPlates, init.enableHelmet, evaluatedPlates,
      armorPlatesIntersected, init.plateIntegrityAfter as any, ammo, currentEnergyJ, currentVelocityMs,
      projectileMassKg, init.behavior, yawAngleDeg, peakYawAngleDeg, softTissueDepthM,
      effectiveCaliberM, stepIndex, init.transform, entryPointLocal, lastInsidePointLocal
    );

    armorBackfaceBluntTraumaJ += armorRes.armorBackfaceBluntTraumaJ;
    currentEnergyJ = armorRes.currentEnergyJ;
    currentVelocityMs = armorRes.currentVelocityMs;
    yawAngleDeg = armorRes.yawAngleDeg;
    peakYawAngleDeg = armorRes.peakYawAngleDeg;
    entryPointLocal = armorRes.entryPointLocal;
    lastInsidePointLocal = armorRes.lastInsidePointLocal;

    if (armorRes.terminalStepRecord) {
      steps.push(armorRes.terminalStepRecord);
      stepIndex++;
      stoppedByArmorPlate = armorRes.stoppedByArmorPlate;
      break;
    }

    const midLocal = lerp(currentPosLocal, nextPosLocal, 0.5);
    const shellSample = bvh.queryOuterShellAtPoint(midLocal);
    if (!shellSample.insideBody) {
      currentPosLocal = nextPosLocal;
      continue;
    }

    if (!enteredTissue) {
      enteredTissue = true;
      entryPointLocal = copyVec3(currentPosLocal);
    }
    lastInsidePointLocal = copyVec3(nextPosLocal);

    const prevDepthCm = softTissueDepthM * 100;
    softTissueDepthM += init.stepSizeM;
    const depthCm = softTissueDepthM * 100;

    const prelimTier2 = bvh.queryTier2Step(currentPosLocal, nextPosLocal, 0.5 * effectiveCaliberM, 0.095, shellSample.baseDensityKgM3);
    const cav = computeCavitationStep(
      ammo, init.behavior, softTissueDepthM, init.stepSizeM, prevDepthCm, yawAngleDeg, peakYawAngleDeg,
      effectiveCaliberM, projectileLengthM, projectileMassKg, currentVelocityMs, currentEnergyJ,
      prelimTier2.localTissueDensityKgM3, spitzerJacketFragmented, init.spitzerFragmentVelocityThresholdMs,
      init.seed, stepIndex, currentDirLocal, midLocal, bvh, secondaryFragments
    );

    yawAngleDeg = cav.yawAngleDeg;
    peakYawAngleDeg = cav.peakYawAngleDeg;
    effectiveCaliberM = cav.effectiveCaliberM;
    projectileMassKg = cav.projectileMassKg;
    projectileLengthM = cav.projectileLengthM;
    spitzerJacketFragmented = cav.spitzerJacketFragmented;
    const crushRadiusM = cav.crushRadiusM;
    let stepEnergyLossJ = cav.stepEnergyLossJ;
    let stepFragmentSpawned = cav.stepFragmentSpawned;

    if (narrowNeckDepthCm === null && yawAngleDeg >= 25) narrowNeckDepthCm = prevDepthCm;

    const boneTrauma = evaluateBoneTraumaStep(
      prelimTier2.hitBones, currentEnergyJ, init.behavior, init.seed, stepIndex,
      currentDirLocal, midLocal, bvh, evaluatedBones, boneTraumaMap, secondaryFragments
    );
    stepEnergyLossJ += boneTrauma.stepEnergyLossJ;
    currentDirLocal = boneTrauma.newDirLocal;
    yawAngleDeg = Math.min(180, yawAngleDeg + boneTrauma.yawDeltaDeg);
    if (yawAngleDeg > peakYawAngleDeg) peakYawAngleDeg = yawAngleDeg;
    if (boneTrauma.stepFragmentSpawned) stepFragmentSpawned = true;

    const stepDepositedJ = Math.min(currentEnergyJ, stepEnergyLossJ);
    const velocityBeforeStepUpdateMs = currentVelocityMs;
    currentEnergyJ = Math.max(0, currentEnergyJ - stepDepositedJ);
    currentVelocityMs = projectileMassKg > 0 ? Math.sqrt((2 * currentEnergyJ) / projectileMassKg) : 0;

    const rawStretchRadiusM = Math.min(0.092, Math.max(crushRadiusM, 0.00038 * Math.sqrt(stepDepositedJ / init.stepSizeM)));
    const exactTier2 = bvh.queryTier2Step(currentPosLocal, nextPosLocal, crushRadiusM, rawStretchRadiusM, shellSample.baseDensityKgM3);

    const highVelocityStretchActive = velocityBeforeStepUpdateMs >= init.stretchVelocityThresholdMs;
    const intersectsInelasticOrgan = exactTier2.stretchOrgans.some((o) => o.isInelastic);
    const stretchCavitationActive = highVelocityStretchActive || intersectsInelasticOrgan;

    const organNerve = evaluateOrganAndNerveTrauma(
      exactTier2, stepDepositedJ, highVelocityStretchActive, midLocal, organTraumaMap, nervesSeveredSet
    );

    const stepVesselsHit = evaluateVascularTraumaStep(
      exactTier2, stretchCavitationActive, highVelocityStretchActive, intersectsInelasticOrgan,
      rawStretchRadiusM, stepDepositedJ, currentDirLocal, init.transform, vascularWoundMap
    );

    steps.push({
      stepIndex: stepIndex++,
      positionLocal: copyVec3(midLocal),
      positionWorld: characterLocalPointToWorld(midLocal, init.transform),
      depthCm,
      tissueDensityKgM3: prelimTier2.localTissueDensityKgM3,
      velocityMs: currentVelocityMs,
      kineticEnergyJ: currentEnergyJ,
      energyDepositedStepJ: stepDepositedJ,
      yawAngleDeg,
      effectiveCaliberM,
      crushRadiusM,
      stretchRadiusM: stretchCavitationActive ? rawStretchRadiusM : crushRadiusM,
      stretchCavitationActive,
      armorPlateHit: armorRes.stepArmorHit,
      organsCrushed: organNerve.stepOrgansCrushed,
      organsStretched: organNerve.stepOrgansStretched,
      bonesHit: boneTrauma.stepBonesHit,
      nervesHit: organNerve.stepNervesHit,
      vesselsHit: stepVesselsHit,
      fragmentSpawned: stepFragmentSpawned,
    });

    currentPosLocal = nextPosLocal;
  }

  foldSecondaryFragmentsTrauma(secondaryFragments, bvh, init.transform, init.initialDirLocal, nervesSeveredSet, organTraumaMap, vascularWoundMap);

  return assembleInternalBallisticsReport(
    enteredTissue, stoppedByArmorPlate, currentEnergyJ, currentVelocityMs, init.entryEnergyJ, init.entryVelocityMs,
    entryPointLocal, lastInsidePointLocal, softTissueDepthM, effectiveCaliberM, armorPlatesIntersected,
    armorBackfaceBluntTraumaJ, init.plateIntegrityAfter as any, peakYawAngleDeg, narrowNeckDepthCm, steps,
    secondaryFragments, organTraumaMap, boneTraumaMap, nervesSeveredSet, vascularWoundMap, bvh, init.transform
  );
}
