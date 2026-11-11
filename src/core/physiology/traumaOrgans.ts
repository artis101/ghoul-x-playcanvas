import {
  ImmediatePostureReaction,
  OrganTraumaRecord,
  PhysiologicalEntityState,
  VocalTraumaCue,
} from '../../contracts/physiology.ts';
import { TIER2_INTERNAL_ORGANS } from '../ghoul/bvhVolumes.ts';
import { copyVec3, vec3 } from '../ballistics/vec3.ts';
import { mergeOrAddVascularWound } from './vascularHelper.ts';

export function applyOrganTrauma(
  state: PhysiologicalEntityState,
  organTrauma: readonly OrganTraumaRecord[],
  currentReaction: ImmediatePostureReaction,
  currentVocal: VocalTraumaCue
): { reaction: ImmediatePostureReaction; vocal: VocalTraumaCue; painSpike: number; organBleedMlPerSec: number } {
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
          state.conscious = false;
          state.alive = false;
          state.causeOfDeath = 'CNS_BRAINSTEM_DESTRUCTION';
          reaction = 'NEUROGENIC_DROP';
          vocal = 'NONE';
        }
        break;

      case 'HEART':
        state.heartIntegrity = Math.max(0, state.heartIntegrity - (0.55 + 0.45 * ot.severity));
        reaction = 'VIOLENT_CHEST_STAGGER';
        vocal = 'SHARP_GASP';
        if (state.heartIntegrity <= 0.08 && ot.stretchCavitationRuptured) {
          state.cardiacOutputRatio = 0;
          state.meanArterialPressureMmHg = 0;
          state.conscious = false;
          state.alive = false;
          state.causeOfDeath = 'CARDIAC_DESTRUCTION';
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

      case 'LUNG_LEFT':
      case 'LUNG_RIGHT':
        state.lungIntegrity = Math.max(0.08, state.lungIntegrity - 0.32 * ot.severity);
        if (state.pneumothoraxState === 'NONE' || state.pneumothoraxState === 'OPEN_PNEUMOTHORAX') {
          state.pneumothoraxState =
            ot.severity >= 0.35 ? 'TENSION_PNEUMOTHORAX' : 'OPEN_PNEUMOTHORAX';
        }
        if (
          reaction === 'NONE' ||
          (reaction === 'WEAPON_WRENCH_DROP' && ot.directCrushLacerated)
        ) {
          reaction = 'VIOLENT_CHEST_STAGGER';
        }
        vocal = 'WET_HEMOTHORAX_COUGH';
        break;

      case 'DIAPHRAGM':
        state.diaphragmIntegrity = Math.max(0.15, state.diaphragmIntegrity - 0.55 * ot.severity);
        if (reaction !== 'LEG_COLLAPSE_PRONE' && reaction !== 'NEUROGENIC_DROP') {
          reaction = 'DIAPHRAGM_DROP_KNEEL';
        }
        vocal = 'SHARP_GASP';
        break;

      case 'LIVER':
        state.liverIntegrity = Math.max(0.05, state.liverIntegrity - (0.50 + 0.45 * ot.severity));
        if (reaction !== 'LEG_COLLAPSE_PRONE' && reaction !== 'NEUROGENIC_DROP') {
          reaction = 'DIAPHRAGM_DROP_KNEEL';
        }
        if (vocal !== 'WET_HEMOTHORAX_COUGH') {
          vocal = 'SHARP_GASP';
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
