import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { grantActivityReward } from '../services/activities.js';
import { parseBalanceImport } from '../services/importBalances.js';
import { purchaseTicket, revokeTicket, activeEntryWeight } from '../services/shop.js';
import { creditedSeconds, qualifiesForVoice } from '../services/voice.js';
import { clampText, formatBits } from '../util.js';
import {
  adminChannel,
  claimButtons,
  claimEmbed,
  drawAndPublish,
  finishApprovedClaim,
  giveawayChannel,
  hubRequirementMinutes,
  performWeeklyReset,
  registerEntry,
  rememberEconomy,
  rerollAndPublish,
  sendCaptcha,
  shopChannel,
  voiceSeconds,
} from './flows.js';
import {
  activityGuideEmbed,
  currentShop,
  economyError,
  enterButton,
  findRole,
  giveawayEmbed,
  grantConfiguredRole,
  howToEmbed,
  inAdminChannel,
  inNamedChannel,
  memberEconomyAllowed,
  memberRoleKeys,
  postAudit,
  removeConfiguredRole,
  replyEphemeral,
  requireStaff,
  shopButtons,
  shopEmbed,
  shopRejection,
  type BotContext,
} from './kit.js';

export async function handleInteraction(client: Client, ctx: BotContext, interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(client, ctx, interaction);
    else if (interaction.isButton()) await handleButton(ctx, interaction);
    else if (interaction.isModalSubmit()) await handleModal(ctx, interaction);
  } catch (error) {
    console.error('[playfull] Command failed.', error);
    if (interaction.isRepliable()) {
      await replyEphemeral(interaction, 'Something went wrong running that. The details are in the bot log.').catch(() => undefined);
    }
  }
}

async function handleCommand(client: Client, ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || interaction.guild.id !== ctx.config.guildId) {
    await replyEphemeral(interaction, 'This bot is set up for a different server.');
    return;
  }
  switch (interaction.commandName) {
    case 'balance':
      return showBalance(ctx, interaction);
    case 'leaderboard':
      return showLeaderboard(ctx, interaction);
    case 'deposit':
      return moveMoney(ctx, interaction, 'deposit');
    case 'withdraw':
      return moveMoney(ctx, interaction, 'withdraw');
    case 'shop':
      return showShop(ctx, interaction);
    case 'buy':
      return buy(ctx, interaction, interaction.options.getString('tier', true));
    case 'tickets':
      return showTickets(ctx, interaction);
    case 'claim':
      return submitClaim(ctx, interaction);
    case 'voice-time':
      return showVoiceTime(ctx, interaction);
    case 'help':
      return replyEphemeral(interaction, helpText(ctx));
    case 'add-money':
      return addMoney(ctx, interaction);
    case 'remove-money':
      return removeMoney(ctx, interaction);
    case 'history':
      return showHistory(ctx, interaction);
    case 'award':
      return award(ctx, interaction);
    case 'voice-report':
      return voiceReport(ctx, interaction);
    case 'giveaway-create':
      return createGiveaway(ctx, interaction);
    case 'giveaway-end':
      return endGiveaway(client, ctx, interaction);
    case 'giveaway-reroll':
      return reroll(client, ctx, interaction);
    case 'giveaway-cancel':
      return cancelGiveaway(ctx, interaction);
    case 'weekly-reset':
      return weeklyReset(client, ctx, interaction);
    case 'set-preset':
      return setPreset(ctx, interaction);
    case 'purchase-limit':
      return setPurchaseLimit(ctx, interaction);
    case 'import-balances':
      return importBalances(ctx, interaction);
    case 'revoke-ticket':
      return revoke(ctx, interaction);
    case 'post-shop':
      return postShop(ctx, interaction);
    case 'post-guide':
      return postGuide(ctx, interaction);
    case 'status':
      return showStatus(ctx, interaction);
    default:
      await replyEphemeral(interaction, 'Unknown command.');
  }
}

async function handleButton(ctx: BotContext, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || interaction.guild.id !== ctx.config.guildId) {
    await replyEphemeral(interaction, 'This bot is set up for a different server.');
    return;
  }
  const [scope, action, first, second] = interaction.customId.split(':');
  if (scope === 'shop' && action === 'buy' && first) return buy(ctx, interaction, first);
  if (scope === 'gw' && action === 'enter' && first) return enterGiveaway(ctx, interaction, Number(first));
  if (scope === 'gw' && action === 'cap' && first && second) return answerCaptcha(ctx, interaction, first, second);
  if (scope === 'claim' && first) return reviewClaim(ctx, interaction, action ?? '', Number(first));
  await replyEphemeral(interaction, 'That button is no longer used.');
}

async function handleModal(ctx: BotContext, interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild || interaction.guild.id !== ctx.config.guildId) return;
  const [scope, action, idText] = interaction.customId.split(':');
  if (scope !== 'claim' || action !== 'deny-modal' || !idText) return;
  const member = await requireButtonStaff(ctx, interaction);
  if (!member) return;
  const claim = ctx.store.getClaim(Number(idText));
  if (!claim || claim.status !== 'pending') {
    await replyEphemeral(interaction, 'That claim was already reviewed.');
    return;
  }
  if (ctx.config.moderation.preventSelfReward && claim.userId === interaction.user.id) {
    await replyEphemeral(interaction, 'You cannot review your own claim.');
    return;
  }
  const reason = clampText(interaction.fields.getTextInputValue('reason'), 300);
  ctx.store.resolveClaim(claim.id, 'denied', interaction.user.id, reason);
  if (interaction.guild) await editClaimMessage(interaction.guild, ctx, claim.id, 'denied', interaction.user.id, reason);
  await replyEphemeral(interaction, `Denied <@${claim.userId}>'s claim. ${reason}`);
}

async function showBalance(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('member') ?? interaction.user;
  if (target.id !== interaction.user.id) {
    const staff = await requireStaffCommand(ctx, interaction, 'mod');
    if (!staff) return;
  } else if (!memberEconomyAllowed(interaction.channel, ctx.config)) {
    await replyEphemeral(interaction, 'Check your balance in the bot commands channel.');
    return;
  }
  const account = target.id === interaction.user.id
    ? ctx.economy.ensure(ctx.config.guildId, target.id)
    : ctx.economy.get(ctx.config.guildId, target.id);
  if (!account) {
    await replyEphemeral(interaction, `<@${target.id}> has no PlayBits yet.`);
    return;
  }
  const name = ctx.config.economy.currencyName;
  const bank = ctx.config.economy.useBank ? `\nBank: **${account.bank}** ${name}` : '';
  await replyEphemeral(
    interaction,
    `<@${target.id}>\nCash: **${account.cash}** ${name}${bank}\nTotal: **${account.cash + account.bank}** ${name}`,
  );
}

async function showLeaderboard(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!memberEconomyAllowed(interaction.channel, ctx.config)) {
    await replyEphemeral(interaction, 'Use the leaderboard in the bot commands channel.');
    return;
  }
  const page = interaction.options.getInteger('page') ?? 1;
  const pageSize = 10;
  const board = ctx.economy.leaderboard(ctx.config.guildId, pageSize, (page - 1) * pageSize);
  if (board.rows.length === 0) {
    await replyEphemeral(interaction, 'Nobody has a PlayBits balance yet.');
    return;
  }
  const lines = board.rows.map((row, index) => {
    const rank = (page - 1) * pageSize + index + 1;
    return `**${rank}.** <@${row.userId}> — ${row.total} (cash ${row.cash} / bank ${row.bank})`;
  });
  await replyEphemeral(interaction, [`PlayBits leaderboard, page ${page}`, ...lines].join('\n'));
}

async function moveMoney(ctx: BotContext, interaction: ChatInputCommandInteraction, direction: 'deposit' | 'withdraw'): Promise<void> {
  if (!memberEconomyAllowed(interaction.channel, ctx.config)) {
    await replyEphemeral(interaction, 'Use that in the bot commands channel.');
    return;
  }
  const amount = interaction.options.getInteger('amount');
  const all = interaction.options.getBoolean('all') ?? false;
  if (all && amount !== null) {
    await replyEphemeral(interaction, 'Choose an amount or all, not both.');
    return;
  }
  if (!all && amount === null) {
    await replyEphemeral(interaction, 'Provide an amount, or set all to true.');
    return;
  }
  const moving = all ? 'all' : amount ?? 0;
  const result = direction === 'deposit'
    ? ctx.economy.deposit(ctx.config.guildId, interaction.user.id, moving)
    : ctx.economy.withdraw(ctx.config.guildId, interaction.user.id, moving);
  if (!result.ok) {
    await replyEphemeral(interaction, economyError(ctx.config, result.error, result.account));
    return;
  }
  const ledger = ctx.store.recentLedger(ctx.config.guildId, interaction.user.id, 1)[0];
  const movedAmount = ledger ? Math.abs(ledger.deltaCash) : 0;
  if (interaction.guild && ledger) {
    await rememberEconomy(interaction.guild, ctx, interaction.user.id, false, ledger.deltaCash, ledger.deltaBank, direction, result.account);
  }
  await replyEphemeral(
    interaction,
    `${direction === 'deposit' ? 'Deposited' : 'Withdrew'} **${movedAmount}** ${ctx.config.economy.currencyName}.\nCash **${result.account.cash}** · Bank **${result.account.bank}**`,
  );
}

async function showShop(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await ensureShopPlace(ctx, interaction))) return;
  const shop = currentShop(ctx);
  await interaction.reply({ embeds: [shopEmbed(ctx.config, shop)], components: shopButtons(shop), ephemeral: true });
}

async function buy(ctx: BotContext, interaction: ChatInputCommandInteraction | ButtonInteraction, tierId: string): Promise<void> {
  if (!interaction.guild) return;
  if (!(await ensureShopPlace(ctx, interaction))) return;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const shop = currentShop(ctx);
  const outcome = purchaseTicket(ctx.store, {
    guildId: ctx.config.guildId,
    userId: interaction.user.id,
    tierId,
    shop,
    memberRoleKeys: memberRoleKeys(member, ctx.config),
    startingCash: ctx.config.economy.startingBucket === 'cash' ? ctx.config.economy.startingBalance : 0,
    startingBank: ctx.config.economy.startingBucket === 'bank' ? ctx.config.economy.startingBalance : 0,
    maxCash: ctx.config.economy.maxCash,
    maxBank: ctx.config.economy.maxBank,
  });
  if (!outcome.ok) {
    await replyEphemeral(interaction, shopRejection(ctx.config, outcome.error, outcome.tier?.name, outcome.requiredRoleKeys, outcome.cash, outcome.bank));
    return;
  }
  const roleError = await grantConfiguredRoleSafe(member, outcome.tier.roleKey, ctx);
  for (const removedId of outcome.removeTierIds) {
    const removed = shop.tiers.find((tier) => tier.id === removedId);
    if (removed) await removeConfiguredRole(member, removed.roleKey, ctx.config);
  }
  const account = ctx.economy.get(ctx.config.guildId, interaction.user.id);
  if (account) {
    await rememberEconomy(
      interaction.guild,
      ctx,
      interaction.user.id,
      Boolean(outcome.created),
      -outcome.netCost,
      0,
      `shop:${outcome.tier.id}`,
      account,
    );
  }
  const replaced = outcome.removeTierIds.length > 0 ? ` Replaced ${outcome.removeTierIds.join(', ')}.` : '';
  await replyEphemeral(
    interaction,
    `You bought **${outcome.tier.name}** for ${formatBits(outcome.price, ctx.config.economy.currencyName)} (${outcome.tier.entries} entries).${replaced}${roleError ? `\n${roleError}` : ''}`,
  );
}

async function showTickets(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const tickets = ctx.store.listTickets(ctx.config.guildId, interaction.user.id).filter((ticket) => ticket.status === 'active');
  const weight = activeEntryWeight(ctx.store.listTickets(ctx.config.guildId, interaction.user.id), ctx.config.giveaway.stackEntries);
  if (tickets.length === 0) {
    await replyEphemeral(interaction, 'You do not hold a raffle ticket right now.');
    return;
  }
  const lines = tickets.map((ticket) => `• ${ticket.tierId} — ${ticket.entries} entries`);
  await replyEphemeral(interaction, `${lines.join('\n')}\n\nGiveaway weight if you enter: **${weight}**.`);
}

async function submitClaim(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) return;
  const activityKey = interaction.options.getString('activity', true);
  const activity = ctx.config.activities[activityKey];
  if (!activity) {
    await replyEphemeral(interaction, 'That activity is not configured.');
    return;
  }
  const note = clampText(interaction.options.getString('note', true), 500);
  const week = ctx.store.getWeek(ctx.config.guildId);
  const created = ctx.store.createClaim({
    guildId: ctx.config.guildId,
    userId: interaction.user.id,
    activityKey,
    weekId: week.weekId,
    status: 'pending',
    note,
    createdAt: Date.now(),
  });
  if (!created.ok) {
    await replyEphemeral(interaction, `You already have a ${created.status} ${activity.label} claim this week.`);
    return;
  }
  const channel = adminChannel(interaction.guild, ctx.config) ?? (inAdminChannel(interaction.channel, ctx.config) ? interaction.channel : null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await replyEphemeral(interaction, `Claim saved, but I could not find #${ctx.config.channels.adminCommands[0] ?? 'admin-cmds'} to show the buttons.`);
    return;
  }
  const message = await channel.send({
    embeds: [claimEmbed(ctx, { userId: interaction.user.id, activityKey, note, status: 'pending' })],
    components: [claimButtons(created.id, activityKey)],
  });
  ctx.store.setClaimMessage(created.id, channel.id, message.id);
  await replyEphemeral(interaction, `Submitted your **${activity.label}** claim. A moderator will approve or deny it.`);
}

async function showVoiceTime(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('member') ?? interaction.user;
  if (target.id !== interaction.user.id) {
    const staff = await requireStaffCommand(ctx, interaction, 'mod');
    if (!staff) return;
  }
  const seconds = voiceSeconds(ctx, target.id);
  const needed = hubRequirementMinutes(ctx.config);
  const minutes = Math.floor(seconds / 60);
  const ready = qualifiesForVoice(seconds, needed) ? 'This meets the Gaming Hub reward.' : `Needs ${needed} minutes.`;
  await replyEphemeral(interaction, `<@${target.id}> has **${minutes}** minutes in the Gaming Hub this week. ${ready}`);
}

async function addMoney(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const user = interaction.options.getUser('member', true);
  const amount = interaction.options.getInteger('amount', true);
  const reason = clampText(interaction.options.getString('reason') ?? 'manual add', 200);
  if (ctx.config.moderation.preventSelfReward && user.id === interaction.user.id) {
    await replyEphemeral(interaction, 'You cannot add PlayBits to yourself.');
    return;
  }
  const result = ctx.economy.add(ctx.config.guildId, user.id, amount, `manual:${reason}`, interaction.user.id);
  if (!result.ok) {
    await replyEphemeral(interaction, economyError(ctx.config, result.error, result.account));
    return;
  }
  await rememberEconomy(interaction.guild, ctx, user.id, result.created, amount, 0, `manual:${reason}`, result.account);
  await replyEphemeral(interaction, `Added **${amount}** to <@${user.id}>. Cash is now **${result.account.cash}**.`);
}

async function removeMoney(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const user = interaction.options.getUser('member', true);
  const amount = interaction.options.getInteger('amount', true);
  const bucket = interaction.options.getString('bucket') === 'bank' ? 'bank' : 'cash';
  const reason = clampText(interaction.options.getString('reason') ?? 'manual remove', 200);
  const result = ctx.economy.remove(ctx.config.guildId, user.id, amount, bucket, `manual:${reason}`, interaction.user.id);
  if (!result.ok) {
    await replyEphemeral(interaction, economyError(ctx.config, result.error, result.account));
    return;
  }
  await rememberEconomy(
    interaction.guild,
    ctx,
    user.id,
    false,
    bucket === 'cash' ? -amount : 0,
    bucket === 'bank' ? -amount : 0,
    `manual:${reason}`,
    result.account,
  );
  await replyEphemeral(interaction, `Removed **${amount}** ${bucket} from <@${user.id}>. Cash **${result.account.cash}** · Bank **${result.account.bank}**.`);
}

async function showHistory(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff) return;
  const user = interaction.options.getUser('member', true);
  const rows = ctx.store.recentLedger(ctx.config.guildId, user.id, 10);
  if (rows.length === 0) {
    await replyEphemeral(interaction, `<@${user.id}> has no PlayBits history.`);
    return;
  }
  const lines = rows.map((row) => {
    const when = `<t:${Math.floor(row.createdAt / 1000)}:R>`;
    return `${when} ${signed(row.deltaCash)} cash, ${signed(row.deltaBank)} bank · ${row.reason} · cash ${row.cashAfter} / bank ${row.bankAfter}`;
  });
  await replyEphemeral(interaction, [`History for <@${user.id}>`, ...lines].join('\n').slice(0, 2000));
}

async function award(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const user = interaction.options.getUser('member', true);
  const activityKey = interaction.options.getString('activity', true);
  const note = clampText(interaction.options.getString('note') ?? 'awarded by moderator', 300);
  const force = interaction.options.getBoolean('force') ?? false;
  if (activityKey === 'gaminghub' && !force) {
    const seconds = voiceSeconds(ctx, user.id);
    const needed = hubRequirementMinutes(ctx.config);
    if (!qualifiesForVoice(seconds, needed)) {
      await replyEphemeral(interaction, `<@${user.id}> has ${Math.floor(seconds / 60)} minutes in the Gaming Hub. The reward needs ${needed}. Use force if you verified the time another way.`);
      return;
    }
  }
  const result = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.config.guildId,
    userId: user.id,
    activityKey,
    actorId: interaction.user.id,
    note,
    preventSelf: ctx.config.moderation.preventSelfReward,
  });
  if (!result.ok) {
    await replyEphemeral(interaction, grantError(result.error, result.label));
    return;
  }
  const member = await interaction.guild.members.fetch(user.id);
  const follow = await finishApprovedClaim(interaction.guild, ctx, member, activityKey, result.reward, result.roleKey, result.created);
  await replyEphemeral(interaction, `<@${user.id}> · ${result.label}. ${follow}`);
}

async function voiceReport(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff) return;
  const week = ctx.store.getWeek(ctx.config.guildId);
  const now = Date.now();
  const totals = new Map<string, number>();
  for (const segment of ctx.store.listVoiceSegments(ctx.config.guildId, week.weekId)) {
    totals.set(segment.userId, (totals.get(segment.userId) ?? 0) + creditedSeconds(segment, now));
  }
  const needed = hubRequirementMinutes(ctx.config);
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (rows.length === 0) {
    await replyEphemeral(interaction, 'Nobody has tracked Gaming Hub time this week.');
    return;
  }
  const lines = rows.map(([userId, seconds]) => {
    const mark = qualifiesForVoice(seconds, needed) ? 'ready' : 'under';
    return `• <@${userId}> — ${Math.floor(seconds / 60)} min (${mark})`;
  });
  await replyEphemeral(interaction, [`Gaming Hub this week (need ${needed} min)`, ...lines].join('\n'));
}

async function createGiveaway(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff || !interaction.guild) return;
  if (ctx.store.getActiveGiveaway(ctx.config.guildId)) {
    await replyEphemeral(interaction, 'There is already an active giveaway. End or cancel it first.');
    return;
  }
  const channel = giveawayChannel(interaction.guild, ctx.config);
  if (!channel) {
    await replyEphemeral(interaction, `I cannot find the giveaways channel "${ctx.config.channels.giveaways}".`);
    return;
  }
  const prize = clampText(interaction.options.getString('prize', true), 200);
  const hours = interaction.options.getInteger('duration_hours') ?? ctx.config.giveaway.defaultDurationHours;
  const winnerMessage = clampText(interaction.options.getString('winner_message') ?? ctx.config.giveaway.defaultWinnerMessage, 1500);
  const endsAt = Date.now() + hours * 60 * 60 * 1000;
  const id = ctx.store.createGiveaway({
    guildId: ctx.config.guildId,
    prize,
    winnerMessage,
    channelId: channel.id,
    endsAt,
    createdBy: interaction.user.id,
  });
  const giveaway = ctx.store.getGiveaway(id);
  if (!giveaway) {
    await replyEphemeral(interaction, 'The giveaway could not be saved.');
    return;
  }
  try {
    const message = await channel.send({ embeds: [giveawayEmbed(ctx.config, giveaway, 0)], components: [enterButton(id)] });
    ctx.store.setGiveawayMessage(id, message.id);
  } catch (error) {
    console.error('[playfull] Could not post the giveaway.', error);
    ctx.store.cancelGiveaway(id, Date.now());
    await replyEphemeral(interaction, 'I could not post in the giveaways channel. Check that I can send messages, embeds, and buttons there.');
    return;
  }
  await replyEphemeral(interaction, `Giveaway posted for **${prize}**. It ends <t:${Math.floor(endsAt / 1000)}:R>.`);
}

async function endGiveaway(client: Client, ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff) return;
  const active = ctx.store.getActiveGiveaway(ctx.config.guildId);
  if (!active) {
    await replyEphemeral(interaction, 'There is no active giveaway.');
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const summary = await drawAndPublish(client, ctx, active.id);
  await interaction.editReply(summary);
}

async function reroll(client: Client, ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff) return;
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(await rerollAndPublish(client, ctx));
}

async function cancelGiveaway(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff || !interaction.guild) return;
  const active = ctx.store.getActiveGiveaway(ctx.config.guildId);
  if (!active || active.status !== 'active') {
    await replyEphemeral(interaction, 'There is no active giveaway to cancel.');
    return;
  }
  ctx.store.cancelGiveaway(active.id, Date.now());
  const cancelled = ctx.store.getGiveaway(active.id);
  if (cancelled?.messageId) {
    const channel = await interaction.guild.channels.fetch(cancelled.channelId).catch(() => null);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      const message = await channel.messages.fetch(cancelled.messageId).catch(() => null);
      if (message) {
        await message.edit({ embeds: [giveawayEmbed(ctx.config, cancelled, ctx.store.countEntries(cancelled.id))], components: [enterButton(cancelled.id, true)] }).catch(() => undefined);
      }
    }
  }
  await replyEphemeral(interaction, `Cancelled **${active.prize}**. No winner was drawn. Tickets were not expired.`);
}

async function weeklyReset(client: Client, ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff) return;
  if (!interaction.options.getBoolean('confirm', true)) {
    await replyEphemeral(interaction, 'Set confirm to true. This expires tickets and temporary roles. It does not change PlayBits.');
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(await performWeeklyReset(client, ctx));
}

async function setPreset(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff) return;
  const preset = interaction.options.getString('preset', true);
  if (!ctx.config.shop.presets[preset]) {
    await replyEphemeral(interaction, 'That preset is not in the config file.');
    return;
  }
  ctx.store.setPreset(ctx.config.guildId, preset);
  const shop = currentShop(ctx);
  const prices = shop.tiers.filter((tier) => tier.enabled).map((tier) => `${tier.name} ${tier.price}`).join(', ');
  await replyEphemeral(interaction, `Shop preset is now **${preset}**. ${prices}. One tier only: ${shop.oneTierOnly ? 'yes' : 'no'}. Purchase limit: ${shop.enforcePurchaseLimit ? 'on' : 'off'}.`);
}

async function setPurchaseLimit(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff) return;
  const enabled = interaction.options.getBoolean('enabled', true);
  ctx.store.setPurchaseLimit(ctx.config.guildId, enabled);
  await replyEphemeral(interaction, enabled
    ? 'Members can buy one ticket of each tier per week.'
    : 'The weekly per-tier purchase limit is lifted.');
}

async function importBalances(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'admin');
  if (!staff || !interaction.guild) return;
  const attachment = interaction.options.getAttachment('file', true);
  const mode = interaction.options.getString('mode', true) === 'add' ? 'add' : 'set';
  const apply = interaction.options.getBoolean('apply', true);
  if (attachment.size > 2_000_000) {
    await replyEphemeral(interaction, 'That file is larger than 2 MB. Split it and import again.');
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const response = await fetch(attachment.url);
  if (!response.ok) {
    await interaction.editReply('I could not download that file from Discord.');
    return;
  }
  const parsed = parseBalanceImport(await response.text());
  const seen = new Map<string, number>();
  for (const row of parsed.rows) {
    const previous = seen.get(row.userId);
    if (previous) parsed.errors.push(`User ${row.userId} is on lines ${previous} and ${row.line}.`);
    seen.set(row.userId, row.line);
  }
  if (parsed.errors.length > 0) {
    await interaction.editReply(`Nothing was written.\n${parsed.errors.slice(0, 12).join('\n')}`.slice(0, 2000));
    return;
  }
  const preview = parsed.rows.slice(0, 8).map((row) => {
    const current = ctx.store.getAccount(ctx.config.guildId, row.userId) ?? { cash: 0, bank: 0 };
    const cash = mode === 'set' ? row.cash : current.cash + row.cash;
    const bank = mode === 'set' ? row.bank : current.bank + row.bank;
    return `<@${row.userId}> cash ${current.cash} → ${cash}, bank ${current.bank} → ${bank}`;
  });
  if (!apply) {
    await interaction.editReply([`Dry run (${mode}), ${parsed.rows.length} rows. Nothing was written.`, ...preview].join('\n').slice(0, 2000));
    return;
  }
  const lines: string[] = [];
  let changed = 0;
  for (const row of parsed.rows) {
    const current = ctx.store.getAccount(ctx.config.guildId, row.userId) ?? { cash: 0, bank: 0 };
    const cash = mode === 'set' ? row.cash : current.cash + row.cash;
    const bank = mode === 'set' ? row.bank : current.bank + row.bank;
    if (ctx.store.getAccount(ctx.config.guildId, row.userId) && cash === current.cash && bank === current.bank) continue;
    ctx.store.setAccountBalance(ctx.config.guildId, row.userId, cash, bank, `import:${mode}`, interaction.user.id);
    lines.push(`import ${mode} · <@${row.userId}> · cash ${current.cash} → ${cash}, bank ${current.bank} → ${bank}`);
    changed += 1;
  }
  let batch = '';
  for (const line of lines) {
    if ((batch + '\n' + line).length > 1800) {
      await postAuditSafe(interaction, ctx, batch);
      batch = line;
    } else batch = batch ? `${batch}\n${line}` : line;
  }
  if (batch) await postAuditSafe(interaction, ctx, batch);
  await interaction.editReply(`Imported ${changed} of ${parsed.rows.length} rows using **${mode}**. Balances now match the file and were not given an extra starting 5.`);
}

async function revoke(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const user = interaction.options.getUser('member', true);
  const tierId = interaction.options.getString('tier', true);
  const refund = interaction.options.getBoolean('refund') ?? false;
  const result = revokeTicket(ctx.store, {
    guildId: ctx.config.guildId,
    userId: user.id,
    tierId,
    refund,
    actorId: interaction.user.id,
    maxCash: ctx.config.economy.maxCash,
    maxBank: ctx.config.economy.maxBank,
  });
  if (!result.ok) {
    await replyEphemeral(interaction, `<@${user.id}> does not have an active ${tierId} ticket.`);
    return;
  }
  const shop = currentShop(ctx);
  const tier = shop.tiers.find((item) => item.id === tierId);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && tier) await removeConfiguredRole(member, tier.roleKey, ctx.config);
  if (refund && result.refunded > 0) {
    const account = ctx.economy.get(ctx.config.guildId, user.id);
    if (account) await rememberEconomy(interaction.guild, ctx, user.id, false, result.refunded, 0, `refund:${tierId}`, account);
  }
  await replyEphemeral(interaction, `Revoked ${tierId} for <@${user.id}>.${refund ? ` Refunded ${result.refunded}.` : ''}`);
}

async function postShop(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const channel = shopChannel(interaction.guild, ctx.config);
  if (!channel) {
    await replyEphemeral(interaction, `I cannot find the shop channel "${ctx.config.channels.shop}".`);
    return;
  }
  const shop = currentShop(ctx);
  await channel.send({ embeds: [shopEmbed(ctx.config, shop)], components: shopButtons(shop) });
  await replyEphemeral(interaction, 'Shop posted.');
}

async function postGuide(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff || !interaction.guild) return;
  const which = interaction.options.getString('which', true);
  const ping = interaction.options.getBoolean('ping_alerts') ?? false;
  const channel = which === 'howto' ? giveawayChannel(interaction.guild, ctx.config) : shopChannel(interaction.guild, ctx.config);
  if (!channel) {
    await replyEphemeral(interaction, 'I cannot find that channel. Check the names in config.json.');
    return;
  }
  const shop = currentShop(ctx);
  const embed = which === 'howto' ? howToEmbed(ctx.config, shop) : activityGuideEmbed(ctx.config);
  const role = findRole(interaction.guild, ctx.config.roles.giveawayAlerts);
  const content = ping && role ? `<@&${role.id}>` : undefined;
  await channel.send({ content, embeds: [embed] });
  await replyEphemeral(interaction, 'Guide posted.');
}

async function showStatus(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void> {
  const staff = await requireStaffCommand(ctx, interaction, 'mod');
  if (!staff) return;
  const shop = currentShop(ctx);
  const week = ctx.store.getWeek(ctx.config.guildId);
  const giveaway = ctx.store.getActiveGiveaway(ctx.config.guildId);
  const totals = ctx.store.sumBalances(ctx.config.guildId);
  const prices = shop.tiers.filter((tier) => tier.enabled).map((tier) => `${tier.id} ${tier.price}/${tier.entries}x`).join(', ');
  await replyEphemeral(interaction, [
    `Week **${week.weekId}** since <t:${Math.floor(week.startedAt / 1000)}:D>.`,
    `Preset **${shop.presetName}**. Limit ${shop.enforcePurchaseLimit ? 'on' : 'off'}. One tier only: ${shop.oneTierOnly ? 'yes' : 'no'}.`,
    prices,
    giveaway ? `Giveaway: **${giveaway.prize}** ends <t:${Math.floor(giveaway.endsAt / 1000)}:R>.` : 'No active giveaway.',
    `PlayBits in circulation: ${totals.total}.`,
  ].join('\n'));
}

async function enterGiveaway(ctx: BotContext, interaction: ButtonInteraction, giveawayId: number): Promise<void> {
  const giveaway = ctx.store.getGiveaway(giveawayId);
  if (!giveaway || giveaway.status !== 'active' || giveaway.endsAt <= Date.now()) {
    await replyEphemeral(interaction, 'That giveaway is closed.');
    return;
  }
  const tickets = ctx.store.listTickets(ctx.config.guildId, interaction.user.id);
  const weight = activeEntryWeight(tickets, ctx.config.giveaway.stackEntries);
  if (weight <= 0) {
    await replyEphemeral(interaction, 'You need a raffle ticket before you can enter. Buy one in the shop. The shop spends cash, so use /withdraw if your PlayBits are in the bank.');
    return;
  }
  if (ctx.store.hasEntry(giveaway.id, interaction.user.id)) {
    await replyEphemeral(interaction, `You're already entered with **${weight}** ${weight === 1 ? 'entry' : 'entries'}.`);
    return;
  }
  if (ctx.config.giveaway.requireCaptcha) {
    await sendCaptcha(interaction, ctx, giveaway.id, 0);
    return;
  }
  await registerEntry(interaction, ctx, giveaway);
}

async function answerCaptcha(ctx: BotContext, interaction: ButtonInteraction, token: string, choice: string): Promise<void> {
  const captcha = ctx.store.getCaptcha(token);
  if (!captcha || captcha.userId !== interaction.user.id || captcha.expiresAt < Date.now()) {
    await replyEphemeral(interaction, 'That check expired. Press Enter on the giveaway again.');
    return;
  }
  const giveaway = ctx.store.getGiveaway(captcha.giveawayId);
  if (!giveaway || giveaway.status !== 'active') {
    ctx.store.deleteCaptcha(token);
    await replyEphemeral(interaction, 'That giveaway is closed.');
    return;
  }
  if (choice !== captcha.answer) {
    const attempts = captcha.attempts + 1;
    ctx.store.deleteCaptcha(token);
    if (attempts >= 3) {
      await replyEphemeral(interaction, 'That answer was wrong too many times. Press Enter to try again.');
      return;
    }
    await sendCaptcha(interaction, ctx, giveaway.id, attempts);
    return;
  }
  ctx.store.deleteCaptcha(token);
  await registerEntry(interaction, ctx, giveaway);
}

async function reviewClaim(ctx: BotContext, interaction: ButtonInteraction, action: string, claimId: number): Promise<void> {
  const staff = await requireButtonStaff(ctx, interaction);
  if (!staff || !interaction.guild) return;
  const claim = ctx.store.getClaim(claimId);
  if (!claim || claim.status !== 'pending') {
    await replyEphemeral(interaction, 'That claim was already reviewed.');
    return;
  }
  if (ctx.config.moderation.preventSelfReward && claim.userId === interaction.user.id) {
    await replyEphemeral(interaction, 'You cannot review your own claim.');
    return;
  }
  if (action === 'deny') {
    const modal = new ModalBuilder().setCustomId(`claim:deny-modal:${claim.id}`).setTitle('Deny claim').addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Reason shown to the mods').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300),
      ),
    );
    await interaction.showModal(modal);
    return;
  }
  if (action === 'approve' && claim.activityKey === 'gaminghub') {
    const seconds = voiceSeconds(ctx, claim.userId);
    const needed = hubRequirementMinutes(ctx.config);
    if (!qualifiesForVoice(seconds, needed)) {
      await replyEphemeral(interaction, `Tracked time is ${Math.floor(seconds / 60)} minutes. The reward needs ${needed}. Use Approve anyway if you verified it another way.`);
      return;
    }
  }
  if (action !== 'approve' && action !== 'override') {
    await replyEphemeral(interaction, 'Unknown review action.');
    return;
  }
  const result = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.config.guildId,
    userId: claim.userId,
    activityKey: claim.activityKey,
    actorId: interaction.user.id,
    note: action === 'override' ? 'approved without the voice minimum' : 'approved',
    preventSelf: ctx.config.moderation.preventSelfReward,
  });
  if (!result.ok) {
    await replyEphemeral(interaction, grantError(result.error, result.label));
    return;
  }
  const member = await interaction.guild.members.fetch(claim.userId);
  const follow = await finishApprovedClaim(interaction.guild, ctx, member, claim.activityKey, result.reward, result.roleKey, result.created);
  await editClaimMessage(interaction.guild, ctx, claim.id, 'approved', interaction.user.id, action === 'override' ? 'approved without the voice minimum' : 'approved');
  await replyEphemeral(interaction, follow);
}

async function editClaimMessage(guild: Guild, ctx: BotContext, claimId: number, status: string, reviewerId: string, reviewNote: string): Promise<void> {
  const claim = ctx.store.getClaim(claimId);
  if (!claim?.channelId || !claim.messageId) return;
  const channel = await guild.channels.fetch(claim.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
  const message = await channel.messages.fetch(claim.messageId).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [claimEmbed(ctx, {
      userId: claim.userId,
      activityKey: claim.activityKey,
      note: claim.note,
      status,
      reviewerId,
      reviewNote,
    })],
    components: [],
  }).catch(() => undefined);
}

function grantError(error: string, label?: string): string {
  if (error === 'self') return 'You cannot award that to yourself.';
  if (error === 'duplicate') return `${label ?? 'That activity'} was already rewarded this week.`;
  return 'That reward could not be granted.';
}

function helpText(ctx: BotContext): string {
  const name = ctx.config.economy.currencyName;
  return [
    `**${name}** start at ${ctx.config.economy.startingBalance} and are not wiped each week.`,
    'Chat in the configured channels to earn. Use `/claim` for activities. Buy tickets with `/shop` or `/buy`, then press Enter on the giveaway.',
    'Member commands: `/balance`, `/leaderboard`, `/deposit`, `/withdraw`, `/tickets`, `/voice-time`.',
    'Moderators, in the admin channel: `/add-money`, `/remove-money`, `/award`, `/history`, `/voice-report`, `/giveaway-end`, `/giveaway-reroll`.',
    'Management: `/giveaway-create`, `/weekly-reset`, `/set-preset`, `/purchase-limit`, `/import-balances`.',
  ].join('\n');
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

async function requireStaffCommand(ctx: BotContext, interaction: ChatInputCommandInteraction, level: 'mod' | 'admin'): Promise<GuildMember | null> {
  return requireStaff(interaction, ctx.config, level);
}

async function requireButtonStaff(ctx: BotContext, interaction: ButtonInteraction | ModalSubmitInteraction): Promise<GuildMember | null> {
  return requireStaff(interaction, ctx.config, 'mod');
}

async function ensureShopPlace(ctx: BotContext, interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<boolean> {
  if (!ctx.config.shop.restrictToChannel) return true;
  const channel = interaction.channel;
  if (!channel || channel.isDMBased()) {
    await replyEphemeral(interaction, 'Buy tickets in the shop channel.');
    return false;
  }
  const parent = channel.isThread() ? channel.parent : channel;
  if (inNamedChannel(parent, ctx.config.channels.shop) || inAdminChannel(parent, ctx.config) || inNamedChannel(channel, ctx.config.channels.shop)) {
    return true;
  }
  await replyEphemeral(interaction, `Buy tickets in #${ctx.config.channels.shop}.`);
  return false;
}

async function grantConfiguredRoleSafe(member: GuildMember, roleKey: string, ctx: BotContext): Promise<string | null> {
  return grantConfiguredRole(member, roleKey, ctx.config);
}

async function postAuditSafe(interaction: ChatInputCommandInteraction, ctx: BotContext, line: string): Promise<void> {
  if (!interaction.guild) return;
  await postAudit(interaction.guild, ctx.config, line);
}
