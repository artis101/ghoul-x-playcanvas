import type * as pc from 'playcanvas';
import type {
  PreloadPhaseId,
  PreloadProgressCallback,
  PreloadProgressSnapshot,
} from '../../contracts/preloader.ts';
import type { CombatAudioEngineOptions } from '../../core/audio/types.ts';
import { createPlayCanvasApp } from '../app/appSetup.ts';
import { GhoulXApplication } from '../app/ghoulXApp.ts';
import { GlbModelRegistry } from '../assets/glbLoader.ts';
import { CombatAudioEngine } from '../audio/combatAudioEngine.ts';
import { getOrCreateMaterials } from '../materials.ts';
import { initRapierPhysics } from '../physics/rapierWorld.ts';
import { PreloaderScreen } from '../ui/preloaderScreen.ts';
import { prewarmProceduralTexturesAndMaterials } from './materialCollector.ts';
import { compileAllGameShaders } from './shaderWarmup.ts';

export interface GamePreloaderOptions {
  readonly canvas?: HTMLCanvasElement;
  readonly app?: pc.Application;
  readonly glbRegistry?: GlbModelRegistry;
  readonly preloaderScreen?: PreloaderScreen;
  readonly audioOptions?: CombatAudioEngineOptions;
  readonly onProgress?: PreloadProgressCallback;
  readonly yieldFrames?: boolean;
  readonly dismissDelayMs?: number;
  readonly allowMissingGlbsForTests?: boolean;
}

interface PhaseRange {
  readonly base: number;
  readonly weight: number;
  readonly label: string;
}

export type PreloaderBootState =
  | {
      readonly kind: 'RUNNING';
      readonly phase: PreloadPhaseId;
      readonly maxOverallProgress: number;
      readonly completedSteps: number;
      readonly totalSteps: number;
    }
  | {
      readonly kind: 'READY';
      readonly completedSteps: number;
      readonly totalSteps: number;
    }
  | {
      readonly kind: 'FAULT';
      readonly phase: PreloadPhaseId;
      readonly message: string;
    };

const PHASE_RANGES: Record<PreloadPhaseId, PhaseRange> = {
  FONTS_AND_DOM: { base: 0.0, weight: 0.05, label: 'WASM PHYSICS & DOM RUNTIME' },
  WASM_PHYSICS: { base: 0.05, weight: 0.1, label: 'WASM PHYSICS & DOM RUNTIME' },
  MODELS_AND_GRAPHS: { base: 0.15, weight: 0.35, label: '3D ARSENAL & ANATOMICAL RIGS' },
  PROCEDURAL_TEXTURES: { base: 0.5, weight: 0.18, label: 'PBR & IBL PROCEDURAL TEXTURES' },
  AUDIO_DSP: { base: 0.68, weight: 0.06, label: 'WEB AUDIO DSP MATRIX' },
  WORLD_COMPOSITION: { base: 0.74, weight: 0.1, label: 'ARENA & AI COMBAT SYSTEMS' },
  SHADER_COMPILATION: { base: 0.84, weight: 0.16, label: 'GPU SHADER PIPELINE COMPILATION' },
  READY: { base: 1.0, weight: 0.0, label: 'SYSTEMS ONLINE' },
};

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function yieldAnimationFrame(shouldYield: boolean): Promise<void> {
  if (!shouldYield || typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function awaitFontsReady(timeoutMs = 1200): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.ready) return;
  let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    await Promise.race([
      document.fonts.ready.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        timerId = globalThis.setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) globalThis.clearTimeout(timerId);
  }
}

export async function runGamePreloader(
  options: GamePreloaderOptions = {}
): Promise<GhoulXApplication> {
  const preloaderScreen = options.preloaderScreen ?? new PreloaderScreen();
  const yieldFrames = options.yieldFrames !== false;
  const startTimeMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const getElapsedMs = (): number => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Math.max(0, now - startTimeMs);
  };

  let bootState: PreloaderBootState = {
    kind: 'RUNNING',
    phase: 'FONTS_AND_DOM',
    maxOverallProgress: 0,
    completedSteps: 0,
    totalSteps: 32,
  };
  let app: pc.Application | null = options.app ?? null;

  const advancePhase = (phase: PreloadPhaseId): void => {
    if (bootState.kind !== 'RUNNING') return;
    bootState = { ...bootState, phase };
  };

  const emitProgress = (
    phase: PreloadPhaseId,
    phaseProgress: number,
    itemLabel: string,
    markReady = false
  ): void => {
    if (bootState.kind !== 'RUNNING') return;
    const range = PHASE_RANGES[phase];
    const clampedPhase = clamp01(phaseProgress);
    const rawOverall = markReady ? 1 : range.base + range.weight * clampedPhase;
    const nextOverall = Math.max(bootState.maxOverallProgress, clamp01(rawOverall));

    const rawCompleted = bootState.completedSteps + 1;
    const nextTotal = markReady
      ? Math.max(rawCompleted, bootState.totalSteps)
      : rawCompleted >= bootState.totalSteps
        ? rawCompleted + 2
        : bootState.totalSteps;
    const nextCompleted = markReady ? nextTotal : rawCompleted;

    bootState = markReady
      ? { kind: 'READY', completedSteps: nextCompleted, totalSteps: nextTotal }
      : {
          kind: 'RUNNING',
          phase,
          maxOverallProgress: nextOverall,
          completedSteps: nextCompleted,
          totalSteps: nextTotal,
        };

    const snapshot: PreloadProgressSnapshot = {
      phase,
      phaseLabel: range.label,
      itemLabel,
      overallProgress: nextOverall,
      phaseProgress: clampedPhase,
      completedSteps: nextCompleted,
      totalSteps: nextTotal,
      elapsedMs: getElapsedMs(),
    };

    preloaderScreen.update(snapshot);
    options.onProgress?.(snapshot);
    app?.fire('preloader:progress', snapshot);
  };

  try {
    // 1. FONTS_AND_DOM
    emitProgress('FONTS_AND_DOM', 0.2, 'Validating viewport canvas & initializing WebGL2 context...');
    let canvas = options.canvas;
    if (!canvas) {
      const el = typeof document !== 'undefined' ? document.getElementById('playcanvas-viewport') : null;
      if (!(el instanceof HTMLCanvasElement)) {
        throw new Error('Canvas #playcanvas-viewport not found in document!');
      }
      canvas = el;
    }

    app = app ?? createPlayCanvasApp(canvas);
    emitProgress('FONTS_AND_DOM', 0.6, 'Synchronizing tactical HUD typography...');
    await awaitFontsReady(1200);
    emitProgress('FONTS_AND_DOM', 1.0, 'DOM runtime & WebGL2 viewport ready');
    await yieldAnimationFrame(yieldFrames);

    // 2. WASM_PHYSICS
    advancePhase('WASM_PHYSICS');
    emitProgress('WASM_PHYSICS', 0.15, 'Initializing Rapier3D SIMD WebAssembly physics kernel...');
    await yieldAnimationFrame(yieldFrames);
    await initRapierPhysics();
    emitProgress('WASM_PHYSICS', 1.0, 'Rapier3D rigid-body & BVH physics kernel online');
    await yieldAnimationFrame(yieldFrames);

    // 3. MODELS_AND_GRAPHS
    advancePhase('MODELS_AND_GRAPHS');
    const glbRegistry = options.glbRegistry ?? new GlbModelRegistry(app);
    emitProgress('MODELS_AND_GRAPHS', 0.02, 'Loading 3D GLB arsenal, GHOUL rig & Voronoi fracture graphs...');

    let loadedAssets = 0;
    try {
      await glbRegistry.preloadAll((ev) => {
        loadedAssets = ev.loadedCount;
        const ratio = (ev.loadedCount / Math.max(1, ev.totalCount)) * 0.82;
        emitProgress('MODELS_AND_GRAPHS', ratio, `Loaded ${ev.assetKey} (${ev.loadedCount}/${ev.totalCount})`);
      });
    } catch (err: unknown) {
      if (!options.allowMissingGlbsForTests) throw err;
    }

    await yieldAnimationFrame(yieldFrames);
    let warmStep = 0;
    glbRegistry.warmExtractedBundles((label) => {
      warmStep += 1;
      emitProgress('MODELS_AND_GRAPHS', 0.82 + Math.min(1, warmStep / 3) * 0.18, label);
    });
    emitProgress('MODELS_AND_GRAPHS', 1.0, 'All 3D GLB containers & fracture bundles cached');
    await yieldAnimationFrame(yieldFrames);

    // 4. PROCEDURAL_TEXTURES
    advancePhase('PROCEDURAL_TEXTURES');
    const materials = getOrCreateMaterials();
    const extraMaterials = await prewarmProceduralTexturesAndMaterials(
      app,
      materials,
      async (label, done, total) => {
        emitProgress('PROCEDURAL_TEXTURES', done / Math.max(1, total), label);
        if (done % 3 === 0) await yieldAnimationFrame(yieldFrames);
      }
    );

    // 5. AUDIO_DSP
    advancePhase('AUDIO_DSP');
    emitProgress('AUDIO_DSP', 0.25, 'Synthesizing warehouse impulse response & WebAudio DSP buses...');
    await yieldAnimationFrame(yieldFrames);
    const combatAudio = new CombatAudioEngine({
      pannerModel: 'equalpower',
      ...options.audioOptions,
    });
    const dspWarm = combatAudio.prewarmDspGraph();
    emitProgress(
      'AUDIO_DSP',
      1.0,
      dspWarm
        ? 'WebAudio convolution reverb, waveshaper & noise buffers pre-baked'
        : 'WebAudio DSP standing by (headless audio context)'
    );
    await yieldAnimationFrame(yieldFrames);

    // 6. WORLD_COMPOSITION
    advancePhase('WORLD_COMPOSITION');
    emitProgress('WORLD_COMPOSITION', 0.2, 'Composing arena geometry, destructible cover & tactical AI wave...');
    await yieldAnimationFrame(yieldFrames);
    const ghoulApp = new GhoulXApplication(canvas, app, glbRegistry, {
      materials,
      combatAudio,
      autoStart: false,
    });
    emitProgress('WORLD_COMPOSITION', 1.0, 'Arena, mayhem pools, viewmodel arsenal & AI squad initialized');
    await yieldAnimationFrame(yieldFrames);

    // 7. SHADER_COMPILATION
    advancePhase('SHADER_COMPILATION');
    emitProgress('SHADER_COMPILATION', 0.05, 'Preparing GPU shader compilation staging pass...');
    const warmup = await compileAllGameShaders({
      app,
      glbRegistry,
      extraMaterials: [...extraMaterials, ...ghoulApp.combatDirector.warmupMaterials],
      sceneShaderOutput: ghoulApp.cinematicFrame.sceneShaderOutput,
      yieldFrames,
      onProgress: (label, done, total) => {
        emitProgress('SHADER_COMPILATION', done / Math.max(1, total), label);
      },
    });

    // 8. READY
    advancePhase('READY');
    ghoulApp.start();
    emitProgress('READY', 1.0, 'All Tactical Subsystems Ready', true);
    app.fire('preloader:complete', {
      totalElapsedMs: getElapsedMs(),
      compiledShaders: warmup.warmedVariants,
      loadedAssets,
    });
    await preloaderScreen.completeAndDismiss(options.dismissDelayMs);

    return ghoulApp;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const currentBoot = bootState as PreloaderBootState;
    const failedPhase: PreloadPhaseId =
      currentBoot.kind === 'RUNNING' || currentBoot.kind === 'FAULT' ? currentBoot.phase : 'READY';
    bootState = { kind: 'FAULT', phase: failedPhase, message };
    preloaderScreen.showError(failedPhase, message);
    app?.fire('preloader:error', { phase: failedPhase, message });
    throw err;
  }
}
