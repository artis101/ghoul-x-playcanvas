import { ARMORED_CHUNK_DETACHED } from './glassShardTypes.ts';
import type { ArmoredVoronoiGlassPane } from './armoredGlassState.ts';

export function runArmoredBfsDetachment(
  pane: ArmoredVoronoiGlassPane,
  detachChunk: (idx: number) => void,
): void {
  if (pane.survivingCount <= 0) return;

  pane.bfsVisited.fill(0);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < pane.chunks.length; i++) {
    if (pane.stage[i] !== ARMORED_CHUNK_DETACHED && pane.chunks[i].touchesFrame) {
      pane.bfsVisited[i] = 1;
      pane.bfsQueue[tail++] = i;
    }
  }

  while (head < tail) {
    const cur = pane.bfsQueue[head++];
    const nbrs = pane.chunks[cur].neighbors;
    for (let k = 0; k < nbrs.length; k++) {
      const nb = nbrs[k];
      if (pane.bfsVisited[nb] === 0 && pane.stage[nb] !== ARMORED_CHUNK_DETACHED) {
        pane.bfsVisited[nb] = 1;
        pane.bfsQueue[tail++] = nb;
      }
    }
  }

  for (let i = 0; i < pane.chunks.length; i++) {
    if (pane.stage[i] !== ARMORED_CHUNK_DETACHED && pane.bfsVisited[i] === 0) {
      detachChunk(i);
    }
  }
}

export function propagateTendrilDamage(
  pane: ArmoredVoronoiGlassPane,
  hitIdx: number,
  hitX: number,
  hitY: number,
  rand: () => number,
  damageChunk: (idx: number, dmg: number, allowDetach: boolean, fx: number, fy: number) => void,
): void {
  const tendrilCount = 3 + Math.floor(rand() * 3);
  for (let t = 0; t < tendrilCount; t++) {
    let cur = hitIdx;
    for (let hop = 0; hop < 2; hop++) {
      const nbrs = pane.chunks[cur].neighbors;
      if (nbrs.length === 0) break;
      const next = nbrs[Math.floor(rand() * nbrs.length)];
      damageChunk(next, 0.18 + rand() * 0.16, false, hitX, hitY);
      cur = next;
    }
  }
}
