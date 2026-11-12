import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { InternalAudioGraph } from '../../core/audio/audioGraph.ts';

export type AudioRuntimeState =
  | {
      readonly kind: 'UNINITIALIZED';
      gestureCleanup: (() => void) | null;
    }
  | {
      readonly kind: 'SUSPENDED';
      readonly graph: InternalAudioGraph;
      unlockInFlight: Promise<boolean> | null;
      gestureCleanup: (() => void) | null;
    }
  | {
      readonly kind: 'RUNNING';
      readonly graph: InternalAudioGraph;
    }
  | {
      readonly kind: 'UNAVAILABLE';
    }
  | {
      readonly kind: 'DESTROYED';
    };

export function createInitialAudioRuntimeState(
  initialGraph: InternalAudioGraph | null,
  hasExplicitNullContext: boolean,
  gestureCleanup: (() => void) | null,
): AudioRuntimeState {
  if (hasExplicitNullContext) {
    gestureCleanup?.();
    return { kind: 'UNAVAILABLE' };
  }
  if (!initialGraph) {
    return { kind: 'UNINITIALIZED', gestureCleanup };
  }
  if (initialGraph.ctx.state === 'running') {
    gestureCleanup?.();
    return { kind: 'RUNNING', graph: initialGraph };
  }
  return {
    kind: 'SUSPENDED',
    graph: initialGraph,
    unlockInFlight: null,
    gestureCleanup,
  };
}

function invokeAndClearGestureCleanup(state: AudioRuntimeState): void {
  if ((state.kind === 'UNINITIALIZED' || state.kind === 'SUSPENDED') && state.gestureCleanup) {
    const cleanup = state.gestureCleanup;
    state.gestureCleanup = null;
    cleanup();
  }
}

export function transitionAudioRuntimeState(
  current: AudioRuntimeState,
  next: AudioRuntimeState,
): AudioRuntimeState {
  if (current.kind === 'DESTROYED') {
    if (next.kind === 'UNINITIALIZED' || next.kind === 'SUSPENDED') {
      invokeAndClearGestureCleanup(next);
    }
    return current;
  }

  if (next.kind === 'RUNNING' || next.kind === 'UNAVAILABLE' || next.kind === 'DESTROYED') {
    invokeAndClearGestureCleanup(current);
  }

  if (next.kind === 'DESTROYED') {
    const graph = getAudioRuntimeGraph(current);
    if (graph) {
      try {
        void graph.ctx.close();
      } catch {
        // Ignore close errors on mock or already-closed contexts
      }
    }
  }

  return next;
}

export function getAudioRuntimeGraph(state: AudioRuntimeState): InternalAudioGraph | null {
  return state.kind === 'SUSPENDED' || state.kind === 'RUNNING' ? state.graph : null;
}

export function syncAudioRuntimeWithContextState(state: AudioRuntimeState): AudioRuntimeState {
  if (state.kind === 'SUSPENDED' && state.graph.ctx.state === 'running') {
    return transitionAudioRuntimeState(state, { kind: 'RUNNING', graph: state.graph });
  }
  return state;
}

export function materializeAudioGraph(
  getState: () => AudioRuntimeState,
  setState: (next: AudioRuntimeState) => void,
  contextFactory: () => InternalAudioGraph | null,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  listenerPitchDeg: number,
  onGraphCreated?: (graph: InternalAudioGraph) => void,
): InternalAudioGraph | null {
  let state = syncAudioRuntimeWithContextState(getState());
  setState(state);
  if (state.kind === 'DESTROYED' || state.kind === 'UNAVAILABLE') return null;
  const existing = getAudioRuntimeGraph(state);
  if (existing) return existing;

  let created: InternalAudioGraph | null = null;
  try {
    created = contextFactory();
  } catch {
    created = null;
  }
  if (!created) {
    setState(transitionAudioRuntimeState(state, { kind: 'UNAVAILABLE' }));
    return null;
  }

  created.updateListener(listenerPos, listenerYawDeg, listenerPitchDeg);
  if (created.ctx.state === 'running') {
    setState(transitionAudioRuntimeState(state, { kind: 'RUNNING', graph: created }));
  } else {
    const gestureCleanup = state.kind === 'UNINITIALIZED' ? state.gestureCleanup : null;
    setState(
      transitionAudioRuntimeState(state, {
        kind: 'SUSPENDED',
        graph: created,
        unlockInFlight: null,
        gestureCleanup,
      }),
    );
  }
  onGraphCreated?.(created);
  return created;
}

export function unlockAudioRuntime(
  getState: () => AudioRuntimeState,
  setState: (next: AudioRuntimeState) => void,
  graph: InternalAudioGraph | null,
): Promise<boolean> {
  const state = getState();
  if (!graph || state.kind === 'DESTROYED' || state.kind === 'UNAVAILABLE') {
    return Promise.resolve(false);
  }
  if (state.kind === 'RUNNING' || graph.ctx.state === 'running') {
    setState(transitionAudioRuntimeState(state, { kind: 'RUNNING', graph }));
    return Promise.resolve(true);
  }
  if (state.kind !== 'SUSPENDED') {
    return Promise.resolve(false);
  }
  if (state.unlockInFlight) {
    return state.unlockInFlight;
  }

  let unlockPromise: Promise<boolean> | null = null;
  unlockPromise = (async (): Promise<boolean> => {
    try {
      await state.graph.ctx.resume();
    } catch {
      const cur = getState();
      if (cur.kind === 'SUSPENDED' && cur.unlockInFlight === unlockPromise) {
        cur.unlockInFlight = null;
      }
      return false;
    }
    const cur = getState();
    if (cur.kind === 'DESTROYED') return false;
    if (state.graph.ctx.state === 'running') {
      setState(transitionAudioRuntimeState(cur, { kind: 'RUNNING', graph: state.graph }));
      return true;
    }
    if (cur.kind === 'SUSPENDED' && cur.unlockInFlight === unlockPromise) {
      cur.unlockInFlight = null;
    }
    return false;
  })();

  state.unlockInFlight = unlockPromise;
  return unlockPromise;
}
