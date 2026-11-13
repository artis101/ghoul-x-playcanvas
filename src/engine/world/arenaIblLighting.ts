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
  _keyLightDir: pc.Vec3
): CachedIblEnvironment | null {
  if (device instanceof pc.NullGraphicsDevice) return null;

  const cached = cachedIblByDevice.get(device);
  if (cached) return cached;

  try {
    const width = 512;
    const height = 256;
    const equirect = new pc.Texture(device, {
      name: 'procedural_tiled_hall_equirect',
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

        // Dim tiled interior: stained ceiling with fixture glow overhead, cream walls
        // around the horizon, dark stone floor below.
        const up = Math.max(0, dy);
        const down = Math.max(0, -dy);
        const wallBand = 1.0 - Math.abs(dy);
        rLin = 0.13 + wallBand * 0.2 - down * 0.06;
        gLin = 0.125 + wallBand * 0.19 - down * 0.06;
        bLin = 0.1 + wallBand * 0.14 - down * 0.05;

        if (dy > 0.5) {
          const bay = Math.abs(Math.sin((dz / dy) * 1.6));
          const lateral = Math.abs(Math.abs(dx / dy) - 1.1);
          if (bay > 0.9 && lateral < 0.35) {
            const glow = ((bay - 0.9) / 0.1) * (1.0 - lateral / 0.35) * up * 2.2;
            rLin += glow;
            gLin += glow * 0.93;
            bLin += glow * 0.7;
          }
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
