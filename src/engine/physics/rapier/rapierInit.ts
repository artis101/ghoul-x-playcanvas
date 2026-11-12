import * as RAPIER from '@dimforge/rapier3d-compat';

export type RapierBootState =
  | { readonly kind: 'UNINITIALIZED' }
  | { readonly kind: 'INITIALIZING'; readonly promise: Promise<typeof RAPIER> }
  | { readonly kind: 'READY'; readonly rapier: typeof RAPIER };

let rapierBootState: RapierBootState = { kind: 'UNINITIALIZED' };

export function getRapierBootState(): RapierBootState {
  return rapierBootState;
}

export function isRapierInitialized(): boolean {
  return rapierBootState.kind === 'READY';
}

/**
 * Idempotently initializes the embedded Rapier3D WASM physics backend.
 */
export async function initRapierPhysics(): Promise<typeof RAPIER> {
  if (rapierBootState.kind === 'READY') {
    return rapierBootState.rapier;
  }
  if (rapierBootState.kind === 'INITIALIZING') {
    return rapierBootState.promise;
  }
  const promise = RAPIER.init().then(
    () => {
      rapierBootState = { kind: 'READY', rapier: RAPIER };
      return RAPIER;
    },
    (err: unknown) => {
      rapierBootState = { kind: 'UNINITIALIZED' };
      throw err;
    },
  );
  rapierBootState = { kind: 'INITIALIZING', promise };
  return promise;
}
