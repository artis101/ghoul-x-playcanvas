import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import { add, normalize, scale } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  BARREL_BLAST_PEAK_ENERGY_J,
  BARREL_BLAST_PEAK_IMPULSE_NS,
  BARREL_BLAST_RADIUS_M,
  type HazardBarrelInstance,
} from './barrelTypes.ts';

export function spawnBarrelShrapnel(
  shrapnelPool: HardwareInstancedPool,
  blastCenter: Vec3Like,
  barrelIndex: number,
): void {
  const shardCount = 24;
  for (let i = 0; i < shardCount; i++) {
    const angle = (i / shardCount) * Math.PI * 2 + barrelIndex * 0.61;
    const elev = 0.25 + ((i * 7) % 11) * 0.065;
    const speed = 7.5 + ((i * 13) % 9) * 1.35;
    const dir = normalize({
      x: Math.cos(angle),
      y: elev,
      z: Math.sin(angle),
    });
    shrapnelPool.spawnKinematicParticle(
      add(blastCenter, scale(dir, 0.24)),
      scale(dir, speed),
      {
        x: ((i % 5) - 2) * 14,
        y: ((i % 7) - 3) * 16,
        z: ((i % 3) - 1) * 19,
      },
      { x: 0.075, y: 0.018, z: 0.048 },
      -9.81,
      0.36,
      3.2,
    );
  }
}

export function executeBarrelDetonation(
  barrel: HazardBarrelInstance,
  rapierWorld: RapierPhysicsWorld,
  shrapnelPool: HardwareInstancedPool | null,
): BlastEvent {
  if (barrel.colliderHandle >= 0) {
    rapierWorld.removeCollider(barrel.colliderHandle);
    barrel.colliderHandle = -1;
  }
  barrel.phase = { kind: 'DETONATED' };
  barrel.state = 'DETONATED';
  barrel.fuseRemainingS = 0;
  if (barrel.intactDrumEntity) barrel.intactDrumEntity.enabled = false;
  if (barrel.flameJetEntity) barrel.flameJetEntity.enabled = false;
  if (barrel.crumpledBaseEntity) barrel.crumpledBaseEntity.enabled = true;
  if (barrel.scorchDecalEntity) barrel.scorchDecalEntity.enabled = true;

  const blastCenter: Vec3Like = {
    x: barrel.basePosition.x,
    y: barrel.basePosition.y + 0.45,
    z: barrel.basePosition.z,
  };

  const blast: BlastEvent = {
    centerWorld: blastCenter,
    radiusM: BARREL_BLAST_RADIUS_M,
    peakImpulseNs: BARREL_BLAST_PEAK_IMPULSE_NS,
    peakEnergyJ: BARREL_BLAST_PEAK_ENERGY_J,
  };

  if (shrapnelPool) {
    spawnBarrelShrapnel(shrapnelPool, blastCenter, barrel.index);
  }

  rapierWorld.applyRadialBlastImpulse(blast);
  return blast;
}
