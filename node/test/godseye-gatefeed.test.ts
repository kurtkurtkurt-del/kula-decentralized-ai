// host.gate (16.11.2026): this computer's own gate refusals, counted by the feed from the reject
// lines of its own signed ledger, in the same pass hostLedger verifies them. A real Ledger and
// Auditor in a temp dir: each line counted exactly once, older than 26 hours never, and no
// address ever reaches the snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreate } from '../src/audit/key.ts';
import { Ledger } from '../src/audit/ledger.ts';
import { Auditor } from '../src/audit/auditor.ts';
import { hostGate, hostLedger, hostLedgerVerifiedLines, kulaSnapshot } from '../src/ui/godseye-feed.ts';
import { clean } from '../src/godseye/branches/guard.ts';

const H = 3_600_000;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const IPV6 = /\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/i;

type Ctx = { dir: string; file: string; L: Ledger; A: Auditor; skew: { ms: number } };
function withLedger(run: (c: Ctx) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-gatefeed-'));
  const was = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  try {
    const key = loadOrCreate(path.join(dir, 'device_key.pem'));
    const file = path.join(dir, 'ledger.jsonl');
    const skew = { ms: 0 };
    const L = new Ledger(file, key, () => Date.now() + skew.ms);
    const A = new Auditor({ ledger: L });
    run({ dir, file, L, A, skew });
  } finally {
    if (was === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// the three refusals of the decision: a public 'no hello', a lan 'not paired', a lan rpc guard
function three(A: Auditor) {
  A.reject('203.0.113.7', 'no hello', { channel: 'api' });
  A.connect('192.168.1.20', 'api');
  A.reject('192.168.1.5', 'not paired', { channel: 'api' });
  A.reject('10.0.0.3', 'rpc guard: op 12 (set tensor graph)', { channel: 'rpc' });
}

const sum = (g: NonNullable<ReturnType<typeof hostGate>>) => {
  const by: Record<string, number> = {};
  let far = 0;
  for (const h of g.hours) { far += h.far; for (const [k, n] of Object.entries(h.by)) by[k] = (by[k] ?? 0) + n; }
  return { by, far, nets: g.nets, guard: g.guard.length };
};

test('three refusals: far 1, nets 1, guard 1, every reason counted once; 26 hours, the last running', () => {
  withLedger(({ file, A }) => {
    three(A);
    assert.equal(hostLedger(file)!.ok, true);
    const now = Date.now();
    const g = hostGate(now)!;
    assert.equal(g.hours.length, 26);
    assert.equal(g.hours[25].start, Math.floor(now / H) * H);
    assert.equal(g.hours[0].start, g.hours[25].start - 25 * H);
    assert.deepEqual(sum(g), { by: { 'no hello': 1, 'not paired': 1, 'rpc guard': 1 }, far: 1, nets: 1, guard: 1 });
    assert.equal(g.guard[0].why, 'rpc guard: op 12 (set tensor graph)');
    // the guard cleans it to itself
    assert.deepStrictEqual(clean({ at: now, host: { name: 'mac', freeMb: 1, gate: g } })!.host.gate, g);
  });
});

test('an append is one more line verified and one more refusal counted; two looks say the same', () => {
  withLedger(({ file, A }) => {
    three(A);
    hostLedger(file);
    const before = sum(hostGate()!);
    const c0 = hostLedgerVerifiedLines();
    A.reject('198.51.100.9', 'tls', { channel: 'rpc' });
    assert.equal(hostLedger(file)!.ok, true);
    assert.equal(hostLedgerVerifiedLines() - c0, 1, 'only the appended line is verified');
    const after = sum(hostGate()!);
    assert.deepEqual(after, { ...before, by: { ...before.by, tls: 1 }, far: 2, nets: 2 });
    // nothing changed: the same counts, nothing verified
    const c1 = hostLedgerVerifiedLines();
    assert.equal(hostLedger(file)!.ok, true);
    assert.deepEqual(sum(hostGate()!), after);
    assert.equal(hostLedgerVerifiedLines(), c1);
    // the same /24 again is the same network
    A.reject('198.51.100.200', 'no hello', { channel: 'api' });
    hostLedger(file);
    assert.equal(hostGate()!.nets, 2);
  });
});

test('a rewritten file is not counted twice; a line appended after the rewrite is counted once', () => {
  withLedger(({ file, L, A }) => {
    three(A);
    hostLedger(file);
    const before = sum(hostGate()!);
    // the same bytes written again, later: the verified prefix still holds
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    hostLedger(file);
    assert.deepEqual(sum(hostGate()!), before);
    // its connect line changed in place, same length: the live file is folded again from byte 0
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.includes('"kind":"connect"'));
    lines[i] = lines[i].replace('192.168.1.20', '192.168.1.21');
    fs.writeFileSync(file, lines.join('\n'));
    const later2 = new Date(Date.now() + 120_000);
    fs.utimesSync(file, later2, later2);
    const c0 = hostLedgerVerifiedLines();
    assert.equal(hostLedger(file)!.ok, false);
    assert.ok(hostLedgerVerifiedLines() - c0 > 1, 'folded from its start');
    assert.deepEqual(sum(hostGate()!), before, 'the refusals already counted are not counted again');
    // the writer goes on (same size, no resync) and a new refusal after the rewrite counts once
    L.append('reject', '2001:db8:1:2::9', { reason: 'bad hello', channel: 'api' });
    hostLedger(file);
    const after = sum(hostGate()!);
    assert.equal(after.by['bad hello'], 1);
    assert.equal(after.far, before.far + 1);
    assert.equal(after.nets, before.nets + 1);
  });
});

test('a refusal older than 26 hours is not counted', () => {
  withLedger(({ file, A, skew }) => {
    skew.ms = -27 * H;
    A.reject('203.0.113.50', 'no hello', { channel: 'api' });
    A.reject('203.0.113.51', 'rpc guard: old', { channel: 'rpc' });
    skew.ms = 0;
    A.reject('192.0.2.1', 'not paired', { channel: 'api' });
    assert.equal(hostLedger(file)!.ok, true);
    assert.deepEqual(sum(hostGate()!), { by: { 'not paired': 1 }, far: 1, nets: 1, guard: 0 });
  });
});

test('private, loopback, link-local and cgnat addresses are not far; ipv6 networks are /48', () => {
  withLedger(({ file, A }) => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.0.9', '169.254.1.1', '100.64.3.3', '127.0.0.1', '::1', 'fe80::1', 'fd12:3456::7', '?', 'self'])
      A.reject(ip, 'no hello', { channel: 'api' });
    for (const ip of ['2001:db8:aa:1::1', '2001:db8:aa:ffff::2', '::ffff:203.0.113.4', '2001:db8:bb::3'])
      A.reject(ip, 'no hello', { channel: 'api' });
    hostLedger(file);
    const s = sum(hostGate()!);
    assert.equal(s.by['no hello'], 15);
    assert.equal(s.far, 4);
    assert.equal(s.nets, 3, 'two in 2001:db8:aa::/48, one ipv4 /24, one in 2001:db8:bb::/48');
  });
});

test('the snapshot carries host.gate and the engine\'s anchor counters, and no address at all', () => {
  withLedger(({ A }) => {
    three(A);
    A.reject('2001:db8:5:6::7', 'tls', { channel: 'rpc' });
    const row = {
      id: 'far1', name: 'far phone', kind: 'phone', where: 'through anc1', far: false, tls: true, waitingPair: false,
      ram: 3400, bw: 60, gpu: null, last_ok: null, reach: { ok: true, ms: 90 }, probedAt: 1,
      cable: null, holds: null, via: 'anchor', through: 'anc1', anchor: false,
      ways: { cable: null, wifi: null, relay: null }, routes: ['far1'], heardAt: null,
      usesThisComputer: false, reachedBy: null, ring: 'circle',
    };
    const engine = {
      status: () => ({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }),
      peers: () => [structuredClone(row)],
      trustOf: () => null,
      models: () => [],
      photos: () => ({ n: 0, unseen: 0, at: null }),
      diskFreeMb: () => 1000,
      anchor: () => ({ on: true, reachable: true, links: 2, bytesDay: 12345, capDay: null }),
    };
    const s = kulaSnapshot(engine as any, { list: () => [] } as any, Date.now());
    assert.equal(s.host.ledger!.ok, true);
    assert.ok(s.host.gate);
    assert.equal(sum(s.host.gate!).far, 2);
    assert.equal(sum(s.host.gate!).nets, 2);
    assert.deepEqual(s.host.anchor, { on: true, reachable: true, links: 2, bytesDay: 12345, capDay: null });
    assert.equal(s.devices[0].via, 'anchor');
    assert.equal(s.devices[0].through, 'anc1');
    assert.equal(s.devices[0].anchor, false);
    const json = JSON.stringify(clean(s));
    assert.doesNotMatch(json, IPV4);
    assert.doesNotMatch(json, IPV6);
    // an engine without anchors: host.anchor is left out, a throwing one says null
    const { anchor: _a, ...plain } = engine;
    assert.equal('anchor' in kulaSnapshot(plain as any, { list: () => [] } as any).host, false);
    assert.equal(kulaSnapshot({ ...plain, anchor: () => { throw new Error('x'); } } as any, { list: () => [] } as any).host.anchor, null);
    // P1b: a row's throughName and through 'self' pass as they are; memberMaxDay only when the engine says it
    assert.equal('throughName' in s.devices[0], false, 'a row without it leaves it out');
    const selfRow = { ...structuredClone(row), through: 'self', throughName: 'this computer', where: 'through this computer (its anchor)' };
    const s2 = kulaSnapshot({ ...engine, peers: () => [selfRow], anchor: () => ({ on: true, reachable: null, links: 3, bytesDay: 9e9, capDay: 2e9, memberMaxDay: 3e9 }) } as any, { list: () => [] } as any, Date.now());
    assert.equal(s2.devices[0].through, 'self');
    assert.equal(s2.devices[0].throughName, 'this computer');
    assert.equal(s2.host.anchor!.memberMaxDay, 3e9);
    assert.equal(clean(s2)!.devices[0].through, 'self');
    assert.equal('memberMaxDay' in s.host.anchor!, false);
  });
});
