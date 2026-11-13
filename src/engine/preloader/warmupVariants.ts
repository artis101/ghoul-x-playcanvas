import * as pc from 'playcanvas';

/**
 * PlayCanvas picks a shader program per material *and* per mesh shape: which vertex streams the
 * mesh has, whether it is skinned or instanced, and whether it receives shadows. A program warmed
 * for one shape is useless for another, so the warm-up must draw each material on the shapes the
 * game really uses, or the first shot / hit / explosion compiles them mid-frame.
 */
export interface WarmupDraw {
  readonly meshInstance: pc.MeshInstance;
  /** A render component stamps its own shadow flags on its mesh instances, so draws are grouped by them. */
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
  /** Undo any state borrowed from a live mesh instance before the warm-up instance is destroyed. */
  readonly release: () => void;
}

interface ShapedMeshInstance {
  _shaderDefs?: number;
}

interface BorrowedMorph {
  _morphInstance: pc.MorphInstance | null;
}

function shapeKey(mi: pc.MeshInstance): string {
  const defs = (mi as unknown as ShapedMeshInstance)._shaderDefs ?? 0;
  return `${mi.material?.id ?? -1}:${defs}:${mi.castShadow ? 1 : 0}`;
}

/** Every mesh instance the scene owns, visible or not: pooled and disabled FX count too. */
export function collectSceneMeshInstances(app: pc.AppBase): pc.MeshInstance[] {
  const byShape = new Map<string, pc.MeshInstance>();
  const add = (mi: pc.MeshInstance | null | undefined): void => {
    if (!mi?.mesh || !mi.material) return;
    const key = shapeKey(mi);
    if (!byShape.has(key)) byShape.set(key, mi);
  };

  const stack: pc.GraphNode[] = [app.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const meshInstances = (node as pc.Entity).render?.meshInstances;
    if (Array.isArray(meshInstances)) meshInstances.forEach(add);
    for (const child of node.children) stack.push(child);
  }
  // Pools that push mesh instances straight into a layer never appear on a render component.
  for (const layer of app.scene.layers.layerList) {
    layer.meshInstances?.forEach(add);
  }
  return Array.from(byShape.values());
}

/** Puts the draws under `parent` on render components, one per shadow-flag combination. */
export function stageWarmupDraws(parent: pc.Entity, draws: readonly WarmupDraw[]): void {
  const groups = new Map<number, WarmupDraw[]>();
  for (const draw of draws) {
    const key = (draw.castShadows ? 1 : 0) | (draw.receiveShadows ? 2 : 0);
    const group = groups.get(key);
    if (group) group.push(draw);
    else groups.set(key, [draw]);
  }
  for (const group of groups.values()) {
    const holder = new pc.Entity('WarmupDrawGroup');
    parent.addChild(holder);
    holder.addComponent('render', {
      meshInstances: group.map((d) => d.meshInstance),
      castShadows: group[0].castShadows,
      receiveShadows: group[0].receiveShadows,
    });
  }
}

/** A stand-in that draws `material` on the live instance's own mesh, skin and instancing layout. */
export function createShapeMatchedDraw(
  live: pc.MeshInstance,
  material: pc.Material,
  fallbackInstancingVb: pc.VertexBuffer
): WarmupDraw {
  const mi = new pc.MeshInstance(live.mesh!, material);
  mi.cull = false;
  mi.screenSpace = live.screenSpace;
  if (live.skinInstance) mi.skinInstance = live.skinInstance;
  // Morph targets (body builds) select their own program, so a wounded morphing body part needs
  // its blood-soaked material warmed with the morph attached, not just the skin.
  if (live.morphInstance) mi.morphInstance = live.morphInstance;
  const instanced = Boolean(live.instancingData);
  if (instanced) {
    mi.setInstancing(live.instancingData?.vertexBuffer ?? fallbackInstancingVb);
    mi.instancingCount = 1;
  }
  return {
    meshInstance: mi,
    castShadows: live.castShadow,
    receiveShadows: live.receiveShadow,
    release: () => {
      // The skin, morph and instancing buffer belong to the live instance; detach so destroy() spares them.
      if (mi.skinInstance) mi.skinInstance = null;
      // The morphInstance setter destroys the instance it replaces, so clear the field itself.
      (mi as unknown as BorrowedMorph)._morphInstance = null;
      if (instanced) mi.setInstancing(null);
    },
  };
}

function createQuadMesh(device: pc.GraphicsDevice, withUv1: boolean): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions(new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0.4, 0.4, 0, -0.4, 0.4, 0]));
  mesh.setNormals(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  mesh.setUvs(0, uvs);
  if (withUv1) mesh.setUvs(1, uvs);
  mesh.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  mesh.incRefCount();
  return mesh;
}

/**
 * Stand-in meshes for effects that are spawned on demand and so have no live instance to copy.
 * Those are built from PlayCanvas primitives (`type: 'sphere' | 'plane' | 'box'`), which carry
 * position, normal and two UV sets; a few use hand-built meshes with a single UV set.
 */
export class PrimitiveShapeWarmup {
  private readonly primitiveQuad: pc.Mesh;
  private readonly singleUvQuad: pc.Mesh;

  public constructor(device: pc.GraphicsDevice) {
    this.primitiveQuad = createQuadMesh(device, true);
    this.singleUvQuad = createQuadMesh(device, false);
  }

  public createDraws(material: pc.Material): WarmupDraw[] {
    const draws: WarmupDraw[] = [];
    const push = (mesh: pc.Mesh, shadows: boolean): void => {
      const mi = new pc.MeshInstance(mesh, material);
      mi.cull = false;
      draws.push({
        meshInstance: mi,
        castShadows: shadows,
        receiveShadows: shadows,
        release: () => undefined,
      });
    };
    push(this.primitiveQuad, true);
    push(this.primitiveQuad, false);
    push(this.singleUvQuad, true);
    return draws;
  }

  public destroy(): void {
    this.primitiveQuad.destroy();
    this.singleUvQuad.destroy();
  }
}
