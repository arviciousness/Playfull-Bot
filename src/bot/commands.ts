import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

type AnyCommand = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
import type { AppConfig } from '../config.js';

export function commandPayloads(config: AppConfig): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const presets = Object.keys(config.shop.presets).slice(0, 25).map((name) => ({ name, value: name }));
  const activities = Object.entries(config.activities).slice(0, 25).map(([key, activity]) => ({
    name: activity.label.slice(0, 100),
    value: key,
  }));
  const tiers = [
    { name: 'Bronze', value: 'bronze' },
    { name: 'Silver', value: 'silver' },
    { name: 'Gold', value: 'gold' },
    { name: 'Platinum', value: 'platinum' },
    { name: 'Diamond', value: 'diamond' },
  ];

  const member = (builder: AnyCommand): AnyCommand => builder.setDMPermission(false);

  return [
    member(new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Show a PlayBits balance.')
      .addUserOption((option) => option.setName('member').setDescription('Moderator only: look up someone else.'))),
    member(new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the PlayBits leaderboard.')
      .addIntegerOption((option) => option.setName('page').setDescription('Page number').setMinValue(1))),
    member(new SlashCommandBuilder()
      .setName('deposit')
      .setDescription('Move PlayBits from cash into the bank.')
      .addIntegerOption((option) => option.setName('amount').setDescription('Amount to deposit').setMinValue(1))
      .addBooleanOption((option) => option.setName('all').setDescription('Deposit all cash'))),
    member(new SlashCommandBuilder()
      .setName('withdraw')
      .setDescription('Move PlayBits from the bank into cash.')
      .addIntegerOption((option) => option.setName('amount').setDescription('Amount to withdraw').setMinValue(1))
      .addBooleanOption((option) => option.setName('all').setDescription('Withdraw everything'))),
    member(new SlashCommandBuilder().setName('shop').setDescription('Show ticket prices and buy buttons.')),
    member(new SlashCommandBuilder()
      .setName('buy')
      .setDescription('Buy a raffle ticket with cash PlayBits.')
      .addStringOption((option) => option.setName('tier').setDescription('Ticket tier').setRequired(true).addChoices(...tiers))),
    member(new SlashCommandBuilder().setName('tickets').setDescription('Show the raffle tickets you hold and your entry weight.')),
    member(new SlashCommandBuilder()
      .setName('claim')
      .setDescription('Ask a moderator to confirm an activity reward.')
      .addStringOption((option) => option.setName('activity').setDescription('Activity').setRequired(true).addChoices(...activities))
      .addStringOption((option) => option.setName('note').setDescription('Link or short proof').setRequired(true).setMaxLength(500))),
    member(new SlashCommandBuilder()
      .setName('voice-time')
      .setDescription('Show Gaming Hub time for the current week.')
      .addUserOption((option) => option.setName('member').setDescription('Moderator only: look up someone else.'))),
    member(new SlashCommandBuilder().setName('help').setDescription('Show what this bot does and the main commands.')),

    staff(new SlashCommandBuilder()
      .setName('add-money')
      .setDescription('Add PlayBits cash to a member.')
      .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
      .addIntegerOption((option) => option.setName('amount').setDescription('PlayBits to add').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('Why').setMaxLength(200))),
    staff(new SlashCommandBuilder()
      .setName('remove-money')
      .setDescription('Remove PlayBits from a member.')
      .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
      .addIntegerOption((option) => option.setName('amount').setDescription('PlayBits to remove').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('bucket').setDescription('Where to remove from').addChoices(
        { name: 'Cash', value: 'cash' },
        { name: 'Bank', value: 'bank' },
      ))
      .addStringOption((option) => option.setName('reason').setDescription('Why').setMaxLength(200))),
    staff(new SlashCommandBuilder()
      .setName('history')
      .setDescription('Show recent PlayBits changes for a member.')
      .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))),
    staff(new SlashCommandBuilder()
      .setName('award')
      .setDescription('Grant an activity reward and role without a claim button.')
      .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('activity').setDescription('Activity').setRequired(true).addChoices(...activities))
      .addStringOption((option) => option.setName('note').setDescription('What you verified').setMaxLength(300))
      .addBooleanOption((option) => option.setName('force').setDescription('Award Gaming Hub even if tracked time is under 30 minutes'))),
    staff(new SlashCommandBuilder().setName('voice-report').setDescription('Show who has Gaming Hub time this week.')),
    staff(new SlashCommandBuilder()
      .setName('giveaway-create')
      .setDescription('Post this week\'s giveaway.')
      .addStringOption((option) => option.setName('prize').setDescription('Steam game or prize name').setRequired(true).setMaxLength(200))
      .addIntegerOption((option) => option.setName('duration_hours').setDescription('Defaults to 168 (7 days)').setMinValue(1).setMaxValue(336))
      .addStringOption((option) => option.setName('winner_message').setDescription('Private thread message. {winner} and {prize} are filled in.').setMaxLength(1500))),
    staff(new SlashCommandBuilder().setName('giveaway-end').setDescription('Draw the winner now.')),
    staff(new SlashCommandBuilder().setName('giveaway-reroll').setDescription('Draw a different winner, excluding previous winners.')),
    staff(new SlashCommandBuilder().setName('giveaway-cancel').setDescription('Cancel the active giveaway without drawing.')),
    staff(new SlashCommandBuilder()
      .setName('weekly-reset')
      .setDescription('Expire tickets and temporary roles. PlayBits are not touched.')
      .addBooleanOption((option) => option.setName('confirm').setDescription('Must be true.').setRequired(true))),
    staff(new SlashCommandBuilder()
      .setName('set-preset')
      .setDescription('Switch ticket prices and purchase rules.')
      .addStringOption((option) => option.setName('preset').setDescription('Preset from the config file').setRequired(true).addChoices(...presets))),
    staff(new SlashCommandBuilder()
      .setName('purchase-limit')
      .setDescription('Turn the one-ticket-per-tier weekly limit on or off.')
      .addBooleanOption((option) => option.setName('enabled').setDescription('True enforces the limit').setRequired(true))),
    staff(new SlashCommandBuilder()
      .setName('import-balances')
      .setDescription('Import UnbelievaBoat balances from a CSV. Use apply false first.')
      .addAttachmentOption((option) => option.setName('file').setDescription('CSV with user_id,cash,bank').setRequired(true))
      .addStringOption((option) => option.setName('mode').setDescription('set replaces balances. add increases them.').setRequired(true).addChoices(
        { name: 'set (use this for the switchover)', value: 'set' },
        { name: 'add', value: 'add' },
      ))
      .addBooleanOption((option) => option.setName('apply').setDescription('False previews. True writes balances.').setRequired(true))),
    staff(new SlashCommandBuilder()
      .setName('revoke-ticket')
      .setDescription('Remove a member\'s active ticket.')
      .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('tier').setDescription('Tier').setRequired(true).addChoices(...tiers))
      .addBooleanOption((option) => option.setName('refund').setDescription('Return the PlayBits to cash'))),
    staff(new SlashCommandBuilder().setName('post-shop').setDescription('Post the ticket shop with buy buttons.')),
    staff(new SlashCommandBuilder()
      .setName('post-guide')
      .setDescription('Post the how-to or the activity guide.')
      .addStringOption((option) => option.setName('which').setDescription('Which guide').setRequired(true).addChoices(
        { name: 'How to enter (giveaways channel)', value: 'howto' },
        { name: 'Activity rewards (shop channel)', value: 'activities' },
      ))
      .addBooleanOption((option) => option.setName('ping_alerts').setDescription('Mention the Giveaway Alerts role'))),
    staff(new SlashCommandBuilder().setName('status').setDescription('Show the week, shop preset, and active giveaway.')),
  ].map((builder) => builder.toJSON());
}

function staff(builder: AnyCommand): AnyCommand {
  return builder.setDMPermission(false);
}
