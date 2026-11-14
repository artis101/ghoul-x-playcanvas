import type { IGhoulXApp } from '../app/appContext.ts';
import type { BootTimingReport } from '../preloader/bootTimings.ts';
import { FrameProfiler } from './frameProfiler.ts';
import { SimClock } from './simClock.ts';
import { getDevFlags, isDevBuild, type DevFlags } from './devFlags.ts';
import { DebugOverlay } from './debugOverlay.ts';

interface PhysicsPerfCounters {
  readonly stepsThisFrame: number;
  readonly queryFlushesThisFrame: number;
  readonly raycastsThisFrame: number;
}

interface PhysicsPerfSource {
  readonly perf?: PhysicsPerfCounters;
  resetPerfCounters?: () => void;
}

export interface PhysicsPerfSample {
  available: boolean;
  steps: number;
  queryFlushes: number;
  raycasts: number;
  maxSteps: number;
  maxQueryFlushes: number;
  maxRaycasts: number;
}

export const DEV_KEY_CODES = { overlay: 'F3', pause: 'F6', step: 'F7', timeScale: 'F8' } as const;

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** Per-app developer state: frame profiler, sim clock, dev keys and the debug overlay. */
export class DevRuntime {
  public readonly profiler = new FrameProfiler();
  public readonly clock = new SimClock();
  public readonly flags: DevFlags;
  public bootTimings: BootTimingReport | null = null;
  public readonly physics: PhysicsPerfSample = {
    available: false,
    steps: 0,
    queryFlushes: 0,
    raycasts: 0,
    maxSteps: 0,
    maxQueryFlushes: 0,
    maxRaycasts: 0,
  };
  public framesInWindow = 0;
  public rawDtSumS = 0;
  public rawDtMaxS = 0;
  private readonly overlay: DebugOverlay | null;
  private removeKeyListener: (() => void) | null = null;

  constructor(public readonly app: IGhoulXApp, flags: DevFlags = getDevFlags()) {
    this.flags = flags;
    const devEnabled = isDevBuild() || flags.debug;
    this.overlay = devEnabled ? createOverlay(this, app, flags.debug) : null;

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      devEnabled
    ) {
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.code !== 'F3' && e.code !== 'F6' && e.code !== 'F7' && e.code !== 'F8') return;
        e.preventDefault();
        if (e.repeat) return;
        this.handleDevKey(e.code);
      };
      window.addEventListener('keydown', onKeyDown);
      this.removeKeyListener = () => window.removeEventListener('keydown', onKeyDown);
    }
  }

  public get isOverlayVisible(): boolean {
    return this.overlay?.visible ?? false;
  }

  public beginFrame(rawDt: number): void {
    this.framesInWindow += 1;
    this.rawDtSumS += rawDt;
    if (rawDt > this.rawDtMaxS) this.rawDtMaxS = rawDt;

    const source = this.app.rapierWorld as unknown as PhysicsPerfSource | undefined;
    if (!source) return;
    const perf = source.perf;
    if (perf) {
      const p = this.physics;
      p.available = true;
      p.steps = perf.stepsThisFrame;
      p.queryFlushes = perf.queryFlushesThisFrame;
      p.raycasts = perf.raycastsThisFrame;
      p.maxSteps = Math.max(p.maxSteps, p.steps);
      p.maxQueryFlushes = Math.max(p.maxQueryFlushes, p.queryFlushes);
      p.maxRaycasts = Math.max(p.maxRaycasts, p.raycasts);
    }
    if (typeof source.resetPerfCounters === 'function') source.resetPerfCounters();
  }

  public endFrame(): void {
    this.overlay?.tick(nowMs());
  }

  public handleDevKey(code: string): boolean {
    switch (code) {
      case DEV_KEY_CODES.overlay:
        this.overlay?.toggle();
        break;
      case DEV_KEY_CODES.pause:
        this.clock.togglePause();
        break;
      case DEV_KEY_CODES.step:
        this.clock.requestStep();
        break;
      case DEV_KEY_CODES.timeScale:
        this.clock.cycleTimeScale();
        break;
      default:
        return false;
    }
    this.overlay?.refresh();
    return true;
  }

  public resetWindowStats(): void {
    this.framesInWindow = 0;
    this.rawDtSumS = 0;
    this.rawDtMaxS = 0;
    this.physics.maxSteps = 0;
    this.physics.maxQueryFlushes = 0;
    this.physics.maxRaycasts = 0;
  }

  public dispose(): void {
    this.removeKeyListener?.();
    this.removeKeyListener = null;
    this.overlay?.destroy();
  }
}

function createOverlay(runtime: DevRuntime, app: IGhoulXApp, visible: boolean): DebugOverlay | null {
  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function' ||
    typeof document.body?.appendChild !== 'function'
  ) {
    return null;
  }
  try {
    return new DebugOverlay(runtime, app, visible);
  } catch {
    return null;
  }
}

const runtimes = new WeakMap<IGhoulXApp, DevRuntime>();

interface DestroyEventSource {
  once?: (name: 'destroy', callback: () => void) => unknown;
}

export function getDevRuntime(app: IGhoulXApp): DevRuntime {
  let runtime = runtimes.get(app);
  if (!runtime) {
    runtime = new DevRuntime(app);
    runtimes.set(app, runtime);
    const clock = runtime.clock;
    if (app.fpsController) app.fpsController.isSimulationPaused = () => clock.paused;
    // The PlayCanvas app fires 'destroy' on teardown; the key listener and overlay go with it.
    const pcApp = (app as unknown as { app?: DestroyEventSource }).app;
    if (typeof pcApp?.once === 'function') pcApp.once('destroy', () => disposeDevRuntime(app));
  }
  return runtime;
}

export function disposeDevRuntime(app: IGhoulXApp): void {
  const runtime = runtimes.get(app);
  if (!runtime) return;
  runtime.dispose();
  runtimes.delete(app);
}
