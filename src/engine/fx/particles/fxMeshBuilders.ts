import * as pc from 'playcanvas';
import { hash2d } from '../math/noiseHelpers.ts';

export function buildLoftedDrumMesh(
  device: pc.GraphicsDevice,
  rings: ReadonlyArray<{ y: number; r: number; v: number }>,
  sides: number,
  crumpleSeed = 0,
): pc.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushTri = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    uv0: [number, number],
    uv1: [number, number],
    uv2: [number, number],
  ): void => {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-8) return;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    const base = positions.length / 3;
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    indices.push(base, base + 1, base + 2);
  };

  const ringPts: Array<Array<[number, number, number]>> = [];
  for (let r = 0; r < rings.length; r++) {
    const spec = rings[r];
    const pts: Array<[number, number, number]> = [];
    for (let s = 0; s <= sides; s++) {
      const idx = s % sides;
      const theta = (idx / sides) * Math.PI * 2;
      let rad = spec.r;
      let yVal = spec.y;
      if (crumpleSeed > 0 && r > 0) {
        const jag = hash2d(idx, r, crumpleSeed);
        rad *= 0.68 + jag * 0.58;
        if (r === rings.length - 1) {
          yVal += (jag - 0.5) * 0.14;
        }
      }
      pts.push([Math.sin(theta) * rad, yVal, Math.cos(theta) * rad]);
    }
    ringPts.push(pts);
  }

  for (let r = 0; r < rings.length - 1; r++) {
    const v0 = rings[r].v;
    const v1 = rings[r + 1].v;
    for (let s = 0; s < sides; s++) {
      const u0 = s / sides;
      const u1 = (s + 1) / sides;
      const p00 = ringPts[r][s];
      const p10 = ringPts[r][s + 1];
      const p11 = ringPts[r + 1][s + 1];
      const p01 = ringPts[r + 1][s];
      pushTri(p00, p10, p11, [u0, v0], [u1, v0], [u1, v1]);
      pushTri(p00, p11, p01, [u0, v0], [u1, v1], [u0, v1]);
    }
  }

  const botY = rings[0].y;
  const topY = rings[rings.length - 1].y;
  const botCenter: [number, number, number] = [0, botY, 0];
  const topCenter: [number, number, number] = [0, crumpleSeed > 0 ? topY * 0.45 : topY, 0];
  for (let s = 0; s < sides; s++) {
    pushTri(botCenter, ringPts[0][s + 1], ringPts[0][s], [0.5, 0.02], [0.55, 0.02], [0.45, 0.02]);
    const last = rings.length - 1;
    pushTri(topCenter, ringPts[last][s], ringPts[last][s + 1], [0.5, 0.98], [0.45, 0.98], [0.55, 0.98]);
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

export function buildCrossedStreakZMesh(device: pc.GraphicsDevice): pc.Mesh {
  const positions = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
    0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5,
  ];
  const normals = [
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  const uvs = [
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

export function buildUnitQuadZMesh(device: pc.GraphicsDevice): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]);
  mesh.setNormals([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  mesh.setUvs(0, [
    0, 0, 1, 0, 1, 1, 0, 1,
  ]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}
