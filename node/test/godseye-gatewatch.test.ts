// the gate watch (16.11.2026, P4): this computer's own gate (host.gate, from its own signed ledger)
// in the trust branch. Scanners are counted, not alarmed; a burst of far refusals against the usual
// of that hour of day is a card, never a red check; the rpc guard and 5+ guesses are; a device's own
// rpc guard is a card that never bars it; the anchor's daily cap has a card with a 0.95 hold. A look
// without host.gate makes the same report as before, and the fit (`~gate`) survives a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create } = await import('../src/godseye/branches/trust.ts');
const { classOf, GATE_KEY, BACKSTOP, hoursOf, gateStep, freshGate } = await import('../src/godseye/branches/gatewatch.ts');
const { untrusted } = await import('../src/godseye/branches/decide.ts');
const { nodeKeys } = await import('../src/godseye/node.ts');
const { generate, publicKeyDer } = await import('../src/audit/key.ts');
const { makeLine, GENESIS, sha256Hex } = await import('../src/audit/ledger.ts');
const { selfSigned, newP256 } = await import('../src/tls.ts');

const H = 3_600_000;
const T0 = Math.floor(1.7e12 / H) * H;     // a running hour's start

/** the gate as the feed hands it at the running hour `run`: 26 hours, the last running */
function gateAt(run: number, farOf: (start: number) => number, o: { by?: (start: number) => Record<string, number>; guard?: { t: number; why: string }[]; nets?: number } = {}) {
  const hours = [];
  for (let i = 25; i >= 0; i--) {
    const start = run - i * H;
    const far = farOf(start);
    hours.push({ start, by: o.by ? o.by(start) : far > 0 ? { 'no hello': far } : {}, far });
  }
  return { hours, nets: o.nets ?? 3, guard: o.guard ?? [] };
}
const plainDev = (id = 'p9') => ({ id, name: id, kind: 'phone', via: 'wifi', where: 'x', reachable: true, reachMs: 1, reason: null, checkedAt: 1, lastOk: null, ramMb: 1000, bwGBs: 10, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null });
const snap = (devices: any[], host: Record<string, unknown> = {}, at = 5_000) => ({
  at, host: { name: 'mac', freeMb: 4000, ledger: { ok: true, count: 3, problem: null }, ...host }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
function branch(initial: unknown = {}) {
  let notes: unknown = structuredClone(initial);
  const events: string[] = [];
  const b = create({ now: () => 9_000, load: <T>(f: T) => (structuredClone(notes) as T) ?? f, save: (x: unknown) => { notes = structuredClone(x); }, emit: (t: string) => events.push(t), peek: () => null, keys: nodeKeys });
  return { b, events, notes: () => notes as any };
}
const gateCheckOf = (v: any) => v.report.host.checks.find((c: any) => c.k === 'gate');
const card = (v: any, id: string) => (v.suggestions ?? []).find((c: any) => c.id === id);
const quiet = (start: number) => 2 + ((start / H) % 3);   // 2, 3, 4 scanner knocks an hour

// a real device whose trust answer holds (as in the trust tests)
function device() {
  const key = generate();
  const certDer = selfSigned(newP256(), key.id);
  const lines: string[] = [];
  let prev = GENESIS;
  for (let t = 1_000; t < 1_003; t++) {
    const { line } = makeLine(key, t, 'connect', '192.168.1.5', {}, prev);
    lines.push(line);
    prev = sha256Hex(line);
  }
  return { key, certDer, lines };
}
const trustOf = (d: ReturnType<typeof device>, o: Record<string, unknown> = {}) => ({
  at: 1_000_000_000, error: null, id: d.key.id, alg: d.key.alg, pub: publicKeyDer(d.key.publicKey).toString('base64'), store: 'keystore',
  cert: d.certDer.toString('base64'), certPinned: true, v1: false, paired: 1, self: 'ok', count: d.lines.length,
  head: sha256Hex(d.lines.at(-1)!), lines: [...d.lines], restartedAt: null, rejectsDay: {}, rejectsLast: [], ...o,
});
const eyeDev = (trust: unknown, o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust, ...o,
});

test('the class table: strangers, guesses, the guard, the rest', () => {
  for (const w of ['no hello', 'bad hello', 'tls', 'no tls', 'not paired', 'overloaded', 'bad channel', 'bad nonce', 'no client cert', 'no v1', 'pin expired']) assert.equal(classOf(w), 'stranger', w);
  for (const w of ['wrong pin', 'wrong secret', 'bad proof']) assert.equal(classOf(w), 'guess', w);
  for (const w of ['rpc guard', 'rpc guard: op 12 (set tensor graph)', 'rpc guard: too big']) assert.equal(classOf(w), 'guard', w);
  for (const w of ['replay', 'something new', 'rpc', 'guard']) assert.equal(classOf(w), 'other', w);
});

test('30 quiet days of scanners, then an hour of 60: the burst card, a calm check, the verdict not bad', () => {
  const { b, events } = branch();
  const start = T0 - 30 * 24 * H;
  for (let run = start; run < T0; run += H) b.observe(snap([plainDev()], { gate: gateAt(run, quiet) }) as any, null);
  let v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined, 'quiet days: no card');
  const calm = gateCheckOf(v);
  assert.equal(calm.ok, true);
  assert.match(calm.text, /^its gate refused \d+ strangers today \(no hello ×\d+\) from about 3 networks: scanners find every open port; none got in$/);
  assert.equal(events.length, 0, 'scanners make no feed line');

  // the running hour holds 60 far refusals
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  const c = card(v, 'trust:gate-burst');
  assert.ok(c, 'the burst card shows');
  assert.equal(c.weight, 2);
  assert.equal(c.title, "more knocking on this computer's gate than usual");
  assert.match(c.why, /^60 knocks from outside the lan in the last hour, usually about [23]\.\d at this hour of day; all refused\. scanners knock on every open port; none got in\.$/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.equal(gateCheckOf(v).ok, true, 'the check stays calm');
  assert.notEqual(v.report.verdict, 'bad');
  assert.equal(events.length, 1, 'one feed line when the card comes');
  assert.match(events[0], /^more knocking on this computer's gate than usual: 60 /);

  // the hour finishes: the card stays (the last finished hour was a burst), no new line
  b.observe(snap([plainDev()], { gate: gateAt(T0 + H, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  assert.match(card(v, 'trust:gate-burst').why, /^60 knocks from outside the lan in the last finished hour, usually about [23]\.\d at that hour of day/);
  assert.equal(events.length, 1);
  // a quiet hour finishes: gone, one line
  b.observe(snap([plainDev()], { gate: gateAt(T0 + 2 * H, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined);
  assert.deepEqual(events.slice(1), ["the knocking on this computer's gate is back to its usual"]);
});

test('while learning: no burst card, except the backstop of 1000 in the running hour', () => {
  const { b } = branch();
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 60 : 0)) }) as any, null);
  let v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined, 'learning: 60 is no card');
  assert.match(gateCheckOf(v).text, /\(still learning what is usual: 25 of 24 hours\)|\(still learning what is usual at this hour of day\)/);
  const fresh = branch();
  fresh.b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 3 : 0)) }) as any, null);
  // 25 finished hours taken in at once; this hour of day has one hour of weight: still learning
  assert.match(gateCheckOf(fresh.b.view()).text, /still learning what is usual at this hour of day/);

  const one = branch();
  one.b.observe(snap([plainDev()], { gate: { hours: [{ start: T0, by: { 'no hello': 5 }, far: 5 }], nets: 1, guard: [] } }) as any, null);
  assert.match(gateCheckOf(one.b.view()).text, /\(still learning what is usual: 0 of 24 hours\)$/);

  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? BACKSTOP - 1 : 0)) }) as any, null);
  assert.equal(card(b.view(), 'trust:gate-burst'), undefined, '999: no card yet');
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? BACKSTOP : 0)) }) as any, null);
  v = b.view() as any;
  const c = card(v, 'trust:gate-burst');
  assert.ok(c, 'the backstop shows while learning');
  assert.match(c.why, /^1000 knocks from outside the lan in the last hour, still learning what is usual; all refused\./);
  assert.equal(gateCheckOf(v).ok, true, 'still a calm check');
});

test('the rpc guard: the card at once, the check red, one feed line, gone after 26 hours', () => {
  const { b, events } = branch();
  const g = T0 - 3 * H;                      // the hour the guard cut something
  const why = 'rpc guard: op 12 (set tensor graph)';
  const look = (run: number) => b.observe(snap([plainDev()], {
    gate: gateAt(run, quiet, { by: (s) => (s === g ? { 'no hello': quiet(s), [why]: 1 } : { 'no hello': quiet(s) }), guard: [{ t: g + 600_000, why }] }),
  }) as any, null);
  look(T0);
  let v = b.view() as any;
  const c = card(v, 'trust:gate-guard');
  assert.ok(c);
  assert.equal(c.weight, 3);
  assert.equal(c.title, "this computer's gate cut a split connection (rpc guard)");
  assert.match(c.why, /^1 time in the last 26 hours, the last: rpc guard: op 12 \(set tensor graph\)\. a paired device sent a command that can carry code; it was dropped before llama\.cpp saw it\. kula versions that differ can do this by accident\.$/);
  const chk = gateCheckOf(v);
  assert.equal(chk.ok, false);
  assert.match(chk.text, /rpc guard ×1 in the last 26 hours\): rpc guard: op 12/);
  assert.equal(v.report.verdict, 'bad', 'the cluster verdict says look');
  assert.match(v.report.headline, /^this computer: its gate cut a split connection/);
  assert.equal(v.report.devices[0].verdict, 'unknown', 'no device turns');
  assert.equal(events.length, 1);
  assert.match(events[0], /^this computer's gate cut a split connection \(rpc guard\): rpc guard: op 12/);
  // it stays while the 26 hours hold it, without a new line
  let run = T0;
  for (; run - 25 * H <= g; run += H) {
    look(run);
    assert.ok(card(b.view(), 'trust:gate-guard'), `still held at ${(run - T0) / H} h`);
  }
  assert.equal(events.length, 1, 'one feed line while it stays');
  look(run);                                  // the guard hour has left the window (its line is still listed)
  v = b.view() as any;
  assert.equal(card(v, 'trust:gate-guard'), undefined, 'gone after 26 hours');
  assert.equal(gateCheckOf(v).ok, true);
  assert.notEqual(v.report.verdict, 'bad');
  assert.deepEqual(events.slice(1), ["this computer's gate: no rpc guard refusal left in the last 26 hours"]);
});

test('five wrong codes in the day: the check red and the guess card; four are calm', () => {
  const { b } = branch();
  const four = (s: number) => (s === T0 - 2 * H ? { 'wrong pin': 4, 'no hello': 1 } : {});
  b.observe(snap([plainDev()], { gate: gateAt(T0, () => 1, { by: four }) }) as any, null);
  let v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, true);
  assert.match(gateCheckOf(v).text, /; 4 wrong codes \(wrong pin ×4\)/);
  assert.equal(card(v, 'trust:gate-guess'), undefined);
  const five = (s: number) => (s === T0 - 2 * H ? { 'wrong pin': 3, 'bad proof': 2 } : {});
  b.observe(snap([plainDev()], { gate: gateAt(T0, () => 1, { by: five }) }) as any, null);
  v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, false);
  assert.equal(gateCheckOf(v).text, '5 wrong codes today: someone may be guessing. all were refused');
  const c = card(v, 'trust:gate-guess');
  assert.ok(c);
  assert.equal(c.weight, 3);
  assert.match(c.why, /^5 wrong codes in the last 24 hours \(wrong pin ×3, bad proof ×2\); all were refused\.$/);
});

test("a device's own rpc guard: the card, its verdict unchanged, absent from untrusted()", () => {
  const d = device();
  const why = 'rpc guard: op 12 (set tensor graph)';
  const plain = branch();
  plain.b.observe(snap([eyeDev(trustOf(d, { rejectsDay: { 'no hello': 2 } }))]) as any, null);
  const was = (plain.b.view() as any).report.devices[0].verdict;
  const { b, events } = branch();
  b.observe(snap([eyeDev(trustOf(d, { rejectsDay: { 'no hello': 2, [why]: 2 }, rejectsLast: [{ t: 1_000_000, why, peer: '192.168.1.9' }] }))]) as any, null);
  const v = b.view() as any;
  const c = card(v, 'trust:rpc-guard:p1');
  assert.ok(c, 'the card');
  assert.equal(c.weight, 3);
  assert.equal(c.title, "pixel's gate cut a split connection (rpc guard)");
  assert.match(c.why, /^2 times today, the last: rpc guard: op 12 \(set tensor graph\)\. a paired device sent a command that can carry code; it was dropped before llama\.cpp saw it\. kula versions that differ can do this by accident\. it defended itself: its verdict does not change\.$/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.equal(v.report.devices[0].verdict, was, 'its verdict does not change');
  assert.notEqual(v.report.devices[0].verdict, 'bad');
  assert.equal(untrusted({ peek: () => v }).has('p1'), false, 'it is not barred');
  assert.equal(events.filter((e) => e.includes('rpc guard')).length, 1, 'one feed line');
  assert.equal(gateCheckOf(v), undefined, 'no host.gate: no host check');
});

test('the anchor past its daily cap: on at 1.01, held at 0.96, gone at 0.9; 0.96 alone is nothing', () => {
  const cap = 2e9;
  const anchor = (x: number) => ({ anchor: { on: true, reachable: true, links: 2, bytesDay: x * cap, capDay: cap } });
  const { b, events } = branch();
  b.observe(snap([plainDev()], anchor(1.01)) as any, null);
  let c = card(b.view(), 'trust:anchor-cap');
  assert.ok(c);
  assert.equal(c.weight, 2);
  assert.equal(c.title, 'this anchor carried more than its daily limit');
  assert.equal(c.why, '2.02 of 2.00 GB in the last day, ciphertext only. nothing was switched off.');
  b.observe(snap([plainDev()], anchor(0.96)) as any, null);
  c = card(b.view(), 'trust:anchor-cap');
  assert.ok(c, 'held above 0.95');
  assert.equal(c.why, '1.92 of 2.00 GB in the last day, ciphertext only. nothing was switched off.');
  b.observe(snap([plainDev()], anchor(0.9)) as any, null);
  assert.equal(card(b.view(), 'trust:anchor-cap'), undefined, 'gone under 0.95');
  assert.deepEqual(events, ['this anchor carried more than its daily limit: 2.02 of 2.00 GB in the last day', 'this anchor is back under its daily limit']);
  const other = branch();
  other.b.observe(snap([plainDev()], anchor(0.96)) as any, null);
  assert.equal(card(other.b.view(), 'trust:anchor-cap'), undefined, '0.96 from below: no card');
  other.b.observe(snap([plainDev()], { anchor: { on: true, reachable: null, links: 0, bytesDay: 5 * cap, capDay: null } }) as any, null);
  assert.equal(card(other.b.view(), 'trust:anchor-cap'), undefined, 'no cap: no card');
  // the report is not touched by the anchor
  assert.equal(gateCheckOf(other.b.view()), undefined);
});

test('no host.gate: the report is the same as before, no notes key, no card', () => {
  const { b, notes } = branch();
  b.observe(snap([]) as any, null);
  assert.deepStrictEqual((b.view() as any).report, {
    verdict: 'unknown', headline: 'no devices to check yet', at: 5_000,
    host: { name: 'mac', checks: [{ k: 'ledger', ok: true, text: 'its own ledger: 3 lines, the chain and every signature hold' }] }, devices: [],
  });
  assert.deepStrictEqual(b.view(), { built: true, stat: 'nothing to check', gauge: null, rows: [], lines: [], report: (b.view() as any).report });
  b.observe(snap([plainDev()], { gate: null }) as any, null);
  const v = b.view() as any;
  assert.deepStrictEqual(v.report.host.checks.map((c: any) => c.k), ['ledger']);
  assert.deepStrictEqual(v.suggestions, []);
  assert.equal(GATE_KEY in notes(), false, 'nothing kept for the gate');
  // the same look with and without a gate: only the gate check differs
  const two = branch();
  two.b.observe(snap([plainDev()], { gate: gateAt(T0, quiet) }) as any, null);
  const w = two.b.view() as any;
  assert.deepStrictEqual({ ...w.report, host: { ...w.report.host, checks: w.report.host.checks.filter((c: any) => c.k !== 'gate') } }, v.report);
});

test('`~gate` survives a reload: the fit comes back, and no hour is taken in twice', () => {
  const one = branch();
  for (let run = T0 - 40 * H; run <= T0; run += H) one.b.observe(snap([plainDev()], { gate: gateAt(run, quiet) }) as any, null);
  const kept = one.notes()[GATE_KEY];
  assert.ok(kept, 'kept under ~gate');
  assert.equal(kept.at, T0 - H, 'the newest finished hour taken in');
  assert.equal(kept.burst.n, 25 + 40, 'every finished hour once');
  const json = JSON.parse(JSON.stringify(one.notes()));
  const two = branch(json);
  two.b.observe(snap([plainDev()], { gate: gateAt(T0, quiet) }) as any, null);
  assert.deepStrictEqual(two.notes()[GATE_KEY], kept, 'the same look teaches nothing again');
  assert.equal(gateCheckOf(two.b.view()).text, gateCheckOf(one.b.view()).text, 'the same check after the reload');
  two.b.observe(snap([plainDev()], { gate: gateAt(T0 + H, quiet) }) as any, null);
  assert.equal(two.notes()[GATE_KEY].burst.n, kept.burst.n + 1, 'the next hour is taken in once');
  // a device with the reserved id is a device like a bad id: nothing of it is kept under ~gate
  two.b.observe(snap([{ ...plainDev(GATE_KEY), trust: { at: 5, error: null, rejectsDay: { 'no hello': 9 } } }], { gate: gateAt(T0 + H, quiet) }) as any, null);
  assert.equal(two.notes()[GATE_KEY].burst.n, kept.burst.n + 1);
  assert.equal(two.notes()[GATE_KEY].rejTotal, 0);
});

test('gateStep alone: hours taken in once, a clock gone back re-anchors, a hostile gate is none', () => {
  const hours = hoursOf(gateAt(T0, quiet));
  assert.equal(hours.length, 26);
  const a = gateStep(freshGate(), hours);
  assert.equal(a.changed, true);
  assert.equal(a.st.fit.n, 25);
  const again = gateStep(a.st, hours);
  assert.equal(again.changed, false);
  assert.equal(again.st, a.st);
  const back = gateStep({ ...a.st, at: T0 + 100 * H }, hours);
  assert.equal(back.changed, true);
  assert.equal(back.st.at, T0 - H);
  assert.equal(back.st.fit.n, 25, 'nothing taken in');
  for (const bad of [null, 1, 'x', [], { hours: 'x' }, { hours: [null, { start: 'x' }, { start: -1 }, { start: NaN }] }]) assert.deepEqual(hoursOf(bad), []);
  const odd = hoursOf({ hours: [{ start: T0, by: { 'no hello': 2.9, x: -1, y: 'z' }, far: 1e20 }, { start: T0 - H, by: null, far: -4 }] });
  assert.deepEqual(odd, [{ start: T0 - H, by: [], far: 0 }, { start: T0, by: [['no hello', 2]], far: 1e9 }]);
});
