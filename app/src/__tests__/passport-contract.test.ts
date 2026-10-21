// kula's side of the passport-core contract. The files come from device-passport itself
// (../device-passport/passport-core/contract) when it sits beside this repo, and from the
// snapshot (modules/passport-measure/vendor/contract) always; both are tested, so a change
// in device-passport that kula does not follow fails here before it reaches a phone.
// The Kotlin side tests the same files: PassportCoreContractTest in passport-core.
import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { combine, estimateModel, fitLabelOf, normalizePassport, rangeOf, rangeText, SUPPORTED_API, SUPPORTED_MAJOR, unknownKeys } from '@/passport/contract';

const app = join(__dirname, '../..');
const sources = [
  ['device-passport', join(app, '../../device-passport/passport-core/contract')],
  ['snapshot', join(app, 'modules/passport-measure/vendor/contract')],
].filter(([, dir]) => existsSync(dir));
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

it('finds the contract somewhere', () => {
  expect(sources.length).toBeGreaterThan(0);
});

describe.each(sources)('contract from %s', (_name, dir) => {
  const contract = read(dir, 'contract.json') as { api: number; schema: string; rounding: string };
  const samples = readdirSync(dir).filter((f) => /^passport-\d+\.\d+\.json$/.test(f));

  it('speaks an API kula reads (else: teach src/passport/contract.ts, then add it to SUPPORTED_API)', () => {
    expect(SUPPORTED_API).toContain(contract.api);
  });

  it('writes a schema major kula reads', () => {
    const major = Number(/^passport\/(\d+)\./.exec(contract.schema)?.[1]);
    expect(SUPPORTED_MAJOR).toContain(major);
  });

  it('rounds half up, as Math.round', () => {
    expect(contract.rounding).toBe('half up');
  });

  it.each(samples)('reads %s without losing a field', (f) => {
    const raw = read(dir, f) as Record<string, unknown>;
    const p = normalizePassport(JSON.stringify(raw));
    for (const [k, v] of Object.entries(raw)) expect(p[k]).toEqual(v);
    // fields of a newer minor are kept and sent on; name them so someone can show them
    const extra = unknownKeys(raw);
    if (extra.length) console.info(`${f}: fields kula does not show yet: ${extra.join(', ')}`);
  });

  it('gives the newest sample all the fields the passport tab shows', () => {
    const newest = samples.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!;
    const p = normalizePassport(readFileSync(join(dir, newest), 'utf8'));
    for (const k of ['device', 'ram_total_gb', 'ram_free_gb', 'mem_bw_gbs', 'gflops', 'largest_model_q4', 'est_tps', 'measured_at'] as const) {
      expect(p[k]).not.toBe('');
    }
  });

  it('knows every field of the newest schema (else: show it, then add it to KNOWN_KEYS in contract.ts)', () => {
    const newest = [...samples].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!;
    expect(unknownKeys(read(dir, newest))).toEqual([]);
  });

  it('reads the 0.3 objects as they come', () => {
    if (!samples.includes('passport-0.3.json')) return;
    const p = normalizePassport(readFileSync(join(dir, 'passport-0.3.json'), 'utf8'));
    expect(p.estimate && p.estimate.tps_low <= p.estimate.tps_high).toBe(true);
    expect(p.budget && p.budget.ram_gb >= 0).toBe(true);
    expect(typeof p.best_threads).toBe('number');
  });

  it('estimates like Measure.kt (estimate-cases.json)', () => {
    const { cases } = read(dir, 'estimate-cases.json') as { cases: { ram_free_gb: number; mem_bw_gbs: number; label: string; tps: number; why: string }[] };
    for (const c of cases) {
      const got = estimateModel(c.ram_free_gb, c.mem_bw_gbs);
      expect({ why: c.why, label: got.label, tps: got.tps }).toEqual({ why: c.why, label: c.label, tps: c.tps });
    }
  });
});

describe('normalizePassport', () => {
  const base = { schema: 'passport/0.2', device: 'd', est_tps: 3 };
  it('drops a 0.3 object of the wrong shape instead of showing it wrong', () => {
    const p = normalizePassport({ ...base, schema: 'passport/0.3', estimate: 'fast', clusters: 4 });
    expect(p.estimate).toBeUndefined();
    expect(p.clusters).toBeUndefined();
  });
  it('keeps the fields of a newer minor', () => {
    const p = normalizePassport({ ...base, schema: 'passport/0.7', npu_tops: 45 });
    expect(p.npu_tops).toBe(45);
    expect(p.schema).toBe('passport/0.7');
  });
  it('refuses a newer major', () => {
    expect(() => normalizePassport({ ...base, schema: 'passport/1.0' })).toThrow('newer');
  });
  it('refuses what is not a passport', () => {
    expect(() => normalizePassport('not json')).toThrow('notPassport');
    expect(() => normalizePassport({ schema: 'ticket/1.0' })).toThrow('notPassport');
  });
  it('refuses a passport without device or speed', () => {
    expect(() => normalizePassport({ schema: 'passport/0.2', device: 'd' })).toThrow('incomplete');
    expect(() => normalizePassport({ schema: 'passport/0.2', est_tps: 1 })).toThrow('incomplete');
  });
  it('reads numbers sent as strings and fills missing ones with 0', () => {
    const p = normalizePassport({ ...base, ram_free_gb: '4.9' });
    expect(p.ram_free_gb).toBe(4.9);
    expect(p.gflops).toBe(0);
  });
});

describe('the speed the screens show', () => {
  // a Galaxy S25+ on 21.10.2026: the card said 28.6–57.3, together said 6.1 (est_tps)
  const s25 = normalizePassport({ schema: 'passport/0.3', device: 'samsung SM-S936B', est_tps: 6.1, largest_model_q4: '<1B', estimate: { fit_b: 1, tps_low: 28.6, tps_high: 57.3, source: 'estimate' } });
  const old = normalizePassport({ schema: 'passport/0.2', device: 'Google Pixel 8', est_tps: 3.9, largest_model_q4: '~3B' });
  it('a 0.3 passport speaks with its range, not est_tps', () => {
    expect(rangeOf(s25)).toEqual({ low: 28.6, high: 57.3 });
    expect(fitLabelOf(s25)).toBe('~1B');
    expect(rangeText(28.6, 57.3)).toBe('28.6–57.3');
  });
  it('an older passport gives est_tps at both ends and its own label', () => {
    expect(rangeOf(old)).toEqual({ low: 3.9, high: 3.9 });
    expect(fitLabelOf(old)).toBe('~3B');
    expect(rangeText(3.9, 3.9)).toBe('3.9');
  });
});

describe('what if they join (combine)', () => {
  // the two devices of 21.10.2026: the S25+ and the MacBook Air M1, as measured
  const phone = normalizePassport({ schema: 'passport/0.3', device: 'samsung SM-S936B', kind: 'phone', est_tps: 6.1, largest_model_q4: '~3B', mem_bw_read_gbs: 58.25,
    budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 1.74, q4_k_m_b: 2.9, q3_k_s_b: 3.9, q8_0_b: 1.6 }, estimate: { fit_b: 1, tps_low: 28.6, tps_high: 57.3, source: 'estimate' } });
  const mac = normalizePassport({ schema: 'passport/0.3', device: 'apple macbook air', kind: 'computer', est_tps: 46.7, largest_model_q4: '~1B', mem_bw_read_gbs: 61.2,
    budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 1.18, q4_k_m_b: 1.9, q3_k_s_b: 2.6, q8_0_b: 1.1 }, estimate: { fit_b: 1, tps_low: 30.1, tps_high: 60.2, source: 'estimate' } });
  const c = combine([phone, mac]);
  it('apart: the speeds add up, the model stays the best single one', () => {
    expect(c.apart).toMatchObject({ low: 58.7, high: 117.5, fitB: 1 });
    expect(c.apart.tokensLow).toBe(Math.round((28.6 + 30.1) * 3600 * 8.5));
  });
  it('split: the budgets add up to a bigger model, the fastest device takes the first share', () => {
    expect(c.split).not.toBeNull();
    expect(c.split!.budgetGb).toBe(2.92);
    expect(c.split!.fitB).toBe(4);
    expect(c.split!.shares.map((s) => s.name)).toEqual(['apple macbook air', 'samsung SM-S936B']);
    expect(c.split!.shares[0].gb).toBe(1.18);
    expect(c.split!.hops).toBe(1);
  });
  it('split: one hop of 100 ms dominates; a lean protocol would be about twice as fast', () => {
    expect(c.split!.high).toBe(5.9);
    expect(c.split!.low).toBe(4.2);
    expect(c.split!.leanHigh).toBe(13.7);
  });
  it('one device: nothing to split', () => {
    expect(combine([phone]).split).toBeNull();
  });
});
