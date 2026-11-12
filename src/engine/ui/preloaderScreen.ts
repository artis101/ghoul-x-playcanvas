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

export type PreloaderScreenState =
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'BOOTING'; readonly phase: PreloadPhaseId; readonly maxProgress: number }
  | {
      readonly kind: 'DISMISSING_DELAY';
      readonly timer: ReturnType<typeof globalThis.setTimeout>;
      readonly inFlight: Promise<void>;
      readonly settle: () => void;
    }
  | {
      readonly kind: 'DISMISSING_FADE';
      readonly fallbackTimer: ReturnType<typeof globalThis.setTimeout>;
      readonly onTransitionEnd: () => void;
      readonly inFlight: Promise<void>;
      readonly settle: () => void;
    }
  | { readonly kind: 'DISMISSED' }
  | { readonly kind: 'FAULT'; readonly phase: PreloadPhaseId; readonly message: string }
  | { readonly kind: 'DESTROYED' };

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

  public state: PreloaderScreenState;

  private readonly retryClickHandler = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  public constructor() {
    this.state =
      this.overlayEl !== null
        ? { kind: 'BOOTING', phase: 'FONTS_AND_DOM', maxProgress: 0 }
        : { kind: 'UNAVAILABLE' };
    this.stagePills = ORDERED_STAGE_KEYS.map((key) => ({
      key,
      pillEl: queryEl(`preloader-stage-${key}`),
      stateEl: queryEl(`preloader-stage-state-${key}`),
    }));
    this.retryBtnEl?.addEventListener('click', this.retryClickHandler);
  }

  public get isAvailable(): boolean {
    return this.overlayEl !== null && this.state.kind !== 'UNAVAILABLE';
  }

  private transitionState(next: PreloaderScreenState): void {
    const prev = this.state;
    if (prev.kind === 'DISMISSING_DELAY') {
      globalThis.clearTimeout(prev.timer);
      const handingOffToFade =
        next.kind === 'DISMISSING_FADE' && next.inFlight === prev.inFlight;
      if (!handingOffToFade) {
        prev.settle();
      }
    } else if (prev.kind === 'DISMISSING_FADE') {
      globalThis.clearTimeout(prev.fallbackTimer);
      this.overlayEl?.removeEventListener('transitionend', prev.onTransitionEnd);
      prev.settle();
    }
    this.state = next;
  }

  public update(snapshot: PreloadProgressSnapshot): void {
    if (this.state.kind !== 'BOOTING') return;

    const maxOverallProgress = Math.max(this.state.maxProgress, clamp01(snapshot.overallProgress));
    this.transitionState({
      kind: 'BOOTING',
      phase: snapshot.phase,
      maxProgress: maxOverallProgress,
    });

    const phaseRatio = clamp01(snapshot.phaseProgress);
    const pctInt = Math.round(maxOverallProgress * 100);

    if (this.progressFillEl) {
      this.progressFillEl.style.width = `${(maxOverallProgress * 100).toFixed(1)}%`;
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
    if (this.state.kind !== 'BOOTING') return;
    this.transitionState({
      kind: 'BOOTING',
      phase,
      maxProgress: this.state.maxProgress,
    });
    this.applyStageStates(phase);
    if (this.phaseLabelEl) {
      this.phaseLabelEl.textContent = phaseLabel ?? DEFAULT_PHASE_LABELS[phase];
    }
    if (itemLabel !== undefined && this.itemTickerEl) {
      this.itemTickerEl.textContent = itemLabel;
    }
  }

  public showError(phase: PreloadPhaseId, message: string): void {
    if (!this.isAvailable || this.state.kind === 'DESTROYED') return;
    this.transitionState({ kind: 'FAULT', phase, message });

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
    if (this.state.kind === 'DISMISSING_DELAY' || this.state.kind === 'DISMISSING_FADE') {
      return this.state.inFlight;
    }
    if (this.state.kind !== 'BOOTING' || !this.overlayEl) {
      return Promise.resolve();
    }

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

    let settleFn!: () => void;
    let settled = false;
    const inFlight = new Promise<void>((resolve) => {
      settleFn = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
    });

    const startFadeOut = (): void => {
      if (this.state.kind !== 'BOOTING' && this.state.kind !== 'DISMISSING_DELAY') {
        settleFn();
        return;
      }
      if (!this.overlayEl) {
        this.transitionState({ kind: 'DISMISSED' });
        return;
      }

      const finishDismiss = (): void => {
        if (this.state.kind !== 'DISMISSING_FADE') return;
        this.overlayEl?.classList.add('hidden');
        this.transitionState({ kind: 'DISMISSED' });
      };

      this.overlayEl.addEventListener('transitionend', finishDismiss, { once: true });
      this.overlayEl.classList.add('preloader-dismissed');
      const fallbackTimer = globalThis.setTimeout(finishDismiss, 360);
      this.transitionState({
        kind: 'DISMISSING_FADE',
        fallbackTimer,
        onTransitionEnd: finishDismiss,
        inFlight,
        settle: settleFn,
      });
    };

    if (delayMs > 0) {
      const timer = globalThis.setTimeout(startFadeOut, delayMs);
      this.transitionState({
        kind: 'DISMISSING_DELAY',
        timer,
        inFlight,
        settle: settleFn,
      });
    } else {
      startFadeOut();
    }

    return inFlight;
  }

  public destroy(): void {
    if (this.state.kind === 'DESTROYED') return;
    if (this.state.kind !== 'UNAVAILABLE') {
      this.transitionState({ kind: 'DESTROYED' });
    }
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
}
