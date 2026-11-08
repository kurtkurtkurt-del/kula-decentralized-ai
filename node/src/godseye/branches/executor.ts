// 7 executor: who answers now, how fast.
import type { Branch, BranchCtx, Snapshot } from '../types.js';

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'executor',
    observe(now) { snap = now; },
    view() {
      const devs = snap?.work.loaded?.devices ?? [];
      const busy = devs.filter((d) => d.busy).length;
      const done = devs.reduce((a, d) => a + (d.done || 0), 0);
      const tps = Math.max(0, ...devs.map((d) => d.tps || 0));
      return {
        built: true,
        stat: devs.length ? `${busy} answering · ${done} answers` : 'idle',
        gauge: busy ? 100 : Math.min(100, (tps / 30) * 100),
        rows: [['chats running', String(snap?.work.chatting ?? 0)]],
        lines: devs.map((d) => `${d.name} · ${d.busy ? 'answering now' : 'free'}${d.tps ? ` · ${d.tps} tok/s` : ''} · ${d.done} answer${d.done === 1 ? '' : 's'}`),
        note: devs.length ? undefined : 'no model loaded: nothing to send work to.',
      };
    },
  };
}
