import * as pc from 'playcanvas';
import type { WeaponRole } from '../../contracts/ballistics.ts';
import type { BarrelSmokeWisp } from './arsenalTypes.ts';
import { getOrCreateViewmodelFxAssets } from './viewmodelFxAssets.ts';

const WISP_POOL_SIZE = 20;

export class BarrelSmokeSystem {
  private readonly slots: BarrelSmokeWisp[] = [];
  private nextSlot = 0;
  private activeCount = 0;
  private smokeRootEntity: pc.Entity | null = null;

  private ensurePool(device: pc.GraphicsDevice, appRoot: pc.Entity): pc.Entity {
    if (this.smokeRootEntity && this.smokeRootEntity.parent !== appRoot) {
      this.destroy();
    }
    if (this.smokeRootEntity) return this.smokeRootEntity;

    const root = new pc.Entity('ViewmodelBarrelSmokeRoot');
    appRoot.addChild(root);
    const fxAssets = getOrCreateViewmodelFxAssets(device);
    for (let i = 0; i < WISP_POOL_SIZE; i++) {
      const entity = new pc.Entity('BarrelSmokeWisp');
      const mi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.barrelSmokeTemplateMat);
      mi.setParameter('material_opacity', 0.0);
      entity.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });
      entity.enabled = false;
      root.addChild(entity);
      this.slots.push({
        entity,
        meshInstance: mi,
        position: new pc.Vec3(),
        velocity: new pc.Vec3(),
        elapsedS: 0,
        durationS: 1,
        startScale: 0,
        endScale: 0,
        baseOpacity: 0,
        spinSpeedDeg: 0,
        active: false,
      });
    }
    this.smokeRootEntity = root;
    return root;
  }

  public spawnWisp(
    device: pc.GraphicsDevice,
    cameraEntity: pc.Entity,
    muzzleFlashEntity: pc.Entity,
    role: WeaponRole
  ): void {
    const appRoot = cameraEntity.root as pc.Entity | null;
    if (!appRoot) return;

    this.ensurePool(device, appRoot);

    const muzzleWorldPos = muzzleFlashEntity.getPosition();
    const camFwd = cameraEntity.forward;

    const wispCount = role === 'SHOTGUN' ? 2 : 1;
    for (let i = 0; i < wispCount; i++) {
      const baseOpacity = role === 'SHOTGUN' ? 0.26 : 0.19;
      const slot = this.slots[this.nextSlot];
      this.nextSlot = (this.nextSlot + 1) % WISP_POOL_SIZE;
      if (!slot.active) this.activeCount++;

      slot.position.set(
        muzzleWorldPos.x + camFwd.x * (0.08 + i * 0.06),
        muzzleWorldPos.y + camFwd.y * (0.08 + i * 0.06) + 0.015,
        muzzleWorldPos.z + camFwd.z * (0.08 + i * 0.06)
      );
      const startScale = 0.065 + i * 0.025;
      const endScale = 0.28 + Math.random() * 0.12;

      slot.velocity.set(
        camFwd.x * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18,
        0.34 + Math.random() * 0.22,
        camFwd.z * (0.55 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.18
      );
      slot.elapsedS = 0;
      slot.durationS = 0.58 + Math.random() * 0.24;
      slot.startScale = startScale;
      slot.endScale = endScale;
      slot.baseOpacity = baseOpacity;
      slot.spinSpeedDeg = (Math.random() - 0.5) * 75;

      slot.meshInstance.setParameter('material_opacity', 0.0);
      slot.entity.setPosition(slot.position);
      slot.entity.setLocalScale(startScale, startScale, 1);
      slot.entity.enabled = true;
      slot.active = true;
    }
  }

  public update(dt: number, cameraEntity: pc.Entity): void {
    if (this.activeCount === 0) return;
    const camPos = cameraEntity.getPosition();

    for (let i = 0; i < this.slots.length; i++) {
      const w = this.slots[i];
      if (!w.active) continue;
      w.elapsedS += dt;
      if (w.elapsedS >= w.durationS) {
        w.active = false;
        w.entity.enabled = false;
        this.activeCount--;
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

  public destroy(): void {
    if (this.smokeRootEntity) {
      this.smokeRootEntity.destroy();
      this.smokeRootEntity = null;
    }
    this.slots.length = 0;
    this.nextSlot = 0;
    this.activeCount = 0;
  }
}
