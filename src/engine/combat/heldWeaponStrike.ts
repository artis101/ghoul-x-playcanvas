import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';

export interface HeldWeaponStrike {
  readonly target: GhoulMannequinEntity;
  readonly distanceM: number;
  readonly pointWorld: Vec3Like;
}

/** Each mesh's local box is shrunk a little so grazing the silhouette's empty corners misses. */
const BOX_SHRINK = 0.85;

const invMat = new pc.Mat4();
const localOrigin = new pc.Vec3();
const localDir = new pc.Vec3();
const localEnd = new pc.Vec3();
const worldOrigin = new pc.Vec3();
const worldEnd = new pc.Vec3();
const hitLocal = new pc.Vec3();
const hitWorld = new pc.Vec3();
const ray = new pc.Ray();
const box = new pc.BoundingBox();

/**
 * Finds the nearest enemy-held gun that a shot passes through before `maxDistM`. The test runs in
 * each weapon mesh's own space, so a rifle held across the chest does not shield the whole torso.
 */
export function findHeldWeaponStrike(
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  targets: readonly GhoulMannequinEntity[],
  maxDistM: number,
): HeldWeaponStrike | null {
  worldOrigin.set(origin.x, origin.y, origin.z);
  worldEnd.set(origin.x + dirNormalized.x, origin.y + dirNormalized.y, origin.z + dirNormalized.z);

  let best: HeldWeaponStrike | null = null;
  for (const target of targets) {
    const hs = target.healthState;
    if (!hs.alive || hs.weaponDropped) continue;
    const weapon = target.heldWeaponEntity;
    if (!weapon) continue;
    const renders = weapon.findComponents('render') as pc.RenderComponent[];

    for (const mi of renders.flatMap((r) => (r.enabled ? r.meshInstances : []))) {
      if (!mi.mesh) continue;
      invMat.copy(mi.node.getWorldTransform()).invert();
      invMat.transformPoint(worldOrigin, localOrigin);
      invMat.transformPoint(worldEnd, localEnd);
      localDir.sub2(localEnd, localOrigin);
      const localPerWorld = localDir.length();
      if (localPerWorld < 1e-6) continue;
      localDir.mulScalar(1 / localPerWorld);

      const meshAabb = mi.mesh.aabb;
      box.center.copy(meshAabb.center);
      box.halfExtents.copy(meshAabb.halfExtents).mulScalar(BOX_SHRINK);
      ray.set(localOrigin, localDir);
      if (!box.intersectsRay(ray, hitLocal)) continue;

      mi.node.getWorldTransform().transformPoint(hitLocal, hitWorld);
      const d = hitWorld.distance(worldOrigin);
      if (d > maxDistM || (best && d >= best.distanceM)) continue;
      best = { target, distanceM: d, pointWorld: { x: hitWorld.x, y: hitWorld.y, z: hitWorld.z } };
    }
  }
  return best;
}
