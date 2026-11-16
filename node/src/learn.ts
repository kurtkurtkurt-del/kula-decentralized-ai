// What each device really does, learned from its answers (15.11.2026), so the planner stops
// guessing. Per device the efficiency: the share of its memory speed it turns into tokens
// (tok/s × the GB read per token ÷ its GB/s, sim.ts effFromTps). Unlike tok/s it carries over
// from one model to another. A split is kept as the tok/s it really ran at, per set of devices
// and model, to say next to the estimate, with the compute scale k its answers showed (splitScale,
// 16.11.2026) that the next plan of the same split uses. ~/.kula-node/speeds.json, nothing in it is secret.
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.js';

export interface Learned { eff: number; n: number; at: string }
// k: the compute scale this split's answers showed (planner.ts PlanInput.computeScale): how much
// faster (k > 1) or slower than the guessed efficiencies its devices really computed. Absent until
// an answer of at least MIN_TOKENS whose network part was at most SPLIT_NET_MAX of the token.
export interface SplitSeen { tps: number; n: number; at: string; k?: number }
export interface Speeds { devices: Record<string, Learned>; splits: Record<string, SplitSeen> }

export const MIN_TOKENS = 16;   // shorter answers say more about the first token than the speed
const KEEP = 0.7;               // how much of the old value a new answer keeps (a running average)

export const speedsFile = () => path.join(home(), 'speeds.json');

export function readSpeeds(file = speedsFile()): Speeds {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { devices: o?.devices && typeof o.devices === 'object' ? o.devices : {}, splits: o?.splits && typeof o.splits === 'object' ? o.splits : {} };
  } catch { return { devices: {}, splits: {} }; }
}

function write(s: Speeds, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(file + '.tmp', file);
}

const blend = (old: number | undefined, x: number, n: number) => (old === undefined || n === 0 ? x : old * KEEP + x * (1 - KEEP));

// one answer of `id` at this efficiency; nonsense (0, NaN, above 1.5) is not learned
export function learnDevice(id: string, eff: number, file = speedsFile(), now = new Date()): Learned | null {
  if (!(eff > 0) || eff > 1.5 || !id) return null;
  const s = readSpeeds(file);
  const o = s.devices[id];
  const l = { eff: Math.round(blend(o?.eff, eff, o?.n ?? 0) * 1000) / 1000, n: Math.min((o?.n ?? 0) + 1, 1000), at: now.toISOString() };
  s.devices[id] = l;
  write(s, file);
  return l;
}

export const splitKey = (model: string, ids: string[]) => `${model}|${[...ids].sort().join(',')}`;

// Learning from a split (16.11.2026, D2 T1): the planner's compute inputs are guesses (0.6 for this
// computer unlearned, 0.3 for a computer worker), and a split teaches nothing per device. What a
// split answer does show is its compute: the measured ms a token less the network part of the
// plan's estimate. k scales every device's efficiency of this split by the same factor, so the
// layout stays and the estimate follows what was seen. Only when the network is at most
// SPLIT_NET_MAX of the measured token: past that the compute left over is mostly noise.
export const SPLIT_K_MIN = 0.4;
export const SPLIT_K_MAX = 4;
export const SPLIT_NET_MAX = 0.8;

/**
 * The compute scale one split answer shows, or null when it teaches nothing about compute.
 * est: the plan's estimate made with kUsed (perTokenMs, netMsPerToken); tps: the answer's speed.
 */
export function splitScale(est: { perTokenMs: number; netMsPerToken: number }, kUsed: number, tps: number): number | null {
  if (!(tps > 0) || !Number.isFinite(tps) || !(kUsed > 0)) return null;
  const measuredMs = 1000 / tps;
  const net = Math.max(0, est.netMsPerToken);
  if (net > SPLIT_NET_MAX * measuredMs) return null;
  const estCompute = est.perTokenMs - net;
  const measuredCompute = measuredMs - net;
  if (!(estCompute > 0) || !(measuredCompute > 0)) return null;
  return Math.min(SPLIT_K_MAX, Math.max(SPLIT_K_MIN, (kUsed * estCompute) / measuredCompute));
}

// k: what splitScale gave for this answer (null or absent: the stored k stays as it was)
export function learnSplit(key: string, tps: number, file = speedsFile(), now = new Date(), k?: number | null): SplitSeen | null {
  if (!(tps > 0) || !Number.isFinite(tps)) return null;
  const s = readSpeeds(file);
  const o = s.splits[key];
  const l: SplitSeen = { tps: Math.round(blend(o?.tps, tps, o?.n ?? 0) * 10) / 10, n: Math.min((o?.n ?? 0) + 1, 1000), at: now.toISOString() };
  const kOld = o?.k !== undefined && o.k > 0 ? o.k : undefined;
  if (k != null && k > 0 && Number.isFinite(k)) l.k = Math.round(Math.min(SPLIT_K_MAX, Math.max(SPLIT_K_MIN, blend(kOld, k, kOld === undefined ? 0 : 1))) * 1000) / 1000;
  else if (kOld !== undefined) l.k = kOld;
  s.splits[key] = l;
  write(s, file);
  return l;
}
