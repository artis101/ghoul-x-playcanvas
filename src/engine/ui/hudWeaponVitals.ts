import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { WEAPONS } from '../../core/ballistics/weapons.ts';
import type { PlayerCombatVitals } from '../ai/tacticalCombatAi.ts';
import type { BulletTimeVignetteState } from '../fx/mayhemDirector.ts';
import { queryEl } from './hudTypes.ts';

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

  private damageFlashAlpha = 0;
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

    if (this.healthValEl && hpRounded !== this.lastHpRounded) {
      this.lastHpRounded = hpRounded;
      this.healthValEl.textContent = `${hpRounded}`;
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

    if (this.damageFlashAlpha > 0) {
      this.damageFlashAlpha = Math.max(0, this.damageFlashAlpha - dt * 2.8);
      this.refreshVignetteOverlay();
    }
  }

  public triggerPlayerDamageFlash(): void {
    this.damageFlashAlpha = 0.42;
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
    let targetCss: string;
    if (this.damageFlashAlpha > 0.01) {
      const dmgShadow = `inset 0 0 88px rgba(255, 42, 58, ${this.damageFlashAlpha.toFixed(3)})`;
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
