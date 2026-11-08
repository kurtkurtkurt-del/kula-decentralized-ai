// 6 planner: where the model sits and why.
import type { Branch, BranchCtx, Snapshot } from '../types.js';
import { hhmm } from './util.js';

const MODE_WORD: Record<string, string> = { phone: 'on the phone', apart: 'apart', split: 'split', here: 'here' };

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'planner',
    observe(now) { snap = now; },
    view() {
      const w = snap?.work;
      const L = w?.loaded;
      const rows: [string, string][] = [];
      if (L) rows.push(['model', L.model.name], ['mode', MODE_WORD[L.mode] ?? L.mode], ['context', `${L.ctx} tokens`], ['since', hhmm(L.since)]);
      if (w?.loading) rows.push(['loading', w.loading.line || w.loading.model]);
      const parts = (L?.parts ?? []).map((p) => `${p.name}: ${p.layers} layers · ${p.mb} MB${p.local ? ' · main device' : ''}`);
      return {
        built: true,
        stat: w?.loading ? `loading ${w.loading.model}` : L ? `${MODE_WORD[L.mode] ?? L.mode} · ${L.model.name}` : 'nothing planned',
        gauge: null,
        rows,
        lines: [...parts, ...(w?.plan ?? [])],
        note: L || w?.loading ? undefined : 'nothing loaded, nothing planned.',
      };
    },
  };
}
