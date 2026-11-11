import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import { findEntityByName, upgradeGlbStandardMaterial } from './materialUpgrade.ts';

export function instantiateDetachedHeadgearProp(
  app: pc.AppBase,
  container: pc.ContainerResource | null,
  archetype: EnemyArchetypeId,
  cache: Map<string, Array<{ mesh: pc.Mesh; material: pc.Material | null }>>
): pc.Entity | null {
  if (!container) return null;
  const gearNames: string[] =
    archetype === 'HEAVY_ENFORCER'
      ? ['Gear_PASGT_Helmet', 'Gear_TacticalVisor']
      : archetype === 'MILITIA_GUNNER'
        ? ['Gear_PASGT_Helmet']
        : archetype === 'SNIPER_OPERATIVE'
          ? ['Gear_SpetsnazBeret']
          : ['Gear_TacticalVisor'];

  const cacheKey = gearNames.join('+');
  let primitives = cache.get(cacheKey);

  if (!primitives) {
    const tempRoot = container.instantiateRenderEntity();
    try {
      const extracted: Array<{
        positions: number[];
        normals: number[];
        uvs: number[];
        indices: number[];
        material: pc.Material | null;
      }> = [];
      let sumX = 0; let sumY = 0; let sumZ = 0; let vertTotal = 0;
      for (const gName of gearNames) {
        const ent = findEntityByName(tempRoot, gName);
        if (!ent?.render) continue;
        for (const mi of ent.render.meshInstances) {
          const srcMesh = mi.mesh;
          if (!srcMesh) continue;
          const positions: number[] = []; const normals: number[] = [];
          const uvs: number[] = []; const indices: number[] = [];
          srcMesh.getPositions(positions);
          srcMesh.getNormals(normals);
          srcMesh.getUvs(0, uvs);
          srcMesh.getIndices(indices);
          if (positions.length === 0) continue;
          for (let i = 0; i < positions.length; i += 3) {
            sumX += positions[i]; sumY += positions[i + 1]; sumZ += positions[i + 2];
            vertTotal++;
          }
          extracted.push({ positions, normals, uvs, indices, material: mi.material ?? null });
        }
      }
      if (vertTotal === 0) return null;
      const cx = sumX / vertTotal; const cy = sumY / vertTotal; const cz = sumZ / vertTotal;
      primitives = extracted.map((item) => {
        const centered = new Array<number>(item.positions.length);
        for (let i = 0; i < item.positions.length; i += 3) {
          centered[i] = item.positions[i] - cx;
          centered[i + 1] = item.positions[i + 1] - cy;
          centered[i + 2] = item.positions[i + 2] - cz;
        }
        const mesh = new pc.Mesh(app.graphicsDevice);
        mesh.setPositions(centered);
        if (item.normals.length === centered.length) mesh.setNormals(item.normals);
        if (item.uvs.length === (centered.length / 3) * 2) mesh.setUvs(0, item.uvs);
        if (item.indices.length > 0) mesh.setIndices(item.indices);
        mesh.update();
        mesh.incRefCount();
        return { mesh, material: item.material };
      });
      cache.set(cacheKey, primitives);
    } finally {
      tempRoot.destroy();
    }
  }

  const propRoot = new pc.Entity(`DetachedHeadgear_${archetype}`);
  const meshInstances = primitives.map((p) => {
    const mat = p.material ?? new pc.StandardMaterial();
    upgradeGlbStandardMaterial(mat, app.graphicsDevice);
    return new pc.MeshInstance(p.mesh, mat);
  });
  propRoot.addComponent('render', { meshInstances, castShadows: true, receiveShadows: true });
  return propRoot;
}
