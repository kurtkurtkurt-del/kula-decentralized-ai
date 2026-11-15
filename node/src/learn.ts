// What each device really does, learned from its answers (15.11.2026), so the planner stops
// guessing. Per device the efficiency: the share of its memory speed it turns into tokens
// (tok/s × the GB read per token ÷ its GB/s, sim.ts effFromTps). Unlike tok/s it carries over
// from one model to another. A split is kept as the tok/s it really ran at, per set of devices
// and model, to say next to the estimate. ~/.kula-node/speeds.json, nothing in it is secret.
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.js';

export interface Learned { eff: number; n: number; at: string }
export interface SplitSeen { tps: number; n: number; at: string }
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

export function learnSplit(key: string, tps: number, file = speedsFile(), now = new Date()): SplitSeen | null {
  if (!(tps > 0) || !Number.isFinite(tps)) return null;
  const s = readSpeeds(file);
  const o = s.splits[key];
  const l = { tps: Math.round(blend(o?.tps, tps, o?.n ?? 0) * 10) / 10, n: Math.min((o?.n ?? 0) + 1, 1000), at: now.toISOString() };
  s.splits[key] = l;
  write(s, file);
  return l;
}
