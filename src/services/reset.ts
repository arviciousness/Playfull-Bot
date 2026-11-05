import type { AppConfig } from '../config.js';
import type { Account, Store, Ticket } from '../store.js';

export const TICKET_ROLE_KEYS = ['bronzeTicket', 'silverTicket', 'goldTicket', 'platinumTicket', 'diamondTicket'] as const;

export interface ResetPlan {
  expireTicketIds: number[];
  roleKeysToStrip: string[];
  nextWeekId: string;
  balances: { userId: string; cash: number; bank: number }[];
  balanceResetIgnored: boolean;
}

export function nextWeekId(weekId: string): string {
  const numeric = Number(weekId);
  if (Number.isInteger(numeric) && numeric > 0) return String(numeric + 1);
  return '1';
}

export function planWeeklyReset(input: {
  accounts: Account[];
  tickets: Ticket[];
  rolesToRemove: string[];
  rolesNeverRemove: string[];
  expireTickets: boolean;
  resetBalancesRequested: boolean;
  weekId: string;
}): ResetPlan {
  const never = new Set(input.rolesNeverRemove);
  const activityRoles = input.rolesToRemove.filter((roleKey) => !never.has(roleKey));
  const ticketRoles = input.expireTickets ? TICKET_ROLE_KEYS.filter((roleKey) => !never.has(roleKey)) : [];
  return {
    expireTicketIds: input.expireTickets ? input.tickets.filter((ticket) => ticket.status === 'active').map((ticket) => ticket.id) : [],
    roleKeysToStrip: [...new Set([...activityRoles, ...ticketRoles])],
    nextWeekId: nextWeekId(input.weekId),
    balances: input.accounts.map((account) => ({ userId: account.userId, cash: account.cash, bank: account.bank })),
    balanceResetIgnored: input.resetBalancesRequested,
  };
}

export interface AppliedReset {
  plan: ResetPlan;
  expiredTickets: number;
  expiredClaims: number;
  closedVoiceSegments: number;
  balances: { cash: number; bank: number; total: number };
}

/** Expires tickets, pending claims, and the week counter. Never writes a balance change. */
export function applyWeeklyReset(store: Store, config: AppConfig, guildId: string, now = Date.now()): AppliedReset {
  return store.transaction(() => {
    const week = store.getWeek(guildId);
    const plan = planWeeklyReset({
      accounts: store.listAccounts(guildId),
      tickets: store.listTickets(guildId),
      rolesToRemove: config.weeklyReset.rolesToRemove,
      rolesNeverRemove: config.weeklyReset.rolesNeverRemove,
      expireTickets: config.weeklyReset.expireTickets,
      resetBalancesRequested: false,
      weekId: week.weekId,
    });
    store.setTicketStatus(plan.expireTicketIds, 'expired', now);
    const expiredClaims = store.expirePendingClaims(guildId, now);
    const closedVoiceSegments = store.closeOpenVoiceSegments(guildId, null, now, true).length;
    store.setWeek(guildId, plan.nextWeekId, now);
    return {
      plan,
      expiredTickets: plan.expireTicketIds.length,
      expiredClaims,
      closedVoiceSegments,
      balances: store.sumBalances(guildId),
    };
  });
}
