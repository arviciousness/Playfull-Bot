export interface ChatRules {
  amount: number;
  cooldownMs: number;
  minLength: number;
  duplicateWindowMs: number;
  rejectDuplicates: boolean;
  countMediaWithoutText: boolean;
  ignorePrefixes: string[];
}

export type ChatReason =
  | 'ok'
  | 'bot'
  | 'channel'
  | 'role'
  | 'cooldown'
  | 'too-short'
  | 'duplicate'
  | 'low-quality'
  | 'command'
  | 'disabled';

export interface ChatInput {
  enabled: boolean;
  isBot: boolean;
  channelAllowed: boolean;
  hasVerifiedRole: boolean;
  requireVerified: boolean;
  content: string;
  hasMedia: boolean;
  now: number;
  lastAwardAt: number | null;
  lastContent: string | null;
  lastContentAt: number | null;
  rules: ChatRules;
}

export function evaluateChat(input: ChatInput): { award: boolean; reason: ChatReason } {
  if (!input.enabled) return { award: false, reason: 'disabled' };
  if (input.isBot) return { award: false, reason: 'bot' };
  if (!input.channelAllowed) return { award: false, reason: 'channel' };
  if (input.requireVerified && !input.hasVerifiedRole) return { award: false, reason: 'role' };

  const content = input.content.trim();
  const lowered = content.toLowerCase();
  if (input.rules.ignorePrefixes.some((prefix) => prefix && lowered.startsWith(prefix.toLowerCase()))) {
    return { award: false, reason: 'command' };
  }
  if (isLowQuality(content, input.rules.minLength)) {
    if (!(input.hasMedia && input.rules.countMediaWithoutText)) {
      return { award: false, reason: content.length < input.rules.minLength ? 'too-short' : 'low-quality' };
    }
  }

  if (
    input.rules.rejectDuplicates &&
    input.lastContent &&
    input.lastContentAt !== null &&
    normalizeForDuplicate(content) === input.lastContent &&
    input.now - input.lastContentAt < input.rules.duplicateWindowMs
  ) {
    return { award: false, reason: 'duplicate' };
  }

  if (input.lastAwardAt !== null && input.now - input.lastAwardAt < input.rules.cooldownMs) {
    return { award: false, reason: 'cooldown' };
  }

  return { award: true, reason: 'ok' };
}

export function normalizeForDuplicate(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function isLowQuality(content: string, minLength: number): boolean {
  const stripped = content
    .replace(/<a?:.+?:\d+>/g, '')
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  if (stripped.length < minLength) return true;
  if (/^(.)\1{7,}$/i.test(stripped)) return true;
  return false;
}
