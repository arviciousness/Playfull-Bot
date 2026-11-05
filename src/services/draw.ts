export interface WeightedEntry {
  userId: string;
  weight: number;
}

/** `rngInt(n)` must return an integer in `[0, n)`. */
export function weightedPick(entries: WeightedEntry[], rngInt: (exclusiveMax: number) => number): WeightedEntry | null {
  const eligible = entries.filter((entry) => Number.isInteger(entry.weight) && entry.weight > 0);
  const total = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0 || eligible.length === 0) return null;
  let ticket = rngInt(total);
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= total) {
    throw new Error('rngInt must return an integer in [0, total).');
  }
  for (const entry of eligible) {
    if (ticket < entry.weight) return entry;
    ticket -= entry.weight;
  }
  return eligible[eligible.length - 1] ?? null;
}

export function drawWinner(
  entries: WeightedEntry[],
  exclude: ReadonlySet<string>,
  rngInt: (exclusiveMax: number) => number,
): WeightedEntry | null {
  return weightedPick(
    entries.filter((entry) => !exclude.has(entry.userId)),
    rngInt,
  );
}

export function totalWeight(entries: WeightedEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.weight > 0 ? entry.weight : 0), 0);
}
