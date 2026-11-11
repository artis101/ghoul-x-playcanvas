import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../../contracts/destruction.ts';
import type { WoodStudAnchorSpan } from '../../../core/destruction/woodPolygonClipper.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  DEFAULT_WOOD_STUD_DEPTH_M,
  DEFAULT_WOOD_STUD_WIDTH_M,
  type StudColumnState,
  type WallInternalState,
  type WoodWallInstance,
} from './woodWallTypes.ts';
import { collectIntactStudSpans, writeWallStudFrameBuffers } from './woodStudFrameBuilder.ts';

export function buildStudAnchorsFromColumns(
  studColumns: readonly StudColumnState[],
): WoodStudAnchorSpan[] {
  const anchors: WoodStudAnchorSpan[] = [];
  const halfStudW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5;
  for (let i = 0; i < studColumns.length; i++) {
    const col = studColumns[i];
    if (col.isBorderPost) continue;
    const spans = collectIntactStudSpans(col);
    for (let s = 0; s < spans.length; s++) {
      anchors.push({
        u: col.u,
        halfWidthM: halfStudW,
        vMin: spans[s].vMin,
        vMax: spans[s].vMax,
      });
    }
  }
  return anchors;
}

export function rebuildWallStudColliders(
  physicsWorld: RapierPhysicsWorld,
  wall: WoodWallInstance,
  internal: WallInternalState,
): void {
  const handles = internal.mutableStudColliderHandles;
  for (let i = 0; i < handles.length; i++) {
    physicsWorld.removeCollider(handles[i]);
  }
  handles.length = 0;

  const halfW = wall.widthM * 0.5;
  const halfH = wall.heightM * 0.5;
  const studHalfW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5;
  const studHalfD = DEFAULT_WOOD_STUD_DEPTH_M * 0.5;
  const plateHalfH = internal.plateHeightM * 0.5;

  const localToWorld = (lx: number, ly: number, lz: number): Vec3Like => ({
    x: wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw,
    y: wall.centerWorld.y + ly,
    z: wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw,
  });

  let studChunkIdx = 0;
  for (let i = 0; i < internal.studColumns.length; i++) {
    const col = internal.studColumns[i];
    const lx = col.u - halfW;
    const spans = collectIntactStudSpans(col);
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s];
      const spanH = span.vMax - span.vMin;
      if (spanH < 0.01) continue;
      const ly = (span.vMin + span.vMax) * 0.5 - halfH;
      const studTag: ColliderSurfaceTag = {
        material: 'WOOD_STUD',
        objectId: wall.id,
        chunkIndex: studChunkIdx++,
        thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
        penetrationResistanceJ: 650,
      };
      handles.push(
        physicsWorld.createStaticBox(
          localToWorld(lx, ly, 0),
          { x: studHalfW, y: spanH * 0.5, z: studHalfD },
          wall.rotationQuat,
          studTag,
        ),
      );
    }
  }

  handles.push(
    physicsWorld.createStaticBox(
      localToWorld(0, -halfH + plateHalfH, 0),
      { x: halfW, y: plateHalfH, z: studHalfD },
      wall.rotationQuat,
      {
        material: 'WOOD_STUD',
        objectId: wall.id,
        chunkIndex: studChunkIdx++,
        thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
        penetrationResistanceJ: 650,
      },
    ),
  );
  handles.push(
    physicsWorld.createStaticBox(
      localToWorld(0, halfH - plateHalfH, 0),
      { x: halfW, y: plateHalfH, z: studHalfD },
      wall.rotationQuat,
      {
        material: 'WOOD_STUD',
        objectId: wall.id,
        chunkIndex: studChunkIdx++,
        thicknessM: DEFAULT_WOOD_STUD_DEPTH_M,
        penetrationResistanceJ: 650,
      },
    ),
  );
}

export function uploadWallStudFrameMesh(
  wall: WoodWallInstance,
  internal: WallInternalState,
): void {
  const counts = writeWallStudFrameBuffers(
    wall.widthM,
    wall.heightM,
    internal.visualStudDepthM,
    internal.plateHeightM,
    internal.studColumns,
    internal.studScratchBuffers,
    DEFAULT_WOOD_STUD_WIDTH_M,
  );
  if (counts.vertexCount <= 0 || counts.indexCount <= 0) {
    wall.studFrameEntity.enabled = false;
    return;
  }
  wall.studFrameEntity.enabled = true;
  const mesh = wall.studFrameMesh;
  const buf = internal.studScratchBuffers;
  mesh.setPositions(buf.positions, 3, counts.vertexCount);
  mesh.setNormals(buf.normals, 3, counts.vertexCount);
  mesh.setUvs(0, buf.uvs, 2, counts.vertexCount);
  mesh.setIndices(buf.indices, counts.indexCount);
  mesh.update(pc.PRIMITIVE_TRIANGLES, false);
}

export function isPointOverIntactStud(
  wall: WoodWallInstance,
  internal: WallInternalState,
  u: number,
  v: number,
  toleranceM = 0,
): boolean {
  if (
    u < -toleranceM ||
    u > wall.widthM + toleranceM ||
    v < -toleranceM ||
    v > wall.heightM + toleranceM
  ) {
    return false;
  }
  const halfStudW = DEFAULT_WOOD_STUD_WIDTH_M * 0.5 + toleranceM;
  const plateH = internal.plateHeightM;
  if (v <= plateH + toleranceM || v >= wall.heightM - plateH - toleranceM) return true;

  for (let i = 0; i < internal.studColumns.length; i++) {
    const col = internal.studColumns[i];
    if (Math.abs(u - col.u) <= halfStudW) {
      if (col.isBorderPost) return true;
      for (let s = 0; s < col.sections.length; s++) {
        const sec = col.sections[s];
        if (!sec.broken && v >= sec.vMin - toleranceM && v <= sec.vMax + toleranceM) {
          return true;
        }
      }
    }
  }
  return false;
}
