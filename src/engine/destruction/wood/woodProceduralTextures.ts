import * as pc from 'playcanvas';

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(x * 374761393 + y * 668265263 + seed * 1442695041, 1274126177);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function createProceduralWoodPanelTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 128;
  const tex = new pc.Texture(device, {
    name: 'wood_wall_sandwich_tex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const fineNoise = (hash2d(x, y, 31) - 0.5) * 16;
      let r: number, g: number, b: number;

      if (v >= 0.86) {
        const fiber = Math.sin(x * 1.35 + hash2d(x >> 1, y, 73) * 3.2) * 18;
        r = 214 + fiber + fineNoise * 0.6;
        g = 176 + fiber * 0.85 + fineNoise * 0.5;
        b = 118 + fiber * 0.65 + fineNoise * 0.4;
      } else {
        const plankRow = Math.floor((v / 0.85) * 6);
        const plankLocalV = ((v / 0.85) * 6) % 1;
        const seam = plankLocalV < 0.045 || plankLocalV > 0.965;
        const grainWave = Math.sin(y * 0.75 + Math.sin(x * 0.14 + plankRow * 2.1) * 2.8) * 14;
        const knotDist = Math.hypot(((u * 3 + plankRow * 0.37) % 1) - 0.5, (plankLocalV - 0.5) * 1.4);
        const knotDarken = knotDist < 0.11 ? -26 * (1 - knotDist / 0.11) : 0;

        if (seam) {
          r = 72 + fineNoise * 0.4;
          g = 50 + fineNoise * 0.4;
          b = 32 + fineNoise * 0.4;
        } else {
          r = 148 + grainWave + knotDarken + fineNoise * 0.55;
          g = 108 + grainWave * 0.78 + knotDarken * 0.8 + fineNoise * 0.45;
          b = 68 + grainWave * 0.52 + knotDarken * 0.6 + fineNoise * 0.35;
        }
      }

      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}

export function createProceduralPineStudTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'wood_stud_lumber_tex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (hash2d(x, y, 97) - 0.5) * 14;
      const streak = Math.sin(x * 1.1 + hash2d(x, y >> 3, 131) * 2.4) * 15;
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(188 + streak + n);
      pixels[idx + 1] = clampByte(144 + streak * 0.8 + n);
      pixels[idx + 2] = clampByte(88 + streak * 0.55 + n);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();
  return tex;
}
