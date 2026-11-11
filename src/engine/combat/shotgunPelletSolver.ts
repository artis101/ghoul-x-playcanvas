import type { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import { distance, deterministicConeSpread } from '../../core/ballistics/vec3.ts';
import { simulateShot } from '../../core/ballistics/solver.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { EnvironmentRayInterceptor } from './combatTypes.ts';
import { isTargetNearShotCone, truncateTrajectorySamples, buildSyntheticFlightSamples } from './hitRoutingUtils.ts';
import { applyImpactFxAndState, type ImpactDispatcherContext } from './impactDamageDispatcher.ts';

export function fireMultiPelletShot(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  origin: Vec3Like,
  normAim: Vec3Like,
  perPelletEnergyJ: number,
  muzzleSpeedMs: number,
  isAp: boolean,
  targets: GhoulMannequinEntity[],
  environment: EnvironmentState,
  fxManager: GoreAndBallisticsFxManager,
  interceptor?: EnvironmentRayInterceptor,
  impactCtx?: ImpactDispatcherContext
): void {
  const pelletCount = Math.max(1, ammo.pelletCount);
  const nearTargets = targets.filter((c) => isTargetNearShotCone(c, origin, normAim, ammo, environment));

  if (nearTargets.length === 0) {
    for (let pIdx = 0; pIdx < pelletCount; pIdx++) {
      const pelletDir = deterministicConeSpread(normAim, ammo.spreadRadians, pIdx, pelletCount);
      const intercept = interceptor?.(origin, pelletDir, 80.0, perPelletEnergyJ, muzzleSpeedMs, ammo.diameterM, isAp);
      const traceDistM = Math.max(0.25, intercept?.stoppedDistanceM ?? 45.0);
      const samples = buildSyntheticFlightSamples(origin, pelletDir, muzzleSpeedMs, ammo.massKg, traceDistM, environment.speedOfSoundMs);
      fxManager.spawnFlyingProjectile(samples, true);
    }
    return;
  }

  const candidateReports = nearTargets.map((cand) => ({
    target: cand,
    report: simulateShot(weapon, ammo, origin, normAim, cand.healthState, environment),
  }));

  const basePelletCount = candidateReports[0].report.pelletResults.length;
  const blockedPellets = new Set<number>();
  let speedRatioSum = 0;
  let unblockedCount = 0;

  for (let pIdx = 0; pIdx < basePelletCount; pIdx++) {
    let chosenSamples = candidateReports[0].report.pelletResults[pIdx].trajectorySamples;
    let earliestHitDistM = 80.0;
    let earliestHitS = Infinity;

    for (const cr of candidateReports) {
      const pr = cr.report.pelletResults[pIdx];
      if (pr?.hitTarget && pr.trajectorySamples.length > 0) {
        const hitTime = pr.trajectorySamples[pr.trajectorySamples.length - 1].timeS;
        if (hitTime < earliestHitS) {
          earliestHitS = hitTime;
          chosenSamples = pr.trajectorySamples;
          if (pr.impactPointWorld) earliestHitDistM = distance(origin, pr.impactPointWorld);
        }
      }
    }

    const pelletDir = deterministicConeSpread(normAim, ammo.spreadRadians, pIdx, basePelletCount);
    if (interceptor) {
      const intercept = interceptor(origin, pelletDir, earliestHitDistM, perPelletEnergyJ, muzzleSpeedMs, ammo.diameterM, isAp);
      if (intercept.blocked || intercept.remainingSpeedMs <= 25 || intercept.remainingEnergyJ <= 8) {
        blockedPellets.add(pIdx);
        const stopDistM = Math.max(0.25, intercept.stoppedDistanceM ?? earliestHitDistM);
        chosenSamples = chosenSamples.length > 1
          ? truncateTrajectorySamples(chosenSamples, origin, stopDistM)
          : buildSyntheticFlightSamples(origin, pelletDir, muzzleSpeedMs, ammo.massKg, stopDistM, environment.speedOfSoundMs);
      } else {
        speedRatioSum += intercept.remainingSpeedMs / Math.max(1, muzzleSpeedMs);
        unblockedCount++;
      }
    }

    if (chosenSamples.length < 2) {
      chosenSamples = buildSyntheticFlightSamples(origin, pelletDir, muzzleSpeedMs, ammo.massKg, 45.0, environment.speedOfSoundMs);
    }
    fxManager.spawnFlyingProjectile(chosenSamples, true);
  }

  if (!impactCtx) return;

  for (const cr of candidateReports) {
    if (!cr.report.hitTarget) continue;
    if (interceptor) {
      const anyReached = cr.report.pelletResults.some((pr, idx) => pr.hitTarget && !blockedPellets.has(idx));
      if (!anyReached) continue;
      const avgRatio = unblockedCount > 0 ? speedRatioSum / unblockedCount : 1.0;
      if (avgRatio < 0.96) {
        const attenAmmo: AmmoSpec = { ...ammo, muzzleVelocityMs: muzzleSpeedMs * avgRatio };
        const attenReport = simulateShot(weapon, attenAmmo, origin, normAim, cr.target.healthState, environment);
        if (attenReport.hitTarget) {
          applyImpactFxAndState(cr.target, attenReport, weapon.codeName, impactCtx, attenAmmo);
        }
        continue;
      }
    }
    applyImpactFxAndState(cr.target, cr.report, weapon.codeName, impactCtx, ammo);
  }
}
