import * as pc from 'playcanvas';
import { clampByte, valueNoise2d } from '../goreNoise.ts';

export function createBloodMistTexture(device: pc.GraphicsDevice): pc.Texture {
  const mSize = 64;
  const mistTex = new pc.Texture(device, {
    name: 'goreBacklitMistTex',
    width: mSize,
    height: mSize,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const mPx = mistTex.lock() as Uint8Array;
  for (let y = 0; y < mSize; y++) {
    for (let x = 0; x < mSize; x++) {
      const u = (x + 0.5) / mSize;
      const v = (y + 0.5) / mSize;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const wisp =
        valueNoise2d(u, v, 5, 1301) * 0.6 + valueNoise2d(u, v, 11, 1453) * 0.4;
      const falloff = Math.max(0, 1 - d * d);
      const alpha = falloff * falloff * (0.45 + wisp * 0.55);
      const idx = (y * mSize + x) * 4;
      mPx[idx] = clampByte(128 + wisp * 36);
      mPx[idx + 1] = clampByte(8 + wisp * 6);
      mPx[idx + 2] = clampByte(12 + wisp * 8);
      mPx[idx + 3] = clampByte(alpha * 255);
    }
  }
  mistTex.unlock();
  return mistTex;
}
