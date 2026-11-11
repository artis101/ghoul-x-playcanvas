import {
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { add, distance, scale, sub } from '../vec3.ts';
import { ALL_ANATOMICAL_COLLIDERS } from '../math/restBoneBases.ts';
import {
  boneColliderDirToWorld,
  worldToBoneColliderSpace,
} from '../math/coordinateFrames.ts';
import { intersectSegmentVolume } from '../math/segmentIntersections.ts';
import { HitCandidate } from './shotTypes.ts';

export function findSegmentHits(
  prevPos: Vec3Like,
  currPos: Vec3Like,
  target: TargetHealthState,
  penetratedColliders: ReadonlySet<string>
): HitCandidate[] {
  const hits: HitCandidate[] = [];

  for (const col of ALL_ANATOMICAL_COLLIDERS) {
    if (col.id === 'vol_helmet_kevlar') {
      if (!target.hasHelmetArmor || !target.headgearIntact || target.helmetArmorIntegrity <= 5) {
        continue;
      }
    }
    if (col.id === 'vol_thorax_kevlar_vest') {
      if (!target.hasChestArmor || target.chestArmorIntegrity <= 5) {
        continue;
      }
    }

    if (
      target.zoneGoreMode[col.ghoulZone] === 'CRANIAL_POP' &&
      (col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW')
    ) {
      continue;
    }
    if (penetratedColliders.has(col.id)) {
      continue;
    }

    const mapA = worldToBoneColliderSpace(prevPos, target, col.ghoulZone);
    const mapB = worldToBoneColliderSpace(currPos, target, col.ghoulZone);

    const inter = intersectSegmentVolume(mapA.colliderSpacePt, mapB.colliderSpacePt, col);
    if (inter) {
      const entryWorld = add(prevPos, scale(sub(currPos, prevPos), inter.tEntry));
      const exitWorld = add(prevPos, scale(sub(currPos, prevPos), inter.tExit));
      const localEntryOffset = add(
        mapA.boneLocalOffset,
        scale(sub(mapB.boneLocalOffset, mapA.boneLocalOffset), inter.tEntry)
      );
      const localExitOffset = add(
        mapA.boneLocalOffset,
        scale(sub(mapB.boneLocalOffset, mapA.boneLocalOffset), inter.tExit)
      );
      const normalWorld = boneColliderDirToWorld(inter.localNormal, target, col.ghoulZone);
      const pathLen = Math.max(0.005, distance(entryWorld, exitWorld));

      hits.push({
        collider: col,
        tEntry: inter.tEntry,
        tExit: inter.tExit,
        localNormal: inter.localNormal,
        entryWorld,
        exitWorld,
        localEntryOffset,
        localExitOffset,
        normalWorld,
        pathLen,
      });
    }
  }

  hits.sort((a, b) => a.tEntry - b.tEntry);
  return hits;
}
