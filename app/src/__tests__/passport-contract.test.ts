// kula's side of the passport-core contract. The files come from device-passport itself
// (../device-passport/passport-core/contract) when it sits beside this repo, and from the
// snapshot (modules/passport-measure/vendor/contract) always; both are tested, so a change
// in device-passport that kula does not follow fails here before it reaches a phone.
// The Kotlin side tests the same files: PassportCoreContractTest in passport-core.
import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { estimateModel, normalizePassport, SUPPORTED_API, SUPPORTED_MAJOR, unknownKeys } from '@/passport/contract';

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
