import {
  ImmediatePostureReaction,
  OrganTraumaRecord,
  PhysiologicalEntityState,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import { copyVec3, vec3 } from '../ballistics/vec3.ts';
import { TIER2_INTERNAL_ORGANS } from '../ghoul/bvhVolumes.ts';
import {
  escalatePostureReaction,
  escalateVocalCue,
  transitionPneumothorax,
  transitionVitalState,
} from './physiologyLifecycleFsm.ts';
import { mergeOrAddVascularWound } from './vascularHelper.ts';
import { constitutionOf, nextPhysiologyRoll, startTerminalCountdown } from './physiologyVariance.ts';

/** Share of destroyed hearts that stop at once for an average combatant; the rest fight on briefly. */
const INSTANT_CARDIAC_ARREST_CHANCE = 0.4;

function destroyHeart(state: PhysiologicalEntityState): void {
  const roll = nextPhysiologyRoll(state);
  const will = constitutionOf(state).willToLive;
  if (roll === null || roll < INSTANT_CARDIAC_ARREST_CHANCE / will) {
    transitionVitalState(state, { kind: 'LETHAL_ARREST', cause: 'CARDIAC_DESTRUCTION' });
    return;
  }
  // Enough oxygen left in the brain for a few seconds of fight.
  const spread = nextPhysiologyRoll(state) ?? 0.5;
  startTerminalCountdown(state, Math.min(14, (3 + spread * 6) * will), 'CARDIAC_DESTRUCTION');
}

export function applyOrganTrauma(
  state: PhysiologicalEntityState,
  organTrauma: readonly OrganTraumaRecord[],
  currentReaction: ImmediatePostureReaction,
  currentVocal: VocalTraumaCue
): {
  reaction: ImmediatePostureReaction;
  vocal: VocalTraumaCue;
  painSpike: number;
  organBleedMlPerSec: number;
} {
  let reaction = currentReaction;
  let vocal = currentVocal;
  let painSpike = 0;
  let organParenchymalBleedMlPerSec = 0;

  for (const ot of organTrauma) {
    const orgDef = TIER2_INTERNAL_ORGANS.find((o) => o.id === ot.organId);
    const organBleed = orgDef
      ? ot.stretchCavitationRuptured
        ? orgDef.ruptureBleedMlPerSec
        : orgDef.baseLacerationBleedMlPerSec * ot.severity
      : 0;
    organParenchymalBleedMlPerSec += organBleed;
    painSpike += 0.42 + ot.severity * 0.45;

    switch (ot.organId) {
      case 'BRAIN':
        state.brainIntegrity = Math.max(0, state.brainIntegrity - (0.65 + 0.5 * ot.severity));
        if (state.brainIntegrity <= 0.25 || ot.stretchCavitationRuptured) {
          state.brainIntegrity = 0;
          transitionVitalState(state, {
            kind: 'LETHAL_ARREST',
            cause: 'CNS_BRAINSTEM_DESTRUCTION',
          });
          reaction = escalatePostureReaction(reaction, 'NEUROGENIC_DROP');
          vocal = 'NONE';
        }
        break;

      case 'HEART':
        state.heartIntegrity = Math.max(0, state.heartIntegrity - (0.55 + 0.45 * ot.severity));
        reaction = escalatePostureReaction(reaction, 'VIOLENT_CHEST_STAGGER');
        if (state.alive) {
          vocal = escalateVocalCue(vocal, 'SHARP_GASP');
        }
        if (state.heartIntegrity <= 0.08 && ot.stretchCavitationRuptured) {
          destroyHeart(state);
        }
        mergeOrAddVascularWound(state, {
          vesselId: 'AORTA_THORACIC_ABDOMINAL',
          vesselKind: 'ARTERIAL',
          ghoulZone: 'TORSO_UPPER_THORAX',
          positionLocal: copyVec3(ot.positionLocal),
          positionWorld: copyVec3(ot.positionWorld),
          sprayDirectionWorld: vec3(0, 0.2, 1),
          severity: ot.severity,
          baseBleedMlPerSec: organBleed,
        });
        organParenchymalBleedMlPerSec -= organBleed;
        break;

      case 'LUNG_RIGHT':
      case 'LUNG_LEFT':
        transitionPneumothorax(state, { kind: 'LUNG_HIT', severity: ot.severity });
        if (reaction === 'NONE' || (reaction === 'WEAPON_WRENCH_DROP' && ot.directCrushLacerated)) {
          reaction = escalatePostureReaction(reaction, 'VIOLENT_CHEST_STAGGER');
        }
        if (state.alive) {
          vocal = escalateVocalCue(vocal, 'WET_HEMOTHORAX_COUGH');
        }
        break;

      case 'DIAPHRAGM':
        state.diaphragmIntegrity = Math.max(0.15, state.diaphragmIntegrity - 0.55 * ot.severity);
        reaction = escalatePostureReaction(reaction, 'DIAPHRAGM_DROP_KNEEL');
        if (state.alive) {
          vocal = escalateVocalCue(vocal, 'SHARP_GASP');
        }
        break;

      case 'LIVER':
        state.liverIntegrity = Math.max(0.05, state.liverIntegrity - (0.50 + 0.45 * ot.severity));
        reaction = escalatePostureReaction(reaction, 'DIAPHRAGM_DROP_KNEEL');
        if (state.alive) {
          vocal = escalateVocalCue(vocal, 'SHARP_GASP');
        }
        mergeOrAddVascularWound(state, {
          vesselId: 'VENA_CAVA_JUGULAR_FEMORAL',
          vesselKind: 'VENOUS',
          ghoulZone: 'TORSO_LOWER_ABDOMEN',
          positionLocal: copyVec3(ot.positionLocal),
          positionWorld: copyVec3(ot.positionWorld),
          sprayDirectionWorld: vec3(0, -0.4, 0.9),
          severity: ot.severity,
          baseBleedMlPerSec: organBleed,
        });
        organParenchymalBleedMlPerSec -= organBleed;
        break;

      case 'GI_TRACT':
        state.giTractIntegrity = Math.max(0.1, state.giTractIntegrity - 0.45 * ot.severity);
        break;
    }
  }

  return { reaction, vocal, painSpike, organBleedMlPerSec: organParenchymalBleedMlPerSec };
}
