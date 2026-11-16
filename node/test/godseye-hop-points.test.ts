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
