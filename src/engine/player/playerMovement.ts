import * as pc from 'playcanvas';

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

    this.playerPos.x = Math.max(-8.2, Math.min(8.2, this.playerPos.x));
    this.playerPos.z = Math.max(-52.0, Math.min(6.0, this.playerPos.z));

    return { moving, strafeSign };
  }
}
