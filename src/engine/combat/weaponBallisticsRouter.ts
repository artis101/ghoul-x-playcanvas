import type { AmmoSpec, EnvironmentState, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import type { InternalBallisticsReport } from '../../contracts/physiology.ts';
import { add, distance, normalize, scale, sub } from '../../core/ballistics/vec3.ts';
import { simulateShot } from '../../core/ballistics/solver.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';
import type { EnvironmentRayInterceptor } from './combatTypes.ts';
import { findBestTargetHit, truncateTrajectorySamples, buildSyntheticFlightSamples } from './hitRoutingUtils.ts';
import { applyImpactFxAndState, type ImpactDispatcherContext } from './impactDamageDispatcher.ts';
import { fireMultiPelletShot } from './shotgunPelletSolver.ts';

export function routeWeaponFire(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  origin: Vec3Like,
  aimDir: Vec3Like,
  targets: GhoulMannequinEntity[],
  environment: EnvironmentState,
  fxManager: GoreAndBallisticsFxManager,
  interceptor?: EnvironmentRayInterceptor,
  impactCtx?: ImpactDispatcherContext
): InternalBallisticsReport | null {
  const normAim = normalize(aimDir);
  const muzzleSpeedMs = ammo.muzzleVelocityMs;
  const muzzleEnergyJ = 0.5 * ammo.massKg * muzzleSpeedMs * muzzleSpeedMs;
  const isAp = ammo.type === 'AP' || ammo.armorPenetrationFactor >= 1.35;

  if (ammo.pelletCount > 1) {
    fireMultiPelletShot(weapon, ammo, origin, normAim, muzzleEnergyJ, muzzleSpeedMs, isAp, targets, environment, fxManager, interceptor, impactCtx);
    return null;
  }

  const match = findBestTargetHit(weapon, ammo, origin, normAim, targets, environment);
  if (!match || !match.report.hitTarget) {
    let stoppedDistM: number | undefined;
    if (interceptor) {
      const envRes = interceptor(origin, normAim, 150.0, muzzleEnergyJ, muzzleSpeedMs, ammo.diameterM, isAp);
      stoppedDistM = envRes.stoppedDistanceM;
    }
    const traceDistM = Math.max(0.25, stoppedDistM ?? 85.0);
    const samples = match && match.report.trajectorySamples.length > 1
      ? stoppedDistM !== undefined ? truncateTrajectorySamples(match.report.trajectorySamples, origin, traceDistM) : match.report.trajectorySamples
      : buildSyntheticFlightSamples(origin, normAim, muzzleSpeedMs, ammo.massKg, traceDistM, environment.speedOfSoundMs);
    fxManager.spawnFlyingProjectile(samples, false);
    return null;
  }

  const { target } = match;
  let { report } = match;
  let effectiveAmmo: AmmoSpec = ammo;
  const firstWound = report.woundEvents[0];
  const hitDistM = firstWound ? distance(origin, firstWound.entryPointWorld) : report.targetDistanceM;
  const interceptDir =
    firstWound && hitDistM > 1e-4
      ? normalize(sub(firstWound.entryPointWorld, origin))
      : normAim;

  if (interceptor) {
    const preIntercept = interceptor(origin, interceptDir, hitDistM, muzzleEnergyJ, muzzleSpeedMs, ammo.diameterM, isAp);
    if (preIntercept.blocked || preIntercept.remainingSpeedMs <= 25 || preIntercept.remainingEnergyJ <= 10) {
      const stopAtM = Math.max(0.25, preIntercept.stoppedDistanceM ?? hitDistM);
      const stoppedSamples = truncateTrajectorySamples(report.trajectorySamples, origin, stopAtM);
      fxManager.spawnFlyingProjectile(stoppedSamples, false);
      return null;
    }

    if (preIntercept.remainingSpeedMs < muzzleSpeedMs * 0.98) {
      effectiveAmmo = { ...ammo, muzzleVelocityMs: preIntercept.remainingSpeedMs };
      let attenuatedReport = simulateShot(weapon, effectiveAmmo, origin, normAim, target.healthState, environment);
      if (!attenuatedReport.hitTarget && firstWound) {
        const termDir = normalize(firstWound.impactDirectionWorld);
        const termOrigin = sub(firstWound.entryPointWorld, scale(termDir, 0.22));
        const terminalAmmo: AmmoSpec = { ...effectiveAmmo, spreadRadians: 0 };
        const terminalReport = simulateShot(weapon, terminalAmmo, termOrigin, termDir, target.healthState, environment);
        if (terminalReport.hitTarget) {
          attenuatedReport = {
            ...terminalReport,
            originWorld: report.originWorld,
            aimDirectionWorld: report.aimDirectionWorld,
            targetDistanceM: report.targetDistanceM,
            trajectorySamples: report.trajectorySamples,
          };
        }
      }
      if (!attenuatedReport.hitTarget) {
        if (attenuatedReport.trajectorySamples.length > 1) fxManager.spawnFlyingProjectile(attenuatedReport.trajectorySamples, false);
        return null;
      }
      report = attenuatedReport;
    }
  }

  if (report.trajectorySamples.length > 1) {
    fxManager.spawnFlyingProjectile(report.trajectorySamples, false);
  }

  if (!impactCtx) return null;
  const primaryInternalReport = applyImpactFxAndState(target, report, weapon.codeName, impactCtx, effectiveAmmo);

  if (report.woundEvents.length > 0) {
    const lastWound = report.woundEvents[report.woundEvents.length - 1];
    if (!lastWound.armorStopped && lastWound.exitEnergyJ > 160 && lastWound.exitVelocityMs > 90) {
      const excluded = new Set<GhoulMannequinEntity>([target]);
      const exitDir = normalize(lastWound.impactDirectionWorld);
      const exitOrigin = add(lastWound.exitPointWorld, scale(exitDir, 0.06));
      let residualSpeedMs = lastWound.exitVelocityMs;
      const residualEnergyJ = lastWound.exitEnergyJ;

      const baseResidualAmmo: AmmoSpec = { ...ammo, muzzleVelocityMs: residualSpeedMs, spreadRadians: 0 };
      const collateral = findBestTargetHit(weapon, baseResidualAmmo, exitOrigin, exitDir, targets, environment, excluded);

      if (collateral && collateral.report.hitTarget) {
        const collatFirstWound = collateral.report.woundEvents[0];
        const collatDistM = collatFirstWound ? distance(exitOrigin, collatFirstWound.entryPointWorld) : collateral.report.targetDistanceM;
        const collatInterceptDir =
          collatFirstWound && collatDistM > 1e-4
            ? normalize(sub(collatFirstWound.entryPointWorld, exitOrigin))
            : exitDir;
        let collatReport = collateral.report;
        let collatAmmo = baseResidualAmmo;
        let collatBlocked = false;

        if (interceptor) {
          const betweenIntercept = interceptor(exitOrigin, collatInterceptDir, collatDistM, residualEnergyJ, residualSpeedMs, ammo.diameterM, isAp);
          if (betweenIntercept.blocked || betweenIntercept.remainingSpeedMs <= 25 || betweenIntercept.remainingEnergyJ <= 10) {
            collatBlocked = true;
          } else if (betweenIntercept.remainingSpeedMs < residualSpeedMs * 0.98) {
            residualSpeedMs = betweenIntercept.remainingSpeedMs;
            collatAmmo = { ...baseResidualAmmo, muzzleVelocityMs: residualSpeedMs };
            collatReport = simulateShot(weapon, collatAmmo, exitOrigin, exitDir, collateral.target.healthState, environment);
            if (!collatReport.hitTarget) collatBlocked = true;
          }
        }
        if (!collatBlocked) {
          applyImpactFxAndState(collateral.target, collatReport, weapon.codeName, impactCtx, collatAmmo);
        }
      } else if (interceptor) {
        interceptor(exitOrigin, exitDir, 120.0, residualEnergyJ, residualSpeedMs, ammo.diameterM, isAp);
      }
    }
  }

  return primaryInternalReport;
}
