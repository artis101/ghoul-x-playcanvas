import type { BlastEvent } from '../../contracts/destruction.ts';
import type { CombatDirector } from '../combat/combatDirector.ts';
import type { DestructionManager } from '../destruction/destructionManager.ts';
import type { MayhemDirector } from '../fx/mayhemDirector.ts';
import type { TacticalCombatAiSystem } from '../ai/tacticalCombatAi.ts';

export function wireCombatDirectorInterceptors(
  combatDirector: CombatDirector,
  destructionManager: DestructionManager,
  mayhemDirector: MayhemDirector,
  tacticalAi: TacticalCombatAiSystem
): void {
  combatDirector.environmentRayInterceptor = (
    origin,
    dir,
    maxDistM,
    energyJ,
    speedMs,
    caliberDiameterM,
    isAp
  ) =>
    destructionManager.interceptRaySegment(
      origin,
      dir,
      maxDistM,
      energyJ,
      speedMs,
      caliberDiameterM,
      isAp
    );

  combatDirector.onExplosionBlast = (center, radiusM, peakImpulseNs, peakEnergyJ) => {
    const blast: BlastEvent = { centerWorld: center, radiusM, peakImpulseNs, peakEnergyJ };
    destructionManager.applyBlast(blast);
    mayhemDirector.notifyExternalExplosion(blast, 0);
    tacticalAi.notifyGunshotOrExplosion(center, 45.0, 0.72);
  };
}
