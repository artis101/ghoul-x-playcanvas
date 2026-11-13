import type { AnatomicalColliderVolume, TargetHealthState } from '../../../contracts/ballistics.ts';
import { getArchetypeLoadout } from '../../ghoul/anatomy/archetypeLoadout.ts';

/**
 * Archetype toughness (docs/wound-movement.md, "Toughness"). A big man soaks a body blast that
 * would drop a skinny punk. Each pellet or bullet is one wound channel, and the HP it costs is
 * scaled by what it went through:
 *
 * - SHALLOW: it only ever touched meat and fat (a buckshot pellet stopping in the chest muscle,
 *   a graze). This is where size matters most: `shallowWoundScale`.
 * - DEEP meat and bone on a channel that went further in: `bodyDamageScale`.
 * - Lungs, liver, gut, and the skull and jaw bone: the square root of `bodyDamageScale`, so a
 *   punctured lung still hurts a tough man nearly as much.
 * - VITAL: brain, heart, aorta and carotids, and the cervical spine: never scaled.
 *
 * The instant-kill rules (cranial burst, severed neck, destroyed brain or cervical spine, fatal
 * limb loss, a ruptured heart's +68 HP) do not go through this at all, so a vital hit kills a big
 * man just as dead.
 */

type DamageClass = 'VITAL' | 'ORGAN' | 'MEAT';

type LayerRef = Pick<AnatomicalColliderVolume, 'layerType' | 'ghoulZone'>;

function damageClassOf(col: LayerRef): DamageClass {
  // The cervical spine and the carotids are vital; the muscle round them is meat like any other.
  if (col.ghoulZone === 'NECK_CERVICAL' && col.layerType !== 'SOFT_FLESH') return 'VITAL';
  switch (col.layerType) {
    case 'ORGAN_BRAIN':
    case 'ORGAN_HEART':
    case 'ARTERY_CAROTID_AORTA':
      return 'VITAL';
    case 'ORGAN_LUNG_LEFT':
    case 'ORGAN_LUNG_RIGHT':
    case 'ORGAN_LIVER':
    case 'ORGAN_STOMACH_GUT':
      return 'ORGAN';
    case 'CORTICAL_BONE':
      // A cracked skull or jaw is not soaked like a rib, but it is not the brain either.
      return col.ghoulZone === 'HEAD_CRANIUM' || col.ghoulZone === 'HEAD_FACE_JAW' ? 'ORGAN' : 'MEAT';
    default:
      // Scalp and cheek are meat like any other: a pellet that stops in them is a shallow wound.
      return 'MEAT';
  }
}

/** HP scale on meat and bone hit by a channel that went deeper, and on armour blunt trauma. */
export function bodyDamageScale(target: Pick<TargetHealthState, 'archetype'>): number {
  return getArchetypeLoadout(target.archetype).bodyDamageScale;
}

/**
 * Sums the HP of one wound channel (one pellet or bullet) layer by layer, then scales it by the
 * target's toughness once the channel is finished, when it is known whether it stayed shallow.
 */
export class WoundChannelTally {
  private vitalHp = 0;
  private organHp = 0;
  private meatHp = 0;
  private shallow = true;
  private readonly bodyScale: number;
  private readonly shallowScale: number;

  constructor(target: Pick<TargetHealthState, 'archetype'>) {
    const loadout = getArchetypeLoadout(target.archetype);
    this.bodyScale = loadout.bodyDamageScale;
    this.shallowScale = loadout.shallowWoundScale;
  }

  /** One tissue layer the round passed through, with the HP the anatomy model gave it. */
  addLayer(col: LayerRef, layerHp: number): void {
    if (col.layerType !== 'SOFT_FLESH') this.shallow = false;
    const cls = damageClassOf(col);
    if (cls === 'VITAL') this.vitalHp += layerHp;
    else if (cls === 'ORGAN') this.organHp += layerHp;
    else this.meatHp += layerHp;
  }

  /** Blunt trauma through a plate: a body blow, not a wound channel. */
  addBlunt(hp: number): void {
    this.shallow = false;
    this.meatHp += hp;
  }

  /** The channel's HP after toughness; resets the tally for the next channel. */
  close(): number {
    const meatScale = this.shallow ? this.shallowScale : this.bodyScale;
    const hp = this.vitalHp + this.organHp * Math.sqrt(this.bodyScale) + this.meatHp * meatScale;
    this.vitalHp = 0;
    this.organHp = 0;
    this.meatHp = 0;
    this.shallow = true;
    return hp;
  }
}

/**
 * The health fraction, after the hit, at or below which a hard shove (a close blast, a shattered
 * pelvis) may knock this body off its feet. Above it the body rocks, takes it and stays up.
 */
export function knockdownHpFraction(target: Pick<TargetHealthState, 'archetype'>): number {
  return getArchetypeLoadout(target.archetype).knockdownHpFraction;
}

/** True when a body left at `hpAfter` is spent enough for a hard shove to put it down. */
export function weakEnoughForKnockdown(
  target: Pick<TargetHealthState, 'archetype' | 'maxHp'>,
  hpAfter: number
): boolean {
  const fraction = target.maxHp > 0 ? hpAfter / target.maxHp : 0;
  return fraction <= knockdownHpFraction(target);
}
