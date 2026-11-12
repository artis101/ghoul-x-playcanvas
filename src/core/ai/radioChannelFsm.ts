import type { AiBarkCategory } from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';

export interface SquadMateSummary {
  readonly targetId: string;
  readonly archetype: EnemyArchetypeId;
  readonly worldPos: Vec3Like;
  readonly alive: boolean;
  readonly conscious: boolean;
  readonly isSuppressing: boolean;
}

export interface PendingRadioResponse {
  readonly triggerAtS: number;
  readonly responderId: string;
  readonly archetype: EnemyArchetypeId;
  readonly category: AiBarkCategory;
  readonly text: string;
  readonly worldPos: Vec3Like;
}

export type RadioChannelState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'CALL_TRANSMITTING';
      readonly speakerId: string;
      readonly lockUntilS: number;
      readonly scheduledReply: PendingRadioResponse | null;
      readonly deferredAllyDown: PendingRadioResponse | null;
    }
  | {
      readonly kind: 'REPLY_PENDING';
      readonly reply: PendingRadioResponse;
      readonly channelFreeAtS: number;
    }
  | {
      readonly kind: 'REPLY_TRANSMITTING';
      readonly speakerId: string;
      readonly lockUntilS: number;
      readonly deferredAllyDown: PendingRadioResponse | null;
    };

export interface RadioStepEmission {
  readonly mate: SquadMateSummary;
  readonly response: PendingRadioResponse;
}

export interface RadioChannelStepResult {
  readonly state: RadioChannelState;
  readonly emissions: readonly RadioStepEmission[];
}

export function createIdleRadioChannelState(): RadioChannelState {
  return { kind: 'IDLE' };
}

export function getActiveRadioCallEndS(state: RadioChannelState): number {
  switch (state.kind) {
    case 'IDLE':
      return 0;
    case 'CALL_TRANSMITTING':
    case 'REPLY_TRANSMITTING':
      return state.lockUntilS;
    case 'REPLY_PENDING':
      return state.channelFreeAtS;
  }
}

export function canStartPrimaryRadioCall(state: RadioChannelState, elapsedClockS: number): boolean {
  switch (state.kind) {
    case 'IDLE':
      return true;
    case 'CALL_TRANSMITTING':
      return elapsedClockS >= state.lockUntilS && state.scheduledReply === null;
    case 'REPLY_TRANSMITTING':
      return elapsedClockS >= state.lockUntilS;
    case 'REPLY_PENDING':
      return elapsedClockS >= state.channelFreeAtS && elapsedClockS < state.reply.triggerAtS;
  }
}

export function transitionBeginRadioCall(
  state: RadioChannelState,
  speakerId: string,
  lockUntilS: number,
  scheduledReply: PendingRadioResponse | null = null
): RadioChannelState {
  let deferredAllyDown: PendingRadioResponse | null = null;
  if (state.kind === 'CALL_TRANSMITTING' || state.kind === 'REPLY_TRANSMITTING') {
    deferredAllyDown = state.deferredAllyDown;
  } else if (state.kind === 'REPLY_PENDING' && state.reply.category === 'ALLY_DOWN') {
    deferredAllyDown = state.reply;
  }
  if (deferredAllyDown) {
    deferredAllyDown = {
      ...deferredAllyDown,
      triggerAtS: Math.max(deferredAllyDown.triggerAtS, lockUntilS),
    };
  }
  return { kind: 'CALL_TRANSMITTING', speakerId, lockUntilS, scheduledReply, deferredAllyDown };
}

export function transitionScheduleAllyDown(
  state: RadioChannelState,
  reply: PendingRadioResponse
): RadioChannelState {
  const activeCallEndS = getActiveRadioCallEndS(state);
  const deferredReply: PendingRadioResponse = {
    ...reply,
    triggerAtS: Math.max(reply.triggerAtS, activeCallEndS),
  };

  switch (state.kind) {
    case 'IDLE':
      return { kind: 'REPLY_PENDING', reply: deferredReply, channelFreeAtS: 0 };
    case 'REPLY_PENDING':
      return { kind: 'REPLY_PENDING', reply: deferredReply, channelFreeAtS: state.channelFreeAtS };
    case 'CALL_TRANSMITTING':
    case 'REPLY_TRANSMITTING':
      return { ...state, deferredAllyDown: deferredReply };
  }
}

export function transitionCancelAgentRadioResponses(
  state: RadioChannelState,
  targetId: string
): RadioChannelState {
  switch (state.kind) {
    case 'IDLE':
      return state;
    case 'CALL_TRANSMITTING':
      return {
        ...state,
        scheduledReply: state.scheduledReply?.responderId === targetId ? null : state.scheduledReply,
        deferredAllyDown: state.deferredAllyDown?.responderId === targetId ? null : state.deferredAllyDown,
      };
    case 'REPLY_TRANSMITTING':
      return {
        ...state,
        deferredAllyDown: state.deferredAllyDown?.responderId === targetId ? null : state.deferredAllyDown,
      };
    case 'REPLY_PENDING':
      if (state.reply.responderId !== targetId) return state;
      return state.channelFreeAtS > 0
        ? { kind: 'REPLY_TRANSMITTING', speakerId: '', lockUntilS: state.channelFreeAtS, deferredAllyDown: null }
        : { kind: 'IDLE' };
  }
}

export function stepRadioChannelState(
  initialState: RadioChannelState,
  elapsedClockS: number,
  resolveMateState: (targetId: string) => SquadMateSummary | undefined,
  replyLockDurationS: number
): RadioChannelStepResult {
  let state = initialState;
  const emissions: RadioStepEmission[] = [];

  if (state.kind === 'CALL_TRANSMITTING' && state.scheduledReply !== null) {
    if (elapsedClockS >= state.scheduledReply.triggerAtS) {
      const pending = state.scheduledReply;
      const mate = resolveMateState(pending.responderId);
      if (mate && mate.alive && mate.conscious) {
        emissions.push({ mate, response: pending });
        const lockUntilS = Math.max(state.lockUntilS, elapsedClockS + replyLockDurationS);
        const deferredAllyDown = state.deferredAllyDown
          ? { ...state.deferredAllyDown, triggerAtS: Math.max(state.deferredAllyDown.triggerAtS, lockUntilS) }
          : null;
        state = { kind: 'REPLY_TRANSMITTING', speakerId: mate.targetId, lockUntilS, deferredAllyDown };
      } else {
        state = { ...state, scheduledReply: null };
      }
    }
  }

  if (state.kind === 'CALL_TRANSMITTING' && state.scheduledReply === null && elapsedClockS >= state.lockUntilS) {
    state = state.deferredAllyDown
      ? { kind: 'REPLY_PENDING', reply: state.deferredAllyDown, channelFreeAtS: state.lockUntilS }
      : { kind: 'IDLE' };
  }

  if (state.kind === 'REPLY_TRANSMITTING' && elapsedClockS >= state.lockUntilS) {
    state = state.deferredAllyDown
      ? { kind: 'REPLY_PENDING', reply: state.deferredAllyDown, channelFreeAtS: state.lockUntilS }
      : { kind: 'IDLE' };
  }

  if (state.kind === 'REPLY_PENDING') {
    const readyAtS = Math.max(state.reply.triggerAtS, state.channelFreeAtS);
    if (elapsedClockS >= readyAtS) {
      const mate = resolveMateState(state.reply.responderId);
      if (mate && mate.alive && mate.conscious) {
        emissions.push({ mate, response: state.reply });
        state = {
          kind: 'REPLY_TRANSMITTING',
          speakerId: mate.targetId,
          lockUntilS: elapsedClockS + replyLockDurationS,
          deferredAllyDown: null,
        };
      } else {
        state = { kind: 'IDLE' };
      }
    }
  }

  return { state, emissions };
}
