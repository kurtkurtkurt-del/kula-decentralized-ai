// The cluster simulator against what was measured on real devices (5.11.2026), the split
// planner's rules, and the apart-mode dispatcher. Pure functions: no native module here.
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CATALOG } from '@/llm/catalog';
import { needMb as fitNeed } from '@/llm/fit';
import {
  asLocal, asWorker, DEVICES, embedMb, estimateAlone, estimateSplit, expectedFinish, GAIN_TO_SHARE, kindOf, MB, modelById, modelProfile,
  needMb, NETWORKS, pickDevice, planShares, simulateApart, waterfill, type SimDevice,
} from '@/llm/sim';

const q06 = modelById('qwen3-0.6b-q8')!;
const q7 = modelById('qwen2.5-7b-q4')!;
const within = (x: number, target: number, pct: number) => expect(Math.abs(x - target) / target).toBeLessThanOrEqual(pct / 100);

describe('calibration: the simulator reproduces what was measured', () => {
  it('mac m1 8 gb runs qwen3 0.6b q8 at 34 tok/s (llama-server, measured)', () => {
    within(estimateAlone(q06, asLocal(DEVICES.macm1)).tps, 34, 8);
  });
  it('415 mb through the emulator nat tunnel takes ~335 s (measured upload, 27 of 29 layers on the mac)', () => {
    const rows = [{ dev: asLocal(DEVICES.emulator), mb: 1 }, { dev: asWorker(DEVICES.macm1), mb: 27 }];
    const blocks = q06.fileMb - embedMb(q06); // the embedding stayed on the emulator
    const est = estimateSplit(q06, rows.map((r) => ({ ...r, mb: (blocks * r.mb) / 28 })), NETWORKS.emuNat);
    within((blocks * 27) / 28, 415, 10); // the mac's share of the file, as llama.cpp reported it
    within(est.loadS, 335, 8);
  });
  it('the s25+ passport (65.9 GB/s, budget 1.82 gb) holds gemma 3 1b, as it did', () => {
    const g = modelById('gemma3-1b-q4')!;
    expect(needMb(g, 2048)).toBeLessThan(DEVICES.s25plus.budgetMb);
    expect(estimateAlone(g, asLocal(DEVICES.s25plus)).tps).toBeGreaterThan(30);
  });
  it('the emulator (2.4 gb, budget 0.54 gb) cannot hold even the smallest model alone', () => {
    expect(needMb(q06, 2048)).toBeGreaterThan(DEVICES.emulator.budgetMb);
  });
  it('agrees with fit.ts on what a model needs', () => {
    for (const m of CATALOG) for (const ctx of [512, 2048, 8192]) expect(Math.round(needMb(modelProfile(m), ctx))).toBe(fitNeed({ size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx }));
  });
  it('knows every catalog model’s shape, and the embedding of a 150k vocabulary is real memory', () => {
    for (const m of CATALOG) {
      const p = modelProfile(m);
      expect(p.layers).toBeGreaterThan(10);
      expect(p.hidden % 128).toBe(0);
      expect(embedMb(p)).toBeGreaterThan(50);
      expect(embedMb(p)).toBeLessThan(p.fileMb / 3);
    }
    // an unknown hugging face model gets a plausible guess
    const g = modelProfile({ id: 'hf:x/y', size: 3e9, quant: 'Q4_K_M', kv_mb_per_1k: 100 });
    expect(g.layers).toBe(28);
    expect(g.hidden).toBeGreaterThan(1024);
  });
});

describe('water filling', () => {
  it('splits by want, caps the full ones and pours the rest on the others', () => {
    expect(waterfill([{ want: 3, cap: 100 }, { want: 1, cap: 100 }], 40)).toEqual([30, 10]);
    const r = waterfill([{ want: 3, cap: 20 }, { want: 1, cap: 100 }], 40)!;
    expect(r[0]).toBeCloseTo(20);
    expect(r[1]).toBeCloseTo(20);
    expect(waterfill([{ want: 1, cap: 10 }], 11)).toBeNull();
    const m = waterfill([{ want: 1, cap: 10, min: 5 }, { want: 100, cap: 100 }], 50)!;
    expect(m[0]).toBeGreaterThanOrEqual(5);
    expect(m[0]).toBeLessThan(6);
  });
});

describe('the split planner', () => {
  const s25 = asLocal(DEVICES.s25plus);
  const phones = [DEVICES.pixel8, DEVICES.mid6, DEVICES.old4].map(asWorker);
  it('fits alone and no share: everything stays here, the estimate is the alone one', () => {
    const p = planShares({ model: q06, ctx: 2048, local: s25, workers: phones, net: NETWORKS.wifi5, share: false });
    expect(p.used).toEqual([]);
    expect(p.fitsAlone).toBe(true);
    expect(p.localMb).toBe(p.needMb);
    expect(p.est).toEqual(p.estAlone);
  });
  it('a small model shared on wi-fi: the split is slower than alone and says so', () => {
    const p = planShares({ model: q06, ctx: 2048, local: s25, workers: phones, net: NETWORKS.wifi5, share: true });
    expect(p.used.length).toBeGreaterThan(0);
    expect(p.aloneFaster).toBe(true);
    expect(p.est.perTokenMs).toBeGreaterThan(p.estAlone!.perTokenMs);
  });
  it('a 7b on a flagship with three phones: fills by speed, keeps the output layer here, and ctx grows the need', () => {
    const p = planShares({ model: q7, ctx: 2048, local: s25, workers: phones, net: NETWORKS.wifi5, share: true });
    expect(p.fitsAlone).toBe(false);
    expect(p.localMb).toBeGreaterThanOrEqual(Math.floor(embedMb(q7) + 300));
    expect(p.localMb + p.used.reduce((a, u) => a + u.assignedMb, 0)).toBeCloseTo(p.needMb, -1);
    expect(p.used[0].id).toBe('pixel8');
    const big = planShares({ model: q7, ctx: 8192, local: s25, workers: phones, net: NETWORKS.wifi5, share: true });
    expect(big.needMb - p.needMb).toBe(Math.round((q7.kvMbPer1k * (8192 - 2048)) / 1024));
  });
  it('a slow network uses fewer devices than a fast one', () => {
    // a master that holds little, four faster workers of 900 mb each: on a fast network
    // every byte moved to them is time saved; on 2.4 ghz each hop costs more than it saves
    const local: SimDevice = { id: 'me', capMb: 2500, bw: 20, eff: 0.6 };
    const ws: SimDevice[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, capMb: 900, bw: 30, eff: 0.6 }));
    const fast = planShares({ model: modelById('llama3.2-3b-q4')!, ctx: 2048, local, workers: ws, net: { mbps: 100, rttMs: 0.5 }, share: true });
    const slow = planShares({ model: modelById('llama3.2-3b-q4')!, ctx: 2048, local, workers: ws, net: NETWORKS.wifi24, share: true });
    expect(fast.used.length).toBeGreaterThan(slow.used.length);
    expect(slow.est.netMsPerToken).toBeGreaterThan(fast.est.netMsPerToken);
  });
  it('the alone-is-faster line sits at the margin', () => {
    // a computer faster than the phone on a perfect network: the bytes it takes are time saved
    const local: SimDevice = { id: 'me', capMb: 4000, bw: 20, eff: 0.6 };
    const twin: SimDevice = { id: 'w', capMb: 4000, bw: 68, eff: 0.3 };
    const p = planShares({ model: modelById('qwen2.5-1.5b-q4')!, ctx: 2048, local, workers: [twin], net: { mbps: 1000, rttMs: 0.1 }, share: true });
    expect(p.aloneFaster).toBe(false);
    expect(p.est.perTokenMs * GAIN_TO_SHARE).toBeLessThanOrEqual(p.estAlone!.perTokenMs);
    // the same twin over 2.4 ghz wi-fi: the hops eat the gain
    const w = planShares({ model: modelById('qwen2.5-1.5b-q4')!, ctx: 2048, local, workers: [twin], net: NETWORKS.wifi24, share: true });
    expect(w.aloneFaster).toBe(true);
  });
  it('refuses what cannot fit: too big together, or a master too small for the output layer', () => {
    expect(() => planShares({ model: q7, ctx: 2048, local: asLocal(DEVICES.old4), workers: [asWorker(DEVICES.old4)], net: NETWORKS.wifi5, share: true })).toThrow('toobig');
    expect(() => planShares({ model: q7, ctx: 2048, local: { id: 'me', capMb: 200, bw: 10, eff: 0.6 }, workers: [asWorker(DEVICES.rtx4090)], net: NETWORKS.wifi5, share: true })).toThrow('local');
  });
  it('emulator + mac over the nat tunnel: most layers on the mac, output here, a long upload', () => {
    const p = planShares({ model: q06, ctx: 2048, local: asLocal(DEVICES.emulator), workers: [asWorker(DEVICES.macm1)], net: NETWORKS.emuNat, share: true });
    expect(p.used[0].id).toBe('macm1');
    expect(p.used[0].layers).toBeGreaterThan(q06.layers / 2);
    expect(p.est.loadS).toBeGreaterThan(200);
    expect(p.est.tps).toBeLessThan(estimateAlone(q06, asLocal(DEVICES.macm1)).tps);
  });
  it('matches the shared vectors (tools/planner-vectors.json), the same file the computer side checks', () => {
    const { vectors } = JSON.parse(readFileSync(join(__dirname, '../../../tools/planner-vectors.json'), 'utf8'));
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of vectors) {
      const model = { ...v.input.model, fileMb: v.input.model.fileBytes / MB };
      delete model.fileBytes;
      if (v.error) expect(() => planShares({ ...v.input, model })).toThrow(v.error);
      else {
        const p = planShares({ ...v.input, model });
        expect({ localMb: p.localMb, used: p.used, needMb: p.needMb, aloneFaster: p.aloneFaster, est: p.est }).toEqual(v.expect);
      }
    }
  });
});

describe('the apart dispatcher', () => {
  const fast = { id: 'pc', tps: 40, busyUntil: 0 };
  const slow = { id: 'phone', tps: 8, busyUntil: 0 };
  it('a short request goes to the free slow device when the fast one is busy long enough', () => {
    const r = { promptTokens: 40, maxTokens: 40 };
    expect(kindOf(r)).toBe('short');
    expect(pickDevice([fast, slow], r, 0)!.id).toBe('pc');
    expect(pickDevice([{ ...fast, busyUntil: 20000 }, slow], r, 0)!.id).toBe('phone');
  });
  it('a long request waits for the fast device', () => {
    const r = { promptTokens: 1500, maxTokens: 600 };
    expect(kindOf(r)).toBe('long');
    expect(pickDevice([{ ...fast, busyUntil: 20000 }, slow], r, 0)!.id).toBe('pc');
    expect(expectedFinish({ ...fast, busyUntil: 20000 }, r, 0)).toBeLessThan(expectedFinish(slow, r, 0));
  });
  it('a batch of eight spreads by speed, the makespan beats fastest-free, and a dropped device’s queue is redone elsewhere', () => {
    const reqs = Array.from({ length: 8 }, (_, i) => ({ promptTokens: 100, maxTokens: i % 2 ? 300 : 60 }));
    const r = simulateApart([fast, slow], reqs);
    expect(r.perDevice.pc).toBeGreaterThan(r.perDevice.phone);
    expect(r.perDevice.phone).toBeGreaterThan(0);
    // the old rule, fastest free device first, one in flight each: a greedy round-robin
    let tPc = 0, tPh = 0;
    for (const q of reqs) {
      const cPc = (q.promptTokens / 320 + q.maxTokens / 40) * 1000, cPh = (q.promptTokens / 64 + q.maxTokens / 8) * 1000;
      if (tPc <= tPh) tPc += cPc; else tPh += cPh;
    }
    expect(r.makespanMs).toBeLessThanOrEqual(Math.max(tPc, tPh));
    const dropped = simulateApart([fast, slow], reqs, { dropAt: [{ id: 'pc', atMs: 1000 }] });
    expect(dropped.reassigned).toBeGreaterThan(0);
    expect(dropped.perDevice.phone).toBe(8 - dropped.perDevice.pc);
    expect(() => simulateApart([{ ...fast, out: true }], reqs)).toThrow('nodevice');
  });
});
