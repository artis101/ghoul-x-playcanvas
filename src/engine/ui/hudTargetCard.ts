import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import { formatTriageLabel, queryEl, triageCardClass, triageColorClass } from './hudTypes.ts';

export class HudTargetCard {
  private targetCardEl = queryEl('hud-target-triage-card');
  private targetNameEl = queryEl('hud-target-name');
  private targetTriageBadgeEl = queryEl('hud-target-triage-badge');
  private targetHpFillEl = queryEl('hud-target-hp-fill');
  private targetHpTextEl = queryEl('hud-target-hp-text');
  private targetArmorTrackEl = queryEl('hud-target-armor-track');
  private targetArmorFillEl = queryEl('hud-target-armor-fill');
  private targetPhysioVitalsEl = queryEl('hud-target-physio-vitals');
  private targetPhysioTraumaEl = queryEl('hud-target-physio-trauma');

  private cardActive: boolean | null = null;
  private lastStatus = '';
  private lastNameSource: string | null = null;
  private lastHpClamped = -1;
  private lastMaxHpRounded = -1;
  private lastHpTenths = -1;
  /** -1 means the armor track is hidden. */
  private lastArmorTenths = -2;

  private lastHasPhysio: boolean | null = null;
  private lastHr = NaN;
  private lastSys = NaN;
  private lastDia = NaN;
  private lastBloodCl = NaN;
  private lastShock = '';
  private lastConscious: boolean | null = null;
  private lastPhysioAlive: boolean | null = null;
  private lastCause = '';

  public update(
    focusedTarget: TargetHealthState | null,
    focusedPhysiology?: PhysiologicalEntityState | null
  ): void {
    if (!this.targetCardEl) return;
    if (!focusedTarget) {
      if (this.cardActive !== false) {
        this.targetCardEl.classList.remove('active');
        this.cardActive = false;
      }
      return;
    }

    const status = computeCombatantTriageStatus(focusedTarget);
    const statusChanged = status !== this.lastStatus;
    if (statusChanged || this.cardActive !== true) {
      this.targetCardEl.className = `hud-target-triage-card active ${triageCardClass(status)}`;
    }
    if (statusChanged) {
      const colorCls = triageColorClass(status);
      if (this.targetTriageBadgeEl) {
        this.targetTriageBadgeEl.textContent = formatTriageLabel(status);
        this.targetTriageBadgeEl.className = `ttc-badge ${colorCls}`;
      }
      if (this.targetHpFillEl) {
        this.targetHpFillEl.className = `ttc-hp-fill ${colorCls}`;
      }
    }
    this.lastStatus = status;
    this.cardActive = true;

    const nameSrc = focusedTarget.name || focusedTarget.targetId;
    if (nameSrc !== this.lastNameSource && this.targetNameEl) {
      this.targetNameEl.textContent = nameSrc.toUpperCase();
      this.lastNameSource = nameSrc;
    }

    this.updateHp(focusedTarget);
    this.updateArmor(focusedTarget);
    this.updatePhysiology(focusedPhysiology);
  }

  private updateHp(target: TargetHealthState): void {
    const hpClamped = target.alive ? Math.max(1, Math.round(target.currentHp)) : 0;
    const hpPct = target.alive
      ? Math.max(0, Math.min(100, (target.currentHp / Math.max(1, target.maxHp)) * 100))
      : 0;
    const hpTenths = Math.round(hpPct * 10);
    if (hpTenths !== this.lastHpTenths) {
      if (this.targetHpFillEl) this.targetHpFillEl.style.width = `${(hpTenths / 10).toFixed(1)}%`;
      this.lastHpTenths = hpTenths;
    }
    const maxRounded = Math.round(target.maxHp);
    if (hpClamped !== this.lastHpClamped || maxRounded !== this.lastMaxHpRounded) {
      if (this.targetHpTextEl) this.targetHpTextEl.textContent = `${hpClamped} / ${maxRounded}`;
      this.lastHpClamped = hpClamped;
      this.lastMaxHpRounded = maxRounded;
    }
  }

  private updateArmor(target: TargetHealthState): void {
    if (!this.targetArmorTrackEl || !this.targetArmorFillEl) return;
    const armor = (target.hasChestArmor ? target.chestArmorIntegrity : 0) || 0;
    const armorTenths = armor > 0 ? Math.round(armor * 1000) : -1;
    if (armorTenths === this.lastArmorTenths) return;
    if (armorTenths < 0) {
      this.targetArmorTrackEl.classList.add('hidden');
    } else {
      if (this.lastArmorTenths < 0) this.targetArmorTrackEl.classList.remove('hidden');
      this.targetArmorFillEl.style.width = `${(armorTenths / 10).toFixed(1)}%`;
    }
    this.lastArmorTenths = armorTenths;
  }

  private updatePhysiology(physio: PhysiologicalEntityState | null | undefined): void {
    if (!this.targetPhysioVitalsEl || !this.targetPhysioTraumaEl) return;
    if (!physio) {
      if (this.lastHasPhysio !== false) {
        this.targetPhysioVitalsEl.textContent = '';
        this.targetPhysioTraumaEl.textContent = '';
        this.lastHasPhysio = false;
      }
      return;
    }

    const firstWrite = this.lastHasPhysio !== true;
    const hr = Math.round(physio.heartRateBpm);
    const sys = Math.round(physio.systolicBpMmHg);
    const dia = Math.round(physio.diastolicBpMmHg);
    const bloodCl = Math.round(physio.bloodVolumeMl / 10);
    if (
      firstWrite ||
      hr !== this.lastHr ||
      sys !== this.lastSys ||
      dia !== this.lastDia ||
      bloodCl !== this.lastBloodCl
    ) {
      this.targetPhysioVitalsEl.textContent = `HR: ${hr} BPM • BP: ${sys}/${dia} • BLOOD: ${(physio.bloodVolumeMl / 1000).toFixed(2)}L`;
      this.lastHr = hr;
      this.lastSys = sys;
      this.lastDia = dia;
      this.lastBloodCl = bloodCl;
    }

    if (
      firstWrite ||
      physio.shockStage !== this.lastShock ||
      physio.conscious !== this.lastConscious ||
      physio.alive !== this.lastPhysioAlive ||
      physio.causeOfDeath !== this.lastCause
    ) {
      const traumas: string[] = [];
      if (physio.shockStage !== 'NONE') traumas.push(`SHOCK: ${physio.shockStage}`);
      if (!physio.conscious) traumas.push('UNCONSCIOUS');
      if (!physio.alive) traumas.push(`DEAD (${physio.causeOfDeath})`);
      this.targetPhysioTraumaEl.textContent = traumas.length > 0 ? traumas.join(' • ') : 'NO CRITICAL TRAUMA';
      this.lastShock = physio.shockStage;
      this.lastConscious = physio.conscious;
      this.lastPhysioAlive = physio.alive;
      this.lastCause = physio.causeOfDeath;
    }
    this.lastHasPhysio = true;
  }
}
