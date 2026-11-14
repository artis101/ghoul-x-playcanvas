import { GhoulXApplication } from './engine/app/ghoulXApp.ts';
import { getDevFlags, isDevBuild } from './engine/dev/devFlags.ts';
import { getDevRuntime, type DevRuntime } from './engine/dev/devRuntime.ts';
import {
  PreloaderScreen,
  runGamePreloader,
  type BootTimingReport,
  type GamePreloaderOptions,
} from './engine/preloader/index.ts';

export { GhoulXApplication, PreloaderScreen, runGamePreloader, type GamePreloaderOptions };

interface GhoulXDevWindow {
  __ghoulx?: { readonly app: GhoulXApplication; readonly dev: DevRuntime };
}

function fastBootDefaults(): Partial<GamePreloaderOptions> {
  if (!getDevFlags().fast) return {};
  return { yieldFrames: false, dismissDelayMs: 0, skipFontWait: true, awaitDismissFade: false };
}

export async function bootstrap(
  options: GamePreloaderOptions = {}
): Promise<GhoulXApplication> {
  const preloaderScreen = options.preloaderScreen ?? new PreloaderScreen();
  let bootReport: BootTimingReport | null = null;
  const ghoulApp = await runGamePreloader({
    ...fastBootDefaults(),
    ...options,
    preloaderScreen,
    onBootTimings: (report) => {
      bootReport = report;
      options.onBootTimings?.(report);
    },
  });
  const dev = getDevRuntime(ghoulApp);
  dev.bootTimings = bootReport;
  if (isDevBuild() && typeof window !== 'undefined') {
    (window as unknown as GhoulXDevWindow).__ghoulx = { app: ghoulApp, dev };
  }
  return ghoulApp;
}
