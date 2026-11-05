import { inWindow } from '@/night/SimulatedWorker';
import { STEPS, isCritique, type Depth, type Length } from './types';
import { CRITIQUE_TOKENS, LENGTH_TOKENS, THINK_TOKENS, WORDS_PER_TOKEN } from './prompts';
import { minutesOf, windowMinutes } from './schedule';

// How long will a project take tonight? (pure, tested) The steps of its depth, each with
// its token budget (the length's for writing, a critique's for critiques, a thinking
// model's extra), at the model's speed on this phone: generation at tps, the prompt read
// PREFILL times faster (the draft and critique a later step reads are counted). The run
// starts when the window opens (now, when it is open) and must end before it closes.
//
// tps: measured on this phone when there is a bench (llm/fit.ts with bench/store.ts), else
// the passport's estimate; null when there is no model or no figure.

export const PREFILL = 6; // reading a prompt is about this much faster than writing
export const STEP_OVERHEAD_S = 4; // per step: the template, the cache, the hand-over

export type EstimateIn = {
  tps: number | null;
  from: string;
  to: string;
  depth: Depth;
  length: Length;
  thinking: boolean;
  promptChars: number;
  now: Date;
};
export type Estimate =
  | { kind: 'unknown' }
  | { kind: 'fits' | 'over'; words: number; tokens: number; seconds: number; startAt: Date; doneAt: Date; windowSeconds: number; steps: number };

export function estimate(e: EstimateIn): Estimate {
  if (!e.tps || !(e.tps > 0)) return { kind: 'unknown' };
  const steps = STEPS[e.depth];
  const task = Math.ceil(e.promptChars / 4) + 80;
  const write = LENGTH_TOKENS[e.length];
  let gen = 0;
  let read = 0;
  let lastWrite = 0;
  let lastCrit = 0;
  for (const s of steps) {
    const out = isCritique(s) ? CRITIQUE_TOKENS : write;
    read += task + (isCritique(s) ? lastWrite : lastCrit ? lastWrite + lastCrit : 0);
    gen += out + (e.thinking ? THINK_TOKENS : 0);
    if (isCritique(s)) lastCrit = out;
    else lastWrite = out;
  }
  const seconds = Math.round(gen / e.tps + read / (e.tps * PREFILL) + steps.length * STEP_OVERHEAD_S);
  const len = windowMinutes(e.from, e.to) * 60;
  const open = inWindow(e.from, e.to, e.now);
  const startAt = open ? e.now : nextOpen(e.from, e.now);
  // the window's end: from its opening, which for an open window may have been yesterday
  const opened = open ? lastOpen(e.from, e.now) : startAt;
  const end = opened.getTime() + len * 1000;
  const windowSeconds = Math.max(0, Math.round((end - startAt.getTime()) / 1000));
  const doneAt = new Date(startAt.getTime() + seconds * 1000);
  return { kind: seconds <= windowSeconds ? 'fits' : 'over', words: Math.round(write * WORDS_PER_TOKEN), tokens: gen, seconds, startAt, doneAt, windowSeconds, steps: steps.length };
}

const at = (base: Date, mins: number, dayShift: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayShift, Math.floor(mins / 60), mins % 60);
function nextOpen(from: string, now: Date): Date {
  const today = at(now, minutesOf(from), 0);
  return today > now ? today : at(now, minutesOf(from), 1);
}
function lastOpen(from: string, now: Date): Date {
  const today = at(now, minutesOf(from), 0);
  return today <= now ? today : at(now, minutesOf(from), -1);
}
