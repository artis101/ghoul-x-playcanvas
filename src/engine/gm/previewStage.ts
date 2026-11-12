import * as pc from 'playcanvas';

export interface PreviewFraming {
  center: pc.Vec3;
  distance: number;
  elevation: number;
  grid: boolean;
}

export function createPreviewStage(
  app: pc.Application,
  canvas: HTMLCanvasElement,
  framing?: PreviewFraming,
): () => void {
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
  const maxElevation = framing ? 1.56 : 1.25;
  let elevation = framing?.elevation ?? 0.17;
  let distance = framing?.distance ?? 3.75;
  const near = framing ? framing.distance * 0.28 : 1.3;
  const far = framing ? framing.distance * 1.8 : 8;
  const zoomStep = framing ? framing.distance * 0.07 : 0.25;
  let pointer: number | null = null;
  const aim = framing?.center ?? new pc.Vec3(0, 0.92, 0);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const grid: pc.Vec3[] = [];
  for (let i = -8; i <= 8; i++) {
    const offset = i * 0.25;
    grid.push(new pc.Vec3(offset, 0, -2), new pc.Vec3(offset, 0, 2));
    grid.push(new pc.Vec3(-2, 0, offset), new pc.Vec3(2, 0, offset));
  }
  const gridColor = new pc.Color(0.19, 0.26, 0.27);
  if (framing?.grid ?? true) app.on('update', () => app.drawLines(grid, gridColor));

  function moveCamera(): void {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const radius = distance / Math.min(1, Math.max(0.5, aspect));
    const horizontal = radius * Math.cos(elevation);
    camera.setPosition(
      aim.x + Math.sin(azimuth) * horizontal,
      aim.y + radius * Math.sin(elevation),
      aim.z + Math.cos(azimuth) * horizontal
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
    elevation = pc.math.clamp(elevation + event.movementY * 0.01, -0.25, maxElevation);
    moveCamera();
  }, options);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = pc.math.clamp(distance * Math.exp(event.deltaY * 0.001), near, far);
    moveCamera();
  }, { ...options, passive: false });
  canvas.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowLeft': azimuth -= 0.15; break;
      case 'ArrowRight': azimuth += 0.15; break;
      case 'ArrowUp': elevation = Math.min(maxElevation, elevation + 0.1); break;
      case 'ArrowDown': elevation = Math.max(-0.25, elevation - 0.1); break;
      case '+':
      case '=': distance = Math.max(near, distance - zoomStep); break;
      case '-': distance = Math.min(far, distance + zoomStep); break;
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
