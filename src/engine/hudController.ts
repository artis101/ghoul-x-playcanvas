import {
  WeaponSpec,
  AmmoSpec,
  ShotSimulationReport,
} from '../contracts/ballistics.ts';
import { WEAPONS } from '../core/ballistics/weapons.ts';

/**
 * Minimalist In-Game Tactical FPS HUD Controller (Soldier of Fortune / CS / MGS style).
 * Zero debug panels or blocking chrome — pure crosshair, hitmarker, ammo/vitals corners, and fading killfeed.
 */
export class HudController {
  private crosshairEl: HTMLElement | null = null;
  private shotgunRingEl: HTMLElement | null = null;
  private hitmarkerEl: HTMLElement | null = null;
  private sniperScopeMaskEl: HTMLElement | null = null;
  private scopeZoomLabelEl: HTMLElement | null = null;
  private scopeRangeLabelEl: HTMLElement | null = null;
  private scopeDropLabelEl: HTMLElement | null = null;

  private magCountEl: HTMLElement | null = null;
  private reserveCountEl: HTMLElement | null = null;
  private weaponNameEl: HTMLElement | null = null;
  private ammoCaliberEl: HTMLElement | null = null;
  private killfeedEl: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private slotPips: NodeListOf<HTMLElement>;

  private hitmarkerTimeout: number | null = null;

  constructor() {
    this.crosshairEl = document.getElementById('crosshair-standard');
    this.shotgunRingEl = document.getElementById('shotgun-spread-ring');
    this.hitmarkerEl = document.getElementById('hitmarker');
    this.sniperScopeMaskEl = document.getElementById('sniper-scope-mask');
    this.scopeZoomLabelEl = document.getElementById('scope-zoom-label');
    this.scopeRangeLabelEl = document.getElementById('scope-range-label');
    this.scopeDropLabelEl = document.getElementById('scope-drop-label');

    this.magCountEl = document.getElementById('hud-mag-count');
    this.reserveCountEl = document.getElementById('hud-reserve-count');
    this.weaponNameEl = document.getElementById('hud-weapon-name');
    this.ammoCaliberEl = document.getElementById('hud-ammo-caliber');
    this.killfeedEl = document.getElementById('hud-killfeed');
    this.promptEl = document.getElementById('hud-prompt');
    this.slotPips = document.querySelectorAll<HTMLElement>('.slot-pip');
  }

  public updateWeaponHud(
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    magCount: number,
    reserveCount: number,
    isReloading: boolean
  ): void {
    const slotIdx = WEAPONS.findIndex((w) => w.id === weapon.id);
    this.slotPips.forEach((pip, idx) => {
      pip.classList.toggle('active', idx === slotIdx);
    });

    if (this.weaponNameEl) {
      this.weaponNameEl.textContent = weapon.codeName;
    }

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

    if (this.reserveCountEl) {
      this.reserveCountEl.textContent = reserveCount.toString().padStart(2, '0');
    }

    if (this.shotgunRingEl) {
      this.shotgunRingEl.style.display =
        weapon.role === 'SHOTGUN' && ammo.pelletCount > 1 ? 'block' : 'none';
    }
  }

  public setCrosshairBloom(scaleFactor: number, hidden = false): void {
    if (!this.crosshairEl) return;
    this.crosshairEl.style.opacity = hidden ? '0' : '1';
    this.crosshairEl.style.transform = `scale(${scaleFactor.toFixed(3)})`;
  }

  public triggerHitmarker(isLethal: boolean): void {
    if (!this.hitmarkerEl) return;
    this.hitmarkerEl.classList.toggle('lethal', isLethal);
    this.hitmarkerEl.classList.add('active');

    if (this.hitmarkerTimeout !== null) {
      window.clearTimeout(this.hitmarkerTimeout);
    }
    this.hitmarkerTimeout = window.setTimeout(() => {
      this.hitmarkerEl?.classList.remove('active');
    }, isLethal ? 170 : 105);
  }

  public pushCombatFeed(
    report: ShotSimulationReport,
    weaponCode: string,
    targetName: string,
    wasAliveBefore: boolean,
    isAliveAfter: boolean
  ): void {
    if (!this.killfeedEl || !report.hitTarget) return;

    const cleanTarget = targetName.split(' (')[0];
    const killedNow = wasAliveBefore && !isAliveAfter;

    // Pick the single punchiest combatant effect or trauma tag
    let detail = '';
    const pop = report.dismembermentEvents.find((d) => d.goreMode === 'CRANIAL_POP');
    const evisc = report.dismembermentEvents.find((d) => d.goreMode === 'EVISCERATED');
    const sever = report.dismembermentEvents.find((d) => d.goreMode === 'CLEAN_SEVER');
    const armorStop =
      report.woundEvents.length > 0 && report.woundEvents.every((w) => w.armorStopped);

    if (pop) {
      detail = 'CRANIAL POP';
    } else if (evisc) {
      detail = 'GUT EVISCERATED';
    } else if (sever) {
      detail = `${sever.zone.replace('_LEFT', '').replace('_RIGHT', '').replace('_', ' ')} SEVERED`;
    } else if (armorStop) {
      detail = 'KEVLAR STOPPED ROUND';
    } else if (killedNow) {
      detail = report.rupturedOrgans.length > 0 ? 'LETHAL ORGAN RUPTURE' : 'NEUTRALIZED';
    } else if (report.weaponDisarmed) {
      detail = 'DISARMED';
    } else if (report.combatantEffects.length > 0) {
      detail = report.combatantEffects[0].split(' — ')[0].toUpperCase();
    } else {
      return;
    }

    this.addFeedRow(cleanTarget, weaponCode, detail, killedNow || Boolean(pop || evisc || sever));
  }

  public pushSystemToast(tag: string, message: string): void {
    this.addFeedRow(message, tag, '', false);
  }

  private addFeedRow(subject: string, tag: string, outcome: string, isLethal: boolean): void {
    if (!this.killfeedEl) return;

    const item = document.createElement('div');
    item.className = `killfeed-item${isLethal ? ' lethal' : ''}`;
    if (outcome) {
      item.innerHTML = `${subject} <span class="kf-tag">[${tag}]</span> ${outcome}`;
    } else {
      item.innerHTML = `<span class="kf-tag">[${tag}]</span> ${subject}`;
    }

    this.killfeedEl.appendChild(item);
    while (this.killfeedEl.children.length > 4 && this.killfeedEl.firstElementChild) {
      this.killfeedEl.firstElementChild.remove();
    }

    window.setTimeout(() => {
      item.style.opacity = '0';
      window.setTimeout(() => item.remove(), 360);
    }, 3100);
  }

  public updateContextPrompt(isPointerLocked: boolean, allHostilesDown: boolean): void {
    if (!this.promptEl) return;

    if (!isPointerLocked) {
      this.promptEl.textContent =
        'CLICK TO ENGAGE  •  WASD MOVE  •  RMB ADS  •  1-4 WEAPON  •  B AMMO  •  R RELOAD  •  T NEW WAVE';
      this.promptEl.style.opacity = '1';
    } else if (allHostilesDown) {
      this.promptEl.textContent = 'AREA CLEAR  —  PRESS [T] FOR NEXT HOSTILE SQUAD';
      this.promptEl.style.opacity = '1';
    } else {
      this.promptEl.style.opacity = '0';
    }
  }

  public setScopeOverlay(active: boolean, zoom = 4.0, range = 42.0, dropCm = 0.0): void {
    if (!this.sniperScopeMaskEl) return;

    if (active) {
      this.sniperScopeMaskEl.classList.remove('hidden');
      if (this.scopeZoomLabelEl) this.scopeZoomLabelEl.textContent = `${zoom.toFixed(1)}x`;
      if (this.scopeRangeLabelEl) this.scopeRangeLabelEl.textContent = `${range.toFixed(0)}m`;
      if (this.scopeDropLabelEl) this.scopeDropLabelEl.textContent = `DROP ${Math.abs(dropCm).toFixed(1)}cm`;
    } else {
      this.sniperScopeMaskEl.classList.add('hidden');
    }
  }
}
