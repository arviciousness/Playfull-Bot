import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type Role,
  type NewsChannel,
  type TextChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import type { AppConfig, EffectiveShop } from '../config.js';
import { resolveShop } from '../config.js';
import type { Economy } from '../services/economy.js';
import type { Giveaway, Store } from '../store.js';
import { formatBits, matchesAnyName, matchesConfiguredName, parseHexColor, renderTemplate } from '../util.js';

export interface BotContext {
  config: AppConfig;
  store: Store;
  economy: Economy;
}

type StaffInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;

const STRING_ROLE_KEYS = [
  'verified',
  'serverBooster',
  'trendHunter',
  'gameCreator',
  'partyLegend',
  'playmaker',
  'playfullPatron',
  'bronzeTicket',
  'silverTicket',
  'goldTicket',
  'platinumTicket',
  'diamondTicket',
  'giveawayAlerts',
] as const;

export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  const payload = { content: content.slice(0, 2000), ephemeral: true as const };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

export function roleSetting(config: AppConfig, key: string): string | undefined {
  const value = (config.roles as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function findRole(guild: Guild, nameOrId: string): Role | undefined {
  if (/^\d{17,20}$/.test(nameOrId)) {
    return guild.roles.cache.get(nameOrId);
  }
  return guild.roles.cache.find((role) => matchesConfiguredName(role.name, nameOrId));
}

export function memberRoleKeys(member: GuildMember, config: AppConfig): string[] {
  const keys = new Set<string>();
  for (const key of STRING_ROLE_KEYS) {
    const setting = roleSetting(config, key);
    if (!setting) continue;
    const role = findRole(member.guild, setting);
    if (role && member.roles.cache.has(role.id)) keys.add(key);
  }
  if (member.premiumSince) keys.add('serverBooster');
  return [...keys];
}

export function isAdmin(member: GuildMember, config: AppConfig): boolean {
  if (member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return config.roles.admin.some((name) => {
    const role = findRole(member.guild, name);
    return Boolean(role && member.roles.cache.has(role.id));
  });
}

export function isMod(member: GuildMember, config: AppConfig): boolean {
  if (isAdmin(member, config)) return true;
  return config.roles.moderator.some((name) => {
    const role = findRole(member.guild, name);
    return Boolean(role && member.roles.cache.has(role.id));
  });
}

export function channelName(channel: GuildBasedChannel | null): string {
  return channel && 'name' in channel ? channel.name : '';
}

export function inAdminChannel(channel: unknown, config: AppConfig): boolean {
  const ref = channelRef(channel);
  if (!ref || config.channels.adminCommands.length === 0) return false;
  return matchesAnyName(ref.id, ref.name, config.channels.adminCommands);
}

export function inNamedChannel(channel: unknown, configured: string): boolean {
  const ref = channelRef(channel);
  if (!ref || !configured) return false;
  return matchesAnyName(ref.id, ref.name, [configured]);
}

function channelRef(channel: unknown): { id: string; name: string } | null {
  if (!channel || typeof channel !== 'object') return null;
  const id = 'id' in channel && typeof channel.id === 'string' ? channel.id : '';
  const name = 'name' in channel && typeof channel.name === 'string' ? channel.name : '';
  if (!id) return null;
  return { id, name };
}

export async function requireStaff(
  interaction: StaffInteraction,
  config: AppConfig,
  level: 'mod' | 'admin',
): Promise<GuildMember | null> {
  if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased() || interaction.channel.isDMBased()) {
    await replyEphemeral(interaction, 'Use this in the server.');
    return null;
  }
  const member = interaction.member instanceof Object && 'roles' in interaction.member
    ? (interaction.member as GuildMember)
    : await interaction.guild.members.fetch(interaction.user.id);
  const allowed = level === 'admin' ? isAdmin(member, config) : isMod(member, config);
  if (!allowed) {
    await replyEphemeral(interaction, level === 'admin'
      ? 'Only the Discord Management role (or a server admin) can do that.'
      : 'Only moderators can do that.');
    return null;
  }
  const channel = interaction.channel;
  const parent = channel.isThread() ? channel.parent : channel;
  if (!inAdminChannel(parent, config) && !inAdminChannel(channel, config)) {
    const where = config.channels.adminCommands.join(' or ') || 'the admin channel';
    await replyEphemeral(interaction, `Run that in #${where}. Staff commands only work there.`);
    return null;
  }
  return member;
}

export function findTextChannel(guild: Guild, configured: string): TextChannel | NewsChannel | null {
  const match = guild.channels.cache.find((channel) => {
    if (!('name' in channel)) return false;
    return matchesAnyName(channel.id, channel.name, [configured]);
  });
  if (!match || !match.isTextBased() || match.isDMBased() || match.isThread() || match.isVoiceBased()) return null;
  if (match.type === ChannelType.GuildText || match.type === ChannelType.GuildAnnouncement) return match;
  return null;
}

export function currentShop(ctx: BotContext): EffectiveShop {
  return resolveShop(ctx.config, ctx.store.getRuntime(ctx.config.guildId));
}

export function roleLabel(config: AppConfig, key: string): string {
  return roleSetting(config, key) ?? key;
}

export async function grantConfiguredRole(member: GuildMember, roleKey: string, config: AppConfig): Promise<string | null> {
  const setting = roleSetting(config, roleKey);
  if (!setting) return `No role is configured for ${roleKey}.`;
  const role = findRole(member.guild, setting);
  if (!role) return `The role "${setting}" does not exist yet. Create it and make sure the bot's role is above it.`;
  if (member.roles.cache.has(role.id)) return null;
  try {
    await member.roles.add(role, 'Playfull reward');
    return null;
  } catch {
    return `I couldn't assign "${role.name}". Move the bot's role above it and give the bot Manage Roles.`;
  }
}

export async function removeConfiguredRole(member: GuildMember, roleKey: string, config: AppConfig): Promise<void> {
  const setting = roleSetting(config, roleKey);
  if (!setting) return;
  const role = findRole(member.guild, setting);
  if (!role || !member.roles.cache.has(role.id)) return;
  await member.roles.remove(role, 'Playfull ticket replaced or revoked').catch(() => undefined);
}

export async function postAudit(guild: Guild, config: AppConfig, line: string): Promise<void> {
  const channel = findTextChannel(guild, config.channels.auditLog);
  if (!channel) {
    console.error(`[playfull] Audit channel "${config.channels.auditLog}" was not found. ${line}`);
    return;
  }
  await channel.send({ content: line.slice(0, 2000) }).catch((error: unknown) => {
    console.error('[playfull] Could not post to the audit channel.', error);
  });
}

export function auditLine(config: AppConfig, userId: string, deltaCash: number, deltaBank: number, reason: string, account: { cash: number; bank: number }): string {
  const parts: string[] = [];
  if (deltaCash !== 0) parts.push(`${signed(deltaCash)} cash`);
  if (deltaBank !== 0) parts.push(`${signed(deltaBank)} bank`);
  if (parts.length === 0) parts.push('no balance change');
  return `${parts.join(', ')} · ${reason} · <@${userId}> · cash ${account.cash} / bank ${account.bank} ${config.economy.currencyName}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function economyError(config: AppConfig, error: string, account: { cash: number; bank: number } | null): string {
  const name = config.economy.currencyName;
  if (error === 'insufficient') {
    const cash = account?.cash ?? 0;
    const bank = account?.bank ?? 0;
    return `That amount is higher than the balance (cash ${cash}, bank ${bank} ${name}).`;
  }
  if (error === 'bank_disabled') return 'The bank is turned off in the config file.';
  if (error === 'empty') return 'There is nothing to move.';
  if (error === 'cap') return `That would pass the configured ${name} cap.`;
  if (error === 'missing') return 'That member has no balance yet.';
  if (error === 'invalid_amount') return 'Use a whole number of PlayBits greater than 0.';
  return 'That balance change was rejected.';
}

export function shopRejection(
  config: AppConfig,
  error: string,
  tierName: string | undefined,
  required: string[] | undefined,
  cash: number,
  bank: number,
): string {
  const name = config.economy.currencyName;
  if (error === 'disabled') return `${tierName ?? 'That tier'} is turned off. Diamond stays off until you enable it in the config.`;
  if (error === 'missing_role') {
    const roles = (required ?? []).map((key) => roleLabel(config, key)).join(' or ');
    return `${tierName ?? 'That ticket'} requires ${roles}.`;
  }
  if (error === 'limit') return `You already bought ${tierName ?? 'that tier'} this week. The limit is one per tier.`;
  if (error === 'one_tier' || error === 'not_an_upgrade') {
    return 'This preset allows only one ticket tier. Buying a higher tier replaces a lower one. You cannot add or downgrade.';
  }
  if (error === 'insufficient_cash') {
    const bankHint = bank > 0 ? ` You have ${bank} in the bank. Use /withdraw to move it to cash.` : '';
    return `You need more cash. You have ${cash} cash and ${bank} bank ${name}.${bankHint}`;
  }
  return 'That ticket could not be purchased.';
}

export function giveawayEmbed(config: AppConfig, giveaway: Giveaway, entryCount: number): EmbedBuilder {
  const ended = giveaway.status === 'ended' || giveaway.status === 'cancelled';
  const endUnix = Math.floor(giveaway.endsAt / 1000);
  const lines = [
    `**Prize:** ${giveaway.prize}`,
    giveaway.status === 'cancelled'
      ? '**Status:** Cancelled'
      : giveaway.status === 'ended'
        ? `**Winner:** ${giveaway.winnerId ? `<@${giveaway.winnerId}>` : 'No eligible entries'}`
        : `**Ends:** <t:${endUnix}:F> (<t:${endUnix}:R>)`,
    '',
    'Buy a raffle ticket in the shop, then press **Enter**.',
    config.giveaway.stackEntries
      ? 'Entries stack across the ticket tiers you hold.'
      : 'Only your highest ticket tier counts.',
    '',
    `**People entered:** ${entryCount}`,
  ];
  const embed = new EmbedBuilder()
    .setColor(parseHexColor(config.giveaway.embedColor))
    .setTitle('Weekly Giveaway')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Playfull Giveaway' });
  if (config.giveaway.thumbnailUrl) embed.setThumbnail(config.giveaway.thumbnailUrl);
  if (ended) embed.setTimestamp(giveaway.endedAt ?? Date.now());
  return embed;
}

export function enterButton(giveawayId: number, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw:enter:${giveawayId}`)
      .setLabel('Enter')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

export function shopEmbed(config: AppConfig, shop: EffectiveShop): EmbedBuilder {
  const lines = shop.tiers.filter((tier) => tier.enabled).map((tier) => {
    const requirement = tier.requiredRoleKeys.length === 0
      ? 'No role required'
      : `Requires ${tier.requiredRoleKeys.map((key) => roleLabel(config, key)).join(' or ')}`;
    return `**${tier.name}** — ${formatBits(tier.price, config.economy.currencyName)} — ${tier.entries} ${tier.entries === 1 ? 'entry' : 'entries'}\n${requirement}`;
  });
  const limit = shop.oneTierOnly
    ? 'You can hold one tier. A higher tier replaces a lower one.'
    : shop.enforcePurchaseLimit
      ? 'Limit: 1 ticket of each tier this week. Tiers stack.'
      : 'The weekly purchase limit is lifted for this event.';
  return new EmbedBuilder()
    .setColor(parseHexColor(config.giveaway.embedColor))
    .setTitle('PlayBits shop')
    .setDescription(`${lines.join('\n\n')}\n\n${limit}\n\nPreset: \`${shop.presetName}\`.`)
    .setFooter({ text: 'Tickets are spent from cash. Use /withdraw if your PlayBits are in the bank.' });
}

export function shopButtons(shop: EffectiveShop): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = shop.tiers.filter((tier) => tier.enabled).map((tier) =>
    new ButtonBuilder().setCustomId(`shop:buy:${tier.id}`).setLabel(`${tier.name} · ${tier.price}`).setStyle(ButtonStyle.Primary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  }
  return rows;
}

export function howToEmbed(config: AppConfig, shop: EffectiveShop): EmbedBuilder {
  const tiers = shop.tiers.filter((tier) => tier.enabled).map((tier) =>
    `• **${tier.name}** (${tier.entries}x): ${formatBits(tier.price, config.economy.currencyName)}`,
  );
  return new EmbedBuilder()
    .setColor(parseHexColor(config.giveaway.embedColor))
    .setTitle('How to enter weekly giveaways')
    .setDescription([
      '**1. Earn PlayBits**',
      `Chat earns ${config.chat.amount} ${config.economy.currencyName} per message, with a ${config.chat.cooldownSeconds}-second cooldown, in the configured chat channels.`,
      config.chat.requireVerified ? 'You need the verified role for chat to count.' : 'Chat does not require a role.',
      'Activities earn more. Use `/claim` and a moderator will confirm them.',
      '',
      '**2. Check your balance**',
      'Use `/balance`.',
      '',
      '**3. Buy a ticket**',
      ...tiers,
      '',
      '**4. Enter**',
      'Open the giveaway post and press Enter. Your entries match the tickets you hold.',
      '',
      'After the draw, tickets and temporary activity roles expire. PlayBits stay in your account.',
    ].join('\n'));
}

export function activityGuideEmbed(config: AppConfig): EmbedBuilder {
  const lines = Object.values(config.activities).map((activity) => {
    const role = activity.expiresWeekly ? roleLabel(config, activity.roleKey) : `${roleLabel(config, activity.roleKey)} (kept after the weekly reset)`;
    const voice = activity.minVoiceMinutes ? ` At least ${activity.minVoiceMinutes} minutes in the Gaming Hub.` : '';
    return `**${activity.label}** — ${formatBits(activity.reward, config.economy.currencyName)} + ${role}.${voice}`;
  });
  return new EmbedBuilder()
    .setColor(parseHexColor(config.giveaway.embedColor))
    .setTitle('How to earn PlayBits')
    .setDescription(lines.join('\n\n'));
}

export function winnerText(giveaway: Giveaway): string {
  return renderTemplate(giveaway.winnerMessage, {
    winner: giveaway.winnerId ? `<@${giveaway.winnerId}>` : 'nobody',
    prize: giveaway.prize,
    user: giveaway.winnerId ? `<@${giveaway.winnerId}>` : 'nobody',
  });
}

export function memberEconomyAllowed(channel: unknown, config: AppConfig): boolean {
  const ref = channelRef(channel);
  if (!ref) return false;
  if (config.channels.memberEconomy.length === 0) return true;
  return inAdminChannel(channel, config) || matchesAnyName(ref.id, ref.name, config.channels.memberEconomy);
}

export function isEarnChannel(message: Message, config: AppConfig): boolean {
  if (!message.guild || !message.channel.isTextBased() || message.channel.isDMBased()) return false;
  if (message.channel.isThread()) {
    if (!config.chat.includeThreads) return false;
    const parent = message.channel.parent;
    if (!parent || !('name' in parent)) return false;
    return matchesAnyName(parent.id, parent.name, config.channels.chatEarn);
  }
  if (!('name' in message.channel)) return false;
  return matchesAnyName(message.channel.id, message.channel.name, config.channels.chatEarn);
}

export function isHubChannel(channel: VoiceBasedChannel | null, config: AppConfig): boolean {
  if (!channel) return false;
  return matchesAnyName(channel.id, channel.name, config.channels.gamingHubVoice);
}
