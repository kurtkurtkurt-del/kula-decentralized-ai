// 5 connections: how each device is reached.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { reachWord } from './util.js';

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'connections',
    observe(now) { snap = now; },
    view() {
      const devs = snap?.devices ?? [];
      const cable = devs.filter((d) => d.via === 'cable' && d.plugged !== false).length;
      const wifi = devs.filter((d) => d.via === 'wifi').length;
      const relay = devs.filter((d) => d.via === 'relay').length;
      return {
        built: true,
        stat: `${cable} cable · ${wifi} wi-fi${relay ? ` · ${relay} relay` : ''}`,
        gauge: null,
        rows: [],
        lines: devs.map((d) => `${d.name} · ${d.via === 'cable' ? `cable${d.plugged === false ? ' (unplugged)' : ''}` : `${d.via} · ${d.where}`} · ${reachWord(d)}`),
        note: devs.length ? undefined : 'no device yet.',
      };
    },
  };
}
