# Project GHOUL-X (`Soldier of Fortune` x `Sniper Elite` in PlayCanvas)

First-principles recreation of **Soldier of Fortune (2000)** localized 22-zone **GHOUL** dismemberment and early-2000s FPS gore combined with **Sniper Elite** 4th-order Runge-Kutta (RK4) external/terminal ballistics, pre-calculated shotgun ragdoll launch physics, and an interactive **X-Ray Kill Cam** in **PlayCanvas + TypeScript**.

## Key Features

1. **Pre-Calculated Shotgun Lethality & Ragdoll Launch (`src/core/ballistics/solver.ts`)**
   - Simulates multi-pellet `12G_00_BUCK` trajectories at trigger pull (and every frame in the Pre-Impact Predictor).
   - Pre-calculates lethality before pellets arrive, unlocking an articulated 22-bone ragdoll launch plan with backward blast momentum, upward lift velocity (`2.5–6.5 m/s`), and off-center angular torque.
2. **22-Zone Soldier of Fortune GHOUL Dismemberment (`src/core/ghoul/anatomy.ts`)**
   - Full kinematic limb tree (`PELVIS_GROIN` -> `TORSO` -> `HEAD_CRANIUM` / `ARMS` / `LEGS`).
   - Supports `CRANIAL_POP` (14-gib head explosion), `CLEAN_SEVER` (hierarchical subtree detachment with bloody stump caps, protruding cortical bone marrow, and pulsing arterial fountains), and `EVISCERATED` torso trauma.
3. **Sniper Elite RK4 External & Terminal Ballistics + X-Ray Kill Cam (`src/engine/killCamDirector.ts`)**
   - RK4 numerical integration with gravity drop, Mach-dependent transonic wave drag, crosswind deflection, and rifling spin drift.
   - Dynamic slow-motion X-Ray Kill Cam (`0.018x–0.035x` time dilation) cross-fading outer tactical skin into a translucent X-Ray silhouette to expose 3D skull, ribcage, spine, pelvis, and beating vital organs.
4. **Argon -> Flash -> Argon Agentic Architecture (`AGENTIC_BOOTSTRAP.md`)**
   - Pure, zero-DOM simulation core (`src/core/`) verified headlessly in `< 60ms` via Vitest (`npm run verify`) decoupled from PlayCanvas 3D WebGL2 presentation (`src/engine/`).

## Quick Start

```bash
npm install
npm run verify   # TypeScript strict check + Vitest ballistic & GHOUL test suite
npm run dev      # Launch Vite + PlayCanvas WebGL2 dev server
npm run build    # Production bundle
```
