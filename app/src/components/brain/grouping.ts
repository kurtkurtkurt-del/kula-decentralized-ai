// The decisions log as a compact timeline (5.11.2026): each line gets a few words instead of
// its sentence (the sentence opens on a tap and is what a screen reader hears), and a run of
// the same night line (units, wrong answers, devices out) or of prompts sent folds into one
// row with a count. Pure.
import type { BrainEntry, BrainKind, Tone } from '@/llm/brainlog';

// a few words for each sentence of the log (i18n brain.short.*); a key not here (the
// secretary's lines are already short) shows its own sentence
const SHORT: Record<string, string> = {
  'brain.plan.alone': 'brain.short.alone',
  'brain.plan.split': 'brain.short.split',
  'brain.plan.apart': 'brain.short.apart',
  'brain.plan.keptHere': 'brain.short.kept',
  'brain.plan.aloneFaster': 'brain.short.aloneFaster',
  'brain.plan.expect': 'brain.short.expect',
  'brain.load.done': 'brain.short.ready',
  'brain.load.toobig': 'brain.short.failed',
  'brain.load.local': 'brain.short.failed',
  'brain.load.failed': 'brain.short.failed',
  'brain.dispatch': 'brain.short.dispatch',
  'brain.retry': 'brain.short.retry',
  'brain.retry.none': 'brain.short.retry',
  'brain.night.start': 'brain.short.nightStart',
  'brain.night.end': 'brain.short.nightEnd',
  'brain.night.failed': 'brain.short.nightFailed',
  'brain.unit': 'brain.short.unit',
  'brain.check.wrong': 'brain.short.wrong',
  'brain.out': 'brain.short.out',
};

/** The short key for a log key, or null when the sentence itself is short enough. */
export function shortKey(key: string): string | null {
  if (SHORT[key]) return SHORT[key];
  if (key.startsWith('brain.why.')) return 'brain.short.skip';
  return null;
}

// lines that repeat in a run and say the same thing again: the night's, and prompts sent
const FOLDS: ReadonlySet<BrainKind> = new Set<BrainKind>(['night', 'unit', 'check', 'out', 'dispatch', 'skip']);
const RANK: Record<Tone, number> = { info: 0, ok: 1, warn: 2, bad: 3 };

export type Group = { id: string; kind: BrainKind; key: string; tone: Tone; at: number; items: BrainEntry[] };

/**
 * Newest-first lines as rows: a run of lines of the same foldable kind (units of the night,
 * wrong answers, devices out, prompts, skipped devices) is one row; the row takes the newest
 * line's time and key, and the worst tone among them. Nothing else folds, so the order of
 * events stays readable.
 */
export function group(newestFirst: BrainEntry[]): Group[] {
  const out: Group[] = [];
  const ids = new Map<string, number>();
  for (const e of newestFirst) {
    const prev = out.at(-1);
    if (prev && FOLDS.has(e.kind) && prev.kind === e.kind && shortKey(prev.key) === shortKey(e.key)) {
      prev.items.push(e);
      if (RANK[e.tone] > RANK[prev.tone]) prev.tone = e.tone;
      continue;
    }
    // an id that stays when newer lines arrive on top (an open row stays open)
    const base = `${e.at}:${e.key}`;
    const seen = ids.get(base) ?? 0;
    ids.set(base, seen + 1);
    out.push({ id: seen ? `${base}:${seen}` : base, kind: e.kind, key: e.key, tone: e.tone, at: e.at, items: [e] });
  }
  return out;
}

/** The figures of a folded run of unit lines added up (one per device): devices, units, tokens. */
export function unitTotals(items: BrainEntry[]): { devices: number; n: number; tokens: number } {
  const devices = new Set<string>();
  let n = 0;
  let tokens = 0;
  for (const e of items) {
    if (e.kind !== 'unit') continue;
    devices.add(String(e.vars?.device ?? ''));
    n += Number(e.vars?.n) || 0;
    tokens += Number(e.vars?.tokens) || 0;
  }
  return { devices: devices.size, n, tokens };
}
