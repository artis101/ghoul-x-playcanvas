import * as pc from 'playcanvas';

export function buildFloorQuadMesh(device: pc.GraphicsDevice): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions([
    -0.5, 0, -0.5,
    -0.5, 0, 0.5,
    0.5, 0, 0.5,
    0.5, 0, -0.5,
  ]);
  mesh.setNormals([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  mesh.setUvs(0, [
    0, 0,
    0, 1,
    1, 1,
    1, 0,
  ]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  mesh.incRefCount();
  return mesh;
}
