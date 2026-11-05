import { readFileSync } from 'node:fs';

export interface TicketTier {
  id: string;
  name: string;
  price: number;
  entries: number;
  enabled: boolean;
  requiredRoleKeys: string[];
  roleKey: string;
}

export interface ShopPreset {
  enforcePurchaseLimit: boolean;
  oneTierOnly: boolean;
  higherReplacesLower: boolean;
  refundReplacedTicket: boolean;
  tiers: TicketTier[];
}

export interface ActivityConfig {
  label: string;
  reward: number;
  roleKey: string;
  expiresWeekly: boolean;
  minVoiceMinutes?: number;
}

export interface AppConfig {
  guildId: string;
  databasePath: string;
  channels: {
    adminCommands: string[];
    memberEconomy: string[];
    auditLog: string;
    giveaways: string;
    events: string;
    shop: string;
    chatEarn: string[];
    gamingHubVoice: string[];
  };
  roles: {
    verified: string;
    moderator: string[];
    admin: string[];
    serverBooster: string;
    trendHunter: string;
    gameCreator: string;
    partyLegend: string;
    playmaker: string;
    playfullPatron: string;
    bronzeTicket: string;
    silverTicket: string;
    goldTicket: string;
    platinumTicket: string;
    diamondTicket: string;
    giveawayAlerts: string;
  };
  economy: {
    currencyName: string;
    startingBalance: number;
    startingBucket: 'cash' | 'bank';
    maxCash: number | null;
    maxBank: number | null;
    useBank: boolean;
  };
  chat: {
    enabled: boolean;
    amount: number;
    cooldownSeconds: number;
    requireVerified: boolean;
    minLength: number;
    rejectDuplicates: boolean;
    duplicateWindowSeconds: number;
    includeThreads: boolean;
    countMediaWithoutText: boolean;
    ignorePrefixes: string[];
  };
  audit: {
    logChatEarnings: boolean;
  };
  moderation: {
    preventSelfReward: boolean;
  };
  activities: Record<string, ActivityConfig>;
  boost: {
    autoGrantPatron: boolean;
    grantPlayBits: number;
    countsAsPurchase: boolean;
  };
  voice: {
    qualifyMinutes: number;
    ignoreDeafened: boolean;
    ignoreMuted: boolean;
    ignoreAfk: boolean;
    heartbeatSeconds: number;
  };
  shop: {
    activePreset: string;
    restrictToChannel: boolean;
    presets: Record<string, ShopPreset>;
  };
  giveaway: {
    defaultDurationHours: number;
    embedColor: string;
    requireCaptcha: boolean;
    stackEntries: boolean;
    privateWinnerThread: boolean;
    thumbnailUrl: string;
    autoWeeklyReset: boolean;
    defaultWinnerMessage: string;
  };
  weeklyReset: {
    expireTickets: boolean;
    resetBalances: boolean;
    rolesToRemove: string[];
    rolesNeverRemove: string[];
  };
}

export interface RuntimeFlags {
  preset: string | null;
  enforcePurchaseLimit: boolean | null;
  oneTierOnly: boolean | null;
  higherReplacesLower: boolean | null;
  refundReplaced: boolean | null;
}

export interface EffectiveShop {
  presetName: string;
  enforcePurchaseLimit: boolean;
  oneTierOnly: boolean;
  higherReplacesLower: boolean;
  refundReplacedTicket: boolean;
  tiers: TicketTier[];
}

const TIER_IDS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;

export function loadConfig(filePath: string): AppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read ${filePath}. Copy config/config.example.json to config/config.json and edit it. (${reason})`,
    );
  }
  stripMeta(parsed);
  rejectEmbeddedToken(parsed);
  const problems: string[] = [];
  const config = parseConfig(parsed, problems);
  if (problems.length > 0) {
    throw new Error(`Invalid config file:\n- ${problems.join('\n- ')}`);
  }
  lockBalanceReset(config);
  return config;
}

export function lockBalanceReset(config: AppConfig, warn: (message: string) => void = console.warn): void {
  if (config.weeklyReset.resetBalances) {
    warn(
      '[playfull] weeklyReset.resetBalances is true. Ignored: the weekly reset never changes PlayBits balances.',
    );
    config.weeklyReset.resetBalances = false;
  }
}

export function resolveShop(config: AppConfig, runtime: RuntimeFlags | null): EffectiveShop {
  const presetName = runtime?.preset || config.shop.activePreset;
  const preset = config.shop.presets[presetName];
  if (!preset) {
    throw new Error(`Unknown shop preset "${presetName}".`);
  }
  return {
    presetName,
    enforcePurchaseLimit: runtime?.enforcePurchaseLimit ?? preset.enforcePurchaseLimit,
    oneTierOnly: runtime?.oneTierOnly ?? preset.oneTierOnly,
    higherReplacesLower: runtime?.higherReplacesLower ?? preset.higherReplacesLower,
    refundReplacedTicket: runtime?.refundReplaced ?? preset.refundReplacedTicket,
    tiers: preset.tiers,
  };
}

export function activityList(config: AppConfig): { key: string; activity: ActivityConfig }[] {
  return Object.entries(config.activities).map(([key, activity]) => ({ key, activity }));
}

function stripMeta(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripMeta(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('_')) delete (value as Record<string, unknown>)[key];
    else stripMeta((value as Record<string, unknown>)[key]);
  }
}

function rejectEmbeddedToken(value: unknown): void {
  const found = findTokenKey(value);
  if (found) {
    throw new Error(
      `Remove "${found}" from the config file. The bot token belongs only in the .env file as DISCORD_TOKEN.`,
    );
  }
}

function findTokenKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (/token/i.test(key) && typeof child === 'string' && child.trim().length > 0) return key;
    const nested = findTokenKey(child);
    if (nested) return nested;
  }
  return null;
}

function parseConfig(value: unknown, problems: string[]): AppConfig {
  const root = asObject(value, 'config', problems);
  const channels = asObject(root.channels, 'channels', problems);
  const roles = asObject(root.roles, 'roles', problems);
  const economy = asObject(root.economy, 'economy', problems);
  const chat = asObject(root.chat, 'chat', problems);
  const audit = asObject(root.audit, 'audit', problems);
  const moderation = asObject(root.moderation, 'moderation', problems);
  const activitiesRaw = asObject(root.activities, 'activities', problems);
  const boost = asObject(root.boost, 'boost', problems);
  const voice = asObject(root.voice, 'voice', problems);
  const shop = asObject(root.shop, 'shop', problems);
  const giveaway = asObject(root.giveaway, 'giveaway', problems);
  const weeklyReset = asObject(root.weeklyReset, 'weeklyReset', problems);

  const startingBucket = economy.startingBucket === 'bank' ? 'bank' : economy.startingBucket === 'cash' ? 'cash' : null;
  if (!startingBucket) problems.push('economy.startingBucket must be "cash" or "bank".');

  const presetsRaw = asObject(shop.presets, 'shop.presets', problems);
  const presets: Record<string, ShopPreset> = {};
  for (const [name, presetValue] of Object.entries(presetsRaw)) {
    presets[name] = parsePreset(name, presetValue, problems);
  }

  const activePreset = asString(shop.activePreset, 'shop.activePreset', problems);
  if (activePreset && !presets[activePreset]) {
    problems.push(`shop.activePreset "${activePreset}" does not match a preset.`);
  }

  const activities: Record<string, ActivityConfig> = {};
  for (const [key, activityValue] of Object.entries(activitiesRaw)) {
    activities[key] = parseActivity(key, activityValue, problems);
  }
  for (const required of ['trending', 'gameplay', 'gamenight', 'gaminghub', 'purchase']) {
    if (!activities[required]) problems.push(`activities.${required} is required.`);
  }

  const useBank = asBoolean(economy.useBank, 'economy.useBank', problems);
  if (useBank === false && startingBucket === 'bank') {
    problems.push('economy.startingBucket cannot be "bank" while economy.useBank is false.');
  }

  const color = asString(giveaway.embedColor, 'giveaway.embedColor', problems);
  if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) problems.push('giveaway.embedColor must look like #007FFF.');

  return {
    guildId: asString(root.guildId, 'guildId', problems) ?? '',
    databasePath: asString(root.databasePath, 'databasePath', problems) || 'data/playfull.db',
    channels: {
      adminCommands: asStringArray(channels.adminCommands, 'channels.adminCommands', problems),
      memberEconomy: asStringArray(channels.memberEconomy, 'channels.memberEconomy', problems),
      auditLog: asString(channels.auditLog, 'channels.auditLog', problems),
      giveaways: asString(channels.giveaways, 'channels.giveaways', problems),
      events: asString(channels.events, 'channels.events', problems),
      shop: asString(channels.shop, 'channels.shop', problems),
      chatEarn: asStringArray(channels.chatEarn, 'channels.chatEarn', problems),
      gamingHubVoice: asStringArray(channels.gamingHubVoice, 'channels.gamingHubVoice', problems),
    },
    roles: {
      verified: asString(roles.verified, 'roles.verified', problems),
      moderator: asStringArray(roles.moderator, 'roles.moderator', problems),
      admin: asStringArray(roles.admin, 'roles.admin', problems),
      serverBooster: asString(roles.serverBooster, 'roles.serverBooster', problems),
      trendHunter: asString(roles.trendHunter, 'roles.trendHunter', problems),
      gameCreator: asString(roles.gameCreator, 'roles.gameCreator', problems),
      partyLegend: asString(roles.partyLegend, 'roles.partyLegend', problems),
      playmaker: asString(roles.playmaker, 'roles.playmaker', problems),
      playfullPatron: asString(roles.playfullPatron, 'roles.playfullPatron', problems),
      bronzeTicket: asString(roles.bronzeTicket, 'roles.bronzeTicket', problems),
      silverTicket: asString(roles.silverTicket, 'roles.silverTicket', problems),
      goldTicket: asString(roles.goldTicket, 'roles.goldTicket', problems),
      platinumTicket: asString(roles.platinumTicket, 'roles.platinumTicket', problems),
      diamondTicket: asString(roles.diamondTicket, 'roles.diamondTicket', problems),
      giveawayAlerts: asString(roles.giveawayAlerts, 'roles.giveawayAlerts', problems),
    },
    economy: {
      currencyName: asString(economy.currencyName, 'economy.currencyName', problems) || 'PlayBits',
      startingBalance: asInt(economy.startingBalance, 'economy.startingBalance', problems, 0),
      startingBucket: startingBucket ?? 'cash',
      maxCash: asNullableInt(economy.maxCash, 'economy.maxCash', problems),
      maxBank: asNullableInt(economy.maxBank, 'economy.maxBank', problems),
      useBank: useBank ?? true,
    },
    chat: {
      enabled: asBoolean(chat.enabled, 'chat.enabled', problems) ?? true,
      amount: asInt(chat.amount, 'chat.amount', problems, 0),
      cooldownSeconds: asInt(chat.cooldownSeconds, 'chat.cooldownSeconds', problems, 0),
      requireVerified: asBoolean(chat.requireVerified, 'chat.requireVerified', problems) ?? true,
      minLength: asInt(chat.minLength, 'chat.minLength', problems, 0),
      rejectDuplicates: asBoolean(chat.rejectDuplicates, 'chat.rejectDuplicates', problems) ?? true,
      duplicateWindowSeconds: asInt(chat.duplicateWindowSeconds, 'chat.duplicateWindowSeconds', problems, 0),
      includeThreads: asBoolean(chat.includeThreads, 'chat.includeThreads', problems) ?? true,
      countMediaWithoutText: asBoolean(chat.countMediaWithoutText, 'chat.countMediaWithoutText', problems) ?? false,
      ignorePrefixes: asStringArray(chat.ignorePrefixes, 'chat.ignorePrefixes', problems),
    },
    audit: {
      logChatEarnings: asBoolean(audit.logChatEarnings, 'audit.logChatEarnings', problems) ?? true,
    },
    moderation: {
      preventSelfReward: asBoolean(moderation.preventSelfReward, 'moderation.preventSelfReward', problems) ?? true,
    },
    activities,
    boost: {
      autoGrantPatron: asBoolean(boost.autoGrantPatron, 'boost.autoGrantPatron', problems) ?? true,
      grantPlayBits: asInt(boost.grantPlayBits, 'boost.grantPlayBits', problems, 0),
      countsAsPurchase: asBoolean(boost.countsAsPurchase, 'boost.countsAsPurchase', problems) ?? true,
    },
    voice: {
      qualifyMinutes: asInt(voice.qualifyMinutes, 'voice.qualifyMinutes', problems, 1),
      ignoreDeafened: asBoolean(voice.ignoreDeafened, 'voice.ignoreDeafened', problems) ?? true,
      ignoreMuted: asBoolean(voice.ignoreMuted, 'voice.ignoreMuted', problems) ?? false,
      ignoreAfk: asBoolean(voice.ignoreAfk, 'voice.ignoreAfk', problems) ?? true,
      heartbeatSeconds: asInt(voice.heartbeatSeconds, 'voice.heartbeatSeconds', problems, 10),
    },
    shop: {
      activePreset,
      restrictToChannel: asBoolean(shop.restrictToChannel, 'shop.restrictToChannel', problems) ?? true,
      presets,
    },
    giveaway: {
      defaultDurationHours: asInt(giveaway.defaultDurationHours, 'giveaway.defaultDurationHours', problems, 1),
      embedColor: color.startsWith('#') ? color : `#${color}`,
      requireCaptcha: asBoolean(giveaway.requireCaptcha, 'giveaway.requireCaptcha', problems) ?? true,
      stackEntries: asBoolean(giveaway.stackEntries, 'giveaway.stackEntries', problems) ?? true,
      privateWinnerThread: asBoolean(giveaway.privateWinnerThread, 'giveaway.privateWinnerThread', problems) ?? true,
      thumbnailUrl: asString(giveaway.thumbnailUrl, 'giveaway.thumbnailUrl', problems, true),
      autoWeeklyReset: asBoolean(giveaway.autoWeeklyReset, 'giveaway.autoWeeklyReset', problems) ?? false,
      defaultWinnerMessage: asString(giveaway.defaultWinnerMessage, 'giveaway.defaultWinnerMessage', problems),
    },
    weeklyReset: {
      expireTickets: asBoolean(weeklyReset.expireTickets, 'weeklyReset.expireTickets', problems) ?? true,
      resetBalances: asBoolean(weeklyReset.resetBalances, 'weeklyReset.resetBalances', problems) ?? false,
      rolesToRemove: asStringArray(weeklyReset.rolesToRemove, 'weeklyReset.rolesToRemove', problems),
      rolesNeverRemove: asStringArray(weeklyReset.rolesNeverRemove, 'weeklyReset.rolesNeverRemove', problems),
    },
  };
}

function parsePreset(name: string, value: unknown, problems: string[]): ShopPreset {
  const preset = asObject(value, `shop.presets.${name}`, problems);
  const tiersRaw = Array.isArray(preset.tiers) ? preset.tiers : [];
  if (!Array.isArray(preset.tiers)) problems.push(`shop.presets.${name}.tiers must be a list.`);
  const tiers = tiersRaw.map((tier, index) => parseTier(name, index, tier, problems));
  const ids = tiers.map((tier) => tier.id);
  for (const id of TIER_IDS) {
    if (!ids.includes(id)) problems.push(`shop.presets.${name} is missing the ${id} tier.`);
  }
  return {
    enforcePurchaseLimit: asBoolean(preset.enforcePurchaseLimit, `shop.presets.${name}.enforcePurchaseLimit`, problems) ?? true,
    oneTierOnly: asBoolean(preset.oneTierOnly, `shop.presets.${name}.oneTierOnly`, problems) ?? false,
    higherReplacesLower: asBoolean(preset.higherReplacesLower, `shop.presets.${name}.higherReplacesLower`, problems) ?? false,
    refundReplacedTicket: asBoolean(preset.refundReplacedTicket, `shop.presets.${name}.refundReplacedTicket`, problems) ?? false,
    tiers,
  };
}

function parseTier(preset: string, index: number, value: unknown, problems: string[]): TicketTier {
  const path = `shop.presets.${preset}.tiers[${index}]`;
  const tier = asObject(value, path, problems);
  const id = asString(tier.id, `${path}.id`, problems);
  if (id && !TIER_IDS.includes(id as (typeof TIER_IDS)[number])) {
    problems.push(`${path}.id must be one of ${TIER_IDS.join(', ')}.`);
  }
  return {
    id,
    name: asString(tier.name, `${path}.name`, problems),
    price: asInt(tier.price, `${path}.price`, problems, 0),
    entries: asInt(tier.entries, `${path}.entries`, problems, 1),
    enabled: asBoolean(tier.enabled, `${path}.enabled`, problems) ?? false,
    requiredRoleKeys: asStringArray(tier.requiredRoleKeys, `${path}.requiredRoleKeys`, problems),
    roleKey: asString(tier.roleKey, `${path}.roleKey`, problems),
  };
}

function parseActivity(key: string, value: unknown, problems: string[]): ActivityConfig {
  const path = `activities.${key}`;
  const activity = asObject(value, path, problems);
  const minVoice = activity.minVoiceMinutes;
  return {
    label: asString(activity.label, `${path}.label`, problems),
    reward: asInt(activity.reward, `${path}.reward`, problems, 0),
    roleKey: asString(activity.roleKey, `${path}.roleKey`, problems),
    expiresWeekly: asBoolean(activity.expiresWeekly, `${path}.expiresWeekly`, problems) ?? true,
    ...(minVoice === undefined ? {} : { minVoiceMinutes: asInt(minVoice, `${path}.minVoiceMinutes`, problems, 1) }),
  };
}

function asObject(value: unknown, path: string, problems: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path} must be an object.`);
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string, problems: string[], allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '' && path !== 'guildId' && path !== 'giveaway.thumbnailUrl')) {
    if (typeof value !== 'string') problems.push(`${path} must be text.`);
    else if (!allowEmpty && path !== 'guildId' && path !== 'giveaway.thumbnailUrl') problems.push(`${path} is empty.`);
    return typeof value === 'string' ? value : '';
  }
  return value;
}

function asStringArray(value: unknown, path: string, problems: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    problems.push(`${path} must be a list of text values.`);
    return [];
  }
  return value;
}

function asBoolean(value: unknown, path: string, problems: string[]): boolean | null {
  if (typeof value !== 'boolean') {
    problems.push(`${path} must be true or false.`);
    return null;
  }
  return value;
}

function asInt(value: unknown, path: string, problems: string[], min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    problems.push(`${path} must be a whole number of at least ${min}.`);
    return min;
  }
  return value;
}

function asNullableInt(value: unknown, path: string, problems: string[]): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${path} must be a whole number or null.`);
    return null;
  }
  return value;
}
