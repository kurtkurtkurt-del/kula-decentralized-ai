// god's eye, the planner's answer mark across a reload (L11 P59b): a device's speed on the loaded file is
// folded in when its answer count grew. The mark keeps the load's `since` beside the count, so a reload
// (a new since, the count from 0 again) folds its first answer; a since that moves every look with the
// same count folds nothing; and only the loaded file's marks are kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-planner-reload-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const planner = await import('../src/godseye/branches/planner.ts');

// ---- copied from godseye-hop-wire.test.ts:19-71
const GB = 1024 * 1024 * 1024;
const model = (id: string, name: string, needMb: number, size: number, o: Record<string, unknown> = {}) => ({
  id, name, file: `${id}.gguf`, size, quant: 'Q4_K_M', params_b: null, catalog: true, here: false, needMb, ...o,
});
const AT = new Date(2026, 10, 11, 15, 0).getTime();
const snap = (o: Record<string, any> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 8000 },
  devices: [],
  models: [],
  projects: [],
  ...o,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...(o.work ?? {}) },
});
const loaded = (m: any, mode: string, devices: any[], o: Record<string, unknown> = {}) => ({ mode, model: { id: m.id, name: m.name, file: m.file, size: m.size }, ctx: 4096, since: AT - 60_000, devices, ...o });
const here = (tps: number | null, done = 3, busy = false) => ({ id: 'local', name: 'this computer', local: true, busy, tps, done });

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

const A = model('a', 'A', 2000, 2 * GB);
const B = model('b', 'B', 2000, 2 * GB);
const S1 = AT - 600_000;
const S2 = AT - 60_000;
/** one look with m loaded here since `since`, this computer at tps with `done` answers */
const hereOn = (m: any, since: number, tps: number | null, done: number) =>
  snap({ models: [A, B], work: { loaded: loaded(m, 'here', [here(tps, done)], { since }) } });
const sp = (b: ReturnType<typeof branch>, m: any = A) => b.notes()?.speeds?.local?.[m.file];
const n = (b: ReturnType<typeof branch>, m: any = A) => sp(b, m)?.n ?? 0;
const fold = (was: number, x: number) => Math.round((was + 0.3 * (x - was)) * 100) / 100;

test('R1: a reload folds its first answer', () => {
  const b = branch();
  b.look(hereOn(A, S1, 4, 12));
  assert.equal(n(b), 1);
  b.look(hereOn(A, S1, 5, 13));
  assert.equal(n(b), 2);
  b.look(hereOn(A, S2, null, 0));
  assert.equal(n(b), 2, 'reloaded, no answer yet');
  b.look(hereOn(A, S2, 6, 1));
  assert.equal(n(b), 3, 'the first answer after the reload');
  assert.equal(sp(b).tps, fold(fold(4, 5), 6));
  b.look(hereOn(A, S2, 6, 1));
  assert.equal(n(b), 3, 'the same look again');
});

test('R2: the same since and count over 3 looks: no fold after the first', () => {
  const b = branch();
  b.look(hereOn(A, S1, 4, 7));
  assert.equal(n(b), 1);
  b.look(hereOn(A, S1, 4, 7), 3);
  assert.equal(n(b), 1);
});

test('R3: a since that moves every look, the count and tps the same: no fold', () => {
  const b = branch();
  b.look(hereOn(A, S1, 4, 7));
  assert.equal(n(b), 1);
  for (let i = 1; i <= 5; i++) b.look(hereOn(A, S1 + i * 1000, 4, 7));
  assert.equal(n(b), 1);
  assert.equal(sp(b).tps, 4);
});

test('R4: the device leaves for one look and returns with the same count: no fold', () => {
  const b = branch();
  b.look(hereOn(A, S1, 4, 7));
  b.look(snap({ models: [A, B], work: { loaded: loaded(A, 'here', [], { since: S1 }) } }));
  b.look(hereOn(A, S1, 4, 7));
  assert.equal(n(b), 1);
});

test('R5: file A, one look of file B, then A reloaded at the same count: A folds', () => {
  const b = branch();
  b.look(hereOn(A, S1, 4, 5));
  assert.equal(n(b), 1);
  b.look(hereOn(B, S1 + 1000, 3, 2));
  assert.equal(n(b, B), 1);
  b.look(hereOn(A, S2, 5, 5));
  assert.equal(n(b), 2, 'A folds: its mark went with the look of B');
  assert.equal(sp(b).tps, fold(4, 5));
});

test('R6: a reload that reaches the very same count before the next look: not folded, the next answer is', () => {
  // the price of R3: a new since at the same count looks like a since that moved and is not folded
  const b = branch();
  b.look(hereOn(A, S1, 4, 5));
  b.look(hereOn(A, S2, 5, 5));
  assert.equal(n(b), 1);
  b.look(hereOn(A, S2, 5, 6));
  assert.equal(n(b), 2);
});

test('R7: a split load: the speeds gain nothing', () => {
  const b = branch();
  const s = (done: number) => snap({ models: [A, B], work: { loaded: loaded(A, 'split', [here(4, done)], { since: S1 }) } });
  b.look(s(3));
  b.look(s(4));
  b.look(s(5));
  assert.equal(n(b), 0);
});
