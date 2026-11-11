import {
  PhysiologicalEntityState,
  VascularWoundRecord,
} from '../../contracts/physiology.ts';

export function mergeOrAddVascularWound(
  state: PhysiologicalEntityState,
  incoming: VascularWoundRecord
): void {
  const existingIdx = state.vascularWounds.findIndex(
    (w) => w.vesselId === incoming.vesselId && w.vesselKind === incoming.vesselKind
  );
  if (existingIdx >= 0) {
    const prev = state.vascularWounds[existingIdx];
    if (incoming.baseBleedMlPerSec > prev.baseBleedMlPerSec) {
      state.vascularWounds[existingIdx] = incoming;
    }
  } else {
    state.vascularWounds.push(incoming);
  }
}
