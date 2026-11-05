import type { AppConfig } from '../config.js';
import type { Store } from '../store.js';

export type GrantError = 'unknown' | 'self' | 'duplicate';

export function grantActivityReward(
  store: Store,
  config: AppConfig,
  input: {
    guildId: string;
    userId: string;
    activityKey: string;
    actorId: string | null;
    note: string;
    preventSelf: boolean;
  },
):
  | { ok: true; reward: number; roleKey: string; claimId: number; label: string; created: boolean }
  | { ok: false; error: GrantError; label?: string } {
  const activity = config.activities[input.activityKey];
  if (!activity) return { ok: false, error: 'unknown' };
  if (input.preventSelf && input.actorId && input.actorId === input.userId) {
    return { ok: false, error: 'self', label: activity.label };
  }
  return store.transaction(() => {
    const week = store.getWeek(input.guildId);
    const existing = store.findOpenClaim(input.guildId, input.userId, input.activityKey, week.weekId);
    if (existing?.status === 'approved') return { ok: false as const, error: 'duplicate' as const, label: activity.label };
    const balance = store.changeBalance({
      guildId: input.guildId,
      userId: input.userId,
      deltaCash: activity.reward,
      deltaBank: 0,
      reason: `activity:${input.activityKey}`,
      actorId: input.actorId,
      allowCreate: true,
      startingCash: config.economy.startingBucket === 'cash' ? config.economy.startingBalance : 0,
      startingBank: config.economy.startingBucket === 'bank' ? config.economy.startingBalance : 0,
      maxCash: config.economy.maxCash,
      maxBank: config.economy.maxBank,
    });
    if (!balance.ok) return { ok: false as const, error: 'unknown' as const, label: activity.label };
    const created = balance.created;
    let claimId: number;
    if (existing?.status === 'pending') {
      store.resolveClaim(existing.id, 'approved', input.actorId, input.note);
      claimId = existing.id;
    } else {
      const inserted = store.createClaim({
        guildId: input.guildId,
        userId: input.userId,
        activityKey: input.activityKey,
        weekId: week.weekId,
        status: 'approved',
        note: input.note,
        reviewerId: input.actorId,
        reviewNote: input.note,
        createdAt: Date.now(),
        resolvedAt: Date.now(),
      });
      if (!inserted.ok) return { ok: false as const, error: 'duplicate' as const, label: activity.label };
      claimId = inserted.id;
    }
    return { ok: true as const, reward: activity.reward, roleKey: activity.roleKey, claimId, label: activity.label, created };
  });
}
