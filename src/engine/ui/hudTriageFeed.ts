import type { AiBarkPayload } from '../../contracts/ai/aiContracts.ts';
import type { ShotSimulationReport, TargetHealthState } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import {
  formatTriageLabel,
  type ProjectedTargetTriageEntry,
  queryEl,
  triageCardClass,
  triageColorClass,
  type WorldTriagePlateDom,
} from './hudTypes.ts';
import { createWorldTriagePlateDom, updateWorldPlateEntry } from './hudWorldPlates.ts';

export class HudTriageFeed {
  private worldTriageLayerEl = queryEl('hud-world-triage-layer');
  private worldPlates = new Map<string, WorldTriagePlateDom>();
  private activeBarks = new Map<string, { text: string; expiresAtMs: number }>();

  private targetCardEl = queryEl('hud-target-triage-card');
  private targetNameEl = queryEl('hud-target-name');
  private targetTriageBadgeEl = queryEl('hud-target-triage-badge');
  private targetHpFillEl = queryEl('hud-target-hp-fill');
  private targetHpTextEl = queryEl('hud-target-hp-text');
  private targetArmorTrackEl = queryEl('hud-target-armor-track');
  private targetArmorFillEl = queryEl('hud-target-armor-fill');
  private targetPhysioVitalsEl = queryEl('hud-target-physio-vitals');
  private targetPhysioTraumaEl = queryEl('hud-target-physio-trauma');

  private killfeedEl = queryEl('hud-killfeed');
  private promptEl = queryEl('hud-prompt');
  private lastPromptText = '';
  private lastPromptOpacity = '';

  public updateTriageOverlays(
    entries: ProjectedTargetTriageEntry[],
    focusedTarget: TargetHealthState | null,
    focusedPhysiology?: PhysiologicalEntityState | null
  ): void {
    const nowMs = Date.now();
    if (this.worldTriageLayerEl && typeof document !== 'undefined') {
      const seenRefs = new Set<string>();
      for (const entry of entries) {
        const key = `${entry.state.targetId}`;
        seenRefs.add(key);

        let dom = this.worldPlates.get(key);
        if (!dom) {
          dom = createWorldTriagePlateDom(this.worldTriageLayerEl);
          this.worldPlates.set(key, dom);
        }
        const barkEntry = this.activeBarks.get(key);
        const barkText =
          barkEntry && nowMs < barkEntry.expiresAtMs ? barkEntry.text : undefined;
        if (barkEntry && nowMs >= barkEntry.expiresAtMs) {
          this.activeBarks.delete(key);
        }
        updateWorldPlateEntry(dom, entry, barkText);
      }

      for (const [key, dom] of this.worldPlates.entries()) {
        if (!seenRefs.has(key)) {
          dom.root.remove();
          this.worldPlates.delete(key);
        }
      }
    }

    if (this.targetCardEl) {
      if (!focusedTarget) {
        this.targetCardEl.classList.remove('active');
        return;
      }

      this.targetCardEl.classList.add('active');
      const status = computeCombatantTriageStatus(focusedTarget);
      const colorCls = triageColorClass(status);
      const cardCls = triageCardClass(status);

      this.targetCardEl.className = `target-triage-card active ${cardCls}`;
      if (this.targetNameEl) {
        this.targetNameEl.textContent = (focusedTarget.name || focusedTarget.targetId).toUpperCase();
      }
      if (this.targetTriageBadgeEl) {
        this.targetTriageBadgeEl.textContent = formatTriageLabel(status);
        this.targetTriageBadgeEl.className = `badge-triage ${colorCls}`;
      }

      const hpClamped = focusedTarget.alive ? Math.max(1, Math.round(focusedTarget.currentHp)) : 0;
      const hpPct = focusedTarget.alive
        ? Math.max(0, Math.min(100, (focusedTarget.currentHp / Math.max(1, focusedTarget.maxHp)) * 100))
        : 0;
      if (this.targetHpFillEl) {
        this.targetHpFillEl.style.width = `${hpPct.toFixed(1)}%`;
        this.targetHpFillEl.className = `meter-fill ${colorCls}`;
      }
      if (this.targetHpTextEl) this.targetHpTextEl.textContent = `${hpClamped} / ${Math.round(focusedTarget.maxHp)}`;

      if (this.targetArmorTrackEl && this.targetArmorFillEl) {
        const armor = (focusedTarget.hasChestArmor ? focusedTarget.chestArmorIntegrity : 0) || 0;
        if (armor > 0) {
          this.targetArmorTrackEl.classList.remove('hidden');
          this.targetArmorFillEl.style.width = `${(armor * 100).toFixed(1)}%`;
        } else {
          this.targetArmorTrackEl.classList.add('hidden');
        }
      }

      if (this.targetPhysioVitalsEl && this.targetPhysioTraumaEl) {
        if (focusedPhysiology) {
          const bpSys = Math.round(focusedPhysiology.systolicBpMmHg);
          const bpDia = Math.round(focusedPhysiology.diastolicBpMmHg);
          const volL = (focusedPhysiology.bloodVolumeMl / 1000).toFixed(2);
          this.targetPhysioVitalsEl.textContent = `HR: ${Math.round(focusedPhysiology.heartRateBpm)} BPM • BP: ${bpSys}/${bpDia} • BLOOD: ${volL}L`;
          const traumas: string[] = [];
          if (focusedPhysiology.shockStage !== 'NONE') traumas.push(`SHOCK: ${focusedPhysiology.shockStage}`);
          if (!focusedPhysiology.conscious) traumas.push('UNCONSCIOUS');
          if (!focusedPhysiology.alive) traumas.push(`DEAD (${focusedPhysiology.causeOfDeath})`);
          this.targetPhysioTraumaEl.textContent = traumas.length > 0 ? traumas.join(' • ') : 'NO CRITICAL TRAUMA';
        } else {
          this.targetPhysioVitalsEl.textContent = '';
          this.targetPhysioTraumaEl.textContent = '';
        }
      }
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
    const decapitated = wasAliveBefore && report.dismembermentEvents.some((d) => d.zone === 'NECK_CERVICAL');
    const cranialPop = wasAliveBefore && report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP');
    const eviscerated = wasAliveBefore && report.dismembermentEvents.some((d) => d.goreMode === 'EVISCERATED');
    const cleanSever = wasAliveBefore && report.dismembermentEvents.some((d) => d.goreMode === 'CLEAN_SEVER');
    const surgicalJoint = cleanSever && report.combatantEffects.some((e) => e.startsWith('JOINT SHATTERED'));

    const detail = decapitated
      ? 'HEAD SEVERED +REWARD'
      : cranialPop
        ? 'CRANIAL POP +REWARD'
        : surgicalJoint
          ? 'SURGICAL SEVER +REWARD'
          : cleanSever
            ? 'DISMEMBERED +REWARD'
            : eviscerated
              ? 'EVISCERATED +REWARD'
              : killedNow
                ? 'NEUTRALIZED'
                : 'HIT';
    const isHighlight = killedNow || decapitated || cranialPop || cleanSever || eviscerated;
    this.addFeedRow(cleanTarget, weaponCode, detail, isHighlight);
  }

  public pushSystemToast(tag: string, message: string): void {
    this.addFeedRow(message, tag, '', false);
  }

  public pushRadioBark(bark: AiBarkPayload): void {
    const durationMs = Math.max(800, Math.round(bark.durationS * 1000));
    this.activeBarks.set(bark.speakerId, {
      text: bark.text,
      expiresAtMs: Date.now() + durationMs,
    });
    const tag = bark.isRadio ? `RADIO • ${bark.callsign}` : `TRAUMA • ${bark.callsign}`;
    this.addFeedRow(bark.text, tag, '', false);
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

  public updateContextPrompt(isPointerLocked: boolean, allDead: boolean): void {
    if (!this.promptEl) return;
    let nextText = '';
    let nextOpacity = '0';
    if (!isPointerLocked) {
      nextText = 'CLICK TO ENGAGE • [TAB] ARMOR/VITALS • [G] GRENADE • [F] REFLEX • [1-4] ARSENAL';
      nextOpacity = '1';
    } else if (allDead) {
      nextText = 'ALL HOSTILES ELIMINATED • PRESS [R] TO RESPAWN SQUAD';
      nextOpacity = '1';
    }
    if (this.lastPromptText !== nextText) {
      this.promptEl.textContent = nextText;
      this.lastPromptText = nextText;
    }
    if (this.lastPromptOpacity !== nextOpacity) {
      this.promptEl.style.opacity = nextOpacity;
      this.lastPromptOpacity = nextOpacity;
    }
  }
}
