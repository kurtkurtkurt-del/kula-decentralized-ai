// 1 senses: every device, is it there, how much memory, how fast it answers.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { active, gb, pct, reachWord } from './util.js';

export function create(ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'senses',
    observe(now, before) {
      snap = now;
      // a device that answered before and does not now (or the other way round) is worth a line
      for (const d of now.devices) {
        const was = before?.devices.find((x) => x.id === d.id);
        if (was && was.reachable !== d.reachable && d.reachable != null) ctx.emit(`${d.name} ${d.reachable ? 'answers again' : `stopped answering${d.reason ? `: ${d.reason}` : ''}`}`);
      }
    },
    view() {
      const devs = snap?.devices ?? [];
      const on = devs.filter(active).length;
      return {
        built: true,
        stat: devs.length ? `${on} of ${devs.length} devices active` : 'no device yet',
        gauge: devs.length ? pct(on, devs.length) : null,
        rows: [],
        lines: devs.map((d) => [d.name, reachWord(d), d.ramMb ? `${gb(d.ramMb)} free` : null, d.bwGBs ? `${d.bwGBs} GB/s` : null].filter(Boolean).join(' · ')),
        note: devs.length ? undefined : 'no device yet. devices (top right) adds one.',
      };
    },
  };
}
