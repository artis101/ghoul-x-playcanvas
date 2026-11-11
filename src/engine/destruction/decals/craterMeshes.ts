import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';

export function createTangentDecalQuadMesh(device: pc.GraphicsDevice): pc.Mesh {
  const positions = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.5,  0.5, 0,
    -0.5,  0.5, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const tangents = new Float32Array([
    1, 0, 0, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
    1, 0, 0, 1,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setVertexStream(pc.SEMANTIC_TANGENT, tangents, 4);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

export function createConcreteChipMesh(device: pc.GraphicsDevice): pc.Mesh {
  const pTop = [0.02, 0.52, -0.04];
  const pBot = [-0.03, -0.46, 0.05];
  const p0 = [-0.48, 0.04, 0.42];
  const p1 = [0.52, -0.06, 0.34];
  const p2 = [0.36, 0.08, -0.48];
  const p3 = [-0.42, -0.05, -0.44];

  const faces = [
    [pTop, p0, p1],
    [pTop, p1, p2],
    [pTop, p2, p3],
    [pTop, p3, p0],
    [pBot, p1, p0],
    [pBot, p2, p1],
    [pBot, p3, p2],
    [pBot, p0, p3],
  ];

  const faceCount = faces.length;
  const positions = new Float32Array(faceCount * 9);
  const normals = new Float32Array(faceCount * 9);
  const indices = new Uint16Array(faceCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const [a, b, c] = faces[f];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const tri = [a, b, c];
    for (let v = 0; v < 3; v++) {
      const idx = f * 3 + v;
      positions[idx * 3] = tri[v][0];
      positions[idx * 3 + 1] = tri[v][1];
      positions[idx * 3 + 2] = tri[v][2];
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
      indices[idx] = idx;
    }
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

export function quatFromPlusZToNormalWithRoll(normal: Vec3Like, rollRad: number): QuatLike {
  const nLen = Math.hypot(normal.x, normal.y, normal.z);
  const nx = nLen > 1e-6 ? normal.x / nLen : 0;
  const ny = nLen > 1e-6 ? normal.y / nLen : 0;
  const nz = nLen > 1e-6 ? normal.z / nLen : 1;

  let ax: number;
  let ay: number;
  let az: number;
  let aw: number;

  if (nz < -0.9999) {
    ax = 0;
    ay = 1;
    az = 0;
    aw = 0;
  } else {
    ax = -ny;
    ay = nx;
    az = 0;
    aw = 1 + nz;
    const qLen = Math.hypot(ax, ay, az, aw);
    ax /= qLen;
    ay /= qLen;
    az /= qLen;
    aw /= qLen;
  }

  const halfRoll = rollRad * 0.5;
  const rz = Math.sin(halfRoll);
  const rw = Math.cos(halfRoll);

  return {
    x: aw * 0 + ax * rw + ay * rz - az * 0,
    y: aw * 0 - ax * rz + ay * rw + az * 0,
    z: aw * rz + ax * 0 - ay * 0 + az * rw,
    w: aw * rw - ax * 0 - ay * 0 - az * rz,
  };
}
