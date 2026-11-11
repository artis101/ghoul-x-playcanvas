import type { EnemyFireMode } from '../../contracts/ai/aiContracts.ts';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import { add, cross, normalize, scale, sub, vec3 } from '../ballistics/vec3.ts';

export type CombatantResolveKind =
  | 'HARDENED_VETERAN'
  | 'FANATIC_BERSERKER'
  | 'GRITTY_REGULAR'
  | 'PANICKED_SCRAPPER';

export interface AttackTokenCandidate {
  readonly targetId: string;
  readonly alive: boolean;
  readonly canReturnFire: boolean;
  readonly isPeekingOut: boolean;
  readonly hasLineOfSight: boolean;
  readonly isOnScreen: boolean;
  readonly distanceToPlayerM: number;
  readonly resolveProfile: CombatantResolveKind;
  readonly completedBurstCount: number;
  readonly suppression: number;
}

/**
 * Pure deterministic squad Attack Token Manager ("Kung-Fu Circle" arbiter).
 * Grants up to `maxAggressiveTokens` (default 3) lethal fire tokens based on
 * resolve profile, LoS, frustum visibility, proximity, and burst rotation.
 * Non-token holders enter `'CINEMATIC_SUPPRESSION'` to shred cover/glass around the player.
 */
export class AttackTokenPool {
  private readonly maxAggressiveTokens: number;
  private readonly holderGrantedAtBurst = new Map<string, number>();
  private readonly currentAssignments = new Map<string, EnemyFireMode>();

  public constructor(maxAggressiveTokens = 3) {
    this.maxAggressiveTokens = Math.max(1, Math.floor(maxAggressiveTokens));
  }

  public assignTokens(
    candidates: readonly AttackTokenCandidate[]
  ): ReadonlyMap<string, EnemyFireMode> {
    this.currentAssignments.clear();

    const aliveIds = new Set<string>();
    const eligible: { candidate: AttackTokenCandidate; score: number }[] = [];

    for (const c of candidates) {
      if (!c.alive) continue;
      aliveIds.add(c.targetId);

      if (!c.canReturnFire) {
        this.holderGrantedAtBurst.delete(c.targetId);
        this.currentAssignments.set(c.targetId, 'CINEMATIC_SUPPRESSION');
        continue;
      }

      const score = this.scoreCandidate(c);
      eligible.push({ candidate: c, score });
    }

    for (const oldId of Array.from(this.holderGrantedAtBurst.keys())) {
      if (!aliveIds.has(oldId)) {
        this.holderGrantedAtBurst.delete(oldId);
      }
    }

    eligible.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-4) return b.score - a.score;
      return a.candidate.targetId.localeCompare(b.candidate.targetId);
    });

    const nextHolders = new Set<string>();
    for (let i = 0; i < eligible.length; i++) {
      const item = eligible[i].candidate;
      if (i < this.maxAggressiveTokens) {
        nextHolders.add(item.targetId);
        this.currentAssignments.set(item.targetId, 'AGGRESSIVE_LETHAL');
        if (!this.holderGrantedAtBurst.has(item.targetId)) {
          this.holderGrantedAtBurst.set(item.targetId, item.completedBurstCount);
        }
      } else {
        this.currentAssignments.set(item.targetId, 'CINEMATIC_SUPPRESSION');
      }
    }

    for (const oldId of Array.from(this.holderGrantedAtBurst.keys())) {
      if (!nextHolders.has(oldId)) {
        this.holderGrantedAtBurst.delete(oldId);
      }
    }

    return this.currentAssignments;
  }

  public getFireMode(targetId: string): EnemyFireMode {
    return this.currentAssignments.get(targetId) ?? 'AGGRESSIVE_LETHAL';
  }

  public releaseToken(targetId: string): void {
    this.holderGrantedAtBurst.delete(targetId);
    this.currentAssignments.delete(targetId);
  }

  public reset(): void {
    this.holderGrantedAtBurst.clear();
    this.currentAssignments.clear();
  }

  private scoreCandidate(c: AttackTokenCandidate): number {
    let score = 0;

    switch (c.resolveProfile) {
      case 'FANATIC_BERSERKER':
        score += 42;
        break;
      case 'HARDENED_VETERAN':
        score += 34;
        break;
      case 'GRITTY_REGULAR':
        score += 22;
        break;
      case 'PANICKED_SCRAPPER':
        score += 12;
        break;
    }

    if (c.hasLineOfSight) score += 50;
    if (c.isPeekingOut) score += 24;
    if (c.isOnScreen) score += 22;

    const clampedDist = Math.max(0, Math.min(35, c.distanceToPlayerM));
    score += (35 - clampedDist) * 0.85;
    score -= c.suppression * 18;

    const grantedBurst = this.holderGrantedAtBurst.get(c.targetId);
    if (grantedBurst !== undefined) {
      const burstsSinceGrant = Math.max(0, c.completedBurstCount - grantedBurst);
      if (burstsSinceGrant === 0) {
        score += 16; // Hysteresis while completing current burst
      } else {
        score -= burstsSinceGrant * 24; // Rotate token to waiting squadmates after burst
      }
    }

    return score;
  }
}

/**
 * Computes a deterministic aim target around the player camera for cinematic suppression
 * (`0.55–1.45m` lateral/vertical offset) or first-shot warning sparks (`0.6–1.1m` in front).
 */
export function computeSuppressionTargetWorld(
  seed: number,
  playerEyeWorld: Vec3Like,
  shooterOriginWorld: Vec3Like,
  isFirstShotWarning: boolean
): Vec3Like {
  const toPlayer = sub(playerEyeWorld, shooterOriginWorld);
  const fwd = normalize({ x: toPlayer.x, y: 0, z: toPlayer.z });
  const right = normalize(cross(fwd, vec3(0, 1, 0)));

  const h = ((seed * 2654435761) >>> 0) % 1000;
  const u1 = (h % 100) / 100;
  const u2 = (Math.floor(h / 100) % 10) / 10;
  const sideSign = seed % 2 === 0 ? 1 : -1;

  if (isFirstShotWarning) {
    // Spark a surface 0.6–1.1m in front of the player camera and 0.55–0.85m off-axis
    const forwardStepM = 0.6 + u1 * 0.5;
    const lateralOffsetM = sideSign * (0.55 + u2 * 0.3);
    const verticalOffsetM = -0.38 + u1 * 0.22;
    const frontAnchor = sub(playerEyeWorld, scale(fwd, forwardStepM));
    return add(
      add(frontAnchor, scale(right, lateralOffsetM)),
      vec3(0, verticalOffsetM, 0)
    );
  }

  // Cinematic suppression: miss by 0.55–1.45m toward cover edges, window glass & wall frames
  const lateralMagM = 0.55 + u1 * 0.9;
  const verticalOffsetM = -0.34 + u2 * 0.88;
  const depthBiasM = (u1 - 0.5) * 0.65;
  return add(
    add(playerEyeWorld, scale(right, sideSign * lateralMagM)),
    vec3(fwd.x * depthBiasM, verticalOffsetM, fwd.z * depthBiasM)
  );
}
