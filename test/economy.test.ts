import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.js';

test('new members start with 5 cash and a second lookup does not grant it again', () => {
  const { economy, store, guildId } = setup();
  const first = economy.ensure(guildId, '200000000000000001');
  assert.equal(first.cash, 5);
  assert.equal(first.bank, 0);
  const second = economy.ensure(guildId, '200000000000000001');
  assert.equal(second.cash, 5);
  assert.equal(store.recentLedger(guildId, '200000000000000001', 10).length, 1);
  assert.equal(store.recentLedger(guildId, '200000000000000001', 1)[0]?.reason, 'starting-balance');
});

test('there is no balance cap unless one is configured', () => {
  const { economy, guildId } = setup();
  const user = '200000000000000002';
  economy.ensure(guildId, user);
  const added = economy.add(guildId, user, 2_000_000, 'event', 'mod');
  assert.equal(added.ok, true);
  if (added.ok) assert.equal(added.account.cash, 2_000_005);
});

test('a configured cap rejects the change and leaves the balance', () => {
  const ctx = setup();
  ctx.config.economy.maxCash = 10;
  const user = '200000000000000003';
  ctx.economy.ensure(ctx.guildId, user);
  const rejected = ctx.economy.add(ctx.guildId, user, 6, 'event', 'mod');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'cap');
  assert.equal(ctx.economy.get(ctx.guildId, user)?.cash, 5);
  const accepted = ctx.economy.add(ctx.guildId, user, 5, 'event', 'mod');
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.account.cash, 10);
});

test('removing more than the balance does nothing', () => {
  const { economy, store, guildId } = setup();
  const user = '200000000000000004';
  economy.ensure(guildId, user);
  const removed = economy.remove(guildId, user, 3, 'cash', 'correction', 'mod');
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.account.cash, 2);
  const tooMuch = economy.remove(guildId, user, 3, 'cash', 'correction', 'mod');
  assert.equal(tooMuch.ok, false);
  if (!tooMuch.ok) assert.equal(tooMuch.error, 'insufficient');
  assert.equal(economy.get(guildId, user)?.cash, 2);
  const reasons = store.recentLedger(guildId, user, 10).map((entry) => entry.reason);
  assert.equal(reasons.filter((reason) => reason === 'correction').length, 1);
});

test('deposit and withdraw move PlayBits between cash and bank', () => {
  const { economy, guildId } = setup();
  const user = '200000000000000005';
  economy.ensure(guildId, user);
  economy.add(guildId, user, 45, 'seed', 'mod');
  const deposited = economy.deposit(guildId, user, 20);
  assert.equal(deposited.ok, true);
  if (deposited.ok) {
    assert.equal(deposited.account.cash, 30);
    assert.equal(deposited.account.bank, 20);
  }
  const withdrawn = economy.withdraw(guildId, user, 'all');
  assert.equal(withdrawn.ok, true);
  if (withdrawn.ok) {
    assert.equal(withdrawn.account.cash, 50);
    assert.equal(withdrawn.account.bank, 0);
  }
});

test('the bank can be turned off', () => {
  const ctx = setup();
  ctx.config.economy.useBank = false;
  const result = ctx.economy.deposit(ctx.guildId, '200000000000000006', 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'bank_disabled');
});

test('leaderboard ranks by total PlayBits', () => {
  const { economy, store, guildId } = setup();
  store.setAccountBalance(guildId, '200000000000000011', 10, 0, 'import:set', 'mod');
  store.setAccountBalance(guildId, '200000000000000012', 5, 30, 'import:set', 'mod');
  store.setAccountBalance(guildId, '200000000000000010', 40, 0, 'import:set', 'mod');
  const board = economy.leaderboard(guildId, 10, 0);
  assert.deepEqual(board.rows.map((row) => row.userId), [
    '200000000000000010',
    '200000000000000012',
    '200000000000000011',
  ]);
  assert.equal(board.rows[1]?.total, 35);
});

test('every balance change is written to the ledger', () => {
  const { economy, store, guildId } = setup();
  const user = '200000000000000020';
  economy.ensure(guildId, user);
  economy.add(guildId, user, 10, 'manual', 'mod');
  economy.deposit(guildId, user, 4);
  const ledger = store.recentLedger(guildId, user, 10);
  assert.equal(ledger.length, 3);
  assert.ok(ledger.every((entry) => entry.cashAfter >= 0 && entry.bankAfter >= 0));
});
