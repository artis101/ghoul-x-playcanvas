import type * as pc from 'playcanvas';
import type { TransientBillowPlume, TransientFireballLobe } from './explosionTypes.ts';

export function stepFireballLobes(lobes: TransientFireballLobe[], dt: number): void {
  for (let i = lobes.length - 1; i >= 0; i--) {
    const lobe = lobes[i];
    lobe.elapsedS += dt;
    if (lobe.elapsedS >= lobe.durationS) {
      lobe.entity.destroy();
      lobes.splice(i, 1);
      continue;
    }

    const t = lobe.elapsedS / lobe.durationS;
    const drag = Math.exp(-3.4 * dt);
    lobe.velocity.scale(drag);
    lobe.position.x += lobe.velocity.x * dt;
    lobe.position.y += lobe.velocity.y * dt;
    lobe.position.z += lobe.velocity.z * dt;

    lobe.entity.setPosition(lobe.position.x, lobe.position.y, lobe.position.z);
    lobe.entity.rotate(
      lobe.angularVelocity.x * dt,
      lobe.angularVelocity.y * dt,
      lobe.angularVelocity.z * dt,
    );

    const easeOut = 1 - Math.pow(1 - t, 2.4);
    const s = lobe.startScale + (lobe.endScale - lobe.startScale) * easeOut;
    lobe.entity.setLocalScale(s, s, s);

    const mi = lobe.meshInstance;
    if (!mi) continue;

    if (lobe.durationS <= 0.12) {
      mi.setParameter('material_opacity', Math.max(0, (1 - t) * (1 - t)));
    } else {
      if (t < 0.32) {
        const k = t / 0.32;
        const ei = 4.2 * (1 - k * 0.35);
        lobe.diffuseUniform[0] = 1.0;
        lobe.diffuseUniform[1] = 0.9 - k * 0.42;
        lobe.diffuseUniform[2] = 0.55 - k * 0.45;
        lobe.emissiveUniform[0] = 1.0 * ei;
        lobe.emissiveUniform[1] = (0.78 - k * 0.44) * ei;
        lobe.emissiveUniform[2] = (0.3 - k * 0.25) * ei;
        mi.setParameter('material_diffuse', lobe.diffuseUniform);
        mi.setParameter('material_emissive', lobe.emissiveUniform);
        mi.setParameter('material_opacity', 0.95);
      } else {
        const k = (t - 0.32) / 0.68;
        const sootLerp = Math.min(1, k * 1.35);
        const ei = Math.max(0, (1 - sootLerp) * 2.4);
        lobe.diffuseUniform[0] = 0.58 * (1 - sootLerp) + 0.09 * sootLerp;
        lobe.diffuseUniform[1] = 0.22 * (1 - sootLerp) + 0.08 * sootLerp;
        lobe.diffuseUniform[2] = 0.08 * (1 - sootLerp) + 0.08 * sootLerp;
        lobe.emissiveUniform[0] = (1 - sootLerp) * 0.85 * ei;
        lobe.emissiveUniform[1] = (1 - sootLerp) * 0.24 * ei;
        lobe.emissiveUniform[2] = (1 - sootLerp) * 0.04 * ei;
        mi.setParameter('material_diffuse', lobe.diffuseUniform);
        mi.setParameter('material_emissive', lobe.emissiveUniform);
        mi.setParameter('material_opacity', 0.92 * (1 - k * k));
      }
    }
  }
}

export function stepBillowPlumes(
  plumes: TransientBillowPlume[],
  dt: number,
  camPos: pc.Vec3 | null,
): void {
  for (let i = plumes.length - 1; i >= 0; i--) {
    const p = plumes[i];
    p.elapsedS += dt;
    if (p.elapsedS >= p.durationS) {
      p.entity.destroy();
      plumes.splice(i, 1);
      continue;
    }

    const t = p.elapsedS / p.durationS;
    const easeOut = 1 - Math.pow(1 - t, p.isGroundRing ? 2.1 : 1.75);
    const curScale = p.startScale + (p.endScale - p.startScale) * easeOut;

    if (p.isGroundRing) {
      p.entity.setLocalEulerAngles(-90, p.elapsedS * p.spinDegPerS, 0);
      p.entity.setLocalScale(curScale, curScale, 1);
      p.meshInstance.setParameter('material_opacity', p.baseOpacity * (1 - t) * (1 - t));
    } else {
      const drag = Math.exp(-1.8 * dt);
      p.velocity.x *= drag;
      p.velocity.z *= drag;
      p.velocity.y *= Math.exp(-0.65 * dt);
      p.position.x += p.velocity.x * dt;
      p.position.y = Math.max(0.08, p.position.y + p.velocity.y * dt);
      p.position.z += p.velocity.z * dt;
      p.entity.setPosition(p.position.x, p.position.y, p.position.z);

      if (camPos) {
        p.entity.lookAt(camPos);
        p.entity.rotateLocal(0, 0, p.elapsedS * p.spinDegPerS);
      }
      p.entity.setLocalScale(curScale, curScale, 1);
      const fadeIn = Math.min(1, t * 7.0);
      p.meshInstance.setParameter(
        'material_opacity',
        p.baseOpacity * fadeIn * (1 - t) * (1 - t * 0.4),
      );
    }
  }
}
