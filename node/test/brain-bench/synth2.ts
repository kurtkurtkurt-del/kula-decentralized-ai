// the brain bench v2's synthetic looks (L6 P32): seeded scenarios of 60 s looks with a fresh probe
// every look, for the three numbers bench v1 did not have: learning's speed interval, its
// reachability guess and the link latency guesses of connections and senses. Nothing here reads a
// clock, the network or a file: every number comes from mulberry32(seed), so the same seed is the
// same stream, look for look.
import type { EyeDevice, Snapshot } from '../../src/godseye/types.ts';
import { mulberry32, gauss, START, MODEL, speed } from './synth.ts';

const MIN = 60_000;

/** a scenario's own stream: the seed mixed with the scenario's name (the same mix as synth.ts) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

/** a device as one probe found it at look time at: there with ms, or not with a reason */
function probed(id: string, there: boolean, at: number, ms: number, via: EyeDevice['via']): EyeDevice {
  return {
    id, name: id, kind: 'phone', via, where: '', reachable: there, reachMs: there ? ms : null,
    reason: there ? null : 'no answer', checkedAt: at, lastOk: null, ramMb: 6000, bwGBs: 20, gpu: null,
    tls: true, waitingPair: false, plugged: null, holds: null, trust: null,
  };
}

function snapshot(at: number, devices: EyeDevice[]): Snapshot {
  return {
    at, host: { name: 'bench', freeMb: 16_000 }, devices,
    work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
    models: [MODEL], projects: [],
  };
}

export type Scenario2Name = 'speed' | 'reach' | 'far';
export const SCENARIOS2: Scenario2Name[] = ['speed', 'reach', 'far'];

/** reach: 1440 looks on wi-fi. steady answers at 0.95. bursty is a two-state chain that starts
 *  good: good to bad at 0.05, bad to good at 0.30; it answers at 0.98 when good and 0.10 when bad.
 *  The chain steps after each look's probe. */
export function* reach(seed: number, looks = 1440): Generator<Snapshot> {
  const rng = rngFor('reach', seed);
  let good = true;
  for (let i = 0; i < looks; i++) {
    const t = START + i * MIN;
    const steady = rng() < 0.95;
    const bursty = rng() < (good ? 0.98 : 0.10);
    good = good ? rng() >= 0.05 : rng() < 0.30;
    const msS = Math.max(1, Math.round(20 + 3 * gauss(rng)));
    const msB = Math.max(1, Math.round(20 + 3 * gauss(rng)));
    yield snapshot(t, [probed('steady', steady, t, msS, 'wifi'), probed('bursty', bursty, t, msB, 'wifi')]);
  }
}

/** the look from which far's base latency is 260 ms instead of 140 */
export const FAR_SHIFT_AT = 720;
export const FAR_SHIFT_TO = 260;

/** far: 1440 looks. far is reached via 'internet' and answers at 0.97, in round(base *
 *  exp(0.25 gauss)) ms; the base is 140, 260 from look 720 on, and every 40th answer is x3.
 *  near is on wi-fi, 20±3 ms, and always answers. */
export function* far(seed: number, looks = 1440): Generator<Snapshot> {
  const rng = rngFor('far', seed);
  let answers = 0;
  for (let i = 0; i < looks; i++) {
    const t = START + i * MIN;
    const there = rng() < 0.97;
    const base = i >= FAR_SHIFT_AT ? FAR_SHIFT_TO : 140;
    let msF = Math.max(1, Math.round(base * Math.exp(0.25 * gauss(rng))));
    if (there) {
      answers++;
      if (answers % 40 === 0) msF *= 3;
    }
    const msN = Math.max(1, Math.round(20 + 3 * gauss(rng)));
    yield snapshot(t, [probed('far', there, t, msF, 'internet'), probed('near', true, t, msN, 'wifi')]);
  }
}

/** a device's true chance of answering a probe, where it is one constant: steady in reach (0.95)
 *  and far in far (0.97); null for every other device (bursty is a chain, near always answers) */
export function reachRate(name: string, id: string): number | null {
  if (name === 'reach' && id === 'steady') return 0.95;
  if (name === 'far' && id === 'far') return 0.97;
  return null;
}

// ---- L11 P62: a drift for bench7 (not in SCENARIOS2, not in scenario2)

/** the look from which drifty answers at 0.70 instead of 0.95 */
export const DRIFT_AT = 720;

/** drift: 1440 looks. One device on wi-fi, drifty, answers at 0.95 before look DRIFT_AT and at
 *  0.70 from it, in 20±3 ms. Its own stream. */
export function* drift(seed: number, looks = 1440): Generator<Snapshot> {
  const rng = rngFor('drift', seed);
  for (let i = 0; i < looks; i++) {
    const t = START + i * MIN;
    const there = rng() < driftRate(i);
    const ms = Math.max(1, Math.round(20 + 3 * gauss(rng)));
    yield snapshot(t, [probed('drifty', there, t, ms, 'wifi')]);
  }
}

/** drifty's true chance of answering at look i */
export const driftRate = (i: number): number => (i >= DRIFT_AT ? 0.70 : 0.95);

/** a scenario's stream by name; speed is synth.ts's own */
export function scenario2(name: Scenario2Name, seed: number): Iterable<Snapshot> {
  switch (name) {
    case 'speed': return speed(seed);
    case 'reach': return reach(seed);
    case 'far': return far(seed);
  }
}
