import { describe, expect, it } from 'vitest';
import { FrameSlicedWorkQueue } from '../src/engine/combat/frameSlicedWorkQueue.ts';

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

describe('FrameSlicedWorkQueue', () => {
  it('runs work on the spot when it has no budget', () => {
    const queue = new FrameSlicedWorkQueue();
    const ran: string[] = [];
    queue.defer(() => ran.push('a'));
    queue.deferFirst(() => ran.push('b'));
    expect(ran).toEqual(['a', 'b']);
    expect(queue.pendingCount).toBe(0);
  });

  it('holds work until drained, and starts no more once the budget is spent', () => {
    const queue = new FrameSlicedWorkQueue();
    queue.budgetMs = 2;
    const ran: string[] = [];
    queue.defer(() => { ran.push('slow'); busyWait(4); });
    queue.defer(() => ran.push('next'));
    expect(ran).toEqual([]);

    queue.drain();
    expect(ran).toEqual(['slow']);
    queue.drain();
    expect(ran).toEqual(['slow', 'next']);
    expect(queue.pendingCount).toBe(0);
  });

  it('runs several cheap jobs in one drain, front-queued work first', () => {
    const queue = new FrameSlicedWorkQueue();
    queue.budgetMs = 50;
    const ran: string[] = [];
    queue.defer(() => ran.push('body-1'));
    queue.defer(() => ran.push('body-2'));
    queue.deferFirst(() => ran.push('walls'));
    queue.drain();
    expect(ran).toEqual(['walls', 'body-1', 'body-2']);
  });

  it('runs work queued by a job, and drops everything on clear', () => {
    const queue = new FrameSlicedWorkQueue();
    queue.budgetMs = 50;
    const ran: string[] = [];
    queue.defer(() => { ran.push('barrel'); queue.defer(() => ran.push('chain')); });
    queue.drain();
    expect(ran).toEqual(['barrel', 'chain']);

    queue.defer(() => ran.push('stale'));
    queue.clear();
    queue.drain();
    expect(ran).toEqual(['barrel', 'chain']);
  });
});
