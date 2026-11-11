import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';

export interface ChildSocketStump {
  childZone: GhoulZoneId;
  node: pc.Entity;
}

export interface ZoneMeshBundle {
  zone: GhoulZoneId;
  zoneNode: pc.Entity;
  fleshNode?: pc.Entity;
  fleshMeshInstances: pc.MeshInstance[];
  intactMaterials: pc.StandardMaterial[];
  laceratedMaterials: pc.StandardMaterial[];
  woundDecalNodes: pc.Entity[];
  boneNodes: pc.Entity[];
  organNodes: pc.Entity[];
  proximalStumpNode?: pc.Entity;
  distalChildStumps: ChildSocketStump[];
  intactAbdomenNode?: pc.Entity;
  evisceratedAbdomenNode?: pc.Entity;
}

export interface RestRagdollBoneFrame {
  restPos: pc.Vec3;
  restDistalPos: pc.Vec3;
  restRot: pc.Quat;
  restRotInv: pc.Quat;
}

export interface GlbZoneMaterialPair {
  meshInstance: pc.MeshInstance;
  intactMat: pc.Material;
  laceratedMat: pc.Material;
}
