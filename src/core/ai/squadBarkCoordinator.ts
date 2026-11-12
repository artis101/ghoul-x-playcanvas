import type { AiBarkCategory, AiBarkPayload } from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';
import type { VocalTraumaCue } from '../../contracts/physiology/entityStateTypes.ts';
import { copyVec3, distance } from '../ballistics/vec3.ts';
import {
  canStartPrimaryRadioCall,
  createIdleRadioChannelState,
  type PendingRadioResponse,
  type RadioChannelState,
  type SquadMateSummary,
  stepRadioChannelState,
  transitionBeginRadioCall,
  transitionCancelAgentRadioResponses,
  transitionScheduleAllyDown,
} from './radioChannelFsm.ts';

export type { PendingRadioResponse, RadioChannelState, SquadMateSummary };

const CONTACT_LINES = [
  'Contact front! Target in the killzone!',
  'Hostile sighted! Weapons free!',
  'Eyes on target! Engage!',
];
const CONTACT_REPLY_LINES = [
  'Copy! Moving to firing angle!',
  'Solid copy, locking him down!',
  'Roger, pinning his position!',
];
const FLANK_LEFT_LINES = ['Flanking left! Keep him pinned!', 'Shifting left angle—cover me!'];
const FLANK_RIGHT_LINES = ['Pushing right side! Lay it down!', 'Re-angling right—suppressing fire!'];
const SUPPRESS_REPLY_LINES = [
  'Copy, suppressing! Move now!',
  'Covering your flank—pour it on!',
  'Keeping his head down! Go!',
];
const COVER_RETREAT_LINES = ['Taking heavy fire! Shifting cover!', 'Pinned down! Need suppression!'];
const SIDEARM_LINES = ['Primary disabled—transitioning to M9!', 'Drawing backup sidearm!'];
const ALLY_DOWN_LINES = [
  'Man down! Check your sectors!',
  'They got him! Pour fire on that angle!',
  'Squadmate KIA—stay sharp!',
];
const BERSERKER_LINES = ['BLEED HIM DRY! PUSH!', 'NO COVER! RUSH HIM NOW!', 'CARVE HIM OPEN—CHARGE!'];
const HORROR_HEAD_LINES = [
  "OH GOD—HIS HEAD'S GONE!",
  'HE BLEW HIS DAMN HEAD CLEAN OFF!',
  'CHRIST ALMIGHTY—STAY DOWN!',
];
const HORROR_LIMB_LINES = [
  'HE TORE HIM APART! FALL BACK!',
  'HIS ARM—HE SHOT IT CLEAN OFF!',
  'JESUS, HE SHREDDED HIM! GET BACK!',
];
const VETERAN_BRUTAL_CALLOUTS = [
  'Shooter is working joints—shift your angles!',
  'Heavy CQB butcher! Check spacing and hard cover!',
  'Sniper taking clean severs—do not hold static peeks!',
];

const VOCAL_CUE_TEXT: Record<Exclude<VocalTraumaCue, 'NONE'>, string> = {
  SHARP_GASP: '*sharp pleural gasp*',
  WET_HEMOTHORAX_COUGH: '*wet hemothorax cough*',
  AGUNAL_WHEEZE: '*agonal hypoxic wheeze*',
  PAIN_GRUNT: '*visceral pain grunt*',
};

export class SquadBarkCoordinator {
  private readonly globalRadioLockDurationS = 2.2;
  private readonly replyLockDurationS = 1.45;
  private readonly callAndResponseDelayS = 0.85;
  private readonly allyDownDelayS = 0.48;
  private readonly perSpeakerRadioCooldownS = 4.5;
  private readonly perSpeakerTraumaCooldownS = 1.65;

  private channelState: RadioChannelState = createIdleRadioChannelState();
  private readonly callsigns = new Map<string, string>();
  private readonly speakerNextRadioS = new Map<string, number>();
  private readonly speakerNextTraumaS = new Map<string, number>();
  private lineCounter = 0;

  public get radioState(): RadioChannelState {
    return this.channelState;
  }

  public resolveCallsign(targetId: string, archetype: EnemyArchetypeId): string {
    const existing = this.callsigns.get(targetId);
    if (existing) return existing;

    const indexMatch = /(\d+)$/.exec(targetId);
    const num = indexMatch ? Number(indexMatch[1]) + 1 : this.callsigns.size + 1;
    const prefix =
      archetype === 'SNIPER_OPERATIVE'
        ? 'OVERWATCH'
        : archetype === 'HEAVY_ENFORCER'
          ? 'HAMMER'
          : archetype === 'SKINHEAD_PUNK'
            ? 'REAPER'
            : 'ALPHA';
    const callsign = `${prefix}-${num}`;
    this.callsigns.set(targetId, callsign);
    return callsign;
  }

  public step(
    elapsedClockS: number,
    resolveMateState: (targetId: string) => SquadMateSummary | undefined,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const stepped = stepRadioChannelState(
      this.channelState,
      elapsedClockS,
      resolveMateState,
      this.replyLockDurationS
    );
    this.channelState = stepped.state;

    for (const { mate, response } of stepped.emissions) {
      this.speakerNextRadioS.set(mate.targetId, elapsedClockS + this.perSpeakerRadioCooldownS);
      onBark({
        speakerId: mate.targetId,
        callsign: this.resolveCallsign(mate.targetId, mate.archetype),
        category: response.category,
        text: response.text,
        worldPos: copyVec3(mate.worldPos),
        isRadio: true,
        durationS: 2.3,
      });
    }
  }

  public notifyContact(
    speakerId: string,
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    squadmates: readonly SquadMateSummary[],
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const responder = squadmates.find((m) => m.targetId !== speakerId && m.alive && m.conscious);
    const text = CONTACT_LINES[this.lineCounter++ % CONTACT_LINES.length];
    const scheduledReply: PendingRadioResponse | null = responder
      ? {
          triggerAtS: elapsedClockS + this.callAndResponseDelayS,
          responderId: responder.targetId,
          archetype: responder.archetype,
          category: 'SUPPRESSING',
          text: CONTACT_REPLY_LINES[this.lineCounter++ % CONTACT_REPLY_LINES.length],
          worldPos: copyVec3(responder.worldPos),
        }
      : null;
    this.tryEmitRadioBark(speakerId, archetype, 'CONTACT', text, worldPos, elapsedClockS, onBark, scheduledReply);
  }

  public notifyFlankOrPeekShift(
    speakerId: string,
    archetype: EnemyArchetypeId,
    peekSign: -1 | 1,
    worldPos: Vec3Like,
    squadmates: readonly SquadMateSummary[],
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const suppressor =
      squadmates.find((m) => m.targetId !== speakerId && m.alive && m.conscious && m.isSuppressing) ??
      squadmates.find((m) => m.targetId !== speakerId && m.alive && m.conscious);
    const pool = peekSign < 0 ? FLANK_LEFT_LINES : FLANK_RIGHT_LINES;
    const text = pool[this.lineCounter++ % pool.length];
    const scheduledReply: PendingRadioResponse | null = suppressor
      ? {
          triggerAtS: elapsedClockS + this.callAndResponseDelayS,
          responderId: suppressor.targetId,
          archetype: suppressor.archetype,
          category: 'SUPPRESSING',
          text: SUPPRESS_REPLY_LINES[this.lineCounter++ % SUPPRESS_REPLY_LINES.length],
          worldPos: copyVec3(suppressor.worldPos),
        }
      : null;
    this.tryEmitRadioBark(speakerId, archetype, 'FLANKING', text, worldPos, elapsedClockS, onBark, scheduledReply);
  }

  public notifyCoverRetreat(
    speakerId: string,
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const text = COVER_RETREAT_LINES[this.lineCounter++ % COVER_RETREAT_LINES.length];
    this.tryEmitRadioBark(speakerId, archetype, 'RELOADING_COVER', text, worldPos, elapsedClockS, onBark);
  }

  public notifySidearmTransition(
    speakerId: string,
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const text = SIDEARM_LINES[this.lineCounter++ % SIDEARM_LINES.length];
    this.tryEmitRadioBark(speakerId, archetype, 'SIDEARM_TRANSITION', text, worldPos, elapsedClockS, onBark);
  }

  public notifyAllyDown(
    deadTargetId: string,
    deadWorldPos: Vec3Like,
    squadmates: readonly SquadMateSummary[],
    elapsedClockS: number
  ): void {
    this.cancelPendingForAgent(deadTargetId);
    let nearestMate: SquadMateSummary | undefined;
    let bestDist = 22.0;
    for (const m of squadmates) {
      if (m.targetId === deadTargetId || !m.alive || !m.conscious) continue;
      const d = distance(m.worldPos, deadWorldPos);
      if (d <= bestDist) {
        bestDist = d;
        nearestMate = m;
      }
    }
    if (nearestMate) {
      this.channelState = transitionScheduleAllyDown(this.channelState, {
        triggerAtS: elapsedClockS + this.allyDownDelayS,
        responderId: nearestMate.targetId,
        archetype: nearestMate.archetype,
        category: 'ALLY_DOWN',
        text: ALLY_DOWN_LINES[this.lineCounter++ % ALLY_DOWN_LINES.length],
        worldPos: copyVec3(nearestMate.worldPos),
      });
    }
  }

  public notifyWoundedTrauma(
    speakerId: string,
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    vocalCue: VocalTraumaCue,
    isBerserkerCharge: boolean,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    if (isBerserkerCharge) {
      const text = BERSERKER_LINES[this.lineCounter++ % BERSERKER_LINES.length];
      this.tryEmitRadioBark(speakerId, archetype, 'BERSERKER_CHARGE', text, worldPos, elapsedClockS, onBark);
      return;
    }
    if (vocalCue === 'NONE') return;
    const nextAllowed = this.speakerNextTraumaS.get(speakerId) ?? 0;
    if (elapsedClockS < nextAllowed) return;

    this.speakerNextTraumaS.set(speakerId, elapsedClockS + this.perSpeakerTraumaCooldownS);
    onBark({
      speakerId,
      callsign: this.resolveCallsign(speakerId, archetype),
      category: 'WOUNDED_TRAUMA',
      text: VOCAL_CUE_TEXT[vocalCue],
      worldPos: copyVec3(worldPos),
      isRadio: false,
      vocalCue,
      durationS: 1.75,
    });
  }

  public notifyWitnessedBrutality(
    speakerId: string,
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    category: AiBarkCategory,
    isHeadLoss: boolean,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): void {
    const pool =
      category === 'BERSERKER_CHARGE'
        ? BERSERKER_LINES
        : category === 'TACTICAL_CALLOUT'
          ? VETERAN_BRUTAL_CALLOUTS
          : isHeadLoss
            ? HORROR_HEAD_LINES
            : HORROR_LIMB_LINES;
    const text = pool[this.lineCounter++ % pool.length];
    const emitted = this.tryEmitRadioBark(
      speakerId,
      archetype,
      category,
      text,
      worldPos,
      elapsedClockS,
      onBark
    );
    if (!emitted && category === 'HORROR_SHOCK') {
      const nextAllowed = this.speakerNextTraumaS.get(speakerId) ?? 0;
      if (elapsedClockS >= nextAllowed) {
        this.speakerNextTraumaS.set(speakerId, elapsedClockS + this.perSpeakerTraumaCooldownS);
        onBark({
          speakerId,
          callsign: this.resolveCallsign(speakerId, archetype),
          category: 'HORROR_SHOCK',
          text,
          worldPos: copyVec3(worldPos),
          isRadio: false,
          durationS: 2.1,
        });
      }
    }
  }

  public cancelPendingForAgent(targetId: string): void {
    this.channelState = transitionCancelAgentRadioResponses(this.channelState, targetId);
  }

  public reset(): void {
    this.channelState = createIdleRadioChannelState();
    this.callsigns.clear();
    this.speakerNextRadioS.clear();
    this.speakerNextTraumaS.clear();
  }

  private tryEmitRadioBark(
    speakerId: string,
    archetype: EnemyArchetypeId,
    category: AiBarkCategory,
    text: string,
    worldPos: Vec3Like,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void,
    scheduledReply: PendingRadioResponse | null = null
  ): boolean {
    if (!canStartPrimaryRadioCall(this.channelState, elapsedClockS)) return false;
    const speakerAllowedAt = this.speakerNextRadioS.get(speakerId) ?? 0;
    if (elapsedClockS < speakerAllowedAt) return false;

    const lockUntilS = elapsedClockS + this.globalRadioLockDurationS;
    this.channelState = transitionBeginRadioCall(this.channelState, speakerId, lockUntilS, scheduledReply);
    this.speakerNextRadioS.set(speakerId, elapsedClockS + this.perSpeakerRadioCooldownS);
    onBark({
      speakerId,
      callsign: this.resolveCallsign(speakerId, archetype),
      category,
      text,
      worldPos: copyVec3(worldPos),
      isRadio: true,
      durationS: 2.4,
    });
    return true;
  }
}
