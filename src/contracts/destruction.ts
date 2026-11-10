import type { Vec3Like } from './ballistics.ts';

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type DestructibleMaterialKind =
  | 'WOOD_DRYWALL'
  | 'WOOD_STUD'
  | 'GLASS_MARCHING_256'
  | 'GLASS_VORONOI'
  | 'BRICK_MASONRY'
  | 'CONCRETE_CHUNKS'
  | 'CONCRETE_INTACT'
  | 'STEEL';

export interface ColliderSurfaceTag {
  material: DestructibleMaterialKind;
  objectId: string;
  chunkIndex?: number;
  thicknessM: number;
  penetrationResistanceJ: number;
}

export interface PenetrationRayHit {
  colliderHandle: number;
  pointWorld: Vec3Like;
  normalWorld: Vec3Like;
  distanceM: number;
  surface: ColliderSurfaceTag;
}

export interface BlastEvent {
  centerWorld: Vec3Like;
  radiusM: number;
  peakImpulseNs: number;
  peakEnergyJ: number;
}

export interface ChunkConnectivityEdge {
  neighborIndex: number;
  breakThresholdJ: number;
  severed: boolean;
}

export interface ChunkConnectivityNode {
  index: number;
  name?: string;
  isAnchored: boolean;
  localCenter: Vec3Like;
  halfExtents?: Vec3Like;
  massKg: number;
  meshVariant?: number;
  edges: ChunkConnectivityEdge[];
}

export interface ChunkConnectivityGraphJson {
  version: 1;
  wallId: string;
  nodes: ChunkConnectivityNode[];
}

export interface BallisticSegmentImpact {
  originWorld: Vec3Like;
  directionWorld: Vec3Like;
  maxDistanceM: number;
  kineticEnergyJ: number;
  speedMs: number;
  caliberRadiusM: number;
  isArmorPiercing: boolean;
}

export interface BallisticPenetrationResult {
  remainingEnergyJ: number;
  remainingSpeedMs: number;
  stopped: boolean;
  impactPointWorld?: Vec3Like;
  impactNormalWorld?: Vec3Like;
  hitMaterial?: DestructibleMaterialKind;
}

export interface IDestructibleSubsystem {
  readonly id: string;
  update(dt: number): void;
  handleRaySegment?(seg: BallisticSegmentImpact): BallisticPenetrationResult | null;
  applyBlast?(blast: BlastEvent): void;
  reset?(): void;
  destroy(): void;
}
