import type { PlayerCombatVitals, PlayerNearMissGrazeKind } from '../../contracts/ai/aiContracts.ts';
import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { WEAPONS } from '../../core/ballistics/weapons.ts';
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

const TRAUMA_IDLE: TraumaFlashState = { kind: 'IDLE' };
const BLEED_NONE: BleedPulseState = { kind: 'NONE' };

export class HudWeaponVitals {
  private healthValEl = queryEl('hud-health-val');
  private healthFillEl = queryEl('hud-health-fill');
  private armorValEl = queryEl('hud-armor-val');
  private armorFillEl = queryEl('hud-armor-fill');

  private magCountEl = queryEl('hud-mag-count');
  private reserveCountEl = queryEl('hud-reserve-count');
  private weaponNameEl = queryEl('hud-weapon-name');
  private ammoCaliberEl = queryEl('hud-ammo-caliber');
  private shotgunRingEl = queryEl('shotgun-spread-ring');
  private vignetteEl = queryEl('damage-vignette');
  private slotPips: HTMLElement[] = [];

  public traumaFlashState: TraumaFlashState = TRAUMA_IDLE;
  public bleedPulseState: BleedPulseState = BLEED_NONE;

  // The vignette layers have fixed box-shadows and are driven only by opacity.
  private woundLayerEl: HTMLElement | null = null;
  private deflectLayerEl: HTMLElement | null = null;
  private lastWoundOpacity = '';
  private lastDeflectOpacity = '';
  private lastHpTenths = -1;
  private lastArmorTenths = -1;
  private lastHpRounded = -1;
  private lastArmorRounded = -1;

  constructor() {
    if (this.vignetteEl && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const wound = document.createElement('div');
      wound.className = 'damage-vignette-layer vignette-wound';
      const deflect = document.createElement('div');
      deflect.className = 'damage-vignette-layer vignette-deflect';
      this.vignetteEl.appendChild(wound);
      this.vignetteEl.appendChild(deflect);
      this.woundLayerEl = wound;
      this.deflectLayerEl = deflect;
    }
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      this.slotPips = Array.from(document.querySelectorAll<HTMLElement>('.slot-pip'));
    }
  }

  public destroy(): void {
    for (const el of [this.woundLayerEl, this.deflectLayerEl]) {
      if (el && typeof el.remove === 'function') el.remove();
    }
    this.woundLayerEl = null;
    this.deflectLayerEl = null;
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
      this.bleedPulseState = BLEED_NONE;
    }

    if (isBleeding !== wasBleeding) {
      this.healthValEl?.classList.toggle('urgent-bleed', isBleeding);
      this.healthFillEl?.classList.toggle('urgent-bleed', isBleeding);
    }

    const hpT = Math.round(hpPct * 10);
    if (this.healthFillEl && hpT !== this.lastHpTenths) {
      this.lastHpTenths = hpT;
      this.healthFillEl.style.width = `${(hpT / 10).toFixed(1)}%`;
    }
    if (this.armorValEl && armorRounded !== this.lastArmorRounded) {
      this.lastArmorRounded = armorRounded;
      this.armorValEl.textContent = `${armorRounded}`;
    }
    const armorT = Math.round(armorPct * 10);
    if (this.armorFillEl && armorT !== this.lastArmorTenths) {
      this.lastArmorTenths = armorT;
      this.armorFillEl.style.width = `${(armorT / 10).toFixed(1)}%`;
    }

    const wasFlashing = this.traumaFlashState.kind !== 'IDLE';
    if (this.traumaFlashState.kind !== 'IDLE') {
      const nextAlpha = Math.max(0, this.traumaFlashState.alpha - dt * 2.4);
      this.traumaFlashState =
        nextAlpha <= 0
          ? TRAUMA_IDLE
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

  private refreshVignetteOverlay(): void {
    if (!this.woundLayerEl && !this.deflectLayerEl) return;
    const flashAlpha =
      this.traumaFlashState.kind === 'IDLE' ? 0 : this.traumaFlashState.alpha;
    const bleedAlpha =
      this.bleedPulseState.kind === 'PULSING'
        ? 0.16 + 0.08 * Math.sin(this.bleedPulseState.phaseRad)
        : 0;
    const activeAlpha = Math.max(flashAlpha, bleedAlpha);
    const isAmberHelmetDeflect =
      this.traumaFlashState.kind === 'GRAZE_FLASH' &&
      this.traumaFlashState.grazeKind === 'HELMET_DEFLECT' &&
      flashAlpha >= bleedAlpha;

    let wound = 0;
    let deflect = 0;
    if (activeAlpha > 0.01) {
      if (isAmberHelmetDeflect) deflect = activeAlpha;
      else wound = activeAlpha;
    }
    const woundStr = wound > 0 ? wound.toFixed(3) : '0';
    const deflectStr = deflect > 0 ? deflect.toFixed(3) : '0';
    if (this.woundLayerEl && woundStr !== this.lastWoundOpacity) {
      this.woundLayerEl.style.opacity = woundStr;
      this.lastWoundOpacity = woundStr;
    }
    if (this.deflectLayerEl && deflectStr !== this.lastDeflectOpacity) {
      this.deflectLayerEl.style.opacity = deflectStr;
      this.lastDeflectOpacity = deflectStr;
    }
  }
}
