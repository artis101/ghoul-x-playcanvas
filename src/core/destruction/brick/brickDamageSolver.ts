import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BrickBallisticHitOutcome,
  BrickBlastOutcome,
  SolidBrickWallGrid,
} from './brickWallGridTypes.ts';
import { BLAST_REACH_SCALE, blastLocalEnergyJ } from '../blastFalloff.ts';

export function computeBulletBrickDamageHp(
  kineticEnergyJ: number,
  isArmorPiercing: boolean
): number {
  if (kineticEnergyJ <= 0) return 0;
  const effJ = kineticEnergyJ * (isArmorPiercing ? 1.18 : 1.0);
  const raw = 4 + Math.pow(effJ, 0.66) * 0.34;
  return Math.min(88, Math.max(5, raw));
}

function addGouge(
  grid: SolidBrickWallGrid,
  idx: number,
  hitFromFront: boolean,
  dmgRatioDelta: number
): void {
  const cell = grid.cells[idx];
  const totalDamageFrac = Math.max(0, Math.min(1, 1 - grid.hp[idx] / cell.maxHp));
  if (hitFromFront) {
    grid.frontGouge[idx] = Math.min(
      0.95,
      Math.max(grid.frontGouge[idx] + dmgRatioDelta * 0.85, totalDamageFrac * 0.9)
    );
    if (totalDamageFrac > 0.5) {
      grid.backGouge[idx] = Math.max(grid.backGouge[idx], (totalDamageFrac - 0.5) * 0.75);
    }
  } else {
    grid.backGouge[idx] = Math.min(
      0.95,
      Math.max(grid.backGouge[idx] + dmgRatioDelta * 0.85, totalDamageFrac * 0.9)
    );
    if (totalDamageFrac > 0.5) {
      grid.frontGouge[idx] = Math.max(grid.frontGouge[idx], (totalDamageFrac - 0.5) * 0.75);
    }
  }
}

export function collapseUnsupportedBricks(
  grid: SolidBrickWallGrid,
  newlyDestroyedOut: number[]
): void {
  const n = grid.cells.length;
  const visited = grid.bfsVisitedScratch;
  const queue = grid.bfsQueueScratch;

  // Iterative pass: prune cantilevered tips with 0 support below and <= 1 lateral/upper bond,
  // then run ground-connectivity BFS from row === 0 so no floating mid-air bricks remain.
  for (let pass = 0; pass < 4; pass++) {
    let prunedTip = false;
    for (let i = 0; i < n; i++) {
      if (grid.hp[i] <= 0) continue;
      const cell = grid.cells[i];
      if (cell.row === 0) continue;

      let supportBelow = 0;
      for (let b = 0; b < cell.overlapsBelow.length; b++) {
        if (grid.hp[cell.overlapsBelow[b].neighborIndex] > 0) supportBelow++;
      }
      if (supportBelow > 0) continue;

      let otherBonds = 0;
      if (cell.neighborLeft >= 0 && grid.hp[cell.neighborLeft] > 0) otherBonds++;
      if (cell.neighborRight >= 0 && grid.hp[cell.neighborRight] > 0) otherBonds++;
      for (let a = 0; a < cell.overlapsAbove.length; a++) {
        if (grid.hp[cell.overlapsAbove[a].neighborIndex] > 0) otherBonds++;
      }

      if (otherBonds <= 1) {
        grid.hp[i] = 0;
        newlyDestroyedOut.push(i);
        prunedTip = true;
      }
    }

    visited.fill(0);
    let qHead = 0;
    let qTail = 0;
    const row0Count = grid.rowCounts[0];
    for (let c = 0; c < row0Count; c++) {
      if (grid.hp[c] > 0) {
        visited[c] = 1;
        queue[qTail++] = c;
      }
    }

    while (qHead < qTail) {
      const cur = queue[qHead++];
      const cell = grid.cells[cur];

      const tryVisit = (nb: number): void => {
        if (nb >= 0 && visited[nb] === 0 && grid.hp[nb] > 0) {
          visited[nb] = 1;
          queue[qTail++] = nb;
        }
      };

      tryVisit(cell.neighborLeft);
      tryVisit(cell.neighborRight);
      for (let b = 0; b < cell.overlapsBelow.length; b++) {
        tryVisit(cell.overlapsBelow[b].neighborIndex);
      }
      for (let a = 0; a < cell.overlapsAbove.length; a++) {
        tryVisit(cell.overlapsAbove[a].neighborIndex);
      }
    }

    let collapsedFloating = false;
    for (let i = 0; i < n; i++) {
      if (grid.hp[i] > 0 && visited[i] === 0) {
        grid.hp[i] = 0;
        newlyDestroyedOut.push(i);
        collapsedFloating = true;
      }
    }

    if (!prunedTip && !collapsedFloating) {
      break;
    }
  }
}

export function applyBallisticHitToBrickGrid(
  grid: SolidBrickWallGrid,
  hitBrickIndex: number,
  kineticEnergyJ: number,
  isArmorPiercing: boolean,
  hitFromFront: boolean
): BrickBallisticHitOutcome {
  if (hitBrickIndex < 0 || hitBrickIndex >= grid.cells.length || grid.hp[hitBrickIndex] <= 0) {
    return {
      hitBrickIndex,
      damageAppliedHp: 0,
      brickBrokeOut: false,
      newlyDestroyedIndices: [],
      newlyDamagedCount: 0,
      remainingEnergyJ: Math.max(0, kineticEnergyJ),
      stopped: false,
    };
  }

  const cell = grid.cells[hitBrickIndex];
  const hpBefore = grid.hp[hitBrickIndex];
  const potentialDamageHp = computeBulletBrickDamageHp(kineticEnergyJ, isArmorPiercing);
  const actualDamageHp = Math.min(hpBefore, potentialDamageHp);

  grid.hp[hitBrickIndex] = Math.max(0, hpBefore - potentialDamageHp);
  grid.hitCount[hitBrickIndex] = Math.min(65535, grid.hitCount[hitBrickIndex] + 1);
  addGouge(grid, hitBrickIndex, hitFromFront, actualDamageHp / cell.maxHp);

  let newlyDamagedCount = grid.hp[hitBrickIndex] > 0 ? 1 : 0;

  // Radiate subtle shock-chip damage across mortar joints to immediate neighbors
  // (capped at >= 16 HP floor so indirect shock softens neighbors without popping them out alone).
  if (kineticEnergyJ >= 750) {
    const splashHp = potentialDamageHp * (kineticEnergyJ >= 2200 ? 0.22 : 0.14);
    const applyNeighborSplash = (nbIdx: number, weight: number): void => {
      if (nbIdx < 0 || grid.hp[nbIdx] <= 16) return;
      const nbCell = grid.cells[nbIdx];
      const delta = Math.min(grid.hp[nbIdx] - 16, splashHp * weight);
      if (delta > 0.5) {
        grid.hp[nbIdx] -= delta;
        grid.hitCount[nbIdx] = Math.min(65535, grid.hitCount[nbIdx] + 1);
        addGouge(grid, nbIdx, hitFromFront, delta / nbCell.maxHp);
        newlyDamagedCount++;
      }
    };

    applyNeighborSplash(cell.neighborLeft, 1.0);
    applyNeighborSplash(cell.neighborRight, 1.0);
    for (let b = 0; b < cell.overlapsBelow.length; b++) {
      applyNeighborSplash(cell.overlapsBelow[b].neighborIndex, 0.75);
    }
    for (let a = 0; a < cell.overlapsAbove.length; a++) {
      applyNeighborSplash(cell.overlapsAbove[a].neighborIndex, 0.75);
    }
  }

  const newlyDestroyed: number[] = [];
  const brickBrokeOut = grid.hp[hitBrickIndex] <= 0;

  if (brickBrokeOut) {
    newlyDestroyed.push(hitBrickIndex);
    collapseUnsupportedBricks(grid, newlyDestroyed);
  }

  let remainingEnergyJ = 0;
  let stopped = true;
  if (brickBrokeOut && potentialDamageHp > 1e-4) {
    const consumedFraction = Math.min(1, hpBefore / potentialDamageHp);
    const rawRemJ = kineticEnergyJ * Math.max(0, 1 - consumedFraction * 0.88);
    if (rawRemJ > 30) {
      remainingEnergyJ = rawRemJ;
      stopped = false;
    }
  }

  return {
    hitBrickIndex,
    damageAppliedHp: actualDamageHp,
    brickBrokeOut,
    newlyDestroyedIndices: newlyDestroyed,
    newlyDamagedCount,
    remainingEnergyJ,
    stopped,
  };
}

export function applyBlastToBrickGrid(
  grid: SolidBrickWallGrid,
  localBlastCenter: Vec3Like,
  blastRadiusM: number,
  peakEnergyJ: number
): BrickBlastOutcome {
  if (blastRadiusM <= 0 || peakEnergyJ <= 0) {
    return { newlyDestroyedIndices: [], damagedBrickCount: 0, changed: false };
  }

  const newlyDestroyed: number[] = [];
  let damagedCount = 0;
  let anyChanged = false;
  const blastFromFront = localBlastCenter.z >= 0;
  const effectiveRadiusM = blastRadiusM * BLAST_REACH_SCALE;

  for (let i = 0; i < grid.cells.length; i++) {
    if (grid.hp[i] <= 0) continue;
    const cell = grid.cells[i];
    const dx = cell.localCenter.x - localBlastCenter.x;
    const dy = cell.localCenter.y - localBlastCenter.y;
    const dz = cell.localCenter.z - localBlastCenter.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= effectiveRadiusM) continue;

    const localEnergyJ = blastLocalEnergyJ(peakEnergyJ, blastRadiusM, dist);
    // Direct blast wave: > ~900 J local energy punches out full 100-HP bricks,
    // while outer blast fringe (120..900 J) cracks & gouges bricks around the breach rim!
    const blastDamageHp = localEnergyJ * 0.115;
    if (blastDamageHp < 4) continue;

    anyChanged = true;
    const prevHp = grid.hp[i];
    grid.hp[i] = Math.max(0, prevHp - blastDamageHp);
    grid.hitCount[i] = Math.min(65535, grid.hitCount[i] + 1);

    if (grid.hp[i] <= 0) {
      newlyDestroyed.push(i);
    } else {
      addGouge(grid, i, blastFromFront, Math.min(1, blastDamageHp / cell.maxHp));
      damagedCount++;
    }
  }

  if (newlyDestroyed.length > 0) {
    collapseUnsupportedBricks(grid, newlyDestroyed);
  }

  return {
    newlyDestroyedIndices: newlyDestroyed,
    damagedBrickCount: damagedCount,
    changed: anyChanged,
  };
}
