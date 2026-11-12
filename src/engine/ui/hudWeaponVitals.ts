import type { PlayerCombatVitals, PlayerNearMissGrazeKind } from '../../contracts/ai/aiContracts.ts';
import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { WEAPONS } from '../../core/ballistics/weapons.ts';
import type { BulletTimeVignetteState } from '../fx/mayhemDirector.ts';
import { queryEl } from './hudTypes.ts';

export type TraumaFlashState =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'WOUND_FLASH'; readonly alpha: number }
  | {
      readonly kind: 'GRAZE_FLASH';
      readonly grazeKind: PlayerNearMissGrazeKind;
      readonly alpha: number;
    };

export type BleedPulseState =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'PULSING'; readonly phaseRad: number };

export class HudWeaponVitals {
  private healthValEl = queryEl('hud-health-val');
  private healthFillEl = queryEl('hud-health-fill');
  private armorValEl = queryEl('hud-armor-val');
  private armorFillEl = queryEl('hud-armor-fill');
  private reflexValEl = queryEl('hud-reflex-val');
  private reflexFillEl = queryEl('hud-reflex-fill');

  private magCountEl = queryEl('hud-mag-count');
  private reserveCountEl = queryEl('hud-reserve-count');
  private weaponNameEl = queryEl('hud-weapon-name');
  private ammoCaliberEl = queryEl('hud-ammo-caliber');
  private shotgunRingEl = queryEl('shotgun-spread-ring');
  private vignetteEl = queryEl('bullet-time-vignette');
  private slotPips: HTMLElement[] = [];

  public traumaFlashState: TraumaFlashState = { kind: 'IDLE' };
  public bleedPulseState: BleedPulseState = { kind: 'NONE' };

  private lastBulletTimeCss = 'none';
  private lastAppliedVignetteCss = '';
  private lastHpRounded = -1;
  private lastArmorRounded = -1;
  private lastHpWidthStr = '';
  private lastArmorWidthStr = '';
  private lastReflexText = '';
  private lastReflexActive: boolean | null = null;
  private lastReflexWidthStr = '';

  constructor() {
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      this.slotPips = Array.from(document.querySelectorAll<HTMLElement>('.slot-pip'));
    }
  }

  public updateWeaponHud(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    magCount: number,
    reserveCount: number,
    isReloading: boolean
  ): void {
    const slotIdx = WEAPONS.findIndex((w) => w.id === weapon.id);
    this.slotPips.forEach((pip, idx) => pip.classList.toggle('active', idx === slotIdx));
    if (this.weaponNameEl) this.weaponNameEl.textContent = weapon.codeName;
    if (this.ammoCaliberEl) {
      if (isReloading) {
        this.ammoCaliberEl.textContent = 'RELOADING...';
      } else {
        const roleTag = ammo.armorPenetrationFactor >= 1.35 ? 'PEN' : 'STOP';
        this.ammoCaliberEl.textContent = `${ammo.caliber.toUpperCase()} • ${roleTag}`;
      }
    }
    if (this.magCountEl) {
      this.magCountEl.textContent = magCount.toString().padStart(2, '0');
      this.magCountEl.classList.toggle('low', magCount <= 2);
    }
    if (this.reserveCountEl) this.reserveCountEl.textContent = reserveCount.toString().padStart(2, '0');
    if (this.shotgunRingEl) {
      this.shotgunRingEl.style.display = weapon.role === 'SHOTGUN' && ammo.pelletCount > 1 ? 'block' : 'none';
    }
  }

  public updatePlayerVitals(vitals: Readonly<PlayerCombatVitals>, dt = 0.016): void {
    const hpRounded = Math.max(0, Math.round(vitals.health));
    const armorRounded = Math.max(0, Math.round(vitals.armor));
    const hpPct = Math.max(0, Math.min(100, (vitals.health / Math.max(1, vitals.maxHealth)) * 100));
    const armorPct = Math.max(0, Math.min(100, (vitals.armor / Math.max(1, vitals.maxArmor)) * 100));
    const isBleeding = vitals.arterialBleed
      ? vitals.arterialBleed.kind === 'BLEEDING'
      : (vitals.urgentBleedRemainingS ?? 0) > 0 && (vitals.urgentBleedHpPerSec ?? 0) > 0;

    if (this.healthValEl && hpRounded !== this.lastHpRounded) {
      this.lastHpRounded = hpRounded;
      this.healthValEl.textContent = `${hpRounded}`;
    }

    const wasBleeding = this.bleedPulseState.kind === 'PULSING';
    if (isBleeding) {
      const prevPhase = this.bleedPulseState.kind === 'PULSING' ? this.bleedPulseState.phaseRad : 0;
      this.bleedPulseState = {
        kind: 'PULSING',
        phaseRad: (prevPhase + dt * 7.5) % (Math.PI * 2),
      };
    } else {
      this.bleedPulseState = { kind: 'NONE' };
    }

    if (isBleeding !== wasBleeding) {
      this.healthValEl?.classList.toggle('urgent-bleed', isBleeding);
      this.healthFillEl?.classList.toggle('urgent-bleed', isBleeding);
    }

    const hpWidthStr = `${hpPct.toFixed(1)}%`;
    if (this.healthFillEl && hpWidthStr !== this.lastHpWidthStr) {
      this.lastHpWidthStr = hpWidthStr;
      this.healthFillEl.style.width = hpWidthStr;
    }
    if (this.armorValEl && armorRounded !== this.lastArmorRounded) {
      this.lastArmorRounded = armorRounded;
      this.armorValEl.textContent = `${armorRounded}`;
    }
    const armorWidthStr = `${armorPct.toFixed(1)}%`;
    if (this.armorFillEl && armorWidthStr !== this.lastArmorWidthStr) {
      this.lastArmorWidthStr = armorWidthStr;
      this.armorFillEl.style.width = armorWidthStr;
    }

    const wasFlashing = this.traumaFlashState.kind !== 'IDLE';
    if (this.traumaFlashState.kind !== 'IDLE') {
      const nextAlpha = Math.max(0, this.traumaFlashState.alpha - dt * 2.4);
      this.traumaFlashState =
        nextAlpha <= 0
          ? { kind: 'IDLE' }
          : { ...this.traumaFlashState, alpha: nextAlpha };
    }

    if (wasFlashing || this.traumaFlashState.kind !== 'IDLE' || wasBleeding || isBleeding) {
      this.refreshVignetteOverlay();
    }
  }

  public triggerPlayerDamageFlash(): void {
    this.traumaFlashState = { kind: 'WOUND_FLASH', alpha: 0.42 };
    this.refreshVignetteOverlay();
  }

  public triggerNearMissGrazeFlash(kind: PlayerNearMissGrazeKind): void {
    this.traumaFlashState = {
      kind: 'GRAZE_FLASH',
      grazeKind: kind,
      alpha: kind === 'HELMET_DEFLECT' ? 0.56 : 0.68,
    };
    this.refreshVignetteOverlay();
  }

  public updateBulletTimeHud(state: BulletTimeVignetteState): void {
    const pct = Math.max(0, Math.min(100, state.reflexEnergyPct));
    const isActive = state.active || state.killPunchActive;
    const reflexText = isActive ? `${state.timeScale.toFixed(2)}x` : `${Math.round(pct)}%`;
    if (this.reflexValEl) {
      if (reflexText !== this.lastReflexText) {
        this.lastReflexText = reflexText;
        this.reflexValEl.textContent = reflexText;
      }
      if (isActive !== this.lastReflexActive) {
        this.lastReflexActive = isActive;
        this.reflexValEl.classList.toggle('active', isActive);
      }
    }
    const reflexWidthStr = `${pct.toFixed(1)}%`;
    if (this.reflexFillEl && reflexWidthStr !== this.lastReflexWidthStr) {
      this.lastReflexWidthStr = reflexWidthStr;
      this.reflexFillEl.style.width = reflexWidthStr;
    }
    if (state.cssBoxShadow !== this.lastBulletTimeCss) {
      this.lastBulletTimeCss = state.cssBoxShadow;
      this.refreshVignetteOverlay();
    }
  }

  private refreshVignetteOverlay(): void {
    if (!this.vignetteEl) return;
    const flashAlpha =
      this.traumaFlashState.kind === 'IDLE' ? 0 : this.traumaFlashState.alpha;
    const bleedAlpha =
      this.bleedPulseState.kind === 'PULSING'
        ? 0.16 + 0.08 * Math.sin(this.bleedPulseState.phaseRad)
        : 0;
    const activeAlpha = Math.max(flashAlpha, bleedAlpha);

    let targetCss: string;
    if (activeAlpha > 0.01) {
      const isAmberHelmetDeflect =
        this.traumaFlashState.kind === 'GRAZE_FLASH' &&
        this.traumaFlashState.grazeKind === 'HELMET_DEFLECT' &&
        flashAlpha >= bleedAlpha;
      const rgb = isAmberHelmetDeflect ? '255, 184, 52' : '255, 32, 48';
      const dmgShadow = `inset 0 0 96px rgba(${rgb}, ${activeAlpha.toFixed(3)})`;
      targetCss = this.lastBulletTimeCss !== 'none' ? `${dmgShadow}, ${this.lastBulletTimeCss}` : dmgShadow;
    } else {
      targetCss = this.lastBulletTimeCss;
    }
    if (targetCss !== this.lastAppliedVignetteCss) {
      this.lastAppliedVignetteCss = targetCss;
      this.vignetteEl.style.boxShadow = targetCss;
    }
  }
}
