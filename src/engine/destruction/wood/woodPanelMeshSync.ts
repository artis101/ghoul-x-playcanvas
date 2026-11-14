import * as pc from 'playcanvas';
import {
  triangulateWoodPanelToBuffers,
  type WoodMeshBuildStats,
} from '../../../core/destruction/woodPolygonClipper.ts';
import type { WoodWallInstance } from './woodWallTypes.ts';

export function uploadWallPanelMesh(wall: WoodWallInstance, stats: WoodMeshBuildStats): void {
  wall.panelMeshStats = stats;
  wall.panelMeshDirty = false;
  if (stats.vertexCount <= 0 || stats.indexCount <= 0) {
    wall.panelEntity.enabled = false;
    return;
  }
  wall.panelEntity.enabled = true;
  const mesh = wall.panelMesh;
  const buf = wall.scratchBuffers;
  mesh.setPositions(buf.positions, 3, stats.vertexCount);
  mesh.setNormals(buf.normals, 3, stats.vertexCount);
  mesh.setUvs(0, buf.uvs, 2, stats.vertexCount);
  mesh.setIndices(buf.indices, stats.indexCount);
  mesh.update(pc.PRIMITIVE_TRIANGLES, false);
}

/** Records that the panel's logical shape changed; the render mesh is rebuilt on the next flush. */
export function markWallPanelMeshDirty(wall: WoodWallInstance): void {
  wall.panelMeshDirty = true;
}

export function rebuildWallPanelMesh(wall: WoodWallInstance): WoodMeshBuildStats {
  const stats = triangulateWoodPanelToBuffers(wall.panelState, wall.scratchBuffers);
  uploadWallPanelMesh(wall, stats);
  return stats;
}

/** Rebuilds the panel's render mesh when its shape changed since the last upload. */
export function flushWallPanelMesh(wall: WoodWallInstance): boolean {
  if (!wall.panelMeshDirty) return false;
  rebuildWallPanelMesh(wall);
  return true;
}
