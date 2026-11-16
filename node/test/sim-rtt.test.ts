// The split estimate against what was measured on 16.11.2026 (docs/ANCHOR.md, stage 3): one Mac,
// Qwen3-0.6B Q8_0, one rpc worker behind a delay proxy. The five points:
//
//   rtt    0 ms  46.3 tok/s      10 ms  32.1      30 ms  17.7      50 ms  12.9      100 ms  7.7
//
// Assumptions, said out loud:
// - the model's shape is Qwen3-0.6B Q8_0 off its gguf header: 28 layers, hidden 1024, vocabulary
//   151 936, 1 byte a parameter, the file 639 446 688 bytes;
// - both ends are the same Apple M1 (master and worker ran on one Mac), memory bandwidth 68 GB/s
//   as the planner tests use for a Mac M1;
// - the M1's efficiency is learned from the 0 ms point, as learn.ts learns it from real answers
//   (that run was faster than the 0.3 measured with llama-server alone); so the 0 ms point is the
//   calibration and the four delayed points are the check;
// - the proxy's loopback is fast: 1000 MB/s, so the activations cost nothing worth counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSplit, planShares, RPC_ROUND_TRIPS, ACT_BYTES, MB, type SimDevice, type SimModel } from '../src/sim.ts';
import { planSplit, simModel, type Peer } from '../src/planner.ts';
import { netOf } from '../src/link.ts';

const q06: SimModel = { id: 'qwen3-0.6b-q8', fileMb: 639446688 / MB, layers: 28, hidden: 1024, vocab: 151936, bytesPerParam: 1, kvMbPer1k: 56 };
const M1_BW = 68;
const LOOP = 1000; // MB/s
const POINTS: [rtt: number, tps: number][] = [[0, 46.3], [10, 32.1], [30, 17.7], [50, 12.9], [100, 7.7]];

// one worker, the same Mac on both ends; the share between them does not change the compute
const rows = (eff: number) => {
  const dev: SimDevice = { id: 'm1', capMb: 4000, bw: M1_BW, eff };
  return [{ dev, mb: 1 }, { dev: { ...dev, id: 'w' }, mb: 1 }];
};

test('the split estimate replays the five measured points within 15% (RPC_ROUND_TRIPS 1.1)', () => {
  assert.equal(RPC_ROUND_TRIPS, 1.1);
  // the efficiency that gives the 0 ms point: per-token time scales as 1 / eff
  const atOne = estimateSplit(q06, rows(1), { mbps: LOOP, rttMs: 0 }).perTokenMs;
  const eff = atOne / (1000 / 46.3);
  assert.ok(eff > 0.2 && eff < 0.8, `learned efficiency ${eff}`);
  const out: string[] = [];
  for (const [rtt, tps] of POINTS) {
    const est = estimateSplit(q06, rows(eff), { mbps: LOOP, rttMs: rtt });
    const off = (est.tps - tps) / tps;
    out.push(`${rtt} ms: measured ${tps}, estimated ${est.tps} (${Math.round(off * 100)}%)`);
    assert.ok(Math.abs(off) <= 0.15, out.join('\n'));
  }
  // the old three round trips a token missed the far points by far: 100 ms gave ~3 tok/s, not 7.7
  const compute = estimateSplit(q06, rows(eff), { mbps: LOOP, rttMs: 0 }).perTokenMs;
  const oldTps = 1000 / (compute + 3 * 100);
  assert.ok(Math.abs(oldTps - 7.7) / 7.7 > 0.5, `old constant at 100 ms: ${oldTps}`);
});

test('a near and a far worker: the round trips are summed per worker over each one\'s own link', () => {
  const act = (mbps: number) => ((2 * q06.hidden * ACT_BYTES) / (mbps * 1e6)) * 1000;
  const near = { mbps: 30, rttMs: 3 };
  const far = { mbps: 5, rttMs: 60 };
  const dev = (id: string, net?: { mbps: number; rttMs: number }): SimDevice => ({ id, capMb: 4000, bw: M1_BW, eff: 0.3, ...(net ? { net } : {}) });
  const est = estimateSplit(q06, [{ dev: dev('me'), mb: 2 }, { dev: dev('near', near), mb: 1 }, { dev: dev('far', far), mb: 1 }], near);
  const want = RPC_ROUND_TRIPS * near.rttMs + act(near.mbps) + RPC_ROUND_TRIPS * far.rttMs + act(far.mbps);
  assert.ok(Math.abs(est.netMsPerToken - want) < 0.1, `${est.netMsPerToken} vs ${want}`);
  // the worst link times the workers (netOf, the old way) charged the near one the far one's delay
  const worst = netOf([{ mbps: near.mbps, rttMs: near.rttMs, at: '', error: null }, { mbps: far.mbps, rttMs: far.rttMs, at: '', error: null }]);
  const old = estimateSplit(q06, [{ dev: dev('me'), mb: 2 }, { dev: dev('near'), mb: 1 }, { dev: dev('far'), mb: 1 }], worst);
  assert.ok(old.netMsPerToken > est.netMsPerToken + 50, `old ${old.netMsPerToken} ms, now ${est.netMsPerToken} ms`);
  // one net for everyone, as before: the same number as a single shared link
  const same = estimateSplit(q06, [{ dev: dev('me'), mb: 2 }, { dev: dev('a'), mb: 1 }, { dev: dev('b'), mb: 1 }], near);
  assert.ok(Math.abs(same.netMsPerToken - 2 * (RPC_ROUND_TRIPS * near.rttMs + act(near.mbps))) < 0.1);
  // the upload goes over each worker's own link too
  assert.ok(est.loadS > same.loadS);
});

test('the planner gives each measured worker its own link; an unmeasured one gets the plan\'s net', () => {
  const m = simModel({ id: 'm7', size: 4683074240, layers: 28, hidden: 3584, vocab: 152064, quant: 'Q4_K_M', kv_mb_per_1k: 56 });
  const peer = (id: string, link: Peer['link']): Peer => ({ id, name: id, host: '10.0.0.9', port: 1, secret: '', kind: 'pc', ram: 4000, bw: 40, added_at: 't', link });
  const near = peer('near', { mbps: 30, rttMs: 3, at: 't', error: null });
  const far = peer('far', { mbps: 10, rttMs: 70, at: 't', error: null });
  const plan = planSplit({ model: m, ctx: 2048, localFreeMb: 3000, localBw: 20, peers: [near, far], share: true, all: true });
  assert.deepEqual(plan.used.map((u) => u.id).sort(), ['far', 'near']);
  const act = (mbps: number) => ((2 * m.hidden * ACT_BYTES) / (mbps * 1e6)) * 1000;
  const want = RPC_ROUND_TRIPS * 3 + act(30) + RPC_ROUND_TRIPS * 70 + act(10);
  assert.ok(Math.abs(plan.est.netMsPerToken - want) < 0.2, `${plan.est.netMsPerToken} vs ${want}`);
  // the same pair without measurements: both get the default guess (30 MB/s, 3 ms)
  const guessed = planSplit({ model: m, ctx: 2048, localFreeMb: 3000, localBw: 20, peers: [{ ...near, link: null }, { ...far, link: null }], share: true, all: true });
  assert.ok(Math.abs(guessed.est.netMsPerToken - 2 * (RPC_ROUND_TRIPS * 3 + act(30))) < 0.2);
  // planShares on its own keeps working with a single net (the phone's side calls it so)
  const p = planShares({ model: q06, ctx: 2048, local: { id: 'me', capMb: 4000, bw: 20, eff: 0.6 }, workers: [{ id: 'w', capMb: 4000, bw: 68, eff: 0.3 }], net: { mbps: 30, rttMs: 3 }, share: true });
  assert.ok(p.est.tps > 0);
});
