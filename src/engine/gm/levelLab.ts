import * as pc from 'playcanvas';
import { createPreviewStage } from './previewStage.ts';
import { buildStationBlockout } from './stationBlockout.ts';
import './levelLab.css';

export function openLevelLab(): void {
  const root = document.getElementById('app-root');
  if (!root) throw new Error('Missing level preview root');

  const view = document.createElement('main');
  view.className = 'level-lab';
  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'Station Blockout';
  const help = document.createElement('p');
  help.id = 'level-lab-help';
  help.textContent = 'Drag or use arrow keys to orbit. Scroll or press + / − to zoom.';
  header.append(title, help);

  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Station geometry preview');
  canvas.setAttribute('aria-describedby', help.id);
  view.append(header, canvas);
  root.replaceChildren(view);

  const app = new pc.Application(canvas, { graphicsDeviceOptions: { antialias: true } });
  const destroyBlockout = buildStationBlockout(app);
  const destroyPreview = createPreviewStage(app, canvas, {
    center: new pc.Vec3(4, 0, 1),
    distance: 56,
    elevation: 1.04,
    grid: false,
  });
  app.start();

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    destroyPreview();
    destroyBlockout();
    app.destroy();
  });
}
