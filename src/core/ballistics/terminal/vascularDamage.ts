import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  CharacterTransform,
  InternalOrganId,
  NeuralPlexusId,
  SecondaryFragmentTrajectory,
  Tier2SpatialQueryResult,
  VascularVesselId,
  VascularWoundRecord,
} from '../../../contracts/physiology.ts';
import {
  AnatomicalBvh,
  characterLocalDirectionToWorld,
  characterLocalPointToWorld,
} from '../../ghoul/bvhVolumes.ts';
import { copyVec3, length, normalize, scale, sub, vec3 } from '../vec3.ts';

export function evaluateVascularTraumaStep(
  exactTier2: Tier2SpatialQueryResult,
  stretchCavitationActive: boolean,
  highVelocityStretchActive: boolean,
  intersectsInelasticOrgan: boolean,
  rawStretchRadiusM: number,
  stepDepositedJ: number,
  currentDirLocal: Vec3Like,
  transform: CharacterTransform,
  vascularWoundMap: Map<VascularVesselId, VascularWoundRecord>
): VascularVesselId[] {
  const stepVesselsHit: VascularVesselId[] = [];

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
    const vesselStretchShearLimitM = intersectsInelasticOrgan
      ? rawStretchRadiusM
      : Math.min(0.038, rawStretchRadiusM);

    for (const vMatch of exactTier2.stretchVessels) {
      const sp = vMatch.spline;
      if (vMatch.surfaceDistanceM > vesselStretchShearLimitM) {
        continue;
      }
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

  return stepVesselsHit;
}

export function foldSecondaryFragmentsTrauma(
  secondaryFragments: SecondaryFragmentTrajectory[],
  bvh: AnatomicalBvh,
  transform: CharacterTransform,
  initialDirLocal: Vec3Like,
  nervesSeveredSet: Set<NeuralPlexusId>,
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
  vascularWoundMap: Map<VascularVesselId, VascularWoundRecord>
): void {
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
}
