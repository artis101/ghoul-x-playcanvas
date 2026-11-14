import type { AiBarkPayload } from '../../contracts/ai/aiContracts.ts';
import type { ShotSimulationReport, TargetHealthState } from '../../contracts/ballistics.ts';
import type { PhysiologicalEntityState } from '../../contracts/physiology.ts';
import { HudTargetCard } from './hudTargetCard.ts';
import {
  type ProjectedTargetTriageEntry,
  queryEl,
  type WorldTriagePlateDom,
} from './hudTypes.ts';
import { createWorldTriagePlateDom, updateWorldPlateEntry } from './hudWorldPlates.ts';

interface FeedRowTimers {
  fade: ReturnType<typeof setTimeout>;
  remove: ReturnType<typeof setTimeout> | null;
}

export class HudTriageFeed {
  private worldTriageLayerEl = queryEl('hud-world-triage-layer');
  private worldPlates = new Map<string, WorldTriagePlateDom>();
  private readonly seenPlateIds = new Set<string>();
  private activeBarks = new Map<string, { text: string; expiresAtMs: number }>();

  private readonly targetCard = new HudTargetCard();

  private killfeedEl = queryEl('hud-killfeed');
  private readonly feedRowTimers = new Map<HTMLElement, FeedRowTimers>();
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
      const seenRefs = this.seenPlateIds;
      seenRefs.clear();
      for (const entry of entries) {
        const key = entry.state.targetId;
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

    this.targetCard.update(focusedTarget, focusedPhysiology ?? null);
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
    const tagEl = document.createElement('span');
    tagEl.className = 'kf-tag';
    tagEl.textContent = `[${tag}]`;
    if (outcome) {
      item.append(`${subject} `, tagEl, ` ${outcome}`);
    } else {
      item.append(tagEl, ` ${subject}`);
    }
    this.killfeedEl.appendChild(item);
    while (this.killfeedEl.children.length > 4 && this.killfeedEl.firstElementChild) {
      const evicted = this.killfeedEl.firstElementChild as HTMLElement;
      this.clearFeedRowTimers(evicted);
      evicted.remove();
    }
    const timers: FeedRowTimers = {
      fade: globalThis.setTimeout(() => {
        item.style.opacity = '0';
        timers.remove = globalThis.setTimeout(() => {
          this.feedRowTimers.delete(item);
          item.remove();
        }, 360);
      }, 3100),
      remove: null,
    };
    this.feedRowTimers.set(item, timers);
  }

  public destroy(): void {
    for (const row of Array.from(this.feedRowTimers.keys())) {
      this.clearFeedRowTimers(row);
      if (typeof row.remove === 'function') row.remove();
    }
    for (const dom of this.worldPlates.values()) {
      if (typeof dom.root.remove === 'function') dom.root.remove();
    }
    this.worldPlates.clear();
    this.activeBarks.clear();
    this.seenPlateIds.clear();
  }

  private clearFeedRowTimers(row: HTMLElement): void {
    const timers = this.feedRowTimers.get(row);
    if (!timers) return;
    globalThis.clearTimeout(timers.fade);
    if (timers.remove !== null) globalThis.clearTimeout(timers.remove);
    this.feedRowTimers.delete(row);
  }

  public updateContextPrompt(isPointerLocked: boolean, allDead: boolean): void {
    if (!this.promptEl) return;
    let nextText = '';
    let nextOpacity = '0';
    if (!isPointerLocked) {
      nextText = 'CLICK TO ENGAGE • [TAB] ARMOR/VITALS • [G] GRENADE • [1-4] ARSENAL';
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
