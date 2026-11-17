// god's eye, the hop against the 16 Nov points (anchor network, P3): one computer splitting with one
// worker behind a delay proxy answered 46 tok/s alone and 32 / 17.7 / 12.9 / 7.7 tok/s split at
// 10 / 30 / 50 / 100 ms. HOP_PRIOR (k = 1) stays: one round trip per worker per token fits them.
//
// The srtt here is the proxy's TRUE round trip, not the probe's ms. The probe's ms is a whole
// handshake, about 4 round trips (gate.ts: tcp + tls 1.3 + hello + proof), so against senses' srtt of
// a far worker k is probably near 0.25: that is why the far split's range runs from k = 1 to 0.25.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hop = await import('../src/godseye/branches/hop.ts');

const COMPUTE_MS = 1000 / 46;
const POINTS: [rtt: number, tps: number][] = [[10, 32], [30, 17.7], [50, 12.9], [100, 7.7]];
const link = (srtt: number) => [{ srtt, rttvar: 0 }];

test('HOP_PRIOR is still 1', () => {
  assert.equal(hop.HOP_PRIOR, 1);
});

test('chainTps at HOP_PRIOR is within 10% of each 16 Nov point', () => {
  for (const [rtt, tps] of POINTS) {
    const est = hop.chainTps(COMPUTE_MS, link(rtt), hop.HOP_PRIOR);
    assert.ok(Math.abs(est - tps) / tps <= 0.1, `${rtt} ms: ${est} vs ${tps}`);
  }
});

test('four hopSteps on the points give hopK in [0.9, 1.2]', () => {
  let f = hop.freshHop();
  for (const [rtt, tps] of POINTS) f = hop.hopStep(f, COMPUTE_MS, link(rtt), tps);
  assert.equal(f.ks.length, 4);
  const k = hop.hopK(f);
  assert.ok(k >= 0.9 && k <= 1.2, String(k));
});

// ---- the real points (17 Nov, P2): T1b (D2) split this computer with one worker through an anchor in
// another home, compute about 15.5 ms per token, and the engine measured the link's round trip at
// 13.3 / 37.0 / 104.8 ms; the answers ran at 32.5 / 18.4 / 7.8 tok/s. The planner's first estimate,
// from that measured link (linkRttMs) and no answer watched, must land within 15% of each.
const decide = await import('../src/godseye/branches/decide.ts');
const T1B: [rtt: number, tps: number][] = [[13.3, 32.5], [37.0, 18.4], [104.8, 7.8]];
const T1B_COMPUTE = 15.5;
const AT = new Date(2026, 10, 16, 20, 0).getTime();
const MODEL = { id: 'q', name: 'Q', file: 'q.gguf', size: 1024 ** 3, quant: 'Q8_0', params_b: null, catalog: true, here: true, needMb: 2000 };
const SPEED = 1000 / T1B_COMPUTE;   // tok/s on q.gguf for both, so any layout computes 15.5 ms a token
const lookAt = (rtt: number, o: Record<string, unknown> = {}): any => ({
  at: AT, host: { name: 'mac', freeMb: 1000 }, models: [MODEL], projects: [],
  devices: [{
    id: 'b', name: 'B', kind: 'pc', via: 'anchor', where: 'through A', reachable: true, reachMs: 4 * rtt, reason: null, checkedAt: AT,
    lastOk: null, ramMb: 4000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null,
    linkRttMs: rtt, linkAt: AT - 60_000, ...o,
  }],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
});
const measured = () => new Map<string, any[]>([['local', [{ file: MODEL.file, tps: SPEED, n: 5 }]], ['b', [{ file: MODEL.file, tps: SPEED, n: 5 }]]]);
const probeOf = (rtt: number) => ({ senses: { hints: [{ id: 'b', link: { srtt: 4 * rtt, rttvar: rtt } }] } });
const placeAt = (rtt: number, peeks: Record<string, any>, o: Record<string, unknown> = {}) =>
  decide.split(decide.field(lookAt(rtt, o), { peek: (id: string) => peeks[id] ?? null } as any, measured()), MODEL as any, 1, 1)!;

test('the real points: the first estimate from the measured link is within 15% of T1b', () => {
  for (const [rtt, tps] of T1B) {
    for (const peeks of [{}, probeOf(rtt)]) {
      const p = placeAt(rtt, peeks);
      assert.deepEqual(p.seats.map((x: any) => x.id), ['local', 'b']);
      assert.equal(p.far!.link, true);
      const est = 1000 / (T1B_COMPUTE + decide.RTT_TRIPS * rtt);
      assert.ok(Math.abs(p.tps! - Math.round(est * 10) / 10) < 1e-9, `${rtt} ms: tps ${p.tps} vs ${est}`);
      const off = Math.abs(p.tps! - tps) / tps;
      console.log(`real point ${rtt} ms: estimate ${p.tps} tok/s (range ${p.far!.lo.toFixed(1)}\u{2013}${p.far!.hi.toFixed(1)}), measured ${tps}, off ${(off * 100).toFixed(1)}%`);
      assert.ok(off <= 0.15, `${rtt} ms: ${p.tps} vs ${tps}`);
      // the stated range holds the measured answer
      assert.ok(p.far!.lo <= tps && tps <= p.far!.hi, `${rtt} ms: ${p.far!.lo}..${p.far!.hi} vs ${tps}`);
    }
  }
});

test('the real points from the probe alone (the old pricing) miss by far more than 15%', () => {
  for (const [rtt, tps] of T1B) {
    const p = placeAt(rtt, probeOf(rtt), { linkRttMs: undefined, linkAt: undefined });
    assert.equal(p.far!.link, undefined);
    const off = Math.abs(p.tps! - tps) / tps;
    console.log(`real point ${rtt} ms, probe only: estimate ${p.tps} tok/s, measured ${tps}, off ${(off * 100).toFixed(1)}%`);
    assert.ok(off > 0.15, `${rtt} ms: ${p.tps} vs ${tps}`);
  }
});
