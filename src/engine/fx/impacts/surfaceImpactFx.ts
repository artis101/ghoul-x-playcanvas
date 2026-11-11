import * as pc from 'playcanvas';
import type { DestructibleMaterialKind, PenetrationRayHit } from '../../../contracts/destruction.ts';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { add, cross, dot, length, normalize, scale, vec3 } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { spawnRicochetSparks } from '../tracers/tracerSparkSystem.ts';
import type { ExplosionTemplateMaterials, TransientBillowPlume } from '../explosions/explosionTypes.ts';

export interface SurfaceImpactContext {
  rapierWorld: RapierPhysicsWorld;
  impactSparkPool: HardwareInstancedPool;
  unitQuadMesh: pc.Mesh;
  rootEntity: pc.Entity;
  templates: ExplosionTemplateMaterials;
  billowPlumes: TransientBillowPlume[];
}

export type SurfaceOpenPredicate = (
  hit: PenetrationRayHit,
  rayOrigin: Vec3Like,
  rayDirNormalized: Vec3Like,
  maxDistM: number,
) => boolean;

export interface EnvironmentSurfaceHit {
  pointWorld: Vec3Like;
  normalWorld: Vec3Like;
  distanceM: number;
  material: DestructibleMaterialKind;
}

export function castEnvironmentImpactRay(
  rapierWorld: RapierPhysicsWorld,
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  maxDistM: number,
  isSurfaceOpenAtHit?: SurfaceOpenPredicate,
): EnvironmentSurfaceHit | null {
  const wallHits = rapierWorld.castPenetrationRay(origin, dirNormalized, maxDistM);
  let bestHit: EnvironmentSurfaceHit | null = null;

  for (const h of wallHits) {
    if (h.distanceM > 0.15 && h.distanceM <= maxDistM) {
      if (isSurfaceOpenAtHit?.(h, origin, dirNormalized, maxDistM)) {
        continue;
      }
      let n = h.normalWorld;
      if (dot(n, dirNormalized) > 0) n = scale(n, -1);
      bestHit = {
        pointWorld: h.pointWorld,
        normalWorld: normalize(n),
        distanceM: h.distanceM,
        material: h.surface.material,
      };
      break;
    }
  }

  if (dirNormalized.y < -1e-4 && origin.y > 0.02) {
    const tFloor = -origin.y / dirNormalized.y;
    if (tFloor > 0.15 && tFloor <= maxDistM && (!bestHit || tFloor < bestHit.distanceM)) {
      bestHit = {
        pointWorld: {
          x: origin.x + dirNormalized.x * tFloor,
          y: 0,
          z: origin.z + dirNormalized.z * tFloor,
        },
        normalWorld: { x: 0, y: 1, z: 0 },
        distanceM: tFloor,
        material: 'CONCRETE_INTACT',
      };
    }
  }

  return bestHit;
}

export function traceWeaponEnvironmentFire(
  rapierWorld: RapierPhysicsWorld,
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  maxDistM: number,
  projectileEnergyJ: number,
  isSurfaceOpenAtHit?: SurfaceOpenPredicate,
): { firstSurfaceHit: EnvironmentSurfaceHit | null; tracerStopDistanceM: number | null } {
  const wallHits = rapierWorld.castPenetrationRay(origin, dirNormalized, maxDistM);
  let firstSurfaceHit: EnvironmentSurfaceHit | null = null;
  let tracerStopDistanceM: number | null = null;
  let remainingEnergyJ = Math.max(0, projectileEnergyJ);
  let lastObjectKey = '';
  let lastObjectDistM = -Infinity;

  for (const h of wallHits) {
    if (h.distanceM <= 0.15 || h.distanceM > maxDistM) continue;
    if (isSurfaceOpenAtHit?.(h, origin, dirNormalized, maxDistM)) continue;

    let n = h.normalWorld;
    if (dot(n, dirNormalized) > 0) n = scale(n, -1);

    if (!firstSurfaceHit) {
      firstSurfaceHit = {
        pointWorld: h.pointWorld,
        normalWorld: normalize(n),
        distanceM: h.distanceM,
        material: h.surface.material,
      };
    }

    const objKey = `${h.surface.material}:${h.surface.objectId}`;
    const isSameSlab = objKey === lastObjectKey && h.distanceM - lastObjectDistM <= 0.45;
    lastObjectKey = objKey;
    lastObjectDistM = h.distanceM;

    if (!isSameSlab) {
      remainingEnergyJ -= Math.max(0, h.surface.penetrationResistanceJ);
      if (remainingEnergyJ <= 15) {
        tracerStopDistanceM = h.distanceM;
        break;
      }
    }
  }

  if (dirNormalized.y < -1e-4 && origin.y > 0.02) {
    const tFloor = -origin.y / dirNormalized.y;
    if (tFloor > 0.15 && tFloor <= maxDistM) {
      if (!firstSurfaceHit || tFloor < firstSurfaceHit.distanceM) {
        firstSurfaceHit = {
          pointWorld: {
            x: origin.x + dirNormalized.x * tFloor,
            y: 0,
            z: origin.z + dirNormalized.z * tFloor,
          },
          normalWorld: { x: 0, y: 1, z: 0 },
          distanceM: tFloor,
          material: 'CONCRETE_INTACT',
        };
      }
      if (tracerStopDistanceM === null || tFloor < tracerStopDistanceM) {
        tracerStopDistanceM = tFloor;
      }
    }
  }

  return { firstSurfaceHit, tracerStopDistanceM };
}

export function spawnSurfaceImpact(
  ctx: SurfaceImpactContext,
  hitPointWorld: Vec3Like,
  surfaceNormalWorld: Vec3Like,
  surfaceMaterial: DestructibleMaterialKind = 'CONCRETE_INTACT',
  kineticEnergyJ = 650,
  seedCounter: { value: number },
): void {
  const n = length(surfaceNormalWorld) > 1e-4 ? normalize(surfaceNormalWorld) : vec3(0, 1, 0);
  const upRef = Math.abs(n.y) < 0.95 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const tangentA = normalize(cross(upRef, n));
  const tangentB = normalize(cross(n, tangentA));

  const isGlass = surfaceMaterial.startsWith('GLASS');
  const isWood = surfaceMaterial.startsWith('WOOD');
  const isMetallic = surfaceMaterial === 'STEEL' || isGlass;
  const sparkCount = isMetallic ? 14 : isWood ? 4 : 9;

  const energyScale = Math.min(1.65, 0.72 + kineticEnergyJ / 1800);
  const origin = add(hitPointWorld, scale(n, 0.018));

  // 1. High-contrast incandescent ricochet sparks
  seedCounter.value = spawnRicochetSparks(
    ctx.impactSparkPool,
    origin,
    n,
    tangentA,
    tangentB,
    sparkCount,
    isMetallic,
    energyScale,
    seedCounter.value,
  );

  // 2. Pulverized concrete / masonry / wood dust plumes
  if (ctx.billowPlumes.length < 48 && !isGlass) {
    const puffCount = isMetallic ? 1 : 2;
    const sharedMat =
      surfaceMaterial === 'BRICK_MASONRY'
        ? ctx.templates.brickDustTemplateMat
        : isWood
          ? ctx.templates.woodDustTemplateMat
          : isMetallic
            ? ctx.templates.metalDustTemplateMat
            : ctx.templates.dustPlumeTemplateMat;
    const baseOpacity = isMetallic ? 0.32 : 0.52;

    for (let p = 0; p < puffCount; p++) {
      const seed = seedCounter.value++;
      const puffEnt = new pc.Entity('MayhemImpactDustPlume');
      const mi = new pc.MeshInstance(ctx.unitQuadMesh, sharedMat);
      mi.setParameter('material_opacity', 0.0);
      puffEnt.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });

      const startScale = (0.14 + p * 0.06) * energyScale;
      const endScale = (0.62 + p * 0.28) * energyScale;
      puffEnt.setPosition(origin.x, origin.y, origin.z);
      puffEnt.setLocalScale(startScale, startScale, 1);
      ctx.rootEntity.addChild(puffEnt);

      const jitterA = ((seed * 47) % 19) / 19 - 0.5;
      const jitterB = ((seed * 83) % 23) / 23 - 0.5;
      const driftVel = new pc.Vec3(
        n.x * (1.25 + p * 0.55) + tangentA.x * jitterA * 0.9,
        Math.max(0.25, n.y * 1.1 + 0.55 + p * 0.25),
        n.z * (1.25 + p * 0.55) + tangentB.z * jitterB * 0.9,
      );

      ctx.billowPlumes.push({
        entity: puffEnt,
        meshInstance: mi,
        position: new pc.Vec3(origin.x, origin.y, origin.z),
        velocity: driftVel,
        elapsedS: 0,
        durationS: 0.48 + p * 0.2,
        startScale,
        endScale,
        baseOpacity,
        spinDegPerS: jitterA * 85,
        isGroundRing: false,
      });
    }
  }
}
