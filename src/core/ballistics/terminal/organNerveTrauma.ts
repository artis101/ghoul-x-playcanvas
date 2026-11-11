import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  InternalOrganId,
  NeuralPlexusId,
  Tier2SpatialQueryResult,
} from '../../../contracts/physiology.ts';
import { copyVec3 } from '../vec3.ts';

export function evaluateOrganAndNerveTrauma(
  exactTier2: Tier2SpatialQueryResult,
  stepDepositedJ: number,
  highVelocityStretchActive: boolean,
  midLocal: Vec3Like,
  organTraumaMap: Map<
    InternalOrganId,
    {
      isInelastic: boolean;
      directCrushLacerated: boolean;
      stretchCavitationRuptured: boolean;
      energyDepositedJ: number;
      severity: number;
      positionLocal: Vec3Like;
      ghoulZone: InternalOrganId;
    }
  >,
  nervesSeveredSet: Set<NeuralPlexusId>
): {
  stepOrgansCrushed: InternalOrganId[];
  stepOrgansStretched: InternalOrganId[];
  stepNervesHit: NeuralPlexusId[];
} {
  const stepOrgansCrushed: InternalOrganId[] = [];
  const stepOrgansStretched: InternalOrganId[] = [];
  const stepNervesHit: NeuralPlexusId[] = [];

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

  for (const org of exactTier2.stretchOrgans) {
    if (!highVelocityStretchActive && !org.isInelastic) {
      continue;
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

  return { stepOrgansCrushed, stepOrgansStretched, stepNervesHit };
}
