import * as pc from 'playcanvas';
import { HALL_SHELL } from '../world/arenaLayout.ts';

// Keep the player just inside the hall's tiled walls; everything else is solid collision.
const WALL_MARGIN_M = 0.45;

export interface PlayerMovementResult {
  moving: boolean;
  strafeSign: number;
}

export class PlayerMovementSolver {
  public readonly playerPos = new pc.Vec3(0, 1.62, 0);
  private readonly scratchPrevPos = new pc.Vec3();
  private readonly result: PlayerMovementResult = { moving: false, strafeSign: 0 };

  public resolveHorizontalMovement?: (prev: pc.Vec3, next: pc.Vec3) => void;

  public updateMovement(
    dt: number,
    cameraYaw: number,
    keysPressed: Record<string, boolean>,
    speedScale = 1
  ): Readonly<PlayerMovementResult> {
    this.scratchPrevPos.copy(this.playerPos);
    const moveSpeed = 5.0 * speedScale * dt;
    const yawRad = (cameraYaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    const w = keysPressed['KeyW'] ? 1 : 0;
    const s = keysPressed['KeyS'] ? 1 : 0;
    const a = keysPressed['KeyA'] ? 1 : 0;
    const d = keysPressed['KeyD'] ? 1 : 0;
    const forwardInput = w - s;
    const rightInput = d - a;
    // Pressing two directions at once does not add their speeds: the wish vector is capped at length 1.
    const inputLen = Math.hypot(forwardInput, rightInput);
    const inputScale = inputLen > 1 ? 1 / inputLen : 1;
    const forwardStep = forwardInput * inputScale * moveSpeed;
    const rightStep = rightInput * inputScale * moveSpeed;
    this.playerPos.x += fwdX * forwardStep + rightX * rightStep;
    this.playerPos.z += fwdZ * forwardStep + rightZ * rightStep;
    this.result.moving = w + s + a + d > 0;
    this.result.strafeSign = rightInput;

    if (this.resolveHorizontalMovement) {
      this.resolveHorizontalMovement(this.scratchPrevPos, this.playerPos);
    }

    const maxX = HALL_SHELL.halfWidthM - WALL_MARGIN_M;
    this.playerPos.x = Math.max(-maxX, Math.min(maxX, this.playerPos.x));
    this.playerPos.z = Math.max(
      HALL_SHELL.backZ + WALL_MARGIN_M,
      Math.min(HALL_SHELL.frontZ - WALL_MARGIN_M, this.playerPos.z)
    );

    return this.result;
  }
}
