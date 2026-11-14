import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BloodMistPuff, InFlightBloodDrop } from './goreTypes.ts';
import { recycleOldestWhenFull, releaseFxEntity } from '../particles/fxEntityPool.ts';
import { MAX_LIVE_BLOOD_DROPS, type GoreFxPools } from './goreFxPools.ts';

export function spawnBacklitMistPuff(
  pools: GoreFxPools,
  mistPuffs: BloodMistPuff[],
  worldPos: Vec3Like,
  dir: Vec3Like,
  driftSpeed: number,
  energyJ: number,
): void {
  const puff = pools.mistPuff.acquire();
  const puffMi = puff.render?.meshInstances?.[0] ?? null;
  puffMi?.setParameter('material_opacity', 0.52);

  const energyScale = Math.min(1.65, 0.75 + energyJ / 650);
  const startScale = (0.1 + Math.random() * 0.06) * energyScale;
  const endScale = (0.38 + Math.random() * 0.2) * energyScale;
  puff.setPosition(worldPos.x, worldPos.y, worldPos.z);
  puff.setLocalEulerAngles(90, Math.random() * 360, 0);
  puff.setLocalScale(startScale, 1, startScale);

  mistPuffs.push({
    entity: puff,
    meshInstance: puffMi,
    position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
    velocity: new pc.Vec3(
      dir.x * driftSpeed + (Math.random() - 0.5) * 0.85,
      Math.max(0.25, dir.y * driftSpeed * 0.65 + 0.42),
      dir.z * driftSpeed + (Math.random() - 0.5) * 0.85,
    ),
    life: 0,
    maxLife: 0.32 + Math.random() * 0.2,
    startScale,
    endScale,
    spinSpeedDeg: (Math.random() - 0.5) * 65,
  });
}

export function spawnBloodBurst(
  pools: GoreFxPools,
  bloodDrops: InFlightBloodDrop[],
  mistPuffs: BloodMistPuff[],
  worldPos: Vec3Like,
  normalDir: Vec3Like,
  energyJ: number,
  count = 16,
): void {
  // Kept restrained: a hit should spit a handful of drops, not hose the room.
  const burstCount = Math.min(16, Math.max(count, Math.floor(energyJ / 50)));
  const baseSpeed = Math.min(10.2, Math.max(2.8, Math.sqrt(Math.max(1, energyJ)) * 0.175));

  if (energyJ >= 32 && mistPuffs.length < 20) {
    const mistCount = energyJ > 280 ? 2 : 1;
    for (let m = 0; m < mistCount; m++) {
      spawnBacklitMistPuff(pools, mistPuffs, worldPos, normalDir, baseSpeed * (0.28 + m * 0.12), energyJ);
    }
  }

  for (let i = 0; i < burstCount; i++) {
    recycleOldestWhenFull(bloodDrops, MAX_LIVE_BLOOD_DROPS);
    const dropEnt = pools.bloodDrop.acquire();

    const isStreamCore = i < burstCount * 0.4;
    const spreadScale = isStreamCore ? 0.42 : 1.08;
    const speedJitter = isStreamCore ? 0.85 + Math.random() * 0.45 : 0.55 + Math.random() * 0.7;
    // Fine atomised spray: thin needles of blood, never marble-sized beads.
    const radius = (isStreamCore ? 0.006 : 0.0035) + Math.random() * 0.005;

    const vx = normalDir.x * baseSpeed * speedJitter + (Math.random() - 0.5) * baseSpeed * spreadScale;
    const vy = normalDir.y * baseSpeed * speedJitter + Math.random() * baseSpeed * 0.58 + 0.65;
    const vz = normalDir.z * baseSpeed * speedJitter + (Math.random() - 0.5) * baseSpeed * spreadScale;

    const spd = Math.hypot(vx, vy, vz);
    const stretch = Math.min(7, 1.5 + spd * 0.6);
    dropEnt.setLocalScale(radius * 0.7, radius * 0.7, radius * stretch);
    dropEnt.setPosition(worldPos.x, worldPos.y, worldPos.z);
    if (spd > 0.1) {
      dropEnt.lookAt(worldPos.x + vx, worldPos.y + vy, worldPos.z + vz);
    }

    bloodDrops.push({
      entity: dropEnt,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      life: 0,
      maxLife: 1.6,
      baseRadius: radius,
    });
  }
}

export function updateMistPuffs(
  mistPuffs: BloodMistPuff[],
  dt: number,
  camPos: pc.Vec3 | null,
): void {
  for (let i = mistPuffs.length - 1; i >= 0; i--) {
    const puff = mistPuffs[i];
    puff.life += dt;
    if (puff.life >= puff.maxLife) {
      releaseFxEntity(puff.entity);
      mistPuffs.splice(i, 1);
      continue;
    }

    const t = puff.life / puff.maxLife;
    const drag = Math.exp(-3.2 * dt);
    puff.velocity.scale(drag);
    puff.velocity.y -= 0.65 * dt;
    puff.position.x += puff.velocity.x * dt;
    puff.position.y = Math.max(0.08, puff.position.y + puff.velocity.y * dt);
    puff.position.z += puff.velocity.z * dt;

    puff.entity.setPosition(puff.position.x, puff.position.y, puff.position.z);
    if (camPos) {
      puff.entity.lookAt(camPos);
      puff.entity.rotateLocal(90, puff.life * puff.spinSpeedDeg, 0);
    }

    const curScale = puff.startScale + (puff.endScale - puff.startScale) * (1 - (1 - t) * (1 - t));
    puff.entity.setLocalScale(curScale, 1, curScale);
    puff.meshInstance?.setParameter('material_opacity', 0.54 * (1 - t) * (1 - t));
  }
}
