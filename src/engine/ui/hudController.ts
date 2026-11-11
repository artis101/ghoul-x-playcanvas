import type { AmmoSpec, ShotSimulationReport, TargetHealthState, WeaponSpec } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import type { PlayerCombatVitals } from '../ai/tacticalCombatAi.ts';
import type { BulletTimeVignetteState } from '../fx/mayhemDirector.ts';
import { HudReticleScope } from './hudReticleScope.ts';
import { HudTriageFeed } from './hudTriageFeed.ts';
import type { ProjectedTargetTriageEntry } from './hudTypes.ts';
import { HudWeaponVitals } from './hudWeaponVitals.ts';

export * from './hudTypes.ts';

export class HudController {
  private readonly vitals = new HudWeaponVitals();
  private readonly reticle = new HudReticleScope();
  private readonly triage = new HudTriageFeed();

  public updateWeaponHud(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    magCount: number,
    reserveCount: number,
    isReloading: boolean
  ): void {
    this.vitals.updateWeaponHud(weapon, ammo, magCount, reserveCount, isReloading);
  }

  public updatePlayerVitals(vitals: Readonly<PlayerCombatVitals>, dt = 0.016): void {
    this.vitals.updatePlayerVitals(vitals, dt);
  }

  public triggerPlayerDamageFlash(): void {
    this.vitals.triggerPlayerDamageFlash();
  }

  public updateBulletTimeHud(state: BulletTimeVignetteState): void {
    this.vitals.updateBulletTimeHud(state);
  }

  public setCrosshairBloom(scaleFactor: number, hidden = false): void {
    this.reticle.setCrosshairBloom(scaleFactor, hidden);
  }

  public triggerHitmarker(mode: 'NORMAL' | 'ARMOR' | 'LETHAL' | boolean): void {
    this.reticle.triggerHitmarker(mode);
  }

  public setScopeOverlay(active: boolean, zoom = 4.0, range = 42.0, dropCm = 0.0): void {
    this.reticle.setScopeOverlay(active, zoom, range, dropCm);
  }

  public updateTriageOverlays(
    entries: ProjectedTargetTriageEntry[],
    focusedTarget: TargetHealthState | null,
    focusedPhysiology?: PhysiologicalEntityState | null
  ): void {
    this.triage.updateTriageOverlays(entries, focusedTarget, focusedPhysiology);
  }

  public pushCombatFeed(
    report: ShotSimulationReport,
    weaponCode: string,
    targetName: string,
    wasAliveBefore: boolean,
    isAliveAfter: boolean
  ): void {
    this.triage.pushCombatFeed(report, weaponCode, targetName, wasAliveBefore, isAliveAfter);
  }

  public pushSystemToast(tag: string, message: string): void {
    this.triage.pushSystemToast(tag, message);
  }

  public updateContextPrompt(isPointerLocked: boolean, allHostilesDown: boolean): void {
    this.triage.updateContextPrompt(isPointerLocked, allHostilesDown);
  }
}
