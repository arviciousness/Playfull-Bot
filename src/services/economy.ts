import type { AppConfig } from '../config.js';
import type { Account, Store } from '../store.js';
import { isPositiveInt } from '../util.js';

export type EconomyError = 'invalid_amount' | 'bank_disabled' | 'insufficient' | 'cap' | 'missing' | 'empty';

export interface EconomySuccess {
  ok: true;
  account: Account;
  ledgerId: number | null;
  created: boolean;
}

export interface EconomyFailure {
  ok: false;
  error: EconomyError;
  account: Account | null;
}

export type EconomyResult = EconomySuccess | EconomyFailure;

export class Economy {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  get currencyName(): string {
    return this.config.economy.currencyName;
  }

  ensure(guildId: string, userId: string): Account {
    const { startingCash, startingBank } = this.startingAmounts();
    return this.store.ensureAccount(guildId, userId, startingCash, startingBank).account;
  }

  get(guildId: string, userId: string): Account | null {
    return this.store.getAccount(guildId, userId);
  }

  add(guildId: string, userId: string, amount: number, reason: string, actorId: string | null): EconomyResult {
    if (!isPositiveInt(amount)) return { ok: false, error: 'invalid_amount', account: null };
    return this.change(guildId, userId, amount, 0, reason, actorId, true);
  }

  remove(
    guildId: string,
    userId: string,
    amount: number,
    bucket: 'cash' | 'bank',
    reason: string,
    actorId: string | null,
  ): EconomyResult {
    if (!isPositiveInt(amount)) return { ok: false, error: 'invalid_amount', account: null };
    if (bucket === 'bank' && !this.config.economy.useBank) {
      return { ok: false, error: 'bank_disabled', account: this.store.getAccount(guildId, userId) };
    }
    const deltaCash = bucket === 'cash' ? -amount : 0;
    const deltaBank = bucket === 'bank' ? -amount : 0;
    return this.change(guildId, userId, deltaCash, deltaBank, reason, actorId, false);
  }

  deposit(guildId: string, userId: string, amount: number | 'all'): EconomyResult {
    if (!this.config.economy.useBank) return { ok: false, error: 'bank_disabled', account: this.store.getAccount(guildId, userId) };
    const account = this.ensure(guildId, userId);
    const moving = amount === 'all' ? account.cash : amount;
    if (!isPositiveInt(moving)) return { ok: false, error: amount === 'all' ? 'empty' : 'invalid_amount', account };
    return this.change(guildId, userId, -moving, moving, 'deposit', userId, false);
  }

  withdraw(guildId: string, userId: string, amount: number | 'all'): EconomyResult {
    if (!this.config.economy.useBank) return { ok: false, error: 'bank_disabled', account: this.store.getAccount(guildId, userId) };
    const account = this.ensure(guildId, userId);
    const moving = amount === 'all' ? account.bank : amount;
    if (!isPositiveInt(moving)) return { ok: false, error: amount === 'all' ? 'empty' : 'invalid_amount', account };
    return this.change(guildId, userId, moving, -moving, 'withdraw', userId, false);
  }

  leaderboard(guildId: string, limit: number, offset: number) {
    return {
      rows: this.store.leaderboard(guildId, limit, offset),
      totalMembers: this.store.countAccounts(guildId),
    };
  }

  private startingAmounts(): { startingCash: number; startingBank: number } {
    const amount = this.config.economy.startingBalance;
    if (this.config.economy.startingBucket === 'bank') return { startingCash: 0, startingBank: amount };
    return { startingCash: amount, startingBank: 0 };
  }

  private change(
    guildId: string,
    userId: string,
    deltaCash: number,
    deltaBank: number,
    reason: string,
    actorId: string | null,
    allowCreate: boolean,
  ): EconomyResult {
    const starting = this.startingAmounts();
    const result = this.store.changeBalance({
      guildId,
      userId,
      deltaCash,
      deltaBank,
      reason,
      actorId,
      allowCreate,
      startingCash: allowCreate ? starting.startingCash : 0,
      startingBank: allowCreate ? starting.startingBank : 0,
      maxCash: this.config.economy.maxCash,
      maxBank: this.config.economy.maxBank,
    });
    if (!result.ok) return result;
    return result;
  }
}
