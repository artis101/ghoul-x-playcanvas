import * as pc from 'playcanvas';
import type {
  Vec3Like,
  TargetHealthState,
  TrajectorySample,
  GhoulZoneId,
} from '../../../contracts/ballistics.ts';

export interface ActiveProjectileFx {
  entity: pc.Entity;
  shockwaveRing?: pc.Entity;
  trajectorySamples: TrajectorySample[];
  currentSampleIndex: number;
  progressTimeS: number;
  totalFlightTimeS: number;
  finished: boolean;
  trailPoints: pc.Vec3[];
}

export interface InFlightBloodDrop {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
  baseRadius?: number;
}

export interface BloodPoolDecal {
  entity: pc.Entity;
  currentScale: number;
  targetScale: number;
  growthRate: number;
  aspectRatio?: number;
}

export interface GibChunk {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  bounces: number;
  life: number;
  maxLife: number;
  leavesBlood: boolean;
  restHeight: number;
}

export interface BoneShardSpark {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
}

export interface ArterialFountainStream {
  target?: TargetHealthState;
  zone?: GhoulZoneId;
  parentZone?: GhoulZoneId;
  stumpPos: Vec3Like;
  sprayDir: Vec3Like;
  durationS: number;
  elapsedS: number;
  dropTimerS: number;
}

export interface BloodMistPuff {
  entity: pc.Entity;
  meshInstance: pc.MeshInstance | null;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  spinSpeedDeg: number;
}

export interface WetGoreMaterialSuite {
  wetBloodDropMat: pc.StandardMaterial;
  wetBloodPoolMat: pc.StandardMaterial;
  wetBloodMistBaseMat: pc.StandardMaterial;
  wetFleshGibMat: pc.StandardMaterial;
  wetCorticalBoneMat: pc.StandardMaterial;
  wetMarrowCapMat: pc.StandardMaterial;
  incandescentSparkMat: pc.StandardMaterial;
  tracerTailMat: pc.StandardMaterial;
  floorQuadMesh: pc.Mesh | null;
}
