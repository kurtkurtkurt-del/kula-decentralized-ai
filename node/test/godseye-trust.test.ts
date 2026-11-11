// god's eye, branch 8 (10.11.2026): the cluster's security report. Real keys, a real certificate
// and real signed ledger lines; the branch must believe none of it without checking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const { create, identityCheck, lineProblem, GUESS_LIMIT } = await import('../src/godseye/branches/trust.ts');
const { nodeKeys, nodeKey } = await import('../src/godseye/node.ts');   // the computer's signatures (platform.ts)
const { generate, fromPrivateKey, publicKeyDer } = await import('../src/audit/key.ts');
const { makeLine, GENESIS, sha256Hex } = await import('../src/audit/ledger.ts');
const { selfSigned, newP256, fingerprint } = await import('../src/tls.ts');
const { foldTrust, TRUST_WINDOW } = await import('../src/ui/engine.ts');

function device(key = generate()) {
  const certDer = selfSigned(newP256(), key.id);
  const lines: string[] = [];
  let prev = GENESIS;
  let t = 1_000;
  const add = (kind: any = 'connect', fields: Record<string, string | number> = {}) => {
    const { line } = makeLine(key, t++, kind, '192.168.1.5', fields, prev);
    lines.push(line);
    prev = sha256Hex(line);
    return line;
  };
  return { key, certDer, fp: fingerprint(certDer), lines, add };
}
type Dev = ReturnType<typeof device>;

let at = 1;
const trustOf = (d: Dev, o: Record<string, unknown> = {}) => ({
  at: at++, error: null, id: d.key.id, alg: d.key.alg, pub: publicKeyDer(d.key.publicKey).toString('base64'), store: 'keystore',
  cert: d.certDer.toString('base64'), certPinned: true, v1: false, paired: 1, self: 'ok', count: d.lines.length,
  head: d.lines.length ? sha256Hex(d.lines.at(-1)!) : GENESIS, lines: [...d.lines], restartedAt: null,
  rejectsDay: {}, rejectsLast: [], ...o,
});
const eyeDev = (d: Dev, trust: unknown, o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null,
  trust, ...o,
});
const snap = (devices: any[], ledger: any = { ok: true, count: 3, problem: null }) => ({
  at: 5_000, host: { name: 'mac', freeMb: 4000, ledger }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
function branch() {
  let notes: unknown = {};
  const events: string[] = [];
  const b = create({ now: () => 9_000, load: <T>(f: T) => (structuredClone(notes) as T) ?? f, save: (x: unknown) => { notes = structuredClone(x); }, emit: (t: string) => events.push(t), peek: () => null, keys: nodeKeys });
  return { b, events, notes: () => notes as any };
}
const check = (v: any, k: string, dev = 0) => v.report.devices[dev].checks.find((c: any) => c.k === k);

test('one device, everything right: all clear, every check ticked; ed25519 and p256 ledger keys both verify', () => {
  for (const key of [generate(), fromPrivateKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey)]) {
    const d = device(key);
    d.add('pair', { fp: 'ab' }); d.add(); d.add('reject', { why: 'not paired' });
    const { b } = branch();
    b.observe(snap([eyeDev(d, trustOf(d, { rejectsDay: { 'not paired': 1 } }))]) as any, null);
    const v = b.view();
    assert.equal(v.report!.verdict, 'ok', JSON.stringify(v.report));
    assert.match(v.report!.headline, /^1 device: every link pinned/);
    assert.equal(v.stat, 'all clear · 1 device');
    for (const k of ['pinned', 'encrypted', 'identity', 'refused', 'ledger', 'key']) assert.equal(check(v, k).ok, true, k);
    assert.match(check(v, 'ledger').text, /3 lines checked/);
    assert.match(check(v, 'refused').text, /not paired ×1/);
  }
});

test('identity: another certificate than the pinned one, a key that is not the claimed id, a cn of another device', () => {
  const d = device();
  d.add();
  const t = trustOf(d);
  assert.equal(identityCheck(t as any, nodeKeys).ok, true);
  assert.match(identityCheck({ ...t, certPinned: false } as any, nodeKeys).text, /not the one pinned/);
  assert.equal(identityCheck({ ...t, id: 'a'.repeat(32) } as any, nodeKeys).ok, false);
  const other = selfSigned(newP256(), 'b'.repeat(32));
  const r = identityCheck({ ...t, cert: other.toString('base64') } as any, nodeKeys);
  assert.equal(r.ok, false);
  assert.match(r.text, /names another device/);
  assert.equal(identityCheck({ ...t, certPinned: null } as any, nodeKeys).ok, null);
});

test('a changed line, a forged signature and a dropped line are each caught, and the device turns red', () => {
  const d = device();
  d.add(); d.add(); d.add();
  const key = nodeKey(d.key.publicKey);
  assert.equal(lineProblem(d.lines[1], key, sha256Hex(d.lines[0])), null);
  const changed = d.lines[1].replace('"connect"', '"reject"');
  assert.match(lineProblem(changed, key, sha256Hex(d.lines[0]))!, /signature/);
  assert.match(lineProblem(d.lines[2], key, sha256Hex(d.lines[0]))!, /chain is broken/);
  const stranger = makeLine(generate(), 5, 'connect', 'x', {}, sha256Hex(d.lines[0])).line;
  assert.match(lineProblem(stranger, key, sha256Hex(d.lines[0]))!, /signature/);

  const { b, events } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { lines: [d.lines[0], d.lines[2]] }))]) as any, null);
  const v = b.view();
  assert.equal(v.report!.verdict, 'bad');
  assert.equal(check(v, 'ledger').ok, false);
  assert.ok(v.report!.devices[0].accept);
  assert.ok(events.some((e) => /pixel: its ledger: the chain is broken/.test(e)));
});

test('later looks join the new lines to the last one verified; a ledger that started over stays red until the person says they know', () => {
  const d = device();
  d.add(); d.add();
  const { b, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  const head = notes().p1.head;
  assert.equal(head, sha256Hex(d.lines[1]));
  // the next look: only the new lines arrive, the window still holds the old ones (foldTrust)
  d.add(); d.add();
  b.observe(snap([eyeDev(d, trustOf(d))]) as any, null);
  assert.equal(notes().p1.verified, 4);
  assert.equal(b.view().report!.verdict, 'ok');
  // the phone's ledger was cleared: a new chain from the genesis zeros, restartedAt set
  const fresh = device(d.key);
  fresh.add(); fresh.add();
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { restartedAt: 7_000 }))]) as any, null);
  let v = b.view();
  assert.equal(v.report!.verdict, 'bad');
  assert.match(check(v, 'ledger').text, /started over/);
  assert.equal(notes().p1.head, sha256Hex(fresh.lines[1]), 'the new chain is followed from here');
  // it stays red on the next look, until accepted
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { restartedAt: 7_000 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(b.act!('accept', 'p1'), null, 'nothing left to accept');
});

test('refusals: a few are fine, a replay or many wrong codes turn the device red; the old protocol still open turns it red', () => {
  const d = device();
  d.add();
  const { b } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { rejectsDay: { 'wrong pin': GUESS_LIMIT - 1 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  b.observe(snap([eyeDev(d, trustOf(d, { rejectsDay: { 'wrong pin': GUESS_LIMIT } }))]) as any, null);
  assert.match(check(b.view(), 'refused').text, /someone may be guessing/);
  b.observe(snap([eyeDev(d, trustOf(d, { rejectsDay: { replay: 1 } }))]) as any, null);
  assert.match(check(b.view(), 'refused').text, /replayed/);
  b.observe(snap([eyeDev(d, trustOf(d, { v1: true }))]) as any, null);
  assert.match(check(b.view(), 'encrypted').text, /old plain-text protocol/);
  assert.equal(b.view().report!.verdict, 'bad');
});

test('the whole answer: an older pairing is red, a device not asked yet is "not checked", this computer\'s broken ledger is red', () => {
  const d = device();
  d.add();
  let r = branch();
  r.b.observe(snap([eyeDev(d, null)]) as any, null);
  assert.equal(r.b.view().report!.verdict, 'unknown');
  assert.match(r.b.view().report!.headline, /not checked yet: pixel/);
  r = branch();
  r.b.observe(snap([eyeDev(d, null, { tls: false })]) as any, null);
  assert.equal(r.b.view().report!.verdict, 'bad');
  assert.match(r.b.view().report!.headline, /older pairing/);
  r = branch();
  r.b.observe(snap([eyeDev(d, trustOf(d))], { ok: false, count: 4, problem: 'line 2 of ledger.jsonl: bad sig' }) as any, null);
  assert.equal(r.b.view().report!.verdict, 'bad');
  assert.match(r.b.view().report!.headline, /this computer: its own ledger is broken/);
  r = branch();
  r.b.observe(snap([eyeDev(d, { ...trustOf(d), error: 'an older kula without the security report: update it' })]) as any, null);
  assert.equal(r.b.view().report!.verdict, 'unknown');
  assert.match(check(r.b.view(), 'identity').text, /older kula/);
  r = branch();
  r.b.observe(snap([]) as any, null);
  assert.equal(r.b.view().stat, 'nothing to check');
});

test('the engine folds /trust answers: new lines join the window, a ledger that no longer holds the line asked for starts it again', () => {
  const body = (lines: string[], found: boolean | null, more = false) => ({ v: 1, id: 'a'.repeat(32), key: { alg: 'ed25519', pub: 'AA==', store: 'file' }, cert: null, gate: { v1: false, tls: true, paired: 1 }, ledger: { count: 9, head: 'c'.repeat(64), self: 'ok', found, more, lines }, rejects: { day: { 'not paired': 2, bad: 'x' }, last: [{ t: 1, why: 'not paired', peer: '1.2.3.4' }] } });
  let t = foldTrust(null, body(['a', 'b'], null), 10);
  assert.deepEqual(t.lines, ['a', 'b']);
  assert.deepEqual(t.rejectsDay, { 'not paired': 2 });
  assert.equal(t.restartedAt, null);
  assert.equal(t.upTo, sha256Hex('b'), 'the next look starts after the last line received, not at the head');
  t = foldTrust(t, body(['c'], true), 20);
  assert.deepEqual(t.lines, ['a', 'b', 'c']);
  assert.equal(foldTrust(t, body([], true), 21).upTo, sha256Hex('c'), 'nothing new: still after c');
  t = foldTrust(t, body(['x'], false), 30);
  assert.deepEqual(t.lines, ['x']);
  assert.equal(t.restartedAt, 30);
  const many = Array.from({ length: 200 }, (_, i) => `l${i}`);
  for (let i = 0; i < 4; i++) t = foldTrust(t, body(many, true), 40 + i);
  assert.equal(t.lines.length, TRUST_WINDOW);
  assert.equal(foldTrust(null, { ledger: { head: 'not hex' } }, 1).head, null);
  // the pin stays in the engine: only whether the shown certificate matches it goes on
  const der = selfSigned(newP256(), 'a'.repeat(32));
  const withCert = { ...body([], null), cert: der.toString('base64') };
  assert.equal(foldTrust(null, withCert, 1, fingerprint(der)).certPinned, true);
  assert.equal(foldTrust(null, withCert, 1, 'f'.repeat(64)).certPinned, false);
  assert.equal(foldTrust(null, withCert, 1, null).certPinned, null);
  assert.ok(!JSON.stringify(foldTrust(null, withCert, 1, fingerprint(der))).includes(fingerprint(der)));
});
