import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

test('the example config loads and keeps the documented defaults', () => {
  const config = loadConfig(fileURLToPath(new URL('../config/config.example.json', import.meta.url)));
  assert.equal(config.shop.activePreset, 'standard');
  assert.equal(config.economy.startingBalance, 5);
  assert.equal(config.economy.maxCash, null);
  assert.equal(config.chat.amount, 1);
  assert.equal(config.chat.cooldownSeconds, 60);
  assert.equal(config.chat.requireVerified, true);
  assert.deepEqual(config.channels.chatEarn, ['general', 'spanish', 'japanese', 'filipino', 'russian']);
  assert.equal(config.giveaway.embedColor, '#007FFF');
  assert.equal(config.giveaway.defaultDurationHours, 168);
  assert.equal(config.giveaway.requireCaptcha, true);
  assert.equal(config.giveaway.stackEntries, true);
  assert.equal(config.weeklyReset.resetBalances, false);
  assert.deepEqual(config.weeklyReset.rolesNeverRemove, ['playfullPatron']);
  assert.equal(config.boost.autoGrantPatron, true);
  assert.equal(config.boost.grantPlayBits, 40);
  assert.equal(config.shop.presets['launch-week']?.tiers.find((tier) => tier.id === 'platinum')?.price, 100);
  assert.equal(config.shop.presets['posted-announcement']?.tiers.find((tier) => tier.id === 'silver')?.price, 19);
});
