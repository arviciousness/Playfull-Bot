import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBalanceImport } from '../src/services/importBalances.js';
import { setup } from './helpers.js';

test('a header CSV, a headerless CSV, and JSON all become balances', () => {
  const csv = parseBalanceImport('user_id,cash,bank\n100000000000000001,42,3\n<@100000000000000002>,10,\n');
  assert.equal(csv.errors.length, 0);
  assert.deepEqual(csv.rows.map((row) => [row.userId, row.cash, row.bank]), [
    ['100000000000000001', 42, 3],
    ['100000000000000002', 10, 0],
  ]);

  const bare = parseBalanceImport('100000000000000003,15,4');
  assert.equal(bare.rows[0]?.cash, 15);

  const json = parseBalanceImport('[{"discord_id":"100000000000000004","balance":"80"}]');
  assert.equal(json.rows[0]?.cash, 80);
  assert.equal(json.rows[0]?.bank, 0);

  const bad = parseBalanceImport('user_id,cash\nnot-an-id,5\n');
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.errors.length, 1);
});

test('import set replaces a balance and does not add the starting 5', () => {
  const { store, guildId } = setup();
  store.setAccountBalance(guildId, '100000000000000009', 5, 1, 'starting-balance', null);
  store.setAccountBalance(guildId, '100000000000000009', 42, 0, 'import:set', 'mod');
  const account = store.getAccount(guildId, '100000000000000009');
  assert.equal(account?.cash, 42);
  assert.equal(account?.bank, 0);
  const fresh = '100000000000000008';
  store.setAccountBalance(guildId, fresh, 7, 2, 'import:set', 'mod');
  assert.equal(store.getAccount(guildId, fresh)?.cash, 7);
  assert.equal(store.recentLedger(guildId, fresh, 5).some((entry) => entry.reason === 'starting-balance'), false);
});
