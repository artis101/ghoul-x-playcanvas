/**
 * Architectural & Armored Voronoi Glass Shatter Subsystem (Facade).
 *
 * Modularized into focused <= 200 LOC stages under `src/core/destruction/glass/`:
 * - `glassShardTypes.ts`: interfaces & constants
 * - `polygonMath2D.ts`: 2D polygon centroid, area, containment, and distance
 * - `polygonClipSutherlandHodgman.ts`: Sutherland-Hodgman convex polygon clipper
 * - `shardPrismExtruder.ts`: 3D double-faced extruded prism geometry builder
 * - `voronoiSeedsGenerator.ts`: radial impact seed distribution & Delaunay triangulation
 * - `voronoiWindowShatter.ts`: bounded window Voronoi cell constructor
 * - `organicVoronoiLayout.ts`: stratified Lloyd-relaxed organic Voronoi grid
 * - `armoredImpactSolver.ts` & `armoredBfsSolver.ts`: ballistic impact, crazing & BFS
 * - `armoredMeshBuilder.ts`: frosted laminate bevels, spiderweb cracks & facet builder
 * - `armoredGlassState.ts`: ArmoredVoronoiGlassPane coordinator
 * - `progressiveVoronoiPane.ts` & `progressiveFangsMeshBuilder.ts`: large plate fangs
 * - `glassShardPoolTypes.ts`, `glassShardIntegrator.ts`, `glassShardSpawner.ts`,
 *   `glassShardBatchWriter.ts`, `glassShardPool.ts`: zero-alloc flat SoA shard simulator
 */

export * from './glass/glassShardTypes.ts';
export * from './glass/glassShardPoolTypes.ts';
export * from './glass/polygonMath2D.ts';
export * from './glass/polygonClipSutherlandHodgman.ts';
export * from './glass/shardPrismExtruder.ts';
export * from './glass/voronoiSeedsGenerator.ts';
export * from './glass/voronoiWindowShatter.ts';
export * from './glass/organicVoronoiLayout.ts';
export * from './glass/armoredBfsSolver.ts';
export * from './glass/armoredImpactSolver.ts';
export * from './glass/armoredMeshBuilder.ts';
export * from './glass/armoredGlassState.ts';
export * from './glass/progressiveFangsMeshBuilder.ts';
export * from './glass/progressiveVoronoiPane.ts';
export * from './glass/glassShardSpawner.ts';
export * from './glass/glassShardIntegrator.ts';
export * from './glass/glassShardBatchWriter.ts';
export * from './glass/glassShardPool.ts';
