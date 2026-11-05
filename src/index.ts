import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { handleInteraction } from './bot/interact.js';
import { bindListeners, onReady, startLoops } from './bot/listeners.js';
import { Economy } from './services/economy.js';
import { openDatabase, Store } from './store.js';
import { isSnowflake, loadEnvFile } from './util.js';

loadEnvFile('.env');

const token = process.env.DISCORD_TOKEN?.trim();
const configPath = process.env.CONFIG_PATH?.trim() || 'config/config.json';

if (!token || token === 'paste-your-bot-token-here') {
  console.error('[playfull] Put the bot token in .env as DISCORD_TOKEN. Do not put it in config.json.');
  process.exit(1);
}
if (!process.env.DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID === 'paste-your-application-id-here') {
  console.error('[playfull] Put the application id in .env as DISCORD_CLIENT_ID.');
  process.exit(1);
}

const config = loadConfig(configPath);
if (process.env.DISCORD_GUILD_ID) config.guildId = process.env.DISCORD_GUILD_ID.trim();
if (!isSnowflake(config.guildId)) {
  console.error('[playfull] Set guildId in config/config.json to your Discord server id (17–20 digits).');
  process.exit(1);
}

const store = new Store(openDatabase(config.databasePath));
const economy = new Economy(store, config);
const ctx = { config, store, economy };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

bindListeners(client, ctx);
client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(client, ctx, interaction);
});
client.once(Events.ClientReady, (ready) => {
  console.log(`[playfull] Logged in as ${ready.user.tag}.`);
  void onReady(ready, ctx)
    .then(() => startLoops(ready, ctx))
    .catch((error: unknown) => console.error('[playfull] Startup failed.', error));
});

await client.login(token);
