import * as pc from 'playcanvas';

export function createProceduralSplinterMeshes(device: pc.GraphicsDevice): pc.Mesh[] {
  const variants: Array<{
    tipSkewY: number;
    tipSkewZ: number;
    midBulgeY: number;
    midBulgeZ: number;
  }> = [
    { tipSkewY: 0.16, tipSkewZ: -0.12, midBulgeY: 0.52, midBulgeZ: 0.44 },
    { tipSkewY: -0.22, tipSkewZ: 0.18, midBulgeY: 0.42, midBulgeZ: 0.58 },
    { tipSkewY: 0.08, tipSkewZ: 0.24, midBulgeY: 0.62, midBulgeZ: 0.36 },
  ];

  const meshes: pc.Mesh[] = [];

  for (let vIdx = 0; vIdx < variants.length; vIdx++) {
    const v = variants[vIdx];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const emitTri = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
    ): void => {
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];

      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) return;
      nx /= len;
      ny /= len;
      nz /= len;

      const base = positions.length / 3;
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uvs.push(a[0] + 0.5, 0.90, b[0] + 0.5, 0.95, c[0] + 0.5, 0.98);
      indices.push(base, base + 1, base + 2);
    };

    const tailTip: [number, number, number] = [-0.5, -v.tipSkewY, -v.tipSkewZ];
    const headTip: [number, number, number] = [0.5, v.tipSkewY, v.tipSkewZ];
    const mTop: [number, number, number] = [-0.06, v.midBulgeY, 0.05];
    const mRight: [number, number, number] = [0.04, -v.midBulgeY * 0.65, v.midBulgeZ];
    const mLeft: [number, number, number] = [0.02, -v.midBulgeY * 0.55, -v.midBulgeZ];

    emitTri(mTop, mRight, headTip);
    emitTri(mRight, mLeft, headTip);
    emitTri(mLeft, mTop, headTip);

    emitTri(mRight, mTop, tailTip);
    emitTri(mLeft, mRight, tailTip);
    emitTri(mTop, mLeft, tailTip);

    const mesh = new pc.Mesh(device);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setUvs(0, uvs);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_TRIANGLES, true);
    mesh.incRefCount();
    meshes.push(mesh);
  }

  return meshes;
}
