import * as pc from 'playcanvas';
import type { GhoulMannequinEntity } from './ghoulMannequinEntity.ts';

/**
 * @attribute {string} defaultClip - Initial animation clip name (default: 'CombatReadyIdle')
 * @attribute {boolean} isSouthpaw - Mirrored southpaw stance flag
 * @attribute {number} armorIntegrity - Damage absorption multiplier
 */
export class CombatantMannequinScript extends pc.Script {
  public static scriptName = 'combatantMannequinScript';

  public defaultClip = 'CombatReadyIdle';
  public isSouthpaw = false;
  public armorIntegrity = 1.0;

  public mannequin: GhoulMannequinEntity | null = null;
  private readonly _eventCleanups: Array<() => void> = [];

  public initialize(): void {
    this.bindEvents();
  }

  private bindEvents(): void {
    this.unbindEvents();
    this.entity.on('combatant:damage', this.onDamage, this);
    this.entity.on('combatant:xray', this.onXRay, this);
    this._eventCleanups.push(
      () => this.entity.off('combatant:damage', this.onDamage, this),
      () => this.entity.off('combatant:xray', this.onXRay, this)
    );
  }

  private unbindEvents(): void {
    for (const cleanup of this._eventCleanups) {
      cleanup();
    }
    this._eventCleanups.length = 0;
  }

  public update(dt: number): void {
    if (this.mannequin) {
      this.mannequin.syncFromHealthState(dt, (this.app as { time?: number }).time ?? 0);
    }
  }

  public swap(old: CombatantMannequinScript): void {
    old.unbindEvents();
    this.mannequin = old.mannequin;
    old.mannequin = null;
    this.defaultClip = old.defaultClip;
    this.isSouthpaw = old.isSouthpaw;
    this.armorIntegrity = old.armorIntegrity;
    this.bindEvents();
  }

  public destroy(): void {
    this.unbindEvents();
    if (this.mannequin) {
      this.mannequin.destroy();
      this.mannequin = null;
    }
  }

  private onDamage(payload: { damage: number }): void {
    if (this.mannequin) {
      this.mannequin.healthState.currentHp -= payload.damage * this.armorIntegrity;
    }
  }

  private onXRay(enabled: boolean): void {
    if (this.mannequin) {
      this.mannequin.setXRayMode(enabled);
    }
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    CombatantMannequinScript,
    'combatantMannequinScript'
  );
} catch {
  // No active pc.Application at module import time in headless tests
}
