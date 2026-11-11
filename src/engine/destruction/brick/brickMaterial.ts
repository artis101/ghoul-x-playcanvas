import * as pc from 'playcanvas';

/**
 * Generates a 24-vertex flat-normal chamfered/beveled unit brick `pc.Mesh` (`[-0.5, +0.5]^3`)
 * with subtle per-variant edge wear and UV jitter so all bricks render in 3 instanced draw calls.
 */
export function createBeveledBrickMeshVariant(
  device: pc.GraphicsDevice,
  variantIndex: number
): pc.Mesh {
  const bevel = 0.055 + (variantIndex % 3) * 0.018;
  const skew = (variantIndex - 1) * 0.014;
  const uvShiftU = (variantIndex % 3) * 0.29;
  const uvShiftV = (variantIndex % 3) * 0.17;

  // 8 slightly chamfered corners of unit cube [-0.5, +0.5]^3
  const hx = 0.5;
  const hy = 0.5;
  const hz = 0.5;
  const bx = hx - bevel * 0.45;
  const by = hy - bevel * 0.7;
  const bz = hz - bevel * 0.55;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushQuad = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number]
  ): void => {
    const abx = p1[0] - p0[0];
    const aby = p1[1] - p0[1];
    const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0];
    const acy = p2[1] - p0[1];
    const acz = p2[2] - p0[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    const baseV = positions.length / 3;
    const verts = [p0, p1, p2, p3];
    const quadUvs: [number, number][] = [
      [0 + uvShiftU, 0 + uvShiftV],
      [1 + uvShiftU, 0 + uvShiftV],
      [1 + uvShiftU, 1 + uvShiftV],
      [0 + uvShiftU, 1 + uvShiftV],
    ];

    for (let i = 0; i < 4; i++) {
      positions.push(verts[i][0], verts[i][1], verts[i][2]);
      normals.push(nx, ny, nz);
      uvs.push(quadUvs[i][0], quadUvs[i][1]);
    }

    indices.push(baseV, baseV + 1, baseV + 2, baseV, baseV + 2, baseV + 3);
  };

  // Front (+Z) inset face
  pushQuad([-bx + skew, -by, hz], [bx, -by, hz], [bx - skew, by, hz], [-bx, by, hz]);
  // Back (-Z) inset face
  pushQuad([bx, -by, -hz], [-bx - skew, -by, -hz], [-bx, by, -hz], [bx + skew, by, -hz]);
  // Top (+Y) inset face
  pushQuad([-bx, hy, bz], [bx, hy, bz], [bx, hy, -bz], [-bx, hy, -bz]);
  // Bottom (-Y) inset face
  pushQuad([-bx, -hy, -bz], [bx, -hy, -bz], [bx, -hy, bz], [-bx, -hy, bz]);
  // Right (+X) full cap
  pushQuad([hx, -by, bz], [hx, -by, -bz], [hx, by, -bz], [hx, by, bz]);
  // Left (-X) full cap
  pushQuad([-hx, -by, -bz], [-hx, -by, bz], [-hx, by, bz], [-hx, by, -bz]);

  // 4 top/bottom Z-chamfer bevel strips for specular edge catchlights
  pushQuad([-bx, by, hz], [bx - skew, by, hz], [bx, hy, bz], [-bx, hy, bz]);
  pushQuad([bx + skew, by, -hz], [-bx, by, -hz], [-bx, hy, -bz], [bx, hy, -bz]);
  pushQuad([-bx, -hy, bz], [bx, -hy, bz], [bx, -by, hz], [-bx + skew, -by, hz]);
  pushQuad([bx, -hy, -bz], [-bx, -hy, -bz], [-bx - skew, -by, -hz], [bx, -by, -hz]);

  // 4 side X-chamfer bevel strips
  pushQuad([bx, -by, hz], [hx, -by, bz], [hx, by, bz], [bx - skew, by, hz]);
  pushQuad([hx, -by, -bz], [bx, -by, -hz], [bx + skew, by, -hz], [hx, by, -bz]);
  pushQuad([-hx, -by, bz], [-bx + skew, -by, hz], [-bx, by, hz], [-hx, by, bz]);
  pushQuad([-bx - skew, -by, -hz], [-hx, -by, -bz], [-hx, by, -bz], [-bx, by, -hz]);

  const mesh = new pc.Mesh(device);
  mesh.setPositions(new Float32Array(positions));
  mesh.setNormals(new Float32Array(normals));
  mesh.setUvs(0, new Float32Array(uvs));
  mesh.setIndices(new Uint16Array(indices));
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

export function createProceduralBrickMaterial(device: pc.GraphicsDevice): {
  material: pc.StandardMaterial;
  diffuseTexture: pc.Texture;
} {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = (Math.imul(x + 11, 374761393) + Math.imul(y + 23, 668265263)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const noise = ((h ^ (h >>> 16)) >>> 0) / 4294967295;

      const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y) / 6;
      const mortarRim = Math.max(0, 1 - Math.min(1, edgeDist));

      // Terracotta clay base blended with pale lime-mortar dust at edges
      const r = Math.round((158 + (noise - 0.5) * 34) * (1 - mortarRim * 0.35) + mortarRim * 62);
      const g = Math.round((72 + (noise - 0.5) * 22) * (1 - mortarRim * 0.35) + mortarRim * 58);
      const b = Math.round((54 + (noise - 0.5) * 18) * (1 - mortarRim * 0.35) + mortarRim * 54);

      const p4 = (y * size + x) * 4;
      pixels[p4] = Math.max(0, Math.min(255, r));
      pixels[p4 + 1] = Math.max(0, Math.min(255, g));
      pixels[p4 + 2] = Math.max(0, Math.min(255, b));
      pixels[p4 + 3] = 255;
    }
  }

  const tex = new pc.Texture(device, {
    name: 'TerracottaBrickAlbedo',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  tex.lock().set(pixels);
  tex.unlock();

  const material = new pc.StandardMaterial();
  material.name = 'InstancedClayBrickMaterial';
  material.diffuse = new pc.Color(0.95, 0.92, 0.9);
  material.diffuseMap = tex;
  material.gloss = 0.24;
  material.update();

  return { material, diffuseTexture: tex };
}
