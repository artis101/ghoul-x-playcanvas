import type { PreloadPhaseId, PreloadProgressSnapshot } from '../../contracts/preloader.ts';
import { queryEl } from './hudTypes.ts';

type StageDomKey =
  | 'WASM_PHYSICS'
  | 'MODELS_AND_GRAPHS'
  | 'PROCEDURAL_TEXTURES'
  | 'AUDIO_DSP'
  | 'WORLD_COMPOSITION'
  | 'SHADER_COMPILATION';

type StageVisualState = 'pending' | 'active' | 'done' | 'error';

const ORDERED_STAGE_KEYS: readonly StageDomKey[] = [
  'WASM_PHYSICS',
  'MODELS_AND_GRAPHS',
  'PROCEDURAL_TEXTURES',
  'AUDIO_DSP',
  'WORLD_COMPOSITION',
  'SHADER_COMPILATION',
];

const STAGE_STATE_BADGES: Record<StageVisualState, string> = {
  pending: 'WAIT',
  active: 'EXEC',
  done: 'READY',
  error: 'FAULT',
};

const DEFAULT_PHASE_LABELS: Record<PreloadPhaseId, string> = {
  FONTS_AND_DOM: 'WASM PHYSICS & DOM RUNTIME',
  WASM_PHYSICS: 'WASM PHYSICS & DOM RUNTIME',
  MODELS_AND_GRAPHS: '3D ARSENAL & ANATOMICAL RIGS',
  PROCEDURAL_TEXTURES: 'PBR & IBL PROCEDURAL TEXTURES',
  AUDIO_DSP: 'WEB AUDIO DSP MATRIX',
  WORLD_COMPOSITION: 'ARENA & AI COMBAT SYSTEMS',
  SHADER_COMPILATION: 'GPU SHADER PIPELINE COMPILATION',
  READY: 'SYSTEMS ONLINE',
};

interface StagePillRefs {
  readonly key: StageDomKey;
  readonly pillEl: HTMLElement | null;
  readonly stateEl: HTMLElement | null;
}

function mapPhaseToStageKey(phase: PreloadPhaseId): StageDomKey | 'READY' {
  return phase === 'FONTS_AND_DOM' ? 'WASM_PHYSICS' : phase;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export class PreloaderScreen {
  public readonly isAvailable: boolean;

  private readonly overlayEl = queryEl('preloader-overlay');
  private readonly statusBadgeEl = queryEl('preloader-status-badge');
  private readonly progressFillEl = queryEl('preloader-progress-fill');
  private readonly subprogressFillEl = queryEl('preloader-subprogress-fill');
  private readonly percentEl = queryEl('preloader-percent');
  private readonly phaseLabelEl = queryEl('preloader-phase-label');
  private readonly itemTickerEl = queryEl('preloader-item-ticker');
  private readonly stepCounterEl = queryEl('preloader-step-counter');
  private readonly elapsedEl = queryEl('preloader-elapsed');
  private readonly errorBannerEl = queryEl('preloader-error-banner');
  private readonly errorMessageEl = queryEl('preloader-error-message');
  private readonly retryBtnEl = queryEl('preloader-retry-btn');
  private readonly stagePills: readonly StagePillRefs[];

  private maxOverallProgress = 0;
  private hasError = false;
  private isDismissed = false;
  private dismissDelayTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private transitionFallbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private activeTransitionHandler: (() => void) | null = null;
  private readonly retryClickHandler = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  public constructor() {
    this.isAvailable = this.overlayEl !== null;
    this.stagePills = ORDERED_STAGE_KEYS.map((key) => ({
      key,
      pillEl: queryEl(`preloader-stage-${key}`),
      stateEl: queryEl(`preloader-stage-state-${key}`),
    }));
    this.retryBtnEl?.addEventListener('click', this.retryClickHandler);
  }

  public update(snapshot: PreloadProgressSnapshot): void {
    if (!this.isAvailable || this.hasError || this.isDismissed) return;

    this.maxOverallProgress = Math.max(this.maxOverallProgress, clamp01(snapshot.overallProgress));
    const phaseRatio = clamp01(snapshot.phaseProgress);
    const pctInt = Math.round(this.maxOverallProgress * 100);

    if (this.progressFillEl) {
      this.progressFillEl.style.width = `${(this.maxOverallProgress * 100).toFixed(1)}%`;
    }
    if (this.subprogressFillEl) {
      this.subprogressFillEl.style.width = `${(phaseRatio * 100).toFixed(1)}%`;
    }
    if (this.percentEl) {
      this.percentEl.textContent = `${String(pctInt).padStart(3, '0')}%`;
    }

    this.applyStageStates(snapshot.phase);

    if (this.phaseLabelEl) {
      this.phaseLabelEl.textContent = snapshot.phaseLabel || DEFAULT_PHASE_LABELS[snapshot.phase];
    }
    if (this.itemTickerEl) {
      this.itemTickerEl.textContent = snapshot.itemLabel;
    }
    if (this.stepCounterEl) {
      const doneStr = String(Math.max(0, snapshot.completedSteps)).padStart(2, '0');
      const totalStr = String(Math.max(1, snapshot.totalSteps)).padStart(2, '0');
      this.stepCounterEl.textContent = `${doneStr} / ${totalStr}`;
    }
    if (this.elapsedEl) {
      this.elapsedEl.textContent = `${(Math.max(0, snapshot.elapsedMs) / 1000).toFixed(2)}s`;
    }
  }

  public setPhase(phase: PreloadPhaseId, phaseLabel?: string, itemLabel?: string): void {
    if (!this.isAvailable || this.hasError || this.isDismissed) return;
    this.applyStageStates(phase);
    if (this.phaseLabelEl) {
      this.phaseLabelEl.textContent = phaseLabel ?? DEFAULT_PHASE_LABELS[phase];
    }
    if (itemLabel !== undefined && this.itemTickerEl) {
      this.itemTickerEl.textContent = itemLabel;
    }
  }

  public showError(phase: PreloadPhaseId, message: string): void {
    if (!this.isAvailable) return;
    this.hasError = true;
    this.clearTimers();

    if (this.overlayEl) {
      this.overlayEl.classList.remove('preloader-dismissed', 'hidden');
      this.overlayEl.style.pointerEvents = 'auto';
    }
    if (this.statusBadgeEl) {
      this.statusBadgeEl.textContent = 'BOOT FAULT';
      this.statusBadgeEl.classList.remove('is-ready');
      this.statusBadgeEl.classList.add('is-error');
    }
    if (this.phaseLabelEl) {
      this.phaseLabelEl.textContent = `FAULT // ${DEFAULT_PHASE_LABELS[phase]}`;
    }
    if (this.errorMessageEl) this.errorMessageEl.textContent = message;
    if (this.errorBannerEl) this.errorBannerEl.classList.remove('hidden');

    this.applyStageStates(phase, true);
  }

  public completeAndDismiss(delayMs = 120): Promise<void> {
    if (!this.isAvailable || !this.overlayEl || this.isDismissed || this.hasError) {
      return Promise.resolve();
    }

    this.isDismissed = true;
    this.maxOverallProgress = 1;
    this.clearTimers();

    if (this.progressFillEl) this.progressFillEl.style.width = '100%';
    if (this.subprogressFillEl) this.subprogressFillEl.style.width = '100%';
    if (this.percentEl) this.percentEl.textContent = '100%';
    if (this.statusBadgeEl) {
      this.statusBadgeEl.textContent = 'SYSTEMS ONLINE';
      this.statusBadgeEl.classList.remove('is-error');
      this.statusBadgeEl.classList.add('is-ready');
    }
    if (this.phaseLabelEl) this.phaseLabelEl.textContent = 'SYSTEMS ONLINE';
    if (this.itemTickerEl) this.itemTickerEl.textContent = 'All Tactical Subsystems Ready';

    this.applyStageStates('READY');
    this.overlayEl.style.pointerEvents = 'none';

    return new Promise<void>((resolve) => {
      const startFadeOut = (): void => {
        if (!this.overlayEl) {
          resolve();
          return;
        }
        let settled = false;
        const finishDismiss = (): void => {
          if (settled) return;
          settled = true;
          this.clearTransitionCleanup();
          this.overlayEl?.classList.add('hidden');
          resolve();
        };

        this.activeTransitionHandler = finishDismiss;
        this.overlayEl.addEventListener('transitionend', finishDismiss, { once: true });
        this.overlayEl.classList.add('preloader-dismissed');
        this.transitionFallbackTimer = globalThis.setTimeout(finishDismiss, 360);
      };

      if (delayMs > 0) {
        this.dismissDelayTimer = globalThis.setTimeout(startFadeOut, delayMs);
      } else {
        startFadeOut();
      }
    });
  }

  public destroy(): void {
    this.clearTimers();
    this.retryBtnEl?.removeEventListener('click', this.retryClickHandler);
  }

  private applyStageStates(phase: PreloadPhaseId, isError = false): void {
    const mapped = mapPhaseToStageKey(phase);
    const targetIdx =
      mapped === 'READY' ? ORDERED_STAGE_KEYS.length : ORDERED_STAGE_KEYS.indexOf(mapped);

    for (let i = 0; i < this.stagePills.length; i++) {
      const ref = this.stagePills[i];
      const state: StageVisualState =
        i < targetIdx ? 'done' : i === targetIdx ? (isError ? 'error' : 'active') : 'pending';

      if (ref.pillEl) {
        ref.pillEl.classList.remove('pending', 'active', 'done', 'error');
        ref.pillEl.classList.add(state);
      }
      if (ref.stateEl) {
        ref.stateEl.textContent = STAGE_STATE_BADGES[state];
      }
    }
  }

  private clearTransitionCleanup(): void {
    if (this.transitionFallbackTimer !== null) {
      globalThis.clearTimeout(this.transitionFallbackTimer);
      this.transitionFallbackTimer = null;
    }
    if (this.activeTransitionHandler && this.overlayEl) {
      this.overlayEl.removeEventListener('transitionend', this.activeTransitionHandler);
      this.activeTransitionHandler = null;
    }
  }

  private clearTimers(): void {
    if (this.dismissDelayTimer !== null) {
      globalThis.clearTimeout(this.dismissDelayTimer);
      this.dismissDelayTimer = null;
    }
    this.clearTransitionCleanup();
  }
}
