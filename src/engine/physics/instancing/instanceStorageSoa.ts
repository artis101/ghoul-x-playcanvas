export class InstanceStorageSoa {
  public readonly maxInstances: number;
  public readonly matrixData: Float32Array;

  public count = 0;
  public freeCount: number;
  public isDirty = false;

  public readonly freeStack: Int32Array;
  public readonly slotToDense: Int32Array;
  public readonly denseToSlot: Int32Array;

  public readonly denseMode: Uint8Array;
  public readonly denseBodyHandle: Int32Array;
  public readonly denseSleepingSynced: Uint8Array;

  public readonly denseScaleX: Float32Array;
  public readonly denseScaleY: Float32Array;
  public readonly denseScaleZ: Float32Array;

  public readonly densePosX: Float32Array;
  public readonly densePosY: Float32Array;
  public readonly densePosZ: Float32Array;

  public readonly denseVelX: Float32Array;
  public readonly denseVelY: Float32Array;
  public readonly denseVelZ: Float32Array;

  public readonly denseQuatX: Float32Array;
  public readonly denseQuatY: Float32Array;
  public readonly denseQuatZ: Float32Array;
  public readonly denseQuatW: Float32Array;

  public readonly denseAngVelX: Float32Array;
  public readonly denseAngVelY: Float32Array;
  public readonly denseAngVelZ: Float32Array;

  public readonly denseGravityY: Float32Array;
  public readonly denseRestitution: Float32Array;
  public readonly denseAgeS: Float32Array;
  public readonly denseTtlS: Float32Array;

  public constructor(maxInstances: number) {
    const cap = Math.max(1, Math.floor(maxInstances));
    this.maxInstances = cap;
    this.matrixData = new Float32Array(cap * 16);

    this.freeCount = cap;
    this.freeStack = new Int32Array(cap);
    this.slotToDense = new Int32Array(cap);
    this.denseToSlot = new Int32Array(cap);

    for (let i = 0; i < cap; i++) {
      this.freeStack[i] = cap - 1 - i;
      this.slotToDense[i] = -1;
      this.denseToSlot[i] = -1;
    }

    this.denseMode = new Uint8Array(cap);
    this.denseBodyHandle = new Int32Array(cap);
    this.denseSleepingSynced = new Uint8Array(cap);

    this.denseScaleX = new Float32Array(cap);
    this.denseScaleY = new Float32Array(cap);
    this.denseScaleZ = new Float32Array(cap);

    this.densePosX = new Float32Array(cap);
    this.densePosY = new Float32Array(cap);
    this.densePosZ = new Float32Array(cap);

    this.denseVelX = new Float32Array(cap);
    this.denseVelY = new Float32Array(cap);
    this.denseVelZ = new Float32Array(cap);

    this.denseQuatX = new Float32Array(cap);
    this.denseQuatY = new Float32Array(cap);
    this.denseQuatZ = new Float32Array(cap);
    this.denseQuatW = new Float32Array(cap);

    this.denseAngVelX = new Float32Array(cap);
    this.denseAngVelY = new Float32Array(cap);
    this.denseAngVelZ = new Float32Array(cap);

    this.denseGravityY = new Float32Array(cap);
    this.denseRestitution = new Float32Array(cap);
    this.denseAgeS = new Float32Array(cap);
    this.denseTtlS = new Float32Array(cap);
  }

  public allocSlot(): number {
    if (this.freeCount === 0 || this.count >= this.maxInstances) return -1;
    const slotId = this.freeStack[--this.freeCount];
    const denseIndex = this.count++;
    this.slotToDense[slotId] = denseIndex;
    this.denseToSlot[denseIndex] = slotId;

    this.denseScaleX[denseIndex] = 1;
    this.denseScaleY[denseIndex] = 1;
    this.denseScaleZ[denseIndex] = 1;
    this.denseQuatX[denseIndex] = 0;
    this.denseQuatY[denseIndex] = 0;
    this.denseQuatZ[denseIndex] = 0;
    this.denseQuatW[denseIndex] = 1;
    this.denseSleepingSynced[denseIndex] = 0;
    this.denseAgeS[denseIndex] = 0;
    this.denseTtlS[denseIndex] = 0;

    const base = denseIndex * 16;
    this.matrixData.fill(0, base, base + 16);
    this.matrixData[base] = 1;
    this.matrixData[base + 5] = 1;
    this.matrixData[base + 10] = 1;
    this.matrixData[base + 15] = 1;

    this.isDirty = true;
    return slotId;
  }

  public freeSlot(slotId: number): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) return false;
    const denseIndex = this.slotToDense[slotId];
    if (denseIndex < 0) return false;

    const lastDense = this.count - 1;
    if (denseIndex < lastDense) {
      const src16 = lastDense * 16;
      const dst16 = denseIndex * 16;
      for (let i = 0; i < 16; i++) this.matrixData[dst16 + i] = this.matrixData[src16 + i];

      this.denseMode[denseIndex] = this.denseMode[lastDense];
      this.denseBodyHandle[denseIndex] = this.denseBodyHandle[lastDense];
      this.denseSleepingSynced[denseIndex] = this.denseSleepingSynced[lastDense];
      this.denseScaleX[denseIndex] = this.denseScaleX[lastDense];
      this.denseScaleY[denseIndex] = this.denseScaleY[lastDense];
      this.denseScaleZ[denseIndex] = this.denseScaleZ[lastDense];
      this.densePosX[denseIndex] = this.densePosX[lastDense];
      this.densePosY[denseIndex] = this.densePosY[lastDense];
      this.densePosZ[denseIndex] = this.densePosZ[lastDense];
      this.denseVelX[denseIndex] = this.denseVelX[lastDense];
      this.denseVelY[denseIndex] = this.denseVelY[lastDense];
      this.denseVelZ[denseIndex] = this.denseVelZ[lastDense];
      this.denseQuatX[denseIndex] = this.denseQuatX[lastDense];
      this.denseQuatY[denseIndex] = this.denseQuatY[lastDense];
      this.denseQuatZ[denseIndex] = this.denseQuatZ[lastDense];
      this.denseQuatW[denseIndex] = this.denseQuatW[lastDense];
      this.denseAngVelX[denseIndex] = this.denseAngVelX[lastDense];
      this.denseAngVelY[denseIndex] = this.denseAngVelY[lastDense];
      this.denseAngVelZ[denseIndex] = this.denseAngVelZ[lastDense];
      this.denseGravityY[denseIndex] = this.denseGravityY[lastDense];
      this.denseRestitution[denseIndex] = this.denseRestitution[lastDense];
      this.denseAgeS[denseIndex] = this.denseAgeS[lastDense];
      this.denseTtlS[denseIndex] = this.denseTtlS[lastDense];

      const movedSlotId = this.denseToSlot[lastDense];
      this.denseToSlot[denseIndex] = movedSlotId;
      this.slotToDense[movedSlotId] = denseIndex;
    }

    this.slotToDense[slotId] = -1;
    this.denseToSlot[lastDense] = -1;
    this.count = lastDense;
    this.freeStack[this.freeCount++] = slotId;
    this.isDirty = true;
    return true;
  }
}
