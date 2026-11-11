import Delaunator from 'delaunator';
import {
  DEFAULT_VORONOI_SHARD_THICKNESS_M,
  type Point2D,
  type VoronoiGlassShardCell,
  type VoronoiWindowShatterOptions,
  type VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import {
  computePolygonAreaAndCentroid2D,
  computeSignedPolygonArea2D,
  computeTriangleCircumcenter2D,
} from './polygonMath2D.ts';
import { clipPolygonToRectSutherlandHodgman } from './polygonClipSutherlandHodgman.ts';
import { extrudeConvexShard2D } from './shardPrismExtruder.ts';
import { generateWindowShatterSeeds } from './voronoiSeedsGenerator.ts';

function prevHalfedge(e: number): number {
  return e % 3 === 0 ? e + 2 : e - 1;
}

export function buildVoronoiCellsFromInteriorSeeds(
  interiorSeeds: Point2D[],
  widthM: number,
  heightM: number,
  hitX: number,
  hitY: number,
  thicknessM: number,
): VoronoiWindowShatterResult {
  const seeds = interiorSeeds.slice();
  const interiorSeedCount = seeds.length;
  const diagM = Math.hypot(widthM, heightM);

  const outerRadius = diagM * 8.0;
  const centerWindowX = widthM * 0.5;
  const centerWindowY = heightM * 0.5;
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4;
    seeds.push({
      x: centerWindowX + Math.cos(angle) * outerRadius,
      y: centerWindowY + Math.sin(angle) * outerRadius,
    });
  }

  const delaunay = Delaunator.from(seeds, (p: Point2D) => p.x, (p: Point2D) => p.y);
  const { triangles, halfedges } = delaunay;
  const numTriangles = triangles.length / 3;

  const circumcenters: Point2D[] = new Array<Point2D>(numTriangles);
  for (let t = 0; t < numTriangles; t++) {
    const a = seeds[triangles[t * 3]];
    const b = seeds[triangles[t * 3 + 1]];
    const c = seeds[triangles[t * 3 + 2]];
    circumcenters[t] = computeTriangleCircumcenter2D(a.x, a.y, b.x, b.y, c.x, c.y);
  }

  const seedToHalfedge = new Int32Array(seeds.length).fill(-1);
  for (let e = 0; e < triangles.length; e++) {
    const endpoint = triangles[e];
    if (seedToHalfedge[endpoint] === -1) {
      seedToHalfedge[endpoint] = e;
    }
  }

  const shards: VoronoiGlassShardCell[] = [];
  let totalAreaM2 = 0;
  const frameEps = 1e-4;

  for (let s = 0; s < interiorSeedCount; s++) {
    const startEdge = seedToHalfedge[s];
    if (startEdge < 0) continue;

    const rawCellLoop: Point2D[] = [];
    let e = startEdge;
    let closedCleanly = false;

    for (let step = 0; step <= numTriangles; step++) {
      rawCellLoop.push(circumcenters[Math.floor(e / 3)]);
      const incoming = prevHalfedge(e);
      const nextOut = halfedges[incoming];
      if (nextOut === -1) {
        closedCleanly = false;
        break;
      }
      if (nextOut === startEdge) {
        closedCleanly = true;
        break;
      }
      e = nextOut;
    }

    if (!closedCleanly || rawCellLoop.length < 3) continue;
    if (computeSignedPolygonArea2D(rawCellLoop) < 0) rawCellLoop.reverse();

    const clipped = clipPolygonToRectSutherlandHodgman(rawCellLoop, 0, 0, widthM, heightM);
    if (clipped.length < 3) continue;

    const { areaM2, centroid } = computePolygonAreaAndCentroid2D(clipped);
    if (areaM2 <= 1e-8) continue;

    let frameContactLengthM = 0;
    for (let i = 0; i < clipped.length; i++) {
      const p0 = clipped[i], p1 = clipped[(i + 1) % clipped.length];
      const onLeft = p0.x <= frameEps && p1.x <= frameEps;
      const onRight = p0.x >= widthM - frameEps && p1.x >= widthM - frameEps;
      const onBottom = p0.y <= frameEps && p1.y <= frameEps;
      const onTop = p0.y >= heightM - frameEps && p1.y >= heightM - frameEps;
      if (onLeft || onRight || onBottom || onTop) {
        frameContactLengthM += Math.hypot(p1.x - p0.x, p1.y - p0.y);
      }
    }

    const extruded = extrudeConvexShard2D(clipped, centroid, widthM, heightM, thicknessM);
    const radialDistanceM = Math.hypot(centroid.x - hitX, centroid.y - hitY);
    totalAreaM2 += areaM2;

    shards.push({
      index: shards.length,
      seed: seeds[s],
      polygon: clipped,
      centroid,
      areaM2,
      radialDistanceM,
      extruded,
      neighbors: [],
      touchesFrame: frameContactLengthM > 1e-4,
      frameContactLengthM,
    });
  }

  const midpointBuckets = new Map<string, Array<{ shardIdx: number; p0: Point2D; p1: Point2D }>>();
  for (let sIdx = 0; sIdx < shards.length; sIdx++) {
    const poly = shards[sIdx].polygon;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % n];
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) <= 1e-4) continue;
      const key = `${Math.round((p0.x + p1.x) * 2500)}:${Math.round((p0.y + p1.y) * 2500)}`;
      const existing = midpointBuckets.get(key);
      if (existing) {
        for (let k = 0; k < existing.length; k++) {
          const other = existing[k];
          if (other.shardIdx === sIdx) continue;
          const matchOpp = Math.hypot(p0.x - other.p1.x, p0.y - other.p1.y) < 1.5e-3 && Math.hypot(p1.x - other.p0.x, p1.y - other.p0.y) < 1.5e-3;
          const matchSame = Math.hypot(p0.x - other.p0.x, p0.y - other.p0.y) < 1.5e-3 && Math.hypot(p1.x - other.p1.x, p1.y - other.p1.y) < 1.5e-3;
          if (matchOpp || matchSame) {
            if (!shards[sIdx].neighbors.includes(other.shardIdx)) shards[sIdx].neighbors.push(other.shardIdx);
            if (!shards[other.shardIdx].neighbors.includes(sIdx)) shards[other.shardIdx].neighbors.push(sIdx);
          }
        }
        existing.push({ shardIdx: sIdx, p0, p1 });
      } else {
        midpointBuckets.set(key, [{ shardIdx: sIdx, p0, p1 }]);
      }
    }
  }

  return { widthM, heightM, hitX, hitY, thicknessM, allSeeds: seeds, interiorSeedCount, shards, totalAreaM2 };
}

export function shatterWindowVoronoi2D(options: VoronoiWindowShatterOptions): VoronoiWindowShatterResult {
  const widthM = Math.max(0.1, options.widthM);
  const heightM = Math.max(0.1, options.heightM);
  const thicknessM = options.thicknessM ?? DEFAULT_VORONOI_SHARD_THICKNESS_M;
  const targetShardCount = Math.max(8, Math.min(96, Math.round(options.shardCount ?? 42)));

  const marginX = widthM * 0.025;
  const marginY = heightM * 0.025;
  const hitX = Math.max(marginX, Math.min(widthM - marginX, options.hitX));
  const hitY = Math.max(marginY, Math.min(heightM - marginY, options.hitY));

  const seedInt =
    options.seed ??
    ((Math.round(hitX * 1000) * 73856093) ^
      (Math.round(hitY * 1000) * 19349663) ^
      (Math.round(widthM * 500) * 83492791) ^
      targetShardCount);

  const seeds = generateWindowShatterSeeds(widthM, heightM, hitX, hitY, targetShardCount, seedInt);
  return buildVoronoiCellsFromInteriorSeeds(seeds, widthM, heightM, hitX, hitY, thicknessM);
}
