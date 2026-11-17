// the brain bench v9's synthetic looks (17 Nov, P2): a split of this computer with far workers, priced
// two ways. Each "home" is one split: this computer and one far worker reached over the internet
// ('one'), two such workers ('two'), or one worker reached through a third computer's anchor, so its
// round trip is that anchor's two legs together ('anchor'). Per home the true compute ms per token C,
// the true round trips per token K and each worker's true round trip are drawn once; then WARM9 looks
// of probes with the split loaded and no answer yet (senses needs 5 ok readings for a link), then one
// new answer per look for ANSWERS9 looks.
//  - the probe (reachMs) is a whole handshake: 4 x the round trip, times exp(0.1 g), plus 0-~9 ms;
//  - the engine's measured link (linkRttMs) is the round trip times exp(0.05 g), measured a minute
//    before the first look (link.ts takes a median of 5 requests, so it is close);
//  - an answer: perTokenMs = C exp(0.05 g) + sum_w K rtt_w exp(0.10 g_w), tps to 0.01.
// K is drawn from the D1 fit, 0.95–1.16, the same range the new pricing assumes: the bench is circular
// for the new pricing (DECISIONS RISK) and only shows how far the old one is off and how fast each
// learns. The real-points test (godseye-hop-points.test.ts) is the proof against measured answers.
// Nothing here reads a clock, the network or a file: every number comes from mulberry32.
import type { EyeDevice, EyeModel, Snapshot } from '../../src/godseye/types.ts';
import { mulberry32, gauss, START } from './synth.ts';

const MIN = 60_000;

export type Scenario9Name = 'one' | 'two' | 'anchor';
export const SCENARIOS9: Scenario9Name[] = ['one', 'two', 'anchor'];
export const HOMES9 = 20;      // homes per scenario and seed
export const WARM9 = 8;        // looks of probes before the first answer
export const ANSWERS9 = 12;    // answers per home, one a look

/** a home's own stream: the seed mixed with the scenario's name and the home (as synth2.ts) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

/** the model of a scenario: 1000 MB on this computer and on each worker (decide.ts caps them at 1000) */
export function model9(name: Scenario9Name): EyeModel {
  const n = name === 'two' ? 3 : 2;
  return { id: `m9${name}`, name: `bench9 ${name}`, file: `m9${name}.gguf`, size: 1_000_000_000, quant: 'q4', params_b: null, catalog: true, here: true, needMb: 1000 * n };
}

/** what a home's answers come from */
export interface Truth9 { computeMs: number; k: number; rtts: number[]; legs: [number, number] | null }
export interface Home9Looks { truth: Truth9; workers: string[]; looks: Snapshot[] }

/** this computer's free memory with its 1000 MB part loaded: floor((429 + 1000) x 0.7) = 1000 */
const HOST_FREE = 429;
/** a worker's memory: floor(1334 x 0.75) = 1000 */
const WORKER_RAM = 1334;

function device(id: string, via: 'internet' | 'anchor', at: number, probeMs: number, rtt: number): EyeDevice {
  return {
    id, name: id, kind: 'pc', via, ...(via === 'anchor' ? { through: 'a', throughName: 'anchor' } : {}),
    where: via === 'anchor' ? 'through anchor' : 'internet', reachable: true, reachMs: probeMs, reason: null,
    checkedAt: at, lastOk: null, ramMb: WORKER_RAM, bwGBs: null, gpu: null, tls: true, waitingPair: false,
    plugged: null, holds: null, trust: null, linkRttMs: rtt, linkAt: START - MIN,
  };
}

/** one home: its truth and its WARM9 + ANSWERS9 looks. Draw order: C, K, each worker's round trip
 *  (anchor: its two legs), each worker's measured-link gauss; then per look each worker's probe (g, |g|)
 *  and, from WARM9 on, the answer's g for C and one per worker */
export function home9(name: Scenario9Name, seed: number, home: number): Home9Looks {
  const rng = rngFor(`${name}#${home}`, seed);
  const m = model9(name);
  const computeMs = 15 + 65 * rng();
  const k = 0.95 + 0.21 * rng();
  const workers = name === 'two' ? ['w1', 'w2'] : ['w1'];
  let legs: [number, number] | null = null;
  const rtts = workers.map(() => {
    if (name !== 'anchor') return 10 + 110 * rng();
    legs = [5 + 55 * rng(), 5 + 55 * rng()];
    return legs[0] + legs[1];
  });
  const measured = rtts.map((r) => Math.round(r * Math.exp(0.05 * gauss(rng)) * 10) / 10);
  const via = name === 'anchor' ? 'anchor' : 'internet';
  const looks: Snapshot[] = [];
  let tps: number | null = null;
  let done = 0;
  for (let i = 0; i < WARM9 + ANSWERS9; i++) {
    const at = START + i * MIN;
    const probes = rtts.map((r) => Math.max(1, Math.round(4 * r * Math.exp(0.1 * gauss(rng)) + 3 * Math.abs(gauss(rng)))));
    if (i >= WARM9) {
      let ms = computeMs * Math.exp(0.05 * gauss(rng));
      for (const r of rtts) ms += k * r * Math.exp(0.10 * gauss(rng));
      tps = Math.round(100_000 / ms) / 100;
      done++;
    }
    looks.push({
      at,
      host: { name: 'bench', freeMb: HOST_FREE },
      devices: workers.map((w, j) => device(w, via, at, probes[j], measured[j])),
      work: {
        loaded: {
          mode: 'split',
          model: { id: m.id, name: m.name, file: m.file, size: m.size },
          ctx: 4096,
          since: START,
          devices: [{ id: 'local', name: 'bench', local: true, busy: false, tps, done }],
          parts: [
            { id: 'local', name: 'bench', local: true, mb: 1000, layers: 10 },
            ...workers.map((w) => ({ id: w, name: w, local: false, mb: 1000, layers: 10 })),
          ],
        },
        loading: null, chatting: 0, plan: [], decisions: [], llama: true,
      },
      models: [m],
      projects: [],
    });
  }
  return { truth: { computeMs, k, rtts, legs }, workers, looks };
}

/** a look as the brain saw it before 17 Nov: no measured link */
export function withoutLink(s: Snapshot): Snapshot {
  return { ...s, devices: s.devices.map(({ linkRttMs: _r, linkAt: _a, ...d }) => d) };
}
