import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplit, planWithProbe, tensorSplit, TooBig, LOCAL_SHARE, WORKER_SHARE, NEED_FACTOR, MB } from '../src/planner.ts';
import type { Peer } from '../src/peers.ts';

let n = 1;
const peer = (id: string, ram: number, bw: number): Peer => ({ id, name: id, host: '10.0.0.' + n++, port: 50551, secret: 'aa'.repeat(8), kind: 'phone', ram, bw, added_at: 't' });

test('fits alone and no share: everything stays local, no worker used', () => {
  const plan = planSplit({ modelBytes: 1000 * MB, localFreeMb: 4000, localBw: 50, peers: [peer('a', 6000, 20)], share: false });
  assert.equal(plan.needMb, Math.round(1000 * NEED_FACTOR));
  assert.equal(plan.fitsAlone, true);
  assert.equal(plan.localMb, plan.needMb);
  assert.deepEqual(plan.used, []);
  assert.equal(plan.totalMb, Math.round(4000 * LOCAL_SHARE + 6000 * WORKER_SHARE));
});

test('fits alone and share: split by bandwidth, capped by capacity, overflow to the fastest', () => {
  // local 50 GB/s, worker 10 GB/s: 5:1 by speed
  const plan = planSplit({ modelBytes: 1200 * MB, localFreeMb: 4000, localBw: 50, peers: [peer('a', 6000, 10)], share: true });
  assert.equal(plan.fitsAlone, true);
  assert.equal(plan.localMb + plan.used[0].assignedMb, plan.needMb);
  assert.equal(plan.localMb, Math.round((plan.needMb * 50) / 60));
  // a slow local with a tiny capacity: the cap holds and the rest goes to the worker
  const capped = planSplit({ modelBytes: 1000 * MB, localFreeMb: 1000, localBw: 50, peers: [peer('a', 6000, 10)], share: true });
  assert.equal(capped.localMb, Math.round(1000 * LOCAL_SHARE));
  assert.equal(capped.used[0].assignedMb, capped.needMb - capped.localMb);
});

test('does not fit alone: fill the fastest first, devices not needed stay out, output layer local', () => {
  const fast = peer('fast', 8000, 40);
  const slow = peer('slow', 8000, 5);
  const plan = planSplit({ modelBytes: 7000 * MB, localFreeMb: 4000, localBw: 20, peers: [slow, fast], share: false });
  assert.equal(plan.fitsAlone, false);
  // fast worker (40) takes its whole capacity, local (20) the rest; slow never asked
  assert.equal(plan.used.length, 1);
  assert.equal(plan.used[0].id, 'fast');
  assert.equal(plan.used[0].assignedMb, Math.round(8000 * WORKER_SHARE));
  assert.equal(plan.localMb, plan.needMb - plan.used[0].assignedMb);
  assert.ok(plan.localMb > 0, 'the output layer needs memory here');
  assert.deepEqual(tensorSplit(plan), [plan.localMb, plan.used[0].assignedMb]);
});

test('unknown ram and bandwidth get the defaults from the phone planner (2000 MB, 4 GB/s)', () => {
  const p = { ...peer('x', 0, 0), ram: null, bw: null };
  const plan = planSplit({ modelBytes: 2000 * MB, localFreeMb: 2000, localBw: 0, peers: [p], share: false });
  assert.equal(plan.totalMb, Math.round(2000 * LOCAL_SHARE + 2000 * WORKER_SHARE));
});

test('too big even together throws TooBig with the numbers', () => {
  assert.throws(() => planSplit({ modelBytes: 20000 * MB, localFreeMb: 4000, localBw: 20, peers: [peer('a', 4000, 10)], share: true }), (e: unknown) => e instanceof TooBig && e.needMb === 22000 && e.totalMb === 5800);
});

test('planWithProbe drops the peers that did not answer in time and says why', async () => {
  const live = peer('live', 8000, 30);
  const dead = peer('dead', 8000, 30);
  const wrong = peer('wrong', 8000, 30);
  const asked: string[] = [];
  const plan = await planWithProbe({
    modelBytes: 7000 * MB, localFreeMb: 4000, localBw: 20, wanted: [live, dead, wrong], share: true, timeoutMs: 2000,
    probe: async (host, port, secret, channel, ms) => {
      asked.push(`${channel}:${ms}`);
      if (host === live.host && port === 50551) return { ok: true, ms: 3 };
      if (host === wrong.host) return { ok: false, reason: 'wrong secret' };
      return { ok: false, reason: 'connect timeout' };
    },
  });
  assert.ok(asked.every((a) => a === 'rpc:2000'));
  assert.deepEqual(plan.used.map((u) => u.id), ['live']);
  assert.deepEqual(plan.skipped.map((s) => `${s.peer.id}:${s.why}`).sort(), ['dead:connect timeout', 'wrong:wrong secret']);
});
