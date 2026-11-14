import * as pc from 'playcanvas';

const ARENA_STATIC_BATCH_GROUP = 'ArenaStaticGeometry';
// Large enough that every piece of the hall can merge with every other piece of the same material.
const MAX_BATCH_AABB_M = 1000;

/**
 * Merges arena boxes that never move, hide or break into static batches, one draw per material
 * and shadow flag. Skipped on a headless device. Returns the batch group id, or null when nothing
 * was batched.
 */
export function batchStaticArenaEntities(app: pc.AppBase, entities: readonly pc.Entity[]): number | null {
  if (entities.length === 0) return null;
  if (app.graphicsDevice instanceof pc.NullGraphicsDevice) return null;
  const batcher = app.batcher as pc.BatchManager | null | undefined;
  if (!batcher) return null;
  const group = batcher.addGroup(ARENA_STATIC_BATCH_GROUP, false, MAX_BATCH_AABB_M);
  if (!group) return null;
  for (const entity of entities) {
    if (entity.render) entity.render.batchGroupId = group.id;
  }
  batcher.generate([group.id]);
  return group.id;
}

/** Destroys the static batches of a group made by batchStaticArenaEntities. */
export function releaseStaticArenaBatches(app: pc.AppBase, groupId: number | null): void {
  if (groupId === null) return;
  (app.batcher as pc.BatchManager | null | undefined)?.removeGroup(groupId);
}
