import {
  WeaponSpec,
  AmmoSpec,
  ShotSimulationReport,
  TargetHealthState,
} from '../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../contracts/physiology.ts';
import { WEAPONS } from '../core/ballistics/weapons.ts';
import {
  CombatantTriageStatus,
  computeCombatantTriageStatus,
} from '../core/ballistics/solver.ts';
import type { PlayerCombatVitals } from './ai/tacticalCombatAi.ts';
import type { BulletTimeVignetteState } from './fx/mayhemDirector.ts';

export interface ProjectedTargetTriageEntry {
  state: TargetHealthState;
  screenX: number;
  screenY: number;
  visible: boolean;
}

interface WorldTriagePlateDom {
  root: HTMLDivElement;
  triageLabel: HTMLSpanElement;
  hpNum: HTMLSpanElement;
  hpFill: HTMLDivElement;
  armorTrack: HTMLDivElement;
  armorFill: HTMLDivElement;
}

function formatTriageLabel(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'HEALTHY';
    case 'WOUNDED':
      return 'WOUNDED';
    case 'MORTALLY_WOUNDED':
      return 'MORTALLY WOUNDED';
    case 'DEAD':
      return 'DEAD';
  }
}

function triageColorClass(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'triage-healthy';
    case 'WOUNDED':
      return 'triage-wounded';
    case 'MORTALLY_WOUNDED':
      return 'triage-mortally-wounded';
    case 'DEAD':
      return 'triage-dead';
  }
}

function triageCardClass(status: CombatantTriageStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'card-healthy';
    case 'WOUNDED':
      return 'card-wounded';
    case 'MORTALLY_WOUNDED':
      return 'card-mortally-wounded';
    case 'DEAD':
      return 'card-dead';
  }
}

function queryEl(id: string): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return null;
  }
  return document.getElementById(id);
}

/**
 * Minimalist In-Game Tactical FPS HUD Controller (Soldier of Fortune / F.E.A.R. / CS style).
 * Zero debug panels or blocking chrome — pure crosshair, hitmarker, enemy health/triage + BP/SpO2 overlay,
 * player vitals + Reflex slow-mo energy bar, Bullet-Time edge vignette, and fading killfeed.
 */
export class HudController {
  private crosshairEl: HTMLElement | null = null;
  private shotgunRingEl: HTMLElement | null = null;
  private hitmarkerEl: HTMLElement | null = null;
  private sniperScopeMaskEl: HTMLElement | null = null;
  private scopeZoomLabelEl: HTMLElement | null = null;
  private scopeRangeLabelEl: HTMLElement | null = null;
  private scopeDropLabelEl: HTMLElement | null = null;

  private vignetteEl: HTMLElement | null = null;

  private worldTriageLayerEl: HTMLElement | null = null;
  private worldPlates = new Map<string, WorldTriagePlateDom>();

  private targetCardEl: HTMLElement | null = null;
  private targetNameEl: HTMLElement | null = null;
  private targetTriageBadgeEl: HTMLElement | null = null;
  private targetHpFillEl: HTMLElement | null = null;
  private targetHpTextEl: HTMLElement | null = null;
  private targetArmorTrackEl: HTMLElement | null = null;
  private targetArmorFillEl: HTMLElement | null = null;
  private targetPhysioVitalsEl: HTMLElement | null = null;
  private targetPhysioTraumaEl: HTMLElement | null = null;

  private healthValEl: HTMLElement | null = null;
  private healthFillEl: HTMLElement | null = null;
  private armorValEl: HTMLElement | null = null;
  private armorFillEl: HTMLElement | null = null;
  private reflexValEl: HTMLElement | null = null;
  private reflexFillEl: HTMLElement | null = null;

  private magCountEl: HTMLElement | null = null;
  private reserveCountEl: HTMLElement | null = null;
  private weaponNameEl: HTMLElement | null = null;
  private ammoCaliberEl: HTMLElement | null = null;
  private killfeedEl: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private slotPips: HTMLElement[] = [];

  private hitmarkerTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  private damageFlashAlpha = 0;
  private lastBulletTimeCss = 'none';

  constructor() {
    this.crosshairEl = queryEl('crosshair-standard');
    this.shotgunRingEl = queryEl('shotgun-spread-ring');
    this.hitmarkerEl = queryEl('hitmarker');
    this.sniperScopeMaskEl = queryEl('sniper-scope-mask');
    this.scopeZoomLabelEl = queryEl('scope-zoom-label');
    this.scopeRangeLabelEl = queryEl('scope-range-label');
    this.scopeDropLabelEl = queryEl('scope-drop-label');

    this.vignetteEl = queryEl('bullet-time-vignette');

    this.worldTriageLayerEl = queryEl('hud-world-triage-layer');
    this.targetCardEl = queryEl('hud-target-triage-card');
    this.targetNameEl = queryEl('hud-target-name');
    this.targetTriageBadgeEl = queryEl('hud-target-triage-badge');
    this.targetHpFillEl = queryEl('hud-target-hp-fill');
    this.targetHpTextEl = queryEl('hud-target-hp-text');
    this.targetArmorTrackEl = queryEl('hud-target-armor-track');
    this.targetArmorFillEl = queryEl('hud-target-armor-fill');
    this.targetPhysioVitalsEl = queryEl('hud-target-physio-vitals');
    this.targetPhysioTraumaEl = queryEl('hud-target-physio-trauma');

    this.healthValEl = queryEl('hud-health-val');
    this.healthFillEl = queryEl('hud-health-fill');
    this.armorValEl = queryEl('hud-armor-val');
    this.armorFillEl = queryEl('hud-armor-fill');
    this.reflexValEl = queryEl('hud-reflex-val');
    this.reflexFillEl = queryEl('hud-reflex-fill');

    this.magCountEl = queryEl('hud-mag-count');
    this.reserveCountEl = queryEl('hud-reserve-count');
    this.weaponNameEl = queryEl('hud-weapon-name');
    this.ammoCaliberEl = queryEl('hud-ammo-caliber');
    this.killfeedEl = queryEl('hud-killfeed');
    this.promptEl = queryEl('hud-prompt');
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

  public updatePlayerVitals(vitals: Readonly<PlayerCombatVitals>, dt = 0.016): void {
    const hpRounded = Math.max(0, Math.round(vitals.health));
    const armorRounded = Math.max(0, Math.round(vitals.armor));
    const hpPct = Math.max(0, Math.min(100, (vitals.health / Math.max(1, vitals.maxHealth)) * 100));
    const armorPct = Math.max(0, Math.min(100, (vitals.armor / Math.max(1, vitals.maxArmor)) * 100));

    if (this.healthValEl) {
      this.healthValEl.textContent = `${hpRounded}`;
    }
    if (this.healthFillEl) {
      this.healthFillEl.style.width = `${hpPct.toFixed(1)}%`;
    }
    if (this.armorValEl) {
      this.armorValEl.textContent = `${armorRounded}`;
    }
    if (this.armorFillEl) {
      this.armorFillEl.style.width = `${armorPct.toFixed(1)}%`;
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
    if (this.reflexValEl) {
      this.reflexValEl.textContent =
        state.active || state.killPunchActive
          ? `${state.timeScale.toFixed(2)}x`
          : `${Math.round(pct)}%`;
      this.reflexValEl.classList.toggle('active', state.active || state.killPunchActive);
    }
    if (this.reflexFillEl) {
      this.reflexFillEl.style.width = `${pct.toFixed(1)}%`;
    }

    this.lastBulletTimeCss = state.cssBoxShadow;
    this.refreshVignetteOverlay();
  }

  private refreshVignetteOverlay(): void {
    if (!this.vignetteEl) return;
    if (this.damageFlashAlpha > 0.01) {
      const dmgShadow = `inset 0 0 88px rgba(255, 42, 58, ${this.damageFlashAlpha.toFixed(3)})`;
      this.vignetteEl.style.boxShadow =
        this.lastBulletTimeCss !== 'none'
          ? `${dmgShadow}, ${this.lastBulletTimeCss}`
          : dmgShadow;
    } else {
      this.vignetteEl.style.boxShadow = this.lastBulletTimeCss;
    }
  }

  public setCrosshairBloom(scaleFactor: number, hidden = false): void {
    if (!this.crosshairEl) return;
    this.crosshairEl.style.opacity = hidden ? '0' : '1';
    this.crosshairEl.style.transform = `scale(${scaleFactor.toFixed(3)})`;
  }

  public triggerHitmarker(mode: 'NORMAL' | 'ARMOR' | 'LETHAL' | boolean): void {
    if (!this.hitmarkerEl) return;
    const resolved = typeof mode === 'boolean' ? (mode ? 'LETHAL' : 'NORMAL') : mode;
    this.hitmarkerEl.classList.toggle('lethal', resolved === 'LETHAL');
    this.hitmarkerEl.classList.toggle('armor', resolved === 'ARMOR');
    this.hitmarkerEl.classList.add('active');

    if (this.hitmarkerTimeout !== null) {
      globalThis.clearTimeout(this.hitmarkerTimeout);
    }
    this.hitmarkerTimeout = globalThis.setTimeout(() => {
      this.hitmarkerEl?.classList.remove('active');
    }, resolved === 'LETHAL' ? 170 : 105);
  }

  public updateTriageOverlays(
    entries: ProjectedTargetTriageEntry[],
    focusedTarget: TargetHealthState | null,
    focusedPhysiology?: PhysiologicalEntityState | null
  ): void {
    // 1. Update floating 3D-projected health bars & triage plates above each combatant
    if (this.worldTriageLayerEl && typeof document !== 'undefined') {
      const seenRefs = new Set<string>();

      for (const entry of entries) {
        const key = `${entry.state.targetId}`;
        seenRefs.add(key);

        let dom = this.worldPlates.get(key);
        if (!dom) {
          const root = document.createElement('div');
          root.className = 'world-triage-plate';

          const top = document.createElement('div');
          top.className = 'wtp-top';

          const triageLabel = document.createElement('span');
          triageLabel.className = 'wtp-triage triage-healthy';

          const hpNum = document.createElement('span');
          hpNum.className = 'wtp-hp-num';

          top.appendChild(triageLabel);
          top.appendChild(hpNum);

          const hpTrack = document.createElement('div');
          hpTrack.className = 'wtp-hp-track';
          const hpFill = document.createElement('div');
          hpFill.className = 'wtp-hp-fill triage-healthy';
          hpTrack.appendChild(hpFill);

          const armorTrack = document.createElement('div');
          armorTrack.className = 'wtp-armor-track hidden';
          const armorFill = document.createElement('div');
          armorFill.className = 'wtp-armor-fill';
          armorTrack.appendChild(armorFill);

          root.appendChild(top);
          root.appendChild(hpTrack);
          root.appendChild(armorTrack);

          this.worldTriageLayerEl.appendChild(root);
          dom = { root, triageLabel, hpNum, hpFill, armorTrack, armorFill };
          this.worldPlates.set(key, dom);
        }

        if (!entry.visible) {
          dom.root.style.display = 'none';
          continue;
        }

        dom.root.style.display = 'block';
        dom.root.style.transform = `translate3d(${entry.screenX.toFixed(1)}px, ${entry.screenY.toFixed(1)}px, 0) translate(-50%, -100%)`;

        const status = computeCombatantTriageStatus(entry.state);
        const statusTag = entry.state.alive ? entry.state.combatantStatusTag : null;
        const baseLabel = formatTriageLabel(status);
        const label =
          statusTag === 'SIDEARM_DRAWN'
            ? `${baseLabel} • SIDEARM DRAWN`
            : statusTag === 'SIDEARM_DRAWING'
              ? `${baseLabel} • DRAWING M9`
              : statusTag === 'DISARMED'
                ? 'DISARMED'
                : statusTag === 'LAST_STAND'
                  ? `${baseLabel} • LAST STAND`
                  : baseLabel;
        const colorCls = triageColorClass(status);
        const hpClamped = entry.state.alive ? Math.max(1, Math.round(entry.state.currentHp)) : 0;
        const hpPct = entry.state.alive
          ? Math.max(0, Math.min(100, (entry.state.currentHp / Math.max(1, entry.state.maxHp)) * 100))
          : 0;

        dom.root.classList.toggle('is-dead', status === 'DEAD');
        dom.triageLabel.textContent = label;
        dom.triageLabel.className = `wtp-triage ${colorCls}`;
        dom.hpNum.textContent = `${hpClamped}`;
        dom.hpFill.className = `wtp-hp-fill ${colorCls}`;
        dom.hpFill.style.width = `${hpPct.toFixed(1)}%`;

        if (entry.state.hasChestArmor && entry.state.chestArmorIntegrity > 0.01 && entry.state.alive) {
          dom.armorTrack.classList.remove('hidden');
          dom.armorFill.style.width = `${(entry.state.chestArmorIntegrity * 100).toFixed(1)}%`;
        } else {
          dom.armorTrack.classList.add('hidden');
        }
      }

      for (const [key, dom] of this.worldPlates.entries()) {
        if (!seenRefs.has(key)) {
          dom.root.remove();
          this.worldPlates.delete(key);
        }
      }
    }

    // 2. Update top-center focused target Health Bar, Triage & Hemodynamic Telemetry Card
    if (!this.targetCardEl) return;
    if (!focusedTarget) {
      this.targetCardEl.classList.add('hidden');
      return;
    }

    const status = computeCombatantTriageStatus(focusedTarget);
    const focusedTag = focusedTarget.alive ? focusedTarget.combatantStatusTag : null;
    const baseLabel = formatTriageLabel(status);
    const label =
      focusedTag === 'SIDEARM_DRAWN'
        ? `${baseLabel} • SIDEARM DRAWN`
        : focusedTag === 'SIDEARM_DRAWING'
          ? `${baseLabel} • DRAWING M9`
          : focusedTag === 'DISARMED'
            ? 'DISARMED'
            : focusedTag === 'LAST_STAND'
              ? `${baseLabel} • LAST STAND`
              : baseLabel;
    const colorCls = triageColorClass(status);
    const cardCls = triageCardClass(status);
    const hpRounded = focusedTarget.alive ? Math.max(1, Math.round(focusedTarget.currentHp)) : 0;
    const maxHpRounded = Math.round(focusedTarget.maxHp);
    const hpPct = focusedTarget.alive
      ? Math.max(0, Math.min(100, (focusedTarget.currentHp / Math.max(1, focusedTarget.maxHp)) * 100))
      : 0;

    this.targetCardEl.className = `hud-target-triage-card ${cardCls}`;

    if (this.targetNameEl) {
      this.targetNameEl.textContent = focusedTarget.name.split(' (')[0];
    }
    if (this.targetTriageBadgeEl) {
      this.targetTriageBadgeEl.textContent = label;
      this.targetTriageBadgeEl.className = `ttc-badge ${colorCls}`;
    }
    if (this.targetHpFillEl) {
      this.targetHpFillEl.className = `ttc-hp-fill ${colorCls}`;
      this.targetHpFillEl.style.width = `${hpPct.toFixed(1)}%`;
    }
    if (this.targetHpTextEl) {
      this.targetHpTextEl.textContent = `${hpRounded} / ${maxHpRounded}`;
    }
    if (this.targetArmorTrackEl && this.targetArmorFillEl) {
      if (focusedTarget.hasChestArmor && focusedTarget.chestArmorIntegrity > 0.01 && focusedTarget.alive) {
        this.targetArmorTrackEl.classList.remove('hidden');
        this.targetArmorFillEl.style.width = `${(focusedTarget.chestArmorIntegrity * 100).toFixed(1)}%`;
      } else {
        this.targetArmorTrackEl.classList.add('hidden');
      }
    }

    if (this.targetPhysioVitalsEl) {
      const sysBp = focusedPhysiology
        ? Math.round(focusedPhysiology.systolicBpMmHg)
        : Math.round(focusedTarget.systolicBpMmHg);
      const diaBp = focusedPhysiology
        ? Math.round(focusedPhysiology.diastolicBpMmHg)
        : Math.round(focusedTarget.systolicBpMmHg * 0.67);
      const spo2 = focusedPhysiology
        ? Math.round(focusedPhysiology.oxygenSaturationPct)
        : Math.round(focusedTarget.oxygenSaturationPct);
      const hr = focusedPhysiology
        ? Math.round(focusedPhysiology.heartRateBpm)
        : Math.round(focusedTarget.heartRateBpm);
      const bloodMl = focusedPhysiology
        ? Math.round(focusedPhysiology.bloodVolumeMl)
        : Math.round(focusedTarget.bloodVolumeMl);
      this.targetPhysioVitalsEl.textContent = focusedTarget.alive
        ? `BP ${sysBp}/${diaBp} • SpO2 ${spo2}% • ${hr} BPM • ${bloodMl}mL`
        : `BP 0/0 • SpO2 ${spo2}% • ASYSTOLE (${bloodMl}mL)`;
    }

    if (this.targetPhysioTraumaEl) {
      let traumaTag = '';
      let isCritical = false;
      if (!focusedTarget.alive) {
        traumaTag =
          focusedPhysiology && focusedPhysiology.causeOfDeath !== 'NONE'
            ? focusedPhysiology.causeOfDeath.replace(/_/g, ' ')
            : 'KIA';
        isCritical = true;
      } else if (focusedPhysiology) {
        if (focusedPhysiology.pneumothoraxState === 'TENSION_PNEUMOTHORAX') {
          traumaTag = 'TENSION PNEUMOTHORAX';
          isCritical = true;
        } else if (focusedPhysiology.shockStage === 'CLASS_III' || focusedPhysiology.shockStage === 'CLASS_IV') {
          traumaTag = `SHOCK ${focusedPhysiology.shockStage.replace('_', ' ')}`;
          isCritical = true;
        } else if (focusedPhysiology.effectiveBleedRateMlPerSec >= 35) {
          traumaTag = `ARTERIAL BLEED -${Math.round(focusedPhysiology.effectiveBleedRateMlPerSec)}mL/s`;
          isCritical = true;
        } else if (focusedPhysiology.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
          traumaTag = 'SUCKING CHEST WOUND';
        } else if (focusedPhysiology.effectiveBleedRateMlPerSec >= 4) {
          traumaTag = `VENOUS OOZE -${Math.round(focusedPhysiology.effectiveBleedRateMlPerSec)}mL/s`;
        } else if (focusedPhysiology.fracturedBones.size > 0) {
          traumaTag = 'CORTICAL FRACTURE';
        }
      }
      this.targetPhysioTraumaEl.textContent = traumaTag;
      this.targetPhysioTraumaEl.classList.toggle('critical', isCritical);
    }
  }

  public pushCombatFeed(
    report: ShotSimulationReport,
    weaponCode: string,
    targetName: string,
    wasAliveBefore: boolean,
    isAliveAfter: boolean
  ): void {
    if (!this.killfeedEl || !report.hitTarget || typeof document === 'undefined') return;

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
    if (!this.killfeedEl || typeof document === 'undefined') return;

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

    globalThis.setTimeout(() => {
      item.style.opacity = '0';
      globalThis.setTimeout(() => item.remove(), 360);
    }, 3100);
  }

  public updateContextPrompt(isPointerLocked: boolean, allHostilesDown: boolean): void {
    if (!this.promptEl) return;

    if (!isPointerLocked) {
      this.promptEl.textContent =
        'CLICK TO ENGAGE  •  WASD MOVE  •  RMB ADS  •  1-4 WEAPON  •  B AMMO  •  G FRAG  •  Z REFLEX  •  X X-RAY  •  R RELOAD  •  T WAVE';
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
