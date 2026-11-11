import type { AudioBufferLike, AudioContextLike } from '../../core/audio/contracts.ts';
import { createInternalAudioGraph, type InternalAudioGraph } from '../../core/audio/audioGraph.ts';
import type { CombatAudioEngineOptions } from '../../core/audio/types.ts';

interface WindowWithWebkitAudio {
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
}

export function resolveBrowserAudioContextCtor(): (new () => AudioContext) | null {
  const scope = globalThis as unknown as WindowWithWebkitAudio;
  if (typeof scope.AudioContext === 'function') return scope.AudioContext;
  if (typeof scope.webkitAudioContext === 'function') return scope.webkitAudioContext;
  if (typeof window !== 'undefined') {
    const win = window as unknown as WindowWithWebkitAudio;
    if (typeof win.AudioContext === 'function') return win.AudioContext;
    if (typeof win.webkitAudioContext === 'function') return win.webkitAudioContext;
  }
  return null;
}

export function bindGestureUnlock(onUnlock: () => void): (() => void) | null {
  const target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      ? window
      : typeof document !== 'undefined' && typeof document.addEventListener === 'function'
        ? document
        : null;
  if (!target) return null;

  const onUserGesture = (): void => {
    onUnlock();
  };

  target.addEventListener('mousedown', onUserGesture, { passive: true });
  target.addEventListener('keydown', onUserGesture, { passive: true });
  return (): void => {
    target.removeEventListener('mousedown', onUserGesture);
    target.removeEventListener('keydown', onUserGesture);
  };
}

export function createGraphFactory(
  options: CombatAudioEngineOptions,
  masterVolume: number,
  reverbWetMix: number,
  rng: () => number,
): () => InternalAudioGraph | null {
  if (options.context !== undefined) {
    const p = options.context;
    return p ? () => createInternalAudioGraph(p, masterVolume, reverbWetMix, rng) : () => null;
  }
  if (options.contextFactory) {
    const f = options.contextFactory;
    return () => {
      const created = f();
      return created ? createInternalAudioGraph(created, masterVolume, reverbWetMix, rng) : null;
    };
  }
  return () => {
    const Ctor = resolveBrowserAudioContextCtor();
    if (!Ctor) return null;
    try {
      const domCtx = new Ctor();
      return createInternalAudioGraph<AudioBuffer>(domCtx, masterVolume, reverbWetMix, rng);
    } catch {
      return null;
    }
  };
}
