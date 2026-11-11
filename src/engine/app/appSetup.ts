import * as pc from 'playcanvas';

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

  window.addEventListener('resize', () => {
    app.graphicsDevice.maxPixelRatio = 1;
    app.resizeCanvas();
  });

  app.scene.exposure = 1.22;
  app.scene.ambientLight = new pc.Color(0.14, 0.17, 0.22);

  return app;
}
