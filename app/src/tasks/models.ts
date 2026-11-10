import { lastPassport } from '@/data/passport';
import { measuredFor } from '@/bench/store';
import { modelKey } from '@/llm/cluster';
import { activeShare, fitOn } from '@/llm/fit';
import { localById, localModels, type LocalModel } from '@/llm/store';
import type { Task } from './types';

// Which model a project runs on, and how fast it goes on this phone. The default is the
// best model on this phone that fits: the largest downloaded one the passport says fits
// (night/LlamaWorker.ts pickModel does the same for the night), else the smallest.

const CTX = 4096; // a project's steps are long; the fit is judged at this context

export function fits(m: LocalModel): boolean {
  return fitOn(lastPassport(), { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: CTX }).verdict !== 'no';
}
export function bestModel(): LocalModel | null {
  // text models first; a vision model (mmproj) writes only when nothing else is here (10.11.2026)
  const all = [...localModels()].sort((a, b) => Number(!!a.mmproj) - Number(!!b.mmproj) || b.size - a.size);
  return all.find(fits) ?? all.filter((m) => !m.mmproj).at(-1) ?? all.at(-1) ?? null;
}
export function modelFor(t: Pick<Task, 'modelId'>): LocalModel | null {
  return (t.modelId ? localById(t.modelId) : null) ?? bestModel();
}
/** tok/s on this phone: the bench's figure when this model was measured here, else the
 * passport's estimate (between the hot and the cool figure); null with neither. */
export function tpsFor(m: LocalModel | null): { tps: number; measured: boolean } | null {
  if (!m) return null;
  const f = fitOn(lastPassport(), { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: CTX, active: activeShare(m) }, measuredFor('self', modelKey(m)));
  if (!f.tps) return null;
  return { tps: f.measured ? f.tps.high : Math.round(((f.tps.low + f.tps.high) / 2) * 10) / 10, measured: f.measured };
}
