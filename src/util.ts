import { readFileSync } from 'node:fs';

export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/** Compare channel and role names. Emoji and punctuation are ignored, so "🎁︱giveaways" matches "giveaways". */
export function normalizeKey(value: string): string {
  return value.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]/g, '');
}

export function matchesConfiguredName(actual: string, configured: string): boolean {
  if (actual === configured) return true;
  const left = normalizeKey(actual);
  const right = normalizeKey(configured);
  return left.length > 0 && left === right;
}

export function matchesAnyName(actualId: string, actualName: string, configured: string[]): boolean {
  return configured.some((entry) => entry === actualId || matchesConfiguredName(actualName, entry));
}

export function formatBits(amount: number, currencyName: string): string {
  return `${amount} ${currencyName}`;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function parseHexColor(hex: string): number {
  const cleaned = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`Color must look like #007FFF. Received "${hex}".`);
  }
  return Number.parseInt(cleaned, 16);
}

export function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export function isPositiveInt(value: number, max = 1_000_000_000): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}

export function loadEnvFile(filePath: string): void {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
