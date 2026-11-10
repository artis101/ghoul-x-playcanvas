// Self-contained WebGL2 PlayCanvas ECS & Primitive Renderer Shim (~12KB)
// Provides exact PlayCanvas API compatibility for standalone cloud artifacts with zero external CDN dependencies.

export const BLEND_NONE = 3;
export const BLEND_NORMAL = 2;
export const BLEND_ADDITIVE = 1;
export const CULLFACE_NONE = 0;
export const CULLFACE_BACK = 1;
export const FILLMODE_FILL_WINDOW = 'FILL_WINDOW';
export const RESOLUTION_AUTO = 'AUTO';

export class Color {
  r: number;
  g: number;
  b: number;
  a: number;
  static YELLOW = new Color(1, 0.92, 0.2, 1);
  static RED = new Color(1, 0.15, 0.15, 1);
  static WHITE = new Color(1, 1, 1, 1);

  constructor(r = 1, g = 1, b = 1, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  set(r: number, g: number, b: number, a = 1): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }
  clone(): Color {
    return new Color(this.r, this.g, this.b, this.a);
  }
}

export class Vec3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(rhs: Vec3): this {
    this.x = rhs.x;
    this.y = rhs.y;
    this.z = rhs.z;
    return this;
  }
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }
  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  distance(rhs: Vec3): number {
    return Math.hypot(this.x - rhs.x, this.y - rhs.y, this.z - rhs.z);
  }
  normalize(): this {
    const len = this.length();
    if (len > 1e-6) {
      this.x /= len;
      this.y /= len;
      this.z /= len;
    }
    return this;
  }
}

export class StandardMaterial {
  diffuse = new Color(0.8, 0.8, 0.8);
  specular = new Color(0.2, 0.2, 0.2);
  emissive = new Color(0, 0, 0);
  emissiveIntensity = 1.0;
  metalness = 0.0;
  gloss = 0.5;
  useMetalness = false;
  opacity = 1.0;
  blendType = BLEND_NONE;
  depthWrite = true;
  cull = 1;
  update(): void {}
}

export class Mouse {
  constructor(_el?: HTMLElement) {}
}
export class TouchDevice {
  constructor(_el?: HTMLElement) {}
}
export class Keyboard {
  constructor(_el?: Window | HTMLElement) {}
}

export interface RenderComponent {
  type: 'box' | 'sphere' | 'cylinder' | 'capsule' | 'cone';
  material: StandardMaterial;
  castShadows?: boolean;
  receiveShadows?: boolean;
}

export interface CameraComponent {
  clearColor: Color;
  fov: number;
  nearClip: number;
  farClip: number;
}

export interface LightComponent {
  type: string;
  color: Color;
  intensity: number;
  castShadows?: boolean;
  shadowResolution?: number;
  shadowDistance?: number;
}

export class Entity {
  name: string;
  enabled = true;
  parent: Entity | null = null;
  children: Entity[] = [];
  private _localPos = new Vec3(0, 0, 0);
  private _localEuler = new Vec3(0, 0, 0);
  private _localScale = new Vec3(1, 1, 1);

  render?: RenderComponent;
  camera?: CameraComponent;
  light?: LightComponent;

  constructor(name = 'Entity') {
    this.name = name;
  }

  addChild(child: Entity): void {
    if (child.parent) {
      const idx = child.parent.children.indexOf(child);
      if (idx >= 0) child.parent.children.splice(idx, 1);
    }
    child.parent = this;
    this.children.push(child);
  }

  removeChild(child: Entity): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parent = null;
    }
  }

  destroy(): void {
    if (this.parent) {
      this.parent.removeChild(this);
    }
    for (const c of [...this.children]) {
      c.destroy();
    }
  }

  addComponent(type: string, data: Record<string, unknown> = {}): unknown {
    if (type === 'render') {
      this.render = {
        type: (data.type as RenderComponent['type']) || 'box',
        material: (data.material as StandardMaterial) || new StandardMaterial(),
        castShadows: Boolean(data.castShadows),
        receiveShadows: Boolean(data.receiveShadows),
      };
      return this.render;
    }
    if (type === 'camera') {
      this.camera = {
        clearColor: (data.clearColor as Color) || new Color(0.04, 0.06, 0.08),
        fov: Number(data.fov ?? 65),
        nearClip: Number(data.nearClip ?? 0.1),
        farClip: Number(data.farClip ?? 400),
      };
      return this.camera;
    }
    if (type === 'light') {
      this.light = {
        type: String(data.type ?? 'directional'),
        color: (data.color as Color) || new Color(1, 1, 1),
        intensity: Number(data.intensity ?? 1),
      };
      return this.light;
    }
    return {};
  }

  setLocalPosition(x: number | Vec3, y = 0, z = 0): void {
    if (x instanceof Vec3) {
      this._localPos.copy(x);
    } else {
      this._localPos.set(x, y, z);
    }
  }

  getLocalPosition(): Vec3 {
    return this._localPos;
  }

  setPosition(x: number | Vec3, y = 0, z = 0): void {
    if (x instanceof Vec3) {
      this.setPosition(x.x, x.y, x.z);
      return;
    }
    if (this.parent && this.parent.parent !== null) {
      const pPos = this.parent.getPosition();
      this._localPos.set(x - pPos.x, y - pPos.y, z - pPos.z);
    } else {
      this._localPos.set(x, y, z);
    }
  }

  getPosition(): Vec3 {
    const m = this.getWorldMatrix();
    return new Vec3(m[12], m[13], m[14]);
  }

  setLocalEulerAngles(x: number | Vec3, y = 0, z = 0): void {
    if (x instanceof Vec3) {
      this._localEuler.copy(x);
    } else {
      this._localEuler.set(x, y, z);
    }
  }

  setEulerAngles(x: number | Vec3, y = 0, z = 0): void {
    this.setLocalEulerAngles(x, y, z);
  }

  getEulerAngles(): Vec3 {
    return this._localEuler.clone();
  }

  getLocalEulerAngles(): Vec3 {
    return this._localEuler.clone();
  }

  setLocalScale(x: number | Vec3, y = 1, z = 1): void {
    if (x instanceof Vec3) {
      this._localScale.copy(x);
    } else {
      this._localScale.set(x, y, z);
    }
  }

  getLocalScale(): Vec3 {
    return this._localScale;
  }

  lookAt(target: Vec3 | number, y = 0, z = 0): void {
    const tx = target instanceof Vec3 ? target.x : target;
    const ty = target instanceof Vec3 ? target.y : y;
    const tz = target instanceof Vec3 ? target.z : z;
    const pos = this.getPosition();
    const dx = tx - pos.x;
    const dy = ty - pos.y;
    const dz = tz - pos.z;
    const horiz = Math.hypot(dx, dz);
    const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
    const pitch = (Math.atan2(dy, horiz) * 180) / Math.PI;
    this._localEuler.set(pitch, yaw, 0);
  }

  getLocalMatrix(): Float32Array {
    return composeTRS(this._localPos, this._localEuler, this._localScale);
  }

  getWorldMatrix(): Float32Array {
    const local = this.getLocalMatrix();
    if (!this.parent || this.parent.name === 'Root') {
      return local;
    }
    return mat4Multiply(this.parent.getWorldMatrix(), local);
  }
}

// Matrix math helpers
function composeTRS(pos: Vec3, eulerDeg: Vec3, scale: Vec3): Float32Array {
  const rx = (eulerDeg.x * Math.PI) / 180;
  const ry = (eulerDeg.y * Math.PI) / 180;
  const rz = (eulerDeg.z * Math.PI) / 180;

  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  // Y * X * Z intrinsic rotation order (matches standard FPS camera yaw->pitch->roll)
  const m00 = (cy * cz + sy * sx * sz) * scale.x;
  const m01 = (cx * sz) * scale.x;
  const m02 = (-sy * cz + cy * sx * sz) * scale.x;

  const m10 = (-cy * sz + sy * sx * cz) * scale.y;
  const m11 = (cx * cz) * scale.y;
  const m12 = (sy * sz + cy * sx * cz) * scale.y;

  const m20 = (sy * cx) * scale.z;
  const m21 = (-sx) * scale.z;
  const m22 = (cy * cx) * scale.z;

  const out = new Float32Array(16);
  out[0] = m00; out[1] = m01; out[2] = m02; out[3] = 0;
  out[4] = m10; out[5] = m11; out[6] = m12; out[7] = 0;
  out[8] = m20; out[9] = m21; out[10] = m22; out[11] = 0;
  out[12] = pos.x; out[13] = pos.y; out[14] = pos.z; out[15] = 1;
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(((fovDeg * Math.PI) / 180) * 0.5);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / Math.max(0.1, aspect);
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function mat4InvertRigidOrAffine(m: Float32Array): Float32Array {
  // General 4x4 inverse
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];

  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (Math.abs(det) < 1e-8) return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  det = 1.0 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  count: number;
}

export class Application {
  canvas: HTMLCanvasElement;
  root = new Entity('Root');
  private gl: WebGL2RenderingContext;
  private updateCallbacks: Array<(dt: number) => void> = [];
  private lastTime = performance.now();
  private meshProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private meshes: Record<string, MeshBuffers> = {};
  private lineVao: WebGLVertexArrayObject;
  private lineVbo: WebGLBuffer;
  private pendingLines: number[] = [];

  constructor(canvas: HTMLCanvasElement, _opts?: Record<string, unknown>) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 required');
    this.gl = gl;

    this.meshProgram = this.createMeshShader();
    this.lineProgram = this.createLineShader();
    this.meshes['box'] = this.buildBoxMesh();
    this.meshes['sphere'] = this.buildSphereMesh(14, 14, 0.5);
    this.meshes['cylinder'] = this.buildCylinderMesh(14, 0.5, 1.0);
    this.meshes['capsule'] = this.buildCylinderMesh(14, 0.5, 1.0);
    this.meshes['cone'] = this.buildCylinderMesh(12, 0.5, 1.0, 0.02);

    this.lineVao = gl.createVertexArray()!;
    this.lineVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);

    this.resizeCanvas();
  }

  setCanvasFillMode(_mode: string): void {}
  setCanvasResolution(_res: string): void {}

  resizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  on(event: string, cb: (dt: number) => void): void {
    if (event === 'update') {
      this.updateCallbacks.push(cb);
    }
  }

  drawLine(p1: Vec3, p2: Vec3, color: Color = Color.YELLOW): void {
    this.pendingLines.push(p1.x, p1.y, p1.z, color.r, color.g, color.b);
    this.pendingLines.push(p2.x, p2.y, p2.z, color.r, color.g, color.b);
  }

  start(): void {
    this.lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.resizeCanvas();
      for (const cb of this.updateCallbacks) {
        cb(dt);
      }
      this.renderFrame();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private renderFrame(): void {
    const gl = this.gl;
    let camEntity: Entity | null = null;
    const opaqueList: Entity[] = [];
    const transparentList: Entity[] = [];

    const traverse = (ent: Entity) => {
      if (!ent.enabled) return;
      if (ent.camera && !camEntity) camEntity = ent;
      if (ent.render) {
        if (ent.render.material.blendType !== BLEND_NONE || ent.render.material.opacity < 0.99) {
          transparentList.push(ent);
        } else {
          opaqueList.push(ent);
        }
      }
      for (const child of ent.children) {
        traverse(child);
      }
    };
    traverse(this.root);

    if (!camEntity || !camEntity.camera) return;
    const cam = (camEntity as Entity).camera!;
    gl.clearColor(cam.clearColor.r, cam.clearColor.g, cam.clearColor.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = mat4Perspective(cam.fov, aspect, cam.nearClip, cam.farClip);
    const camWorld = (camEntity as Entity).getWorldMatrix();
    const view = mat4InvertRigidOrAffine(camWorld);
    const vp = mat4Multiply(proj, view);
    const camPos = (camEntity as Entity).getPosition();

    gl.useProgram(this.meshProgram);
    const uMVP = gl.getUniformLocation(this.meshProgram, 'uMVP');
    const uModel = gl.getUniformLocation(this.meshProgram, 'uModel');
    const uDiffuse = gl.getUniformLocation(this.meshProgram, 'uDiffuse');
    const uEmissive = gl.getUniformLocation(this.meshProgram, 'uEmissive');
    const uOpacity = gl.getUniformLocation(this.meshProgram, 'uOpacity');
    const uCamPos = gl.getUniformLocation(this.meshProgram, 'uCamPos');
    const uIsFloor = gl.getUniformLocation(this.meshProgram, 'uIsFloor');

    gl.uniform3f(uCamPos, camPos.x, camPos.y, camPos.z);

    const drawEntity = (ent: Entity) => {
      const r = ent.render!;
      const mat = r.material;
      const mesh = this.meshes[r.type] || this.meshes['box'];
      const model = ent.getWorldMatrix();
      const mvp = mat4Multiply(vp, model);

      gl.uniformMatrix4fv(uMVP, false, mvp);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform3f(uDiffuse, mat.diffuse.r, mat.diffuse.g, mat.diffuse.b);
      gl.uniform3f(
        uEmissive,
        mat.emissive.r * mat.emissiveIntensity,
        mat.emissive.g * mat.emissiveIntensity,
        mat.emissive.b * mat.emissiveIntensity
      );
      gl.uniform1f(uOpacity, mat.opacity);
      gl.uniform1i(uIsFloor, ent.name === 'ArenaFloor' ? 1 : 0);

      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    };

    // Pass 1: Opaque
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const ent of opaqueList) drawEntity(ent);

    // Pass 2: Lines (bullet trajectories)
    if (this.pendingLines.length > 0) {
      gl.useProgram(this.lineProgram);
      const uLineVP = gl.getUniformLocation(this.lineProgram, 'uVP');
      gl.uniformMatrix4fv(uLineVP, false, vp);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.pendingLines), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this.pendingLines.length / 6);
      this.pendingLines.length = 0;
    }

    // Pass 3: Transparent (X-Ray Silhouette, Shockwave Rings)
    if (transparentList.length > 0) {
      gl.useProgram(this.meshProgram);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const ent of transparentList) drawEntity(ent);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  private createMeshShader(): WebGLProgram {
    const vs = `#version 300 es
    layout(location=0) in vec3 aPos;
    layout(location=1) in vec3 aNormal;
    uniform mat4 uMVP;
    uniform mat4 uModel;
    out vec3 vNormal;
    out vec3 vWorldPos;
    void main() {
      vec4 wp = uModel * vec4(aPos, 1.0);
      vWorldPos = wp.xyz;
      vNormal = normalize(mat3(uModel) * aNormal);
      gl_Position = uMVP * vec4(aPos, 1.0);
    }`;

    const fs = `#version 300 es
    precision highp float;
    in vec3 vNormal;
    in vec3 vWorldPos;
    uniform vec3 uDiffuse;
    uniform vec3 uEmissive;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform int uIsFloor;
    out vec4 fragColor;
    void main() {
      vec3 N = normalize(vNormal);
      vec3 L1 = normalize(vec3(0.45, 0.82, 0.35));
      vec3 L2 = normalize(vec3(-0.4, 0.35, -0.7));
      float diff1 = max(dot(N, L1), 0.0);
      float diff2 = max(dot(N, L2), 0.0) * 0.35;
      vec3 V = normalize(uCamPos - vWorldPos);
      float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);

      vec3 baseCol = uDiffuse;
      if (uIsFloor == 1) {
        // Tactical firing range 1m grid lines
        vec2 grid = abs(fract(vWorldPos.xz - 0.5) - 0.5) / fwidth(vWorldPos.xz);
        float line = min(grid.x, grid.y);
        float gridFactor = 1.0 - min(line, 1.0);
        baseCol = mix(uDiffuse, vec3(0.18, 0.24, 0.32), gridFactor * 0.45);
      }

      vec3 lit = baseCol * (0.28 + diff1 * 0.78 + diff2) + uEmissive + (uEmissive * rim * 1.4);
      // Distance fog
      float dist = length(uCamPos - vWorldPos);
      float fog = clamp((dist - 35.0) / 95.0, 0.0, 0.75);
      vec3 col = mix(lit, vec3(0.04, 0.06, 0.09), fog);
      fragColor = vec4(col, uOpacity);
    }`;
    return this.compileProgram(vs, fs);
  }

  private createLineShader(): WebGLProgram {
    const vs = `#version 300 es
    layout(location=0) in vec3 aPos;
    layout(location=1) in vec3 aColor;
    uniform mat4 uVP;
    out vec3 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uVP * vec4(aPos, 1.0);
    }`;
    const fs = `#version 300 es
    precision mediump float;
    in vec3 vColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(vColor, 1.0);
    }`;
    return this.compileProgram(vs, fs);
  }

  private compileProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return prog;
  }

  private createMeshBuffers(verts: number[]): MeshBuffers {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, count: verts.length / 6 };
  }

  private buildBoxMesh(): MeshBuffers {
    const faces = [
      { n: [0, 0, 1], v: [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]] },
      { n: [0, 0, -1], v: [[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5]] },
      { n: [0, 1, 0], v: [[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5]] },
      { n: [0, -1, 0], v: [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[-0.5,-0.5,0.5]] },
      { n: [1, 0, 0], v: [[0.5,-0.5,0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5]] },
      { n: [-1, 0, 0], v: [[-0.5,-0.5,-0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5]] },
    ];
    const data: number[] = [];
    for (const f of faces) {
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        data.push(f.v[idx][0], f.v[idx][1], f.v[idx][2], f.n[0], f.n[1], f.n[2]);
      }
    }
    return this.createMeshBuffers(data);
  }

  private buildSphereMesh(latBands: number, lonBands: number, radius: number): MeshBuffers {
    const data: number[] = [];
    for (let lat = 0; lat < latBands; lat++) {
      const t1 = (lat * Math.PI) / latBands;
      const t2 = ((lat + 1) * Math.PI) / latBands;
      for (let lon = 0; lon < lonBands; lon++) {
        const p1 = (lon * 2 * Math.PI) / lonBands;
        const p2 = ((lon + 1) * 2 * Math.PI) / lonBands;
        const pts = [
          [Math.sin(t1)*Math.cos(p1), Math.cos(t1), Math.sin(t1)*Math.sin(p1)],
          [Math.sin(t2)*Math.cos(p1), Math.cos(t2), Math.sin(t2)*Math.sin(p1)],
          [Math.sin(t2)*Math.cos(p2), Math.cos(t2), Math.sin(t2)*Math.sin(p2)],
          [Math.sin(t1)*Math.cos(p2), Math.cos(t1), Math.sin(t1)*Math.sin(p2)],
        ];
        for (const i of [0, 1, 2, 0, 2, 3]) {
          const n = pts[i];
          data.push(n[0]*radius, n[1]*radius, n[2]*radius, n[0], n[1], n[2]);
        }
      }
    }
    return this.createMeshBuffers(data);
  }

  private buildCylinderMesh(segs: number, rBottom: number, height: number, rTop = rBottom): MeshBuffers {
    const data: number[] = [];
    const hy = height * 0.5;
    for (let i = 0; i < segs; i++) {
      const a1 = (i * 2 * Math.PI) / segs;
      const a2 = ((i + 1) * 2 * Math.PI) / segs;
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const c2 = Math.cos(a2), s2 = Math.sin(a2);
      const p0 = [c1 * rBottom, -hy, s1 * rBottom];
      const p1 = [c2 * rBottom, -hy, s2 * rBottom];
      const p2 = [c2 * rTop, hy, s2 * rTop];
      const p3 = [c1 * rTop, hy, s1 * rTop];
      const n1 = [c1, 0, s1], n2 = [c2, 0, s2];
      // Side quad
      data.push(...p0, ...n1, ...p1, ...n2, ...p2, ...n2);
      data.push(...p0, ...n1, ...p2, ...n2, ...p3, ...n1);
      // Top cap
      data.push(0, hy, 0, 0, 1, 0, p3[0], hy, p3[2], 0, 1, 0, p2[0], hy, p2[2], 0, 1, 0);
      // Bottom cap
      data.push(0, -hy, 0, 0, -1, 0, p1[0], -hy, p1[2], 0, -1, 0, p0[0], -hy, p0[2], 0, -1, 0);
    }
    return this.createMeshBuffers(data);
  }
}

export type AppBase = Application;
