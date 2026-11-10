# AGENTIC_BOOTSTRAP.md — Argon -> Flash -> Argon Protocol

## 1. Mission Statement
We are building **Project GHOUL-X**: a first-principles recreation of **Soldier of Fortune (2000)** combined with **Sniper Elite's external, terminal, and X-Ray wound ballistics** in **PlayCanvas + TypeScript**.

## 2. Agent Roles
- **Argon (Architect & Verifier)**:
  - Owns `src/contracts/` (immutable data contracts and mathematical invariants).
  - Delegates bounded, parallelizable implementation units to `flash_coder` (`Model: 'flash'`).
  - Runs `npm run verify` (`tsc --noEmit && vitest run`) and inspects runtime telemetry to validate Flash's work.
  - Iterates with `flash_coder` when discrepancies, physics edge cases, or visual issues are detected.
- **Flash (`flash_coder` Worker Subagent)**:
  - Implements pure simulation modules (`src/core/`) and PlayCanvas 3D engine systems (`src/engine/`) strictly against `src/contracts/`.
  - Must never introduce `any`, mock placeholders, or untested math.
  - Runs `npm run verify` before reporting completion.

## 3. Architectural Separation of Concerns
1. `src/contracts/` — Pure TypeScript interfaces & constants (Zero runtime dependencies).
2. `src/core/ballistics/` — External ballistics (RK4 solver, G1/G7 drag, windage, Coriolis/Magnus, sub-stepped ray-segment generation) & Terminal ballistics (multi-layer tissue penetration, hydrostatic shock, bone ricochet/shatter, internal deflection).
3. `src/core/ghoul/` — 26-zone GHOUL anatomical mannequin geometry (local-space OBBs/spheres/capsules for skin, bone, and vital organs), structural integrity, dismemberment thresholds, arterial bleedout, and wound telemetry.
4. `src/engine/` — PlayCanvas WebGL2 application:
   - Procedural 3D anatomical targets (outer tactical mesh + internal articulated 3D skeleton, skull, ribcage, spine, pelvis, beating heart, lungs, brain, major arteries).
   - Ballistic Range & Combat Arena environment.
   - First-Person / Precision Scope weapon controller with breath stabilization and wind/drop reticle helper.
   - **Sniper Elite X-Ray Kill Cam Director**: Pre-calculates lethality, slows `timeScale` to `0.04x`, orbits the spinning bullet in flight with shockwave trails, cross-fades target outer mesh to translucent X-Ray shader on entry, and visualizes bone shatter, organ rupture, and GHOUL limb severing in real time.
   - Tactical Telemetry HUD & Ballistic Inspector (wound log, energy transfer graph, velocity/drop curve, ammo & weapon selector).
