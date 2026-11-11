import { AmmoSpec, Vec3Like } from '../../../contracts/ballistics.ts';
import { ArmorPlateId, RayMarchStepRecord } from '../../../contracts/physiology.ts';
import { AnatomicalBvh, characterLocalPointToWorld } from '../../ghoul/bvhVolumes.ts';
import { copyVec3, lerp } from '../vec3.ts';
import { computeEffectivePlateThreatJ } from './armorThreat.ts';
import { ProjectileTerminalBehavior } from './projectileBehavior.ts';

export interface ArmorPlateStepResult {
  stepArmorHit: ArmorPlateId | null;
  stoppedByArmorPlate: ArmorPlateId | null;
  armorBackfaceBluntTraumaJ: number;
  currentEnergyJ: number;
  currentVelocityMs: number;
  yawAngleDeg: number;
  peakYawAngleDeg: number;
  entryPointLocal: Vec3Like | null;
  lastInsidePointLocal: Vec3Like | null;
  terminalStepRecord: RayMarchStepRecord | null;
}

export function evaluateArmorPlatesStep(
  bvh: AnatomicalBvh,
  currentPosLocal: Vec3Like,
  nextPosLocal: Vec3Like,
  enableArmorPlates: boolean,
  enableHelmet: boolean,
  evaluatedPlates: Set<ArmorPlateId>,
  armorPlatesIntersected: ArmorPlateId[],
  plateIntegrityAfter: Record<ArmorPlateId, number>,
  ammo: AmmoSpec,
  currentEnergyJ: number,
  currentVelocityMs: number,
  projectileMassKg: number,
  behavior: ProjectileTerminalBehavior,
  yawAngleDeg: number,
  peakYawAngleDeg: number,
  softTissueDepthM: number,
  effectiveCaliberM: number,
  stepIndex: number,
  transform: any,
  entryPointLocal: Vec3Like | null,
  lastInsidePointLocal: Vec3Like | null
): ArmorPlateStepResult {
  const hitPlates = bvh.queryArmorPlatesAlongSegment(currentPosLocal, nextPosLocal, enableArmorPlates, enableHelmet);
  let stepArmorHit: ArmorPlateId | null = null;
  let stoppedByArmorPlate: ArmorPlateId | null = null;
  let bluntTraumaJ = 0;
  let energyJ = currentEnergyJ;
  let velMs = currentVelocityMs;
  let yawDeg = yawAngleDeg;
  let peakYaw = peakYawAngleDeg;
  let entryPt = entryPointLocal;
  let lastInside = lastInsidePointLocal;
  let terminalStepRecord: RayMarchStepRecord | null = null;

  for (const plate of hitPlates) {
    stepArmorHit = plate.id;
    if (evaluatedPlates.has(plate.id)) continue;
    evaluatedPlates.add(plate.id);
    armorPlatesIntersected.push(plate.id);

    const priorIntegrity = plateIntegrityAfter[plate.id];
    if (priorIntegrity <= 0.02) continue;

    const stopCapacityJ = plate.maxStopEnergyJ * priorIntegrity;
    const effectiveThreatJ = computeEffectivePlateThreatJ(plate, ammo, energyJ);
    const integrityDrop = (energyJ / 1000) * plate.degradationPerKilojoule;
    plateIntegrityAfter[plate.id] = Math.max(0, priorIntegrity - integrityDrop);

    if (effectiveThreatJ <= stopCapacityJ) {
      stoppedByArmorPlate = plate.id;
      bluntTraumaJ += energyJ * plate.backfaceBluntTransferRatio;
      const hitMidLocal = lerp(currentPosLocal, nextPosLocal, 0.5);
      if (!entryPt) entryPt = copyVec3(hitMidLocal);
      lastInside = copyVec3(hitMidLocal);

      terminalStepRecord = {
        stepIndex,
        positionLocal: copyVec3(hitMidLocal),
        positionWorld: characterLocalPointToWorld(hitMidLocal, transform, plate.ghoulZone),
        depthCm: softTissueDepthM * 100,
        tissueDensityKgM3: plate.densityKgM3,
        velocityMs: 0,
        kineticEnergyJ: 0,
        energyDepositedStepJ: energyJ,
        yawAngleDeg: yawDeg,
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
      };
      energyJ = 0;
      velMs = 0;
      break;
    } else {
      const absorbedRatio = Math.min(0.82, stopCapacityJ / Math.max(1, effectiveThreatJ));
      const plateLossJ = energyJ * absorbedRatio * 0.72;
      bluntTraumaJ += plateLossJ * plate.backfaceBluntTransferRatio * 0.5;
      energyJ = Math.max(5, energyJ - plateLossJ);
      velMs = Math.sqrt((2 * energyJ) / projectileMassKg);
      yawDeg = Math.min(180, yawDeg + (behavior === 'AP_PENETRATOR_STABLE' ? 4 : 18));
      if (yawDeg > peakYaw) peakYaw = yawDeg;
    }
  }

  return {
    stepArmorHit,
    stoppedByArmorPlate,
    armorBackfaceBluntTraumaJ: bluntTraumaJ,
    currentEnergyJ: energyJ,
    currentVelocityMs: velMs,
    yawAngleDeg: yawDeg,
    peakYawAngleDeg: peakYaw,
    entryPointLocal: entryPt,
    lastInsidePointLocal: lastInside,
    terminalStepRecord,
  };
}
