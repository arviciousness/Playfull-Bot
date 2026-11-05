import type { EffectiveShop, TicketTier } from '../config.js';
import type { Store, Ticket, TicketStatus } from '../store.js';

export type PurchaseError =
  | 'unknown_tier'
  | 'disabled'
  | 'missing_role'
  | 'limit'
  | 'one_tier'
  | 'not_an_upgrade'
  | 'insufficient_cash';

export interface PurchaseDecision {
  ok: true;
  tier: TicketTier;
  price: number;
  refund: number;
  netCost: number;
  removeTicketIds: number[];
  removeTierIds: string[];
  created?: boolean;
}

export interface PurchaseRejection {
  ok: false;
  error: PurchaseError;
  tier?: TicketTier;
  cash: number;
  bank: number;
  requiredRoleKeys?: string[];
}

export type PurchaseOutcome = PurchaseDecision | PurchaseRejection;

const COUNTS_TOWARD_LIMIT: TicketStatus[] = ['active', 'replaced', 'expired'];

export function evaluatePurchase(input: {
  tierId: string;
  shop: EffectiveShop;
  cash: number;
  bank: number;
  held: Ticket[];
  weekId: string;
  memberRoleKeys: string[];
}): PurchaseOutcome {
  const tier = input.shop.tiers.find((item) => item.id === input.tierId);
  if (!tier) return { ok: false, error: 'unknown_tier', cash: input.cash, bank: input.bank };
  if (!tier.enabled) return { ok: false, error: 'disabled', tier, cash: input.cash, bank: input.bank };

  if (tier.requiredRoleKeys.length > 0 && !tier.requiredRoleKeys.some((key) => input.memberRoleKeys.includes(key))) {
    return {
      ok: false,
      error: 'missing_role',
      tier,
      cash: input.cash,
      bank: input.bank,
      requiredRoleKeys: tier.requiredRoleKeys,
    };
  }

  const purchasedThisWeek = input.held.filter(
    (ticket) => ticket.tierId === tier.id && ticket.weekId === input.weekId && COUNTS_TOWARD_LIMIT.includes(ticket.status),
  );
  if (input.shop.enforcePurchaseLimit && purchasedThisWeek.length >= 1) {
    return { ok: false, error: 'limit', tier, cash: input.cash, bank: input.bank };
  }

  const active = input.held.filter((ticket) => ticket.status === 'active');
  const order = input.shop.tiers.map((item) => item.id);
  const newRank = order.indexOf(tier.id);
  let remove: Ticket[] = [];
  if (active.length > 0 && (input.shop.oneTierOnly || input.shop.higherReplacesLower)) {
    const highest = Math.max(...active.map((ticket) => order.indexOf(ticket.tierId)));
    if (input.shop.higherReplacesLower && newRank > highest) {
      remove = active.filter((ticket) => order.indexOf(ticket.tierId) < newRank);
    } else if (input.shop.oneTierOnly) {
      return {
        ok: false,
        error: newRank <= highest ? 'not_an_upgrade' : 'one_tier',
        tier,
        cash: input.cash,
        bank: input.bank,
      };
    }
  }

  const refund = input.shop.refundReplacedTicket ? remove.reduce((sum, ticket) => sum + ticket.pricePaid, 0) : 0;
  const netCost = tier.price - refund;
  if (input.cash < netCost) {
    return { ok: false, error: 'insufficient_cash', tier, cash: input.cash, bank: input.bank };
  }

  return {
    ok: true,
    tier,
    price: tier.price,
    refund,
    netCost,
    removeTicketIds: remove.map((ticket) => ticket.id),
    removeTierIds: [...new Set(remove.map((ticket) => ticket.tierId))],
  };
}

export function purchaseTicket(
  store: Store,
  input: {
    guildId: string;
    userId: string;
    tierId: string;
    shop: EffectiveShop;
    memberRoleKeys: string[];
    startingCash: number;
    startingBank: number;
    maxCash: number | null;
    maxBank: number | null;
  },
): PurchaseOutcome {
  return store.transaction(() => {
    const ensured = store.ensureAccount(input.guildId, input.userId, input.startingCash, input.startingBank);
    const account = store.getAccount(input.guildId, input.userId);
    if (!account) {
      return { ok: false as const, error: 'insufficient_cash' as const, cash: 0, bank: 0 };
    }
    const week = store.getWeek(input.guildId);
    const decision = evaluatePurchase({
      tierId: input.tierId,
      shop: input.shop,
      cash: account.cash,
      bank: account.bank,
      held: store.listTickets(input.guildId, input.userId),
      weekId: week.weekId,
      memberRoleKeys: input.memberRoleKeys,
    });
    if (!decision.ok) return decision;

    const now = Date.now();
    if (decision.removeTicketIds.length > 0) {
      store.setTicketStatus(decision.removeTicketIds, 'replaced', now);
    }
    const balance = store.changeBalance({
      guildId: input.guildId,
      userId: input.userId,
      deltaCash: -decision.netCost,
      deltaBank: 0,
      reason: purchaseReason(decision),
      actorId: input.userId,
      allowCreate: false,
      startingCash: 0,
      startingBank: 0,
      maxCash: input.maxCash,
      maxBank: input.maxBank,
    });
    if (!balance.ok) {
      return { ok: false as const, error: 'insufficient_cash' as const, tier: decision.tier, cash: account.cash, bank: account.bank };
    }
    store.insertTicket({
      guildId: input.guildId,
      userId: input.userId,
      tierId: decision.tier.id,
      weekId: week.weekId,
      entries: decision.tier.entries,
      pricePaid: decision.tier.price,
      status: 'active',
      createdAt: now,
    });
    return { ...decision, created: ensured.created };
  });
}

export function revokeTicket(
  store: Store,
  input: {
    guildId: string;
    userId: string;
    tierId: string;
    refund: boolean;
    actorId: string;
    maxCash: number | null;
    maxBank: number | null;
  },
): { ok: true; refunded: number; roleKey: string | null } | { ok: false; error: 'none' } {
  return store.transaction(() => {
    const tickets = store.listTickets(input.guildId, input.userId).filter((ticket) => ticket.tierId === input.tierId && ticket.status === 'active');
    const ticket = tickets[tickets.length - 1];
    if (!ticket) return { ok: false as const, error: 'none' as const };
    store.setTicketStatus([ticket.id], 'revoked', Date.now());
    if (input.refund && ticket.pricePaid > 0) {
      store.changeBalance({
        guildId: input.guildId,
        userId: input.userId,
        deltaCash: ticket.pricePaid,
        deltaBank: 0,
        reason: `refund:${ticket.tierId}`,
        actorId: input.actorId,
        allowCreate: true,
        startingCash: 0,
        startingBank: 0,
        maxCash: input.maxCash,
        maxBank: input.maxBank,
      });
    }
    return { ok: true as const, refunded: input.refund ? ticket.pricePaid : 0, roleKey: null };
  });
}

function purchaseReason(decision: PurchaseDecision): string {
  const replaced = decision.removeTierIds.length > 0 ? ` (replaced ${decision.removeTierIds.join(', ')})` : '';
  const refund = decision.refund > 0 ? `, refund ${decision.refund}` : '';
  return `shop:${decision.tier.id} for ${decision.price}${replaced}${refund}`;
}

export function activeEntryWeight(tickets: Ticket[], stackEntries: boolean): number {
  const active = tickets.filter((ticket) => ticket.status === 'active' && ticket.entries > 0);
  if (active.length === 0) return 0;
  if (!stackEntries) return Math.max(...active.map((ticket) => ticket.entries));
  return active.reduce((sum, ticket) => sum + ticket.entries, 0);
}
