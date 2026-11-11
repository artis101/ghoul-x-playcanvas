import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { TacticalCombatAiSystem } from './tacticalCombatAi.ts';

/**
 * TacticalAiCoordinatorScript
 *
 * PlayCanvas script component coordinating Tactical Combat AI ticks,
 * sensory event subscriptions, and clean lifecycle management.
 */
export class TacticalAiCoordinatorScript extends pc.ScriptType {
  /**
   * @attribute
   */
  public sightRangeM = 30.0;

  /**
   * @attribute
   */
  public playerDamageEnabled = true;

  private aiSystem: TacticalCombatAiSystem | null = null;
  private readonly onGunshotHandler = (soundOrigin: Vec3Like, radius?: number, impulse?: number) => {
    this.aiSystem?.notifyGunshotOrExplosion(soundOrigin, radius, impulse);
  };

  public initialize(): void {
    this.app.on('combat:gunshot', this.onGunshotHandler, this);
    this.app.on('combat:explosion', this.onGunshotHandler, this);
  }

  public bindSystem(system: TacticalCombatAiSystem): void {
    this.aiSystem = system;
  }

  public update(dt: number): void {
    // Stepped via CombatDirector orchestrator, or standalone tick if bound
  }

  public swap(old: TacticalAiCoordinatorScript): void {
    this.aiSystem = old.aiSystem;
    this.sightRangeM = old.sightRangeM;
    this.playerDamageEnabled = old.playerDamageEnabled;
  }

  public destroy(): void {
    this.app.off('combat:gunshot', this.onGunshotHandler, this);
    this.app.off('combat:explosion', this.onGunshotHandler, this);
    this.aiSystem = null;
  }
}

try {
  pc.registerScript(TacticalAiCoordinatorScript, 'tacticalAiCoordinator');
} catch {}
