import * as pc from 'playcanvas';
import { WEAPON_ASSET_IDS, type WeaponAssetId } from '../assets/glbLoader.ts';

export interface WeaponAmmoState {
  magCap: number;
  mag: number;
  reserve: number;
  ammoIndex: number;
}

export const WEAPON_CAPACITIES: Record<string, { magCap: number; reserve: number }> = {
  m590_shotgun: { magCap: 8, reserve: 40 },
  silver_talon_50ae: { magCap: 7, reserve: 35 },
  msg90_sniper: { magCap: 20, reserve: 60 },
  m4a1_carbine: { magCap: 30, reserve: 120 },
};

export interface BarrelSmokeWisp {
  entity: pc.Entity;
  meshInstance: pc.MeshInstance;
  position: pc.Vec3;
  velocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  spinSpeedDeg: number;
}

export interface ViewmodelMuzzleFxAssets {
  quadMesh: pc.Mesh;
  starPetalMat: pc.StandardMaterial;
  coreSpearMat: pc.StandardMaterial;
  coronaHaloMat: pc.StandardMaterial;
  barrelSmokeTemplateMat: pc.StandardMaterial;
  machinedGrainNormalTex: pc.Texture;
}

export function toWeaponAssetId(weaponId: string): WeaponAssetId | null {
  for (const candidate of WEAPON_ASSET_IDS) {
    if (candidate === weaponId) return candidate;
  }
  return null;
}

export function resolveGraphicsDeviceFromEntity(entity: pc.Entity): pc.GraphicsDevice | null {
  const appRef = (entity as unknown as { _app?: pc.AppBase | null })._app;
  if (appRef && appRef.graphicsDevice) return appRef.graphicsDevice;
  return pc.Application.getApplication()?.graphicsDevice ?? null;
}
