# GHOUL-X PlayCanvas — Agentic Coding & Architectural Guidelines

This document is the single canonical source of truth for all human developers and AI coding agents working on the GHOUL-X codebase. All additions, modifications, and refactors must strictly follow these principles.

---

## 1. File Size & Modularity Guardrails

- **Target File Size**: Aim for **80–250 LOC** per file. Modules up to **~300 LOC** are acceptable when a single algorithm, state machine, or mathematical solver is genuinely cohesive.
- **Hard Ceiling (450 LOC)**: Any file exceeding **450 LOC** is considered architectural debt and code smell. It must be decomposed into focused submodules before landing changes. Always verify with `wc -l`.
- **Single Responsibility Principle (SRP)**:
  - Exactly **one** PlayCanvas `pc.Script` component class (`export class MyScript extends pc.Script`) per file.
  - Exactly **one** pure algorithmic pass, solver function family, or focused data contract per module.
  - Monolithic god classes/files (e.g. legacy `*Director.ts` or `*System.ts` with thousands of lines) are strictly forbidden. Use lean coordinator facades that assemble cohesive sub-units.
- **Clean Barrel Exports**: Maintain lightweight barrel files (5–30 LOC) at folder roots for backwards-compatible public APIs, avoiding circular imports.

---

## 2. Strict Architectural Layering

The codebase enforces a unidirectional dependency hierarchy:
`src/contracts/` ➔ `src/core/` ➔ `src/engine/`

### 2.1. `src/contracts/` (Data & Event Schemas)
- Houses shared TypeScript interfaces, type aliases, enums, and constants.
- Contains the master event bus contracts (`src/contracts/events.ts`) using canonical `namespace:action` payloads.
- **Type-Only Re-exports**: Always use `export type { ... }` when re-exporting interfaces to ensure full compatibility with TypeScript `isolatedModules` and Vite bundling.
- **Path Resolution**: Double-check relative import depth when moving files into subfolders (e.g. `../../../contracts/...`). Avoid ambiguous duplicate `export *` collisions in barrel files.
- **Zero Engine Imports**: Never import `playcanvas` or runtime DOM APIs in contracts.

### 2.2. `src/core/` (Pure Simulation & Math)
- **100% Engine-Agnostic Pure TypeScript**: All terminal ballistics, GHOUL anatomical hierarchies, BVH queries, physiological trauma models, Voronoi/Clipper2 fracture math, and WebAudio DSP logic reside here.
- **Zero `playcanvas` Imports**: Pure core modules must run in headless environments (Node.js/Vitest) without DOM, WebGL, or PlayCanvas stubs. Never import `playcanvas` in `src/core/`.
- All spatial math relies on engine-agnostic vector/quaternion primitives (`Vec3Like`, `QuatLike`) from `src/core/ballistics/vec3.ts` and `src/contracts/`.

### 2.3. `src/engine/` (PlayCanvas & Rapier Runtime)
- Houses PlayCanvas 2.4+ ES6 script components, Rapier3D physics adapters, GPU instanced rendering pools, audio engine wrappers, and HTML5 DOM HUD controllers.
- Integrates preloaded `.glb` assets and handles input, rendering, and scene graph composition.

---

## 3. PlayCanvas Best Practices & Script Conventions

- **Component Declaration**: Use modern PlayCanvas 2.4+ ES6 classes:
  ```ts
  export class MyControllerScript extends pc.Script {
    // Component logic
  }
  pc.registerScript(MyControllerScript, 'myControllerScript');
  ```
- **JSDoc Attributes**: Declare `@attribute` properties at the top of script classes for editor visibility and schema documentation.
- **Event-Driven Decoupling**:
  - Prefer strongly-typed event communication (`this.app.fire('namespace:action', payload)`) over direct cross-system hard references.
  - **Never invoke `findByName` or `findComponents` inside `update(dt)`** loops. Cache node, entity, and component references in `initialize()`.
- **Lifecycle & Resource Cleanup**:
  - Always track event listeners registered in `initialize()`.
  - Remove all listeners and release allocated GPU/physics resources in `destroy()` (e.g. via an array of cleanup callbacks `_eventCleanups`).
  - Implement `swap(old)` on stateful scripts to support safe hot-reloading during live debugging.

---

## 4. GLB-Only 3D Assets Policy (Zero Procedural Base Models)

- **Strict Ban on Procedural Base Meshes**: All player weapons, combatant bodies, tactical gear/helmets, grenades, destructible concrete/brick walls, and debris props must use sculpted `.glb` models from `public/models/`. Procedural fallback generation (e.g. legacy `retroMeshBuilder`) is permanently eliminated.
- **Preload Upfront in Bootstrap**:
  - Load all 8 canonical `.glb` assets in `bootstrap()` via `await glbRegistry.preloadAll()` **before** instantiating scene entities.
  - Scene systems can assume all models exist, eliminating dual-mode live-upgrade scaffolding (`attachGlbRegistry`, `upgradeWithGlbAssets`, `upgradeTargetsWithGlb`).
- **Headless Unit Testing**: For tests running in environments without network/GLB access, construct clean meshless `pc.Entity` transform/bone hierarchies. Never reintroduce procedural fallback mesh generators.
- **Distinction Between Base Models vs. Dynamic Fracture**: This rule applies to static baseline meshes. Real-time procedural destruction cuts (Clipper2 polygon holes, Voronoi dynamic glass shards, blood decal geometry) remain valid runtime simulations.

---

## 5. Hardware-Smart Verification & Swarm Rules (MacBook Neo Mode)

To ensure rapid, deterministic iteration without choking memory or CPU cores on resource-constrained development machines (such as 8GB/16GB unified-memory laptops):

### 5.1. Banned Commands in Parallel Swarm Turns
- **NEVER run full test suites (`npm test`, `vitest run` across all files) or E2E tests inside worker agent turns.** Parallel Node forks combined with Rapier WASM physics instances starve CPU/RAM and cause agent stalls.
- **NEVER run `npx vite build` or `npx tsc` concurrently across multiple swarm workers.**

### 5.2. Primary Verification Gates
When validating code changes, use this staged, single-threaded pipeline:
1. **Line Count Audit**:
   ```bash
   find src -type f \( -name '*.ts' -o -name '*.js' \) | xargs wc -l | sort -nr | head -n 25
   ```
   Verify no file exceeds the 450 LOC ceiling.
2. **Typecheck (Single Process)**:
   ```bash
   npx tsc --noEmit
   ```
   Validates 100% of types, imports, and exports across both `src/` and `tests/` in a single lightweight pass.
3. **Bundle Build (Single Process)**:
   ```bash
   npx vite build
   ```
   Validates the ES module graph, bundling, and asset pipelines.
4. **Targeted Tests Only**:
   If verifying a specific runtime behavior, execute only the relevant test file in a single fork:
   ```bash
   npx vitest run tests/<target>.test.ts --pool=forks --poolOptions.forks.singleFork --no-file-parallelism
   ```

### 5.3. Multi-Agent & Swarm Execution Discipline
- **Disjoint Workspaces**: Assign strictly non-overlapping directory paths to parallel workers (e.g. author A owns `src/engine/physics/`, author B owns `src/engine/audio/`).
- **Concurrency Capping**: Cap active worker turns to a maximum of 2–3 simultaneous agents. Stagger execution waves.
- **Role Separation**: Authors write code and check line counts; a single Verifier agent runs compiler and bundle checks after authors conclude. Authors fix reported issues directly.
