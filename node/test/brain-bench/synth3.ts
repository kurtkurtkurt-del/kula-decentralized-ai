// the brain bench v3's synthetic looks (L8 P47): a split load of MODEL across this computer and one
// or two workers, 1440 looks of 60 s with a fresh probe of every worker each look, for one number
// bench v2 did not have: the split's hop, k * sum srtt. Each look the split finishes a new answer
// at 0.5; its tok/s comes from the scenario's true compute time C and true hop factor K over the
// workers' base latencies (not the probe's), so k is learnable from the answers and senses' srtt.
// Nothing here reads a clock, the network or a file: every number comes from mulberry32(seed), so
// the same seed is the same stream, look for look. K and C are invented (DECISIONS-L8 risks).
import type { EyeDevice, Snapshot } from '../../src/godseye/types.ts';
import { mulberry32, gauss, START, MODEL } from './synth.ts';

const MIN = 60_000;
const LOOKS = 1440;

/** the look from which far's base latency is 260 ms instead of 140 */
export const SHIFT_AT = 720;

/** a scenario's own stream: the seed mixed with the scenario's name (copied from synth2.ts) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

type WorkerName = 'near' | 'far';

/** a worker's base latency at look i: near is wi-fi at 20 ms; far is the internet, 140 then 260 */
export function baseOf(w: WorkerName, i: number): number {
  if (w === 'near') return 20;
  return i >= SHIFT_AT ? 260 : 140;
}

/** one probe of worker w at look i, from one gauss draw */
function probeMs(w: WorkerName, i: number, g: number): number {
  if (w === 'near') return Math.max(1, Math.round(20 + 3 * g));
  let ms = Math.max(1, Math.round(baseOf(w, i) * Math.exp(0.25 * g)));
  if (i % 40 === 39) ms *= 3;
  return ms;
}

function probed(id: WorkerName, at: number, ms: number): EyeDevice {
  return {
    id, name: id, kind: 'phone', via: id === 'near' ? 'wifi' : 'internet', where: '', reachable: true, reachMs: ms,
    reason: null, checkedAt: at, lastOk: at, ramMb: 6000, bwGBs: 20, gpu: null, tls: true, waitingPair: false,
    plugged: null, holds: null, trust: null,
  };
}

export type Scenario3Name = 'lan' | 'far' | 'two';
export const SCENARIOS3: Scenario3Name[] = ['lan', 'far', 'two'];

interface Spec { workers: WorkerName[]; C: number; K: number }
const SPECS: Record<Scenario3Name, Spec> = {
  lan: { workers: ['near'], C: 120, K: 0.5 },
  far: { workers: ['far'], C: 120, K: 1.2 },
  two: { workers: ['near', 'far'], C: 150, K: 0.8 },
};

/** what the scenario drew its answers from: the compute ms per token, the hop factor, the workers */
export function truth3(name: Scenario3Name): { computeMs: number; k: number; workers: string[] } {
  const s = SPECS[name];
  return { computeMs: s.C, k: s.K, workers: [...s.workers] };
}

/** the scenario's noiseless tok/s at look i (L10 P57): 1000 / (C + sum_w (K base_w(i) + 0.5)) */
export function trueTps(name: Scenario3Name, i: number): number {
  const s = SPECS[name];
  let ms = s.C;
  for (const w of s.workers) ms += s.K * baseOf(w, i) + 0.5;
  return 1000 / ms;
}

/** a scenario's stream: 1440 looks of 60 s from START, every worker reachable and probed each look.
 *  Draw order per look: each worker's probe gauss; u = rng(); when u < 0.5 a new answer: g1, then
 *  one gauss per worker. perTokenMs = C exp(0.05 g1) + sum_w (K base_w(i) exp(0.10 g_w) + 0.5);
 *  tps = round(100000 / perTokenMs) / 100. */
export function* scenario3(name: Scenario3Name, seed: number): Generator<Snapshot> {
  const spec = SPECS[name];
  const rng = rngFor(name, seed);
  let tps: number | null = null;
  let done = 0;
  for (let i = 0; i < LOOKS; i++) {
    const t = START + i * MIN;
    const devices = spec.workers.map((w) => probed(w, t, probeMs(w, i, gauss(rng))));
    const u = rng();
    if (u < 0.5) {
      const g1 = gauss(rng);
      let perTokenMs = spec.C * Math.exp(0.05 * g1);
      for (const w of spec.workers) perTokenMs += spec.K * baseOf(w, i) * Math.exp(0.10 * gauss(rng)) + 0.5;
      tps = Math.round(100_000 / perTokenMs) / 100;
      done++;
    }
    yield {
      at: t,
      host: { name: 'bench', freeMb: 16_000 },
      devices,
      work: {
        loaded: {
          mode: 'split',
          model: { id: MODEL.id, name: MODEL.name, file: MODEL.file, size: MODEL.size },
          ctx: 4096,
          since: START,
          devices: [{ id: 'local', name: 'bench', local: true, busy: false, tps, done }],
          parts: [
            { id: 'local', name: 'bench', local: true, mb: 2000, layers: 10 },
            ...spec.workers.map((w) => ({ id: w, name: w, local: false, mb: 2000, layers: 10 })),
          ],
        },
        loading: null, chatting: 0, plan: [], decisions: [], llama: true,
      },
      models: [MODEL],
      projects: [],
    };
  }
}
