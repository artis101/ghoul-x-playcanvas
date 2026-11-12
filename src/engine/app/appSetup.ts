import * as pc from 'playcanvas';

const appResizeCleanups = new WeakMap<pc.Application, () => void>();

export function createPlayCanvasApp(canvas: HTMLCanvasElement): pc.Application {
  const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    touch: new pc.TouchDevice(canvas),
    keyboard: new pc.Keyboard(window),
    graphicsDeviceOptions: {
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    },
  });

  app.graphicsDevice.maxPixelRatio = 1;
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.resizeCanvas();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onResize = (): void => {
      app.graphicsDevice.maxPixelRatio = 1;
      app.resizeCanvas();
    };
    window.addEventListener('resize', onResize);
    appResizeCleanups.set(app, () => {
      window.removeEventListener('resize', onResize);
    });
  }

  app.scene.exposure = 1.22;
  app.scene.ambientLight = new pc.Color(0.14, 0.17, 0.22);

  return app;
}

export function unbindPlayCanvasAppResize(app: pc.Application): void {
  const cleanup = appResizeCleanups.get(app);
  if (cleanup) {
    cleanup();
    appResizeCleanups.delete(app);
  }
}
