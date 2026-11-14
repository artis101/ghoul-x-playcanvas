import type { Vec3Like } from '../../contracts/ballistics.ts';

const CAPACITY = 48;

/**
 * Line-of-sight answers for exact (from, to) pairs, kept for one AI update. A full memo
 * overwrites its oldest entry.
 */
export class SightQueryMemo {
  private readonly coords = new Float64Array(CAPACITY * 6);
  private readonly blocked = new Uint8Array(CAPACITY);
  private size = 0;
  private writeIndex = 0;

  public clear(): void {
    this.size = 0;
    this.writeIndex = 0;
  }

  public isBlocked(from: Vec3Like, to: Vec3Like, cast: (from: Vec3Like, to: Vec3Like) => boolean): boolean {
    const c = this.coords;
    for (let i = 0; i < this.size; i++) {
      const o = i * 6;
      if (c[o] === from.x && c[o + 1] === from.y && c[o + 2] === from.z &&
          c[o + 3] === to.x && c[o + 4] === to.y && c[o + 5] === to.z) {
        return this.blocked[i] === 1;
      }
    }
    const result = cast(from, to);
    const w = this.writeIndex;
    const o = w * 6;
    c[o] = from.x; c[o + 1] = from.y; c[o + 2] = from.z;
    c[o + 3] = to.x; c[o + 4] = to.y; c[o + 5] = to.z;
    this.blocked[w] = result ? 1 : 0;
    this.writeIndex = (w + 1) % CAPACITY;
    if (this.size < CAPACITY) this.size++;
    return result;
  }
}
