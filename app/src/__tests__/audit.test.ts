// beyin's ledger read on the phone: a sample ledger chains, one changed byte breaks it at
// the right line, an empty ledger is fine, and the peer badges follow the newest line.
import { describe, expect, it } from '@jest/globals';
import { GENESIS, detailOf, filterKind, parseLedger, peerBadge, sha256Hex, summarize, verdictOf, verifyChain } from '@/llm/audit';

// Builds lines the way Ledger.kt does: ordered fields, prev = sha256 of the previous line,
// a stand-in signature (the phone does not check signatures, only the chain).
function ledger(events: Record<string, unknown>[], firstPrev = GENESIS): string[] {
  const out: string[] = [];
  let prev = firstPrev;
  for (const e of events) {
    const line = JSON.stringify({ ...e, prev, sig: 'c2ln' });
    out.push(line);
    prev = sha256Hex(line);
  }
  return out;
}

const sample = ledger([
  { t: 1_700_000_000_000, kind: 'pair', peer: '10.0.0.2' },
  { t: 1_700_000_001_000, kind: 'connect', peer: '10.0.0.2', channel: 'rpc' },
  { t: 1_700_000_002_000, kind: 'claim', peer: '10.0.0.2', ramMb: 4096, heldMb: 1024, bw: 12.5, tps: 9, modelGb: 2.1, warn: ['ram claim far above held'] },
  { t: 1_700_000_003_000, kind: 'reject', peer: '10.0.0.3', channel: 'rpc', why: 'wrong secret' },
  { t: 1_700_000_004_000, kind: 'health', throttled: false, batteryC: 31, batteryPct: 80 },
  { t: 1_700_000_005_000, kind: 'end', peer: '10.0.0.2', channel: 'rpc', bytes: 1200, seconds: 4 },
  { t: 1_700_000_006_000, kind: 'load', split: [{ peer: 'local', layers: 20 }, { peer: '10.0.0.2', layers: 12 }], sha: 'abcdef0123456789' },
]);

describe('sha256', () => {
  it('matches the known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('ğüşiöç')).toBe(sha256Hex('ğüşiöç'));
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});

describe('the chain', () => {
  it('verifies a sample ledger from genesis', () => {
    expect(verifyChain(sample)).toEqual({ ok: true, broken: null, fromGenesis: true });
  });
  it('accepts a tail that starts mid-chain', () => {
    const r = verifyChain(sample.slice(3));
    expect(r.ok).toBe(true);
    expect(r.fromGenesis).toBe(false);
  });
  it('breaks at the line after the changed one', () => {
    const broken = [...sample];
    broken[2] = broken[2].replace('"ramMb":4096', '"ramMb":8192');
    expect(verifyChain(broken)).toMatchObject({ ok: false, broken: 3 });
  });
  it('breaks on a dropped line and on a line that is not json', () => {
    expect(verifyChain([sample[0], sample[2]])).toMatchObject({ ok: false, broken: 1 });
    expect(verifyChain([sample[0], 'not a ledger line'])).toMatchObject({ ok: false, broken: 1 });
  });
  it('is fine with an empty ledger', () => {
    expect(verifyChain([])).toEqual({ ok: true, broken: null, fromGenesis: true });
    expect(verifyChain(['', ''])).toEqual({ ok: true, broken: null, fromGenesis: true });
    expect(summarize(parseLedger([]))).toEqual({ total: 0, rejects: 0, warns: 0, malformed: 0, byKind: {}, last: null });
  });
});

describe('the summary', () => {
  const entries = parseLedger(sample);
  it('counts rejects, warnings and kinds', () => {
    const s = summarize(entries);
    expect(s.total).toBe(7);
    expect(s.rejects).toBe(1);
    expect(s.warns).toBe(1);
    expect(s.malformed).toBe(0);
    expect(s.byKind).toEqual({ pair: 1, connect: 1, claim: 1, reject: 1, health: 1, end: 1, load: 1 });
    expect(s.last).toBe(1_700_000_006_000);
  });
  it('keeps malformed lines apart', () => {
    const s = summarize(parseLedger([...sample, '{"t":1}', 'x']));
    expect(s.total).toBe(7);
    expect(s.malformed).toBe(2);
  });
  it('filters by kind and gives each line its verdict', () => {
    expect(filterKind(entries, 'claim')).toHaveLength(1);
    expect(filterKind(entries, null)).toHaveLength(7);
    expect(entries.map((e) => verdictOf(e.line!))).toEqual(['verified', 'verified', 'warn', 'rejected', 'verified', 'verified', 'verified']);
    expect(verdictOf(parseLedger(ledger([{ t: 1, kind: 'end', peer: 'p', reject: 'too long' }]))[0].line!)).toBe('rejected');
  });
  it('writes a detail line per kind', () => {
    expect(detailOf(entries[3].line!)).toBe('rpc · wrong secret');
    expect(detailOf(entries[2].line!)).toBe('4096 / 1024 mb · 12.5 gb/s · 9 tps · ram claim far above held');
    expect(detailOf(entries[6].line!)).toBe('sha abcdef012345 · 2 parts');
  });
});

describe('the peer badges', () => {
  const entries = parseLedger(sample);
  it('follow the newest line per peer', () => {
    expect(peerBadge(entries, '10.0.0.2')).toBe('verified'); // the end line came after the warned claim
    expect(peerBadge(entries, '10.0.0.3')).toBe('rejected');
    expect(peerBadge(entries, '10.0.0.9')).toBe('none');
    expect(peerBadge(entries.slice(0, 3), '10.0.0.2')).toBe('warn');
  });
});
