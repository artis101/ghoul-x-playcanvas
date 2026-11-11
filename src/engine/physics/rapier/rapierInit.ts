import * as RAPIER from '@dimforge/rapier3d-compat';

let rapierInitPromise: Promise<typeof RAPIER> | null = null;
let rapierInitialized = false;

export function isRapierInitialized(): boolean {
  return rapierInitialized;
}

/**
 * Idempotently initializes the embedded Rapier3D WASM physics backend.
 */
export async function initRapierPhysics(): Promise<typeof RAPIER> {
  if (rapierInitialized) {
    return RAPIER;
  }
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init().then(() => {
      rapierInitialized = true;
      return RAPIER;
    });
  }
  return rapierInitPromise;
}
