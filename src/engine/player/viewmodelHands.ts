import * as pc from 'playcanvas';
import type { WeaponAssetId, WeaponGlbInstance } from '../assets/glbLoader.ts';

type Point = [number, number, number];
type Grip = { center: Point; width: number; depth: number; rake: number };
type Hold = { right: Grip; left?: { center: Point; vertical?: boolean; bone?: string } };

const HOLDS: Record<WeaponAssetId, Hold> = {
  m4a1_carbine: {
    right: { center: [0, -0.056, 0.026], width: 0.016, depth: 0.021, rake: 0.36 },
    left: { center: [0, -0.060, -0.272], vertical: true },
  },
  m590_shotgun: {
    right: { center: [0, -0.017, 0.072], width: 0.016, depth: 0.021, rake: 0.30 },
    left: { center: [0, -0.009, -0.343], bone: 'Bone_Pump' },
  },
  silver_talon_50ae: {
    right: { center: [0, -0.052, 0.022], width: 0.019, depth: 0.027, rake: 0.33 },
    left: { center: [0, -0.060, 0.010], vertical: true },
  },
  msg90_sniper: {
    right: { center: [0, -0.062, 0.029], width: 0.019, depth: 0.024, rake: 0.34 },
    left: { center: [0, 0.004, -0.300] },
  },
  frag_grenade: {
    right: { center: [0, -0.004, 0], width: 0.033, depth: 0.033, rake: 0 },
  },
};

const sphere = new pc.SphereGeometry({ radius: 1, latitudeBands: 10, longitudeBands: 12 });

class HandMesh {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly indices: number[] = [];
  private readonly uvs: number[] = [];

  ellipsoid(center: Point, radii: Point, rotation = pc.Quat.IDENTITY, exponent = 1): void {
    const offset = this.positions.length / 3;
    const point = new pc.Vec3();
    const normal = new pc.Vec3();
    const { positions, normals, indices } = sphere;
    for (let i = 0; i < positions.length; i += 3) {
      const profile = (v: number) => Math.sign(v) * Math.abs(v) ** exponent;
      point.set(profile(positions[i]) * radii[0], profile(positions[i + 1]) * radii[1], profile(positions[i + 2]) * radii[2]);
      rotation.transformVector(point, point);
      this.positions.push(point.x + center[0], point.y + center[1], point.z + center[2]);
      const normalProfile = (v: number) => Math.sign(v) * Math.abs(v) ** (2 - exponent);
      normal.set(normalProfile(normals[i]) / radii[0], normalProfile(normals[i + 1]) / radii[1], normalProfile(normals[i + 2]) / radii[2]).normalize();
      rotation.transformVector(normal, normal);
      this.normals.push(normal.x, normal.y, normal.z);
    }
    for (const uv of sphere.uvs) this.uvs.push(uv);
    for (const index of indices) this.indices.push(index + offset);
  }

  segment(start: Point, end: Point, width: number, depth = width): void {
    const direction = new pc.Vec3(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const length = direction.length();
    const rotation = new pc.Quat().setFromDirections(pc.Vec3.UP, direction.normalize());
    this.ellipsoid(
      [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      [width, length / 2 + width * 0.65, depth],
      rotation,
    );
  }

  sleeve(wrist: Point, cuff: Point, elbow: Point): void {
    const start = new pc.Vec3(...wrist);
    const middle = new pc.Vec3(...cuff);
    const end = new pc.Vec3(...elbow);
    this.loft([
      { center: start, radius: 0.022 },
      { center: new pc.Vec3().lerp(start, middle, 0.10), radius: 0.026 },
      { center: new pc.Vec3().lerp(start, middle, 0.34), radius: 0.026 },
      { center: new pc.Vec3().lerp(start, middle, 0.42), radius: 0.024 },
      { center: middle, radius: 0.028 },
      { center: new pc.Vec3().lerp(middle, end, 0.19), radius: 0.030 },
      { center: new pc.Vec3().lerp(middle, end, 0.31), radius: 0.029 },
      { center: new pc.Vec3().lerp(middle, end, 0.50), radius: 0.034 },
      { center: new pc.Vec3().lerp(middle, end, 0.63), radius: 0.032 },
      { center: new pc.Vec3().lerp(middle, end, 0.78), radius: 0.036 },
      { center: end, radius: 0.036 },
    ], 24, 0.86);
  }

  finger(start: Point, bend: Point, tip: Point, radius: number): void {
    const a = new pc.Vec3(...start);
    const b = new pc.Vec3(...bend);
    const c = new pc.Vec3(...tip);
    this.loft([
      { center: a, radius },
      { center: new pc.Vec3().lerp(a, b, 0.65), radius: radius * 0.93 },
      { center: b, radius: radius * 0.88 },
      { center: new pc.Vec3().lerp(b, c, 0.64), radius: radius * 0.80 },
      { center: c, radius: radius * 0.59 },
      { center: c.clone().addScaled(new pc.Vec3().sub2(c, b).normalize(), radius * 0.36), radius: radius * 0.24 },
    ], 12, 0.90);
  }

  private loft(stations: { center: pc.Vec3; radius: number }[], sides: number, aspect: number): void {
    const stride = sides + 1;
    const base = this.positions.length / 3;
    const firstDirection = new pc.Vec3().sub2(stations[1].center, stations[0].center).normalize();
    const reference = Math.abs(firstDirection.y) > 0.9 ? pc.Vec3.RIGHT : pc.Vec3.UP;
    let distance = 0;
    for (const [ring, { center, radius }] of stations.entries()) {
      const previous = stations[Math.max(ring - 1, 0)].center;
      const next = stations[Math.min(ring + 1, stations.length - 1)].center;
      const tangent = new pc.Vec3().sub2(next, previous).normalize();
      const across = new pc.Vec3().cross(reference, tangent).normalize();
      const up = new pc.Vec3().cross(tangent, across);
      distance += center.distance(previous);
      for (let i = 0; i <= sides; i++) {
        const angle = i * 2 * Math.PI / sides;
        const u = Math.cos(angle);
        const v = Math.sin(angle);
        const point = across.clone().mulScalar(radius * u).addScaled(up, radius * aspect * v).add(center);
        const normal = across.clone().mulScalar(u).addScaled(up, v / aspect).normalize();
        this.positions.push(point.x, point.y, point.z);
        this.normals.push(normal.x, normal.y, normal.z);
        this.uvs.push(i / sides, distance * 8);
        if (ring === 0 || i === sides) continue;
        const a = base + (ring - 1) * stride + i;
        const b = a + 1;
        this.indices.push(a, b, b + stride, a, b + stride, a + stride);
      }
    }
    const first = base;
    const last = base + (stations.length - 1) * stride;
    for (let i = 1; i < sides - 1; i++) {
      this.indices.push(first, first + i + 1, first + i, last, last + i, last + i + 1);
    }
  }

  attach(node: pc.Entity, device: pc.GraphicsDevice, material: pc.Material): pc.MeshInstance {
    const mesh = new pc.Mesh(device);
    mesh.setPositions(this.positions);
    mesh.setNormals(this.normals);
    mesh.setUvs(0, this.uvs);
    mesh.setVertexStream(pc.SEMANTIC_TANGENT, pc.calculateTangents(this.positions, this.normals, this.uvs, this.indices), 4);
    mesh.setIndices(this.indices);
    mesh.update();
    return new pc.MeshInstance(mesh, material, node);
  }
}

const fabricNormals = new WeakMap<pc.GraphicsDevice, pc.Texture>();

function getFabricNormal(device: pc.GraphicsDevice): pc.Texture {
  const existing = fabricNormals.get(device);
  if (existing) return existing;
  const size = 64;
  const map = new pc.Texture(device, {
    name: 'Viewmodel fabric weave',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  const data = map.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * Math.PI / 4;
      const v = y * Math.PI / 4;
      const dx = Math.cos(u) * (0.18 + 0.07 * Math.sin(v));
      const dy = Math.cos(v) * (0.18 - 0.07 * Math.sin(u));
      const index = (y * size + x) * 4;
      data[index] = 128 + 127 * dx;
      data[index + 1] = 128 + 127 * dy;
      data[index + 2] = 128 + 127 * Math.sqrt(1 - dx * dx - dy * dy);
      data[index + 3] = 255;
    }
  }
  map.unlock();
  fabricNormals.set(device, map);
  device.once('destroy', () => map.destroy());
  return map;
}

function makeMaterial(color: Point, gloss: number, weave?: pc.Texture, tiling = 1): pc.StandardMaterial {
  const material = new pc.StandardMaterial();
  material.diffuse.set(...color);
  material.gloss = gloss;
  if (weave) {
    material.normalMap = weave;
    material.normalMapTiling.set(tiling, tiling);
    material.bumpiness = 0.7;
  }
  material.update();
  return material;
}

function buildRightHand(glove: HandMesh, sleeve: HandMesh, armor: HandMesh, grip: Grip, grenade: boolean): void {
  const { center: [x, y, z], width, depth, rake } = grip;
  glove.ellipsoid([x + width + 0.008, y, z + 0.013], [0.018, 0.040, 0.025],
    new pc.Quat().setFromEulerAngles(-18, 0, 8), 0.78);
  for (let i = 0; i < 4; i++) {
    const fingerY = y + 0.023 - i * 0.017;
    const fingerZ = z + (y - fingerY) * rake;
    const knuckle: Point = [x + width + 0.009, fingerY, fingerZ];
    const bend: Point = [x + width * 0.66, fingerY - 0.003, fingerZ - depth - 0.005];
    const tip: Point = [x - width * (i === 3 ? 0.36 : 0.75), fingerY - 0.006, fingerZ - depth - 0.004];
    const radius = 0.009 - i * 0.00065;
    if (i === 0 && !grenade) {
      // Indexed along the side of the frame in the holding pose.
      glove.segment([knuckle[0], y + 0.035, z + 0.005], [x + width + 0.007, y + 0.041, z - 0.048], radius);
    } else {
      glove.finger(knuckle, bend, tip, radius);
    }
    armor.ellipsoid([knuckle[0] + 0.011, fingerY - 0.001, fingerZ + 0.010],
      [0.0055, 0.0077, 0.010], new pc.Quat().setFromEulerAngles(-16, -14, 8), 0.66);
  }
  const thumbBase: Point = [x + width * 0.8, y + 0.020, z + depth + 0.007];
  const thumbBend: Point = [x - 0.005, y + 0.031, z + depth + 0.005];
  glove.finger(thumbBase, thumbBend, [x - width, y + 0.029, z + 0.008], 0.011);

  const wrist: Point = [x + width + 0.018, y - 0.030, z + 0.034];
  const cuff: Point = [wrist[0] + 0.016, wrist[1] - 0.024, wrist[2] + 0.056];
  glove.segment([x + width + 0.009, y - 0.013, z + 0.026], wrist, 0.021, 0.018);
  sleeve.sleeve(wrist, cuff, [cuff[0] + 0.057, cuff[1] - 0.11, cuff[2] + 0.20]);
  armor.ellipsoid([wrist[0] + 0.020, wrist[1] + 0.004, wrist[2] + 0.007],
    [0.005, 0.017, 0.012], new pc.Quat().setFromEulerAngles(-22, 10, 5), 0.65);
}

function buildLeftHand(glove: HandMesh, sleeve: HandMesh, armor: HandMesh, hold: NonNullable<Hold['left']>): void {
  const [x, y, z] = hold.center;
  const vertical = hold.vertical ?? false;
  const palm: Point = [x - 0.027, y - (vertical ? 0.006 : 0.029), z + 0.010];
  glove.ellipsoid(palm, vertical ? [0.017, 0.035, 0.023] : [0.025, 0.016, 0.038], pc.Quat.IDENTITY, 0.78);
  for (let i = 0; i < 4; i++) {
    const offset = (i - 1.5) * 0.016;
    const start: Point = vertical ? [x - 0.026, y + offset, z + 0.005] : [x - 0.029, y - 0.025, z + offset];
    const bend: Point = vertical ? [x - 0.011, y + offset, z - 0.020] : [x - 0.016, y - 0.030, z + offset];
    const tip: Point = vertical ? [x + 0.015, y + offset - 0.004, z - 0.022] : [x + 0.017, y - 0.018, z + offset];
    const radius = 0.009 - i * 0.00055;
    glove.finger(start, bend, tip, radius);
    armor.ellipsoid(vertical ? [start[0] - 0.011, start[1], start[2] + 0.002] : [start[0] - 0.011, start[1] - 0.010, start[2]],
      vertical ? [0.0055, 0.007, 0.009] : [0.009, 0.0055, 0.007], pc.Quat.IDENTITY, 0.68);
  }
  glove.finger(palm, [x - 0.032, y + 0.012, z + 0.023], [x - 0.023, y + 0.019, z - 0.003], 0.011);
  const wrist: Point = [palm[0] - 0.015, palm[1] - 0.022, z + 0.043];
  const cuff: Point = [wrist[0] - 0.030, wrist[1] - 0.030, wrist[2] + 0.055];
  glove.segment(palm, wrist, 0.022, 0.018);
  sleeve.sleeve(wrist, cuff, [cuff[0] - 0.08, cuff[1] - 0.11, cuff[2] + 0.22]);
  armor.ellipsoid([wrist[0] - 0.017, wrist[1] - 0.011, wrist[2] + 0.007],
    [0.008, 0.009, 0.013], new pc.Quat().setFromEulerAngles(-14, -22, 20), 0.66);
}

export function mountViewmodelHands(
  weapon: WeaponGlbInstance,
  device: pc.GraphicsDevice,
  materials: pc.StandardMaterial[],
): void {
  const hold = HOLDS[weapon.weaponId];
  const weave = getFabricNormal(device);
  const gloveMaterial = makeMaterial([0.15, 0.16, 0.155], 0.33, weave, 3);
  const sleeveMaterial = makeMaterial([0.25, 0.28, 0.19], 0.19, weave, 10);
  const armorMaterial = makeMaterial([0.075, 0.085, 0.081], 0.46);
  materials.push(gloveMaterial, sleeveMaterial, armorMaterial);

  const addHand = (name: string, boneName: string, build: (glove: HandMesh, sleeve: HandMesh, armor: HandMesh) => void) => {
    const bone = weapon.boneNodes.get(boneName) ?? weapon.rootEntity;
    const relative = new pc.Mat4().invert(bone.getWorldTransform()).mul(weapon.rootEntity.getWorldTransform());
    const node = new pc.Entity(name);
    node.setLocalPosition(relative.getTranslation());
    node.setLocalRotation(new pc.Quat().setFromMat4(relative));
    node.setLocalScale(relative.getScale());
    const glove = new HandMesh();
    const sleeve = new HandMesh();
    const armor = new HandMesh();
    build(glove, sleeve, armor);
    node.addComponent('render', {
      meshInstances: [
        glove.attach(node, device, gloveMaterial),
        sleeve.attach(node, device, sleeveMaterial),
        armor.attach(node, device, armorMaterial),
      ],
      castShadows: false,
    });
    bone.addChild(node);
  };

  const grenade = weapon.weaponId === 'frag_grenade';
  addHand('ViewmodelRightHand', grenade ? 'Bone_Body' : 'Bone_Root',
    (glove, sleeve, armor) => buildRightHand(glove, sleeve, armor, hold.right, grenade));
  if (hold.left) {
    const left = hold.left;
    addHand('ViewmodelLeftHand', left.bone ?? 'Bone_Root', (glove, sleeve, armor) => buildLeftHand(glove, sleeve, armor, left));
  }
}
