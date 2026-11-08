// 2 memory: what happened and why, the decision log of this computer.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { hhmm } from './util.js';

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'memory',
    observe(now) { snap = now; },
    view() {
      const d = snap?.work.decisions ?? [];
      return {
        built: true,
        stat: `${d.length} notes kept`,
        gauge: Math.min(100, d.length * (100 / 30)),
        rows: [],
        lines: [...d].reverse().map((x) => `${hhmm(x.at)}  ${x.text}`),
        note: d.length ? undefined : 'nothing yet.',
      };
    },
  };
}
