import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { TacticalCombatAiSystem } from './tacticalCombatAi.ts';

export type AiCoordinatorScriptState =
  | { readonly kind: 'UNINITIALIZED' }
  | { readonly kind: 'ACTIVE'; readonly system: TacticalCombatAiSystem | null }
  | { readonly kind: 'DESTROYED' };

/**
 * TacticalAiCoordinatorScript
 *
 * PlayCanvas ES6 script component coordinating Tactical Combat AI ticks,
 * sensory event subscriptions, and clean hot-reload lifecycle management.
 */
export class TacticalAiCoordinatorScript extends pc.Script {
  public static scriptName = 'tacticalAiCoordinator';

  /**
   * @attribute
   */
  public sightRangeM = 30.0;

  /**
   * @attribute
   */
  public playerDamageEnabled = true;

  private scriptState: AiCoordinatorScriptState = { kind: 'UNINITIALIZED' };
  private aiSystem: TacticalCombatAiSystem | null = null;
  private readonly _eventCleanups: Array<() => void> = [];

  private readonly onGunshotHandler = (soundOrigin: Vec3Like, radius?: number, impulse?: number) => {
    if (this.scriptState.kind !== 'ACTIVE') return;
    this.aiSystem?.notifyGunshotOrExplosion(soundOrigin, radius, impulse);
  };

  public initialize(): void {
    this.scriptState = { kind: 'ACTIVE', system: this.aiSystem };
    this.bindEventListeners();
  }

  public bindSystem(system: TacticalCombatAiSystem): void {
    if (this.scriptState.kind === 'DESTROYED') return;
    this.aiSystem = system;
    if (this.scriptState.kind === 'ACTIVE') {
      this.scriptState = { kind: 'ACTIVE', system };
    }
  }

  public update(_dt: number): void {
    // Stepped via CombatDirector orchestrator, or standalone tick if bound
  }

  public swap(old: TacticalAiCoordinatorScript): void {
    old.unbindEventListeners();
    if (this.aiSystem && this.aiSystem !== old.aiSystem) {
      this.aiSystem.destroy();
    }
    this.aiSystem = old.aiSystem;
    old.aiSystem = null;
    old.scriptState = { kind: 'DESTROYED' };

    this.sightRangeM = old.sightRangeM;
    this.playerDamageEnabled = old.playerDamageEnabled;
    this.scriptState = { kind: 'ACTIVE', system: this.aiSystem };
    this.unbindEventListeners();
    this.bindEventListeners();
  }

  public destroy(): void {
    this.unbindEventListeners();
    this.aiSystem = null;
    this.scriptState = { kind: 'DESTROYED' };
  }

  private bindEventListeners(): void {
    this.app.on('combat:gunshot', this.onGunshotHandler, this);
    this.app.on('combat:explosion', this.onGunshotHandler, this);
    this._eventCleanups.push(
      () => this.app.off('combat:gunshot', this.onGunshotHandler, this),
      () => this.app.off('combat:explosion', this.onGunshotHandler, this)
    );
  }

  private unbindEventListeners(): void {
    while (this._eventCleanups.length > 0) {
      this._eventCleanups.pop()?.();
    }
  }
}

try {
  const register = pc.registerScript as unknown as (
    script: typeof pc.Script,
    name?: string
  ) => void;
  register(TacticalAiCoordinatorScript, 'tacticalAiCoordinator');
} catch {}
