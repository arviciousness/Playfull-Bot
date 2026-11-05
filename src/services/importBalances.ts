import { isSnowflake } from '../util.js';

export interface ImportRow {
  userId: string;
  cash: number;
  bank: number;
  line: number;
}

export interface ImportParseResult {
  rows: ImportRow[];
  errors: string[];
}

const ID_KEYS = new Set(['user_id', 'userid', 'user', 'id', 'discord_id', 'discordid', 'member_id']);
const CASH_KEYS = new Set(['cash', 'wallet', 'pocket']);
const BANK_KEYS = new Set(['bank', 'vault']);
const TOTAL_KEYS = new Set(['balance', 'total', 'playbits', 'amount', 'net', 'money']);

export function parseBalanceImport(text: string): ImportParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { rows: [], errors: ['The file is empty.'] };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(trimmed);
  return parseDelimited(trimmed);
}

function parseJson(text: string): ImportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rows: [], errors: ['The file looks like JSON but could not be parsed.'] };
  }
  const list = Array.isArray(value) ? value : [value];
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`Row ${index + 1} is not an object.`);
      return;
    }
    const record = item as Record<string, unknown>;
    const normalized: Record<string, string> = {};
    for (const [key, cell] of Object.entries(record)) normalized[normalizeHeader(key)] = String(cell ?? '').trim();
    const parsed = rowFromRecord(normalized, index + 1);
    if (typeof parsed === 'string') errors.push(parsed);
    else rows.push(parsed);
  });
  return { rows, errors };
}

function parseDelimited(text: string): ImportParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  const table = lines.map((line) => parseCsvLine(line, delimiter));
  const header = table[0]?.map(normalizeHeader) ?? [];
  const hasHeader = header.some((cell) => ID_KEYS.has(cell) || CASH_KEYS.has(cell) || TOTAL_KEYS.has(cell));
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const start = hasHeader ? 1 : 0;
  for (let index = start; index < table.length; index++) {
    const cells = table[index] ?? [];
    const line = index + 1;
    if (hasHeader) {
      const record: Record<string, string> = {};
      header.forEach((key, cellIndex) => {
        record[key] = cells[cellIndex] ?? '';
      });
      const parsed = rowFromRecord(record, line);
      if (typeof parsed === 'string') errors.push(parsed);
      else rows.push(parsed);
      continue;
    }
    const parsed = rowFromCells(cells, line);
    if (typeof parsed === 'string') errors.push(parsed);
    else rows.push(parsed);
  }
  if (rows.length === 0 && errors.length === 0) errors.push('No balance rows were found.');
  return { rows, errors };
}

function rowFromRecord(record: Record<string, string>, line: number): ImportRow | string {
  const userId = cleanId(first(record, ID_KEYS) ?? '');
  if (!userId) return `Line ${line}: missing Discord user id.`;
  if (!isSnowflake(userId)) return `Line ${line}: "${userId}" is not a Discord user id.`;
  const cashCell = first(record, CASH_KEYS);
  const bankCell = first(record, BANK_KEYS);
  const totalCell = first(record, TOTAL_KEYS);
  if (cashCell === undefined && totalCell === undefined) return `Line ${line}: missing a cash or balance column.`;
  const cash = parseAmount(cashCell ?? totalCell ?? '', line, 'cash');
  if (typeof cash === 'string') return cash;
  const bank = bankCell === undefined || bankCell === '' ? 0 : parseAmount(bankCell, line, 'bank');
  if (typeof bank === 'string') return bank;
  return { userId, cash, bank, line };
}

function rowFromCells(cells: string[], line: number): ImportRow | string {
  const userId = cleanId(cells[0] ?? '');
  if (!isSnowflake(userId)) return `Line ${line}: expected user_id,cash,bank.`;
  const cash = parseAmount(cells[1] ?? '', line, 'cash');
  if (typeof cash === 'string') return cash;
  const bank = cells[2] === undefined || cells[2] === '' ? 0 : parseAmount(cells[2], line, 'bank');
  if (typeof bank === 'string') return bank;
  return { userId, cash, bank, line };
}

function first(record: Record<string, string>, keys: Set<string>): string | undefined {
  for (const key of Object.keys(record)) {
    if (keys.has(key)) return record[key];
  }
  return undefined;
}

function cleanId(value: string): string {
  return value.replace(/[<@!>]/g, '').trim();
}

function parseAmount(value: string, line: number, label: string): number | string {
  const cleaned = value.replace(/[, ]/g, '').trim();
  if (!/^\d+$/.test(cleaned)) return `Line ${line}: ${label} must be a whole number of 0 or more.`;
  const amount = Number(cleaned);
  if (!Number.isSafeInteger(amount)) return `Line ${line}: ${label} is too large.`;
  return amount;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += char ?? '';
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(current.trim());
      current = '';
    } else current += char ?? '';
  }
  cells.push(current.trim());
  return cells;
}
