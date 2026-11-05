import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSplit, planWithProbe, tensorSplit, TooBig, simModel, type Peer } from '../src/planner.ts';
import { planShares, MB } from '../src/sim.ts';

let n = 1;
const peer = (id: string, ram: number, bw: number, kind: Peer['kind'] = 'phone'): Peer => ({ id, name: id, host: '10.0.0.' + n++, port: 50551, secret: 'aa'.repeat(8), kind, ram, bw, added_at: 't' });
const q06 = simModel({ id: 'qwen3-0.6b-q8', size: 639446688, layers: 28, hidden: 1024, vocab: 151936, quant: 'Q8_0', kv_mb_per_1k: 56 });
const q7 = simModel({ id: 'qwen2.5-7b-q4', size: 4683074240, layers: 28, hidden: 3584, vocab: 152064, quant: 'Q4_K_M', kv_mb_per_1k: 56 });

test('the core is the very file the phone runs', () => {
  const here = readFileSync(new URL('../src/sim.ts', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../../app/src/llm/sim/model.ts', import.meta.url), 'utf8');
  assert.equal(here, phone, 'node/src/sim.ts must be a copy of app/src/llm/sim/model.ts (cp it)');
});

test('the shared vectors give the same plans here (tools/planner-vectors.json)', () => {
  const { vectors } = JSON.parse(readFileSync(new URL('../../tools/planner-vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.length >= 6);
  for (const v of vectors) {
    const { fileBytes, ...rest } = v.input.model;
    const model = { ...rest, fileMb: fileBytes / MB };
    if (v.error) assert.throws(() => planShares({ ...v.input, model }), new RegExp(v.error), v.name);
    else {
      const p = planShares({ ...v.input, model });
      assert.deepEqual({ localMb: p.localMb, used: p.used, needMb: p.needMb, aloneFaster: p.aloneFaster, est: p.est }, v.expect, v.name);
    }
  }
});

test('fits alone and no share: everything stays local, no worker used', () => {
  const plan = planSplit({ model: q06, ctx: 2048, localFreeMb: 4000, localBw: 50, peers: [peer('a', 6000, 20)], share: false });
  assert.equal(plan.fitsAlone, true);
  assert.equal(plan.localMb, plan.needMb);
  assert.deepEqual(plan.used, []);
  assert.deepEqual(tensorSplit(plan), [plan.needMb]);
});

test('does not fit alone: the fastest worker first, the slow one stays out, the output layer local', () => {
  const fast = peer('fast', 8000, 40);
  const slow = peer('slow', 8000, 5);
  const plan = planSplit({ model: q7, ctx: 2048, localFreeMb: 4000, localBw: 20, peers: [slow, fast], share: false });
  assert.equal(plan.fitsAlone, false);
  assert.equal(plan.used.length, 1);
  assert.equal(plan.used[0].id, 'fast');
  assert.ok(plan.localMb >= 300 + 260, 'the runtime and the output layer need memory here');
  assert.ok(plan.used[0].layers > 20);
  assert.deepEqual(tensorSplit(plan), [plan.localMb, plan.used[0].assignedMb]);
  assert.ok(plan.est.tps > 0 && plan.est.loadS > 0);
});

test('a mac as the master and a phone as the worker: the phone gets nothing it should not', () => {
  const plan = planSplit({ model: q06, ctx: 2048, localFreeMb: 4000, localBw: 68, localEff: 0.3, peers: [peer('s25', 6500, 65.9)], share: true });
  assert.equal(plan.fitsAlone, true);
  assert.equal(plan.aloneFaster, true); // one hop over wi-fi costs more than a 0.6b saves
});

test('too big even together throws TooBig with the numbers', () => {
  assert.throws(() => planSplit({ model: q7, ctx: 2048, localFreeMb: 1400, localBw: 8, peers: [peer('a', 1400, 8)], share: true }), (e: unknown) => e instanceof TooBig && e.needMb > 5000 && e.totalMb === 2030);
});

test('planWithProbe drops the peers that did not answer in time and says why', async () => {
  const live = peer('live', 8000, 30);
  const dead = peer('dead', 8000, 30);
  const asked: string[] = [];
  const plan = await planWithProbe({
    model: q7, ctx: 2048, localFreeMb: 4000, localBw: 20, wanted: [live, dead], share: true,
    probe: async (host) => { asked.push(host); return host === live.host ? { ok: true, ms: 3 } : { ok: false, reason: 'timeout' }; },
  });
  assert.equal(asked.length, 2);
  assert.deepEqual(plan.used.map((u) => u.id), ['live']);
  assert.deepEqual(plan.skipped.map((s) => [s.peer.id, s.why]), [['dead', 'timeout']]);
});
