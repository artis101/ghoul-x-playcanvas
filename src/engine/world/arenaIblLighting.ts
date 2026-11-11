import * as pc from 'playcanvas';

export interface CachedIblEnvironment {
  envAtlas: pc.Texture;
  skyboxCubemap: pc.Texture;
}

const cachedIblByDevice = new WeakMap<pc.GraphicsDevice, CachedIblEnvironment>();

export function writeRgbmPixel(
  pixels: Uint8Array,
  idx: number,
  rLin: number,
  gLin: number,
  bLin: number
): void {
  const sr = Math.sqrt(Math.max(0, rLin)) * 0.125;
  const sg = Math.sqrt(Math.max(0, gLin)) * 0.125;
  const sb = Math.sqrt(Math.max(0, bLin)) * 0.125;
  const maxC = Math.min(1.0, Math.max(sr, sg, sb, 1.0 / 255.0));
  const aByte = Math.max(1, Math.min(255, Math.ceil(maxC * 255.0)));
  const aNorm = aByte / 255.0;

  pixels[idx] = Math.min(255, Math.round(Math.min(1.0, sr / aNorm) * 255.0));
  pixels[idx + 1] = Math.min(255, Math.round(Math.min(1.0, sg / aNorm) * 255.0));
  pixels[idx + 2] = Math.min(255, Math.round(Math.min(1.0, sb / aNorm) * 255.0));
  pixels[idx + 3] = aByte;
}

export function getOrCreateProceduralIblEnvironment(
  device: pc.GraphicsDevice,
  sunDir: pc.Vec3
): CachedIblEnvironment | null {
  if (device instanceof pc.NullGraphicsDevice) return null;

  const cached = cachedIblByDevice.get(device);
  if (cached) return cached;

  try {
    const width = 512;
    const height = 256;
    const equirect = new pc.Texture(device, {
      name: 'procedural_tactical_hdr_equirect',
      width,
      height,
      format: pc.PIXELFORMAT_RGBA8,
      type: pc.TEXTURETYPE_RGBM,
      projection: pc.TEXTUREPROJECTION_EQUIRECT,
      mipmaps: false,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });

    const sx = sunDir.x;
    const sy = sunDir.y;
    const sz = sunDir.z;

    const pixels = equirect.lock() as Uint8Array;
    for (let y = 0; y < height; y++) {
      const elev = (0.5 - (y + 0.5) / height) * Math.PI;
      const sinEl = Math.sin(elev);
      const cosEl = Math.cos(elev);

      for (let x = 0; x < width; x++) {
        const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2.0;
        const dx = cosEl * Math.sin(phi);
        const dy = sinEl;
        const dz = cosEl * Math.cos(phi);

        let rLin = 0;
        let gLin = 0;
        let bLin = 0;

        if (dy >= 0) {
          const zenithT = Math.pow(dy, 0.55);
          const horizonGlow = Math.pow(1.0 - dy, 4.0);
          rLin = 0.16 * (1.0 - zenithT) + 0.065 * zenithT + horizonGlow * 0.42;
          gLin = 0.24 * (1.0 - zenithT) + 0.135 * zenithT + horizonGlow * 0.36;
          bLin = 0.36 * (1.0 - zenithT) + 0.285 * zenithT + horizonGlow * 0.28;

          const cloudWave = Math.sin(dx * 5.0 + dz * 3.2) * Math.cos(dz * 4.4 - dx * 2.1) * 0.5 + 0.5;
          const cloudFactor = cloudWave * (1.0 - zenithT * 0.55) * 0.16;
          rLin += cloudFactor * 0.95;
          gLin += cloudFactor * 0.98;
          bLin += cloudFactor * 1.05;

          if (dy > 0.48) {
            const stripBand = Math.abs(Math.sin((dz / Math.max(0.22, dy)) * 3.6));
            const lateralMask = Math.max(0, 1.0 - Math.abs(dx / Math.max(0.22, dy)) * 0.85);
            if (stripBand > 0.92 && lateralMask > 0.25) {
              const stripBoost = ((stripBand - 0.92) / 0.08) * lateralMask * 2.4;
              rLin += stripBoost * 1.05;
              gLin += stripBoost * 1.08;
              bLin += stripBoost * 1.15;
            }
          }

          const sunDot = Math.max(0, dx * sx + dy * sy + dz * sz);
          const mieWide = Math.pow(sunDot, 8.0) * 0.65;
          const mieTight = Math.pow(sunDot, 96.0) * 3.8;
          const sunDisc = sunDot > 0.9985 ? 24.0 : 0.0;

          rLin += (mieWide + mieTight + sunDisc) * 1.08;
          gLin += (mieWide * 0.92 + mieTight * 0.94 + sunDisc * 0.96);
          bLin += (mieWide * 0.74 + mieTight * 0.80 + sunDisc * 0.84);
        } else {
          const groundDepth = Math.min(1.0, -dy * 2.5);
          const horizonBounce = Math.pow(1.0 + dy, 5.0);
          rLin = 0.032 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.18;
          gLin = 0.038 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.19;
          bLin = 0.048 * (1.0 - groundDepth * 0.45) + horizonBounce * 0.22;
        }

        writeRgbmPixel(pixels, (y * width + x) * 4, rLin, gLin, bLin);
      }
    }
    equirect.unlock();

    const lightingSource = pc.EnvLighting.generateLightingSource(equirect, { size: 256 });
    const envAtlas = pc.EnvLighting.generateAtlas(lightingSource);
    const skyboxCubemap = pc.EnvLighting.generateSkyboxCubemap(lightingSource, 256);

    lightingSource.destroy();
    equirect.destroy();

    const bundle: CachedIblEnvironment = { envAtlas, skyboxCubemap };
    cachedIblByDevice.set(device, bundle);
    return bundle;
  } catch {
    return null;
  }
}
