import type { CombatDirector } from '../combat/combatDirector.ts';
import type { DestructionManager } from '../destruction/destructionManager.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';
import {
  fanOutBlast,
  GRENADE_BLAST_PROFILE,
  type BlastFanoutPlayer,
  type BlastFanoutSystems,
} from './blastFanout.ts';

export function wireCombatDirectorInterceptors(
  combatDirector: CombatDirector,
  destructionManager: DestructionManager,
  mayhemDirector: MayhemDirector,
  tacticalAi: TacticalCombatAiSystem,
  player: BlastFanoutPlayer | null = null
): void {
  combatDirector.environmentRayInterceptor = (
    origin,
    dir,
    maxDistM,
    energyJ,
    speedMs,
    caliberDiameterM,
    isAp,
    armorPenetrationFactor
  ) =>
    destructionManager.interceptRaySegment(
      origin,
      dir,
      maxDistM,
      energyJ,
      speedMs,
      caliberDiameterM,
      isAp,
      armorPenetrationFactor
    );

  combatDirector.grenadeSweepInterceptor = (
    prevPos,
    desiredPos,
    velocity,
    grenadeRadiusM,
    crossedGlassIds
  ) =>
    destructionManager.resolveGrenadeStep(
      prevPos,
      desiredPos,
      velocity,
      grenadeRadiusM,
      crossedGlassIds
    );

  mayhemDirector.isSurfaceOpenAtHit = (hit, origin, dir, maxDistM) =>
    destructionManager.isSurfaceOpenAtHit(hit, origin, dir, maxDistM);
  mayhemDirector.getBreachVersion = () => destructionManager.breachVersion;

  const blastSystems: BlastFanoutSystems = { combatDirector, destructionManager, mayhemDirector, tacticalAi, fpsController: player };
  combatDirector.onGrenadeBlast = (blast) => fanOutBlast(blastSystems, blast, GRENADE_BLAST_PROFILE);
}
