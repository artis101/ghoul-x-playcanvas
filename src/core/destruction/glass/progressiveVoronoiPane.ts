import {
  type ProgressiveVoronoiHitReport,
  type VoronoiWindowShatterResult,
} from './glassShardTypes.ts';
import {
  isPointInConvexPolygon2D,
  pointToConvexPolygonDistance2D,
} from './polygonMath2D.ts';
import {
  writeClingingFangsMeshBuffers,
  pruneUnanchoredFangs,
} from './progressiveFangsMeshBuilder.ts';

export class ProgressiveVoronoiPane {
  public readonly shatter: VoronoiWindowShatterResult;
  public readonly attached: Uint8Array;
  private survivingFangs: number;
  private readonly bfsVisited: Uint8Array;
  private readonly bfsQueue: Int32Array;

  public constructor(shatter: VoronoiWindowShatterResult) {
    this.shatter = shatter;
    const n = shatter.shards.length;
    this.attached = new Uint8Array(n).fill(1);
    this.survivingFangs = n;
    this.bfsVisited = new Uint8Array(n);
    this.bfsQueue = new Int32Array(n);
  }

  public get survivingFangCount(): number {
    return this.survivingFangs;
  }

  public triggerInitialBreach(energyJ: number): number[] {
    const shards = this.shatter.shards;
    const n = shards.length;
    const detached: number[] = [];

    const detach = (idx: number): void => {
      if (this.attached[idx] === 0) return;
      this.attached[idx] = 0;
      this.survivingFangs--;
      detached.push(idx);
    };

    if (energyJ >= 3800) {
      for (let i = 0; i < n; i++) detach(i);
      return detached;
    }

    const diagM = Math.hypot(this.shatter.widthM, this.shatter.heightM);
    const minDimM = Math.min(this.shatter.widthM, this.shatter.heightM);
    const minGripLengthM = minDimM * 0.11;
    const breachRadiusM = diagM * (0.25 + Math.min(0.07, (energyJ / 3800) * 0.07));

    const fangCandidates: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = shards[i];
      const hitDirectly = isPointInConvexPolygon2D(s.polygon, this.shatter.hitX, this.shatter.hitY, 1e-4);
      if (!hitDirectly && s.touchesFrame && s.frameContactLengthM >= minGripLengthM && s.radialDistanceM > diagM * 0.20) {
        fangCandidates.push(i);
      }
    }

    fangCandidates.sort((a, b) => {
      const scoreA = shards[a].radialDistanceM + shards[a].frameContactLengthM * 0.45;
      const scoreB = shards[b].radialDistanceM + shards[b].frameContactLengthM * 0.45;
      return scoreB - scoreA;
    });

    const targetClingingFangs = Math.min(fangCandidates.length, Math.max(4, Math.min(7, Math.round(n * 0.28))));
    const protectedFangs = new Set<number>();
    for (let k = 0; k < fangCandidates.length; k++) {
      const idx = fangCandidates[k];
      if (shards[idx].radialDistanceM > breachRadiusM || protectedFangs.size < targetClingingFangs) {
        if (protectedFangs.size < 7) protectedFangs.add(idx);
      }
    }

    for (let i = 0; i < n; i++) {
      if (!protectedFangs.has(i)) detach(i);
    }

    const minDetachedTarget = Math.min(n, Math.max(9, Math.ceil(n * 0.58)));
    if (detached.length < minDetachedTarget) {
      const remainingByDist: number[] = [];
      for (let i = 0; i < n; i++) {
        if (this.attached[i] === 1) remainingByDist.push(i);
      }
      remainingByDist.sort((a, b) => shards[a].radialDistanceM - shards[b].radialDistanceM);
      for (let k = 0; k < remainingByDist.length && detached.length < minDetachedTarget; k++) {
        detach(remainingByDist[k]);
      }
    }

    this.survivingFangs -= pruneUnanchoredFangs(shards, this.attached, this.bfsVisited, this.bfsQueue, detached);
    return detached;
  }

  public strikeClingingFangs(
    hitX: number,
    hitY: number,
    energyJ: number,
    radiusM = 0.03,
  ): ProgressiveVoronoiHitReport {
    if (this.survivingFangs === 0) {
      return { hitOpenBreach: true, newlyDetachedIndices: [], survivingFangCount: 0 };
    }

    const shards = this.shatter.shards;
    const isBlast = energyJ >= 3800 || radiusM >= 0.25;
    let directFang = -1;

    for (let i = 0; i < shards.length; i++) {
      if (this.attached[i] === 0) continue;
      if (isPointInConvexPolygon2D(shards[i].polygon, hitX, hitY, 1e-4)) {
        directFang = i;
        break;
      }
    }

    if (directFang < 0 && !isBlast) {
      return { hitOpenBreach: true, newlyDetachedIndices: [], survivingFangCount: this.survivingFangs };
    }

    const detached: number[] = [];
    const detach = (idx: number): void => {
      if (this.attached[idx] === 0) return;
      this.attached[idx] = 0;
      this.survivingFangs--;
      detached.push(idx);
    };

    if (isBlast) {
      const blastR = Math.max(radiusM, 0.35);
      for (let i = 0; i < shards.length; i++) {
        if (this.attached[i] === 0) continue;
        if (energyJ >= 3800 || pointToConvexPolygonDistance2D(shards[i].polygon, hitX, hitY) <= blastR) {
          detach(i);
        }
      }
    } else if (directFang >= 0) {
      detach(directFang);
      const knockNeighborR = Math.hypot(this.shatter.widthM, this.shatter.heightM) * 0.20;
      for (const nb of shards[directFang].neighbors) {
        if (this.attached[nb] === 1 && pointToConvexPolygonDistance2D(shards[nb].polygon, hitX, hitY) <= knockNeighborR) {
          detach(nb);
        }
      }
    }

    if (detached.length === 0) {
      return { hitOpenBreach: true, newlyDetachedIndices: [], survivingFangCount: this.survivingFangs };
    }

    this.survivingFangs -= pruneUnanchoredFangs(shards, this.attached, this.bfsVisited, this.bfsQueue, detached);
    return { hitOpenBreach: false, newlyDetachedIndices: detached, survivingFangCount: this.survivingFangs };
  }

  public writeClingingFangsMeshBuffers(
    outPositions: Float32Array,
    outNormals: Float32Array,
    outUvs: Float32Array,
    outColors: Float32Array,
    outIndices: Uint16Array,
  ): { fangCount: number; vertexCount: number; indexCount: number } {
    return writeClingingFangsMeshBuffers(
      this.shatter,
      this.attached,
      outPositions,
      outNormals,
      outUvs,
      outColors,
      outIndices,
    );
  }
}
