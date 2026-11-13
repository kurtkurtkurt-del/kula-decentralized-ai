// god's eye, the split's second order (L10 P56): with a usable k, split() also tries the workers
// nearest-cost first (each worker's compute per MB plus its link per MB of the room it gives), and
// takes a set from that order only when it is strictly faster than the speed order's best. Without a
// k it is the speed order alone, as before.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-split-order-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const planner = await import('../src/godseye/branches/planner.ts');
const decide = await import('../src/godseye/branches/decide.ts');

// ---- copied from godseye-hop-wire.test.ts:19-58
const GB = 1024 * 1024 * 1024;
const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...o,
});
const model = (id: string, name: string, needMb: number, size: number, o: Record<string, unknown> = {}) => ({
  id, name, file: `${id}.gguf`, size, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const AT = new Date(2026, 10, 11, 15, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 8000 },
  devices: [dev(), dev({ id: 'p2', name: 'galaxy' })],
  models: [],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});

// ---- fixture X: 6000 MB, 4 GB (readGb 4.2); host 8000 free (cap 5600); p1 wifi and p2 internet, 4000 each (cap 3000)
const X = model('x', 'X', 6000, 4 * GB);
const P1 = { srtt: 20, rttvar: 2 };
const P2 = { srtt: 200, rttvar: 20 };
const S0 = snap({ devices: [dev({ ramMb: 4000 }), dev({ id: 'p2', name: 'galaxy', via: 'internet', ramMb: 4000 })], models: [X] });
// measured on X's file: local 2, p1 6, p2 5 tok/s (n 5): GB/s 8.4, 25.2, 21
const MEASURED = () => new Map<string, any[]>([
  ['local', [{ file: X.file, tps: 2, n: 5 }]], ['p1', [{ file: X.file, tps: 6, n: 5 }]], ['p2', [{ file: X.file, tps: 5, n: 5 }]],
]);
const SPEEDS = () => ({ local: { [X.file]: { tps: 2, n: 5, at: AT } }, p1: { [X.file]: { tps: 6, n: 5, at: AT } }, p2: { [X.file]: { tps: 5, n: 5, at: AT } } });
const senses = (hints: unknown[] = [{ id: 'p1', link: P1 }, { id: 'p2', link: P2 }]) => ({ senses: { hints } });
const peekOf = (peeks: Record<string, any>) => ({ peek: (id: string) => peeks[id] ?? null });
const fieldX = (peeks: Record<string, any> = senses(), s: any = S0, m = MEASURED()) => decide.field(s, peekOf(peeks) as any, m);
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const seatIds = (p: any) => p.seats.map((x: any) => x.id);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** the planner with a fake ctx whose now() moves 61 s per call (so every look may save) */
function branch(peeks: Record<string, any> = {}, notes: unknown = null) {
  let t = AT;
  let kept: unknown = notes;
  const b = planner.create({
    now: () => (t += 61_000),
    load: <T,>(fb: T): T => (kept as T) ?? fb,
    save: (d: unknown) => { kept = structuredClone(d); },
    emit: () => {},
    peek: (id: string) => peeks[id] ?? null,
  } as any);
  const look = (s: any, n = 1) => { for (let i = 0; i < n; i++) b.observe(s, null); return b.view(); };
  return { look, notes: () => kept as any };
}

// ---- fixture Y: X's model and speeds, but p1 (tps 6) over the internet at srtt 400, p2 (tps 5) on wifi at srtt 20
const Y1 = { srtt: 400, rttvar: 40 };
const Y2 = { srtt: 20, rttvar: 2 };
const SY = snap({ devices: [dev({ ramMb: 4000, via: 'internet' }), dev({ id: 'p2', name: 'galaxy', ramMb: 4000 })], models: [X] });
const sensesY = () => senses([{ id: 'p1', link: Y1 }, { id: 'p2', link: Y2 }]);
const fieldY = () => fieldX(sensesY(), SY);

test('Y, k 1: the near slower phone is taken, not the fast far one', () => {
  // speed order (p1, p2): two seats 83.333 + 250 + 400 = 733.3 ms; three 83.333 + 100 + 420 = 603.3 (1.7)
  // perMb: p1 4200 / (6000 x 25.2) + 400 / 3000 = 0.1611; p2 4200 / (6000 x 21) + 20 / 3000 = 0.0400: (p2, p1)
  // nearest-cost order: local and p2 = 100 + 250 + 20 = 370 ms (2.7), strictly less than 603.3
  const p = decide.split(fieldY(), X, 1, 1)!;
  assert.deepEqual(seatIds(p), ['local', 'p2']);
  near(p.chain!.computeMs, 350, 1e-3);
  assert.deepEqual(p.chain!.links, [Y2]);
  assert.equal(p.tps, 2.7);
  assert.equal(p.tps, r1(1000 / 370));
  assert.deepEqual(p.action.devices, ['p2']);
  // the shares inside the set still go to the fastest first: p2 (21 GB/s) before this computer (8.4)
  assert.deepEqual(p.shares!.map((x) => [x.seat.id, x.mb]), [['p2', 3000], ['local', 3000]]);
});

test('Y without k: the speed order alone, as before', () => {
  // three seats: 83.333 + 100 + 2 x HOP_MS = 203.3 ms -> 4.9
  const p = decide.split(fieldY(), X)!;
  assert.deepEqual(seatIds(p), ['local', 'p1', 'p2']);
  assert.equal(p.tps, 4.9);
  assert.equal('chain' in p, false);
});

test('Y, k 0.01: the links cost almost nothing, the speed order holds', () => {
  // perMb: p1 0.02778 + 4 / 3000 = 0.0291; p2 0.03333 + 0.2 / 3000 = 0.0334: the same order as by speed
  // three seats: 183.333 + 0.01 x 420 = 187.533 ms -> 5.3 (two: 333.333 + 4 = 337.3)
  const p = decide.split(fieldY(), X, 1, 0.01)!;
  assert.deepEqual(seatIds(p), ['local', 'p1', 'p2']);
  assert.equal(p.tps, r1(1000 / (550 / 3 + 4.2)));
  assert.equal(p.tps, 5.3);
  near(p.chain!.computeMs, 550 / 3, 1e-3);
  assert.deepEqual(p.chain!.links, [Y1, Y2]);
});

test("X's own links: the same as godseye-hop-wire's expectations", () => {
  // perMb at k 1: p1 0.0278 + 0.0067, p2 0.0333 + 0.0667; at k 0.5 the same order: one order only
  const a = decide.split(fieldX(), X, 1, 1)!;
  assert.deepEqual(seatIds(a), ['local', 'p1']);
  assert.equal(a.tps, 2.8);
  near(a.chain!.computeMs, 1000 / 3, 1e-3);
  assert.deepEqual(a.chain!.links, [P1]);
  const b = decide.split(fieldX(), X, 1, 0.5)!;
  assert.deepEqual(seatIds(b), ['local', 'p1', 'p2']);
  assert.equal(b.tps, 3.4);
  near(b.chain!.computeMs, 550 / 3, 1e-3);
  assert.deepEqual(b.chain!.links, [P1, P2]);
});

test('a worker of unknown speed stays last in both orders', () => {
  // p3: no measured speed and no bandwidth, but the shortest link
  const s = snap({ devices: [...SY.devices, dev({ id: 'p3', name: 'moto', ramMb: 4000 })], models: [X] });
  const f = fieldX(senses([{ id: 'p1', link: Y1 }, { id: 'p2', link: Y2 }, { id: 'p3', link: { srtt: 1, rttvar: 0 } }]), s);
  assert.equal(f.seats.find((x) => x.id === 'p3')!.speed, null);
  // as Y: p3 is never tried before p1 or p2
  const p = decide.split(f, X, 1, 1)!;
  assert.deepEqual(seatIds(p), ['local', 'p2']);
  assert.equal(p.tps, 2.7);
  // 12000 MB needs all three: the fewest that fit, speed unknown, in both orders the same set
  const big = { ...X, needMb: 12000 };
  const q = decide.split(f, big, 1, 1)!;
  assert.deepEqual(seatIds(q), ['local', 'p1', 'p2', 'p3']);
  assert.equal(q.tps, null);
  assert.equal('chain' in q, false);
  assert.deepEqual(q, decide.split(f, big));
});

test('two equal workers keep the speed order', () => {
  // p1 and p2 both tps 6, srtt 20: equal perMb, so one order; k 10: two seats 333.333 + 200 = 533.3
  // ms against three 166.667 + 400 = 566.7: the first of them in the field's order, p1
  const m = new Map<string, any[]>([['local', [{ file: X.file, tps: 2, n: 5 }]], ['p1', [{ file: X.file, tps: 6, n: 5 }]], ['p2', [{ file: X.file, tps: 6, n: 5 }]]]);
  const f = fieldX(senses([{ id: 'p1', link: P1 }, { id: 'p2', link: P1 }]), S0, m);
  const p = decide.split(f, X, 1, 10)!;
  assert.deepEqual(seatIds(p), ['local', 'p1']);
  assert.equal(p.tps, r1(1000 / (1000 / 3 + 200)));
  const q = decide.split(f, X, 1, 1)!;
  assert.deepEqual(seatIds(q), ['local', 'p1', 'p2']);
});

test('the real planner on Y: the split card names p2 and not p1', () => {
  // a fresh fit: the prior k 1. Nothing runs X whole (host cap 5600, phones 3000): "fits only split"
  const b = branch(sensesY(), { v: 1, last: X.id, speeds: SPEEDS() });
  const v: any = b.look(SY, decide.SHOW);
  const card = v.suggestions.find((c: any) => c.id === `planner:split:${X.id}`);
  assert.ok(card, JSON.stringify(v.suggestions.map((c: any) => c.id)));
  assert.match(card.title, /galaxy/);
  assert.doesNotMatch(card.title, /pixel/);
  assert.deepEqual(card.action.devices, ['p2']);
});
