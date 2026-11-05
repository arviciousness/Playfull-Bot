export interface VoiceFlags {
  inHub: boolean;
  selfDeaf: boolean;
  serverDeaf: boolean;
  selfMute: boolean;
  serverMute: boolean;
  afk: boolean;
  channelId: string | null;
}

export interface VoiceCountRules {
  ignoreDeafened: boolean;
  ignoreMuted: boolean;
  ignoreAfk: boolean;
}

export type VoiceEffect = 'none' | 'open' | 'close' | 'reopen';

export function isCounting(state: VoiceFlags, rules: VoiceCountRules): boolean {
  if (!state.inHub) return false;
  if (rules.ignoreAfk && state.afk) return false;
  if (rules.ignoreDeafened && (state.selfDeaf || state.serverDeaf)) return false;
  if (rules.ignoreMuted && (state.selfMute || state.serverMute)) return false;
  return true;
}

export function voiceEffect(prev: VoiceFlags & { counting: boolean }, next: VoiceFlags & { counting: boolean }): VoiceEffect {
  if (prev.counting && next.counting && prev.channelId !== next.channelId) return 'reopen';
  if (prev.counting && !next.counting) return 'close';
  if (!prev.counting && next.counting) return 'open';
  return 'none';
}

export function creditedSeconds(segment: { startedAt: number; endedAt: number | null; seconds: number }, now: number): number {
  if (segment.endedAt !== null) return segment.seconds;
  return segment.seconds + Math.max(0, Math.floor((now - segment.startedAt) / 1000));
}

export function qualifiesForVoice(seconds: number, qualifyMinutes: number): boolean {
  return seconds >= qualifyMinutes * 60;
}
