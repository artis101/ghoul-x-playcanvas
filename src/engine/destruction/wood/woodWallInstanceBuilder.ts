import * as pc from 'playcanvas';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import {
  createWoodPanelState,
  triangulateWoodPanelToBuffers,
  type WoodMeshScratchBuffers,
} from '../../../core/destruction/woodPolygonClipper.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  DEFAULT_WOOD_STUD_SPACING_M,
  DEFAULT_WOOD_STUD_WIDTH_M,
  MAX_STUD_FRAME_INDICES,
  MAX_STUD_FRAME_VERTICES,
  type WallInternalState,
  type WoodWallConfig,
  type WoodWallInstance,
} from './woodWallTypes.ts';
import {
  computeWallStudPositionsU,
  createInitialStudColumns,
  writeWallStudFrameBuffers,
} from './woodStudFrameBuilder.ts';
import {
  buildStudAnchorsFromColumns,
  rebuildWallStudColliders,
} from './woodStudColliderSync.ts';

export function createWoodWallInstance(
  app: pc.Application,
  physicsWorld: RapierPhysicsWorld,
  panelMaterial: pc.Material,
  studMaterial: pc.Material,
  maxPanelVertices: number,
  maxPanelIndices: number,
  config: WoodWallConfig,
): { instance: WoodWallInstance; internal: WallInternalState } {
  const widthM = Math.max(0.2, config.widthM ?? 2.4);
  const heightM = Math.max(0.2, config.heightM ?? 2.4);
  const thicknessM = Math.max(0.02, config.thicknessM ?? 0.08);
  const yawRad = config.yawRad ?? 0;
  const studSpacingM = Math.max(0.2, config.studSpacingM ?? DEFAULT_WOOD_STUD_SPACING_M);

  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  const rotationQuat: QuatLike = {
    x: 0,
    y: Math.sin(yawRad * 0.5),
    z: 0,
    w: Math.cos(yawRad * 0.5),
  };

  const centerWorld = {
    x: config.centerWorld.x,
    y: config.centerWorld.y,
    z: config.centerWorld.z,
  };

  const studPositionsU = computeWallStudPositionsU(widthM, studSpacingM);
  const halfW = widthM * 0.5;
  const halfH = heightM * 0.5;
  const plateH = Math.min(DEFAULT_WOOD_STUD_WIDTH_M, heightM * 0.2);
  const visualStudDepthM = Math.max(0.014, thicknessM - 0.006);

  const studColumns = createInitialStudColumns(heightM, plateH, studPositionsU);
  const mutableStudColliderHandles: number[] = [];

  const drywallHalfZ = Math.max(0.012, thicknessM * 0.25);
  const drywallTag: ColliderSurfaceTag = {
    material: 'WOOD_DRYWALL',
    objectId: config.id,
    thicknessM,
    penetrationResistanceJ: 140,
  };
  const drywallColliderHandle = physicsWorld.createStaticBox(
    centerWorld,
    { x: halfW, y: halfH, z: drywallHalfZ },
    rotationQuat,
    drywallTag,
  );

  const scratchBuffers: WoodMeshScratchBuffers = {
    positions: new Float32Array(maxPanelVertices * 3),
    normals: new Float32Array(maxPanelVertices * 3),
    uvs: new Float32Array(maxPanelVertices * 2),
    indices: maxPanelVertices <= 65535 ? new Uint16Array(maxPanelIndices) : new Uint32Array(maxPanelIndices),
  };

  const studScratchBuffers: WoodMeshScratchBuffers = {
    positions: new Float32Array(MAX_STUD_FRAME_VERTICES * 3),
    normals: new Float32Array(MAX_STUD_FRAME_VERTICES * 3),
    uvs: new Float32Array(MAX_STUD_FRAME_VERTICES * 2),
    indices: new Uint16Array(MAX_STUD_FRAME_INDICES),
  };

  const panelState = createWoodPanelState(widthM, heightM, thicknessM);
  panelState.studAnchors = buildStudAnchorsFromColumns(studColumns);
  const initialStats = triangulateWoodPanelToBuffers(panelState, scratchBuffers);

  const panelMesh = new pc.Mesh(app.graphicsDevice);
  panelMesh.clear(true, true, maxPanelVertices, maxPanelIndices);
  panelMesh.setPositions(scratchBuffers.positions, 3, initialStats.vertexCount);
  panelMesh.setNormals(scratchBuffers.normals, 3, initialStats.vertexCount);
  panelMesh.setUvs(0, scratchBuffers.uvs, 2, initialStats.vertexCount);
  panelMesh.setIndices(scratchBuffers.indices, initialStats.indexCount);
  panelMesh.update(pc.PRIMITIVE_TRIANGLES, true);
  panelMesh.incRefCount();

  const studCounts = writeWallStudFrameBuffers(
    widthM,
    heightM,
    visualStudDepthM,
    plateH,
    studColumns,
    studScratchBuffers,
    DEFAULT_WOOD_STUD_WIDTH_M,
  );
  const studFrameMesh = new pc.Mesh(app.graphicsDevice);
  studFrameMesh.clear(true, true, MAX_STUD_FRAME_VERTICES, MAX_STUD_FRAME_INDICES);
  studFrameMesh.setPositions(studScratchBuffers.positions, 3, studCounts.vertexCount);
  studFrameMesh.setNormals(studScratchBuffers.normals, 3, studCounts.vertexCount);
  studFrameMesh.setUvs(0, studScratchBuffers.uvs, 2, studCounts.vertexCount);
  studFrameMesh.setIndices(studScratchBuffers.indices, studCounts.indexCount);
  studFrameMesh.update(pc.PRIMITIVE_TRIANGLES, false);
  studFrameMesh.incRefCount();

  const rootEntity = new pc.Entity(`WoodWall_${config.id}`);
  rootEntity.setPosition(centerWorld.x, centerWorld.y, centerWorld.z);
  rootEntity.setRotation(rotationQuat.x, rotationQuat.y, rotationQuat.z, rotationQuat.w);

  const horizSpan = widthM * 0.5 + thicknessM + 0.2;
  const wallCustomAabb = new pc.BoundingBox(
    new pc.Vec3(centerWorld.x, centerWorld.y, centerWorld.z),
    new pc.Vec3(horizSpan, heightM * 0.5 + 0.2, horizSpan),
  );

  const panelEntity = new pc.Entity(`WoodWallPanel_${config.id}`);
  const panelMi = new pc.MeshInstance(panelMesh, panelMaterial);
  panelEntity.addComponent('render', {
    meshInstances: [panelMi],
    castShadows: true,
    receiveShadows: true,
  });
  if (panelEntity.render) panelEntity.render.customAabb = wallCustomAabb;
  rootEntity.addChild(panelEntity);

  const studFrameEntity = new pc.Entity(`WoodWallStuds_${config.id}`);
  const studMi = new pc.MeshInstance(studFrameMesh, studMaterial);
  studFrameEntity.addComponent('render', {
    meshInstances: [studMi],
    castShadows: true,
    receiveShadows: true,
  });
  if (studFrameEntity.render) studFrameEntity.render.customAabb = wallCustomAabb;
  rootEntity.addChild(studFrameEntity);

  app.root.addChild(rootEntity);

  const instance: WoodWallInstance = {
    id: config.id,
    centerWorld,
    widthM,
    heightM,
    thicknessM,
    yawRad,
    studSpacingM,
    cosYaw,
    sinYaw,
    rotationQuat,
    studPositionsU,
    drywallColliderHandle,
    studColliderHandles: mutableStudColliderHandles,
    rootEntity,
    panelEntity,
    studFrameEntity,
    panelMesh,
    studFrameMesh,
    panelState,
    scratchBuffers,
    lastMeshStats: initialStats,
  };

  const internal: WallInternalState = {
    studColumns,
    mutableStudColliderHandles,
    studScratchBuffers,
    visualStudDepthM,
    plateHeightM: plateH,
    activeVolley: null,
  };

  rebuildWallStudColliders(physicsWorld, instance, internal);
  return { instance, internal };
}
