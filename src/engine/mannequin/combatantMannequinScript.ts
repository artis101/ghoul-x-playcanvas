import * as pc from 'playcanvas';
import type { GhoulMannequinEntity } from './ghoulMannequinEntity.ts';

/**
 * @attribute {string} defaultClip - Initial animation clip name (default: 'CombatReadyIdle')
 * @attribute {boolean} isSouthpaw - Mirrored southpaw stance flag
 * @attribute {number} armorIntegrity - Damage absorption multiplier
 */
export class CombatantMannequinScript extends pc.ScriptType {
  public defaultClip = 'CombatReadyIdle';
  public isSouthpaw = false;
  public armorIntegrity = 1.0;

  public mannequin: GhoulMannequinEntity | null = null;

  public initialize(): void {
    this.entity.on('combatant:damage', this.onDamage, this);
    this.entity.on('combatant:xray', this.onXRay, this);
  }

  public update(dt: number): void {
    if (this.mannequin) {
      this.mannequin.syncFromHealthState(dt, (this.app as any).time ?? 0);
    }
  }

  public swap(old: CombatantMannequinScript): void {
    this.mannequin = old.mannequin;
    this.defaultClip = old.defaultClip;
    this.isSouthpaw = old.isSouthpaw;
    this.armorIntegrity = old.armorIntegrity;
  }

  public destroy(): void {
    this.entity.off('combatant:damage', this.onDamage, this);
    this.entity.off('combatant:xray', this.onXRay, this);
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
