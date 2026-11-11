import {
  GLASS_CELL_CRACKED,
  GLASS_CELL_INTACT,
  GLASS_CELL_VOID,
  GLASS_DIR_E,
  GLASS_DIR_N,
  GLASS_DIR_S,
  GLASS_DIR_W,
  type MarchingGlassImpactOptions,
  type MarchingGlassImpactReport,
} from './marchingTileTypes.ts';
import { computeNeighborBitmask8, createDeterministicPrng } from './marchingBitmaskMath.ts';

export interface MarchingPaneStateContext {
  widthM: number;
  heightM: number;
  gridW: number;
  gridH: number;
  frameBorderIntact: boolean;
  cells: Uint8Array;
  survivingCount: number;
  impactCounter: number;
  uvToGridCoords(u: number, v: number): { col: number; row: number };
}

export function applyMarchingImpact(
  pane: MarchingPaneStateContext,
  options: MarchingGlassImpactOptions,
): MarchingGlassImpactReport {
  const u = Math.max(0, Math.min(1, options.u));
  const v = Math.max(0, Math.min(1, options.v));
  const energyJ = Math.max(0, options.energyJ);

  const { col: centerCol, row: centerRow } = pane.uvToGridCoords(u, v);
  const centerIdx = centerRow * pane.gridW + centerCol;
  const centerInitialState = pane.cells[centerIdx];

  const cellWidthM = pane.widthM / pane.gridW;
  const cellHeightM = pane.heightM / pane.gridH;
  const minCellDimM = Math.min(cellWidthM, cellHeightM);

  const requestedRadiusM =
    options.radiusM ??
    Math.min(
      Math.max(pane.widthM, pane.heightM) * 0.22,
      0.035 + Math.sqrt(Math.min(energyJ, 4000)) * 0.0014,
    );

  if (centerInitialState === GLASS_CELL_VOID && requestedRadiusM <= minCellDimM * 0.65) {
    return {
      alreadyBrokenHole: true,
      cellsBroken: 0,
      cellsCracked: 0,
      tendrilsSpawned: 0,
      survivingCells: pane.survivingCount,
    };
  }

  const derivedSeed =
    options.seed ??
    (((centerCol + 1) * 73856093) ^ ((centerRow + 1) * 19349663) ^ (pane.impactCounter * 83492791) ^ Math.round(energyJ * 13));
  const rand = createDeterministicPrng(derivedSeed);

  let cellsBroken = 0;
  let cellsCracked = 0;

  const knockOutCell = (c: number, r: number): void => {
    if (c < 0 || c >= pane.gridW || r < 0 || r >= pane.gridH) return;
    const idx = r * pane.gridW + c;
    if (pane.cells[idx] !== GLASS_CELL_VOID) {
      pane.cells[idx] = GLASS_CELL_VOID;
      pane.survivingCount--;
      cellsBroken++;
    }
  };

  const crackCell = (c: number, r: number): void => {
    if (c < 0 || c >= pane.gridW || r < 0 || r >= pane.gridH) return;
    const idx = r * pane.gridW + c;
    if (pane.cells[idx] === GLASS_CELL_INTACT) {
      pane.cells[idx] = GLASS_CELL_CRACKED;
      cellsCracked++;
    }
  };

  knockOutCell(centerCol, centerRow);

  const effectiveRadiusM =
    centerInitialState === GLASS_CELL_CRACKED ? requestedRadiusM * 1.35 : requestedRadiusM;

  const hitLocalX = u * pane.widthM;
  const hitLocalY = v * pane.heightM;
  const colRadius = Math.ceil(effectiveRadiusM / cellWidthM);
  const rowRadius = Math.ceil(effectiveRadiusM / cellHeightM);
  const radiusSq = effectiveRadiusM * effectiveRadiusM;

  for (let r = centerRow - rowRadius; r <= centerRow + rowRadius; r++) {
    if (r < 0 || r >= pane.gridH) continue;
    const cellCenterY = (r + 0.5) * cellHeightM;
    const dy = cellCenterY - hitLocalY;
    for (let c = centerCol - colRadius; c <= centerCol + colRadius; c++) {
      if (c < 0 || c >= pane.gridW) continue;
      const cellCenterX = (c + 0.5) * cellWidthM;
      const dx = cellCenterX - hitLocalX;
      const distSq = dx * dx + dy * dy;
      const jitterFactor = 0.82 + rand() * 0.34;
      if (distSq <= radiusSq * jitterFactor) {
        knockOutCell(c, r);
      } else if (distSq <= radiusSq * 2.1) {
        crackCell(c, r);
      }
    }
  }

  const energyNorm = Math.min(1, energyJ / 1800);
  const tendrilCount = Math.max(
    4,
    Math.min(8, 4 + Math.floor(energyNorm * 3.2 + rand() * 1.8)),
  );
  const maxWalkSteps = Math.max(
    2,
    Math.min(
      Math.max(pane.gridW, pane.gridH),
      Math.round(2.5 + energyNorm * 3.5 + (effectiveRadiusM / minCellDimM) * 0.75),
    ),
  );

  const baseAngle = rand() * Math.PI * 2;
  const angleStep = (Math.PI * 2) / tendrilCount;

  for (let t = 0; t < tendrilCount; t++) {
    let theta = baseAngle + t * angleStep + (rand() - 0.5) * angleStep * 0.45;
    let walkX = centerCol + 0.5;
    let walkY = centerRow + 0.5;
    const stepsForTendril = Math.max(
      2,
      Math.round(maxWalkSteps * (0.7 + rand() * 0.5)),
    );

    for (let s = 1; s <= stepsForTendril; s++) {
      theta += (rand() - 0.5) * 0.52;
      walkX += Math.cos(theta) * 0.95;
      walkY += Math.sin(theta) * 0.95;

      const c = Math.floor(walkX);
      const r = Math.floor(walkY);
      if (c < 0 || c >= pane.gridW || r < 0 || r >= pane.gridH) {
        break;
      }

      const existing = pane.cells[r * pane.gridW + c];
      if (s === 1 && energyJ >= 350 && rand() < 0.45) {
        knockOutCell(c, r);
      } else if (existing === GLASS_CELL_CRACKED && s <= 2 && rand() < 0.55) {
        knockOutCell(c, r);
      } else {
        crackCell(c, r);
      }
    }
  }

  // Prune any completely unsupported 1-cell floating islands
  for (let r = 0; r < pane.gridH; r++) {
    for (let c = 0; c < pane.gridW; c++) {
      const idx = r * pane.gridW + c;
      if (pane.cells[idx] === GLASS_CELL_VOID) continue;
      const mask = computeNeighborBitmask8(
        pane.cells,
        pane.gridW,
        pane.gridH,
        c,
        r,
        pane.frameBorderIntact,
      );
      const cardinalMask =
        mask & (GLASS_DIR_N | GLASS_DIR_E | GLASS_DIR_S | GLASS_DIR_W);
      if (cardinalMask === 0) {
        knockOutCell(c, r);
      }
    }
  }

  return {
    alreadyBrokenHole: false,
    cellsBroken,
    cellsCracked,
    tendrilsSpawned: tendrilCount,
    survivingCells: pane.survivingCount,
  };
}
