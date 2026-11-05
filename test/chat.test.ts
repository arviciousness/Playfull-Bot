import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChat, type ChatInput } from '../src/services/chat.js';
import { isCounting, voiceEffect } from '../src/services/voice.js';
import { setup } from './helpers.js';

function input(patch: Partial<ChatInput>): ChatInput {
  return {
    enabled: true,
    isBot: false,
    channelAllowed: true,
    hasVerifiedRole: true,
    requireVerified: true,
    content: 'hello',
    hasMedia: false,
    now: 1_000_000,
    lastAwardAt: null,
    lastContent: null,
    lastContentAt: null,
    rules: {
      amount: 1,
      cooldownMs: 60_000,
      minLength: 2,
      duplicateWindowMs: 600_000,
      rejectDuplicates: true,
      countMediaWithoutText: false,
      ignorePrefixes: ['p!'],
    },
    ...patch,
  };
}

test('chat pays verified members in allowed channels and blocks farming', () => {
  assert.equal(evaluateChat(input({})).reason, 'ok');
  assert.equal(evaluateChat(input({ isBot: true })).reason, 'bot');
  assert.equal(evaluateChat(input({ channelAllowed: false })).reason, 'channel');
  assert.equal(evaluateChat(input({ hasVerifiedRole: false })).reason, 'role');
  assert.equal(evaluateChat(input({ content: 'a' })).reason, 'too-short');
  assert.equal(evaluateChat(input({ content: '🔥🔥' })).reason, 'low-quality');
  assert.equal(evaluateChat(input({ content: 'p!balance' })).reason, 'command');
  assert.equal(evaluateChat(input({ content: 'aaaaaaaa' })).reason, 'low-quality');
  assert.equal(evaluateChat(input({ now: 30_000, lastAwardAt: 0, lastContent: 'hey', lastContentAt: 0, content: 'hey there' })).reason, 'cooldown');
  assert.equal(evaluateChat(input({
    now: 120_000,
    lastAwardAt: 0,
    lastContent: 'hello',
    lastContentAt: 0,
    content: 'hello',
  })).reason, 'duplicate');
  assert.equal(evaluateChat(input({
    now: 120_000,
    lastAwardAt: 0,
    lastContent: 'hello',
    lastContentAt: 0,
    content: 'different message',
  })).reason, 'ok');
});

test('voice time pauses when deafened and counts a normal Gaming Hub session', () => {
  const rules = { ignoreDeafened: true, ignoreMuted: false, ignoreAfk: true };
  const sitting = { inHub: true, selfDeaf: false, serverDeaf: false, selfMute: true, serverMute: false, afk: false, channelId: 'hub' };
  const deaf = { ...sitting, selfDeaf: true };
  const left = { ...sitting, inHub: false, channelId: null };
  assert.equal(isCounting(sitting, rules), true);
  assert.equal(isCounting(deaf, rules), false);
  assert.equal(voiceEffect({ ...sitting, counting: true }, { ...deaf, counting: false }), 'close');
  assert.equal(voiceEffect({ ...deaf, counting: false }, { ...sitting, counting: true }), 'open');
  assert.equal(voiceEffect({ ...sitting, counting: true }, { ...left, counting: false }), 'close');
  assert.equal(voiceEffect(
    { ...sitting, counting: true },
    { ...sitting, counting: true, channelId: 'hub-2' },
  ), 'reopen');
});

test('tracked voice seconds survive a restart without counting the downtime', () => {
  const { store, guildId } = setup();
  store.openVoiceSegment({ guildId, userId: 'u', channelId: 'hub', weekId: '1', startedAt: 0 });
  store.heartbeatVoice(guildId, 65_000);
  store.settleVoiceOnStartup(guildId, 500_000, new Set(['u']));
  const [segment] = store.listVoiceSegments(guildId, '1');
  assert.equal(segment?.seconds, 65);
  assert.equal(segment?.endedAt, null);
  assert.equal(segment?.startedAt, 500_000);
  store.settleVoiceOnStartup(guildId, 600_000, new Set());
  const [closed] = store.listVoiceSegments(guildId, '1');
  assert.equal(closed?.seconds, 65);
  assert.equal(closed?.endedAt, 600_000);
});
