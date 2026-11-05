import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite from 'better-sqlite3';
import type { RuntimeFlags } from './config.js';

export type TicketStatus = 'active' | 'replaced' | 'expired' | 'revoked';
export type ClaimStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Account {
  guildId: string;
  userId: string;
  cash: number;
  bank: number;
}

export interface LedgerEntry {
  id: number;
  guildId: string;
  userId: string;
  deltaCash: number;
  deltaBank: number;
  cashAfter: number;
  bankAfter: number;
  reason: string;
  actorId: string | null;
  createdAt: number;
}

export interface Ticket {
  id: number;
  guildId: string;
  userId: string;
  tierId: string;
  weekId: string;
  entries: number;
  pricePaid: number;
  status: TicketStatus;
  createdAt: number;
}

export interface Claim {
  id: number;
  guildId: string;
  userId: string;
  activityKey: string;
  weekId: string;
  status: ClaimStatus;
  note: string;
  reviewerId: string | null;
  reviewNote: string | null;
  channelId: string | null;
  messageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface VoiceSegment {
  id: number;
  guildId: string;
  userId: string;
  channelId: string;
  weekId: string;
  startedAt: number;
  endedAt: number | null;
  seconds: number;
}

export interface Giveaway {
  id: number;
  guildId: string;
  prize: string;
  winnerMessage: string;
  channelId: string;
  messageId: string | null;
  threadId: string | null;
  eventsMessageId: string | null;
  endsAt: number;
  status: 'active' | 'drawing' | 'ended' | 'cancelled';
  winnerId: string | null;
  createdBy: string;
  createdAt: number;
  endedAt: number | null;
  announceClaimed: number;
}

export interface GiveawayEntry {
  giveawayId: number;
  userId: string;
  enteredAt: number;
}

export interface BalanceChangeInput {
  guildId: string;
  userId: string;
  deltaCash: number;
  deltaBank: number;
  reason: string;
  actorId: string | null;
  allowCreate: boolean;
  startingCash: number;
  startingBank: number;
  maxCash: number | null;
  maxBank: number | null;
}

export type BalanceChangeResult =
  | { ok: true; account: Account; ledgerId: number | null; created: boolean }
  | { ok: false; error: 'missing' | 'insufficient' | 'cap'; account: Account | null };

export class Store {
  readonly db: BetterSqlite.Database;

  constructor(db: BetterSqlite.Database) {
    this.db = db;
    migrate(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getAccount(guildId: string, userId: string): Account | null {
    const row = this.db
      .prepare('SELECT guild_id, user_id, cash, bank FROM accounts WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as AccountRow | undefined;
    return row ? mapAccount(row) : null;
  }

  /** Creates the account with the starting balance when it does not exist. Imported accounts are left alone. */
  ensureAccount(guildId: string, userId: string, startingCash: number, startingBank: number): { account: Account; created: boolean } {
    return this.transaction(() => {
      const existing = this.getAccount(guildId, userId);
      if (existing) return { account: existing, created: false };
      const now = Date.now();
      this.db
        .prepare('INSERT INTO accounts (guild_id, user_id, cash, bank, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, userId, startingCash, startingBank, now);
      if (startingCash !== 0 || startingBank !== 0) {
        this.insertLedger({
          guildId,
          userId,
          deltaCash: startingCash,
          deltaBank: startingBank,
          cashAfter: startingCash,
          bankAfter: startingBank,
          reason: 'starting-balance',
          actorId: null,
          createdAt: now,
        });
      }
      return {
        account: { guildId, userId, cash: startingCash, bank: startingBank },
        created: true,
      };
    });
  }

  changeBalance(input: BalanceChangeInput): BalanceChangeResult {
    return this.transaction(() => {
      let account = this.getAccount(input.guildId, input.userId);
      let created = false;
      if (!account) {
        if (!input.allowCreate) return { ok: false, error: 'missing', account: null };
        const ensured = this.ensureAccount(input.guildId, input.userId, input.startingCash, input.startingBank);
        account = ensured.account;
        created = ensured.created;
      }
      const cash = account.cash + input.deltaCash;
      const bank = account.bank + input.deltaBank;
      if (cash < 0 || bank < 0) return { ok: false, error: 'insufficient', account };
      if (
        (input.maxCash !== null && cash > input.maxCash) ||
        (input.maxBank !== null && bank > input.maxBank)
      ) {
        return { ok: false, error: 'cap', account };
      }
      if (input.deltaCash === 0 && input.deltaBank === 0) {
        return { ok: true, account, ledgerId: null, created };
      }
      const now = Date.now();
      this.db
        .prepare('UPDATE accounts SET cash = ?, bank = ? WHERE guild_id = ? AND user_id = ?')
        .run(cash, bank, input.guildId, input.userId);
      const ledgerId = this.insertLedger({
        guildId: input.guildId,
        userId: input.userId,
        deltaCash: input.deltaCash,
        deltaBank: input.deltaBank,
        cashAfter: cash,
        bankAfter: bank,
        reason: input.reason,
        actorId: input.actorId,
        createdAt: now,
      });
      return { ok: true, account: { ...account, cash, bank }, ledgerId, created };
    });
  }

  /** Sets absolute balances for an import. New rows do not also receive the starting balance. */
  setAccountBalance(
    guildId: string,
    userId: string,
    cash: number,
    bank: number,
    reason: string,
    actorId: string | null,
  ): Account {
    return this.transaction(() => {
      const existing = this.getAccount(guildId, userId);
      const now = Date.now();
      if (!existing) {
        this.db
          .prepare('INSERT INTO accounts (guild_id, user_id, cash, bank, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(guildId, userId, cash, bank, now);
        this.insertLedger({
          guildId,
          userId,
          deltaCash: cash,
          deltaBank: bank,
          cashAfter: cash,
          bankAfter: bank,
          reason,
          actorId,
          createdAt: now,
        });
        return { guildId, userId, cash, bank };
      }
      const deltaCash = cash - existing.cash;
      const deltaBank = bank - existing.bank;
      if (deltaCash !== 0 || deltaBank !== 0) {
        this.db
          .prepare('UPDATE accounts SET cash = ?, bank = ? WHERE guild_id = ? AND user_id = ?')
          .run(cash, bank, guildId, userId);
        this.insertLedger({
          guildId,
          userId,
          deltaCash,
          deltaBank,
          cashAfter: cash,
          bankAfter: bank,
          reason,
          actorId,
          createdAt: now,
        });
      }
      return { guildId, userId, cash, bank };
    });
  }

  leaderboard(guildId: string, limit: number, offset: number): { userId: string; cash: number; bank: number; total: number }[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, cash, bank, (cash + bank) AS total
         FROM accounts WHERE guild_id = ?
         ORDER BY total DESC, user_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(guildId, limit, offset) as { user_id: string; cash: number; bank: number; total: number }[];
    return rows.map((row) => ({ userId: row.user_id, cash: row.cash, bank: row.bank, total: row.total }));
  }

  countAccounts(guildId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE guild_id = ?').get(guildId) as { n: number };
    return row.n;
  }

  sumBalances(guildId: string): { cash: number; bank: number; total: number } {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cash), 0) AS cash, COALESCE(SUM(bank), 0) AS bank FROM accounts WHERE guild_id = ?')
      .get(guildId) as { cash: number; bank: number };
    return { cash: row.cash, bank: row.bank, total: row.cash + row.bank };
  }

  listAccounts(guildId: string): Account[] {
    const rows = this.db
      .prepare('SELECT guild_id, user_id, cash, bank FROM accounts WHERE guild_id = ? ORDER BY user_id ASC')
      .all(guildId) as AccountRow[];
    return rows.map(mapAccount);
  }

  recentLedger(guildId: string, userId: string, limit: number): LedgerEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, guild_id, user_id, delta_cash, delta_bank, cash_after, bank_after, reason, actor_id, created_at
         FROM ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(guildId, userId, limit) as LedgerRow[];
    return rows.map(mapLedger);
  }

  countLedger(guildId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE guild_id = ?').get(guildId) as { n: number };
    return row.n;
  }

  getWeek(guildId: string): { weekId: string; startedAt: number } {
    const row = this.db.prepare('SELECT week_id, started_at FROM weeks WHERE guild_id = ?').get(guildId) as
      | { week_id: string; started_at: number }
      | undefined;
    if (row) return { weekId: row.week_id, startedAt: row.started_at };
    const startedAt = Date.now();
    this.db.prepare('INSERT INTO weeks (guild_id, week_id, started_at) VALUES (?, ?, ?)').run(guildId, '1', startedAt);
    return { weekId: '1', startedAt };
  }

  setWeek(guildId: string, weekId: string, startedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO weeks (guild_id, week_id, started_at) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET week_id = excluded.week_id, started_at = excluded.started_at`,
      )
      .run(guildId, weekId, startedAt);
  }

  listTickets(guildId: string, userId?: string): Ticket[] {
    const rows = userId
      ? (this.db
          .prepare(
            `SELECT id, guild_id, user_id, tier_id, week_id, entries, price_paid, status, created_at
             FROM tickets WHERE guild_id = ? AND user_id = ? ORDER BY id ASC`,
          )
          .all(guildId, userId) as TicketRow[])
      : (this.db
          .prepare(
            `SELECT id, guild_id, user_id, tier_id, week_id, entries, price_paid, status, created_at
             FROM tickets WHERE guild_id = ? ORDER BY id ASC`,
          )
          .all(guildId) as TicketRow[]);
    return rows.map(mapTicket);
  }

  insertTicket(ticket: Omit<Ticket, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO tickets (guild_id, user_id, tier_id, week_id, entries, price_paid, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticket.guildId,
        ticket.userId,
        ticket.tierId,
        ticket.weekId,
        ticket.entries,
        ticket.pricePaid,
        ticket.status,
        ticket.createdAt,
        ticket.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  setTicketStatus(ids: number[], status: TicketStatus, at: number): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?');
    for (const id of ids) statement.run(status, at, id);
  }

  getRuntime(guildId: string): RuntimeFlags | null {
    const row = this.db
      .prepare(
        `SELECT preset, enforce_purchase_limit, one_tier_only, higher_replaces_lower, refund_replaced
         FROM runtime WHERE guild_id = ?`,
      )
      .get(guildId) as
      | {
          preset: string | null;
          enforce_purchase_limit: number | null;
          one_tier_only: number | null;
          higher_replaces_lower: number | null;
          refund_replaced: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      preset: row.preset,
      enforcePurchaseLimit: row.enforce_purchase_limit === null ? null : row.enforce_purchase_limit === 1,
      oneTierOnly: row.one_tier_only === null ? null : row.one_tier_only === 1,
      higherReplacesLower: row.higher_replaces_lower === null ? null : row.higher_replaces_lower === 1,
      refundReplaced: row.refund_replaced === null ? null : row.refund_replaced === 1,
    };
  }

  setPreset(guildId: string, preset: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime (guild_id, preset, enforce_purchase_limit, one_tier_only, higher_replaces_lower, refund_replaced, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           preset = excluded.preset,
           enforce_purchase_limit = NULL,
           one_tier_only = NULL,
           higher_replaces_lower = NULL,
           refund_replaced = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(guildId, preset, Date.now());
  }

  setPurchaseLimit(guildId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO runtime (guild_id, preset, enforce_purchase_limit, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET enforce_purchase_limit = excluded.enforce_purchase_limit, updated_at = excluded.updated_at`,
      )
      .run(guildId, enabled ? 1 : 0, Date.now());
  }

  createClaim(claim: Omit<Claim, 'id' | 'reviewerId' | 'reviewNote' | 'resolvedAt' | 'channelId' | 'messageId'> & {
    channelId?: string | null;
    messageId?: string | null;
    reviewerId?: string | null;
    reviewNote?: string | null;
    resolvedAt?: number | null;
  }): { ok: true; id: number } | { ok: false; error: 'duplicate'; status: ClaimStatus } {
    const open = this.findOpenClaim(claim.guildId, claim.userId, claim.activityKey, claim.weekId);
    if (open) return { ok: false, error: 'duplicate', status: open.status };
    try {
      const result = this.db
        .prepare(
          `INSERT INTO claims (
             guild_id, user_id, activity_key, week_id, status, note, reviewer_id, review_note, channel_id, message_id, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.guildId,
          claim.userId,
          claim.activityKey,
          claim.weekId,
          claim.status,
          claim.note,
          claim.reviewerId ?? null,
          claim.reviewNote ?? null,
          claim.channelId ?? null,
          claim.messageId ?? null,
          claim.createdAt,
          claim.resolvedAt ?? null,
        );
      return { ok: true, id: Number(result.lastInsertRowid) };
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const again = this.findOpenClaim(claim.guildId, claim.userId, claim.activityKey, claim.weekId);
        return { ok: false, error: 'duplicate', status: again?.status ?? 'pending' };
      }
      throw error;
    }
  }

  getClaim(id: number): Claim | null {
    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as ClaimRow | undefined;
    return row ? mapClaim(row) : null;
  }

  findOpenClaim(guildId: string, userId: string, activityKey: string, weekId: string): Claim | null {
    const row = this.db
      .prepare(
        `SELECT * FROM claims
         WHERE guild_id = ? AND user_id = ? AND activity_key = ? AND week_id = ? AND status IN ('pending', 'approved')`,
      )
      .get(guildId, userId, activityKey, weekId) as ClaimRow | undefined;
    return row ? mapClaim(row) : null;
  }

  setClaimMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare('UPDATE claims SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, id);
  }

  resolveClaim(id: number, status: 'approved' | 'denied' | 'expired', reviewerId: string | null, reviewNote: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE claims SET status = ?, reviewer_id = ?, review_note = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, reviewerId, reviewNote, Date.now(), id);
    return result.changes === 1;
  }

  expirePendingClaims(guildId: string, at: number): number {
    const result = this.db
      .prepare(`UPDATE claims SET status = 'expired', resolved_at = ?, review_note = 'week ended' WHERE guild_id = ? AND status = 'pending'`)
      .run(at, guildId);
    return result.changes;
  }

  openVoiceSegment(segment: Omit<VoiceSegment, 'id' | 'endedAt' | 'seconds'>): number {
    const existing = this.db
      .prepare('SELECT id FROM voice_segments WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL')
      .get(segment.guildId, segment.userId) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = this.db
      .prepare(
        `INSERT INTO voice_segments (guild_id, user_id, channel_id, week_id, started_at, ended_at, seconds)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      )
      .run(segment.guildId, segment.userId, segment.channelId, segment.weekId, segment.startedAt);
    return Number(result.lastInsertRowid);
  }

  closeOpenVoiceSegments(guildId: string, userId: string | null, at: number, creditTail: boolean): number[] {
    const rows = userId
      ? (this.db
          .prepare('SELECT id, started_at, seconds FROM voice_segments WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL')
          .all(guildId, userId) as { id: number; started_at: number; seconds: number }[])
      : (this.db
          .prepare('SELECT id, started_at, seconds FROM voice_segments WHERE guild_id = ? AND ended_at IS NULL')
          .all(guildId) as { id: number; started_at: number; seconds: number }[]);
    const update = this.db.prepare('UPDATE voice_segments SET ended_at = ?, seconds = ? WHERE id = ?');
    const ids: number[] = [];
    for (const row of rows) {
      const tail = creditTail ? Math.max(0, Math.floor((at - row.started_at) / 1000)) : 0;
      update.run(at, row.seconds + tail, row.id);
      ids.push(row.id);
    }
    return ids;
  }

  listOpenVoice(guildId: string): { userId: string; channelId: string }[] {
    const rows = this.db
      .prepare('SELECT user_id, channel_id FROM voice_segments WHERE guild_id = ? AND ended_at IS NULL')
      .all(guildId) as { user_id: string; channel_id: string }[];
    return rows.map((row) => ({ userId: row.user_id, channelId: row.channel_id }));
  }

  heartbeatVoice(guildId: string, at: number): void {
    const rows = this.db
      .prepare('SELECT id, started_at, seconds FROM voice_segments WHERE guild_id = ? AND ended_at IS NULL')
      .all(guildId) as { id: number; started_at: number; seconds: number }[];
    const update = this.db.prepare('UPDATE voice_segments SET started_at = ?, seconds = ? WHERE id = ?');
    for (const row of rows) {
      const add = Math.max(0, Math.floor((at - row.started_at) / 1000));
      if (add <= 0) continue;
      update.run(at, row.seconds + add, row.id);
    }
  }

  /**
   * After a restart, keep confirmed seconds and drop the gap while the process was down.
   * Members no longer in a counted channel have their segment closed without that gap.
   */
  settleVoiceOnStartup(guildId: string, at: number, stillPresent: Set<string>): void {
    const rows = this.db
      .prepare('SELECT id, user_id, seconds FROM voice_segments WHERE guild_id = ? AND ended_at IS NULL')
      .all(guildId) as { id: number; user_id: string; seconds: number }[];
    const resume = this.db.prepare('UPDATE voice_segments SET started_at = ? WHERE id = ?');
    const close = this.db.prepare('UPDATE voice_segments SET ended_at = ?, seconds = ? WHERE id = ?');
    for (const row of rows) {
      if (stillPresent.has(row.user_id)) resume.run(at, row.id);
      else close.run(at, row.seconds, row.id);
    }
  }

  listVoiceSegments(guildId: string, weekId: string): VoiceSegment[] {
    const rows = this.db
      .prepare(
        `SELECT id, guild_id, user_id, channel_id, week_id, started_at, ended_at, seconds
         FROM voice_segments WHERE guild_id = ? AND week_id = ? ORDER BY id ASC`,
      )
      .all(guildId, weekId) as VoiceSegmentRow[];
    return rows.map(mapVoice);
  }

  createGiveaway(input: {
    guildId: string;
    prize: string;
    winnerMessage: string;
    channelId: string;
    endsAt: number;
    createdBy: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO giveaways (
           guild_id, prize, winner_message, channel_id, ends_at, status, created_by, created_at, announce_claimed
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0)`,
      )
      .run(input.guildId, input.prize, input.winnerMessage, input.channelId, input.endsAt, input.createdBy, Date.now());
    return Number(result.lastInsertRowid);
  }

  getGiveaway(id: number): Giveaway | null {
    const row = this.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;
    return row ? mapGiveaway(row) : null;
  }

  getActiveGiveaway(guildId: string): Giveaway | null {
    const row = this.db
      .prepare(`SELECT * FROM giveaways WHERE guild_id = ? AND status IN ('active', 'drawing') ORDER BY id DESC LIMIT 1`)
      .get(guildId) as GiveawayRow | undefined;
    return row ? mapGiveaway(row) : null;
  }

  setGiveawayMessage(id: number, messageId: string): void {
    this.db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  setGiveawayThread(id: number, threadId: string): void {
    this.db.prepare('UPDATE giveaways SET thread_id = ? WHERE id = ?').run(threadId, id);
  }

  setGiveawayAnnouncement(id: number, messageId: string): void {
    this.db.prepare('UPDATE giveaways SET events_message_id = ?, announce_claimed = 1 WHERE id = ?').run(messageId, id);
  }

  markAnnounced(id: number): void {
    this.db.prepare('UPDATE giveaways SET announce_claimed = 1 WHERE id = ?').run(id);
  }

  listNeedsDraw(guildId: string, now: number): Giveaway[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM giveaways
         WHERE guild_id = ? AND (status = 'drawing' OR (status = 'active' AND ends_at <= ?))
         ORDER BY id ASC`,
      )
      .all(guildId, now) as GiveawayRow[];
    return rows.map(mapGiveaway);
  }

  listUnannounced(guildId: string): Giveaway[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM giveaways
         WHERE guild_id = ? AND status = 'ended' AND events_message_id IS NULL AND announce_claimed = 0
         ORDER BY id ASC`,
      )
      .all(guildId) as GiveawayRow[];
    return rows.map(mapGiveaway);
  }

  tryBeginDraw(id: number): boolean {
    const result = this.db.prepare(`UPDATE giveaways SET status = 'drawing' WHERE id = ? AND status = 'active'`).run(id);
    return result.changes === 1;
  }

  finishDraw(id: number, winnerId: string | null, at: number): void {
    this.db
      .prepare(`UPDATE giveaways SET status = 'ended', winner_id = ?, ended_at = ? WHERE id = ? AND status = 'drawing'`)
      .run(winnerId, at, id);
  }

  cancelGiveaway(id: number, at: number): boolean {
    const result = this.db
      .prepare(`UPDATE giveaways SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'active'`)
      .run(at, id);
    return result.changes === 1;
  }

  setWinner(id: number, winnerId: string): void {
    this.db.prepare('UPDATE giveaways SET winner_id = ? WHERE id = ?').run(winnerId, id);
  }

  addEntry(giveawayId: number, userId: string, at: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)')
      .run(giveawayId, userId, at);
    return result.changes === 1;
  }

  hasEntry(giveawayId: number, userId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS n FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?')
      .get(giveawayId, userId) as { n: number } | undefined;
    return Boolean(row);
  }

  listEntries(giveawayId: number): GiveawayEntry[] {
    const rows = this.db
      .prepare('SELECT giveaway_id, user_id, entered_at FROM giveaway_entries WHERE giveaway_id = ? ORDER BY entered_at ASC')
      .all(giveawayId) as { giveaway_id: number; user_id: string; entered_at: number }[];
    return rows.map((row) => ({ giveawayId: row.giveaway_id, userId: row.user_id, enteredAt: row.entered_at }));
  }

  countEntries(giveawayId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(giveawayId) as {
      n: number;
    };
    return row.n;
  }

  addWinner(giveawayId: number, userId: string, weight: number, isReroll: boolean, at: number): void {
    this.db
      .prepare(
        'INSERT INTO giveaway_winners (giveaway_id, user_id, weight, drawn_at, is_reroll) VALUES (?, ?, ?, ?, ?)',
      )
      .run(giveawayId, userId, weight, at, isReroll ? 1 : 0);
  }

  listWinners(giveawayId: number): { userId: string; weight: number; isReroll: boolean }[] {
    const rows = this.db
      .prepare('SELECT user_id, weight, is_reroll FROM giveaway_winners WHERE giveaway_id = ? ORDER BY id ASC')
      .all(giveawayId) as { user_id: string; weight: number; is_reroll: number }[];
    return rows.map((row) => ({ userId: row.user_id, weight: row.weight, isReroll: row.is_reroll === 1 }));
  }

  saveCaptcha(token: string, giveawayId: number, userId: string, answer: string, attempts: number, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO captchas (token, giveaway_id, user_id, answer, attempts, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET answer = excluded.answer, attempts = excluded.attempts, expires_at = excluded.expires_at`,
      )
      .run(token, giveawayId, userId, answer, attempts, expiresAt);
  }

  getCaptcha(token: string): { giveawayId: number; userId: string; answer: string; attempts: number; expiresAt: number } | null {
    const row = this.db
      .prepare('SELECT giveaway_id, user_id, answer, attempts, expires_at FROM captchas WHERE token = ?')
      .get(token) as
      | { giveaway_id: number; user_id: string; answer: string; attempts: number; expires_at: number }
      | undefined;
    if (!row) return null;
    return {
      giveawayId: row.giveaway_id,
      userId: row.user_id,
      answer: row.answer,
      attempts: row.attempts,
      expiresAt: row.expires_at,
    };
  }

  deleteCaptcha(token: string): void {
    this.db.prepare('DELETE FROM captchas WHERE token = ?').run(token);
  }

  recordBoost(guildId: string, userId: string, premiumSince: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO boosts (guild_id, user_id, premium_since, created_at) VALUES (?, ?, ?, ?)')
      .run(guildId, userId, premiumSince, Date.now());
    return result.changes === 1;
  }

  getChatState(guildId: string, userId: string): { lastAwardAt: number | null; lastContent: string | null; lastContentAt: number | null } {
    const row = this.db
      .prepare('SELECT last_award_at, last_content, last_content_at FROM chat_state WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId) as
      | { last_award_at: number | null; last_content: string | null; last_content_at: number | null }
      | undefined;
    return {
      lastAwardAt: row?.last_award_at ?? null,
      lastContent: row?.last_content ?? null,
      lastContentAt: row?.last_content_at ?? null,
    };
  }

  setChatState(guildId: string, userId: string, lastAwardAt: number, lastContent: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_state (guild_id, user_id, last_award_at, last_content, last_content_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           last_award_at = excluded.last_award_at,
           last_content = excluded.last_content,
           last_content_at = excluded.last_content_at`,
      )
      .run(guildId, userId, lastAwardAt, lastContent, lastAwardAt);
  }

  private insertLedger(entry: Omit<LedgerEntry, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO ledger (guild_id, user_id, delta_cash, delta_bank, cash_after, bank_after, reason, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.guildId,
        entry.userId,
        entry.deltaCash,
        entry.deltaBank,
        entry.cashAfter,
        entry.bankAfter,
        entry.reason,
        entry.actorId,
        entry.createdAt,
      );
    return Number(result.lastInsertRowid);
  }
}

export function openDatabase(filePath: string): BetterSqlite.Database {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = new BetterSqlite(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db: BetterSqlite.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cash INTEGER NOT NULL,
      bank INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      delta_cash INTEGER NOT NULL,
      delta_bank INTEGER NOT NULL,
      cash_after INTEGER NOT NULL,
      bank_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      actor_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger (guild_id, user_id, id);

    CREATE TABLE IF NOT EXISTS weeks (
      guild_id TEXT PRIMARY KEY,
      week_id TEXT NOT NULL,
      started_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tier_id TEXT NOT NULL,
      week_id TEXT NOT NULL,
      entries INTEGER NOT NULL,
      price_paid INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tickets_user ON tickets (guild_id, user_id, status);

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      activity_key TEXT NOT NULL,
      week_id TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      reviewer_id TEXT,
      review_note TEXT,
      channel_id TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS claims_one_open
      ON claims (guild_id, user_id, activity_key, week_id)
      WHERE status IN ('pending', 'approved');

    CREATE TABLE IF NOT EXISTS voice_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      week_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      seconds INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS voice_open ON voice_segments (guild_id, user_id, ended_at);

    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      prize TEXT NOT NULL,
      winner_message TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      thread_id TEXT,
      events_message_id TEXT,
      ends_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      winner_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      announce_claimed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      entered_at INTEGER NOT NULL,
      PRIMARY KEY (giveaway_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS giveaway_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      weight INTEGER NOT NULL,
      drawn_at INTEGER NOT NULL,
      is_reroll INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS captchas (
      token TEXT PRIMARY KEY,
      giveaway_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime (
      guild_id TEXT PRIMARY KEY,
      preset TEXT,
      enforce_purchase_limit INTEGER,
      one_tier_only INTEGER,
      higher_replaces_lower INTEGER,
      refund_replaced INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boosts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      premium_since INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, premium_since)
    );

    CREATE TABLE IF NOT EXISTS chat_state (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_award_at INTEGER,
      last_content TEXT,
      last_content_at INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && String((error as { code: string }).code).includes('SQLITE_CONSTRAINT'));
}

interface AccountRow {
  guild_id: string;
  user_id: string;
  cash: number;
  bank: number;
}

interface LedgerRow {
  id: number;
  guild_id: string;
  user_id: string;
  delta_cash: number;
  delta_bank: number;
  cash_after: number;
  bank_after: number;
  reason: string;
  actor_id: string | null;
  created_at: number;
}

interface TicketRow {
  id: number;
  guild_id: string;
  user_id: string;
  tier_id: string;
  week_id: string;
  entries: number;
  price_paid: number;
  status: TicketStatus;
  created_at: number;
}

interface ClaimRow {
  id: number;
  guild_id: string;
  user_id: string;
  activity_key: string;
  week_id: string;
  status: ClaimStatus;
  note: string;
  reviewer_id: string | null;
  review_note: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

interface VoiceSegmentRow {
  id: number;
  guild_id: string;
  user_id: string;
  channel_id: string;
  week_id: string;
  started_at: number;
  ended_at: number | null;
  seconds: number;
}

interface GiveawayRow {
  id: number;
  guild_id: string;
  prize: string;
  winner_message: string;
  channel_id: string;
  message_id: string | null;
  thread_id: string | null;
  events_message_id: string | null;
  ends_at: number;
  status: Giveaway['status'];
  winner_id: string | null;
  created_by: string;
  created_at: number;
  ended_at: number | null;
  announce_claimed: number;
}

function mapAccount(row: AccountRow): Account {
  return { guildId: row.guild_id, userId: row.user_id, cash: row.cash, bank: row.bank };
}

function mapLedger(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    deltaCash: row.delta_cash,
    deltaBank: row.delta_bank,
    cashAfter: row.cash_after,
    bankAfter: row.bank_after,
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    tierId: row.tier_id,
    weekId: row.week_id,
    entries: row.entries,
    pricePaid: row.price_paid,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    activityKey: row.activity_key,
    weekId: row.week_id,
    status: row.status,
    note: row.note,
    reviewerId: row.reviewer_id,
    reviewNote: row.review_note,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapVoice(row: VoiceSegmentRow): VoiceSegment {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    weekId: row.week_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seconds: row.seconds,
  };
}

function mapGiveaway(row: GiveawayRow): Giveaway {
  return {
    id: row.id,
    guildId: row.guild_id,
    prize: row.prize,
    winnerMessage: row.winner_message,
    channelId: row.channel_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    eventsMessageId: row.events_message_id,
    endsAt: row.ends_at,
    status: row.status,
    winnerId: row.winner_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    announceClaimed: row.announce_claimed,
  };
}
