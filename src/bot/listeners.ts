import { Events, REST, Routes, type Client, type Guild, type GuildMember, type Message, type PartialGuildMember, type VoiceState } from 'discord.js';
import { evaluateChat, normalizeForDuplicate } from '../services/chat.js';
import { drawGiveaway } from '../services/giveaway.js';
import { isCounting, voiceEffect, type VoiceFlags } from '../services/voice.js';
import { commandPayloads } from './commands.js';
import { publishWinner, performWeeklyReset, rememberEconomy } from './flows.js';
import {
  grantConfiguredRole,
  isEarnChannel,
  isHubChannel,
  memberRoleKeys,
  postAudit,
  roleLabel,
  type BotContext,
} from './kit.js';

export function bindListeners(client: Client, ctx: BotContext): void {
  client.on(Events.MessageCreate, (message) => {
    void onMessage(ctx, message).catch((error: unknown) => console.error('[playfull] Chat reward failed.', error));
  });
  client.on(Events.VoiceStateUpdate, (previous, next) => {
    void onVoice(ctx, previous, next).catch((error: unknown) => console.error('[playfull] Voice tracking failed.', error));
  });
  client.on(Events.GuildMemberUpdate, (previous, next) => {
    void onMember(ctx, previous, next).catch((error: unknown) => console.error('[playfull] Boost reward failed.', error));
  });
}

export async function onReady(client: Client, ctx: BotContext): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.error('[playfull] DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
  } else {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(clientId, ctx.config.guildId), { body: commandPayloads(ctx.config) });
    console.log(`[playfull] Registered ${commandPayloads(ctx.config).length} commands.`);
  }
  const guild = await client.guilds.fetch(ctx.config.guildId).catch(() => null);
  if (!guild) {
    console.error(`[playfull] Could not find server ${ctx.config.guildId}. Check guildId and that the bot is invited.`);
    return;
  }
  await guild.channels.fetch().catch(() => undefined);
  await guild.members.fetch().catch((error: unknown) => {
    console.error('[playfull] Could not load members. Turn on the Server Members Intent in the Developer Portal.', error);
  });
  await syncVoice(guild, ctx);
  await tickGiveaways(client, ctx);
}

export function startLoops(client: Client, ctx: BotContext): void {
  const heartbeatMs = Math.max(10, ctx.config.voice.heartbeatSeconds) * 1000;
  setInterval(() => {
    void reconcileVoice(client, ctx).catch((error: unknown) => console.error('[playfull] Voice heartbeat failed.', error));
  }, heartbeatMs);
  setInterval(() => {
    void tickGiveaways(client, ctx).catch((error: unknown) => console.error('[playfull] Giveaway check failed.', error));
  }, 15_000);
}

async function onMessage(ctx: BotContext, message: Message): Promise<void> {
  if (!message.guild || message.guild.id !== ctx.config.guildId || !ctx.config.chat.enabled) return;
  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  const state = ctx.store.getChatState(ctx.config.guildId, message.author.id);
  const decision = evaluateChat({
    enabled: ctx.config.chat.enabled,
    isBot: message.author.bot || Boolean(message.webhookId) || message.system,
    channelAllowed: isEarnChannel(message, ctx.config),
    hasVerifiedRole: member ? memberRoleKeys(member, ctx.config).includes('verified') : false,
    requireVerified: ctx.config.chat.requireVerified,
    content: message.content,
    hasMedia: message.attachments.size > 0 || message.stickers.size > 0,
    now: Date.now(),
    lastAwardAt: state.lastAwardAt,
    lastContent: state.lastContent,
    lastContentAt: state.lastContentAt,
    rules: {
      amount: ctx.config.chat.amount,
      cooldownMs: ctx.config.chat.cooldownSeconds * 1000,
      minLength: ctx.config.chat.minLength,
      duplicateWindowMs: ctx.config.chat.duplicateWindowSeconds * 1000,
      rejectDuplicates: ctx.config.chat.rejectDuplicates,
      countMediaWithoutText: ctx.config.chat.countMediaWithoutText,
      ignorePrefixes: ctx.config.chat.ignorePrefixes,
    },
  });
  if (!decision.award) return;
  const result = ctx.economy.add(ctx.config.guildId, message.author.id, ctx.config.chat.amount, 'chat', null);
  if (!result.ok) return;
  ctx.store.setChatState(ctx.config.guildId, message.author.id, Date.now(), normalizeForDuplicate(message.content));
  await rememberEconomy(
    message.guild,
    ctx,
    message.author.id,
    result.created,
    ctx.config.chat.amount,
    0,
    'chat',
    result.account,
    { includeChange: ctx.config.audit.logChatEarnings },
  );
}

async function onVoice(ctx: BotContext, previous: VoiceState, next: VoiceState): Promise<void> {
  const guild = next.guild;
  if (guild.id !== ctx.config.guildId) return;
  const member = next.member ?? previous.member;
  if (!member || member.user.bot) return;
  const before = snapshot(previous, ctx);
  const after = snapshot(next, ctx);
  const effect = voiceEffect(before, after);
  const now = Date.now();
  if (effect === 'close' || effect === 'reopen') ctx.store.closeOpenVoiceSegments(guild.id, member.id, now, true);
  if (effect === 'open' || effect === 'reopen') {
    const channelId = after.channelId;
    if (!channelId) return;
    ctx.store.openVoiceSegment({
      guildId: guild.id,
      userId: member.id,
      channelId,
      weekId: ctx.store.getWeek(guild.id).weekId,
      startedAt: now,
    });
  }
}

function snapshot(state: VoiceState, ctx: BotContext): VoiceFlags & { counting: boolean } {
  const flags: VoiceFlags = {
    inHub: isHubChannel(state.channel, ctx.config),
    selfDeaf: Boolean(state.selfDeaf),
    serverDeaf: Boolean(state.serverDeaf),
    selfMute: Boolean(state.selfMute),
    serverMute: Boolean(state.serverMute),
    afk: Boolean(state.channelId && state.guild.afkChannelId === state.channelId),
    channelId: state.channelId,
  };
  return { ...flags, counting: isCounting(flags, ctx.config.voice) };
}

async function onMember(ctx: BotContext, previous: GuildMember | PartialGuildMember, next: GuildMember): Promise<void> {
  if (next.guild.id !== ctx.config.guildId || next.user.bot) return;
  if (previous.partial) return;
  if (!next.premiumSince) return;
  if (previous.premiumSince && previous.premiumSince.getTime() === next.premiumSince.getTime()) return;
  if (previous.premiumSince) return;
  if (!ctx.store.recordBoost(next.guild.id, next.id, next.premiumSince.getTime())) return;

  if (ctx.config.boost.autoGrantPatron) {
    const full = await next.guild.members.fetch(next.id);
    const roleError = await grantConfiguredRole(full, 'playfullPatron', ctx.config);
    if (roleError) console.error(`[playfull] ${roleError}`);
  }
  if (ctx.config.boost.grantPlayBits <= 0) {
    await postAudit(next.guild, ctx.config, `Server boost · <@${next.id}> · ${roleLabel(ctx.config, 'playfullPatron')} role`);
    return;
  }
  const key = ctx.config.boost.countsAsPurchase ? 'purchase' : 'boost';
  const week = ctx.store.getWeek(next.guild.id);
  const existing = ctx.store.findOpenClaim(next.guild.id, next.id, key, week.weekId);
  if (existing?.status === 'approved') {
    await postAudit(next.guild, ctx.config, `Server boost · <@${next.id}> · role refreshed, reward already granted this week`);
    return;
  }
  const paid = ctx.economy.add(next.guild.id, next.id, ctx.config.boost.grantPlayBits, 'boost', null);
  if (!paid.ok) return;
  if (existing?.status === 'pending') ctx.store.resolveClaim(existing.id, 'approved', null, 'server boost');
  else {
    ctx.store.createClaim({
      guildId: next.guild.id,
      userId: next.id,
      activityKey: key,
      weekId: week.weekId,
      status: 'approved',
      note: 'server boost',
      reviewerId: null,
      reviewNote: 'server boost',
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    });
  }
  await rememberEconomy(next.guild, ctx, next.id, paid.created, ctx.config.boost.grantPlayBits, 0, 'boost', paid.account);
}

async function syncVoice(guild: Guild, ctx: BotContext): Promise<void> {
  const present: { userId: string; channelId: string }[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased() || !isHubChannel(channel, ctx.config)) continue;
    for (const [userId, member] of channel.members) {
      if (member.user.bot) continue;
      const flags: VoiceFlags = {
        inHub: true,
        selfDeaf: Boolean(member.voice.selfDeaf),
        serverDeaf: Boolean(member.voice.serverDeaf),
        selfMute: Boolean(member.voice.selfMute),
        serverMute: Boolean(member.voice.serverMute),
        afk: channel.id === guild.afkChannelId,
        channelId: channel.id,
      };
      if (!isCounting(flags, ctx.config.voice)) continue;
      present.push({ userId, channelId: channel.id });
    }
  }
  const now = Date.now();
  ctx.store.settleVoiceOnStartup(guild.id, now, new Set(present.map((person) => person.userId)));
  const weekId = ctx.store.getWeek(guild.id).weekId;
  for (const person of present) {
    ctx.store.openVoiceSegment({ guildId: guild.id, userId: person.userId, channelId: person.channelId, weekId, startedAt: now });
  }
}

async function reconcileVoice(client: Client, ctx: BotContext): Promise<void> {
  const guild = client.guilds.cache.get(ctx.config.guildId);
  const now = Date.now();
  if (!guild) {
    ctx.store.heartbeatVoice(ctx.config.guildId, now);
    return;
  }
  for (const segment of ctx.store.listOpenVoice(ctx.config.guildId)) {
    const state = guild.voiceStates.cache.get(segment.userId);
    if (!state) continue;
    const flags: VoiceFlags = {
      inHub: isHubChannel(state.channel, ctx.config),
      selfDeaf: Boolean(state.selfDeaf),
      serverDeaf: Boolean(state.serverDeaf),
      selfMute: Boolean(state.selfMute),
      serverMute: Boolean(state.serverMute),
      afk: Boolean(state.channelId && guild.afkChannelId === state.channelId),
      channelId: state.channelId,
    };
    const stillThere = state.channelId === segment.channelId && isCounting(flags, ctx.config.voice);
    if (!stillThere) ctx.store.closeOpenVoiceSegments(ctx.config.guildId, segment.userId, now, true);
  }
  ctx.store.heartbeatVoice(ctx.config.guildId, now);
}

async function tickGiveaways(client: Client, ctx: BotContext): Promise<void> {
  const due = ctx.store.listNeedsDraw(ctx.config.guildId, Date.now());
  for (const giveaway of due) {
    const result = drawGiveaway(ctx.store, ctx.config, giveaway.id);
    if (!result.ok) continue;
    await publishWinner(client, ctx, giveaway.id, false);
    if (ctx.config.giveaway.autoWeeklyReset) await performWeeklyReset(client, ctx);
  }
  for (const giveaway of ctx.store.listUnannounced(ctx.config.guildId)) {
    await publishWinner(client, ctx, giveaway.id, false);
  }
}
