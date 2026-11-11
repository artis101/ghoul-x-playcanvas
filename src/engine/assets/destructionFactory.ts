import * as pc from 'playcanvas';
import type { ConcreteWallConnectivityGraphJson, DebrisPackBundle, FracturedConcreteWallBundle } from './glbTypes.ts';
import { extractMeshLocalVertices, findEntityByName, upgradeEntityHierarchyPbr } from './materialUpgrade.ts';

export function extractFracturedConcreteBundle(
  app: pc.AppBase,
  container: pc.ContainerResource,
  connectivityGraph: ConcreteWallConnectivityGraphJson
): FracturedConcreteWallBundle {
  const tempRoot = container.instantiateRenderEntity();
  upgradeEntityHierarchyPbr(tempRoot, app.graphicsDevice);
  try {
    const intactEnt = findEntityByName(tempRoot, 'IntactConcreteWall');
    const intactMi = intactEnt?.render?.meshInstances?.[0];
    if (!intactMi || !intactMi.mesh) {
      throw new Error('IntactConcreteWall meshInstance missing in concrete_wall_fractured.glb');
    }

    const intactWallMesh = intactMi.mesh;
    const intactWallMaterial = intactMi.material ?? null;

    const chunkMeshes: pc.Mesh[] = [];
    const chunkLocalVertices: Float32Array[] = [];
    let chunkMaterial: pc.Material | null = null;

    for (const node of connectivityGraph.nodes) {
      const chunkEnt = findEntityByName(tempRoot, node.name);
      const mi = chunkEnt?.render?.meshInstances?.[0];
      if (!mi || !mi.mesh) {
        throw new Error(`Missing meshInstance for ${node.name} in concrete_wall_fractured.glb`);
      }
      chunkMeshes.push(mi.mesh);
      chunkLocalVertices.push(extractMeshLocalVertices(mi.mesh));
      if (!chunkMaterial && mi.material) chunkMaterial = mi.material;
    }

    intactWallMesh.incRefCount();
    for (const m of chunkMeshes) m.incRefCount();

    return {
      intactWallMesh,
      intactWallMaterial,
      chunkMeshes,
      chunkMaterial,
      chunkLocalVertices,
      connectivity: connectivityGraph,
    };
  } finally {
    tempRoot.destroy();
  }
}

export function extractDebrisPackBundle(
  app: pc.AppBase,
  container: pc.ContainerResource
): DebrisPackBundle {
  const tempRoot = container.instantiateRenderEntity();
  upgradeEntityHierarchyPbr(tempRoot, app.graphicsDevice);
  try {
    const brickMeshes: pc.Mesh[] = [];
    const brickLocalVertices: Float32Array[] = [];
    let brickMaterial: pc.Material | null = null;

    for (let i = 0; i < 3; i++) {
      const name = `Brick_${i}`;
      const ent = findEntityByName(tempRoot, name);
      const mi = ent?.render?.meshInstances?.[0];
      if (!mi || !mi.mesh) throw new Error(`Missing ${name} meshInstance in debris_pack.glb`);
      mi.mesh.incRefCount();
      brickMeshes.push(mi.mesh);
      brickLocalVertices.push(extractMeshLocalVertices(mi.mesh));
      if (!brickMaterial && mi.material) brickMaterial = mi.material;
    }

    const splinterMeshes: pc.Mesh[] = [];
    const splinterLocalVertices: Float32Array[] = [];
    let splinterMaterial: pc.Material | null = null;

    for (let i = 0; i < 3; i++) {
      const name = `Splinter_${i}`;
      const ent = findEntityByName(tempRoot, name);
      const mi = ent?.render?.meshInstances?.[0];
      if (!mi || !mi.mesh) throw new Error(`Missing ${name} meshInstance in debris_pack.glb`);
      mi.mesh.incRefCount();
      splinterMeshes.push(mi.mesh);
      splinterLocalVertices.push(extractMeshLocalVertices(mi.mesh));
      if (!splinterMaterial && mi.material) splinterMaterial = mi.material;
    }

    return {
      brickMeshes,
      brickMaterial,
      brickLocalVertices,
      splinterMeshes,
      splinterMaterial,
      splinterLocalVertices,
    };
  } finally {
    tempRoot.destroy();
  }
}
