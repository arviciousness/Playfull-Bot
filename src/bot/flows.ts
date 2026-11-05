import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import type { AppConfig } from '../config.js';
import { drawGiveaway, rerollGiveaway } from '../services/giveaway.js';
import { applyWeeklyReset } from '../services/reset.js';
import { activeEntryWeight } from '../services/shop.js';
import type { Giveaway } from '../store.js';
import { creditedSeconds, isCounting, type VoiceFlags } from '../services/voice.js';
import { parseHexColor } from '../util.js';
import {
  auditLine,
  enterButton,
  findRole,
  findTextChannel,
  isHubChannel,
  giveawayEmbed,
  grantConfiguredRole,
  postAudit,
  replyEphemeral,
  roleLabel,
  type BotContext,
  winnerText,
} from './kit.js';

export async function publishWinner(client: Client, ctx: BotContext, giveawayId: number, reroll: boolean): Promise<void> {
  const giveaway = ctx.store.getGiveaway(giveawayId);
  if (!giveaway) return;
  const guild = await client.guilds.fetch(ctx.config.guildId).catch(() => null);
  if (!guild) return;

  const source = giveaway.messageId ? await fetchMessage(guild, giveaway.channelId, giveaway.messageId) : null;
  if (source) {
    await source.edit({
      embeds: [giveawayEmbed(ctx.config, giveaway, ctx.store.countEntries(giveaway.id))],
      components: [enterButton(giveaway.id, true)],
    }).catch((error: unknown) => console.error('[playfull] Could not update the giveaway post.', error));
  }

  if (!reroll && giveaway.eventsMessageId) return;

  const events = findTextChannel(guild, ctx.config.channels.events);
  const winner = giveaway.winnerId ? `<@${giveaway.winnerId}>` : 'No eligible entries';
  const description = giveaway.winnerId
    ? `${reroll ? 'Rerolled winner' : 'Winner'}: ${winner}\nPrize: **${giveaway.prize}**\n\n${winnerText(giveaway)}`
    : `The giveaway for **${giveaway.prize}** ended with no eligible entries.`;
  const embed = new EmbedBuilder()
    .setColor(parseHexColor(ctx.config.giveaway.embedColor))
    .setTitle(reroll ? 'Giveaway reroll' : 'Giveaway winner')
    .setDescription(description)
    .setTimestamp(new Date());
  if (events) {
    const sent = await events.send({
      content: giveaway.winnerId ? `<@${giveaway.winnerId}>` : undefined,
      embeds: [embed],
    }).catch((error: unknown) => {
      console.error('[playfull] Could not announce the winner.', error);
      return null;
    });
    if (sent && !reroll) ctx.store.setGiveawayAnnouncement(giveaway.id, sent.id);
  } else {
    console.error(`[playfull] Events channel "${ctx.config.channels.events}" was not found.`);
    if (!reroll) ctx.store.markAnnounced(giveaway.id);
  }

  if (!giveaway.winnerId) return;
  await openWinnerThread(client, ctx, guild, giveaway).catch((error: unknown) => {
    console.error('[playfull] Winner thread failed.', error);
  });

  const weights = ctx.store.listWinners(giveaway.id);
  const latest = weights[weights.length - 1];
  await postAudit(
    guild,
    ctx.config,
    `Giveaway ${reroll ? 'reroll' : 'draw'} · **${giveaway.prize}** · winner <@${giveaway.winnerId}> · weight ${latest?.weight ?? '?'}`,
  );
}

async function openWinnerThread(client: Client, ctx: BotContext, guild: Guild, giveaway: Giveaway): Promise<void> {
  if (!ctx.config.giveaway.privateWinnerThread || !giveaway.winnerId) return;
  const text = winnerText({ ...giveaway });
  const host = giveaway.messageId ? await fetchMessage(guild, giveaway.channelId, giveaway.messageId) : null;
  const parent = host?.channel;
  if (host && parent?.type === ChannelType.GuildText) {
    try {
      const existing = giveaway.threadId ? await guild.channels.fetch(giveaway.threadId).catch(() => null) : null;
      const thread = existing && existing.isThread()
        ? existing
        : await parent.threads.create({
            name: `Winner · ${giveaway.prize}`.slice(0, 100),
            type: ChannelType.PrivateThread,
            invitable: false,
            startMessage: host.id,
            reason: 'Playfull giveaway winner',
          });
      if (!giveaway.threadId) ctx.store.setGiveawayThread(giveaway.id, thread.id);
      await thread.members.add(giveaway.winnerId).catch(() => undefined);
      await thread.members.add(giveaway.createdBy).catch(() => undefined);
      await thread.send({ content: text.slice(0, 2000) });
      return;
    } catch (error) {
      console.error('[playfull] Private thread was not created. Sending a direct message instead.', error);
    }
  }
  const user = await client.users.fetch(giveaway.winnerId).catch(() => null);
  if (user) {
    await user.send({ content: text.slice(0, 2000) }).catch(() => {
      console.error(`[playfull] Could not message the winner ${giveaway.winnerId}.`);
    });
  }
}

export async function refreshGiveawayMessage(guild: Guild, ctx: BotContext, giveaway: Giveaway): Promise<void> {
  if (!giveaway.messageId) return;
  const message = await fetchMessage(guild, giveaway.channelId, giveaway.messageId);
  if (!message) return;
  await message.edit({
    embeds: [giveawayEmbed(ctx.config, giveaway, ctx.store.countEntries(giveaway.id))],
    components: [enterButton(giveaway.id, giveaway.status !== 'active')],
  }).catch(() => undefined);
}

export function makeCaptcha(): { prompt: string; answer: string; choices: string[] } {
  const left = 2 + Math.floor(Math.random() * 8);
  const right = 2 + Math.floor(Math.random() * 8);
  const answer = left + right;
  const choices = new Set<number>([answer]);
  while (choices.size < 4) {
    const offset = 1 + Math.floor(Math.random() * 4);
    const candidate = Math.random() < 0.5 ? answer + offset : answer - offset;
    if (candidate > 0 && candidate !== answer) choices.add(candidate);
  }
  const list = [...choices];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = list[index] ?? answer;
    list[index] = list[swap] ?? current;
    list[swap] = current;
  }
  return { prompt: `Quick check before you enter: what is ${left} + ${right}?`, answer: String(answer), choices: list.map(String) };
}

export function captchaRow(token: string, choices: string[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((choice) => new ButtonBuilder().setCustomId(`gw:cap:${token}:${choice}`).setLabel(choice).setStyle(ButtonStyle.Secondary)),
  );
}

export async function registerEntry(interaction: ButtonInteraction, ctx: BotContext, giveaway: Giveaway): Promise<void> {
  const weight = activeEntryWeight(ctx.store.listTickets(ctx.config.guildId, interaction.user.id), ctx.config.giveaway.stackEntries);
  const inserted = ctx.store.addEntry(giveaway.id, interaction.user.id, Date.now());
  if (interaction.guild) await refreshGiveawayMessage(interaction.guild, ctx, giveaway);
  const already = inserted ? '' : 'You were already on the list. ';
  await replyEphemeral(
    interaction,
    `${already}You're entered for **${giveaway.prize}** with **${weight}** ${weight === 1 ? 'entry' : 'entries'}. If you buy another tier before the draw, that weight is included automatically.`,
  );
}

export async function drawAndPublish(client: Client, ctx: BotContext, giveawayId: number): Promise<string> {
  const result = drawGiveaway(ctx.store, ctx.config, giveawayId);
  if (!result.ok) {
    if (result.giveaway?.status === 'ended') return result.giveaway.winnerId
      ? `That giveaway already ended. Winner: <@${result.giveaway.winnerId}>.`
      : 'That giveaway already ended with no eligible entries.';
    return 'There is no active giveaway to draw.';
  }
  await publishWinner(client, ctx, giveawayId, false);
  if (ctx.config.giveaway.autoWeeklyReset) await performWeeklyReset(client, ctx);
  if (!result.winnerId) return `**${result.giveaway.prize}** ended with no eligible entries.`;
  const weight = result.weights.find((entry) => entry.userId === result.winnerId)?.weight ?? 0;
  return `Winner: <@${result.winnerId}> for **${result.giveaway.prize}** (${weight} entries).`;
}

export async function rerollAndPublish(client: Client, ctx: BotContext): Promise<string> {
  const active = ctx.store.getActiveGiveaway(ctx.config.guildId);
  if (active) return 'End the current giveaway before rerolling.';
  const latest = latestEnded(ctx);
  if (!latest) return 'There is no ended giveaway to reroll.';
  const result = rerollGiveaway(ctx.store, ctx.config, latest.id);
  if (!result.ok) {
    if (result.error === 'no_eligible') return 'Nobody else with a ticket is left to draw.';
    return 'That giveaway cannot be rerolled.';
  }
  await publishWinner(client, ctx, latest.id, true);
  return `New winner: <@${result.winnerId}> (${result.weight} entries).`;
}

export function latestEnded(ctx: BotContext): Giveaway | null {
  const row = ctx.store.db
    .prepare(`SELECT id FROM giveaways WHERE guild_id = ? AND status = 'ended' ORDER BY id DESC LIMIT 1`)
    .get(ctx.config.guildId) as { id: number } | undefined;
  return row ? ctx.store.getGiveaway(row.id) : null;
}

export async function performWeeklyReset(client: Client, ctx: BotContext): Promise<string> {
  const guild = await client.guilds.fetch(ctx.config.guildId);
  const before = ctx.store.sumBalances(ctx.config.guildId);
  const applied = applyWeeklyReset(ctx.store, ctx.config, ctx.config.guildId);
  const removed = await stripRoles(guild, applied.plan.roleKeysToStrip, ctx.config);
  const after = ctx.store.sumBalances(ctx.config.guildId);
  const roleSummary = removed.map((item) => item.missing ? `${item.label}: role not found` : `${item.label}: removed from ${item.removed}`).join('\n');
  const summary = [
    `Week ${applied.plan.nextWeekId} has started.`,
    `Expired tickets: ${applied.expiredTickets}.`,
    `Closed unanswered claims: ${applied.expiredClaims}.`,
    roleSummary || 'No temporary roles were configured.',
    `PlayBits in circulation: ${before.total} before, ${after.total} after. Balances were not reset.`,
  ].join('\n');
  await resumeHubVoice(guild, ctx);
  await postAudit(guild, ctx.config, `Weekly reset · ${summary.replaceAll('\n', ' · ')}`.slice(0, 1900));
  return summary;
}

async function resumeHubVoice(guild: Guild, ctx: BotContext): Promise<void> {
  const now = Date.now();
  const weekId = ctx.store.getWeek(ctx.config.guildId).weekId;
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
      ctx.store.openVoiceSegment({ guildId: guild.id, userId, channelId: channel.id, weekId, startedAt: now });
    }
  }
}

async function stripRoles(guild: Guild, roleKeys: string[], config: AppConfig): Promise<{ label: string; removed: number; missing: boolean }[]> {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[playfull] Could not fetch members. Enable the Server Members Intent.', error);
  }
  const results: { label: string; removed: number; missing: boolean }[] = [];
  for (const key of roleKeys) {
    const setting = roleLabel(config, key);
    const role = findRole(guild, setting);
    if (!role) {
      results.push({ label: setting, removed: 0, missing: true });
      continue;
    }
    let removed = 0;
    const members = [...role.members.values()];
    for (const member of members) {
      try {
        await member.roles.remove(role, 'Playfull weekly reset');
        removed += 1;
      } catch (error) {
        console.error(`[playfull] Could not remove ${role.name} from ${member.id}.`, error);
      }
    }
    results.push({ label: role.name, removed, missing: false });
  }
  return results;
}

export async function rememberEconomy(
  guild: Guild,
  ctx: BotContext,
  userId: string,
  created: boolean,
  deltaCash: number,
  deltaBank: number,
  reason: string,
  account: { cash: number; bank: number },
  options?: { includeChange?: boolean },
): Promise<void> {
  if (created && ctx.config.economy.startingBalance > 0) {
    const startingCash = ctx.config.economy.startingBucket === 'cash' ? ctx.config.economy.startingBalance : 0;
    const startingBank = ctx.config.economy.startingBucket === 'bank' ? ctx.config.economy.startingBalance : 0;
    await postAudit(
      guild,
      ctx.config,
      auditLine(ctx.config, userId, startingCash, startingBank, 'starting-balance', {
        cash: account.cash - deltaCash,
        bank: account.bank - deltaBank,
      }),
    );
  }
  if (options?.includeChange === false) return;
  if (deltaCash === 0 && deltaBank === 0) return;
  await postAudit(guild, ctx.config, auditLine(ctx.config, userId, deltaCash, deltaBank, reason, account));
}

export function voiceSeconds(ctx: BotContext, userId: string, now = Date.now()): number {
  const week = ctx.store.getWeek(ctx.config.guildId);
  return ctx.store
    .listVoiceSegments(ctx.config.guildId, week.weekId)
    .filter((segment) => segment.userId === userId)
    .reduce((total, segment) => total + creditedSeconds(segment, now), 0);
}

export function hubRequirementMinutes(config: AppConfig): number {
  return config.activities.gaminghub?.minVoiceMinutes ?? config.voice.qualifyMinutes;
}

export async function fetchMessage(guild: Guild, channelId: string, messageId: string) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

export function claimEmbed(ctx: BotContext, input: {
  userId: string;
  activityKey: string;
  note: string;
  status: string;
  reviewerId?: string | null;
  reviewNote?: string | null;
}): EmbedBuilder {
  const activity = ctx.config.activities[input.activityKey];
  const lines = [
    `**Member:** <@${input.userId}>`,
    `**Activity:** ${activity?.label ?? input.activityKey}`,
    `**Reward:** ${activity?.reward ?? 0} ${ctx.config.economy.currencyName} + ${activity ? roleLabel(ctx.config, activity.roleKey) : 'role'}`,
    `**Note:** ${input.note || 'none'}`,
    `**Status:** ${input.status}`,
  ];
  if (input.activityKey === 'gaminghub') {
    const seconds = voiceSeconds(ctx, input.userId);
    const minutes = Math.floor(seconds / 60);
    const needed = hubRequirementMinutes(ctx.config);
    lines.push(`**Tracked Gaming Hub time this week:** ${minutes} min (needs ${needed})`);
  }
  if (input.reviewerId) lines.push(`**Reviewer:** <@${input.reviewerId}>`);
  if (input.reviewNote) lines.push(`**Review note:** ${input.reviewNote}`);
  return new EmbedBuilder().setColor(0x007fff).setTitle('Activity claim').setDescription(lines.join('\n')).setTimestamp(new Date());
}

export function claimButtons(claimId: number, activityKey: string): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`claim:approve:${claimId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`claim:deny:${claimId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  if (activityKey === 'gaminghub') {
    row.addComponents(new ButtonBuilder().setCustomId(`claim:override:${claimId}`).setLabel('Approve anyway').setStyle(ButtonStyle.Secondary));
  }
  return row;
}

export async function finishApprovedClaim(
  guild: Guild,
  ctx: BotContext,
  member: GuildMember,
  activityKey: string,
  reward: number,
  roleKey: string,
  created: boolean,
): Promise<string> {
  const roleError = await grantConfiguredRole(member, roleKey, ctx.config);
  const account = ctx.economy.get(ctx.config.guildId, member.id);
  if (account) {
    await rememberEconomy(guild, ctx, member.id, created, reward, 0, `activity:${activityKey}`, account);
  }
  return roleError
    ? `PlayBits were added, but the role was not. ${roleError}`
    : `Added ${reward} ${ctx.config.economy.currencyName} and the role.`;
}

export function newCaptchaToken(): string {
  return randomBytes(8).toString('hex');
}

export async function sendCaptcha(interaction: ButtonInteraction, ctx: BotContext, giveawayId: number, attempts: number): Promise<void> {
  const captcha = makeCaptcha();
  const token = newCaptchaToken();
  ctx.store.saveCaptcha(token, giveawayId, interaction.user.id, captcha.answer, attempts, Date.now() + 2 * 60 * 1000);
  const payload = { content: captcha.prompt, components: [captchaRow(token, captcha.choices)], ephemeral: true as const };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

export function shopChannel(guild: Guild, config: AppConfig): TextChannel | NewsChannel | null {
  return findTextChannel(guild, config.channels.shop);
}

export function giveawayChannel(guild: Guild, config: AppConfig): TextChannel | NewsChannel | null {
  return findTextChannel(guild, config.channels.giveaways);
}

export function adminChannel(guild: Guild, config: AppConfig): TextChannel | NewsChannel | null {
  const first = config.channels.adminCommands[0];
  return first ? findTextChannel(guild, first) : null;
}
