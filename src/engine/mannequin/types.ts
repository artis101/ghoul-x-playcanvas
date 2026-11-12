import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';

export type {
  MannequinDriveMode,
  MannequinDriveState,
  PropAttachmentKind,
  PropAttachmentState,
  PropAttachmentTransitionInput,
  PropAttachmentTransitionResult,
} from './propAttachmentState.ts';

/** The pair of wound caps shown when a zone is cut away from its parent. */
export interface StumpCap {
  zone: GhoulZoneId;
  parent: GhoulZoneId;
  /** On the body, over the socket the zone came out of. */
  socket: pc.Entity;
  /** On the severed end of the zone itself. */
  limb: pc.Entity;
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
