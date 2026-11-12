// how much a card matters, in the person's order (11.11.2026, docs/BEYIN.md): privacy first, then
// the devices' health, then speed. The class comes first, the card's weight second, a warning
// before a suggestion third. The panel (eye.ts) and the advisor's "first:" card (advisor.ts) both
// sort by it, so they never disagree (finding C5: a weight-1 privacy warning sat below any
// weight-2 speed card).
import type { BranchId } from './types.js';

const PRIVACY: readonly string[] = ['review', 'trust'];
const HEALTH_BRANCHES: readonly string[] = ['limits'];
const HEALTH_IDS = ['executor:rest:', 'models:tight:', 'planner:barred:'];

/** 3 privacy (review, trust), 2 health (limits, a device that needs rest, a model that is tight, a barred device), 1 the rest */
export function cardClass(c: { branch: BranchId | string; id: string }): 1 | 2 | 3 {
  if (PRIVACY.includes(c.branch)) return 3;
  if (HEALTH_BRANCHES.includes(c.branch) || HEALTH_IDS.some((p) => c.id.startsWith(p))) return 2;
  return 1;
}

/** higher first: class * 100 + weight * 2 + 1 for a warning */
export function cardRank(c: { branch: BranchId | string; id: string; weight?: number; kind: string }): number {
  return cardClass(c) * 100 + (c.weight ?? 2) * 2 + (c.kind === 'warn' ? 1 : 0);
}
