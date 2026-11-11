// What one home thinks of another home's device, from what happened between them. There is no
// global score: every brain keeps its own book, and a friend's warning counts less than its own eyes.
// One lie proven against a known answer is enough; honest hardware does not get those wrong.

export type Outcome =
  | 'good'                         // checked and right (another copy or a known answer agreed)
  | 'outvoted'                     // two or more other devices agreed against it: one could be a flipped bit
  | 'wrong'                        // wrong against an answer this home knows (a canary, its own re-run): proof
  | 'late'                         // took the piece and did not bring it back in time
  | 'warned';                      // a friend caught it and showed the proof

export interface Rep {
  good: number; bad: number; late: number;   // decayed counts
  proof: number;                   // first-hand bad answers (not decayed: a lie stays a lie)
  at: number;                      // ms, when the counts were last decayed
  banUntil: number;                // ms; no work goes to it before then
}

export const HALF_LIFE_MS = 30 * 86_400_000;
export const BAN_MS = 30 * 86_400_000;
export const WARNED_BAN_MS = 7 * 86_400_000;
export const BAD_WEIGHT = 8;       // one wrong answer outweighs eight right ones
export const LATE_WEIGHT = 1;
export const CUT = 0.4;            // below this score it gets no more work from this home
export const NEW_DEVICE = 8;       // checked answers before a device is only sampled

export const fresh = (now: number): Rep => ({ good: 0, bad: 0, late: 0, proof: 0, at: now, banUntil: 0 });

export function decay(r: Rep, now: number): Rep {
  if (now <= r.at) return r;
  const k = 0.5 ** ((now - r.at) / HALF_LIFE_MS);
  return { ...r, good: r.good * k, bad: r.bad * k, late: r.late * k, at: now };
}

/** The score, 0..1: a beta mean with one right and one wrong answer assumed to start. A new device is 0.5. */
export function score(r: Rep | undefined, now: number): number {
  if (!r) return 0.5;
  const d = decay(r, now);
  const a = 1 + d.good;
  const b = 1 + BAD_WEIGHT * d.bad + LATE_WEIGHT * d.late;
  return a / (a + b);
}

export const banned = (r: Rep | undefined, now: number): boolean => !!r && r.banUntil > now;
/** may this home still hand it work? */
export const usable = (r: Rep | undefined, now: number): boolean => !banned(r, now) && score(r, now) >= CUT;

/** One thing that happened. A copy; `r` is not touched. */
export function observe(r: Rep | undefined, outcome: Outcome, now: number): Rep {
  const d = decay(r ?? fresh(now), now);
  const out = { ...d };
  switch (outcome) {
    case 'good': out.good += 1; break;
    case 'late': out.late += 1; break;
    case 'wrong': out.bad += 1; out.proof += 1; out.banUntil = Math.max(out.banUntil, now + BAN_MS); break;
    case 'outvoted':
      out.bad += 1; out.proof += 1;
      // one disagreement can be a flipped bit; two are a habit
      if (out.proof >= 2) out.banUntil = Math.max(out.banUntil, now + BAN_MS);
      break;
    case 'warned': out.bad += 1; out.banUntil = Math.max(out.banUntil, now + WARNED_BAN_MS); break;
  }
  return out;
}
