import { GhoulXApplication } from './engine/app/ghoulXApp.ts';
import {
  PreloaderScreen,
  runGamePreloader,
  type GamePreloaderOptions,
} from './engine/preloader/index.ts';

export { GhoulXApplication, PreloaderScreen, runGamePreloader, type GamePreloaderOptions };

export async function bootstrap(
  options: GamePreloaderOptions = {}
): Promise<GhoulXApplication> {
  const preloaderScreen = options.preloaderScreen ?? new PreloaderScreen();
  return runGamePreloader({
    ...options,
    preloaderScreen,
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    void bootstrap().catch((err: unknown) => {
      console.error('GHOUL-X bootstrap failed:', err);
    });
  });
}
