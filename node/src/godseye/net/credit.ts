// Reciprocity without money. Nothing here is a coin: there is no total, nothing to own, nothing to
// sell. There is only who did how much for whom, read from signed receipts both sides keep, and the
// trust a person gave a friend ("I will do up to 200 units for Ayşe before anything comes back").
//
// A stranger's work is honoured along a chain of friends, the way a friend of a friend is welcome
// at the table: C does work for A because C trusts B and B trusts A. B does nothing itself but its
// word moves along: C has now done something for B, and B for A. Every hop keeps its own balance;
// none of them can spend another's.
import type { Trust, Units } from './types.js';

/** gave[x][y]: units x has done for y, as their receipts say (a chain's hops included). */
export type Gave = Record<string, Record<string, Units>>;

export const MAX_HOPS = 3;          // giver, two friends, asker: further than that, nobody knows anybody
export const HOP_DECAY = 0.5;       // each friend in between halves what the chain is worth

export const gaveOf = (g: Gave, x: string, y: string): Units => g[x]?.[y] ?? 0;
/** what y owes x: positive when x did more for y than y for x */
export const owed = (g: Gave, x: string, y: string): Units => gaveOf(g, x, y) - gaveOf(g, y, x);

export function limitOf(trust: Trust[], x: string, y: string): Units {
  let l = 0;
  for (const t of trust) if (t.from === x && t.to === y) l = Math.max(l, t.limit);
  return l;
}

/** How much more x will do for y, directly: the trust x gave y, less what y owes x. Without trust
 *  it is only what x owes y: a debt is always honoured, even to a stranger (tit for tat). */
export const hop = (trust: Trust[], g: Gave, x: string, y: string): Units => limitOf(trust, x, y) - owed(g, x, y);

/** The homes x trusts, sorted, so the search is the same everywhere. Credit travels along trust,
 *  not along mere balances, so only these can stand in the middle of a chain. */
function friends(trust: Trust[], x: string): string[] {
  return [...new Set(trust.filter((t) => t.from === x && t.limit > 0).map((t) => t.to))].sort();
}

export interface Room { units: Units; path: string[] }

/** How much `giver` will do for `asker` on credit, and along which chain. The best chain wins: its
 *  weakest hop, halved for every friend in between; on a tie the shorter, then the first by name.
 *  In the wild each hop's number comes from that hop's own signed word (a vouch); here, from `g`. */
export function room(trust: Trust[], g: Gave, giver: string, asker: string, maxHops = MAX_HOPS): Room {
  if (giver === asker) return { units: Infinity, path: [] };
  let best: Room = { units: Math.max(0, hop(trust, g, giver, asker)), path: [giver, asker] };
  const walk = (path: string[], low: number) => {
    const at = path[path.length - 1];
    if (path.length >= maxHops) return;          // one more friend and the asker would be too many hops
    for (const n of friends(trust, at)) {
      if (path.includes(n) || n === asker) continue;
      const lowN = Math.min(low, hop(trust, g, at, n));
      if (lowN <= 0) continue;
      const end = Math.min(lowN, hop(trust, g, n, asker));
      const full = [...path, n, asker];
      const worth = end * HOP_DECAY ** (full.length - 2);
      if (end > 0 && (worth > best.units || (worth === best.units && full.length < best.path.length))) best = { units: worth, path: full };
      walk([...path, n], lowN);
    }
  };
  walk([giver], Infinity);
  return { units: Math.floor(best.units), path: best.path };
}

/** Records work along a chain: each hop did `units` for the next. A copy; `g` is not touched.
 *  A negative `units` takes it back (a receipt the asker later revoked with proof). */
export function carry(g: Gave, path: string[], units: Units): Gave {
  const out: Gave = {};
  for (const [x, row] of Object.entries(g)) out[x] = { ...row };
  for (let i = 0; i + 1 < path.length; i++) {
    const [x, y] = [path[i], path[i + 1]];
    out[x] ??= {};
    out[x][y] = (out[x][y] ?? 0) + units;
  }
  return out;
}

/** One home's standing over everyone it has a balance with. */
export function standing(g: Gave, home: string): { gave: Units; got: Units; net: Units } {
  let gave = 0, got = 0;
  for (const [y, u] of Object.entries(g[home] ?? {})) if (y !== home) gave += u;
  for (const [x, row] of Object.entries(g)) if (x !== home) got += row[home] ?? 0;
  return { gave, got, net: gave - got };
}
