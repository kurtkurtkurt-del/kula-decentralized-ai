import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llamaSplit, llamaLayers } from '../src/split.ts';

const plan = (local: number, workers: number[]) => ({ localLayers: local, used: workers.map((layers, i) => ({ id: `w${i}`, layers })) as any });

test('the old order gave the bigger part to the worker (why this was fixed)', () => {
  // 15.11.2026: kula passed [this computer's MB, the worker's MB]; llama.cpp puts rpc devices first
  const old = llamaLayers([875, 289], 28, 99);
  assert.ok(old.devices[0] > 17, `the worker got ${old.devices[0]} of 29 slots, the plan said 11`);
});

test('with a local gpu: workers first, this computer last with the output layer, exactly the plan', () => {
  const ls = llamaSplit(plan(17, [11]), 28, true);
  assert.deepEqual(ls, { tensorSplit: [11, 18], ngl: 29, outputOn: 'local' });
  assert.deepEqual(llamaLayers(ls.tensorSplit, 28, ls.ngl), { cpu: 0, devices: [11, 18] });
});

test('without a local gpu: the first layers stay on the processor through -ngl, the output on the last worker', () => {
  const ls = llamaSplit(plan(10, [8, 10]), 28, false);
  assert.deepEqual(ls, { tensorSplit: [8, 11], ngl: 19, outputOn: 'w1' });
  assert.deepEqual(llamaLayers(ls.tensorSplit, 28, ls.ngl), { cpu: 10, devices: [8, 11] });
  const none = llamaSplit(plan(0, [28]), 28, false);
  assert.deepEqual(llamaLayers(none.tensorSplit, 28, none.ngl), { cpu: 0, devices: [29] });
});

test('llama.cpp hands out exactly the planned layers, for many shapes, both ways', () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let t = 0; t < 2000; t++) {
    const n = 4 + rnd(120);
    const k = 1 + rnd(4);
    const cuts = Array.from({ length: k }, () => rnd(n + 1)).sort((a, b) => a - b);
    const workers = cuts.map((c, i) => c - (i ? cuts[i - 1] : 0));
    const local = n - workers.reduce((a, b) => a + b, 0);
    for (const gpu of [true, false]) {
      const ls = llamaSplit(plan(local, workers), n, gpu);
      const got = llamaLayers(ls.tensorSplit, n, ls.ngl);
      if (gpu) assert.deepEqual(got, { cpu: 0, devices: [...workers, local + 1] }, `n ${n} workers ${workers} local ${local} gpu`);
      else {
        const want = [...workers]; want[want.length - 1] += 1;
        assert.deepEqual(got, { cpu: local, devices: want }, `n ${n} workers ${workers} local ${local} cpu`);
      }
    }
  }
});
