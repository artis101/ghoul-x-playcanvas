import * as pc from 'playcanvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { AMMO_556_NATO_M855, WEAPON_M4A1 } from '../src/core/ballistics/weapons.ts';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import type { Vec3Like } from '../src/contracts/ballistics.ts';
import { GhoulXApplication } from '../src/engine/app/ghoulXApp.ts';
import { onEngineUpdate } from '../src/engine/app/engineUpdateLoop.ts';
import { BARREL_BLAST_PROFILE, fanOutBlast } from '../src/engine/app/blastFanout.ts';
import { GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import { initRapierPhysics } from '../src/engine/physics/rapierWorld.ts';

// Net add/remove count per `${'window'|'document'}:${type}`; a balanced teardown leaves every entry at 0.
const listenerLedger = new Map<string, number>();

function ledgerTarget(scope: 'window' | 'document'): {
  addEventListener: (type: string) => void;
  removeEventListener: (type: string) => void;
} {
  const bump = (type: string, delta: number): void => {
    const key = `${scope}:${type}`;
    listenerLedger.set(key, (listenerLedger.get(key) ?? 0) + delta);
  };
  return { addEventListener: (type) => bump(type, 1), removeEventListener: (type) => bump(type, -1) };
}

async function withCountingFakeDom<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = { getElementById: () => null, ...ledgerTarget('document') };
  g.window = { ...ledgerTarget('window'), location: { reload: () => {} }, performance: globalThis.performance };
  try {
    return await fn();
  } finally {
    g.document = prevDoc;
    g.window = prevWin;
  }
}

function createHeadlessApp(): { canvas: HTMLCanvasElement; app: pc.Application } {
  const canvasStub = { width: 640, height: 480, addEventListener: () => {}, removeEventListener: () => {}, requestPointerLock: () => {} };
  const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, { graphicsDevice: new pc.NullGraphicsDevice(canvasStub) });
  return { canvas: canvasStub as unknown as HTMLCanvasElement, app };
}

function stepFrames(ghoul: GhoulXApplication, n: number): void {
  for (let i = 0; i < n; i++) onEngineUpdate(ghoul, 1 / 60);
}

function firstTargetPosition(ghoul: GhoulXApplication): Vec3Like | null {
  const target = ghoul.combatDirector.targets[0];
  if (!target) return null;
  const p = target.rootEntity.getPosition();
  return vec3(p.x, p.y, p.z);
}

function fireOneShot(ghoul: GhoulXApplication): void {
  const eye = ghoul.fpsController.getEyePosition();
  const origin = vec3(eye.x, eye.y, eye.z);
  const targetPos = firstTargetPosition(ghoul);
  const dir = targetPos ? normalize(sub(targetPos, origin)) : vec3(0, 0, -1);
  ghoul.combatDirector.fireWeapon(WEAPON_M4A1, AMMO_556_NATO_M855, origin, dir);
}

function blastNear(ghoul: GhoulXApplication, center: Vec3Like): void {
  fanOutBlast(ghoul, { centerWorld: center, radiusM: 4, peakImpulseNs: 150, peakEnergyJ: 1600 }, BARREL_BLAST_PROFILE);
}

function rootChildNamesBeyond(app: pc.Application, baseline: number): string[] {
  return app.root.children.slice(baseline).map((c) => c.name);
}

describe('GhoulXApplication teardown', () => {
  beforeAll(async () => { await initRapierPhysics(); });

  it('tears the whole runtime down and rebuilds it on the same app', async () => {
    await withCountingFakeDom(async () => {
      const { canvas, app } = createHeadlessApp();
      try {
        const baselineRootChildren = app.root.children.length;
        // The pc.Application registers its own document listeners at creation; those are out of scope.
        listenerLedger.clear();

        const first = new GhoulXApplication(canvas, app, new GlbModelRegistry(app));
        stepFrames(first, 3);
        fireOneShot(first);
        stepFrames(first, 5);
        const eye = first.fpsController.getEyePosition();
        const targetPos = firstTargetPosition(first) ?? vec3(eye.x, eye.y, eye.z - 1.5);
        blastNear(first, vec3(targetPos.x, targetPos.y, targetPos.z + 1.5));
        stepFrames(first, 10);

        expect(() => first.destroy()).not.toThrow();
        expect(first.lifecycleState.kind).toBe('DESTROYED');
        expect(() => first.destroy()).not.toThrow();

        const leftover = rootChildNamesBeyond(app, baselineRootChildren);
        expect(leftover, `entities left under app.root: ${leftover.join(', ')}`).toEqual([]);

        const unbalanced = [...listenerLedger].filter(([, n]) => n !== 0);
        expect(unbalanced, JSON.stringify(unbalanced)).toEqual([]);

        const second = new GhoulXApplication(canvas, app, new GlbModelRegistry(app));
        stepFrames(second, 3);
        fireOneShot(second);
        stepFrames(second, 5);
        expect(second.combatDirector.targets.length).toBeGreaterThan(0);
        expect(() => second.destroy()).not.toThrow();

        const leftoverSecond = rootChildNamesBeyond(app, baselineRootChildren);
        expect(leftoverSecond, `entities left under app.root after rebuild: ${leftoverSecond.join(', ')}`).toEqual([]);
      } finally {
        app.destroy();
      }
    });
  }, 60_000);
});
