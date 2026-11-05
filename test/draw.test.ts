import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawWinner, totalWeight, weightedPick, type WeightedEntry } from '../src/services/draw.js';
import { drawGiveaway, rerollGiveaway } from '../src/services/giveaway.js';
import { activeEntryWeight } from '../src/services/shop.js';
import { setup } from './helpers.js';

const entries: WeightedEntry[] = [
  { userId: 'bronze', weight: 1 },
  { userId: 'silver', weight: 2 },
  { userId: 'gold', weight: 3 },
  { userId: 'platinum', weight: 4 },
];

test('the draw walks ticket weights from the start of the range', () => {
  assert.equal(weightedPick(entries, () => 0)?.userId, 'bronze');
  assert.equal(weightedPick(entries, () => 1)?.userId, 'silver');
  assert.equal(weightedPick(entries, () => 3)?.userId, 'gold');
  assert.equal(weightedPick(entries, () => 9)?.userId, 'platinum');
  assert.equal(totalWeight(entries), 10);
});

test('zero, negative, and empty weights never win', () => {
  assert.equal(weightedPick([{ userId: 'a', weight: 0 }, { userId: 'b', weight: -2 }], () => 0), null);
  assert.equal(weightedPick([], () => 0), null);
  assert.equal(drawWinner(entries, new Set(['bronze', 'silver', 'gold', 'platinum']), () => 0), null);
});

test('a reroll excludes previous winners', () => {
  const winner = drawWinner(entries, new Set(['bronze', 'silver']), () => 0);
  assert.equal(winner?.userId, 'gold');
});

test('many draws follow the ticket weights', () => {
  let seed = 1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const counts = new Map<string, number>();
  const total = 8000;
  for (let index = 0; index < total; index += 1) {
    const winner = weightedPick(entries, (max) => Math.floor(random() * max));
    counts.set(winner?.userId ?? 'none', (counts.get(winner?.userId ?? 'none') ?? 0) + 1);
  }
  assert.ok(Math.abs((counts.get('bronze') ?? 0) / total - 0.1) < 0.03);
  assert.ok(Math.abs((counts.get('platinum') ?? 0) / total - 0.4) < 0.03);
  assert.equal(counts.get('none') ?? 0, 0);
});

test('stacked tickets are the weight used at draw time, and a reroll skips the first winner', () => {
  const ctx = setup();
  const entrant = '200000000000000201';
  const other = '200000000000000202';
  ctx.store.setAccountBalance(ctx.guildId, entrant, 0, 0, 'import:set', null);
  ctx.store.insertTicket({
    guildId: ctx.guildId,
    userId: entrant,
    tierId: 'bronze',
    weekId: '1',
    entries: 1,
    pricePaid: 50,
    status: 'active',
    createdAt: 1,
  });
  ctx.store.insertTicket({
    guildId: ctx.guildId,
    userId: entrant,
    tierId: 'gold',
    weekId: '1',
    entries: 3,
    pricePaid: 130,
    status: 'active',
    createdAt: 2,
  });
  ctx.store.insertTicket({
    guildId: ctx.guildId,
    userId: other,
    tierId: 'silver',
    weekId: '1',
    entries: 2,
    pricePaid: 90,
    status: 'active',
    createdAt: 3,
  });
  assert.equal(activeEntryWeight(ctx.store.listTickets(ctx.guildId, entrant), true), 4);
  const giveawayId = ctx.store.createGiveaway({
    guildId: ctx.guildId,
    prize: 'Test Game',
    winnerMessage: 'Hi {winner}',
    channelId: '300000000000000001',
    endsAt: Date.now() - 1000,
    createdBy: 'mod',
  });
  ctx.store.addEntry(giveawayId, entrant, 1);
  ctx.store.addEntry(giveawayId, other, 2);
  const drawn = drawGiveaway(ctx.store, ctx.config, giveawayId, () => 0);
  assert.equal(drawn.ok, true);
  if (drawn.ok) assert.equal(drawn.winnerId, entrant);
  const again = rerollGiveaway(ctx.store, ctx.config, giveawayId, () => 0);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.winnerId, other);
  const noneLeft = rerollGiveaway(ctx.store, ctx.config, giveawayId, () => 0);
  assert.equal(noneLeft.ok, false);
  if (!noneLeft.ok) assert.equal(noneLeft.error, 'no_eligible');
});
