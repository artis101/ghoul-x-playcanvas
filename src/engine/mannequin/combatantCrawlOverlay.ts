import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import { GHOUL_ZONE_HIERARCHY } from '../../core/ghoul/anatomy.ts';
import { evaluateCrawlCondition } from '../../core/ghoul/anatomy/crawlCondition.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';

const LEG_ZONES = ['THIGH', 'KNEE', 'SHIN', 'FOOT'] as const;
const SIDES = ['LEFT', 'RIGHT'] as const;
const EASE_RATE = 3.5;
const MAX_HEAD_DROOP_DEG = 26;
const SMEAR_SPACING_M = 0.3;

/** Lays wound behaviour over the crawl cycle: dragged legs, a sagging head and a blood trail. */
export class CombatantCrawlOverlay {
  private limpRotations: Map<GhoulZoneId, pc.Quat> | null = null;
  private readonly drag: Record<(typeof SIDES)[number], number> = { LEFT: 0, RIGHT: 0 };
  private droop = 0;
  private readonly rotation = new pc.Quat();
  private readonly nod = new pc.Quat();
  private readonly lastSmear = new pc.Vec3(Number.NaN, 0, 0);

  public reset(): void {
    this.drag.LEFT = 0;
    this.drag.RIGHT = 0;
    this.droop = 0;
    this.lastSmear.x = Number.NaN;
  }

  public sync(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    crawling: boolean,
    dt: number,
    clockS: number,
    fxManager?: GoreAndBallisticsFxManager,
  ): void {
    const condition = crawling ? evaluateCrawlCondition(healthState, clockS) : null;
    const ease = dt > 0 ? 1 - Math.exp(-EASE_RATE * dt) : 1;
    this.drag.LEFT += ((condition?.dragLeftLeg ? 1 : 0) - this.drag.LEFT) * ease;
    this.drag.RIGHT += ((condition?.dragRightLeg ? 1 : 0) - this.drag.RIGHT) * ease;
    this.droop += ((condition?.headDroop ?? 0) - this.droop) * ease;

    const limp = this.limpRotations ??= this.buildLimpRotations(glb);
    for (const side of SIDES) {
      const weight = this.drag[side];
      if (weight < 0.01) continue;
      for (const part of LEG_ZONES) {
        const zone: GhoulZoneId = `${part}_${side}`;
        const node = glb.boneNodes.get(zone);
        const target = limp.get(zone);
        if (!node || !target || healthState.severedZones.has(zone)) continue;
        node.setLocalRotation(this.rotation.slerp(node.getLocalRotation(), target, weight));
      }
    }
    if (this.droop > 0.01) {
      this.nod.setFromEulerAngles(this.droop * MAX_HEAD_DROOP_DEG, 0, 0);
      for (const zone of ['NECK_CERVICAL', 'HEAD_CRANIUM'] as const) {
        const node = glb.boneNodes.get(zone);
        if (node) node.setLocalRotation(this.rotation.mul2(node.getLocalRotation(), this.nod));
      }
    }
    if (condition && fxManager && healthState.bleedRateHpPerSec > 0) this.leaveTrail(healthState, fxManager);
  }

  /** A dragged leg hangs straight from the hip with the foot trailing. */
  private buildLimpRotations(glb: CombatantGlbInstance): Map<GhoulZoneId, pc.Quat> {
    const limp = new Map<GhoulZoneId, pc.Quat>();
    for (const side of SIDES) {
      for (const part of LEG_ZONES) {
        const zone: GhoulZoneId = `${part}_${side}`;
        const parent = GHOUL_ZONE_HIERARCHY[zone].parent;
        const bind = glb.boneBindPoses.get(zone);
        const parentBind = parent && glb.boneBindPoses.get(parent);
        if (!bind || !parentBind) continue;
        const rest = new pc.Quat().copy(parentBind.modelRot).invert().mul(bind.modelRot);
        // Let the toes point back along the shin instead of standing on them.
        if (part === 'FOOT') rest.slerp(rest, pc.Quat.IDENTITY, 0.6);
        limp.set(zone, rest);
      }
    }
    return limp;
  }

  private leaveTrail(healthState: TargetHealthState, fxManager: GoreAndBallisticsFxManager): void {
    const { x, z } = healthState.worldPosition;
    if (!Number.isNaN(this.lastSmear.x) && Math.hypot(x - this.lastSmear.x, z - this.lastSmear.z) < SMEAR_SPACING_M) {
      return;
    }
    this.lastSmear.set(x, 0, z);
    fxManager.spawnBloodSmear(healthState.worldPosition, 0.07 + Math.min(0.09, healthState.bleedRateHpPerSec * 0.02));
  }
}
