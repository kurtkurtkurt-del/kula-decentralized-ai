// 10 models and device care: what is held where, what is on offer.
import type { Branch, BranchCtx, Snapshot } from '../types.js';

export function create(_ctx: BranchCtx): Branch {
  let snap: Snapshot | null = null;
  return {
    id: 'models',
    observe(now) { snap = now; },
    view() {
      const held = (snap?.devices ?? []).filter((d) => d.holds);
      const models = snap?.models ?? [];
      const L = snap?.work.loaded;
      return {
        built: true,
        stat: L ? `${L.model.name} loaded` : `${models.length} models · ${held.length} held`,
        gauge: null,
        rows: [['held now', held.length ? held.map((d) => `${d.name}: ${d.holds}`).join(' · ') : 'no device holds a model']],
        lines: models.slice(0, 12).map((m) => `${m.name}${m.size ? ` · ${(m.size / 1e9).toFixed(2)} GB` : ''}${m.here ? ' · on this computer' : ''}`),
      };
    },
  };
}
