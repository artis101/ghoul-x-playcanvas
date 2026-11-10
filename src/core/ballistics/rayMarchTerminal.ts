import { AmmoSpec, Vec3Like } from '../../contracts/ballistics.ts';
import {
  ArmorPlateId,
  BoneTraumaRecord,
  CharacterTransform,
  InternalBallisticsInput,
  InternalBallisticsReport,
  InternalOrganId,
  NeuralPlexusId,
  OrganTraumaRecord,
  PHYSIOLOGY_CONSTANTS,
  RayMarchStepRecord,
  SecondaryFragmentTrajectory,
  SkeletalStructureId,
  Tier1ArmorPlateVolume,
  VascularVesselId,
  VascularWoundRecord,
} from '../../contracts/physiology.ts';
import {
  AnatomicalBvh,
  characterLocalDirectionToWorld,
  characterLocalPointToWorld,
  DEFAULT_CHARACTER_TRANSFORM,
  getDefaultAnatomicalBvh,
  TIER1_ARMOR_PLATES,
  transformWorldRayToCharacterLocal,
} from '../ghoul/bvhVolumes.ts';
import {
  add,
  copyVec3,
  cross,
  length,
  lerp,
  normalize,
  rotateAroundAxis,
  scale,
  sub,
  vec3,
} from './vec3.ts';

type ProjectileTerminalBehavior =
  | 'SPITZER_HIGH_VEL_YAW'
  | 'RIFLE_FMJ_OTM_YAW'
  | 'AP_PENETRATOR_STABLE'
  | 'EXPANDING_JHP_MUSHROOM'
  | 'SOLID_SLUG_OR_BALL';

function createInitialPlateIntegrityMap(
  overrides?: Partial<Record<ArmorPlateId, number>>
): Record<ArmorPlateId, number> {
  const map: Record<ArmorPlateId, number> = {
    FRONT_ESAPI_PLATE: 1.0,
    BACK_ESAPI_PLATE: 1.0,
    SIDE_SAPI_LEFT: 1.0,
    SIDE_SAPI_RIGHT: 1.0,
    HELMET_BALLISTIC_SHELL: 1.0,
  };
  if (overrides) {
    for (const plate of TIER1_ARMOR_PLATES) {
      const val = overrides[plate.id];
      if (val !== undefined) {
        map[plate.id] = Math.max(0, Math.min(1, val));
      }
    }
  }
  return map;
}

function classifyTerminalBehavior(ammo: AmmoSpec, entryVelocityMs: number): ProjectileTerminalBehavior {
  if (ammo.type === 'JHP') {
    return 'EXPANDING_JHP_MUSHROOM';
  }
  if (ammo.type === 'AP' && ammo.diameterM < 0.012 && ammo.armorPenetrationFactor >= 1.4) {
    return 'AP_PENETRATOR_STABLE';
  }
  // 5.56x45mm / 5.45x39mm lightweight high-velocity spitzer FMJ (d <= 6.2mm)
  if (ammo.type === 'FMJ' && ammo.diameterM <= 0.0062 && entryVelocityMs >= 620) {
    return 'SPITZER_HIGH_VEL_YAW';
  }
  // 7.62mm FMJ / Match OTM spitzer
  if (ammo.type === 'FMJ' && ammo.diameterM <= 0.0086 && entryVelocityMs >= 600) {
    return 'RIFLE_FMJ_OTM_YAW';
  }
  return 'SOLID_SLUG_OR_BALL';
}

function computeProjectileLengthM(ammo: AmmoSpec, behavior: ProjectileTerminalBehavior): number {
  switch (behavior) {
    case 'SPITZER_HIGH_VEL_YAW':
      return ammo.diameterM * 4.15; // e.g. 5.7mm * 4.15 = 23.6mm M855/M193 spitzer
    case 'RIFLE_FMJ_OTM_YAW':
      return ammo.diameterM * 3.95; // e.g. 7.82mm * 3.95 = 30.9mm 7.62 spitzer
    case 'AP_PENETRATOR_STABLE':
      return ammo.diameterM * 3.8;
    case 'EXPANDING_JHP_MUSHROOM':
      return ammo.diameterM * 1.65;
    case 'SOLID_SLUG_OR_BALL':
      return ammo.type === 'BUCKSHOT_00' ? ammo.diameterM : ammo.diameterM * 1.75;
  }
}

function buildConeRayDirection(
  forwardUnit: Vec3Like,
  polarAngleRad: number,
  azimuthRad: number
): Vec3Like {
  const refUp = Math.abs(forwardUnit.y) < 0.98 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const orthoRight = normalize(cross(refUp, forwardUnit));
  const tilted = rotateAroundAxis(forwardUnit, orthoRight, polarAngleRad);
  return normalize(rotateAroundAxis(tilted, forwardUnit, azimuthRad));
}

function computeEffectivePlateThreatJ(
  plate: Tier1ArmorPlateVolume,
  ammo: AmmoSpec,
  kineticEnergyJ: number
): number {
  if (plate.material === 'CERAMIC_ESAPI_IV') {
    if (ammo.type === 'JHP' || ammo.type === 'BUCKSHOT_00') {
      return kineticEnergyJ * 0.62;
    }
    if (ammo.type === 'AP' && ammo.armorPenetrationFactor >= 2.0) {
      // Dedicated tungsten-carbide sub-caliber penetrator (e.g. M993) concentrates stress on ceramic tile
      return kineticEnergyJ * (ammo.armorPenetrationFactor * 0.64);
    }
    // Standard copper/lead/mild-steel FMJ ball (5.56 M855, 7.62 M80/M118LR): Level IV ceramic defeats 1st round
    return kineticEnergyJ * 0.88;
  }

  if (plate.material === 'UHMWPE_III_PLUS') {
    if (ammo.type === 'AP') {
      return kineticEnergyJ * (ammo.armorPenetrationFactor * 0.82);
    }
    if (ammo.type === 'JHP' || ammo.type === 'BUCKSHOT_00') {
      return kineticEnergyJ * 0.68;
    }
    return kineticEnergyJ * 0.95;
  }

  // Aramid IIIA Helmet Shell: stops pistol/buckshot/fragments, penetrated by rifle FMJ/AP
  if (ammo.type === 'AP' || (ammo.type === 'FMJ' && ammo.diameterM <= 0.0086 && kineticEnergyJ > 1100)) {
    return kineticEnergyJ * Math.max(1.25, ammo.armorPenetrationFactor);
  }
  return kineticEnergyJ * 0.85;
}

/**
 * Traces a secondary jacket fragment or cortical bone shard sub-ray inside soft tissue.
 */
function traceSecondarySubRay(
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

/**
 * Executes Stage-2 1.2 cm Sub-Stepped Internal Ballistics Ray-Marching across Tier-1 Armor/Shell
 * and Tier-2 Internal Organs, Cortical Skeleton, Brachial Plexus, and 3D Vascular Splines.
 */
export function marchInternalBallistics(
  input: InternalBallisticsInput,
  bvh: AnatomicalBvh = getDefaultAnatomicalBvh()
): InternalBallisticsReport {
  const transform: CharacterTransform = input.characterTransform ?? DEFAULT_CHARACTER_TRANSFORM;
  const config = input.config ?? {};
  const stepSizeM = config.stepSizeM ?? PHYSIOLOGY_CONSTANTS.DEFAULT_RAYMARCH_STEP_M;
  const maxMarchDistanceM = config.maxMarchDistanceM ?? 0.90;
  const stretchVelocityThresholdMs =
    config.stretchVelocityThresholdMs ?? PHYSIOLOGY_CONSTANTS.STRETCH_CAVITY_VELOCITY_THRESHOLD_MS;
  const spitzerFragmentVelocityThresholdMs =
    config.spitzerFragmentVelocityThresholdMs ??
    PHYSIOLOGY_CONSTANTS.SPITZER_FRAGMENT_VELOCITY_THRESHOLD_MS;
  const enableArmorPlates = config.enableArmorPlates ?? true;
  const enableHelmet = config.enableHelmet ?? true;
  const seed = config.deterministicSeed ?? 1337;

  const plateIntegrityAfter = createInitialPlateIntegrityMap(config.initialPlateIntegrity);
  const { ammo } = input;
  const entryVelocityMs = Math.max(0, input.impactVelocityMs);
  const entryEnergyJ = 0.5 * ammo.massKg * entryVelocityMs * entryVelocityMs;

  const { originLocal, directionLocal: initialDirLocal } = transformWorldRayToCharacterLocal(
    input.rayOriginWorld,
    input.rayDirectionWorld,
    transform
  );

  const broadphase = bvh.intersectTier1Broadphase(originLocal, initialDirLocal);
  if (!broadphase.hit || entryEnergyJ <= 0.5) {
    return {
      hitOuterShell: false,
      entryPointLocal: null,
      exitPointLocal: null,
      entryPointWorld: null,
      exitPointWorld: null,
      entryVelocityMs,
      exitVelocityMs: entryVelocityMs,
      entryEnergyJ,
      exitEnergyJ: entryEnergyJ,
      totalEnergyDepositedJ: 0,
      totalPenetrationDepthCm: 0,
      overPenetrated: false,
      stoppedByArmorPlate: null,
      armorPlatesIntersected: [],
      armorBackfaceBluntTraumaJ: 0,
      plateIntegrityAfter,
      peakYawAngleDeg: config.initialYawAngleDeg ?? 1.5,
      narrowNeckDepthCm: null,
      steps: [],
      secondaryFragments: [],
      organTrauma: [],
      boneTrauma: [],
      nervesSevered: [],
      vascularWounds: [],
      woundTractMuscleBleedMlPerSec: 0,
    };
  }

  const behavior = classifyTerminalBehavior(ammo, entryVelocityMs);
  let projectileLengthM = computeProjectileLengthM(ammo, behavior);
  let projectileMassKg = ammo.massKg;

  let currentDirLocal = copyVec3(initialDirLocal);
  let currentPosLocal = add(originLocal, scale(currentDirLocal, Math.max(0, broadphase.tMin - 0.006)));

  let currentEnergyJ = entryEnergyJ;
  let currentVelocityMs = entryVelocityMs;
  let yawAngleDeg = config.initialYawAngleDeg ?? 1.5;
  let peakYawAngleDeg = yawAngleDeg;
  let effectiveCaliberM = ammo.diameterM;

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

  const organTraumaMap = new Map<
    InternalOrganId,
    {
      isInelastic: boolean;
      directCrushLacerated: boolean;
      stretchCavitationRuptured: boolean;
      energyDepositedJ: number;
      severity: number;
      positionLocal: Vec3Like;
      ghoulZone: OrganTraumaRecord['organId'];
    }
  >();

  const boneTraumaMap = new Map<SkeletalStructureId, BoneTraumaRecord>();
  const evaluatedBones = new Set<SkeletalStructureId>();
  const vascularWoundMap = new Map<VascularVesselId, VascularWoundRecord>();

  const maxSpanM = Math.min(maxMarchDistanceM, broadphase.tMax - broadphase.tMin + 0.14);
  const maxStepCount = Math.ceil(maxSpanM / stepSizeM) + 4;

  let stepIndex = 0;
  for (let iter = 0; iter < maxStepCount; iter++) {
    if (currentEnergyJ <= 1.0 || currentVelocityMs <= 12) {
      break;
    }

    const nextPosLocal = add(currentPosLocal, scale(currentDirLocal, stepSizeM));

    // -----------------------------------------------------------------------
    // 1. Check Tier-1 Exact Armor Plates (Swimmer ESAPI, Side SAPI, Helmet)
    // -----------------------------------------------------------------------
    const hitPlates = bvh.queryArmorPlatesAlongSegment(
      currentPosLocal,
      nextPosLocal,
      enableArmorPlates,
      enableHelmet
    );
    let stepArmorHit: ArmorPlateId | null = null;

    for (const plate of hitPlates) {
      stepArmorHit = plate.id;
      if (evaluatedPlates.has(plate.id)) continue;
      evaluatedPlates.add(plate.id);
      armorPlatesIntersected.push(plate.id);

      const priorIntegrity = plateIntegrityAfter[plate.id];
      if (priorIntegrity <= 0.02) {
        continue; // Completely shattered strike face offers negligible resistance
      }

      const stopCapacityJ = plate.maxStopEnergyJ * priorIntegrity;
      const effectiveThreatJ = computeEffectivePlateThreatJ(plate, ammo, currentEnergyJ);
      const integrityDrop = (currentEnergyJ / 1000) * plate.degradationPerKilojoule;
      plateIntegrityAfter[plate.id] = Math.max(0, priorIntegrity - integrityDrop);

      if (effectiveThreatJ <= stopCapacityJ) {
        // Plate DEFEATS projectile! Couple backface blunt trauma into underlying thorax/cranium.
        stoppedByArmorPlate = plate.id;
        armorBackfaceBluntTraumaJ += currentEnergyJ * plate.backfaceBluntTransferRatio;
        const hitMidLocal = lerp(currentPosLocal, nextPosLocal, 0.5);
        if (!entryPointLocal) {
          entryPointLocal = copyVec3(hitMidLocal);
        }
        lastInsidePointLocal = copyVec3(hitMidLocal);

        steps.push({
          stepIndex: stepIndex++,
          positionLocal: copyVec3(hitMidLocal),
          positionWorld: characterLocalPointToWorld(hitMidLocal, transform, plate.ghoulZone),
          depthCm: softTissueDepthM * 100,
          tissueDensityKgM3: plate.densityKgM3,
          velocityMs: 0,
          kineticEnergyJ: 0,
          energyDepositedStepJ: currentEnergyJ,
          yawAngleDeg,
          effectiveCaliberM,
          crushRadiusM: 0.5 * effectiveCaliberM,
          stretchRadiusM: 0,
          stretchCavitationActive: false,
          armorPlateHit: plate.id,
          organsCrushed: [],
          organsStretched: [],
          bonesHit: [],
          nervesHit: [],
          vesselsHit: [],
          fragmentSpawned: false,
        });

        currentEnergyJ = 0;
        currentVelocityMs = 0;
        break;
      } else {
        // Armor overmatched! Subtract plate perforation work and destabilize yaw slightly
        const absorbedRatio = Math.min(0.82, stopCapacityJ / Math.max(1, effectiveThreatJ));
        const plateLossJ = currentEnergyJ * absorbedRatio * 0.72;
        armorBackfaceBluntTraumaJ += plateLossJ * plate.backfaceBluntTransferRatio * 0.5;
        currentEnergyJ = Math.max(5, currentEnergyJ - plateLossJ);
        currentVelocityMs = Math.sqrt((2 * currentEnergyJ) / projectileMassKg);
        yawAngleDeg = Math.min(180, yawAngleDeg + (behavior === 'AP_PENETRATOR_STABLE' ? 4 : 18));
        if (yawAngleDeg > peakYawAngleDeg) peakYawAngleDeg = yawAngleDeg;
      }
    }

    if (stoppedByArmorPlate || currentEnergyJ <= 1.0) {
      break;
    }

    // -----------------------------------------------------------------------
    // 2. Check Tier-1 Outer Shell Membership
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // 3. Caliber-Specific Deformation (Mushrooming) & Yaw Evolution
    // -----------------------------------------------------------------------
    const prevDepthCm = softTissueDepthM * 100;
    softTissueDepthM += stepSizeM;
    const depthCm = softTissueDepthM * 100;

    if (behavior === 'EXPANDING_JHP_MUSHROOM') {
      // Progressive hollow-point mushrooming across first 4–7 cm of soft tissue
      const expandProgress = Math.min(1.0, softTissueDepthM / 0.06);
      const smoothExpand = expandProgress * expandProgress * (3 - 2 * expandProgress);
      effectiveCaliberM =
        ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * smoothExpand);
      // Expanded mushroom stabilizes nose-forward with minor wobble
      yawAngleDeg = Math.min(22, yawAngleDeg + 0.9 * (stepSizeM / 0.012));
    } else if (behavior === 'SPITZER_HIGH_VEL_YAW') {
      // 5.56mm / 5.45mm spitzer: flies relatively straight ("narrow neck") for first ~11–13 cm,
      // then violently yaws 90°–180° due to rear-heavy center of mass!
      if (depthCm < 11.2) {
        yawAngleDeg = Math.min(18, yawAngleDeg + 1.25 * (stepSizeM / 0.012));
      } else if (depthCm < 17.2) {
        yawAngleDeg = Math.min(176, yawAngleDeg + 29.0 * (stepSizeM / 0.012));
      } else {
        yawAngleDeg = Math.min(180, yawAngleDeg + 6.0 * (stepSizeM / 0.012));
      }
      effectiveCaliberM =
        yawAngleDeg > 65
          ? ammo.diameterM * Math.min(1.22, ammo.tissueExpansionFactor)
          : ammo.diameterM;
    } else if (behavior === 'RIFLE_FMJ_OTM_YAW') {
      // 7.62mm FMJ / OTM: ~14 cm neck then strong yaw + slight tip flattening
      if (depthCm < 13.5) {
        yawAngleDeg = Math.min(20, yawAngleDeg + 1.15 * (stepSizeM / 0.012));
      } else if (depthCm < 22.0) {
        yawAngleDeg = Math.min(165, yawAngleDeg + 21.0 * (stepSizeM / 0.012));
      }
      const expandFrac = Math.min(1, Math.max(0, (depthCm - 8) / 12));
      effectiveCaliberM =
        ammo.diameterM * (1.0 + (Math.min(1.35, ammo.tissueExpansionFactor) - 1.0) * expandFrac);
    } else if (behavior === 'AP_PENETRATOR_STABLE') {
      // Tungsten/hardened sub-caliber AP core: high sectional stability ("ice-picking")
      effectiveCaliberM = ammo.diameterM * Math.min(1.03, ammo.tissueExpansionFactor);
      yawAngleDeg = Math.min(12, yawAngleDeg + 0.32 * (stepSizeM / 0.012));
    } else {
      // Heavy solid FMJ / slug / buckshot
      const expandFrac = Math.min(1.0, softTissueDepthM / 0.08);
      effectiveCaliberM =
        ammo.diameterM * (1.0 + (ammo.tissueExpansionFactor - 1.0) * 0.65 * expandFrac);
      yawAngleDeg = Math.min(28, yawAngleDeg + 1.0 * (stepSizeM / 0.012));
    }

    if (narrowNeckDepthCm === null && yawAngleDeg >= 25) {
      narrowNeckDepthCm = prevDepthCm;
    }
    if (yawAngleDeg > peakYawAngleDeg) {
      peakYawAngleDeg = yawAngleDeg;
    }

    const thetaRad = (yawAngleDeg * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(thetaRad));
    const absSin = Math.abs(Math.sin(thetaRad));

    // Permanent Crush Radius R_perm = 0.5 * (d_eff |cos theta| + L_proj |sin theta|)
    const crushRadiusM = 0.5 * (effectiveCaliberM * absCos + projectileLengthM * absSin);

    // Pre-query Tier-2 with generous candidate stretch radius so we know exact local tissue density rho
    const prelimTier2 = bvh.queryTier2Step(
      currentPosLocal,
      nextPosLocal,
      crushRadiusM,
      0.095,
      shellSample.baseDensityKgM3
    );
    const rho = prelimTier2.localTissueDensityKgM3;

    // -----------------------------------------------------------------------
    // 4. Fluid Retardation Energy Loss: dEk = 0.5 * Cd(theta, mushroom) * rho * A_eff * v^2 * dx
    // Hoerner slender-body crossflow law: broadside area presentation scales with sin^2(theta)
    // during low-yaw nose-forward flight, spiking 4.5x+ as spitzer yaws broadside near 90 deg!
    // -----------------------------------------------------------------------
    const frontalAreaM2 = Math.PI * 0.25 * effectiveCaliberM * effectiveCaliberM;
    const broadsideAreaM2 = effectiveCaliberM * projectileLengthM;
    const effectiveAreaM2 = frontalAreaM2 * absCos + broadsideAreaM2 * absSin * absSin;

    let cdTissue = 0.30;
    if (behavior === 'EXPANDING_JHP_MUSHROOM') {
      cdTissue = 0.58 + 0.42 * Math.min(1, softTissueDepthM / 0.06);
    } else if (behavior === 'AP_PENETRATOR_STABLE') {
      cdTissue = 0.22 + 0.35 * absSin * absSin;
    } else {
      // Spitzer / ball: low point-forward drag (~0.27), surging 4x+ broadside (~1.18) during violent yaw!
      cdTissue = 0.27 + 0.92 * absSin * absSin;
    }

    let stepEnergyLossJ =
      0.5 * cdTissue * rho * effectiveAreaM2 * currentVelocityMs * currentVelocityMs * stepSizeM;

    let stepFragmentSpawned = false;

    // -----------------------------------------------------------------------
    // 5. High-Velocity Spitzer Yaw Fragmentation (v > 730 m/s & yaw >= 52 deg)
    // Hydrodynamic bending moment peaks near sin(2*theta) (~45–60 deg), shearing the jacket cannelure!
    // -----------------------------------------------------------------------
    if (
      behavior === 'SPITZER_HIGH_VEL_YAW' &&
      !spitzerJacketFragmented &&
      yawAngleDeg >= 52 &&
      currentVelocityMs > spitzerFragmentVelocityThresholdMs
    ) {
      spitzerJacketFragmented = true;
      stepFragmentSpawned = true;

      const fragCount = currentVelocityMs > 815 ? 3 : 2;
      const totalFragEnergyJ = currentEnergyJ * 0.22;
      const perFragEnergyJ = totalFragEnergyJ / fragCount;
      const perFragMassKg = (projectileMassKg * 0.24) / fragCount;

      for (let fIdx = 0; fIdx < fragCount; fIdx++) {
        const coneDeg = 13 + ((fIdx * 4 + (seed % 5)) % 9); // 13–21 deg forward cone
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
      projectileMassKg *= 0.76;
      projectileLengthM *= 0.72;
    }

    // -----------------------------------------------------------------------
    // 6. Cortical Bone Fracture, Ray Deflection & Secondary Bone Shard Rays
    // -----------------------------------------------------------------------
    const stepBonesHit: SkeletalStructureId[] = [];
    for (const bone of prelimTier2.hitBones) {
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
        // Slight primary ray deflection & yaw destabilization off dense cortical bone
        deflectionDeg =
          behavior === 'AP_PENETRATOR_STABLE'
            ? 2.2
            : shattered
              ? 6.5
              : 4.2;
        const deflectAzimuth = ((seed * 0.31 + stepIndex * 1.9) % (2 * Math.PI));
        currentDirLocal = buildConeRayDirection(
          currentDirLocal,
          (deflectionDeg * Math.PI) / 180,
          deflectAzimuth
        );
        yawAngleDeg = Math.min(
          180,
          yawAngleDeg + (behavior === 'AP_PENETRATOR_STABLE' ? 5 : 22)
        );
        if (yawAngleDeg > peakYawAngleDeg) peakYawAngleDeg = yawAngleDeg;

        // Spawn 1–3 secondary cortical bone shard rays inside 12°–22° forward cone!
        spawnedShardCount = shattered ? 3 : currentEnergyJ > bone.fractureThresholdJ * 1.6 ? 2 : 1;
        stepFragmentSpawned = true;
        const shardTotalEnergyJ = Math.min(currentEnergyJ * 0.12, shattered ? 85 : 42);
        const perShardEnergyJ = Math.max(8, shardTotalEnergyJ / spawnedShardCount);
        const perShardMassKg = 0.0014;

        for (let sIdx = 0; sIdx < spawnedShardCount; sIdx++) {
          const coneDeg = 12 + ((sIdx * 5 + stepIndex * 3) % 10); // 12–21 deg forward cone
          const azRad = ((sIdx * 2.39996 + stepIndex * 0.7) % (2 * Math.PI));
          const shardDir = buildConeRayDirection(
            currentDirLocal,
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

    const stepDepositedJ = Math.min(currentEnergyJ, stepEnergyLossJ);
    const velocityBeforeStepUpdateMs = currentVelocityMs;
    currentEnergyJ = Math.max(0, currentEnergyJ - stepDepositedJ);
    currentVelocityMs =
      projectileMassKg > 0 ? Math.sqrt((2 * currentEnergyJ) / projectileMassKg) : 0;

    // -----------------------------------------------------------------------
    // 7. Temporary Stretch Radius R_temp ~ sqrt(dEk / dx) & Elastic vs Inelastic Gate
    // -----------------------------------------------------------------------
    const linearEnergyTransferJPerM = stepDepositedJ / stepSizeM;
    const rawStretchRadiusM = Math.min(
      0.092,
      Math.max(crushRadiusM, 0.00038 * Math.sqrt(linearEnergyTransferJPerM))
    );

    const exactTier2 = bvh.queryTier2Step(
      currentPosLocal,
      nextPosLocal,
      crushRadiusM,
      rawStretchRadiusM,
      shellSample.baseDensityKgM3
    );

    const highVelocityStretchActive = velocityBeforeStepUpdateMs >= stretchVelocityThresholdMs;
    const intersectsInelasticOrgan = exactTier2.stretchOrgans.some((o) => o.isInelastic);
    const stretchCavitationActive = highVelocityStretchActive || intersectsInelasticOrgan;

    const stepOrgansCrushed: InternalOrganId[] = [];
    const stepOrgansStretched: InternalOrganId[] = [];
    const stepNervesHit: NeuralPlexusId[] = [];
    const stepVesselsHit: VascularVesselId[] = [];

    // Direct permanent crush organ lacerations
    for (const org of exactTier2.crushOrgans) {
      stepOrgansCrushed.push(org.id);
      const prev = organTraumaMap.get(org.id);
      const addedSeverity = Math.min(1.0, 0.45 + stepDepositedJ / 140);
      organTraumaMap.set(org.id, {
        isInelastic: org.isInelastic,
        directCrushLacerated: true,
        stretchCavitationRuptured:
          (prev?.stretchCavitationRuptured ?? false) ||
          ((highVelocityStretchActive || org.isInelastic) &&
            (prev?.energyDepositedJ ?? 0) + stepDepositedJ >= org.parenchymaRuptureThresholdJ),
        energyDepositedJ: (prev?.energyDepositedJ ?? 0) + stepDepositedJ,
        severity: Math.min(1.0, (prev?.severity ?? 0) + addedSeverity),
        positionLocal: prev?.positionLocal ?? copyVec3(midLocal),
        ghoulZone: org.id,
      });
    }

    // Temporary stretch cavitation organ trauma (active ONLY when v >= 600 m/s OR organ.isInelastic!)
    // Note: Heart myocardium has high elastic collagen strength and requires close-range inner-core stretch,
    // whereas friable inelastic Brain/Liver parenchyma ruptures across the full temporary stretch cavity!
    for (const org of exactTier2.stretchOrgans) {
      if (!highVelocityStretchActive && !org.isInelastic) {
        continue; // Sub-600 m/s pistol stretch in elastic lung/gut/muscle rebounds elastically without rupture!
      }
      if (org.id === 'HEART' && !stepOrgansCrushed.includes('HEART') && stepDepositedJ < 95) {
        continue;
      }
      stepOrgansStretched.push(org.id);
      const prev = organTraumaMap.get(org.id);
      const stretchEnergyShareJ = stepDepositedJ * (org.isInelastic ? 0.85 : 0.55);
      const cumulativeEnergy = (prev?.energyDepositedJ ?? 0) + stretchEnergyShareJ;
      const ruptured =
        (prev?.stretchCavitationRuptured ?? false) ||
        cumulativeEnergy >= org.parenchymaRuptureThresholdJ;

      organTraumaMap.set(org.id, {
        isInelastic: org.isInelastic,
        directCrushLacerated: prev?.directCrushLacerated ?? false,
        stretchCavitationRuptured: ruptured,
        energyDepositedJ: cumulativeEnergy,
        severity: Math.min(
          1.0,
          Math.max(prev?.severity ?? 0, ruptured ? 0.88 : 0.42)
        ),
        positionLocal: prev?.positionLocal ?? copyVec3(midLocal),
        ghoulZone: org.id,
      });
    }

    // Neural Plexus Hits (direct crush or high-velocity stretch)
    for (const nv of exactTier2.crushNerves) {
      stepNervesHit.push(nv.id);
      nervesSeveredSet.add(nv.id);
    }
    if (highVelocityStretchActive) {
      for (const nv of exactTier2.stretchNerves) {
        if (!nervesSeveredSet.has(nv.id) && stepDepositedJ > 45) {
          stepNervesHit.push(nv.id);
          nervesSeveredSet.add(nv.id);
        }
      }
    }

    // Vascular Spline Hits:
    // - Direct permanent crush (within R_perm) -> full transection (severity = 1.0)
    // - Stretch cavitation avulsion (within R_temp ONLY when v >= 600 m/s OR inelastic liver/brain parenchyma bursts nearby!)
    for (const vMatch of exactTier2.crushVessels) {
      const sp = vMatch.spline;
      stepVesselsHit.push(sp.id);
      const outwardLocal = normalize(sub(vMatch.closestPointLocal, vec3(0, vMatch.closestPointLocal.y, 0)));
      const sprayLocal =
        length(outwardLocal) > 0.1 ? outwardLocal : scale(currentDirLocal, -1);
      vascularWoundMap.set(sp.id, {
        vesselId: sp.id,
        vesselKind: sp.vesselKind,
        ghoulZone: sp.ghoulZone,
        positionLocal: copyVec3(vMatch.closestPointLocal),
        positionWorld: characterLocalPointToWorld(
          vMatch.closestPointLocal,
          transform,
          sp.ghoulZone
        ),
        sprayDirectionWorld: characterLocalDirectionToWorld(sprayLocal, transform),
        severity: 1.0,
        baseBleedMlPerSec: sp.mlPerSec,
      });
    }

    if (stretchCavitationActive) {
      // Fackler wound ballistics: elastic collagen/elastin arterial walls resist outer-fringe stretch waves,
      // avulsing only within the inner high-strain shear core (~3.2 cm max), unless embedded in bursting inelastic parenchyma.
      const vesselStretchShearLimitM = intersectsInelasticOrgan
        ? rawStretchRadiusM
        : Math.min(0.038, rawStretchRadiusM);

      for (const vMatch of exactTier2.stretchVessels) {
        const sp = vMatch.spline;
        if (vMatch.surfaceDistanceM > vesselStretchShearLimitM) {
          continue;
        }
        // If <600 m/s, only avulse vessels embedded inside/adjacent to an inelastic organ that actually ruptured
        if (!highVelocityStretchActive && !intersectsInelasticOrgan) {
          continue;
        }
        if (stepDepositedJ < 18) continue;

        stepVesselsHit.push(sp.id);
        const existing = vascularWoundMap.get(sp.id);
        const proximityFactor = Math.max(
          0.38,
          1.0 - Math.max(0, vMatch.surfaceDistanceM) / Math.max(0.005, rawStretchRadiusM)
        );
        const stretchSeverity = Math.min(0.85, 0.42 + 0.45 * proximityFactor);
        if (!existing || stretchSeverity > existing.severity) {
          const outwardLocal = normalize(
            sub(vMatch.closestPointLocal, vec3(0, vMatch.closestPointLocal.y, 0))
          );
          const sprayLocal =
            length(outwardLocal) > 0.1 ? outwardLocal : scale(currentDirLocal, -1);
          vascularWoundMap.set(sp.id, {
            vesselId: sp.id,
            vesselKind: sp.vesselKind,
            ghoulZone: sp.ghoulZone,
            positionLocal: copyVec3(vMatch.closestPointLocal),
            positionWorld: characterLocalPointToWorld(
              vMatch.closestPointLocal,
              transform,
              sp.ghoulZone
            ),
            sprayDirectionWorld: characterLocalDirectionToWorld(sprayLocal, transform),
            severity: stretchSeverity,
            baseBleedMlPerSec: sp.mlPerSec * stretchSeverity,
          });
        }
      }
    }

    steps.push({
      stepIndex: stepIndex++,
      positionLocal: copyVec3(midLocal),
      positionWorld: characterLocalPointToWorld(midLocal, transform),
      depthCm,
      tissueDensityKgM3: rho,
      velocityMs: currentVelocityMs,
      kineticEnergyJ: currentEnergyJ,
      energyDepositedStepJ: stepDepositedJ,
      yawAngleDeg,
      effectiveCaliberM,
      crushRadiusM,
      stretchRadiusM: stretchCavitationActive ? rawStretchRadiusM : crushRadiusM,
      stretchCavitationActive,
      armorPlateHit: stepArmorHit,
      organsCrushed: stepOrgansCrushed,
      organsStretched: stepOrgansStretched,
      bonesHit: stepBonesHit,
      nervesHit: stepNervesHit,
      vesselsHit: stepVesselsHit,
      fragmentSpawned: stepFragmentSpawned,
    });

    currentPosLocal = nextPosLocal;
  }

  // Fold secondary fragment sub-ray lacerations into aggregate organ, nerve, and vascular trauma!
  for (const frag of secondaryFragments) {
    for (const nvId of frag.nervesLacerated) {
      nervesSeveredSet.add(nvId);
    }
    for (const orgId of frag.organsLacerated) {
      const orgDef = bvh.organs.find((o) => o.organ.id === orgId)?.organ;
      if (!orgDef) continue;
      const prev = organTraumaMap.get(orgId);
      organTraumaMap.set(orgId, {
        isInelastic: orgDef.isInelastic,
        directCrushLacerated: true,
        stretchCavitationRuptured: prev?.stretchCavitationRuptured ?? false,
        energyDepositedJ: (prev?.energyDepositedJ ?? 0) + frag.initialEnergyJ * 0.5,
        severity: Math.min(1.0, Math.max(prev?.severity ?? 0, 0.52)),
        positionLocal: prev?.positionLocal ?? copyVec3(frag.originLocal),
        ghoulZone: orgId,
      });
    }
    for (const vId of frag.vesselsLacerated) {
      const spDef = bvh.vascularSplines.find((v) => v.spline.id === vId)?.spline;
      if (!spDef) continue;
      const prev = vascularWoundMap.get(vId);
      const fragSev = 0.65;
      if (!prev || fragSev > prev.severity) {
        vascularWoundMap.set(vId, {
          vesselId: vId,
          vesselKind: spDef.vesselKind,
          ghoulZone: spDef.ghoulZone,
          positionLocal: copyVec3(frag.originLocal),
          positionWorld: characterLocalPointToWorld(frag.originLocal, transform, spDef.ghoulZone),
          sprayDirectionWorld: characterLocalDirectionToWorld(
            scale(initialDirLocal, -1),
            transform
          ),
          severity: fragSev,
          baseBleedMlPerSec: spDef.mlPerSec * fragSev,
        });
      }
    }
  }

  const hitOuterShell = enteredTissue || stoppedByArmorPlate !== null;
  const overPenetrated = enteredTissue && stoppedByArmorPlate === null && currentEnergyJ > 2.0;
  const exitEnergyJ = stoppedByArmorPlate ? 0 : currentEnergyJ;
  const exitVelocityMs = stoppedByArmorPlate ? 0 : currentVelocityMs;
  const totalEnergyDepositedJ = Math.max(0, entryEnergyJ - exitEnergyJ);

  const organTrauma: OrganTraumaRecord[] = Array.from(organTraumaMap.entries()).map(
    ([organId, rec]) => {
      const orgDef = bvh.organs.find((o) => o.organ.id === organId)?.organ;
      return {
        organId,
        isInelastic: rec.isInelastic,
        directCrushLacerated: rec.directCrushLacerated,
        stretchCavitationRuptured: rec.stretchCavitationRuptured,
        energyDepositedJ: rec.energyDepositedJ,
        severity: rec.severity,
        positionLocal: rec.positionLocal,
        positionWorld: characterLocalPointToWorld(
          rec.positionLocal,
          transform,
          orgDef?.ghoulZone
        ),
      };
    }
  );

  // Baseline microvascular skeletal muscle ooze along the permanent crush wound tract (4–14 mL/s)
  const woundTractMuscleBleedMlPerSec = enteredTissue
    ? Math.min(16, Math.max(3.5, softTissueDepthM * 28 * (effectiveCaliberM / 0.009)))
    : 0;

  return {
    hitOuterShell,
    entryPointLocal,
    exitPointLocal: overPenetrated ? lastInsidePointLocal : null,
    entryPointWorld: entryPointLocal ? characterLocalPointToWorld(entryPointLocal, transform) : null,
    exitPointWorld:
      overPenetrated && lastInsidePointLocal
        ? characterLocalPointToWorld(lastInsidePointLocal, transform)
        : null,
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
