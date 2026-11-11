import * as pc from 'playcanvas';
import type { InFlightBloodDrop } from './goreTypes.ts';

export function updateBloodDrops(
  bloodDrops: InFlightBloodDrop[],
  dt: number,
  gravity: number,
  onSpawnBloodPool: (pos: pc.Vec3, maxRadius: number) => void,
): void {
  for (let i = bloodDrops.length - 1; i >= 0; i--) {
    const drop = bloodDrops[i];
    drop.life += dt;
    drop.velocity.y += gravity * dt;

    drop.position.x += drop.velocity.x * dt;
    drop.position.y += drop.velocity.y * dt;
    drop.position.z += drop.velocity.z * dt;

    drop.entity.setPosition(drop.position.x, drop.position.y, drop.position.z);

    const spd = drop.velocity.length();
    if (spd > 0.25) {
      const r = drop.baseRadius ?? 0.016;
      const stretch = Math.min(3.4, 1.0 + spd * 0.24);
      drop.entity.setLocalScale(r * 0.82, r * 0.82, r * stretch);
      drop.entity.lookAt(
        drop.position.x + drop.velocity.x,
        drop.position.y + drop.velocity.y,
        drop.position.z + drop.velocity.z,
      );
    }

    if (drop.position.y <= 0.015) {
      onSpawnBloodPool(drop.position, 0.25);
      drop.entity.destroy();
      bloodDrops.splice(i, 1);
      continue;
    }

    if (drop.life >= drop.maxLife) {
      drop.entity.destroy();
      bloodDrops.splice(i, 1);
    }
  }
}
