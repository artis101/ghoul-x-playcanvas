import * as pc from 'playcanvas';
import { smoothstep } from './glassSystemTypes.ts';

export function generateWindowGlassPaneRgba8(textureSize = 256): Uint8Array {
  const size = Math.max(32, Math.floor(textureSize));
  const rgba = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    const edgeDistY = Math.min(v, 1 - v);

    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const edgeDistX = Math.min(u, 1 - u);
      const borderDist = Math.min(edgeDistX, edgeDistY);

      const skyGrad = smoothstep(0.08, 0.96, v);
      let r = 128 + skyGrad * 34;
      let g = 186 + skyGrad * 36;
      let b = 204 + skyGrad * 34;

      const diagCoord = u * 0.64 + v * 0.77;
      const primaryBand = (1 - smoothstep(0.0, 0.24, Math.abs(diagCoord - 0.60))) * 0.85;
      const secondaryBand = (1 - smoothstep(0.0, 0.11, Math.abs(diagCoord - 0.96))) * 0.45;
      const reflection = primaryBand + secondaryBand;

      r += reflection * 42;
      g += reflection * 40;
      b += reflection * 34;

      const edgeGlow = smoothstep(0.014, 0.032, borderDist) * (1 - smoothstep(0.032, 0.095, borderDist));
      r -= edgeGlow * 10;
      g += edgeGlow * 18;
      b += edgeGlow * 14;

      const gasketMask = 1 - smoothstep(0.004, 0.020, borderDist);
      r = r * (1 - gasketMask * 0.58) + 26 * gasketMask * 0.58;
      g = g * (1 - gasketMask * 0.58) + 36 * gasketMask * 0.58;
      b = b * (1 - gasketMask * 0.58) + 42 * gasketMask * 0.58;

      const micro = (Math.sin(u * 19.7 + v * 13.1) * 0.5 + Math.cos(u * 11.3 - v * 23.9) * 0.5) * 1.5;
      const alpha = 224 + reflection * 18 + gasketMask * 24;

      const outIdx = (py * size + px) * 4;
      rgba[outIdx] = Math.max(0, Math.min(255, Math.round(r + micro)));
      rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g + micro)));
      rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b + micro)));
      rgba[outIdx + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    }
  }

  return rgba;
}

export function createWindowGlassPaneTexture(
  device: pc.GraphicsDevice,
  textureSize = 256,
): pc.Texture {
  const size = Math.max(32, Math.floor(textureSize));
  const rgba = generateWindowGlassPaneRgba8(size);

  return new pc.Texture(device, {
    name: 'WindowGlassPaneTexture',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    flipY: false,
    levels: [rgba],
  });
}
