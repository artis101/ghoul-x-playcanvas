import type {
  AiBarkPayload,
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
} from '../../contracts/ai/aiContracts.ts';
import type { AmmoSpec, ShotSimulationReport, TargetHealthState, WeaponSpec } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { HudReticleScope } from './hudReticleScope.ts';
import { HudTriageFeed } from './hudTriageFeed.ts';
import type { ProjectedTargetTriageEntry } from './hudTypes.ts';
import { HudWeaponVitals } from './hudWeaponVitals.ts';

export * from './hudTypes.ts';

export class HudController {
  private readonly vitals = new HudWeaponVitals();
  private readonly reticle = new HudReticleScope();
  private readonly triage = new HudTriageFeed();
  private destroyed = false;

  /** Clears the HUD's timers and removes the DOM nodes it created; the page's own HUD elements stay. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reticle.destroy();
    this.triage.destroy();
    this.vitals.destroy();
  }

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

  public triggerNearMissGrazeFlash(kind: PlayerNearMissGrazeKind): void {
    this.vitals.triggerNearMissGrazeFlash(kind);
  }

  public setCrosshairBloom(scaleFactor: number, hidden = false, lineOpacity = 1): void {
    this.reticle.setCrosshairBloom(scaleFactor, hidden, lineOpacity);
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

  public pushRadioBark(bark: AiBarkPayload): void {
    this.triage.pushRadioBark(bark);
  }

  public updateContextPrompt(isPointerLocked: boolean, allHostilesDown: boolean): void {
    this.triage.updateContextPrompt(isPointerLocked, allHostilesDown);
  }
}
