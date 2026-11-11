import {
  AnatomicalColliderVolume,
  Vec3Like,
} from '../../../contracts/ballistics.ts';

export interface HitCandidate {
  collider: AnatomicalColliderVolume;
  tEntry: number;
  tExit: number;
  localNormal: Vec3Like;
  entryWorld: Vec3Like;
  exitWorld: Vec3Like;
  localEntryOffset: Vec3Like;
  localExitOffset: Vec3Like;
  normalWorld: Vec3Like;
  pathLen: number;
}
