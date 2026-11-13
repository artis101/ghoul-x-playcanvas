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
      // Broken, grainy spray rather than a soft round cloud.
      const grain = valueNoise2d(u, v, 22, 1597);
      const alpha = falloff * falloff * Math.max(0, wisp * 1.3 - 0.25) * (0.55 + grain * 0.45);
      const idx = (y * mSize + x) * 4;
      mPx[idx] = clampByte(70 + wisp * 24);
      mPx[idx + 1] = clampByte(9 + wisp * 5);
      mPx[idx + 2] = clampByte(7 + wisp * 4);
      mPx[idx + 3] = clampByte(alpha * 255);
    }
  }
  mistTex.unlock();
  return mistTex;
}
