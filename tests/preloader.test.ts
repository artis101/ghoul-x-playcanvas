import * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import type { AssetLoadProgressEvent, PreloadPhaseId, PreloadProgressSnapshot } from '../src/contracts/preloader.ts';
import { GhoulXApplication } from '../src/engine/app/ghoulXApp.ts';
import { ALL_GLB_ASSET_KEYS, GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import { CombatAudioEngine, type AudioContextLike } from '../src/engine/audio/combatAudioEngine.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import { initRapierPhysics } from '../src/engine/physics/rapierWorld.ts';
import {
  PreloaderScreen,
  collectSceneMaterials,
  compileAllGameShaders,
  prewarmProceduralTexturesAndMaterials,
  runGamePreloader,
} from '../src/engine/preloader/index.ts';

interface FakeElement {
  id: string;
  textContent: string;
  style: { width: string; pointerEvents: string };
  classList: {
    readonly classes: Set<string>;
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    contains: (token: string) => boolean;
  };
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  dispatch: (type: string) => void;
}

function createFakeElement(id: string, initialClasses: string[] = []): FakeElement {
  const classes = new Set<string>(initialClasses);
  const listeners = new Map<string, Set<() => void>>();
  return {
    id, textContent: '', style: { width: '0%', pointerEvents: 'auto' },
    classList: {
      classes,
      add: (...tokens: string[]) => tokens.forEach((t) => classes.add(t)),
      remove: (...tokens: string[]) => tokens.forEach((t) => classes.delete(t)),
      contains: (token: string) => classes.has(token),
    },
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: () => void) => { listeners.get(type)?.delete(cb); },
    dispatch: (type: string) => { for (const cb of Array.from(listeners.get(type) ?? [])) cb(); },
  };
}

function withFakeDom<T>(elements: Record<string, FakeElement>, fn: () => Promise<T> | T): Promise<T> | T {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = { getElementById: (id: string) => elements[id] ?? null, addEventListener: () => {}, removeEventListener: () => {} };
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { reload: () => {} },
    performance: globalThis.performance,
  };
  const restore = (): void => { g.document = prevDoc; g.window = prevWin; };
  try {
    const res = fn();
    return res instanceof Promise ? res.finally(restore) : (restore(), res);
  } catch (err) { restore(); throw err; }
}

function createHeadlessApp(): { canvas: HTMLCanvasElement; app: pc.Application } {
  const canvasStub = { width: 640, height: 480, addEventListener: () => {}, removeEventListener: () => {}, requestPointerLock: () => {} };
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, { graphicsDevice: new pc.NullGraphicsDevice(canvasStub) });
  return { canvas: canvasStub as unknown as HTMLCanvasElement, app };
}

function createMinimalContainer(name: string): pc.ContainerResource {
  return {
    renders: [], materials: [], textures: [], animations: [], gsplats: [],
    instantiateModelEntity: () => new pc.Entity(name),
    instantiateRenderEntity: () => new pc.Entity(name),
    getMaterialVariants: () => [], applyMaterialVariant: () => {}, applyMaterialVariantInstances: () => {},
  };
}

describe('GHOUL-X Pre-Loader, Shader Warm-Up & Deferred Application Start', () => {
  it('PreloaderScreen is headless-safe without DOM and drives monotonic progress, stage pills, error banner & dismissal with DOM', async () => {
    const headlessScreen = new PreloaderScreen();
    expect(headlessScreen.isAvailable).toBe(false);
    headlessScreen.update({
      phase: 'WASM_PHYSICS', phaseLabel: 'WASM PHYSICS', itemLabel: 'Init',
      overallProgress: 0.25, phaseProgress: 0.5, completedSteps: 1, totalSteps: 10, elapsedMs: 42,
    });
    headlessScreen.setPhase('AUDIO_DSP');
    headlessScreen.showError('AUDIO_DSP', 'Audio failed');
    await headlessScreen.completeAndDismiss(0);
    headlessScreen.destroy();

    const ids = [
      'preloader-overlay', 'preloader-status-badge', 'preloader-progress-fill', 'preloader-subprogress-fill',
      'preloader-percent', 'preloader-phase-label', 'preloader-item-ticker', 'preloader-step-counter',
      'preloader-elapsed', 'preloader-error-message', 'preloader-retry-btn',
      'preloader-stage-WASM_PHYSICS', 'preloader-stage-state-WASM_PHYSICS',
      'preloader-stage-MODELS_AND_GRAPHS', 'preloader-stage-state-MODELS_AND_GRAPHS',
    ];
    const els: Record<string, FakeElement> = Object.fromEntries(ids.map((id) => [id, createFakeElement(id)]));
    els['preloader-error-banner'] = createFakeElement('preloader-error-banner', ['hidden']);

    await withFakeDom(els, async () => {
      const screen = new PreloaderScreen();
      expect(screen.isAvailable).toBe(true);
      screen.update({
        phase: 'MODELS_AND_GRAPHS', phaseLabel: '3D ARSENAL', itemLabel: 'ghoul_combatant.glb',
        overallProgress: 0.45, phaseProgress: 0.6, completedSteps: 4, totalSteps: 12, elapsedMs: 350,
      });
      expect(els['preloader-percent'].textContent).toBe('045%');
      expect(els['preloader-stage-WASM_PHYSICS'].classList.contains('done')).toBe(true);
      expect(els['preloader-stage-MODELS_AND_GRAPHS'].classList.contains('active')).toBe(true);

      screen.update({
        phase: 'MODELS_AND_GRAPHS', phaseLabel: '3D ARSENAL', itemLabel: 'm4a1_carbine.glb',
        overallProgress: 0.2, phaseProgress: 0.8, completedSteps: 5, totalSteps: 12, elapsedMs: 400,
      });
      expect(els['preloader-percent'].textContent).toBe('045%');

      const dismissPromise = screen.completeAndDismiss(0);
      expect(els['preloader-overlay'].style.pointerEvents).toBe('none');
      expect(els['preloader-percent'].textContent).toBe('100%');
      els['preloader-overlay'].dispatch('transitionend');
      await dismissPromise;
      expect(els['preloader-overlay'].classList.contains('hidden')).toBe(true);

      const errScreen = new PreloaderScreen();
      errScreen.showError('MODELS_AND_GRAPHS', 'Missing GLB');
      expect(els['preloader-status-badge'].textContent).toBe('BOOT FAULT');
      expect(els['preloader-error-banner'].classList.contains('hidden')).toBe(false);
      expect(els['preloader-error-message'].textContent).toBe('Missing GLB');
      errScreen.destroy();
      screen.destroy();
    });
  });

  it('GlbModelRegistry.preloadAll reports all 9 asset progress events and warmExtractedBundles caches steps', async () => {
    const { app } = createHeadlessApp();
    try {
      const registry = new GlbModelRegistry(app);
      for (const key of ALL_GLB_ASSET_KEYS) registry.registerContainerResource(key, createMinimalContainer(key));
      const mockGraph = { version: 1 as const, wallId: 'concrete_barrier_v1', nodes: [] };
      vi.spyOn(registry, 'loadConcreteConnectivity').mockImplementation(async () => {
        (registry as unknown as { connectivityGraph: typeof mockGraph }).connectivityGraph = mockGraph;
        return mockGraph;
      });

      const events: AssetLoadProgressEvent[] = [];
      await registry.preloadAll((ev) => events.push(ev));
      expect(events.map((e) => e.loadedCount)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(events.every((e) => e.totalCount === 9)).toBe(true);

      const warmLabels: string[] = [];
      registry.warmExtractedBundles((label) => warmLabels.push(label));
      expect(warmLabels.length).toBe(3);
      registry.destroy();
    } finally {
      app.destroy();
    }
  });

  it('CombatAudioEngine.prewarmDspGraph builds the DSP graph without calling ctx.resume() and reuses it on unlock()', async () => {
    const headlessAudio = new CombatAudioEngine({ context: null, autoUnlockOnGesture: false });
    expect(headlessAudio.prewarmDspGraph()).toBe(false);
    headlessAudio.destroy();

    let resumeCount = 0;
    let factoryCount = 0;
    const makeParam = () => ({
      value: 1,
      setValueAtTime: function () { return this; },
      linearRampToValueAtTime: function () { return this; },
      exponentialRampToValueAtTime: function () { return this; },
      setTargetAtTime: function () { return this; },
      cancelScheduledValues: function () { return this; },
    });
    const makeNode = () => ({ connect: (d: unknown) => d, disconnect: () => {} });
    const mockCtx: AudioContextLike = {
      state: 'suspended', currentTime: 0, sampleRate: 22050,
      destination: makeNode() as AudioContextLike['destination'],
      listener: { positionX: makeParam(), positionY: makeParam(), positionZ: makeParam() },
      resume: async () => { resumeCount += 1; (mockCtx as { state: AudioContextState }).state = 'running'; },
      close: async () => {},
      createGain: () => ({ ...makeNode(), gain: makeParam() }),
      createOscillator: () => ({ ...makeNode(), type: 'sine', frequency: makeParam(), detune: makeParam(), start: () => {}, stop: () => {} }),
      createBiquadFilter: () => ({ ...makeNode(), type: 'lowpass', frequency: makeParam(), Q: makeParam(), gain: makeParam() }),
      createBuffer: (ch, len, sr) => ({ sampleRate: sr, length: len, duration: len / sr, numberOfChannels: ch, getChannelData: () => new Float32Array(len) }),
      createBufferSource: () => ({ ...makeNode(), buffer: null, loop: false, playbackRate: makeParam(), start: () => {}, stop: () => {} }),
      createConvolver: () => ({ ...makeNode(), buffer: null, normalize: true }),
      createDynamicsCompressor: () => ({ ...makeNode(), threshold: makeParam(), knee: makeParam(), ratio: makeParam(), attack: makeParam(), release: makeParam() }),
      createPanner: () => ({
        ...makeNode(), panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 1000, rolloffFactor: 1,
        coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0, positionX: makeParam(), positionY: makeParam(), positionZ: makeParam(),
      }),
      createWaveShaper: () => ({ ...makeNode(), curve: null, oversample: 'none' }),
    };

    const audio = new CombatAudioEngine({ contextFactory: () => (factoryCount++, mockCtx), autoUnlockOnGesture: false });
    expect(audio.prewarmDspGraph()).toBe(true);
    expect(factoryCount).toBe(1);
    expect(resumeCount).toBe(0);
    expect(audio.isUnlocked()).toBe(false);
    expect(await audio.unlock()).toBe(true);
    expect(factoryCount).toBe(1);
    expect(resumeCount).toBe(1);
    audio.destroy();
  });

  it('prewarmProceduralTexturesAndMaterials, collectSceneMaterials & compileAllGameShaders handle NullGraphicsDevice gracefully', async () => {
    const { app } = createHeadlessApp();
    try {
      const palette = getOrCreateMaterials();
      const steps: number[] = [];
      const mats = await prewarmProceduralTexturesAndMaterials(app, palette, (_label, done) => { steps.push(done); });
      expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(mats.length).toBeGreaterThan(0);

      const childEntity = new pc.Entity('TestMeshEntity');
      const boxMesh = pc.Mesh.fromGeometry(app.graphicsDevice, new pc.BoxGeometry());
      childEntity.addComponent('render', { meshInstances: [new pc.MeshInstance(boxMesh, palette.targetStandMat)] });
      childEntity.enabled = false;
      app.root.addChild(childEntity);
      expect(collectSceneMaterials(app.root)).toContain(palette.targetStandMat);

      const glbRegistry = new GlbModelRegistry(app);
      const warmup = await compileAllGameShaders({ app, glbRegistry, extraMaterials: mats, yieldFrames: false });
      expect(warmup).toEqual({ compiledMaterials: 0, warmedVariants: 0 });
      glbRegistry.destroy();
    } finally {
      app.destroy();
    }
  });

  it('GhoulXApplication supports deferred autoStart:false + idempotent start(), default autoStart:true, and runGamePreloader 8-phase boot', async () => {
    await initRapierPhysics();
    await withFakeDom({}, async () => {
      const { canvas, app } = createHeadlessApp();
      let deferredApp: GhoulXApplication | null = null;
      try {
        const startSpy = vi.spyOn(app, 'start');
        deferredApp = new GhoulXApplication(canvas, app, new GlbModelRegistry(app), { autoStart: false });
        expect(deferredApp.isStarted).toBe(false);
        expect(startSpy).toHaveBeenCalledTimes(0);
        deferredApp.start();
        deferredApp.start();
        expect(deferredApp.isStarted).toBe(true);
        expect(startSpy).toHaveBeenCalledTimes(1);
      } finally {
        deferredApp?.rapierWorld.destroy();
        app.destroy();
      }

      const setupDefault = createHeadlessApp();
      let defaultApp: GhoulXApplication | null = null;
      try {
        const defaultStartSpy = vi.spyOn(setupDefault.app, 'start');
        defaultApp = new GhoulXApplication(setupDefault.canvas, setupDefault.app, new GlbModelRegistry(setupDefault.app));
        expect(defaultApp.isStarted).toBe(true);
        expect(defaultStartSpy).toHaveBeenCalledTimes(1);
      } finally {
        defaultApp?.rapierWorld.destroy();
        setupDefault.app.destroy();
      }

      const setup2 = createHeadlessApp();
      let bootedApp: GhoulXApplication | null = null;
      try {
        const preloadedRegistry = new GlbModelRegistry(setup2.app);
        vi.spyOn(preloadedRegistry, 'preloadAll').mockImplementation(async (onAssetLoaded) => {
          for (let i = 0; i < ALL_GLB_ASSET_KEYS.length; i++) {
            const key = ALL_GLB_ASSET_KEYS[i];
            onAssetLoaded?.({ assetKey: key, url: `/models/${key}.glb`, loadedCount: i + 1, totalCount: 9 });
          }
          onAssetLoaded?.({ assetKey: 'concrete_wall_connectivity', url: '/models/concrete_wall_connectivity.json', loadedCount: 9, totalCount: 9 });
        });

        const phases: PreloadPhaseId[] = [];
        const progresses: number[] = [];
        let completePayload: { compiledShaders: number; loadedAssets: number } | null = null;
        setup2.app.on('preloader:complete', (p: { compiledShaders: number; loadedAssets: number }) => { completePayload = p; });

        bootedApp = await runGamePreloader({
          canvas: setup2.canvas, app: setup2.app, glbRegistry: preloadedRegistry, yieldFrames: false, dismissDelayMs: 0,
          onProgress: (snap: PreloadProgressSnapshot) => {
            if (phases[phases.length - 1] !== snap.phase) phases.push(snap.phase);
            progresses.push(snap.overallProgress);
          },
        });

        expect(bootedApp.isStarted).toBe(true);
        expect(phases).toEqual([
          'FONTS_AND_DOM', 'WASM_PHYSICS', 'MODELS_AND_GRAPHS', 'PROCEDURAL_TEXTURES',
          'AUDIO_DSP', 'WORLD_COMPOSITION', 'SHADER_COMPILATION', 'READY',
        ]);
        for (let i = 1; i < progresses.length; i++) expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
        expect(progresses[progresses.length - 1]).toBe(1);
        expect(completePayload).not.toBeNull();
      } finally {
        bootedApp?.rapierWorld.destroy();
        setup2.app.destroy();
      }
    });
  });
});
