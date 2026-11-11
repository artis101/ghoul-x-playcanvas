import {
  InternalBallisticsReport,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityConfig,
  PhysiologicalEntityState,
} from '../../contracts/physiology.ts';
import { createPhysiologicalEntityState } from './initialState.ts';
import { recomputeMotorAndReadability } from './motorReadability.ts';
import { computeBleedVisualProfile } from './shockBleedProfiles.ts';
import { applyInternalBallisticsTrauma } from './traumaDispatcher.ts';
import { stepBiologicalTick } from './biologicalTick.ts';

/**
 * Decoupled 4–10 Hz Physiological ECS State Machine + Stage-4 Readability Bridge.
 */
export class PhysiologyEcsSystem {
  public readonly tickHz: number;
  public readonly tickIntervalS: number;

  private accumulatorS = 0;
  private readonly entities = new Map<string, PhysiologicalEntityState>();
  private readonly denseList: PhysiologicalEntityState[] = [];

  constructor(tickHz: number = PHYSIOLOGY_CONSTANTS.DEFAULT_TICK_HZ) {
    const clampedHz = Math.max(1, Math.min(30, tickHz));
    this.tickHz = clampedHz;
    this.tickIntervalS = 1.0 / clampedHz;
  }

  public registerEntity(config: PhysiologicalEntityConfig): PhysiologicalEntityState {
    const existing = this.entities.get(config.entityId);
    if (existing) {
      return existing;
    }
    const state = createPhysiologicalEntityState(config);
    this.entities.set(config.entityId, state);
    this.denseList.push(state);
    return state;
  }

  public getEntity(entityId: string): PhysiologicalEntityState | undefined {
    return this.entities.get(entityId);
  }

  public getAllEntities(): readonly PhysiologicalEntityState[] {
    return this.denseList;
  }

  public removeEntity(entityId: string): boolean {
    const state = this.entities.get(entityId);
    if (!state) return false;
    this.entities.delete(entityId);
    const idx = this.denseList.indexOf(state);
    if (idx >= 0) {
      const last = this.denseList.pop()!;
      if (idx < this.denseList.length) {
        this.denseList[idx] = last;
      }
    }
    return true;
  }

  public reset(): void {
    this.accumulatorS = 0;
    this.entities.clear();
    this.denseList.length = 0;
  }

  public applyChestSealOrDecompression(entityId: string): boolean {
    const state = this.entities.get(entityId);
    if (!state || !state.alive) return false;
    if (
      state.pneumothoraxState === 'TENSION_PNEUMOTHORAX' ||
      state.pneumothoraxState === 'OPEN_PNEUMOTHORAX'
    ) {
      state.pneumothoraxState = 'DECOMPRESSED_SEALED';
      state.lungIntegrity = Math.max(state.lungIntegrity, 0.78);
      recomputeMotorAndReadability(state);
      return true;
    }
    return false;
  }

  public applyBallisticTrauma(
    entityId: string,
    report: InternalBallisticsReport
  ): PhysiologicalEntityState {
    const state = this.entities.get(entityId);
    if (!state) {
      throw new Error(`PhysiologyEcsSystem: unknown entityId '${entityId}'`);
    }
    return applyInternalBallisticsTrauma(state, report);
  }

  public update(dt: number): number {
    if (dt <= 0 || !Number.isFinite(dt)) return 0;

    for (let i = 0; i < this.denseList.length; i++) {
      this.denseList[i].elapsedTimeS += dt;
    }

    this.accumulatorS += dt;
    let ticksExecuted = 0;

    while (this.accumulatorS + 1e-9 >= this.tickIntervalS) {
      this.accumulatorS -= this.tickIntervalS;
      ticksExecuted++;
      for (let i = 0; i < this.denseList.length; i++) {
        stepBiologicalTick(this.denseList[i], this.tickIntervalS);
      }
    }

    if (ticksExecuted === 0) {
      for (let i = 0; i < this.denseList.length; i++) {
        const st = this.denseList[i];
        if (st.vascularWounds.length > 0) {
          st.readability.bleedVisualProfile = computeBleedVisualProfile(st);
        }
      }
    }

    return ticksExecuted;
  }
}
