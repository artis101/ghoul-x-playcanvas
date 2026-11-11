import * as pc from 'playcanvas';
import type { WeaponRole } from '../../contracts/ballistics.ts';
import type { BarrelSmokeWisp } from './arsenalTypes.ts';
import { getOrCreateViewmodelFxAssets } from './viewmodelFxAssets.ts';

export class BarrelSmokeSystem {
  private readonly wisps: BarrelSmokeWisp[] = [];
  private smokeRootEntity: pc.Entity | null = null;

  public spawnWisp(
    device: pc.GraphicsDevice,
    cameraEntity: pc.Entity,
    muzzleFlashEntity: pc.Entity,
    role: WeaponRole
  ): void {
    const appRoot = cameraEntity.root;
    if (!appRoot) return;

    if (!this.smokeRootEntity || this.smokeRootEntity.parent !== appRoot) {
      this.smokeRootEntity = new pc.Entity('ViewmodelBarrelSmokeRoot');
      appRoot.addChild(this.smokeRootEntity);
    }

    if (this.wisps.length >= 20) {
      const oldest = this.wisps.shift();
      oldest?.entity.destroy();
    }

    const fxAssets = getOrCreateViewmodelFxAssets(device);
    const muzzleWorldPos = muzzleFlashEntity.getPosition();
    const camFwd = cameraEntity.forward;

    const wispCount = role === 'SHOTGUN' ? 2 : 1;
    for (let i = 0; i < wispCount; i++) {
      const baseOpacity = role === 'SHOTGUN' ? 0.26 : 0.19;
      const wispEnt = new pc.Entity('BarrelSmokeWisp');
      const mi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.barrelSmokeTemplateMat);
      mi.setParameter('material_opacity', 0.0);
      wispEnt.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });

      const startPos = new pc.Vec3(
        muzzleWorldPos.x + camFwd.x * (0.08 + i * 0.06),
        muzzleWorldPos.y + camFwd.y * (0.08 + i * 0.06) + 0.015,
        muzzleWorldPos.z + camFwd.z * (0.08 + i * 0.06)
      );
      const startScale = 0.065 + i * 0.025;
      const endScale = 0.28 + Math.random() * 0.12;

      wispEnt.setPosition(startPos);
      wispEnt.setLocalScale(startScale, startScale, 1);
      this.smokeRootEntity.addChild(wispEnt);

      this.wisps.push({
        entity: wispEnt,
        meshInstance: mi,
        position: startPos,
        velocity: new pc.Vec3(
          camFwd.x * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18,
          0.34 + Math.random() * 0.22,
          camFwd.z * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18
        ),
        elapsedS: 0,
        durationS: 0.58 + Math.random() * 0.24,
        startScale,
        endScale,
        baseOpacity,
        spinSpeedDeg: (Math.random() - 0.5) * 75,
      });
    }
  }

  public update(dt: number, cameraEntity: pc.Entity): void {
    if (this.wisps.length === 0) return;
    const camPos = cameraEntity.getPosition();

    for (let i = this.wisps.length - 1; i >= 0; i--) {
      const w = this.wisps[i];
      w.elapsedS += dt;
      if (w.elapsedS >= w.durationS) {
        w.entity.destroy();
        this.wisps.splice(i, 1);
        continue;
      }

      const t = w.elapsedS / w.durationS;
      const drag = Math.exp(-2.8 * dt);
      w.velocity.x *= drag;
      w.velocity.z *= drag;
      w.position.x += w.velocity.x * dt;
      w.position.y += w.velocity.y * dt;
      w.position.z += w.velocity.z * dt;

      w.entity.setPosition(w.position);
      w.entity.lookAt(camPos);
      w.entity.rotateLocal(0, 0, w.elapsedS * w.spinSpeedDeg);

      const curScale = w.startScale + (w.endScale - w.startScale) * (1 - (1 - t) * (1 - t));
      w.entity.setLocalScale(curScale, curScale, 1);
      const fadeIn = Math.min(1, t * 6.0);
      w.meshInstance.setParameter('material_opacity', w.baseOpacity * fadeIn * (1 - t) * (1 - t));
    }
  }

  public clear(): void {
    for (const w of this.wisps) {
      w.entity.destroy();
    }
    this.wisps.length = 0;
  }
}
