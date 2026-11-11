import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import { GunsmokeGrid, type GunsmokeGridOptions } from '../../../core/fx/gunsmokeGrid.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { clampByte, valueNoise2d } from '../math/noiseHelpers.ts';
import { basisColumnsToQuaternion } from '../math/surfaceAlignment.ts';

function createSoftCorditeSmokeTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'lingeringCorditeSmokeTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock();
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.hypot(dx, dy);
      const idx = (y * size + x) * 4;
      if (r >= 1.0) {
        pixels[idx] = 185;
        pixels[idx + 1] = 190;
        pixels[idx + 2] = 198;
        pixels[idx + 3] = 0;
        continue;
      }

      const n1 = valueNoise2d(x, y, 0.11, 613);
      const n2 = valueNoise2d(x, y, 0.23, 947);
      const fbm = n1 * 0.65 + n2 * 0.35;
      const radialFalloff = Math.pow(Math.max(0, 1.0 - r * r), 1.85);
      const alpha = radialFalloff * (0.52 + 0.48 * fbm);
      const shade = 168 + Math.round(fbm * 48);

      pixels[idx] = clampByte(shade);
      pixels[idx + 1] = clampByte(shade + 4);
      pixels[idx + 2] = clampByte(shade + 10);
      pixels[idx + 3] = clampByte(alpha * 68);
    }
  }
  tex.unlock();
  return tex;
}

/**
 * 1-draw WebGL2 hardware-instanced lingering hallway gunsmoke volume renderer
 * backed by `GunsmokeGrid`.
 */
export class LingeringGunsmokePool {
  public readonly grid: GunsmokeGrid;
  public readonly instancedPool: HardwareInstancedPool;
  private readonly smokeTexture: pc.Texture;
  private readonly smokeMaterial: pc.StandardMaterial;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    unitQuadMesh: pc.Mesh,
    options: GunsmokeGridOptions = {}
  ) {
    this.grid = new GunsmokeGrid(options);
    const dev = app.graphicsDevice;
    this.smokeTexture = createSoftCorditeSmokeTexture(dev);

    this.smokeMaterial = new pc.StandardMaterial();
    this.smokeMaterial.name = 'mayhemLingeringGunsmokeMat';
    this.smokeMaterial.diffuse = new pc.Color(0.56, 0.58, 0.62);
    this.smokeMaterial.emissive = new pc.Color(0.16, 0.17, 0.19);
    this.smokeMaterial.opacity = 0.28;
    this.smokeMaterial.opacityMap = this.smokeTexture;
    this.smokeMaterial.opacityMapChannel = 'a';
    this.smokeMaterial.blendType = pc.BLEND_NORMAL;
    this.smokeMaterial.depthWrite = false;
    this.smokeMaterial.cull = pc.CULLFACE_NONE;
    this.smokeMaterial.useLighting = false;
    this.smokeMaterial.update();

    this.instancedPool = new HardwareInstancedPool(
      app,
      unitQuadMesh,
      this.smokeMaterial,
      this.grid.maxPuffs,
      'MayhemLingeringGunsmokePool',
      false
    );
  }

  public get activeCount(): number {
    return this.instancedPool.activeCount;
  }

  public injectGunsmoke(originWorld: Vec3Like, dirWorld: Vec3Like, intensity = 1.0): number {
    if (this.destroyed) return -1;
    const slot = this.grid.injectGunsmoke(originWorld, dirWorld, intensity);
    this.syncInstances(null);
    return slot;
  }

  public applyBlastSwirl(centerWorld: Vec3Like, radiusM: number, peakImpulseNs = 120): number {
    if (this.destroyed) return 0;
    return this.grid.applyBlastSwirl(centerWorld, radiusM, peakImpulseNs);
  }

  public update(dt: number, cameraWorldPos: Vec3Like | null): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) return;
    this.grid.step(dt);
    this.syncInstances(cameraWorldPos);
  }

  private syncInstances(cameraWorldPos: Vec3Like | null): void {
    const puffs = this.grid.getPuffs();
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      if (!p.active || p.density <= 0.01) {
        if (this.instancedPool.isSlotActive(i)) {
          this.instancedPool.freeSlot(i);
        }
        continue;
      }

      const lifeFrac = Math.min(1, p.ageS / Math.max(0.1, p.maxLifetimeS));
      const fadeIn = Math.min(1.0, p.ageS / 0.35);
      const fadeOut = Math.max(0.0, 1.0 - lifeFrac * lifeFrac);
      const visScale = p.radiusM * 2.0 * (0.45 + 0.55 * fadeIn) * (0.35 + 0.65 * fadeOut);
      if (visScale <= 0.05) {
        if (this.instancedPool.isSlotActive(i)) {
          this.instancedPool.freeSlot(i);
        }
        continue;
      }

      const quat = this.computeBillboardQuat(p.posX, p.posY, p.posZ, p.rollRad, cameraWorldPos);
      this.instancedPool.setSlotTRS(
        i,
        { x: p.posX, y: p.posY, z: p.posZ },
        quat,
        { x: visScale, y: visScale * 0.82, z: 1.0 }
      );
    }
    this.instancedPool.upload();
  }

  private computeBillboardQuat(
    px: number,
    py: number,
    pz: number,
    rollRad: number,
    cameraWorldPos: Vec3Like | null
  ): QuatLike {
    let fx = 0;
    let fy = 0;
    let fz = 1;
    if (cameraWorldPos) {
      const dx = cameraWorldPos.x - px;
      const dy = cameraWorldPos.y - py;
      const dz = cameraWorldPos.z - pz;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-4) {
        fx = dx / len;
        fy = dy / len;
        fz = dz / len;
      }
    }

    const upRefX = Math.abs(fy) < 0.95 ? 0 : 1;
    const upRefY = Math.abs(fy) < 0.95 ? 1 : 0;
    const upRefZ = 0;

    let rx = upRefY * fz - upRefZ * fy;
    let ry = upRefZ * fx - upRefX * fz;
    let rz = upRefX * fy - upRefY * fx;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    const c = Math.cos(rollRad);
    const s = Math.sin(rollRad);
    return basisColumnsToQuaternion(
      rx * c + ux * s,
      ry * c + uy * s,
      rz * c + uz * s,
      ux * c - rx * s,
      uy * c - ry * s,
      uz * c - rz * s,
      fx,
      fy,
      fz
    );
  }

  public clear(): void {
    if (this.destroyed) return;
    this.grid.clear();
    this.instancedPool.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.instancedPool.destroy();
    this.smokeMaterial.destroy();
    this.smokeTexture.destroy();
  }
}
