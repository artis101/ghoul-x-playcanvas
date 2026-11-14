import type { AudioNodeLike, GainNodeLike } from '../../core/audio/contracts.ts';
import type { SpatialChain } from '../../core/audio/spatialChain.ts';

export type VoiceCategory =
  | 'EXPLOSION'
  | 'NEAR_MISS'
  | 'ENEMY_FIRE_NEAR'
  | 'IMPACT'
  | 'RICOCHET'
  | 'GORE'
  | 'VOCAL'
  | 'CASING'
  | 'ENEMY_FIRE_FAR'
  | 'BARK';

export interface VoiceCategoryRule {
  readonly priority: number;
  readonly maxVoices: number;
  readonly audibleDistanceM: number;
}

export const MAX_ACTIVE_VOICES = 40;
export const ENEMY_FIRE_NEAR_DISTANCE_M = 30;
export const CHAIN_RELEASE_TAIL_S = 0.12;
export const VOICE_STEAL_FADE_S = 0.012;
const MAX_CHAINS_PER_VOICE = 4;
const PROVISIONAL_VOICE_LIFETIME_S = 4.8;
const UNSCOPED_CHAIN_LIFETIME_S = 4.8;

// The player's own weapon is not budgeted, so it is never dropped or stolen.
// Each audible distance sits about 1.25x beyond the maxDistanceM that category's spatial chain uses.
export const VOICE_CATEGORY_RULES: Readonly<Record<VoiceCategory, VoiceCategoryRule>> = {
  EXPLOSION: { priority: 90, maxVoices: 6, audibleDistanceM: 160 },
  NEAR_MISS: { priority: 85, maxVoices: 3, audibleDistanceM: Number.POSITIVE_INFINITY },
  ENEMY_FIRE_NEAR: { priority: 70, maxVoices: 12, audibleDistanceM: 130 },
  IMPACT: { priority: 60, maxVoices: 10, audibleDistanceM: 95 },
  RICOCHET: { priority: 60, maxVoices: 4, audibleDistanceM: 80 },
  GORE: { priority: 60, maxVoices: 6, audibleDistanceM: 80 },
  VOCAL: { priority: 50, maxVoices: 4, audibleDistanceM: 56 },
  CASING: { priority: 40, maxVoices: 6, audibleDistanceM: 28 },
  ENEMY_FIRE_FAR: { priority: 30, maxVoices: 8, audibleDistanceM: 130 },
  BARK: { priority: 20, maxVoices: 3, audibleDistanceM: 56 },
};

export class VoiceAllocator {
  droppedCount = 0;
  stolenCount = 0;
  culledCount = 0;

  private readonly slotCategory: (VoiceCategory | null)[] = new Array<VoiceCategory | null>(
    MAX_ACTIVE_VOICES,
  ).fill(null);
  private readonly slotPriority = new Float64Array(MAX_ACTIVE_VOICES);
  private readonly slotStart = new Float64Array(MAX_ACTIVE_VOICES);
  private readonly slotEnd = new Float64Array(MAX_ACTIVE_VOICES);
  private readonly slotInputs: (GainNodeLike | null)[] = new Array<GainNodeLike | null>(
    MAX_ACTIVE_VOICES * MAX_CHAINS_PER_VOICE,
  ).fill(null);
  private readonly slotInputCount = new Uint8Array(MAX_ACTIVE_VOICES);
  private readonly pendingChains: (SpatialChain | null)[] = new Array<SpatialChain | null>(
    MAX_CHAINS_PER_VOICE,
  ).fill(null);
  private pendingCount = 0;
  private openSlot = -1;
  private openDepth = 0;
  private openMaxEnd = 0;

  constructor(
    private readonly registerChainNodes: (nodes: readonly AudioNodeLike[], endTime: number) => void,
  ) {}

  begin(category: VoiceCategory, distanceM: number, now: number): boolean {
    if (this.openDepth > 0) {
      this.openDepth++;
      return true;
    }
    const rule = VOICE_CATEGORY_RULES[category];
    if (distanceM > rule.audibleDistanceM) {
      this.culledCount++;
      return false;
    }
    const slot = this.acquireSlot(category, rule.priority, rule.maxVoices, now);
    if (slot < 0) {
      this.droppedCount++;
      return false;
    }
    this.slotCategory[slot] = category;
    this.slotPriority[slot] = rule.priority;
    this.slotStart[slot] = now;
    this.slotEnd[slot] = now + PROVISIONAL_VOICE_LIFETIME_S;
    this.slotInputCount[slot] = 0;
    this.openSlot = slot;
    this.openDepth = 1;
    this.openMaxEnd = now;
    this.pendingCount = 0;
    return true;
  }

  noteSourceEnd(endTime: number): void {
    if (this.openDepth > 0 && endTime > this.openMaxEnd) {
      this.openMaxEnd = endTime;
    }
  }

  captureChain(chain: SpatialChain, createdAt: number): void {
    if (this.openDepth > 0 && this.pendingCount < MAX_CHAINS_PER_VOICE) {
      this.pendingChains[this.pendingCount++] = chain;
      return;
    }
    this.registerChainNodes(chain.nodes, createdAt + UNSCOPED_CHAIN_LIFETIME_S);
  }

  end(): void {
    if (this.openDepth === 0) {
      return;
    }
    this.openDepth--;
    if (this.openDepth > 0) {
      return;
    }
    const releaseAt = this.openMaxEnd + CHAIN_RELEASE_TAIL_S;
    const base = this.openSlot * MAX_CHAINS_PER_VOICE;
    for (let i = 0; i < this.pendingCount; i++) {
      const chain = this.pendingChains[i];
      if (chain) {
        this.registerChainNodes(chain.nodes, releaseAt);
        this.slotInputs[base + i] = chain.input;
      }
      this.pendingChains[i] = null;
    }
    this.slotInputCount[this.openSlot] = this.pendingCount;
    this.slotEnd[this.openSlot] = this.openMaxEnd;
    this.pendingCount = 0;
    this.openSlot = -1;
  }

  activeCount(now: number): number {
    let count = 0;
    for (let i = 0; i < MAX_ACTIVE_VOICES; i++) {
      if (this.slotCategory[i] !== null && this.slotEnd[i] > now) {
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.slotCategory.fill(null);
    this.slotInputs.fill(null);
    this.pendingChains.fill(null);
    this.slotInputCount.fill(0);
    this.openSlot = -1;
    this.openDepth = 0;
    this.pendingCount = 0;
  }

  private acquireSlot(
    category: VoiceCategory,
    priority: number,
    maxVoices: number,
    now: number,
  ): number {
    let freeSlot = -1;
    let sameCategory = 0;
    let victim = -1;
    for (let i = 0; i < MAX_ACTIVE_VOICES; i++) {
      if (this.slotCategory[i] !== null && this.slotEnd[i] <= now) {
        this.releaseSlot(i);
      }
      const slotCat = this.slotCategory[i];
      if (slotCat === null) {
        if (freeSlot < 0) {
          freeSlot = i;
        }
        continue;
      }
      if (slotCat === category) {
        sameCategory++;
      }
      if (
        victim < 0 ||
        this.slotPriority[i] < this.slotPriority[victim] ||
        (this.slotPriority[i] === this.slotPriority[victim] &&
          this.slotStart[i] < this.slotStart[victim])
      ) {
        victim = i;
      }
    }
    if (sameCategory >= maxVoices) {
      return -1;
    }
    if (freeSlot >= 0) {
      return freeSlot;
    }
    if (victim >= 0 && this.slotPriority[victim] < priority) {
      this.fadeOutSlot(victim, now);
      return victim;
    }
    return -1;
  }

  private releaseSlot(i: number): void {
    this.slotCategory[i] = null;
    const base = i * MAX_CHAINS_PER_VOICE;
    for (let k = 0; k < MAX_CHAINS_PER_VOICE; k++) {
      this.slotInputs[base + k] = null;
    }
    this.slotInputCount[i] = 0;
  }

  // A stolen voice's chain inputs fade to silence and the tracker releases its nodes at their
  // scheduled time; parts of the voice routed straight to the dry bus play out.
  private fadeOutSlot(i: number, now: number): void {
    const base = i * MAX_CHAINS_PER_VOICE;
    const count = this.slotInputCount[i];
    for (let k = 0; k < count; k++) {
      const input = this.slotInputs[base + k];
      if (!input) {
        continue;
      }
      try {
        const p = input.gain;
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(0, now + VOICE_STEAL_FADE_S);
      } catch {
        // mock or closed nodes may reject param scheduling
      }
    }
    this.stolenCount++;
    this.releaseSlot(i);
  }
}
