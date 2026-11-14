import * as pc from 'playcanvas';

/** Builds the render component and any fixed children of a pooled entity once, when the pool creates it. */
export type FxEntityBuilder = (entity: pc.Entity) => void;

const ownerByEntity = new WeakMap<pc.Entity, FxEntityPool>();

/**
 * Reusable short-lived FX entities of one kind. Entities are created lazily, parented once, and
 * disabled on release instead of destroyed, so steady-state spawning creates no entities,
 * components or mesh instances.
 */
export class FxEntityPool {
  private readonly all: pc.Entity[] = [];
  private readonly free: pc.Entity[] = [];
  private readonly freeSet = new Set<pc.Entity>();
  private destroyed = false;

  constructor(
    private readonly parent: pc.Entity,
    private readonly entityName: string,
    private readonly build: FxEntityBuilder,
  ) {}

  public get size(): number { return this.all.length; }
  public get liveCount(): number { return this.all.length - this.free.length; }

  /** Returns an enabled entity with an identity local transform (position 0, rotation identity, scale 1). */
  public acquire(): pc.Entity {
    let entity = this.free.pop();
    if (entity) {
      this.freeSet.delete(entity);
    } else {
      entity = new pc.Entity(this.entityName);
      this.build(entity);
      this.parent.addChild(entity);
      this.all.push(entity);
      ownerByEntity.set(entity, this);
    }
    entity.setLocalPosition(0, 0, 0);
    entity.setLocalRotation(pc.Quat.IDENTITY);
    entity.setLocalScale(1, 1, 1);
    entity.enabled = true;
    return entity;
  }

  public release(entity: pc.Entity): void {
    if (this.destroyed || ownerByEntity.get(entity) !== this || this.freeSet.has(entity)) return;
    entity.enabled = false;
    this.free.push(entity);
    this.freeSet.add(entity);
  }

  public releaseAll(): void {
    for (const entity of this.all) this.release(entity);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entity of this.all) {
      ownerByEntity.delete(entity);
      entity.destroy();
    }
    this.all.length = 0;
    this.free.length = 0;
    this.freeSet.clear();
  }
}

/** Returns a pooled entity to its pool; an entity no pool owns is destroyed. */
export function releaseFxEntity(entity: pc.Entity): void {
  const owner = ownerByEntity.get(entity);
  if (owner) owner.release(entity);
  else entity.destroy();
}

/** Releases the oldest records (index 0 first) until the list has room for one more. */
export function recycleOldestWhenFull<T extends { entity: pc.Entity }>(live: T[], cap: number): void {
  while (live.length >= cap) {
    const oldest = live.shift();
    if (!oldest) break;
    releaseFxEntity(oldest.entity);
  }
}
