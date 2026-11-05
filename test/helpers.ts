import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from '../src/config.js';
import { Economy } from '../src/services/economy.js';
import { openDatabase, Store } from '../src/store.js';

export function setup(): { config: AppConfig; store: Store; economy: Economy; guildId: string } {
  const config = loadConfig(fileURLToPath(new URL('../config/config.example.json', import.meta.url)));
  config.guildId = '100000000000000001';
  const store = new Store(openDatabase(':memory:'));
  const economy = new Economy(store, config);
  return { config, store, economy, guildId: config.guildId };
}
