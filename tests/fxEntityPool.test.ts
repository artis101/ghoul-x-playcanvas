import { describe, it, expect } from 'vitest';
import * as pc from 'playcanvas';
import { FxEntityPool, recycleOldestWhenFull, releaseFxEntity } from '../src/engine/fx/particles/fxEntityPool.ts';

function createPool() {
  const parent = new pc.Entity('PoolTestRoot');
  // Stands in for app.root, which the application marks enabled-in-hierarchy; without it
  // Entity.enabled always reads false for children of a detached parent.
  (parent as unknown as { _enabledInHierarchy: boolean })._enabledInHierarchy = true;
  const counter = { builds: 0 };
  const pool = new FxEntityPool(parent, 'PooledThing', () => { counter.builds += 1; });
  return { parent, pool, counter };
}

describe('FxEntityPool', () => {
  it('creates a named, parented, enabled entity and builds it once', () => {
    const { parent, pool, counter } = createPool();
    const entity = pool.acquire();
    expect(entity.name).toBe('PooledThing');
    expect(entity.parent).toBe(parent);
    expect(entity.enabled).toBe(true);
    expect(counter.builds).toBe(1);
  });

  it('reuses a released entity with a reset local transform', () => {
    const { pool, counter } = createPool();
    const first = pool.acquire();
    first.setLocalPosition(1, 2, 3);
    first.setLocalScale(4, 4, 4);
    first.setLocalEulerAngles(30, 60, 90);
    pool.release(first);
    expect(first.enabled).toBe(false);
    const second = pool.acquire();
    expect(second).toBe(first);
    expect(counter.builds).toBe(1);
    const p = second.getLocalPosition();
    const s = second.getLocalScale();
    const r = second.getLocalRotation();
    expect([p.x, p.y, p.z]).toEqual([0, 0, 0]);
    expect([s.x, s.y, s.z]).toEqual([1, 1, 1]);
    expect([r.x, r.y, r.z, r.w]).toEqual([0, 0, 0, 1]);
  });

  it('ignores a double release so the free list has no duplicates', () => {
    const { pool } = createPool();
    const first = pool.acquire();
    pool.release(first);
    pool.release(first);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a).toBe(first);
    expect(b).not.toBe(first);
  });

  it('releaseAll leaves nothing live and every entity disabled', () => {
    const { pool } = createPool();
    const entities = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(pool.liveCount).toBe(3);
    pool.releaseAll();
    expect(pool.liveCount).toBe(0);
    expect(pool.size).toBe(3);
    for (const e of entities) expect(e.enabled).toBe(false);
  });

  it('releaseFxEntity returns a pooled entity to its own pool', () => {
    const { pool } = createPool();
    const entity = pool.acquire();
    expect(pool.liveCount).toBe(1);
    releaseFxEntity(entity);
    expect(pool.liveCount).toBe(0);
  });

  it('recycleOldestWhenFull releases the first record when at the cap', () => {
    const { pool } = createPool();
    const live = [{ entity: pool.acquire() }, { entity: pool.acquire() }, { entity: pool.acquire() }];
    const first = live[0];
    recycleOldestWhenFull(live, 3);
    expect(live.length).toBe(2);
    expect(live).not.toContain(first);
    expect(first.entity.enabled).toBe(false);
  });
});
