import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learnDevice, learnSplit, readSpeeds, splitKey } from '../src/learn.ts';
import { planSplit, simModel, explainPlan, type Peer } from '../src/planner.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kula-learn-')), 'speeds.json');

test('a device is learned as a running average; nonsense is not learned', () => {
  const f = tmp();
  assert.deepEqual(readSpeeds(f), { devices: {}, splits: {} });
  assert.equal(learnDevice('pc', 0.4, f)!.eff, 0.4);
  assert.equal(learnDevice('pc', 0.6, f)!.eff, 0.46, 'keeps 70% of the old');
  assert.equal(readSpeeds(f).devices.pc.n, 2);
  assert.equal(learnDevice('pc', 0, f), null);
  assert.equal(learnDevice('pc', Number.NaN, f), null);
  assert.equal(learnDevice('pc', 3, f), null, 'above 1.5 of its memory speed is a wrong reading');
  assert.equal(readSpeeds(f).devices.pc.eff, 0.46);
});

test('a split is kept per model and set of devices, in any order', () => {
  const f = tmp();
  assert.equal(splitKey('m', ['b', 'a']), splitKey('m', ['a', 'b']));
  learnSplit(splitKey('m', ['a', 'b']), 12, f);
  learnSplit(splitKey('m', ['b', 'a']), 8, f);
  assert.equal(readSpeeds(f).splits[splitKey('m', ['a', 'b'])].tps, 10.8);
});

test('the planner uses a learned speed, and the plan says where the numbers came from', () => {
  const q14 = simModel({ id: 'q14', size: 8_990_000_000, layers: 48, hidden: 5120, vocab: 152064, quant: 'Q4_K_M', kv_mb_per_1k: 192 });
  const card: Peer = { id: 'card', name: 'card', host: 'a', port: 1, secret: '', kind: 'pc', ram: 30000, bw: 40, gpu: 'NVIDIA GeForce RTX 4070', vram: 12282, added_at: 't' };
  const base = { model: q14, ctx: 2048, localFreeMb: 6000, localBw: 60, peers: [card], net: { mbps: 60, rttMs: 3 }, share: true };
  const guessed = planSplit(base);
  const slow = planSplit({ ...base, peerEff: { card: 0.05 }, seenTps: 6.2 });
  assert.ok(slow.est.tps < guessed.est.tps, 'a card that answered slowly lowers the estimate');
  const g = explainPlan(guessed, 'Qwen2.5 14B').join('\n');
  const s = explainPlan(slow, 'Qwen2.5 14B').join('\n');
  assert.match(g, /guessed from the name/);
  assert.match(s, /its speed learned from its answers/);
  assert.match(s, /last time this split ran at 6.2 tok\/s/);
  assert.match(s, /what the devices showed in earlier answers/);
});
