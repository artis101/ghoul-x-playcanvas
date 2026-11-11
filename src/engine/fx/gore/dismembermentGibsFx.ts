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
  const count = Math.max(4, event.gibCount);
  const origin = event.stumpWorldPosition;
  const launchVel = event.severedLimbVelocity;

  ctx.spawnBloodBurst(
    new pc.Vec3(origin.x, origin.y, origin.z),
    new pc.Vec3(event.arterialSprayDirection.x, event.arterialSprayDirection.y, event.arterialSprayDirection.z),
    360,
    18,
  );

  for (let i = 0; i < count; i++) {
    const isBonePredominant = i % 3 === 0;
    const gibRoot = new pc.Entity('GibChunk');

    if (isBonePredominant) {
      const boneShaft = new pc.Entity('CorticalBoneFragment');
      boneShaft.addComponent('render', {
        type: 'cylinder',
        material: goreSuite.wetCorticalBoneMat,
        castShadows: true,
        receiveShadows: true,
      });
      const r = 0.015 + Math.random() * 0.01;
      const len = 0.058 + Math.random() * 0.038;
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

      const tissueCuff = new pc.Entity('AdherentMuscleCuff');
      tissueCuff.addComponent('render', {
        type: 'sphere',
        material: goreSuite.wetFleshGibMat,
        castShadows: true,
      });
      tissueCuff.setLocalPosition(r * 0.35, -len * 0.18, 0);
      tissueCuff.setLocalScale(r * 1.65, len * 0.55, r * 1.45);
      gibRoot.addChild(tissueCuff);
    } else {
      const meatMass = new pc.Entity('WetMuscleMass');
      meatMass.addComponent('render', {
        type: i % 2 === 0 ? 'capsule' : 'sphere',
        material: goreSuite.wetFleshGibMat,
        castShadows: true,
        receiveShadows: true,
      });
      const s = 0.036 + Math.random() * 0.036;
      meatMass.setLocalScale(s * 0.92, s * 1.38, s * 0.84);
      gibRoot.addChild(meatMass);

      if (i % 2 === 1) {
        const boneSplinter = new pc.Entity('BoneSplinterSpur');
        boneSplinter.addComponent('render', {
          type: 'cone',
          material: goreSuite.wetCorticalBoneMat,
          castShadows: false,
        });
        boneSplinter.setLocalPosition(0, s * 0.58, 0);
        boneSplinter.setLocalScale(s * 0.32, s * 0.72, s * 0.32);
        gibRoot.addChild(boneSplinter);
      }
    }

    gibRoot.setPosition(origin.x, origin.y, origin.z);
    gibRoot.setLocalEulerAngles(Math.random() * 360, Math.random() * 360, Math.random() * 360);
    fxRoot.addChild(gibRoot);

    const vx = launchVel.x * 0.68 + (Math.random() - 0.5) * 4.5;
    const vy = Math.max(1.9, launchVel.y * 0.58 + Math.random() * 3.4);
    const vz = launchVel.z * 0.68 + (Math.random() - 0.5) * 4.5;

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
      restHeight: 0.026,
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
