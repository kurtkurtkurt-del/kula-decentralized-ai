// 8 trust and verification: how each link is secured.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { pct } from './util.js';

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'trust',
    observe(now) { snap = now; },
    view() {
      const devs = snap?.devices ?? [];
      const t = devs.filter((d) => d.tls).length;
      return {
        built: true,
        stat: devs.length ? `${t} of ${devs.length} tls-pinned` : 'nothing to check',
        gauge: devs.length ? pct(t, devs.length) : null,
        rows: [],
        lines: devs.map((d) => `${d.name} · ${d.tls ? 'tls · certificate pinned' : 'older pairing (shared secret)'}${d.waitingPair ? ' · waiting for the one-time code' : ''}`),
        note: 'nothing private goes into these checks: no prompts, no answers, only who connected and whether it was allowed.',
      };
    },
  };
}
