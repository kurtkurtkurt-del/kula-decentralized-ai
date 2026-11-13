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
const { foldTrust, TRUST_WINDOW, TRUST_LINES, TRUST_ROUNDS } = await import('../src/ui/engine.ts');
const { ownerBlind } = await import('../src/attest.ts');

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

test('a device that reports 5000 ledger lines but sends none: not checked, never "every ledger holds"', () => {
  const d = device();
  const { b } = branch();
  for (let i = 0; i < 3; i++) b.observe(snap([eyeDev(d, trustOf(d, { count: 5000, head: 'f'.repeat(64), lines: [] }))]) as any, null);
  const v = b.view();
  assert.notEqual(v.report!.verdict, 'ok', JSON.stringify(v.report));
  assert.equal(v.report!.verdict, 'unknown');
  assert.doesNotMatch(v.report!.headline, /every ledger holds/);
  assert.equal(check(v, 'ledger').ok, null);
  assert.equal(check(v, 'ledger').text, 'it reports 5000 lines, none checked here yet');
  // it then stops saying its length: still nothing checked here, still not all clear
  b.observe(snap([eyeDev(d, trustOf(d, { count: null, head: 'f'.repeat(64), lines: [] }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').ok, null);
  assert.equal(b.view().report!.verdict, 'unknown');
  // a device with no ledger lines at all (count 0, or no count) is still all clear
  for (const o of [{}, { count: undefined }]) {
    const e = device();
    const r = branch();
    r.b.observe(snap([eyeDev(e, trustOf(e, o))]) as any, null);
    assert.equal(check(r.b.view(), 'ledger').text, 'no ledger lines yet');
    assert.equal(r.b.view().report!.verdict, 'ok', JSON.stringify(o));
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
  // (P43: the lines were 'a', 'b', 'c', which name no prev. The engine now checks every link after
  // a since, so they are real chained ledger lines; the meaning of each step is unchanged.)
  const d = device();
  for (let i = 0; i < 3; i++) d.add();
  const [a, b, c] = d.lines;
  const e = device();
  for (let i = 0; i < 1 + 4 * 200; i++) e.add();
  const x = e.lines[0];
  const body = (lines: string[], found: boolean | null, more = false) => ({ v: 1, id: 'a'.repeat(32), key: { alg: 'ed25519', pub: 'AA==', store: 'file' }, cert: null, gate: { v1: false, tls: true, paired: 1 }, ledger: { count: 9, head: 'c'.repeat(64), self: 'ok', found, more, lines }, rejects: { day: { 'not paired': 2, bad: 'x' }, last: [{ t: 1, why: 'not paired', peer: '1.2.3.4' }] } });
  let t = foldTrust(null, body([a, b], null), 10);
  assert.deepEqual(t.lines, [a, b]);
  assert.deepEqual(t.rejectsDay, { 'not paired': 2 });
  assert.equal(t.restartedAt, null);
  assert.equal(t.upTo, sha256Hex(b), 'the next look starts after the last line received, not at the head');
  t = foldTrust(t, body([c], true), 20);
  assert.deepEqual(t.lines, [a, b, c]);
  assert.equal(foldTrust(t, body([], true), 21).upTo, sha256Hex(c), 'nothing new: still after c');
  t = foldTrust(t, body([x], false), 30);
  assert.deepEqual(t.lines, [x]);
  assert.equal(t.restartedAt, 30);
  for (let i = 0; i < 4; i++) t = foldTrust(t, body(e.lines.slice(1 + i * 200, 201 + i * 200), true), 40 + i);
  assert.equal(t.lines.length, TRUST_WINDOW);
  assert.equal(t.restartedAt, 30, 'every round linked: no new restart');
  assert.equal(foldTrust(null, { ledger: { head: 'not hex' } }, 1).head, null);
  // the pin stays in the engine: only whether the shown certificate matches it goes on
  const der = selfSigned(newP256(), 'a'.repeat(32));
  const withCert = { ...body([], null), cert: der.toString('base64') };
  assert.equal(foldTrust(null, withCert, 1, fingerprint(der)).certPinned, true);
  assert.equal(foldTrust(null, withCert, 1, 'f'.repeat(64)).certPinned, false);
  assert.equal(foldTrust(null, withCert, 1, null).certPinned, null);
  assert.ok(!JSON.stringify(foldTrust(null, withCert, 1, fingerprint(der))).includes(fingerprint(der)));
});

test('the engine folds /trust answers: an answer to a since that leaves out found (or sends null) is a ledger that started over, never a quiet gap', () => {
  // (P43: 'a', 'b', 'c' became chained ledger lines, as above; found true now also needs the link)
  const d = device();
  for (let i = 0; i < 3; i++) d.add();
  const [a, b, c] = d.lines;
  const x = device().add();
  const body = (lines: string[], ledger: Record<string, unknown> = {}) => ({ v: 1, id: 'a'.repeat(32), key: { alg: 'ed25519', pub: 'AA==', store: 'file' }, cert: null, gate: { v1: false, tls: true, paired: 1 }, ledger: { count: 9, head: 'c'.repeat(64), self: 'ok', more: false, lines, ...ledger } });
  // the first answer: no since was asked (upTo null), so no found is no restart
  const first = foldTrust(null, body([a, b]), 10);
  assert.equal(first.restartedAt, null);
  assert.equal(foldTrust(null, body([a], { found: null }), 10).restartedAt, null);
  assert.ok(first.upTo, 'the next look asks since the last line');
  // the next look asked since=upTo: an answer without found, or with found null, cannot say it holds the line
  for (const ledger of [{}, { found: null }, { found: 'yes' }, { found: 1 }]) {
    const t = foldTrust(first, body([x], ledger), 20);
    assert.equal(t.restartedAt, 20, JSON.stringify(ledger));
    assert.deepEqual(t.lines, [x], 'the window starts again');
  }
  assert.equal(foldTrust(first, body([c], { found: true }), 20).restartedAt, null, 'found true: the chain goes on');
  assert.equal(foldTrust(first, body([x], { found: false }), 20).restartedAt, 20);
  // a look that had nothing to ask since (no upTo: nothing received yet) sets no restart either
  const empty = foldTrust(null, body([]), 5);
  assert.equal(empty.upTo, null);
  assert.equal(foldTrust(empty, body([a]), 6).restartedAt, null);
});

// ---- owner-blind (11.11.2026): can the device's owner read the jobs it runs ---------------------

const DEBUG = 'hardware key, locked, verified boot, but a debug build (signed with the public debug key): its owner could still read jobs';
const proof = (ok: boolean | null, text: string, at = 8_000) => ({ at, ok, why: ok ? 'ok' : 'unofficial', text });
const running = (ids: string[]) => ({ loaded: { mode: 'apart', model: { id: 'm', name: 'm', file: 'm.gguf', size: 1 }, ctx: 4096, since: 1, devices: ids.map((id) => ({ id, name: id, local: id === 'mac', busy: false, tps: null, done: 0 })) }, loading: null, chatting: 0, plan: [], decisions: [], llama: true });

test('owner-blind: one line per device, shown and never counted in the verdict', () => {
  const d = device();
  d.add();
  const look = (attest: unknown, o: Record<string, unknown> = {}) => {
    const { b } = branch();
    b.observe(snap([eyeDev(d, trustOf(d, { attest }), o)]) as any, null);
    return b.view();
  };
  const debug = look(proof(false, DEBUG));
  assert.deepEqual(check(debug, 'owner-blind'), { k: 'owner-blind', ok: false, text: DEBUG });
  assert.equal(debug.report!.verdict, 'ok', 'informational: the device stays all clear');
  assert.equal(debug.lines[0], 'pixel · all clear');
  const ok = look(proof(true, 'hardware key, locked, verified boot, official kula build: its owner cannot read jobs'));
  assert.equal(check(ok, 'owner-blind').ok, true);
  // never asked; a computer; an older kula; a proof older than a day; a field out of shape
  assert.equal(check(look(undefined), 'owner-blind').text, 'not asked yet whether its owner can read jobs');
  assert.deepEqual(check(look(null, { kind: 'pc' }), 'owner-blind'), { k: 'owner-blind', ok: null, text: 'a computer cannot prove this' });
  assert.equal(check(look({ at: 8_000, ok: null, why: 'computer', text: 'a computer cannot prove this' }, { kind: 'pc' }), 'owner-blind').ok, null);
  // (P43, G3: a phone that sends no proof was "an older kula: it cannot prove this yet", ok null; a
  // phone can make one, so it now fails the check, still informational)
  const old = look({ at: 8_000, ok: null, why: 'old', text: 'an older kula: it cannot prove this yet' });
  assert.deepEqual(check(old, 'owner-blind'), { k: 'owner-blind', ok: false, text: 'it sent no proof (a phone can make one): nothing shows its owner cannot read jobs' });
  assert.equal(old.report!.verdict, 'ok', 'still never in the verdict');
  const { b } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { attest: proof(true, 'fine', 9_000 - 27 * 3_600_000) }))]) as any, null);
  assert.deepEqual([check(b.view(), 'owner-blind').ok, /not asked again since/.test(check(b.view(), 'owner-blind').text)], [null, true]);
  for (const bad of [{ at: 'x', ok: true, text: 't' }, { at: 1, ok: 'yes', text: 't' }, { at: 1, ok: true, text: '' }, { at: 1, ok: true, text: 'x'.repeat(301) }, 'proof']) {
    assert.equal(check(look(bad), 'owner-blind').text, typeof bad === 'string' ? 'not asked yet whether its owner can read jobs' : 'its last proof could not be read');
  }
  // a device red for something else: the feed and the headline name that, not owner-blind
  const red = branch();
  red.b.observe(snap([eyeDev(d, trustOf(d, { attest: proof(false, DEBUG), rejectsDay: { replay: 1 } }))]) as any, null);
  assert.match(red.b.view().report!.headline, /replayed/);
});

test('owner-blind: a warning card for a device in the running cluster that fails it, none for the others', () => {
  const a = device(), c = device();
  a.add(); c.add();
  const { b } = branch();
  const devs = [eyeDev(a, trustOf(a, { attest: proof(false, DEBUG) })), eyeDev(c, trustOf(c, { attest: proof(false, DEBUG) }), { id: 'p2', name: 'tablet' })];
  b.observe({ ...snap(devs), work: running([]) } as any, null);
  assert.deepEqual(b.view().suggestions, [], 'nothing runs: no card');
  b.observe({ ...snap(devs), work: running(['p1', 'mac']) } as any, null);
  const cards = b.view().suggestions!;
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    id: 'trust:owner-blind:p1', kind: 'warn', weight: 1, title: 'pixel could read the jobs it runs',
    why: `${DEBUG}. Prompts reach it in plain text, so only give it work you would show its owner.`,
    action: { do: 'open', panel: 'branch', branch: 'trust' }, label: 'look',
  });
  // a device that passes, or cannot say (a computer), gets no card
  const ok = branch();
  ok.b.observe({ ...snap([eyeDev(a, trustOf(a, { attest: proof(true, 'fine') })), eyeDev(c, trustOf(c, { attest: null }), { id: 'p2', kind: 'pc' })]), work: running(['p1', 'p2']) } as any, null);
  assert.deepEqual(ok.b.view().suggestions, []);
});

test('owner-blind: a device whose id has a space or is 92 chars long still gets its warning on the panel (E2)', async () => {
  const { GodsEye, cleanCard, dark } = await import('../src/godseye/index.ts');
  // the exact id for an odd device id is decide.ts's cardId; only its shape is asserted here
  for (const id of ['pixel 8', 'w-' + 'a'.repeat(90)]) {
    const d = device();
    d.add();
    const { b } = branch();
    const s = { ...snap([eyeDev(d, trustOf(d, { attest: proof(false, DEBUG) }), { id })]), work: running([id, 'mac']) } as any;
    b.observe(s, null);
    const said = b.view().suggestions!;
    assert.equal(said.length, 1, id);
    assert.ok(said[0].id.startsWith('trust:owner-blind:'), said[0].id);
    assert.ok(cleanCard(said[0]), `the eye keeps the card for ${JSON.stringify(id.slice(0, 12))}`);
    const eye = new GodsEye({ snapshot: () => s, dir: '/nonexistent-p26', makers: { trust: () => ({ id: 'trust', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: said }) }) } as any });
    eye.tick();
    assert.equal(eye.view().cards.filter((c: any) => c.branch === 'trust').length, 1, 'the owner-blind warning reaches the panel');
  }
});

test('a full window of 64 KiB lines: the next answer hashes only its new line, and the verdict is the same (A8)', () => {
  const d = device();
  const pad = 'x'.repeat(64 * 1024 - 200);   // a line as long as the engine lets one be (64 KiB)
  for (let i = 0; i < TRUST_WINDOW; i++) d.add('connect', { pad });
  const { b, events } = branch();
  b.observe(snap([eyeDev(d, trustOf(d))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.match(check(b.view(), 'ledger').text, new RegExp(`${TRUST_WINDOW} lines checked`));
  // one new line: the window slides by one, as the engine keeps it
  d.add('connect', { pad });
  const t = trustOf(d, { lines: d.lines.slice(-TRUST_WINDOW) });
  const t0 = performance.now();
  b.observe(snap([eyeDev(d, t)]) as any, null);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `the second answer took ${ms.toFixed(1)} ms`);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.match(check(b.view(), 'ledger').text, new RegExp(`${TRUST_WINDOW + 1} lines checked`));
  assert.deepEqual(events, []);
  // the next new line, forged: it is checked in full as before, the cache changes nothing
  const lines = d.lines.slice(-TRUST_WINDOW);
  d.add('connect', { pad });
  const forged = d.lines.at(-1)!.replace('"kind":"connect"', '"kind":"pair"');
  b.observe(snap([eyeDev(d, trustOf(d, { lines: [...lines.slice(1), forged] }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'ledger').ok, false);
  assert.match(events.join('\n'), /a signature does not match the device key/);
});

test('the engine asks for a proof once an hour, and keeps only what the check found', async () => {
  const { attestDue, foldAttest, ATTEST_EVERY } = await import('../src/ui/engine.ts');
  assert.equal(attestDue(null, 1), true);
  const look = { ...foldTrust(null, {}, 1), attest: { at: 1_000, ok: false, why: 'unofficial' as const, text: DEBUG } };
  assert.equal(attestDue(look, 1_000 + ATTEST_EVERY - 1), false);
  assert.equal(attestDue(look, 1_000 + ATTEST_EVERY), true);
  assert.equal(attestDue(look, 500), true, 'a clock that went back asks again');
  // the proof is kept across the looks that do not ask for one
  assert.deepEqual(foldTrust(look, { ledger: {} }, 2).attest, look.attest);
  const policy = { signers: [], pkg: 'app.pasaport.android', status: null };
  const ch = 'ab'.repeat(32);
  assert.deepEqual(foldAttest({ id: 'x' }, ch, 5, policy), { at: 5, ok: null, why: 'old', text: 'an older kula: it cannot prove this yet' });
  assert.deepEqual(foldAttest({ id: 'x', attest: null }, ch, 5, policy), { at: 5, ok: null, why: 'computer', text: 'a computer cannot prove this' });
  const no = foldAttest({ attest: { v: 1, error: 'no keystore on this device' } }, ch, 5, policy);
  assert.equal(no.ok, false);
  assert.equal(no.why, 'cannot');
  assert.deepEqual(Object.keys(no), ['at', 'ok', 'why', 'text'], 'no chain kept');
});

// ---- G1 (13.11.2026): a rewritten ledger is never all clear --------------------------------------

/** one /trust answer of device [d], as the worker sends it */
const answer = (d: Dev, lines: string[], found: boolean | null, more = false) => ({
  v: 1, id: d.key.id, key: { alg: d.key.alg, pub: publicKeyDer(d.key.publicKey).toString('base64'), store: 'keystore' }, cert: d.certDer.toString('base64'),
  gate: { v1: false, tls: true, paired: 1 },
  ledger: { count: d.lines.length, head: sha256Hex(d.lines.at(-1) ?? GENESIS), self: 'ok', found, more, lines },
  rejects: { day: {}, last: [] },
});
/** the engine's look as the branch sees it (the snapshot leaves upTo out) */
const eyeTrust = (look: any) => { const { upTo: _u, ...rest } = look; return rest; };
/** one look of the engine at an honest worker: at most TRUST_ROUNDS rounds, each the next
 *  TRUST_LINES after the line asked for (GATE.md: no since, or a since not found, gets the last 200) */
function lookAt(d: Dev, was: any, at: number) {
  let look = was;
  for (let r = 0; r < TRUST_ROUNDS; r++) {
    const since = look?.upTo ?? null;
    const idx = since ? d.lines.findIndex((l) => sha256Hex(l) === since) : -1;
    const start = since && idx >= 0 ? idx + 1 : Math.max(0, d.lines.length - TRUST_LINES);
    const got = d.lines.slice(start, start + TRUST_LINES);
    const more = start + got.length < d.lines.length;
    look = foldTrust(look, answer(d, got, since ? idx >= 0 : null, more), at + r, d.fp);
    if (!more) break;
  }
  return look;
}
const ledgerOf = (b: any) => check(b.view(), 'ledger');

test('G1: a rewritten ledger pushed past the window is bad, with the started-over text', () => {
  const d = device();
  for (let i = 0; i < 3; i++) d.add();
  const { b } = branch();
  let look = foldTrust(null, answer(d, d.lines, null), 100, d.fp);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  // since=<head>, found true, 600 lines of a new chain that does not link to the head
  const forged = { ...device(d.key), certDer: d.certDer, fp: d.fp };   // the same key and certificate, a new chain
  forged.add('pair', { fp: 'f'.repeat(8) });
  for (let i = 0; i < 599; i++) forged.add();
  for (let r = 0; r < 3; r++) look = foldTrust(look, answer(forged, forged.lines.slice(r * 200, r * 200 + 200), true, r < 2), 200 + r, d.fp);
  assert.equal(look.restartedAt, 200, 'the engine saw the broken link');
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(ledgerOf(b).text, /^its ledger started over at .* \(cleared on the device, or rewritten\)$/);
});

test('G1: a fork in the middle of a round, then two more rounds: bad', () => {
  const d = device();
  for (let i = 0; i < 3; i++) d.add();
  const { b } = branch();
  let look = foldTrust(null, answer(d, d.lines, null), 100, d.fp);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  const honest = d.lines.length;
  for (let i = 0; i < 100; i++) d.add();
  const fork = device(d.key);
  fork.add('pair', { fp: 'ab' });
  for (let i = 0; i < 499; i++) fork.add();
  const sent = [...d.lines.slice(honest), ...fork.lines];   // 100 honest lines, then 500 of another chain
  for (let r = 0; r < 3; r++) look = foldTrust(look, answer(d, sent.slice(r * 200, r * 200 + 200), true, r < 2), 200 + r, d.fp);
  assert.equal(look.restartedAt, 200);
  assert.equal(look.lines[0], fork.lines[0], 'the window starts again at the broken link');
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(ledgerOf(b).text, /started over/);
});

test('G1: an honest catch-up of 1440 lines over 4 looks of 2 rounds is ok at every look, with no gap', () => {
  assert.equal(TRUST_ROUNDS, 2);
  const d = device();
  for (let i = 0; i < 3; i++) d.add();
  const { b, events, notes } = branch();
  let look = lookAt(d, null, 100);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  for (let i = 0; i < 1440; i++) d.add();   // a day away: a line a minute
  for (let n = 0; n < 4; n++) {
    look = lookAt(d, look, 1_000 + n * 10);
    assert.equal(look.restartedAt, null);
    b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
    assert.equal(b.view().report!.verdict, 'ok', `look ${n + 1}: ${ledgerOf(b).text}`);
    assert.equal(notes().p1.gap, false);
  }
  assert.equal(notes().p1.verified, 3 + 1440);
  assert.equal(notes().p1.head, sha256Hex(d.lines.at(-1)!));
  assert.deepEqual(events, []);
});

test('G1: a look of 2 rounds keeps the line it joined to in the window (500 before, 400 new)', () => {
  const d = device();
  for (let i = 0; i < 900; i++) d.add();
  const was = { ...foldTrust(null, {}, 1), lines: d.lines.slice(0, 500), upTo: sha256Hex(d.lines[499]) };
  let look: any = was;
  for (let r = 0; r < TRUST_ROUNDS; r++) look = foldTrust(look, answer(d, d.lines.slice(500 + r * 200, 700 + r * 200), true, true), 10 + r);
  assert.equal(look.restartedAt, null);
  assert.equal(look.lines.length, TRUST_WINDOW);
  assert.equal(look.lines[0], d.lines[400]);
  assert.ok(look.lines.includes(d.lines[499]), 'the line the look started after is still in the window');
});

test('G1: after the engine restarts, a window not joined to the head is not checked until the person accepts', () => {
  const d = device();
  for (let i = 0; i < 100; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, eyeTrust(lookAt(d, null, 100)))]) as any, null);
  const head = notes().p1.head;
  assert.equal(notes().p1.verified, 100);
  for (let i = 0; i < 400; i++) d.add();
  // kula-node restarted: no since to ask, the last 200 lines; the head is 300 lines back
  let look = foldTrust(null, answer(d, d.lines.slice(-200), null), 1_000, d.fp);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  const gapText = 'its ledger could not be joined to the 100 lines checked before: lines came while this computer was not looking. accept to carry on from here';
  assert.equal(b.view().report!.verdict, 'unknown');
  assert.deepEqual(ledgerOf(b), { k: 'ledger', ok: null, text: gapText });
  assert.equal(b.view().report!.devices[0].accept, true);
  assert.deepEqual([notes().p1.head, notes().p1.verified], [head, 100]);
  assert.deepEqual(events, ['pixel: its ledger could not be joined to the lines checked before']);
  // the next look: the same, and no second feed line
  d.add();
  look = lookAt(d, look, 2_000);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'unknown');
  assert.equal(ledgerOf(b).text, gapText);
  assert.deepEqual([notes().p1.head, notes().p1.verified], [head, 100]);
  assert.equal(events.length, 1);
  // only the person's tap carries on from here; the next answer is checked from its first line
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(notes().p1.count, 501, 'the count high-water mark stays');
  d.add();
  look = lookAt(d, look, 3_000);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok', ledgerOf(b).text);
  assert.equal(notes().p1.verified, look.lines.length, 'counted from the window');
  assert.equal(b.view().report!.devices[0].accept, false);
});

test('G1: after the engine restarts, a forged last 200 is unknown and never ok without an accept', () => {
  const d = device();
  for (let i = 0; i < 100; i++) d.add();
  const { b } = branch();
  b.observe(snap([eyeDev(d, eyeTrust(lookAt(d, null, 100)))]) as any, null);
  const forged = { ...device(d.key), certDer: d.certDer, fp: d.fp };   // the same key and certificate, a new chain
  forged.add('pair', { fp: 'cd' });
  for (let i = 0; i < 299; i++) forged.add();
  let look = foldTrust(null, answer(forged, forged.lines.slice(-200), null), 1_000, d.fp);
  for (let n = 0; n < 4; n++) {
    b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
    assert.equal(b.view().report!.verdict, 'unknown', `look ${n + 1}`);
    assert.match(ledgerOf(b).text, /could not be joined/);
    forged.add();
    look = lookAt(forged, look, 2_000 + n * 10);
  }
});

test('G1: a window whose first line follows the head is joined: verified grows by the window', () => {
  const d = device();
  for (let i = 0; i < 100; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, eyeTrust(lookAt(d, null, 100)))]) as any, null);
  for (let i = 0; i < 200; i++) d.add();
  const look = foldTrust(null, answer(d, d.lines.slice(-200), null), 1_000, d.fp);
  b.observe(snap([eyeDev(d, eyeTrust(look))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok', ledgerOf(b).text);
  assert.equal(notes().p1.verified, 300);
  assert.equal(notes().p1.gap, false);
  assert.deepEqual(events, []);
});

// ---- G3 (13.11.2026): no proof is said ---------------------------------------------------------

test('G3: a phone running jobs that sends no proof (a computer\'s word, or none) gets the card', () => {
  for (const attest of [null, undefined]) {
    const r = ownerBlind({ attest, challenge: 'c'.repeat(64), id: 'a'.repeat(32), alg: 'ed25519', pub: 'AA==' }, { now: 8_000, signers: [], pkg: 'x', status: null });
    assert.equal(r.ok, null);
    const d = device();
    d.add();
    const { b } = branch();
    b.observe({ ...snap([eyeDev(d, trustOf(d, { attest: { at: 8_000, ok: r.ok, why: r.why, text: r.text } }))]), work: running(['p1', 'mac']) } as any, null);
    const v = b.view();
    assert.equal(check(v, 'owner-blind').ok, false, String(attest));
    assert.equal(v.report!.verdict, 'ok', 'owner-blind stays out of the verdict');
    assert.deepEqual(v.suggestions!.map((c: any) => [c.id, c.title]), [['trust:owner-blind:p1', 'pixel could read the jobs it runs']]);
  }
});

test('G3: a home computer that cannot prove gets no card; a circle computer does; a circle phone that proved does not', () => {
  const d = device();
  d.add();
  const computer = { at: 8_000, ok: null, why: 'computer', text: 'a computer cannot prove this' };
  const cards = (attest: unknown, o: Record<string, unknown>) => {
    const { b } = branch();
    b.observe({ ...snap([eyeDev(d, trustOf(d, { attest }), o)]), work: running(['p1', 'mac']) } as any, null);
    return b.view().suggestions!;
  };
  assert.deepEqual(cards(computer, { kind: 'pc' }), [], 'home (no ring)');
  assert.deepEqual(cards(computer, { kind: 'pc', ring: 'home' }), []);
  assert.deepEqual(cards(computer, { kind: 'pc', ring: 'circle' }), [{
    id: 'trust:owner-blind:p1', kind: 'warn', weight: 1, title: 'pixel has not shown that its owner cannot read the jobs it runs',
    why: 'a computer cannot prove this. Prompts reach it in plain text, so only give it work you would show its owner.',
    action: { do: 'open', panel: 'branch', branch: 'trust' }, label: 'look',
  }]);
  assert.deepEqual(cards(proof(true, 'hardware key, locked, verified boot, official kula build: its owner cannot read jobs'), { ring: 'circle' }), []);
  // a circle computer not running anything: no card
  const { b } = branch();
  b.observe({ ...snap([eyeDev(d, trustOf(d, { attest: computer }), { kind: 'pc', ring: 'circle' })]), work: running(['mac']) } as any, null);
  assert.deepEqual(b.view().suggestions, []);
});

test('G3: a split part that fails gets the card; a part holding no layers does not', () => {
  const d = device();
  d.add();
  const split = (mb: number) => ({ ...running([]), loaded: { ...running([]).loaded, mode: 'split', devices: [], parts: [{ id: 'mac', name: 'mac', local: true, mb: 900, layers: 10 }, { id: 'p1', name: 'pixel', local: false, mb, layers: mb ? 12 : 0 }] } });
  const { b } = branch();
  b.observe({ ...snap([eyeDev(d, trustOf(d, { attest: proof(false, DEBUG) }))]), work: split(1200) } as any, null);
  assert.deepEqual(b.view().suggestions!.map((c: any) => c.id), ['trust:owner-blind:p1']);
  b.observe({ ...snap([eyeDev(d, trustOf(d, { attest: proof(false, DEBUG) }))]), work: split(0) } as any, null);
  assert.deepEqual(b.view().suggestions, []);
});
