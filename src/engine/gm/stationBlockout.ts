import * as pc from 'playcanvas';

type Box = [x: number, y: number, z: number, width: number, height: number, depth: number];

// Dimensions in meters. The west concourse splits into a wide south route
// and a narrow north service route. Both converge on the east platform.
const floors: Box[] = [
  [-14, -0.2, 0, 8, 0.4, 5],
  [-6, -0.2, 0, 8, 0.4, 13],
  [4, -0.2, -4.75, 12, 0.4, 3.5],
  [4, -0.2, 3.5, 12, 0.4, 6],
  [15, -0.2, 0, 10, 0.4, 13],
  [15, -0.65, 8.5, 10, 0.4, 4],
  [23, -0.2, -3, 6, 0.4, 3.5],
];

const walls: Box[] = [
  [-14, 1.3, -2.65, 8, 2.6, 0.3],
  [-14, 1.3, 2.65, 8, 2.6, 0.3],
  [-10.15, 1.3, -4.65, 0.3, 2.6, 3.7],
  [-10.15, 1.3, 4.65, 0.3, 2.6, 3.7],
  [5, 1.3, -6.65, 30, 2.6, 0.3],
  [5, 1.3, 6.65, 30, 2.6, 0.3],
  [4, 1.3, -1.25, 12, 2.6, 3.5],
  [20.15, 1.3, -5.7, 0.3, 2.6, 1.9],
  [20.15, 1.3, 0.9, 0.3, 2.6, 11.2],
  [23, 1.3, -4.9, 6, 2.6, 0.3],
  [23, 1.3, -1.1, 6, 2.6, 0.3],
];

const partitions: Box[] = [
  [-5.5, 0.75, -2, 0.6, 1.5, 3],
  [1, 0.55, 2.3, 2.5, 1.1, 0.6],
  [7, 0.55, 4.6, 2.5, 1.1, 0.6],
  [13, 0.85, -0.7, 1.3, 1.7, 2.5],
  [17, 0.85, 2.8, 1.3, 1.7, 2.5],
];

export function buildStationBlockout(app: pc.Application): () => void {
  const stage = new pc.Entity('Station blockout');
  app.root.addChild(stage);
  const materials: pc.StandardMaterial[] = [];

  addBoxes('Floor', floors, new pc.Color(0.38, 0.46, 0.5));
  addBoxes('Wall', walls, new pc.Color(0.58, 0.66, 0.69));
  addBoxes('Partition', partitions, new pc.Color(0.84, 0.52, 0.25));
  addBoxes('Platform edge', [[15, 0.015, 6.25, 10, 0.03, 0.18]], new pc.Color(0.92, 0.68, 0.24));
  addBoxes('Rails', [
    [15, -0.36, 8, 10, 0.12, 0.1],
    [15, -0.36, 9.3, 10, 0.12, 0.1],
  ], new pc.Color(0.13, 0.19, 0.22));

  function addBoxes(name: string, boxes: Box[], color: pc.Color): void {
    const material = new pc.StandardMaterial();
    material.diffuse.copy(color);
    material.update();
    materials.push(material);
    for (const [x, y, z, width, height, depth] of boxes) {
      const entity = new pc.Entity(name);
      entity.addComponent('render', { type: 'box', material });
      entity.setLocalPosition(x, y, z);
      entity.setLocalScale(width, height, depth);
      stage.addChild(entity);
    }
  }

  return () => {
    stage.destroy();
    for (const material of materials) material.destroy();
  };
}
