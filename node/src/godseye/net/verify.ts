// Which pieces go twice, which devices get a known-answer piece, and what to make of the answers.
// The idea is BOINC's adaptive replication: a device with no history has everything checked, a
// device with a long clean history only a sample. Canaries (pieces whose answer this home already
// knows, from its own night) look like any other piece and catch two liars who agree with each other.
import { NEW_DEVICE, score, type Outcome, type Rep } from './reputation.js';

/** A number in [0, 1) from the inputs alone (FNV-1a, 32 bit): the same coin on every machine. */
export function coin(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('\u0000');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // one more mix so near inputs do not give near numbers
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return (h >>> 0) / 2 ** 32;
}

export const CHECK_FLOOR = 0.1;    // even the best device has one piece in ten run twice
export const CANARY_FLOOR = 0.05;  // and one in twenty is a known answer

/** How often this device's pieces should be checked, by its score in this home's book. */
export function rates(r: Rep | undefined, now: number): { check: number; canary: number } {
  if (!r || r.good < NEW_DEVICE) return { check: 1, canary: 0.25 };
  const s = score(r, now);
  return {
    check: Math.min(1, CHECK_FLOOR + 1.5 * (1 - s)),
    canary: Math.min(0.5, CANARY_FLOOR + 0.3 * (1 - s)),
  };
}

export interface Plan { canary: boolean; check: boolean }

/** What the asker does with a grant for copy 0 of a piece on a device of another home: send a
 *  canary in its place, or send it and have it checked by a second home, or just send it. */
export function plan(piece: string, device: string, r: Rep | undefined, now: number, seed: string | number): Plan {
  const p = rates(r, now);
  if (coin(seed, 'canary', piece, device) < p.canary) return { canary: true, check: false };
  return { canary: false, check: coin(seed, 'check', piece, device) < p.check };
}

export interface Answer { device: string; home: string; digest: string }
export type Judgement =
  | { state: 'wait' }
  | { state: 'tiebreak' }          // two disagree: this home runs it itself (or a third copy goes out)
  | { state: 'accept'; digest: string; checked: boolean; outcomes: { device: string; outcome: Outcome }[] };

/** What the answers to one piece come to. `want` is how many copies were sent; `truth` is the
 *  answer this home knows (a canary) or found itself (a tiebreak re-run at home). The outcomes go
 *  straight into reputation.observe(): wrong against the truth is proof, outvoted is a strike. */
export function judge(answers: Answer[], want: number, truth?: string): Judgement {
  if (truth != null) {
    return { state: 'accept', digest: truth, checked: true, outcomes: answers.map((a) => ({ device: a.device, outcome: a.digest === truth ? 'good' : 'wrong' })) };
  }
  if (answers.length < want || answers.length === 0) return { state: 'wait' };
  if (want === 1 && answers.length === 1) return { state: 'accept', digest: answers[0].digest, checked: false, outcomes: [] };
  const count = new Map<string, number>();
  for (const a of answers) count.set(a.digest, (count.get(a.digest) ?? 0) + 1);
  const top = [...count.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
  // all agree, or a strict majority of three or more
  if (count.size === 1 || (answers.length >= 3 && top[1] * 2 > answers.length)) {
    return { state: 'accept', digest: top[0], checked: true, outcomes: answers.map((a) => ({ device: a.device, outcome: a.digest === top[0] ? 'good' : 'outvoted' })) };
  }
  return { state: 'tiebreak' };
}

/** After a device is caught: the pieces it gave this home that nobody checked go out again. */
export function recall<T extends { device: string; checked: boolean; at: number }>(accepted: T[], device: string, since = 0): T[] {
  return accepted.filter((a) => a.device === device && !a.checked && a.at >= since);
}
