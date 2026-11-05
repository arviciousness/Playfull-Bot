import { randomInt } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Giveaway, Store } from '../store.js';
import { drawWinner, type WeightedEntry } from './draw.js';
import { activeEntryWeight } from './shop.js';

export function cryptoRngInt(exclusiveMax: number): number {
  return randomInt(0, exclusiveMax);
}

export function entryWeights(store: Store, giveaway: Giveaway, stackEntries: boolean): WeightedEntry[] {
  return store.listEntries(giveaway.id).map((entry) => ({
    userId: entry.userId,
    weight: activeEntryWeight(store.listTickets(giveaway.guildId, entry.userId), stackEntries),
  }));
}

export function drawGiveaway(
  store: Store,
  config: AppConfig,
  giveawayId: number,
  rngInt: (exclusiveMax: number) => number = cryptoRngInt,
):
  | { ok: true; giveaway: Giveaway; winnerId: string | null; weights: WeightedEntry[] }
  | { ok: false; error: 'missing' | 'not_active'; giveaway: Giveaway | null } {
  return store.transaction(() => {
    const existing = store.getGiveaway(giveawayId);
    if (!existing) return { ok: false as const, error: 'missing' as const, giveaway: null };
    if (existing.status === 'ended' || existing.status === 'cancelled') {
      return { ok: false as const, error: 'not_active' as const, giveaway: existing };
    }
    if (existing.status === 'active' && !store.tryBeginDraw(giveawayId)) {
      return { ok: false as const, error: 'not_active' as const, giveaway: store.getGiveaway(giveawayId) };
    }
    const giveaway = store.getGiveaway(giveawayId);
    if (!giveaway) return { ok: false as const, error: 'missing' as const, giveaway: null };
    const weights = entryWeights(store, giveaway, config.giveaway.stackEntries);
    const exclude = new Set(store.listWinners(giveawayId).map((winner) => winner.userId));
    const winner = drawWinner(weights, exclude, rngInt);
    const now = Date.now();
    store.finishDraw(giveawayId, winner?.userId ?? null, now);
    if (winner) store.addWinner(giveawayId, winner.userId, winner.weight, false, now);
    return { ok: true as const, giveaway: store.getGiveaway(giveawayId) ?? giveaway, winnerId: winner?.userId ?? null, weights };
  });
}

export function rerollGiveaway(
  store: Store,
  config: AppConfig,
  giveawayId: number,
  rngInt: (exclusiveMax: number) => number = cryptoRngInt,
):
  | { ok: true; winnerId: string; weight: number }
  | { ok: false; error: 'missing' | 'not_ended' | 'no_eligible' } {
  return store.transaction(() => {
    const giveaway = store.getGiveaway(giveawayId);
    if (!giveaway) return { ok: false as const, error: 'missing' as const };
    if (giveaway.status !== 'ended') return { ok: false as const, error: 'not_ended' as const };
    const weights = entryWeights(store, giveaway, config.giveaway.stackEntries);
    const exclude = new Set(store.listWinners(giveawayId).map((winner) => winner.userId));
    const winner = drawWinner(weights, exclude, rngInt);
    if (!winner) return { ok: false as const, error: 'no_eligible' as const };
    store.setWinner(giveawayId, winner.userId);
    store.addWinner(giveawayId, winner.userId, winner.weight, true, Date.now());
    return { ok: true as const, winnerId: winner.userId, weight: winner.weight };
  });
}
