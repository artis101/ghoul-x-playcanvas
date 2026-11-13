import * as pc from 'playcanvas';
import { HALL_SHELL } from '../world/arenaLayout.ts';

// Keep the player just inside the hall's tiled walls; everything else is solid collision.
const WALL_MARGIN_M = 0.45;

export class PlayerMovementSolver {
  public readonly playerPos = new pc.Vec3(0, 1.62, 0);
  private readonly scratchPrevPos = new pc.Vec3();

  public resolveHorizontalMovement?: (prev: pc.Vec3, next: pc.Vec3) => void;

  public updateMovement(
    dt: number,
    cameraYaw: number,
    keysPressed: Record<string, boolean>,
    speedScale = 1
  ): { moving: boolean; strafeSign: number } {
    this.scratchPrevPos.copy(this.playerPos);
    const moveSpeed = 5.0 * speedScale * dt;
    const yawRad = (cameraYaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    let moving = false;
    let strafeSign = 0;
    if (keysPressed['KeyW']) {
      this.playerPos.x += fwdX * moveSpeed;
      this.playerPos.z += fwdZ * moveSpeed;
      moving = true;
    }
    if (keysPressed['KeyS']) {
      this.playerPos.x -= fwdX * moveSpeed;
      this.playerPos.z -= fwdZ * moveSpeed;
      moving = true;
    }
    if (keysPressed['KeyA']) {
      this.playerPos.x -= rightX * moveSpeed;
      this.playerPos.z -= rightZ * moveSpeed;
      moving = true;
      strafeSign -= 1;
    }
    if (keysPressed['KeyD']) {
      this.playerPos.x += rightX * moveSpeed;
      this.playerPos.z += rightZ * moveSpeed;
      moving = true;
      strafeSign += 1;
    }

    if (this.resolveHorizontalMovement) {
      this.resolveHorizontalMovement(this.scratchPrevPos, this.playerPos);
    }

    const maxX = HALL_SHELL.halfWidthM - WALL_MARGIN_M;
    this.playerPos.x = Math.max(-maxX, Math.min(maxX, this.playerPos.x));
    this.playerPos.z = Math.max(
      HALL_SHELL.backZ + WALL_MARGIN_M,
      Math.min(HALL_SHELL.frontZ - WALL_MARGIN_M, this.playerPos.z)
    );

    return { moving, strafeSign };
  }
}
