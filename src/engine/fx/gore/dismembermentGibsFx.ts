import * as pc from 'playcanvas';
import type { DismembermentEvent } from '../../../contracts/ballistics.ts';
import type { GibChunk, WetGoreMaterialSuite } from './goreTypes.ts';

export interface GibSpawnContext {
  spawnBloodBurst(worldPos: pc.Vec3, normalDir: pc.Vec3, energyJ: number, count?: number): void;
  spawnBloodPool(pos: pc.Vec3, maxRadius?: number): void;
}

export function spawnDismembermentGibs(
  fxRoot: pc.Entity,
  goreSuite: WetGoreMaterialSuite,
  gibChunks: GibChunk[],
  event: DismembermentEvent,
  ctx: GibSpawnContext,
): void {
  // The severed limb is the big piece of debris. Besides it only a few splinters of bone with
  // muscle still on them are knocked loose: bare round lumps of flesh read as blobs of blood
  // hanging in the air, not as gore.
  const count = Math.min(3, Math.max(1, Math.round(event.gibCount * 0.25)));
  const origin = event.stumpWorldPosition;
  const launchVel = event.severedLimbVelocity;

  ctx.spawnBloodBurst(
    new pc.Vec3(origin.x, origin.y, origin.z),
    new pc.Vec3(event.arterialSprayDirection.x, event.arterialSprayDirection.y, event.arterialSprayDirection.z),
    360,
    10,
  );

  for (let i = 0; i < count; i++) {
    const gibRoot = new pc.Entity('GibChunk');

    const boneShaft = new pc.Entity('CorticalBoneFragment');
    boneShaft.addComponent('render', {
      type: 'cylinder',
      material: goreSuite.wetCorticalBoneMat,
      castShadows: true,
      receiveShadows: true,
    });
    const r = 0.012 + Math.random() * 0.008;
    const len = 0.05 + Math.random() * 0.035;
    boneShaft.setLocalScale(r, len, r * 0.88);
    gibRoot.addChild(boneShaft);

    const marrowCore = new pc.Entity('TrabecularMarrowCore');
    marrowCore.addComponent('render', {
      type: 'cylinder',
      material: goreSuite.wetMarrowCapMat,
      castShadows: false,
    });
    marrowCore.setLocalPosition(0, len * 0.48, 0);
    marrowCore.setLocalScale(r * 0.68, 0.012, r * 0.68);
    gibRoot.addChild(marrowCore);

    // Torn muscle clinging to one end of the splinter, smaller than the bone is long.
    const tissueCuff = new pc.Entity('AdherentMuscleCuff');
    tissueCuff.addComponent('render', {
      type: 'sphere',
      material: goreSuite.wetFleshGibMat,
      castShadows: true,
    });
    tissueCuff.setLocalPosition(r * 0.35, -len * 0.25, 0);
    tissueCuff.setLocalScale(r * 1.5, len * 0.42, r * 1.3);
    gibRoot.addChild(tissueCuff);

    gibRoot.setPosition(origin.x, origin.y, origin.z);
    gibRoot.setLocalEulerAngles(Math.random() * 360, Math.random() * 360, Math.random() * 360);
    fxRoot.addChild(gibRoot);

    // Knocked out and down, not lobbed overhead.
    const vx = launchVel.x * 0.5 + (Math.random() - 0.5) * 2.2;
    const vy = launchVel.y * 0.3 + Math.random() * 1.2;
    const vz = launchVel.z * 0.5 + (Math.random() - 0.5) * 2.2;

    gibChunks.push({
      entity: gibRoot,
      position: new pc.Vec3(origin.x, origin.y, origin.z),
      velocity: new pc.Vec3(vx, vy, vz),
      angularVelocity: new pc.Vec3(
        (Math.random() - 0.5) * 22,
        (Math.random() - 0.5) * 22,
        (Math.random() - 0.5) * 22,
      ),
      bounces: 0,
      life: 0,
      maxLife: 12.0,
      leavesBlood: true,
      restHeight: 0.014,
    });
  }
}

export function updateGibChunks(
  gibChunks: GibChunk[],
  dt: number,
  gravity: number,
  onSpawnBloodPool: (pos: pc.Vec3, maxRadius: number) => void,
): void {
  for (let i = gibChunks.length - 1; i >= 0; i--) {
    const gib = gibChunks[i];
    gib.life += dt;
    gib.velocity.y += gravity * dt;

    gib.position.x += gib.velocity.x * dt;
    gib.position.y += gib.velocity.y * dt;
    gib.position.z += gib.velocity.z * dt;

    gib.entity.setPosition(gib.position.x, gib.position.y, gib.position.z);
    if (gib.angularVelocity.length() > 0.05) {
      gib.entity.rotate(
        gib.angularVelocity.x * dt * 45,
        gib.angularVelocity.y * dt * 45,
        gib.angularVelocity.z * dt * 45,
      );
    }

    if (gib.position.y <= gib.restHeight) {
      gib.position.y = gib.restHeight;
      gib.bounces++;
      if (gib.leavesBlood && gib.bounces <= 2) {
        onSpawnBloodPool(gib.position, 0.3);
      }

      if (gib.bounces <= 2 && Math.abs(gib.velocity.y) > 0.5) {
        gib.velocity.y = -gib.velocity.y * 0.32;
        gib.velocity.x *= 0.58;
        gib.velocity.z *= 0.58;
        gib.angularVelocity.set(
          gib.angularVelocity.x * 0.5,
          gib.angularVelocity.y * 0.5,
          gib.angularVelocity.z * 0.2,
        );
      } else {
        gib.velocity.set(0, 0, 0);
        gib.angularVelocity.set(0, 0, 0);
        if (!gib.leavesBlood && gib.bounces === 3) {
          const eul = gib.entity.getLocalEulerAngles();
          gib.entity.setLocalEulerAngles(0, eul.y, 88);
        }
      }
    }

    if (gib.life >= gib.maxLife) {
      gib.entity.destroy();
      gibChunks.splice(i, 1);
    }
  }
}
