import * as pc from 'playcanvas';

export function createPreviewStage(app: pc.Application, canvas: HTMLCanvasElement): () => void {
  const camera = new pc.Entity('Preview Camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color(0.085, 0.108, 0.117),
    fov: 38,
    horizontalFov: false,
  });
  app.root.addChild(camera);
  app.scene.ambientLight = new pc.Color(0.48, 0.5, 0.52);

  addLight('Key', new pc.Color(1, 0.93, 0.82), 1.7, 48, 25);
  addLight('Fill', new pc.Color(0.61, 0.82, 1), 1.1, 32, 212);

  function addLight(name: string, color: pc.Color, intensity: number, pitch: number, yaw: number): void {
    const light = new pc.Entity(name);
    light.addComponent('light', { type: 'directional', color, intensity });
    light.setEulerAngles(pitch, yaw, 0);
    app.root.addChild(light);
  }

  let azimuth = 0.48;
  let elevation = 0.17;
  let distance = 3.75;
  let pointer: number | null = null;
  const aim = new pc.Vec3(0, 0.92, 0);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const grid: pc.Vec3[] = [];
  for (let i = -8; i <= 8; i++) {
    const offset = i * 0.25;
    grid.push(new pc.Vec3(offset, 0, -2), new pc.Vec3(offset, 0, 2));
    grid.push(new pc.Vec3(-2, 0, offset), new pc.Vec3(2, 0, offset));
  }
  const gridColor = new pc.Color(0.19, 0.26, 0.27);
  app.on('update', () => app.drawLines(grid, gridColor));

  function moveCamera(): void {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const radius = distance / Math.min(1, Math.max(0.5, aspect));
    const horizontal = radius * Math.cos(elevation);
    camera.setPosition(
      Math.sin(azimuth) * horizontal,
      aim.y + radius * Math.sin(elevation),
      Math.cos(azimuth) * horizontal
    );
    camera.lookAt(aim);
  }

  const resize = new ResizeObserver(() => {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    app.setCanvasResolution(pc.RESOLUTION_FIXED, canvas.clientWidth, canvas.clientHeight);
    moveCamera();
  });
  resize.observe(canvas);

  canvas.addEventListener('pointerdown', (event) => {
    if (pointer !== null || event.button !== 0) return;
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
  }, options);
  canvas.addEventListener('lostpointercapture', () => { pointer = null; }, options);
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointer) return;
    azimuth -= event.movementX * 0.01;
    elevation = pc.math.clamp(elevation + event.movementY * 0.01, -0.25, 1.25);
    moveCamera();
  }, options);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = pc.math.clamp(distance * Math.exp(event.deltaY * 0.001), 1.3, 8);
    moveCamera();
  }, { ...options, passive: false });
  canvas.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowLeft': azimuth -= 0.15; break;
      case 'ArrowRight': azimuth += 0.15; break;
      case 'ArrowUp': elevation = Math.min(1.25, elevation + 0.1); break;
      case 'ArrowDown': elevation = Math.max(-0.25, elevation - 0.1); break;
      case '+':
      case '=': distance = Math.max(1.3, distance - 0.25); break;
      case '-': distance = Math.min(8, distance + 0.25); break;
      default: return;
    }
    event.preventDefault();
    moveCamera();
  }, options);
  moveCamera();
  return () => {
    controller.abort();
    resize.disconnect();
  };
}
