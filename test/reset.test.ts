import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockBalanceReset } from '../src/config.js';
import { grantActivityReward } from '../src/services/activities.js';
import { applyWeeklyReset, planWeeklyReset } from '../src/services/reset.js';
import { setup } from './helpers.js';

test('weekly reset expires tickets and temporary roles without touching PlayBits', () => {
  const ctx = setup();
  const user = '200000000000000301';
  ctx.store.setAccountBalance(ctx.guildId, user, 12345, 67, 'import:set', null);
  ctx.store.insertTicket({
    guildId: ctx.guildId,
    userId: user,
    tierId: 'gold',
    weekId: '1',
    entries: 3,
    pricePaid: 130,
    status: 'active',
    createdAt: 1,
  });
  ctx.store.createClaim({
    guildId: ctx.guildId,
    userId: user,
    activityKey: 'trending',
    weekId: '1',
    status: 'pending',
    note: 'clip',
    createdAt: 1,
  });
  const approved = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.guildId,
    userId: user,
    activityKey: 'purchase',
    actorId: 'mod',
    note: 'receipt',
    preventSelf: true,
  });
  assert.equal(approved.ok, true);
  const balanceBefore = ctx.store.getAccount(ctx.guildId, user);
  const ledgerBefore = ctx.store.countLedger(ctx.guildId);
  const applied = applyWeeklyReset(ctx.store, ctx.config, ctx.guildId, 5_000);
  assert.equal(applied.expiredTickets, 1);
  assert.equal(applied.expiredClaims, 1);
  assert.deepEqual(ctx.store.getAccount(ctx.guildId, user), balanceBefore);
  assert.ok(applied.balances.total >= 12345);
  assert.equal(ctx.store.countLedger(ctx.guildId), ledgerBefore + 0);
  assert.equal(ctx.store.listTickets(ctx.guildId, user)[0]?.status, 'expired');
  assert.equal(ctx.store.getWeek(ctx.guildId).weekId, '2');
  const claims = [ctx.store.findOpenClaim(ctx.guildId, user, 'trending', '1'), ctx.store.findOpenClaim(ctx.guildId, user, 'purchase', '1')];
  assert.equal(claims[0], null);
  assert.equal(claims[1]?.status, 'approved');
  assert.ok(!applied.plan.roleKeysToStrip.includes('playfullPatron'));
  for (const role of ['trendHunter', 'gameCreator', 'partyLegend', 'playmaker', 'bronzeTicket', 'silverTicket', 'goldTicket', 'platinumTicket']) {
    assert.ok(applied.plan.roleKeysToStrip.includes(role), role);
  }
});

test('Playfull Patron is kept even if someone adds it to the removal list', () => {
  const plan = planWeeklyReset({
    accounts: [{ guildId: 'g', userId: 'u', cash: 9, bank: 1 }],
    tickets: [{ id: 4, guildId: 'g', userId: 'u', tierId: 'bronze', weekId: '1', entries: 1, pricePaid: 50, status: 'active', createdAt: 1 }],
    rolesToRemove: ['trendHunter', 'playfullPatron', 'playmaker'],
    rolesNeverRemove: ['playfullPatron'],
    expireTickets: true,
    resetBalancesRequested: true,
    weekId: '3',
  });
  assert.equal(plan.balanceResetIgnored, true);
  assert.deepEqual(plan.balances, [{ userId: 'u', cash: 9, bank: 1 }]);
  assert.equal(plan.nextWeekId, '4');
  assert.ok(!plan.roleKeysToStrip.includes('playfullPatron'));
  assert.deepEqual(plan.expireTicketIds, [4]);
});

test('the config loader refuses a weekly PlayBits wipe', () => {
  const { config } = setup();
  config.weeklyReset.resetBalances = true;
  const warnings: string[] = [];
  lockBalanceReset(config, (message) => warnings.push(message));
  assert.equal(config.weeklyReset.resetBalances, false);
  assert.equal(warnings.length, 1);
});

test('an approved activity can be claimed again next week, not twice this week', () => {
  const ctx = setup();
  const user = '200000000000000302';
  const first = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.guildId,
    userId: user,
    activityKey: 'gamenight',
    actorId: 'mod',
    note: 'attended',
    preventSelf: true,
  });
  const second = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.guildId,
    userId: user,
    activityKey: 'gamenight',
    actorId: 'mod',
    note: 'attended again',
    preventSelf: true,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, 'duplicate');
  applyWeeklyReset(ctx.store, ctx.config, ctx.guildId);
  const third = grantActivityReward(ctx.store, ctx.config, {
    guildId: ctx.guildId,
    userId: user,
    activityKey: 'gamenight',
    actorId: 'mod',
    note: 'next week',
    preventSelf: true,
  });
  assert.equal(third.ok, true);
  const account = ctx.store.getAccount(ctx.guildId, user);
  assert.equal(account?.cash, ctx.config.economy.startingBalance + 25 + 25);
  assert.equal(account?.bank, 0);
});
