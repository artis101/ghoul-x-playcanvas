import * as pc from 'playcanvas';

/**
 * Extracts tightly packed local `Float32Array` `[x0, y0, z0, x1, y1, z1, ...]` positions from a `pc.Mesh`
 * for Rapier3D `ColliderDesc.convexHull(localVertices)`.
 */
export function extractMeshLocalVertices(mesh: pc.Mesh): Float32Array {
  const positions: number[] = [];
  mesh.getPositions(positions);
  return new Float32Array(positions);
}

export function findEntityByName(root: pc.Entity, name: string): pc.Entity | null {
  const node = root.findByName(name);
  return node instanceof pc.Entity ? node : null;
}

export function collectBoneNodes(root: pc.GraphNode, out: Map<string, pc.GraphNode>): void {
  if (root.name.startsWith('Bone_')) {
    out.set(root.name, root);
  }
  for (const child of root.children) {
    collectBoneNodes(child, out);
  }
}

const upgradedGlbMaterials = new WeakSet<pc.StandardMaterial>();
const upgradedGlbTextures = new WeakSet<pc.Texture>();

export function upgradeGlbTexture(tex: pc.Texture | null | undefined, maxAniso: number): void {
  if (!tex || upgradedGlbTextures.has(tex)) return;
  upgradedGlbTextures.add(tex);
  // Point-sampled textures (the painted character skins) are meant to show their texels.
  if (tex.magFilter === pc.FILTER_NEAREST) return;
  tex.anisotropy = maxAniso;
  if (tex.mipmaps) {
    tex.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
    tex.magFilter = pc.FILTER_LINEAR;
  }
}

export function upgradeGlbStandardMaterial(mat: pc.Material | null | undefined, device: pc.GraphicsDevice): void {
  if (!(mat instanceof pc.StandardMaterial) || upgradedGlbMaterials.has(mat)) return;
  upgradedGlbMaterials.add(mat);

  const maxAniso =
    device instanceof pc.NullGraphicsDevice
      ? 1
      : Math.max(1, Math.min(4, device.maxAnisotropy || 1));

  upgradeGlbTexture(mat.diffuseMap, maxAniso);
  upgradeGlbTexture(mat.normalMap, maxAniso);
  upgradeGlbTexture(mat.glossMap, maxAniso);
  upgradeGlbTexture(mat.metalnessMap, maxAniso);
  upgradeGlbTexture(mat.aoMap, maxAniso);
  upgradeGlbTexture(mat.emissiveMap, maxAniso);
  upgradeGlbTexture(mat.specularMap, maxAniso);

  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.useSkybox = true;
  if (mat.aoMap) {
    mat.occludeSpecular = pc.SPECOCC_GLOSSDEPENDENT;
  }
  if (mat.normalMap) {
    mat.bumpiness = Math.max(mat.bumpiness || 1.0, 1.22);
  }
  mat.update();
}

export function upgradeContainerPbrQuality(container: pc.ContainerResource, device: pc.GraphicsDevice): void {
  const maxAniso =
    device instanceof pc.NullGraphicsDevice
      ? 1
      : Math.max(1, Math.min(4, device.maxAnisotropy || 1));

  if (Array.isArray(container.textures)) {
    for (const texAsset of container.textures) {
      if (texAsset?.resource instanceof pc.Texture) {
        upgradeGlbTexture(texAsset.resource, maxAniso);
      }
    }
  }
  if (Array.isArray(container.materials)) {
    for (const matAsset of container.materials) {
      if (matAsset?.resource instanceof pc.StandardMaterial) {
        upgradeGlbStandardMaterial(matAsset.resource, device);
      }
    }
  }
}

export function upgradeEntityHierarchyPbr(root: pc.Entity, device: pc.GraphicsDevice): void {
  const renderComps = root.findComponents('render') as pc.RenderComponent[];
  for (const rc of renderComps) {
    for (const mi of rc.meshInstances) {
      upgradeGlbStandardMaterial(mi.material, device);
    }
  }
}
