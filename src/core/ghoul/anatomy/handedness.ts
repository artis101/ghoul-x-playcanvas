/**
 * The single place that turns handedness into a body side.
 *
 * Sides are the character's own: facing +z with +y up, `LEFT` is +x and `RIGHT` is -x.
 * A right-hander triggers with `RIGHT` and supports with `LEFT`; a southpaw is the reverse.
 */
export type BodySide = 'LEFT' | 'RIGHT';

export function oppositeSide(side: BodySide): BodySide {
  return side === 'LEFT' ? 'RIGHT' : 'LEFT';
}

/** The side whose hand holds the grip and pulls the trigger. */
export function triggerSide(isLeftHanded: boolean): BodySide {
  return isLeftHanded ? 'LEFT' : 'RIGHT';
}

/** The side whose hand steadies the weapon and is free to clutch a wound. */
export function supportSide(isLeftHanded: boolean): BodySide {
  return oppositeSide(triggerSide(isLeftHanded));
}

/** +1 when the side lies along the body's +x (its left), -1 along -x. */
export function sideSignX(side: BodySide): 1 | -1 {
  return side === 'LEFT' ? 1 : -1;
}
