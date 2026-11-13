# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The architectural rules (file-size limits, layering, PlayCanvas conventions, GLB-only assets, verification discipline) live in AGENTS.md and are imported here:

@AGENTS.md

## Commands

```bash
npm run dev          # Vite dev server on 0.0.0.0:5173 (strictPort); also the "ghoul-x-dev" preview in .claude/launch.json
npx tsc --noEmit     # typecheck src/ and tests/ (tsconfig includes both)
npx vite build       # bundle check
npx vitest run tests/<name>.test.ts --pool=forks --poolOptions.forks.singleFork --no-file-parallelism   # one test file
npx vitest run tests/<name>.test.ts -t "<test name>"                                                   # one test case
```

There is no linter. `npm run build` / `npm run verify` / `npm test` run tsc plus the whole Vitest suite; per AGENTS.md §5, avoid the full suite on this machine and run targeted test files instead. There is no Vitest config file, so tests use Vitest defaults (Node environment).

## Routes

`src/entry.ts` picks a page from the URL path:
- `/` → `bootstrap()` in `src/main.ts` → the game.
- `/gm/characters` → Character Lab (`src/engine/gm/characterLab.ts`): plays the combatant GLB's animation clips with props, for checking poses and grips.
- `/gm/levels` → Level Lab (`src/engine/gm/levelLab.ts`).

## Runtime architecture

**Startup.** `runGamePreloader` (`src/engine/preloader/gamePreloader.ts`) creates the PlayCanvas app, loads every GLB through `GlbModelRegistry.preloadAll()`, warms shaders, and only then constructs `GhoulXApplication`. It reports progress through `preloader:*` app events and the DOM `PreloaderScreen`.

**Composition root.** `GhoulXApplication` (`src/engine/app/ghoulXApp.ts`) builds the subsystems as plain classes and shares them through `IGhoulXApp` (`appContext.ts`): `RapierPhysicsWorld`, `ArenaBuilder`, `MayhemDirector` (barrels, tracers, casings, explosion FX), `DestructionManager`, `TacticalCombatAiSystem`, `CombatDirector` (targets, shots, grenades, physiology, ragdolls), `GoreAndBallisticsFxManager`, `CombatAudioEngine`, `FpsController`, `ArsenalManager` and `HudController`. Cross-system callbacks are wired in the constructor and in `combatEventWiring.ts`. The remaining `*Script.ts` files are thin `pc.Script` wrappers around these classes; none is attached to an entity at runtime.

**Frame order** (`src/engine/app/engineUpdateLoop.ts`) matters when you add a system:
1. Player and arsenal update.
2. `mayhemDirector.update()`: barrels, lights, smoke, casings and tracer pools.
3. Audio listener and audio update.
4. `combatDirector.update()`: AI shots, grenades, physiology, ragdolls. Runs before the Rapier step.
5. `destructionManager.update()`: Rapier step and debris/instanced uploads, then `syncSurfaceBreaches()`.
6. Sniper rangefinder, HUD, FX.

**Shot path.** `handleTriggerPull` (`playerActionHandlers.ts`) → `CombatDirector.fireWeapon` → `weaponBallisticsRouter` / `shotgunPelletSolver` run the pure RK4 solver in `src/core/ballistics/` → hits reach `impactDamageDispatcher` → GHOUL zone trauma (`src/core/ghoul/`) and the physiology model (`src/core/physiology/`) → `physiologySyncAdapter` drives the mannequin, ragdoll and gore FX. Blasts go through `MayhemDirector.onExplosionBlast` into destruction, combat trauma and AI alerting.

**Core vs. engine.** `src/core/` holds the simulation (ballistics, anatomy and BVH, physiology, AI state machines, destruction geometry, audio DSP) and must stay free of `playcanvas` imports. `src/core/events.ts` only re-exports `src/contracts/events.ts`.

## Tests

- Tests live flat in `tests/` and import straight from `src/`. Engine-level tests (e.g. `full_integration.test.ts`) import real `playcanvas` and run the engine classes in Node without WebGL.
- `tests/blenderGlbFixtures.ts` parses the real `.glb` files in `public/models/` with `fs`. The `blender_*` tests check the shipped assets, so they fail if a GLB is re-exported with different bones, clips or meshes.

## Assets and Blender pipeline

- Shipped models are in `public/models/*.glb`. Their Blender sources are in `public/models/blend_sources/`, and the build/bake scripts are in `scripts/blender/`.
- Blender, the bakes and the Kimodo motion generator run on the `chonkster.local` host over SSH, not on this Mac. `scripts/blender/README.md` has the combatant animation bake, the loop-clip procedure and the export commands.
- Bone names follow `Bone_<PART>_<LEFT|RIGHT>`. Left and right are the character's own sides.
