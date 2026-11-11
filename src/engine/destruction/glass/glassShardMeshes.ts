import * as pc from 'playcanvas';
import { extrudeConvexShard2D } from '../../../core/destruction/glassVoronoiShatter.ts';

export function createCrystallineTriangleShardMesh(device: pc.GraphicsDevice): pc.Mesh {
  const hz = 0.08;
  const p0x = -0.5;
  const p0y = -0.36;
  const p1x = 0.56;
  const p1y = -0.22;
  const p2x = -0.06;
  const p2y = 0.58;

  const positions = new Float32Array([
    p0x, p0y, hz,
    p1x, p1y, hz,
    p2x, p2y, hz,
    p0x, p0y, -hz,
    p2x, p2y, -hz,
    p1x, p1y, -hz,
    p0x, p0y, hz,
    p1x, p1y, -hz,
    p1x, p1y, hz,
    p0x, p0y, hz,
    p0x, p0y, -hz,
    p1x, p1y, -hz,
    p1x, p1y, hz,
    p2x, p2y, -hz,
    p2x, p2y, hz,
    p1x, p1y, hz,
    p1x, p1y, -hz,
    p2x, p2y, -hz,
    p2x, p2y, hz,
    p0x, p0y, -hz,
    p0x, p0y, hz,
    p2x, p2y, hz,
    p2x, p2y, -hz,
    p0x, p0y, -hz,
  ]);

  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1,
    0.13, -0.99, 0, 0.13, -0.99, 0, 0.13, -0.99, 0,
    0.13, -0.99, 0, 0.13, -0.99, 0, 0.13, -0.99, 0,
    0.79, 0.61, 0, 0.79, 0.61, 0, 0.79, 0.61, 0,
    0.79, 0.61, 0, 0.79, 0.61, 0, 0.79, 0.61, 0,
    -0.91, 0.41, 0, -0.91, 0.41, 0, -0.91, 0.41, 0,
    -0.91, 0.41, 0, -0.91, 0.41, 0, -0.91, 0.41, 0,
  ]);

  const indices = new Uint16Array(24);
  for (let i = 0; i < 24; i++) indices[i] = i;

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions, 3, 24);
  mesh.setNormals(normals, 3, 24);
  mesh.setIndices(indices, 24);
  mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  return mesh;
}

export function createIntactWindowPanePrismMesh(
  device: pc.GraphicsDevice,
  widthM: number,
  heightM: number,
  thicknessM: number,
): pc.Mesh {
  const rectPoly = [
    { x: 0, y: 0 },
    { x: widthM, y: 0 },
    { x: widthM, y: heightM },
    { x: 0, y: heightM },
  ];
  const ext = extrudeConvexShard2D(
    rectPoly,
    { x: widthM * 0.5, y: heightM * 0.5 },
    widthM,
    heightM,
    thicknessM,
  );

  const colors = new Float32Array(ext.vertexCount * 4);
  for (let v = 0; v < ext.vertexCount; v++) {
    const lnz = ext.localNormals[v * 3 + 2];
    const isRim = Math.abs(lnz) < 0.5;
    const c4 = v * 4;
    colors[c4] = isRim ? 0.52 : 0.76;
    colors[c4 + 1] = isRim ? 0.74 : 0.93;
    colors[c4 + 2] = isRim ? 0.80 : 0.99;
    colors[c4 + 3] = isRim ? 0.72 : 0.42;
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(ext.localPositions, 3, ext.vertexCount);
  mesh.setNormals(ext.localNormals, 3, ext.vertexCount);
  mesh.setUvs(0, ext.localUvs, 2, ext.vertexCount);
  mesh.setColors(colors, 4, ext.vertexCount);
  mesh.setIndices(ext.localIndices, ext.indexCount);
  mesh.update(pc.PRIMITIVE_TRIANGLES, true);
  return mesh;
}
