import * as pc from 'playcanvas';

function hash2d(x: number, y: number, seed: number): number {
  let h = (Math.imul(x + 11, 374761393) + Math.imul(y + 23, 668265263) + Math.imul(seed, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(u: number, v: number, freqU: number, freqV: number, seed: number): number {
  const x = u * freqU;
  const y = v * freqV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const ix0 = ((x0 % freqU) + freqU) % freqU;
  const ix1 = (ix0 + 1) % freqU;
  const iy0 = ((y0 % freqV) + freqV) % freqV;
  const iy1 = (iy0 + 1) % freqV;

  const n00 = hash2d(ix0, iy0, seed);
  const n10 = hash2d(ix1, iy0, seed);
  const n01 = hash2d(ix0, iy1, seed);
  const n11 = hash2d(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Generates a fallback unit broken-brick debris `pc.Mesh` for headless NullGraphicsDevice tests
 * when `debris_pack.glb` is not loaded. Runtime arena uses `debris_pack.glb` `Brick_0..2`.
 */
export function createBeveledBrickMeshVariant(
  device: pc.GraphicsDevice,
  variantIndex: number
): pc.Mesh {
  const scale = 0.94 + (variantIndex % 3) * 0.03;
  return pc.Mesh.fromGeometry(
    device,
    new pc.BoxGeometry({ halfExtents: new pc.Vec3(0.5 * scale, 0.5, 0.5 * scale) })
  );
}

/**
 * Synthesizes a 256x256 3-Band PBR Masonry Brick & Lime-Mortar Atlas + Normal Map:
 * - Band 1 (`v in [0.00..0.50]`): Flush kiln-fired terracotta brick framed by recessed sandy lime-mortar joints
 * - Band 2 (`v in [0.50..0.78]`): Spalled, gouged, fracture-cracked brick core with pulverized mortar dust
 * - Band 3 (`v in [0.78..1.00]`): Rough mortar bed & broken brick cross-section for 3D punched hole rims
 */
export function createProceduralBrickMaterial(device: pc.GraphicsDevice): {
  material: pc.StandardMaterial;
  diffuseTexture: pc.Texture;
  normalTexture: pc.Texture;
} {
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const coarse = valueNoise(u, v, 8, 8, 101);
      const fine = valueNoise(u, v, 28, 28, 211);
      const grain = hash2d(x, y, 307);

      let r: number;
      let g: number;
      let b: number;
      let h: number;

      if (v < 0.50) {
        // Band 1: Intact Brick + Recessed Mortar Joint Border
        const bv = (v - 0.03) / 0.44;
        const distU = Math.min(u, 1 - u);
        const distV = Math.min(Math.max(0, bv), Math.max(0, 1 - bv));
        // Uniform ~9mm mortar joints along head (U) and bed (V) courses
        const mortarMaskU = 1 - Math.min(1, Math.max(0, (distU - 0.020) / 0.014));
        const mortarMaskV = 1 - Math.min(1, Math.max(0, (distV - 0.055) / 0.032));
        const mortar = Math.max(mortarMaskU, mortarMaskV);

        const wireCut = valueNoise(u, v, 48, 8, 401);
        const clayPit = Math.max(0, (grain - 0.78) / 0.22);

        const brickR = 176 + (coarse - 0.5) * 28 + (fine - 0.5) * 18 - clayPit * 28;
        const brickG = 78 + (coarse - 0.5) * 16 + (fine - 0.5) * 11 - clayPit * 14;
        const brickB = 54 + (coarse - 0.5) * 12 + (fine - 0.5) * 9 - clayPit * 10;

        const mortarR = 166 + (fine - 0.5) * 20 + (grain - 0.5) * 16;
        const mortarG = 162 + (fine - 0.5) * 19 + (grain - 0.5) * 15;
        const mortarB = 153 + (fine - 0.5) * 18 + (grain - 0.5) * 14;

        r = brickR * (1 - mortar) + mortarR * mortar;
        g = brickG * (1 - mortar) + mortarG * mortar;
        b = brickB * (1 - mortar) + mortarB * mortar;
        h = (0.62 + (wireCut - 0.5) * 0.10 + (fine - 0.5) * 0.12 - clayPit * 0.22) * (1 - mortar) +
          (0.24 + (grain - 0.5) * 0.08) * mortar;
      } else if (v < 0.78) {
        // Band 2: Spalled / Gouged / Cracked Brick Core
        const ridgeA = Math.abs(valueNoise(u, v, 14, 14, 509) - 0.5) * 2;
        const ridgeB = Math.abs(valueNoise(u + 0.17, v * 1.3, 22, 18, 613) - 0.5) * 2;
        const crack = Math.max(0, 1 - ridgeA * 7.5) + Math.max(0, 1 - ridgeB * 9.0) * 0.7;
        const crackClamped = Math.min(1, crack);
        const dust = Math.max(0, (coarse * fine - 0.34) * 2.8);

        let cr = 188 + (coarse - 0.5) * 34 + (grain - 0.5) * 22;
        let cg = 92 + (coarse - 0.5) * 20 + (grain - 0.5) * 14;
        let cb = 62 + (coarse - 0.5) * 15 + (grain - 0.5) * 10;

        // Blend pulverized pale mortar dust & dark fracture fissures
        const dustMix = Math.min(0.65, dust * 0.55);
        cr = cr * (1 - dustMix) + 182 * dustMix;
        cg = cg * (1 - dustMix) + 176 * dustMix;
        cb = cb * (1 - dustMix) + 166 * dustMix;

        r = cr * (1 - crackClamped * 0.72) + 38 * (crackClamped * 0.72);
        g = cg * (1 - crackClamped * 0.72) + 22 * (crackClamped * 0.72);
        b = cb * (1 - crackClamped * 0.72) + 18 * (crackClamped * 0.72);
        h = 0.52 + (coarse - 0.5) * 0.34 + (fine - 0.5) * 0.24 - crackClamped * 0.42;
      } else {
        // Band 3: Breached Hole Rim (Mortar Bed + Broken Clay Cross-Section)
        const rv = (v - 0.81) / 0.16;
        const bedMortar = rv < 0.16 || rv > 0.84 ? 1 : 0;
        const rough = (fine - 0.5) * 26 + (grain - 0.5) * 18;
        if (bedMortar > 0) {
          r = 152 + rough * 0.7;
          g = 148 + rough * 0.7;
          b = 140 + rough * 0.7;
          h = 0.32 + (grain - 0.5) * 0.14;
        } else {
          r = 156 + (coarse - 0.5) * 30 + rough * 0.65;
          g = 72 + (coarse - 0.5) * 16 + rough * 0.45;
          b = 50 + (coarse - 0.5) * 12 + rough * 0.35;
          h = 0.56 + (coarse - 0.5) * 0.28 + (fine - 0.5) * 0.20;
        }
      }

      heights[y * size + x] = h;
      const p4 = (y * size + x) * 4;
      pixels[p4] = clampByte(r);
      pixels[p4 + 1] = clampByte(g);
      pixels[p4 + 2] = clampByte(b);
      pixels[p4 + 3] = 255;
    }
  }

  const normalPixels = new Uint8Array(size * size * 4);
  const strength = 4.2;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dhx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
      const dhy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
      let nx = -dhx;
      let ny = -dhy;
      let nz = 1.0;
      const invLen = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;
      const p4 = (y * size + x) * 4;
      normalPixels[p4] = clampByte((nx * 0.5 + 0.5) * 255);
      normalPixels[p4 + 1] = clampByte((ny * 0.5 + 0.5) * 255);
      normalPixels[p4 + 2] = clampByte((nz * 0.5 + 0.5) * 255);
      normalPixels[p4 + 3] = 255;
    }
  }

  const diffuseTex = new pc.Texture(device, {
    name: 'SolidMasonryBrickAtlasAlbedo',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  diffuseTex.lock().set(pixels);
  diffuseTex.unlock();

  const normalTex = new pc.Texture(device, {
    name: 'SolidMasonryBrickAtlasNormal',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.lock().set(normalPixels);
  normalTex.unlock();

  const material = new pc.StandardMaterial();
  material.name = 'SolidMasonryBrickWallMaterial';
  material.diffuse = new pc.Color(1, 1, 1);
  material.diffuseMap = diffuseTex;
  material.diffuseVertexColor = true;
  material.normalMap = normalTex;
  material.bumpiness = 0.85;
  material.useMetalness = true;
  material.metalness = 0.02;
  material.gloss = 0.22;
  material.cull = pc.CULLFACE_NONE;
  material.update();

  return { material, diffuseTexture: diffuseTex, normalTexture: normalTex };
}
