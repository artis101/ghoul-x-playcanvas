import type { AiBarkCategory, AiBarkPayload } from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';
import type { VocalTraumaCue } from '../../contracts/physiology/entityStateTypes.ts';
import { copyVec3, distance } from '../ballistics/vec3.ts';

export interface SquadMateSummary {
  readonly targetId: string;
  readonly archetype: EnemyArchetypeId;
  readonly worldPos: Vec3Like;
  readonly alive: boolean;
  readonly conscious: boolean;
  readonly isSuppressing: boolean;
}

interface PendingRadioResponse {
  readonly triggerAtS: number;
  readonly responderId: string;
  readonly archetype: EnemyArchetypeId;
  readonly category: AiBarkCategory;
  readonly text: string;
  readonly worldPos: Vec3Like;
}

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

const FLANK_LEFT_LINES = [
  'Flanking left! Keep him pinned!',
  'Shifting left angle—cover me!',
];

const FLANK_RIGHT_LINES = [
  'Pushing right side! Lay it down!',
  'Re-angling right—suppressing fire!',
];

const SUPPRESS_REPLY_LINES = [
  'Copy, suppressing! Move now!',
  'Covering your flank—pour it on!',
  'Keeping his head down! Go!',
];

const COVER_RETREAT_LINES = [
  'Taking heavy fire! Shifting cover!',
  'Pinned down! Need suppression!',
];

const SIDEARM_LINES = [
  'Primary disabled—transitioning to M9!',
  'Drawing backup sidearm!',
];

const ALLY_DOWN_LINES = [
  'Man down! Check your sectors!',
  'They got him! Pour fire on that angle!',
  'Squadmate KIA—stay sharp!',
];

const BERSERKER_LINES = [
  'BLEED HIM DRY! PUSH!',
  'NO COVER! RUSH HIM NOW!',
];

const VOCAL_CUE_TEXT: Record<Exclude<VocalTraumaCue, 'NONE'>, string> = {
  SHARP_GASP: '*sharp pleural gasp*',
  WET_HEMOTHORAX_COUGH: '*wet hemothorax cough*',
  AGUNAL_WHEEZE: '*agonal hypoxic wheeze*',
  PAIN_GRUNT: '*visceral pain grunt*',
};

/**
 * Pure F.E.A.R.-style Squad Radio & Trauma Bark Coordinator.
 * Enforces a global 2.2s radio channel lock so bots never talk over each other,
 * schedules 0.85s call-and-response pairs, and cancels queued replies if the responder dies.
 */
export class SquadBarkCoordinator {
  private readonly globalRadioLockDurationS = 2.2;
  private readonly callAndResponseDelayS = 0.85;
  private readonly allyDownDelayS = 0.48;
  private readonly perSpeakerRadioCooldownS = 4.5;
  private readonly perSpeakerTraumaCooldownS = 1.65;

  private globalRadioAvailableAtS = 0;
  private readonly callsigns = new Map<string, string>();
  private readonly speakerNextRadioS = new Map<string, number>();
  private readonly speakerNextTraumaS = new Map<string, number>();
  private readonly pendingResponses: PendingRadioResponse[] = [];
  private lineCounter = 0;

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
    for (let i = this.pendingResponses.length - 1; i >= 0; i--) {
      const pending = this.pendingResponses[i];
      if (elapsedClockS < pending.triggerAtS) continue;

      this.pendingResponses.splice(i, 1);
      const mate = resolveMateState(pending.responderId);
      if (!mate || !mate.alive || !mate.conscious) {
        continue; // Cancelled because responder died or lost consciousness mid-delay
      }

      const bark: AiBarkPayload = {
        speakerId: mate.targetId,
        callsign: this.resolveCallsign(mate.targetId, mate.archetype),
        category: pending.category,
        text: pending.text,
        worldPos: copyVec3(mate.worldPos),
        isRadio: true,
        durationS: 2.3,
      };
      this.globalRadioAvailableAtS = Math.max(
        this.globalRadioAvailableAtS,
        elapsedClockS + 1.45
      );
      this.speakerNextRadioS.set(
        mate.targetId,
        elapsedClockS + this.perSpeakerRadioCooldownS
      );
      onBark(bark);
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
    const text = CONTACT_LINES[this.lineCounter++ % CONTACT_LINES.length];
    if (!this.tryEmitRadioBark(speakerId, archetype, 'CONTACT', text, worldPos, elapsedClockS, onBark)) {
      return;
    }

    const responder = squadmates.find(
      (m) => m.targetId !== speakerId && m.alive && m.conscious
    );
    if (responder) {
      this.queueResponse({
        triggerAtS: elapsedClockS + this.callAndResponseDelayS,
        responderId: responder.targetId,
        archetype: responder.archetype,
        category: 'SUPPRESSING',
        text: CONTACT_REPLY_LINES[this.lineCounter++ % CONTACT_REPLY_LINES.length],
        worldPos: copyVec3(responder.worldPos),
      });
    }
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
    const pool = peekSign < 0 ? FLANK_LEFT_LINES : FLANK_RIGHT_LINES;
    const text = pool[this.lineCounter++ % pool.length];
    if (!this.tryEmitRadioBark(speakerId, archetype, 'FLANKING', text, worldPos, elapsedClockS, onBark)) {
      return;
    }

    const suppressor =
      squadmates.find((m) => m.targetId !== speakerId && m.alive && m.conscious && m.isSuppressing) ??
      squadmates.find((m) => m.targetId !== speakerId && m.alive && m.conscious);
    if (suppressor) {
      this.queueResponse({
        triggerAtS: elapsedClockS + this.callAndResponseDelayS,
        responderId: suppressor.targetId,
        archetype: suppressor.archetype,
        category: 'SUPPRESSING',
        text: SUPPRESS_REPLY_LINES[this.lineCounter++ % SUPPRESS_REPLY_LINES.length],
        worldPos: copyVec3(suppressor.worldPos),
      });
    }
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
      this.queueResponse({
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

  public cancelPendingForAgent(targetId: string): void {
    for (let i = this.pendingResponses.length - 1; i >= 0; i--) {
      if (this.pendingResponses[i].responderId === targetId) {
        this.pendingResponses.splice(i, 1);
      }
    }
  }

  public reset(): void {
    this.globalRadioAvailableAtS = 0;
    this.callsigns.clear();
    this.speakerNextRadioS.clear();
    this.speakerNextTraumaS.clear();
    this.pendingResponses.length = 0;
  }

  private tryEmitRadioBark(
    speakerId: string,
    archetype: EnemyArchetypeId,
    category: AiBarkCategory,
    text: string,
    worldPos: Vec3Like,
    elapsedClockS: number,
    onBark: (bark: AiBarkPayload) => void
  ): boolean {
    if (elapsedClockS < this.globalRadioAvailableAtS) return false;
    const speakerAllowedAt = this.speakerNextRadioS.get(speakerId) ?? 0;
    if (elapsedClockS < speakerAllowedAt) return false;

    this.globalRadioAvailableAtS = elapsedClockS + this.globalRadioLockDurationS;
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

  private queueResponse(resp: PendingRadioResponse): void {
    if (this.pendingResponses.length >= 2) {
      this.pendingResponses.shift();
    }
    this.pendingResponses.push(resp);
  }
}
