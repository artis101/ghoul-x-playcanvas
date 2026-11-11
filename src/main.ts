import { initRapierPhysics } from './engine/physics/rapierWorld.ts';
import { GlbModelRegistry } from './engine/assets/glbLoader.ts';
import { createPlayCanvasApp } from './engine/app/appSetup.ts';
import { GhoulXApplication } from './engine/app/ghoulXApp.ts';

export { GhoulXApplication };

export async function bootstrap(): Promise<GhoulXApplication> {
  await initRapierPhysics();

  const canvasEl = document.getElementById('playcanvas-viewport');
  if (!(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error('Canvas #playcanvas-viewport not found in document!');
  }

  const app = createPlayCanvasApp(canvasEl);
  const glbRegistry = new GlbModelRegistry(app);

  try {
    await glbRegistry.preloadAll();
  } catch (err: unknown) {
    console.warn('GLB asset preloading encountered an error, falling back:', err);
  }

  return new GhoulXApplication(canvasEl, app, glbRegistry);
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
