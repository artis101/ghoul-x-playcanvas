import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { ActiveBlastFlashFx } from './combatTypes.ts';

export function createBlastFireballMaterial(): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = 'fragBlastFireballMat';
  mat.diffuse = new pc.Color(1.0, 0.42, 0.08);
  mat.emissive = new pc.Color(1.0, 0.65, 0.18);
  mat.useLighting = false;
  mat.blendType = pc.BLEND_ADDITIVE;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}

export function spawnBlastVisualFx(
  center: Vec3Like,
  blastRadiusM: number,
  app: pc.AppBase,
  materials: EngineMaterialPalette,
  blastFireballMat: pc.StandardMaterial,
  activeBlastFlashes: ActiveBlastFlashFx[]
): void {
  const root = new pc.Entity('FragBlastFx');
  root.setPosition(center.x, Math.max(0.08, center.y), center.z);

  const fireball = new pc.Entity('FragFireballSphere');
  fireball.addComponent('render', {
    type: 'sphere',
    material: blastFireballMat,
    castShadows: false,
  });
  fireball.setLocalScale(0.35, 0.35, 0.35);
  root.addChild(fireball);

  const shockRing = new pc.Entity('FragShockwaveRing');
  shockRing.addComponent('render', {
    type: 'cylinder',
    material: materials.shockwaveRingMat,
    castShadows: false,
  });
  shockRing.setLocalPosition(0, 0.04, 0);
  shockRing.setLocalScale(0.5, 0.02, 0.5);
  root.addChild(shockRing);

  app.root.addChild(root);

  activeBlastFlashes.push({
    root,
    fireball,
    shockRing,
    elapsedS: 0,
    durationS: 0.28,
    maxRadiusM: Math.min(4.6, blastRadiusM * 0.62),
  });
}

export function stepBlastFlashes(activeBlastFlashes: ActiveBlastFlashFx[], dt: number): void {
  for (let i = activeBlastFlashes.length - 1; i >= 0; i--) {
    const bf = activeBlastFlashes[i];
    bf.elapsedS += dt;
    const t = Math.min(1, bf.elapsedS / bf.durationS);
    const fireScale = 0.4 + bf.maxRadiusM * Math.pow(t, 0.55) * (1 - t * 0.35);
    const ringScale = 0.6 + bf.maxRadiusM * 2.1 * t;
    bf.fireball.setLocalScale(fireScale, fireScale * 0.85, fireScale);
    bf.shockRing.setLocalScale(ringScale, 0.02, ringScale);

    if (bf.elapsedS >= bf.durationS) {
      bf.root.destroy();
      activeBlastFlashes.splice(i, 1);
    }
  }
}
