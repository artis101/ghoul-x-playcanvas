import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import type { SplinterSpawnDescriptor } from '../../../core/destruction/woodPolygonClipper.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { WoodWallInstance } from './woodWallTypes.ts';
import { quatAlignUnitXToVector } from './buckshotVolleyTracker.ts';

export function spawnPerimeterSplinters(
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  wall: WoodWallInstance,
  descriptors: readonly SplinterSpawnDescriptor[],
  bulletDirWorld: Vec3Like,
  exitFaceSignZ: number,
  kineticEnergyJ: number,
): void {
  if (descriptors.length === 0 || splinterPools.length === 0) return;

  const halfW = wall.widthM * 0.5;
  const halfH = wall.heightM * 0.5;
  const exitZ = exitFaceSignZ * (wall.thicknessM * 0.5 + 0.012);
  const speedFactor = Math.min(2.0, Math.max(0.65, Math.sqrt(Math.max(80, kineticEnergyJ) / 900)));

  const scratchQuat: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const scratchPos: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchAngVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchScale: Vec3Like = { x: 0.1, y: 0.015, z: 0.015 };

  for (let i = 0; i < descriptors.length; i++) {
    const desc = descriptors[i];
    const lx = desc.u - halfW;
    const ly = desc.v - halfH;
    const lz = i === descriptors.length - 1 ? -exitZ : exitZ;

    scratchPos.x = wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw;
    scratchPos.y = wall.centerWorld.y + ly;
    scratchPos.z = wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw;

    const tanWx = desc.tangentU * wall.cosYaw;
    const tanWy = desc.tangentV;
    const tanWz = -desc.tangentU * wall.sinYaw;
    quatAlignUnitXToVector(tanWx, tanWy, tanWz, scratchQuat);

    const radWx = desc.radialU * wall.cosYaw;
    const radWy = desc.radialV;
    const radWz = -desc.radialU * wall.sinYaw;

    const forwardBurst = (i === descriptors.length - 1 ? -2.2 : 4.8 + nextRand() * 4.5) * speedFactor;
    const radialBurst = (1.6 + nextRand() * 2.8) * speedFactor;

    scratchVel.x = bulletDirWorld.x * forwardBurst + radWx * radialBurst + (nextRand() - 0.5) * 1.2;
    scratchVel.y = bulletDirWorld.y * forwardBurst + radWy * radialBurst + 0.85 + nextRand() * 1.6;
    scratchVel.z = bulletDirWorld.z * forwardBurst + radWz * radialBurst + (nextRand() - 0.5) * 1.2;

    scratchAngVel.x = (nextRand() - 0.5) * 26;
    scratchAngVel.y = (nextRand() - 0.5) * 26;
    scratchAngVel.z = (nextRand() - 0.5) * 26;

    const lenScale = Math.max(0.055, Math.min(0.24, desc.lengthM));
    const thickScale = 0.012 + nextRand() * 0.015;
    scratchScale.x = lenScale;
    scratchScale.y = thickScale;
    scratchScale.z = thickScale * (0.75 + nextRand() * 0.5);

    const pool = splinterPools[i % splinterPools.length];
    pool.spawnKinematicParticle(
      scratchPos,
      scratchVel,
      scratchAngVel,
      scratchScale,
      -9.81,
      0.28,
      2.2 + nextRand() * 1.1,
      scratchQuat,
    );
  }
}

export function spawnPlankChunkBurst(
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  wall: WoodWallInstance,
  centerU: number,
  centerV: number,
  radiusM: number,
  bulletDirWorld: Vec3Like,
  exitFaceSignZ: number,
  kineticEnergyJ: number,
  count: number,
): void {
  if (count <= 0 || splinterPools.length === 0) return;

  const halfW = wall.widthM * 0.5;
  const halfH = wall.heightM * 0.5;
  const exitZ = exitFaceSignZ * (wall.thicknessM * 0.5 + 0.02);
  const speedFactor = Math.min(2.1, Math.max(0.85, Math.sqrt(Math.max(200, kineticEnergyJ) / 1100)));

  const scratchQuat: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const scratchPos: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchAngVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchScale: Vec3Like = { x: 0.1, y: 0.015, z: 0.015 };

  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2 + (nextRand() - 0.5) * 0.4;
    const r = radiusM * (0.2 + 0.7 * Math.sqrt(nextRand()));
    const su = Math.max(0.03, Math.min(wall.widthM - 0.03, centerU + Math.cos(theta) * r * 1.25));
    const sv = Math.max(0.03, Math.min(wall.heightM - 0.03, centerV + Math.sin(theta) * r));

    const lx = su - halfW;
    const ly = sv - halfH;
    scratchPos.x = wall.centerWorld.x + lx * wall.cosYaw + exitZ * wall.sinYaw;
    scratchPos.y = wall.centerWorld.y + ly;
    scratchPos.z = wall.centerWorld.z - lx * wall.sinYaw + exitZ * wall.cosYaw;

    const grainSign = (i & 1) === 0 ? 1 : -1;
    const tanU = grainSign;
    const tanV = (nextRand() - 0.5) * 0.28;
    quatAlignUnitXToVector(tanU * wall.cosYaw, tanV, -tanU * wall.sinYaw, scratchQuat);

    const radWx = Math.cos(theta) * wall.cosYaw;
    const radWy = Math.sin(theta);
    const radWz = -Math.cos(theta) * wall.sinYaw;

    const forwardSpeed = (5.2 + nextRand() * 5.4) * speedFactor;
    const radialSpeed = (1.8 + nextRand() * 3.0) * speedFactor;

    scratchVel.x = bulletDirWorld.x * forwardSpeed + radWx * radialSpeed;
    scratchVel.y = bulletDirWorld.y * forwardSpeed + radWy * radialSpeed + 1.1 + nextRand() * 1.8;
    scratchVel.z = bulletDirWorld.z * forwardSpeed + radWz * radialSpeed;

    scratchAngVel.x = (nextRand() - 0.5) * 20;
    scratchAngVel.y = (nextRand() - 0.5) * 20;
    scratchAngVel.z = (nextRand() - 0.5) * 20;

    scratchScale.x = 0.13 + nextRand() * 0.14;
    scratchScale.y = 0.042 + nextRand() * 0.048;
    scratchScale.z = 0.015 + nextRand() * 0.016;

    const pool = splinterPools[i % splinterPools.length];
    pool.spawnKinematicParticle(
      scratchPos,
      scratchVel,
      scratchAngVel,
      scratchScale,
      -9.81,
      0.28,
      2.0 + nextRand() * 1.2,
      scratchQuat,
    );
  }
}

export function spawnBlastSplinterShower(
  splinterPools: readonly HardwareInstancedPool[],
  nextRand: () => number,
  wall: WoodWallInstance,
  centerU: number,
  centerV: number,
  breachRadiusM: number,
  blastCenterWorld: Vec3Like,
  awaySignZ: number,
  count: number,
  proximity: number,
): void {
  if (splinterPools.length === 0 || count <= 0) {
    return;
  }

  const halfW = wall.widthM * 0.5;
  const halfH = wall.heightM * 0.5;
  const launchBoost = 6.5 + 8.5 * proximity;

  const scratchQuat: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const scratchPos: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchAngVel: Vec3Like = { x: 0, y: 0, z: 0 };
  const scratchScale: Vec3Like = { x: 0.1, y: 0.015, z: 0.015 };

  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2 + (nextRand() - 0.5) * 0.25;
    const r = breachRadiusM * (0.35 + 0.65 * Math.sqrt(nextRand()));
    const su = Math.max(0.02, Math.min(wall.widthM - 0.02, centerU + Math.cos(theta) * r));
    const sv = Math.max(0.02, Math.min(wall.heightM - 0.02, centerV + Math.sin(theta) * r));

    const lx = su - halfW;
    const ly = sv - halfH;
    const lz = awaySignZ * (wall.thicknessM * 0.5 + 0.02);

    const wx = wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw;
    const wy = wall.centerWorld.y + ly;
    const wz = wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw;

    scratchPos.x = wx;
    scratchPos.y = wy;
    scratchPos.z = wz;

    // Tangent orientation around blast breach perimeter
    const tanU = -Math.sin(theta);
    const tanV = Math.cos(theta);
    quatAlignUnitXToVector(tanU * wall.cosYaw, tanV, -tanU * wall.sinYaw, scratchQuat);

    let dx = wx - blastCenterWorld.x;
    let dy = wy - blastCenterWorld.y;
    let dz = wz - blastCenterWorld.z;
    const dLen = Math.hypot(dx, dy, dz);
    if (dLen > 1e-4) {
      dx /= dLen;
      dy /= dLen;
      dz /= dLen;
    } else {
      dx = awaySignZ * wall.sinYaw;
      dy = 0.35;
      dz = awaySignZ * wall.cosYaw;
    }

    const speed = launchBoost * (0.65 + 0.7 * nextRand());
    scratchVel.x = dx * speed + (nextRand() - 0.5) * 2.5;
    scratchVel.y = Math.max(-1.5, dy * speed) + 1.8 + nextRand() * 2.8;
    scratchVel.z = dz * speed + (nextRand() - 0.5) * 2.5;

    scratchAngVel.x = (nextRand() - 0.5) * 32;
    scratchAngVel.y = (nextRand() - 0.5) * 32;
    scratchAngVel.z = (nextRand() - 0.5) * 32;

    scratchScale.x = 0.09 + nextRand() * 0.16;
    scratchScale.y = 0.016 + nextRand() * 0.022;
    scratchScale.z = 0.014 + nextRand() * 0.02;

    const pool = splinterPools[i % splinterPools.length];
    pool.spawnKinematicParticle(
      scratchPos,
      scratchVel,
      scratchAngVel,
      scratchScale,
      -9.81,
      0.3,
      2.6 + nextRand() * 1.4,
      scratchQuat,
    );
  }
}

