import { CATALOG, type CatalogModel } from '@/llm/catalog';
import { activeShare } from '@/llm/fit';
import type { Passport } from '@/passport/contract';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, MB, WORKER_SHARE, type SimDevice, type SimModel, type SimNet } from '@/llm/sim/model';

// Profiles for the simulator: devices we have or know, the networks between them, and the
// shape of every catalog model. Measured numbers are marked; the rest are guesses to be
// replaced by a passport (docs/PLANNER.md lists what to measure).
export type DeviceProfile = {
  id: string;
  name: string;
  kind: 'phone' | 'tablet' | 'pc';
  ramTotalMb: number;
  ramFreeMb: number;   // when idle, screen on
  budgetMb: number;    // the passport's budget (ram_gb × 1024) when measured
  bw: number;          // GB/s, the passport's mem_bw_read_gbs
  eff: number;         // decode efficiency; 0.6 until measured
  measured: boolean;
};

export const DEVICES: Record<string, DeviceProfile> = {
  // measured 5.11.2026: passport 65.9 GB/s, budget 1.82 GB; gemma 3 1b ran
  s25plus: { id: 's25plus', name: 'Galaxy S25+', kind: 'phone', ramTotalMb: 12288, ramFreeMb: 6500, budgetMb: 1864, bw: 65.9, eff: DEFAULT_EFF, measured: true },
  pixel8: { id: 'pixel8', name: 'Pixel 8', kind: 'phone', ramTotalMb: 8192, ramFreeMb: 3800, budgetMb: 2200, bw: 28, eff: DEFAULT_EFF, measured: false },
  mid6: { id: 'mid6', name: 'mid-range 6 gb', kind: 'phone', ramTotalMb: 6144, ramFreeMb: 2600, budgetMb: 1400, bw: 14, eff: DEFAULT_EFF, measured: false },
  old4: { id: 'old4', name: 'old 4 gb', kind: 'phone', ramTotalMb: 4096, ramFreeMb: 1400, budgetMb: 800, bw: 8, eff: DEFAULT_EFF, measured: false },
  // measured 5.11.2026: 2.4 GB ram, budget 0.54 GB (an avd on the m1)
  emulator: { id: 'emulator', name: 'emulator', kind: 'phone', ramTotalMb: 2458, ramFreeMb: 1100, budgetMb: 553, bw: 12, eff: DEFAULT_EFF, measured: true },
  // measured 5.11.2026: llama-server 34 tok/s on qwen3 0.6b q8 → eff 0.3 at 68 GB/s
  macm1: { id: 'macm1', name: 'Mac M1 8 gb', kind: 'pc', ramTotalMb: 8192, ramFreeMb: 4000, budgetMb: 3000, bw: 68, eff: 0.3, measured: true },
  rtx4090: { id: 'rtx4090', name: 'Linux 4090', kind: 'pc', ramTotalMb: 24576, ramFreeMb: 22000, budgetMb: 20000, bw: 1008, eff: DEFAULT_EFF, measured: false },
};

export const NETWORKS: Record<string, SimNet & { id: string; name: string }> = {
  wifi5: { id: 'wifi5', name: 'wi-fi 5 ghz', mbps: 30, rttMs: 3 },
  wifi24: { id: 'wifi24', name: 'wi-fi 2.4 ghz', mbps: 5, rttMs: 8 },
  hotspot: { id: 'hotspot', name: 'phone hotspot', mbps: 8, rttMs: 12 },
  // measured 5.11.2026: 415 MB through the avd's nat tunnel in ~320 s
  emuNat: { id: 'emuNat', name: 'emulator nat', mbps: 1.3, rttMs: 2 },
};

// Architecture read off each gguf header (block_count, embedding_length, vocab_size).
const ARCH: Record<string, { layers: number; hidden: number; vocab: number }> = {
  'qwen3-0.6b-q8': { layers: 28, hidden: 1024, vocab: 151936 },
  'gemma3-1b-q4': { layers: 26, hidden: 1152, vocab: 262144 },
  'llama3.2-1b-q4': { layers: 16, hidden: 2048, vocab: 128256 },
  'qwen2.5-1.5b-q4': { layers: 28, hidden: 1536, vocab: 151936 },
  'qwen3-1.7b-q8': { layers: 28, hidden: 2048, vocab: 151936 },
  'llama3.2-3b-q4': { layers: 28, hidden: 3072, vocab: 128256 },
  'qwen3-4b-q4': { layers: 36, hidden: 2560, vocab: 151936 },
  'phi4-mini-q4': { layers: 32, hidden: 3072, vocab: 200064 },
  'qwen2.5-7b-q4': { layers: 28, hidden: 3584, vocab: 152064 },
  // mixtures of experts (10.11.2026, read off the headers the same way)
  'qwen3-30b-a3b': { layers: 48, hidden: 2048, vocab: 151936 },
  'gemma4-26b-a4b': { layers: 30, hidden: 2816, vocab: 262144 },
};

const bytesPerParam = (quant: string) => (/q8/i.test(quant) ? 1 : /q3/i.test(quant) ? 0.45 : /f16|bf16/i.test(quant) ? 2 : 0.55);

/**
 * A model's shape for the simulator; an unknown (hugging face) model gets a guess from its size.
 * A mixture of experts carries its active share (fit.ts activeShare): the planner's speed reads
 * the active weights, its memory the whole file.
 */
export function modelProfile(m: Pick<CatalogModel, 'id' | 'size' | 'quant' | 'kv_mb_per_1k'> & { params_b?: number; active_b?: number; file?: string }): SimModel {
  const a = ARCH[m.id];
  const bpp = bytesPerParam(m.quant);
  const params = m.params_b ?? m.size / bpp / 1e9;
  // roughly: hidden grows with the cube root of the parameters, 28 layers, a 150k vocabulary
  const guess = { layers: 28, hidden: Math.round((1024 * Math.cbrt(params / 0.6)) / 128) * 128, vocab: 151936 };
  const { layers, hidden, vocab } = a ?? guess;
  const active = activeShare(m);
  return { id: m.id, fileMb: m.size / MB, layers, hidden, vocab, bytesPerParam: bpp, kvMbPer1k: m.kv_mb_per_1k, ...(active < 1 ? { activeShare: active } : {}) };
}
export const MODELS: SimModel[] = CATALOG.map(modelProfile);
export const modelById = (id: string) => MODELS.find((m) => m.id === id) ?? null;

/** A profile as the master (its free ram × LOCAL_SHARE) or as a worker (× WORKER_SHARE). */
export const asLocal = (d: DeviceProfile): SimDevice => ({ id: d.id, capMb: d.ramFreeMb * LOCAL_SHARE, bw: d.bw, eff: d.eff });
export const asWorker = (d: DeviceProfile): SimDevice => ({ id: d.id, capMb: d.ramFreeMb * WORKER_SHARE, bw: d.bw, eff: d.eff });

/** This phone from its passport, for the master's seat. */
export function localFromPassport(p: Passport | null, freeMb: number): SimDevice {
  const bw = p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || DEFAULT_BW : DEFAULT_BW;
  return { id: 'me', capMb: freeMb * LOCAL_SHARE, bw, eff: DEFAULT_EFF };
}
/** A paired peer (ram and bw from its qr) for a worker's seat; a pc gets the mac's measured efficiency. */
export function workerFromPeer(p: { id: string; ram: number | null; bw: number | null; kind: string }): SimDevice {
  return { id: p.id, capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? DEFAULT_BW, eff: p.kind === 'pc' ? 0.3 : DEFAULT_EFF };
}
