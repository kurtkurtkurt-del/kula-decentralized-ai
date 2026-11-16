// Learning from a split (16.11.2026, D2 T1): a split answer teaches the planner its compute scale k
// (learn.ts splitScale), and the next plan of the same split multiplies every device's efficiency
// by it (planner.ts PlanInput.computeScale). The numbers are T1's (one Mac, Qwen3-0.6B Q8_0, one
// computer worker through an anchor): the first plan said 31.5 tok/s at 0.7 ms, the split ran at
// 66.4; then at 13.3 / 37.0 / 104.8 ms it ran at 32.5 / 18.4 / 7.8 tok/s.
//
// Assumptions, said out loud:
// - the model's shape off its gguf header: 28 layers, hidden 1024, vocabulary 151 936, 1 byte a
//   parameter, the file 639 446 688 bytes; kv 112 MB per 1 024 tokens (8 kv heads × 128, f16);
// - this computer unlearned (eff 0.6) at 39.5 GB/s, which gives T1's first estimate of 31.5; the
//   worker a computer at 42 GB/s (eff 0.3), its links as T1 measured them;
// - the network part of each estimate is the planner's (sim.ts, untouched here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MB, type SimModel } from '../src/sim.ts';
import { explainPlan, planSplit, type Peer } from '../src/planner.ts';
import { learnSplit, readSpeeds, splitScale, MIN_TOKENS, SPLIT_K_MAX, SPLIT_K_MIN, SPLIT_NET_MAX } from '../src/learn.ts';

const q06: SimModel = { id: 'qwen3-0.6b-q8', fileMb: 639446688 / MB, layers: 28, hidden: 1024, vocab: 151936, bytesPerParam: 1, kvMbPer1k: 112 };
const worker = (rttMs: number, mbps: number): Peer => ({ id: 'b', name: 'worker-b', host: '10.0.0.9', port: 1, secret: '', kind: 'pc', ram: 8000, bw: 42, added_at: 't', link: { mbps, rttMs, at: 't', error: null } });
const plan = (rttMs: number, mbps: number, computeScale?: number | null) => planSplit({ model: q06, ctx: 2048, localFreeMb: 16000, localBw: 39.5, peers: [worker(rttMs, mbps)], share: true, all: true, computeScale });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kula-learn-split-')), 'speeds.json');

test('one split answer teaches k; the far points then land within 15% of what T1 measured', () => {
  const first = plan(0.7, 217.5);
  assert.ok(Math.abs(first.est.tps - 31.5) <= 0.2, `first estimate ${first.est.tps}`);
  assert.equal(first.computeScale, undefined);
  assert.match(explainPlan(first, 'qwen3').join('\n'), /not measured yet/);

  // the answer: 66.4 tok/s, its network part about 0.8 ms of the 15 ms token
  const k = splitScale(first.est, 1, 66.4);
  assert.ok(k !== null && k > 1.5 && k < 3, `k ${k}`);
  const file = tmpFile();
  const seen = learnSplit('qwen3|b', 66.4, file, new Date(), k);
  assert.equal(seen?.k, Math.round(k! * 1000) / 1000);
  const kStored = readSpeeds(file).splits['qwen3|b'].k!;

  // the same split at 0.7 ms with k gives back what was measured
  const again = plan(0.7, 217.5, kStored);
  assert.ok(Math.abs(again.est.tps - 66.4) / 66.4 <= 0.02, `0.7 ms with k: ${again.est.tps}`);
  assert.equal(again.computeScale, kStored);
  const words = explainPlan(again, 'qwen3').join('\n');
  assert.match(words, /learned from this split/);
  assert.doesNotMatch(words, /not measured yet/);

  const out: string[] = [];
  for (const [rtt, mbps, measured] of [[13.3, 19.7, 32.5], [37.0, 13.6, 18.4], [104.8, 6.9, 7.8]]) {
    const unlearned = plan(rtt, mbps);
    const p = plan(rtt, mbps, kStored);
    // the same factor on every device: the layout does not move
    assert.equal(p.localLayers, unlearned.localLayers, `${rtt} ms layers`);
    assert.deepEqual(p.used.map((u) => [u.id, u.layers, u.assignedMb]), unlearned.used.map((u) => [u.id, u.layers, u.assignedMb]));
    assert.equal(p.est.netMsPerToken, unlearned.est.netMsPerToken);
    const off = (p.est.tps - measured) / measured;
    out.push(`${rtt} ms: measured ${measured}, estimated ${p.est.tps} (${Math.round(off * 100)}%), unlearned ${unlearned.est.tps}`);
    assert.ok(Math.abs(off) <= 0.15, out.join('\n'));
  }
});

test('k is clamped to 0.4–4, in splitScale and in what is stored', () => {
  const est = { perTokenMs: 30, netMsPerToken: 1 };
  assert.equal(SPLIT_K_MIN, 0.4);
  assert.equal(SPLIT_K_MAX, 4);
  assert.equal(splitScale(est, 1, 400), 4);        // 2.5 ms a token: far faster than any guess
  assert.equal(splitScale(est, 1, 2), 0.4);        // 500 ms a token: far slower
  assert.equal(splitScale(est, 3, 66.4), 4);       // k used multiplies in before the clamp
  const file = tmpFile();
  assert.equal(learnSplit('m|x', 50, file, new Date(), 9)?.k, 4);
  assert.equal(learnSplit('m|y', 50, file, new Date(), 0.01)?.k, 0.4);
  // nonsense teaches nothing
  assert.equal(splitScale(est, 1, 0), null);
  assert.equal(splitScale(est, 1, NaN), null);
  assert.equal(splitScale(est, 0, 50), null);
  // a stored k is used as given; a nonsense one is not used at all
  assert.equal(plan(0.7, 217.5, 0).computeScale, undefined);
  assert.equal(plan(0.7, 217.5, -1).est.tps, plan(0.7, 217.5).est.tps);
});

test('the 80% network rule: a token that is mostly network teaches no k, and the old k stays', () => {
  assert.equal(SPLIT_NET_MAX, 0.8);
  assert.equal(MIN_TOKENS, 16); // the engine learns only from answers of at least this many tokens
  const est = { perTokenMs: 70, netMsPerToken: 40 };
  // measured 45 ms a token: the 40 ms network is 89% of it
  assert.equal(splitScale(est, 1, 1000 / 45), null);
  // measured 50 ms: exactly 80% is still learned (compute 10 ms against 30 estimated: k 3)
  assert.ok(Math.abs(splitScale(est, 1, 1000 / 50)! - 3) < 1e-9);
  // measured 60 ms: 67%, compute 20 ms against 30: k 1.5
  assert.ok(Math.abs(splitScale(est, 1, 1000 / 60)! - 1.5) < 1e-9);

  const file = tmpFile();
  assert.equal(learnSplit('m|z', 20, file, new Date(), 1.5)?.k, 1.5);
  // a far answer: the tok/s is kept, k is not touched
  const far = learnSplit('m|z', 1000 / 45, file, new Date(), splitScale(est, 1.5, 1000 / 45));
  assert.equal(far?.k, 1.5);
  assert.equal(far?.n, 2);
  // a near one blends in as the tok/s does (0.7 of the old)
  const near = learnSplit('m|z', 20, file, new Date(), 2.5);
  assert.equal(near?.k, 1.8);
  // an old speeds.json without k: nothing learned, nothing used
  const old = tmpFile();
  fs.writeFileSync(old, JSON.stringify({ devices: {}, splits: { 'm|w': { tps: 40, n: 3, at: 't' } } }));
  assert.equal(readSpeeds(old).splits['m|w'].k, undefined);
  assert.equal(learnSplit('m|w', 40, old, new Date(), null)?.k, undefined);
});
