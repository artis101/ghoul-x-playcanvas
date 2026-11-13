export interface FpsInputCallbacks {
  onTriggerPull: () => void;
  onSelectWeapon: (idx: number) => void;
  onCycleWeapon: (delta: number) => void;
  onCycleAmmo: () => void;
  onReload: () => void;
  onSpawnWave: () => void;
  onThrowGrenade: () => void;
}
