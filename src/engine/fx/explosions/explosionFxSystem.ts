import * as pc from 'playcanvas';
import type { BlastEvent } from '../../../contracts/destruction.ts';
import { add, normalize, scale } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { directionToStreakQuaternion } from '../math/surfaceAlignment.ts';
import type {
  ExplosionTemplateMaterials,
  TransientBillowPlume,
  TransientFireballLobe,
} from './explosionTypes.ts';

export interface ExplosionSpawnContext {
  rootEntity: pc.Entity;
  unitQuadMesh: pc.Mesh;
  templates: ExplosionTemplateMaterials;
  fireballLobes: TransientFireballLobe[];
  billowPlumes: TransientBillowPlume[];
  impactSparkPool: HardwareInstancedPool;
}

export function spawnMultiStageExplosion(
  ctx: ExplosionSpawnContext,
  blast: BlastEvent,
  seedCounter = 1,
): number {
  const center = blast.centerWorld;
  const radiusScale = Math.max(0.75, Math.min(1.6, blast.radiusM / 6.0));
  let curSeed = seedCounter;

  // Stage 1: Blinding initial white-gold flash core
  const flashEnt = new pc.Entity('ExplosionFlashCore');
  flashEnt.addComponent('render', {
    type: 'sphere',
    material: ctx.templates.flashCoreTemplateMat,
    castShadows: false,
  });
  const flashMi = flashEnt.render?.meshInstances?.[0] ?? null;
  flashMi?.setParameter('material_opacity', 0.96);
  flashEnt.setPosition(center.x, center.y + 0.15, center.z);
  flashEnt.setLocalScale(0.55 * radiusScale, 0.55 * radiusScale, 0.55 * radiusScale);
  ctx.rootEntity.addChild(flashEnt);

  ctx.fireballLobes.push({
    entity: flashEnt,
    meshInstance: flashMi,
    diffuseUniform: new Float32Array([1.0, 0.96, 0.82]),
    emissiveUniform: new Float32Array([5.5, 4.95, 3.41]),
    position: new pc.Vec3(center.x, center.y + 0.15, center.z),
    velocity: new pc.Vec3(0, 0.4, 0),
    angularVelocity: new pc.Vec3(0, 0, 0),
    elapsedS: 0,
    durationS: 0.085,
    startScale: 0.55 * radiusScale,
    endScale: 3.1 * radiusScale,
  });

  // Stage 2: Churning multi-lobed emissive-to-soot fireball spheres
  const lobeCount = 5;
  for (let i = 0; i < lobeCount; i++) {
    const angle = (i / lobeCount) * Math.PI * 2 + 0.37;
    const radialDist = i === 0 ? 0 : (0.28 + (i % 2) * 0.16) * radiusScale;

    const lobeEnt = new pc.Entity(`ExplosionFireballLobe_${i}`);
    lobeEnt.addComponent('render', {
      type: 'sphere',
      material: ctx.templates.fireballLobeTemplateMat,
      castShadows: false,
    });
    const lobeMi = lobeEnt.render?.meshInstances?.[0] ?? null;
    const diffU = new Float32Array([1.0, 0.86, 0.45]);
    const emisU = new Float32Array([4.2, 3.02, 1.0]);
    if (lobeMi) {
      lobeMi.setParameter('material_diffuse', diffU);
      lobeMi.setParameter('material_emissive', emisU);
      lobeMi.setParameter('material_opacity', 0.94);
    }

    const lx = center.x + Math.cos(angle) * radialDist;
    const ly = center.y + (i === 0 ? 0.28 : 0.12 + (i % 3) * 0.14);
    const lz = center.z + Math.sin(angle) * radialDist;
    const startScale = (i === 0 ? 0.85 : 0.62) * radiusScale;
    const endScale = (i === 0 ? 2.55 : 1.95) * radiusScale;

    lobeEnt.setPosition(lx, ly, lz);
    lobeEnt.setLocalScale(startScale, startScale, startScale);
    ctx.rootEntity.addChild(lobeEnt);

    ctx.fireballLobes.push({
      entity: lobeEnt,
      meshInstance: lobeMi,
      diffuseUniform: diffU,
      emissiveUniform: emisU,
      position: new pc.Vec3(lx, ly, lz),
      velocity: new pc.Vec3(
        Math.cos(angle) * (i === 0 ? 0 : 1.65 * radiusScale),
        2.2 + (i % 3) * 0.65,
        Math.sin(angle) * (i === 0 ? 0 : 1.65 * radiusScale),
      ),
      angularVelocity: new pc.Vec3(90 - i * 32, 65 + i * 24, -50 + i * 19),
      elapsedS: 0,
      durationS: 0.56 + (i % 3) * 0.08,
      startScale,
      endScale,
    });
  }

  // Stage 3: Expanding ground shockwave ring
  const ringEnt = new pc.Entity('ExplosionGroundShockwaveRing');
  const ringMi = new pc.MeshInstance(ctx.unitQuadMesh, ctx.templates.shockwaveRingTemplateMat);
  ringMi.setParameter('material_opacity', 0.88);
  ringEnt.addComponent('render', { meshInstances: [ringMi], castShadows: false, receiveShadows: false });
  const groundY = Math.max(0.03, Math.min(0.25, center.y * 0.12));
  ringEnt.setPosition(center.x, groundY, center.z);
  ringEnt.setLocalEulerAngles(-90, 0, 0);
  ringEnt.setLocalScale(0.6, 0.6, 1);
  ctx.rootEntity.addChild(ringEnt);

  ctx.billowPlumes.push({
    entity: ringEnt,
    meshInstance: ringMi,
    position: new pc.Vec3(center.x, groundY, center.z),
    velocity: new pc.Vec3(0, 0, 0),
    elapsedS: 0,
    durationS: 0.28,
    startScale: 0.65,
    endScale: blast.radiusM * 2.15,
    baseOpacity: 0.88,
    spinDegPerS: 45,
    isGroundRing: true,
  });

  // Stage 4: Flying incandescent ember streaks
  const emberCount = 28;
  for (let e = 0; e < emberCount; e++) {
    curSeed++;
    const azim = (e / emberCount) * Math.PI * 2 + ((curSeed % 11) * 0.09);
    const elev = 0.22 + ((curSeed * 7) % 13) / 16;
    const spd = (9.5 + ((curSeed * 17) % 15) * 0.85) * radiusScale;
    const dir = normalize({ x: Math.cos(azim), y: elev, z: Math.sin(azim) });
    const quat = directionToStreakQuaternion(dir);
    ctx.impactSparkPool.spawnKinematicParticle(
      add(center, scale(dir, 0.22)),
      scale(dir, spd),
      { x: 0, y: 0, z: 0 },
      { x: 0.022, y: 0.022, z: 0.36 },
      -9.81,
      0.46,
      0.65 + (e % 5) * 0.16,
      quat,
    );
  }

  // Stage 5: Lingering rising dark charcoal smoke plumes
  const smokeCount = 6;
  for (let s = 0; s < smokeCount; s++) {
    if (ctx.billowPlumes.length >= 60) break;
    const angle = (s / smokeCount) * Math.PI * 2 + 0.52;
    const smokeEnt = new pc.Entity(`ExplosionDarkSmokePlume_${s}`);
    const smokeMi = new pc.MeshInstance(ctx.unitQuadMesh, ctx.templates.darkSmokeTemplateMat);
    smokeMi.setParameter('material_opacity', 0.0);
    smokeEnt.addComponent('render', {
      meshInstances: [smokeMi],
      castShadows: false,
      receiveShadows: false,
    });

    const sx = center.x + Math.cos(angle) * 0.35 * radiusScale;
    const sy = center.y + 0.32 + (s % 3) * 0.22;
    const sz = center.z + Math.sin(angle) * 0.35 * radiusScale;
    const startScale = (0.95 + (s % 2) * 0.25) * radiusScale;
    const endScale = (3.4 + (s % 3) * 0.55) * radiusScale;

    smokeEnt.setPosition(sx, sy, sz);
    smokeEnt.setLocalScale(startScale, startScale, 1);
    ctx.rootEntity.addChild(smokeEnt);

    ctx.billowPlumes.push({
      entity: smokeEnt,
      meshInstance: smokeMi,
      position: new pc.Vec3(sx, sy, sz),
      velocity: new pc.Vec3(
        Math.cos(angle) * 0.85 * radiusScale,
        1.55 + (s % 3) * 0.42,
        Math.sin(angle) * 0.85 * radiusScale,
      ),
      elapsedS: 0,
      durationS: 1.85 + (s % 3) * 0.35,
      startScale,
      endScale,
      baseOpacity: 0.72,
      spinDegPerS: (s % 2 === 0 ? 1 : -1) * 28,
      isGroundRing: false,
    });
  }

  return curSeed;
}
