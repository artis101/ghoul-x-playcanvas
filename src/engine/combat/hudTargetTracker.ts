import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { HudController, ProjectedTargetTriageEntry } from '../hudController.ts';
import type { GhoulMannequinEntity } from '../mannequin.ts';
import type { PhysiologyEcsSystem } from '../../core/physiology/physiologySystem.ts';

export interface CachedHudTargetLos {
  occluded: boolean;
  expiresAtS: number;
  epoch: number;
  viewerX: number;
  viewerY: number;
  viewerZ: number;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
}

export class HudTargetTracker {
  private readonly hudLosCache = new Map<string, CachedHudTargetLos>();
  private readonly scratchWorldPt = new pc.Vec3();
  private readonly scratchScreenPt = new pc.Vec3();
  private readonly scratchBodyScreenPt = new pc.Vec3();

  public projectTargets(
    targets: GhoulMannequinEntity[],
    camera: pc.CameraComponent | null,
    hudController: HudController,
    physiologySystem: PhysiologyEcsSystem,
    lastEngagedTarget: GhoulMannequinEntity | null,
    viewerPos: Vec3Like,
    totalElapsedTimeS: number,
    losCacheEpoch: number,
    lastHitClockByTarget: Map<string, number>,
    isLineOfSightBlocked?: (from: Vec3Like, to: Vec3Like) => boolean
  ): void {
    if (!camera) return;

    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const cx = vw * 0.5;
    const cy = vh * 0.5;
    const entries: ProjectedTargetTriageEntry[] = [];
    let bestCrosshairDist = 240;
    let aimedTarget: GhoulMannequinEntity | null = null;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const hs = t.healthState;
      const headPopped = hs.zoneGoreMode.HEAD_CRANIUM === 'CRANIAL_POP';
      const anchorPos = headPopped
        ? hs.ragdollBones.NECK_CERVICAL?.position ?? hs.worldPosition
        : hs.ragdollBones.HEAD_CRANIUM?.position ?? hs.worldPosition;
      const bodyPos = hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? {
        x: hs.worldPosition.x,
        y: hs.worldPosition.y + 1.25,
        z: hs.worldPosition.z,
      };
      const yLift = hs.isRagdollActive ? 0.3 : 0.28;

      this.scratchWorldPt.set(anchorPos.x, anchorPos.y + yLift, anchorPos.z);
      camera.worldToScreen(this.scratchWorldPt, this.scratchScreenPt);

      const onScreen =
        this.scratchScreenPt.z > 0 &&
        this.scratchScreenPt.x >= -90 &&
        this.scratchScreenPt.x <= vw + 90 &&
        this.scratchScreenPt.y >= -60 &&
        this.scratchScreenPt.y <= vh + 60;

      let occludedByCover = false;
      if (isLineOfSightBlocked && onScreen) {
        let cached = this.hudLosCache.get(hs.targetId);
        const vDx = cached ? viewerPos.x - cached.viewerX : Infinity;
        const vDy = cached ? viewerPos.y - cached.viewerY : Infinity;
        const vDz = cached ? viewerPos.z - cached.viewerZ : Infinity;
        const aDx = cached ? anchorPos.x - cached.anchorX : Infinity;
        const aDy = cached ? anchorPos.y - cached.anchorY : Infinity;
        const aDz = cached ? anchorPos.z - cached.anchorZ : Infinity;

        if (
          cached &&
          cached.epoch === losCacheEpoch &&
          totalElapsedTimeS < cached.expiresAtS &&
          vDx * vDx + vDy * vDy + vDz * vDz < 0.01 &&
          aDx * aDx + aDy * aDy + aDz * aDz < 0.01
        ) {
          occludedByCover = cached.occluded;
        } else {
          occludedByCover = isLineOfSightBlocked(viewerPos, anchorPos) && isLineOfSightBlocked(viewerPos, bodyPos);
          if (!cached) {
            cached = {
              occluded: occludedByCover,
              expiresAtS: totalElapsedTimeS + 0.08,
              epoch: losCacheEpoch,
              viewerX: viewerPos.x,
              viewerY: viewerPos.y,
              viewerZ: viewerPos.z,
              anchorX: anchorPos.x,
              anchorY: anchorPos.y,
              anchorZ: anchorPos.z,
            };
            this.hudLosCache.set(hs.targetId, cached);
          } else {
            cached.occluded = occludedByCover;
            cached.expiresAtS = totalElapsedTimeS + 0.08;
            cached.epoch = losCacheEpoch;
            cached.viewerX = viewerPos.x;
            cached.viewerY = viewerPos.y;
            cached.viewerZ = viewerPos.z;
            cached.anchorX = anchorPos.x;
            cached.anchorY = anchorPos.y;
            cached.anchorZ = anchorPos.z;
          }
        }
      }

      const lastHitClock = lastHitClockByTarget.get(hs.targetId);
      const recentlyWallbanged =
        lastHitClock !== undefined &&
        totalElapsedTimeS - lastHitClock >= -1e-4 &&
        totalElapsedTimeS - lastHitClock <= 0.8;

      const visible = onScreen && (!occludedByCover || recentlyWallbanged);
      entries.push({
        state: hs,
        screenX: this.scratchScreenPt.x,
        screenY: this.scratchScreenPt.y,
        visible,
      });

      this.scratchWorldPt.set(bodyPos.x, bodyPos.y, bodyPos.z);
      camera.worldToScreen(this.scratchWorldPt, this.scratchBodyScreenPt);
      if (!occludedByCover && this.scratchBodyScreenPt.z > 0) {
        const distPx = Math.hypot(this.scratchBodyScreenPt.x - cx, this.scratchBodyScreenPt.y - cy);
        const headDistPx = Math.hypot(this.scratchScreenPt.x - cx, this.scratchScreenPt.y + 28 - cy);
        const minDist = Math.min(distPx, headDistPx);
        if (minDist < bestCrosshairDist) {
          bestCrosshairDist = minDist;
          aimedTarget = t;
        }
      }
    }

    const focusedState = aimedTarget?.healthState ?? lastEngagedTarget?.healthState ?? null;
    const focusedPhysio = focusedState ? physiologySystem.getEntity(focusedState.targetId) ?? null : null;
    hudController.updateTriageOverlays(entries, focusedState, focusedPhysio);
  }
}
