// the brain bench's synthetic looks (L5 P30): seeded scenarios, each a stream of snapshots shaped
// the way kula's engine hands them to the eye. Nothing here reads a clock, the network or a file:
// every number comes from mulberry32(seed), so the same seed is the same stream, look for look.
//
// the clock is the local one, as the forecast's slots are (hour of the week on this computer).
import type { EyeDevice, EyeModel, EyeWork, Snapshot } from '../../src/godseye/types.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** monday 5 january 2026, 00:00 on the local clock */
export const START = new Date(2026, 0, 5).getTime();

/** mulberry32: a 32-bit seeded random in [0, 1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** one standard normal draw (box-muller, two uniforms) */
export function gauss(rng: () => number): number {
  const u = 1 - rng();                     // (0, 1]: log never sees 0
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** a scenario's own stream: the seed mixed with the scenario's name, so two scenarios with one
 *  seed do not walk the same numbers */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

export const MODEL: EyeModel = {
  id: 'm', name: 'bench model', file: 'm.gguf', size: 1_000_000_000, quant: 'q4', params_b: 1.5,
  catalog: true, here: true, needMb: 1500,
};

function device(id: string, o: Partial<EyeDevice> = {}): EyeDevice {
  return {
    id, name: id, kind: 'phone', via: 'wifi', where: '', reachable: null, reachMs: null, reason: null,
    checkedAt: null, lastOk: null, ramMb: 6000, bwGBs: 20, gpu: null, tls: true, waitingPair: false,
    plugged: null, holds: null, trust: null, ...o,
  };
}

function work(loaded: EyeWork['loaded'] = null): EyeWork {
  return { loaded, loading: null, chatting: 0, plan: [], decisions: [], llama: true };
}

function snapshot(at: number, devices: EyeDevice[], loaded: EyeWork['loaded'] = null): Snapshot {
  return { at, host: { name: 'bench', freeMb: 16_000 }, devices, work: work(loaded), models: [MODEL], projects: [] };
}

/** a device as one probe found it: there, or not with a reason */
function probed(id: string, there: boolean, at: number, ms: number, o: Partial<EyeDevice> = {}): EyeDevice {
  return device(id, { reachable: there, reachMs: there ? ms : null, reason: there ? null : 'no answer', checkedAt: at, ...o });
}

export type ScenarioName = 'weekly' | 'coin' | 'speed' | 'stable' | 'lossy';
export const SCENARIOS: ScenarioName[] = ['weekly', 'coin', 'speed', 'stable', 'lossy'];

/** weekly: 60 s looks for 42 days. night is there 22-07 on nights drawn at 0.9, otherwise each
 *  hour at 0.1; office is there mon-fri 9-17 on days drawn at 0.9, otherwise each hour at 0.05.
 *  presence holds for the whole hour. */
export function* weekly(seed: number): Generator<Snapshot> {
  const rng = rngFor('weekly', seed);
  const days = 42;
  const hours = days * 24;
  const nights: boolean[] = [];                       // night k starts on the evening of day k - 1
  for (let k = 0; k <= days; k++) nights.push(rng() < 0.9);
  const workdays: boolean[] = [];
  for (let k = 0; k < days; k++) workdays.push(rng() < 0.9);
  const night: boolean[] = [];
  const office: boolean[] = [];
  for (let k = 0; k < hours; k++) {
    const d = new Date(START + k * HOUR);
    const h = d.getHours();
    const dow = d.getDay();
    const day = Math.floor(k / 24);
    const nightOf = h >= 22 ? day + 1 : h < 7 ? day : -1;
    night.push(nightOf >= 0 && nights[nightOf] ? true : rng() < 0.1);
    const workHour = dow >= 1 && dow <= 5 && h >= 9 && h < 17;
    office.push(workHour && workdays[day] ? true : rng() < 0.05);
  }
  for (let t = START, i = 0; t < START + days * DAY; t += MIN, i++) {
    const k = Math.floor((t - START) / HOUR);
    yield snapshot(t, [probed('night', night[k], t, 25), probed('office', office[k], t, 15)]);
  }
}

/** coin: one device, there each hour at 0.5, for 28 days of 60 s looks */
export function* coin(seed: number): Generator<Snapshot> {
  const rng = rngFor('coin', seed);
  const days = 28;
  const there: boolean[] = [];
  for (let k = 0; k < days * 24; k++) there.push(rng() < 0.5);
  for (let t = START; t < START + days * DAY; t += MIN) {
    yield snapshot(t, [probed('coin', there[Math.floor((t - START) / HOUR)], t, 20)]);
  }
}

/** speed: 600 looks of 60 s with an apart load of m.gguf; each device finishes one answer a look.
 *  p1 runs at 12 tok/s, 18 from look 300 on, with 10% gaussian noise; p2 at 30 with 5%. */
export function* speed(seed: number, looks = 600): Generator<Snapshot> {
  const rng = rngFor('speed', seed);
  const since = START - MIN;
  const tps = (base: number, noise: number): number => Math.max(0.1, Math.round(base * (1 + noise * gauss(rng)) * 100) / 100);
  for (let i = 0; i < looks; i++) {
    const t = START + i * MIN;
    const p1 = tps(i >= 300 ? 18 : 12, 0.1);
    const p2 = tps(30, 0.05);
    yield snapshot(t, [probed('p1', true, t, 20, { holds: MODEL.file }), probed('p2', true, t, 18, { holds: MODEL.file })], {
      mode: 'apart',
      model: { id: MODEL.id, name: MODEL.name, file: MODEL.file, size: MODEL.size },
      ctx: 4096,
      since,
      devices: [
        { id: 'p1', name: 'p1', local: false, busy: false, tps: p1, done: i + 1 },
        { id: 'p2', name: 'p2', local: false, busy: false, tps: p2, done: i + 1 },
      ],
    });
  }
}

/** stable: 1440 looks of 5 s, a probe every third look, no flips. a: 20±3 ms with 200 ms on every
 *  50th reading; b: on a cable, 2±0.5 ms; c: seated in the load, its checkedAt frozen after look
 *  100 (the engine does not probe a device in use). lossy: the same, with a failing 5% of its
 *  probes. */
export function* stable(seed: number, lossy = false): Generator<Snapshot> {
  const rng = rngFor(lossy ? 'lossy' : 'stable', seed);
  const step = 5_000;
  let a = probed('a', true, START, 20);
  let b = probed('b', true, START, 2, { via: 'cable', plugged: true });
  let c = probed('c', true, START, 30, { holds: MODEL.file });
  let readsA = 0;
  for (let i = 0; i < 1440; i++) {
    const t = START + i * step;
    if (i % 3 === 0) {
      readsA++;
      const fails = lossy && rng() < 0.05;
      const msA = readsA % 50 === 0 ? 200 : Math.max(1, Math.round(20 + 3 * gauss(rng)));
      a = probed('a', !fails, t, msA);
      b = probed('b', true, t, Math.max(0.1, Math.round((2 + 0.5 * gauss(rng)) * 10) / 10), { via: 'cable', plugged: true });
      if (i <= 100) c = probed('c', true, t, Math.max(1, Math.round(30 + 2 * gauss(rng))), { holds: MODEL.file });
    }
    yield snapshot(t, [a, b, c], {
      mode: 'apart',
      model: { id: MODEL.id, name: MODEL.name, file: MODEL.file, size: MODEL.size },
      ctx: 4096,
      since: START - step,
      devices: [{ id: 'c', name: 'c', local: false, busy: false, tps: null, done: 0 }],
    });
  }
}

/** a scenario's stream by name */
export function scenario(name: ScenarioName, seed: number): Iterable<Snapshot> {
  switch (name) {
    case 'weekly': return weekly(seed);
    case 'coin': return coin(seed);
    case 'speed': return speed(seed);
    case 'stable': return stable(seed, false);
    case 'lossy': return stable(seed, true);
  }
}
