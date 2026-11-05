import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveShop, type EffectiveShop } from '../src/config.js';
import { applyWeeklyReset } from '../src/services/reset.js';
import { activeEntryWeight, evaluatePurchase, purchaseTicket } from '../src/services/shop.js';
import { setup } from './helpers.js';

function shopFor(preset: string | null, patch?: Partial<EffectiveShop>): EffectiveShop {
  const { config } = setup();
  const resolved = resolveShop(config, preset
    ? { preset, enforcePurchaseLimit: null, oneTierOnly: null, higherReplacesLower: null, refundReplaced: null }
    : null);
  return { ...resolved, ...patch, tiers: patch?.tiers ?? resolved.tiers.map((tier) => ({ ...tier })) };
}

test('the standard preset matches the UnbelievaBoat shop', () => {
  const shop = shopFor(null);
  const prices = Object.fromEntries(shop.tiers.map((tier) => [tier.id, tier.price]));
  assert.deepEqual(prices, { bronze: 50, silver: 90, gold: 130, platinum: 170, diamond: 210 });
  assert.equal(shop.tiers.find((tier) => tier.id === 'diamond')?.enabled, false);
  assert.deepEqual(shop.tiers.find((tier) => tier.id === 'gold')?.requiredRoleKeys, ['partyLegend', 'playmaker']);
  assert.deepEqual(shop.tiers.find((tier) => tier.id === 'platinum')?.requiredRoleKeys, ['playfullPatron', 'serverBooster']);
  assert.equal(shop.enforcePurchaseLimit, true);
  assert.equal(shop.oneTierOnly, false);
});

test('buying bronze spends cash and a second bronze in the same week is rejected', () => {
  const ctx = setup();
  const user = '200000000000000101';
  ctx.store.setAccountBalance(ctx.guildId, user, 500, 80, 'import:set', null);
  const shop = shopFor(null);
  const first = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, []));
  assert.equal(first.ok, true);
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 450);
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.bank, 80);
  const second = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, []));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error, 'limit');
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 450);
});

test('cash in the bank does not pay for a ticket', () => {
  const ctx = setup();
  const user = '200000000000000102';
  ctx.store.setAccountBalance(ctx.guildId, user, 40, 100, 'import:set', null);
  const decision = evaluatePurchase({
    tierId: 'bronze',
    shop: shopFor(null),
    cash: 40,
    bank: 100,
    held: [],
    weekId: '1',
    memberRoleKeys: [],
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.error, 'insufficient_cash');
});

test('silver, gold, and platinum follow the shop role rules and stack', () => {
  const ctx = setup();
  const user = '200000000000000103';
  ctx.store.setAccountBalance(ctx.guildId, user, 1000, 0, 'import:set', null);
  const shop = shopFor(null);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'silver', shop, [])).ok, false);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'silver', shop, ['trendHunter'])).ok, true);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'gold', shop, ['trendHunter'])).ok, false);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'gold', shop, ['playmaker'])).ok, true);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'platinum', shop, ['playmaker'])).ok, false);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'platinum', shop, ['serverBooster'])).ok, true);
  const held = ctx.store.listTickets(ctx.guildId, user);
  assert.equal(activeEntryWeight(held, true), 9);
  assert.equal(activeEntryWeight(held, false), 4);
});

test('diamond stays disabled until it is turned on', () => {
  const ctx = setup();
  const user = '200000000000000104';
  ctx.store.setAccountBalance(ctx.guildId, user, 1000, 0, 'import:set', null);
  const disabled = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'diamond', shopFor(null), ['playfullPatron']));
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.error, 'disabled');
  const shop = shopFor(null);
  const diamond = shop.tiers.find((tier) => tier.id === 'diamond');
  if (diamond) diamond.enabled = true;
  const bought = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'diamond', shop, ['playfullPatron']));
  assert.equal(bought.ok, true);
});

test('lifting the purchase limit allows a second ticket of the same tier', () => {
  const ctx = setup();
  const user = '200000000000000105';
  ctx.store.setAccountBalance(ctx.guildId, user, 500, 0, 'import:set', null);
  const shop = shopFor(null, { enforcePurchaseLimit: false });
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, [])).ok, true);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, [])).ok, true);
  assert.equal(ctx.store.listTickets(ctx.guildId, user).filter((ticket) => ticket.status === 'active').length, 2);
});

test('launch week uses 10/30/50/100, requires verified, and a higher tier replaces a lower one', () => {
  const ctx = setup();
  const user = '200000000000000106';
  ctx.store.setAccountBalance(ctx.guildId, user, 100, 0, 'import:set', null);
  const shop = shopFor('launch-week');
  assert.equal(shop.tiers.find((tier) => tier.id === 'silver')?.price, 30);
  assert.equal(shop.oneTierOnly, true);
  assert.equal(shop.higherReplacesLower, true);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'gold', shop, [])).ok, false);
  assert.equal(purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, ['verified'])).ok, true);
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 90);
  const upgrade = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'silver', shop, ['verified']));
  assert.equal(upgrade.ok, true);
  if (upgrade.ok) {
    assert.equal(upgrade.refund, 0);
    assert.deepEqual(upgrade.removeTierIds, ['bronze']);
  }
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 60);
  const again = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, ['verified']));
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error, 'limit');
  const downgrade = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, ['verified']));
  assert.equal(downgrade.ok, false);
  const held = ctx.store.listTickets(ctx.guildId, user);
  assert.equal(activeEntryWeight(held, true), 2);
  assert.equal(held.filter((ticket) => ticket.status === 'active').map((ticket) => ticket.tierId).join(), 'silver');
});

test('a replaced ticket can refund when that switch is on', () => {
  const ctx = setup();
  const user = '200000000000000107';
  ctx.store.setAccountBalance(ctx.guildId, user, 100, 0, 'import:set', null);
  const shop = shopFor('launch-week', { refundReplacedTicket: true });
  purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, ['verified']));
  purchaseTicket(ctx.store, purchaseInput(ctx, user, 'silver', shop, ['verified']));
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 70);
});

test('the posted announcement preset is 10/19/28/37 with no role gates', () => {
  const shop = shopFor('posted-announcement');
  assert.deepEqual(shop.tiers.filter((tier) => tier.id !== 'diamond').map((tier) => tier.price), [10, 19, 28, 37]);
  assert.equal(shop.tiers.filter((tier) => tier.enabled).every((tier) => tier.requiredRoleKeys.length === 0), true);
  const decision = evaluatePurchase({
    tierId: 'gold',
    shop,
    cash: 28,
    bank: 0,
    held: [],
    weekId: '1',
    memberRoleKeys: [],
  });
  assert.equal(decision.ok, true);
});

test('after the weekly reset the same member can buy bronze again and only the purchase changes PlayBits', () => {
  const ctx = setup();
  const user = '200000000000000108';
  ctx.store.setAccountBalance(ctx.guildId, user, 100, 15, 'import:set', null);
  const shop = shopFor(null);
  purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, []));
  const before = ctx.store.sumBalances(ctx.guildId);
  const ledgerBefore = ctx.store.countLedger(ctx.guildId);
  applyWeeklyReset(ctx.store, ctx.config, ctx.guildId);
  const after = ctx.store.sumBalances(ctx.guildId);
  assert.deepEqual(after, before);
  assert.equal(ctx.store.countLedger(ctx.guildId), ledgerBefore);
  assert.equal(ctx.store.listTickets(ctx.guildId, user).every((ticket) => ticket.status === 'expired'), true);
  const next = purchaseTicket(ctx.store, purchaseInput(ctx, user, 'bronze', shop, []));
  assert.equal(next.ok, true);
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.cash, 0);
  assert.equal(ctx.store.getAccount(ctx.guildId, user)?.bank, 15);
});

function purchaseInput(
  ctx: ReturnType<typeof setup>,
  userId: string,
  tierId: string,
  shop: EffectiveShop,
  memberRoleKeys: string[],
) {
  return {
    guildId: ctx.guildId,
    userId,
    tierId,
    shop,
    memberRoleKeys,
    startingCash: ctx.config.economy.startingBalance,
    startingBank: 0,
    maxCash: ctx.config.economy.maxCash,
    maxBank: ctx.config.economy.maxBank,
  };
}
