// god's eye, branch 8 (10.11.2026): the two newer checks — a ledger that got shorter, and a burst
// of refusals against the device's own usual rate — and their armour: a hostile snapshot, a far-
// forward clock and odd device ids must not throw, poison the notes or reach the view. Real keys
// and real signed lines, as in the trust test; the burst windows run on the answer's own clock,
// driven here hour by hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, poissonTail, medianOf } = await import('../src/godseye/branches/trust.ts');
const { nodeKeys, nodeKey } = await import('../src/godseye/node.ts');   // the computer's signatures (platform.ts)
const { hhmm } = await import('../src/godseye/branches/util.ts');
const { generate, publicKeyDer } = await import('../src/audit/key.ts');
const { makeLine, GENESIS, sha256Hex } = await import('../src/audit/ledger.ts');
const { selfSigned, newP256, fingerprint } = await import('../src/tls.ts');
const { burstStep, freshBurst } = await import('../src/godseye/branches/burst.ts');

const H = 3_600_000;
// L10 P55: an hour is held against the same hour of day (burst.ts). t0 = 1e9 is hour of day 14, and
// 72 quiet hours (not 24) hit every hour of day three times, so the usual is known everywhere
const hod = (start: number) => Math.floor((start + H / 2) / H) % 24;

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

const trustOf = (d: Dev, o: Record<string, unknown> = {}) => ({
  at: 1_000_000_000, error: null, id: d.key.id, alg: d.key.alg, pub: publicKeyDer(d.key.publicKey).toString('base64'), store: 'keystore',
  cert: d.certDer.toString('base64'), certPinned: true, v1: false, paired: 1, self: 'ok', count: d.lines.length,
  head: d.lines.length ? sha256Hex(d.lines.at(-1)!) : GENESIS, lines: [...d.lines], restartedAt: null,
  rejectsDay: {}, rejectsLast: [], ...o,
});
const eyeDev = (d: Dev, trust: unknown, o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null,
  trust, ...o,
});
// a plain device without a trust answer (for the cap tests)
const mkDev = (id: string) => ({ id, name: id, kind: 'phone', via: 'wifi', where: 'x', reachable: true, reachMs: 1, reason: null, checkedAt: 1, lastOk: null, ramMb: 1000, bwGBs: 10, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null });
const snap = (devices: any[]) => ({
  at: 5_000, host: { name: 'mac', freeMb: 4000, ledger: { ok: true, count: 3, problem: null } }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
function branch(initial: unknown = {}) {
  let notes: unknown = structuredClone(initial);
  const events: string[] = [];
  const b = create({ now: () => 9_000, load: <T>(f: T) => (structuredClone(notes) as T) ?? f, save: (x: unknown) => { notes = structuredClone(x); }, emit: (t: string) => events.push(t), peek: () => null, keys: nodeKeys });
  return { b, events, notes: () => notes as any };
}
const check = (v: any, k: string, dev = 0) => v.report.devices[dev].checks.find((c: any) => c.k === k);

// one quiet answer at the end of each hour, after the first one (which only remembers)
const hourByHour = (b: any, d: Dev, t0: number, hours: number) => {
  for (let i = 1; i <= hours; i++) b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + i * H }))]) as any, null);
};

test('poissonTail and medianOf, against values worked out by hand', () => {
  const e = Math.exp(-0.5);
  // 1 - e^-0.5 * (1 + 0.5 + 0.125)
  assert.ok(Math.abs(poissonTail(3, 0.5) - (1 - e * (1 + 0.5 + 0.125))) < 1e-12);
  // 1 - e^-0.5 * (1 + 0.5 + 0.125 + 1/48 + 1/384 + 1/3840)
  assert.ok(Math.abs(poissonTail(6, 0.5) - (1 - e * (1 + 0.5 + 0.125 + 1 / 48 + 1 / 384 + 1 / 3840))) < 1e-12);
  assert.ok(Math.abs(poissonTail(3, 0.5) - 0.01439) < 1e-4);
  assert.ok(Math.abs(poissonTail(6, 0.5) - 0.0000142) < 1e-6);
  assert.equal(poissonTail(0, 0.5), 1, 'at least 0 refusals is always sure');
  assert.equal(poissonTail(2, 0.5), 1 - e * 1.5);
  assert.ok(Number.isFinite(poissonTail(900, 750)) && poissonTail(900, 750) >= 0 && poissonTail(900, 750) <= 1, 'a lambda past 710 stays in range');
  assert.ok(Math.abs(poissonTail(150, 100) - 1.88e-6) < 0.2e-6, 'the far tail at lambda 100');
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 4, 2, 3]), 2.5);
  assert.equal(medianOf([7]), 7);
});

test('a ledger that got shorter: red with the shorter text, one feed line, kept until accepted', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(notes().p1.count, 40);
  // the same chain reported 35 lines long: lines were removed on the device. (P43: this used a new
  // 35-line chain with no restart flag; its first line no longer joins the head, so it is now a gap,
  // "could not be joined", not checked. The count alone carries the shorter fault, as before.)
  const shortOf = (at: number) => trustOf(d, { at, count: 35 });
  b.observe(snap([eyeDev(d, shortOf(2_000_000))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 35 now (lines were removed)');
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 1, 'one feed line, not one per look');
  assert.equal(events[0], 'pixel: its ledger got shorter: 40 lines before, 35 now (lines were removed)');
  // it stays red on the next look, without another line
  b.observe(snap([eyeDev(d, shortOf(3_000_000))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 1);
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(notes().p1.count, 35, 'after accepting, the smaller count is the baseline');
  assert.equal(notes().p1.fault, null);
});

test('a shorter ledger with a new restartedAt: only the started-over fault, the count follows without a second one', () => {
  const d = device();
  d.add(); d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.count, 2);
  const cleared = device(d.key);
  cleared.add();   // the ledger was cleared on the phone: one new line, restartedAt set
  b.observe(snap([eyeDev(cleared, trustOf(cleared, { at: 2_000_000, restartedAt: 1_500_000 }))]) as any, null);
  const v = b.view();
  assert.equal(v.report!.verdict, 'bad');
  assert.match(check(v, 'ledger').text, /started over/);
  assert.ok(!events.some((e) => /got shorter/.test(e)), 'no second fault for the restart');
  assert.equal(notes().p1.count, 1);
});

test('a restart flag alone never lowers the remembered count: a shorter ledger still faults', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.count, 40);
  // the device claims a restart and five lines, but the lines still hold the verified head:
  // its own word never clears a mark the branch remembered
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: 5, restartedAt: 1_500_000 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 5 now (lines were removed)');
  assert.equal(events[0], 'pixel: its ledger got shorter: 40 lines before, 5 now (lines were removed)');
});

test('a restart with an unusable key is not consumed: the next answer that can be checked raises it', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  const fresh = device(d.key);
  for (let i = 0; i < 45; i++) fresh.add('connect', { n: i });   // a chain the old head is not in
  // the rewritten ledger arrives with the restart flag but no usable key: nothing is consumed
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 2_000_000, restartedAt: 1_500_000, pub: null }))]) as any, null);
  assert.equal(notes().p1.restartSeen, null, 'an unusable key consumes nothing');
  assert.equal(b.view().report!.verdict, 'unknown', 'this look cannot be checked');
  // the next answer can be checked: the started-over fault is raised, with its feed line
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 3_000_000, restartedAt: 1_500_000 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(check(b.view(), 'ledger').text, /started over/);
  assert.equal(events.filter((e) => /started over/.test(e)).length, 1, 'one feed line for the restart');
  assert.ok(/started over/.test(events[0]));
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.match(check(b.view(), 'ledger').text, /45 lines checked/, 'the new chain, not 85 lines');
});

test('the shorter fault is raised once and keeps the numbers from the moment it was raised', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: 31 }))]) as any, null);
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 1);
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 31 now (lines were removed)');
  // the device keeps writing lines while the fault waits: no new feed line, the text stays
  b.observe(snap([eyeDev(d, trustOf(d, { at: 3_000_000, count: 32 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: 4_000_000, count: 33 }))]) as any, null);
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 1);
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 31 now (lines were removed)');
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(notes().p1.count, 31, 'the accepted count is the one in the text');
});

test('an unaccepted line fault is kept: the shorter fault waits until it is accepted', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  // a dropped line and a smaller count arrive together: the line fault wins and is kept. (P43: the
  // dropped line was the second of a window without the head, now a gap that checks nothing; it is
  // the line after the head here, so the window still joins and the dropped line is caught.)
  d.add(); d.add();
  const dropped = [...d.lines.slice(0, 40), d.lines[41]];
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: 35, lines: dropped }))]) as any, null);
  assert.match(check(b.view(), 'ledger').text, /chain is broken/);
  assert.ok(!events.some((e) => /got shorter/.test(e)));
  b.observe(snap([eyeDev(d, trustOf(d, { at: 3_000_000, count: 35, lines: dropped }))]) as any, null);
  assert.match(check(b.view(), 'ledger').text, /chain is broken/);
  // after the person accepts the line fault, the next smaller count raises the shorter fault
  assert.equal(b.act!('accept', 'p1'), 'noted');
  b.observe(snap([eyeDev(d, trustOf(d, { at: 4_000_000, count: 35 }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 35 now (lines were removed)');
});

test('an absurd count is ignored rather than remembered: the remembered count stays a high-water mark', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.count, 40);
  for (const bad of [1e300, NaN, -5, '40']) {
    b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: bad as any }))]) as any, null);
  }
  assert.equal(notes().p1.count, 40);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.ok(!events.some((e) => /got shorter/.test(e)));
});

test('72 quiet hours (three of each hour of day) then 6 refusals in one hour: a burst, told against the device\'s own usual', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);   // the first answer only remembers
  hourByHour(b, d, t0, 72);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(notes().p1.burst.n, 72);
  // six refusals land in the next hour; the list keeps only the last three, the day's total says six
  const last3 = [1, 2, 3].map((t) => ({ t, why: 'not paired', peer: '192.168.1.77' }));
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, rejectsDay: { 'not paired': 6 }, rejectsLast: last3 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  assert.equal(events.filter((e) => /6 refusals in the last hour/.test(e)).length, 1, 'one feed line when the burst starts');
  assert.equal(events[0], 'pixel: 6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  // the next answer closes the burst hour: it is learned only as burst.ts learns a flagged hour, the
  // fit after it is the step from the 72 quiet hours, nothing more
  const before = structuredClone(notes().p1.burst);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 73 * H + 1000 }))]) as any, null);
  assert.deepEqual(notes().p1.burst, burstStep(before, hod(t0 + 72 * H), 6).fit);
  assert.equal(notes().p1.win.k, 0);
});

test('the same six refusals with only 10 finished hours: no burst, still learning', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 10);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 10 * H + 1000, rejectsDay: { 'not paired': 6 }, rejectsLast: [{ t: 1, why: 'not paired', peer: '192.168.1.77' }] }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(check(b.view(), 'refused').ok, true);
  assert.equal(check(b.view(), 'refused').text, 'refused today: not paired \u{00D7}6 (still learning what is usual: 10 of 24 hours)');
});

test('the same six refusals after 30 finished hours: not red, this hour of day is still being learned', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 30);
  // 30 hours are past the 24 needed, but this hour of day (20) was seen once: it is not judged yet
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 30 * H + 1000, rejectsDay: { 'not paired': 6 }, rejectsLast: [{ t: 1, why: 'not paired', peer: '192.168.1.77' }] }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(check(b.view(), 'refused').ok, true);
  assert.equal(check(b.view(), 'refused').text, 'refused today: not paired \u{00D7}6 (still learning what is usual at this hour of day)');
});

test('two refusals in an hour are never a burst', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, rejectsDay: { 'not paired': 2 }, rejectsLast: [{ t: 1, why: 'not paired', peer: 'x' }] }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.match(check(b.view(), 'refused').text, /not paired ×2/);
});

test('a reason past the day cap is capped, never dropped: 20000 wrong pins is still red', () => {
  const d = device();
  d.add();
  const { b, events } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 1000, rejectsDay: { 'wrong pin': 20000 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, '10000 wrong codes today: someone may be guessing. all were refused');
  assert.equal(events.filter((e) => /wrong codes today/.test(e)).length, 1);
});

test('10001 replays is red with the replay text', () => {
  const d = device();
  d.add();
  const { b, events } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 1000, rejectsDay: { replay: 10001 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, 'someone replayed a recorded handshake (10000 times today); it was refused');
  assert.equal(events.filter((e) => /replayed a recorded handshake/.test(e)).length, 1);
});

test('a busy reason ageing past the cap raises no burst: it was capped, not dropped', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  const t0 = 1_000_000_000;
  // the device's usual is huge: the first answer only remembers it (capped)
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0, rejectsDay: { 'not paired': 10400 } }))]) as any, null);
  for (let i = 1; i <= 72; i++) b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + i * H, rejectsDay: { 'not paired': 10400 } }))]) as any, null);
  // the day ages 10 400 -> 9 990 -> 9 900: none of that is new refusals
  for (const [i, n] of [[1, 9990], [2, 9900]] as const) {
    b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + i * 1000, rejectsDay: { 'not paired': n } }))]) as any, null);
    assert.equal(b.view().report!.verdict, 'ok', String(n));
  }
  assert.equal(notes().p1.win.k, 0);
  assert.equal(events.filter((e) => /refusals in the last hour/.test(e)).length, 0);
});

test('a busy device is learned while learning: 15 an hour builds the baseline, 60 in an hour is a burst', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  for (let i = 1; i <= 73; i++) {
    b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + i * H, rejectsDay: { 'not paired': 15 * i } }))]) as any, null);
    assert.equal(b.view().report!.verdict, 'ok');
  }
  // the first finished hour counts the first answer, which only remembered: a zero, then 15s
  let fold = freshBurst();
  for (let i = 0; i < 73; i++) fold = burstStep(fold, hod(t0 + i * H), i === 0 ? 0 : 15).fit;
  assert.deepEqual(notes().p1.burst, fold);
  // one heavy hour: a burst against the learned 15 an hour at that hour of day
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 74 * H, rejectsDay: { 'not paired': 15 * 73 + 60 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  const f = notes().p1.burst;
  const h = hod(t0 + 74 * H);
  assert.equal(check(b.view(), 'refused').text, `60 refusals in the last hour, at this hour of day it usually sees about ${(f.a[h] / f.b[h]).toFixed(1)}: unusual. all were refused`);
});

test('a burst and a shorter ledger in the same look: both reach the feed', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  // one answer: the count shrank AND six refusals burst into the hour
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, count: 35, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 35 now (lines were removed)');
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  assert.ok(events.includes('pixel: its ledger got shorter: 40 lines before, 35 now (lines were removed)'));
  assert.ok(events.includes('pixel: 6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused'));
});

test('a restart whose new chain also faults: the started-over fault is kept until accepted, then the line fault', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  // the ledger was rewritten with a new chain whose second line is missing: both conditions at once
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  const broken = [fresh.lines[0], fresh.lines[2]];
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 2_000_000, restartedAt: 1_500_000, lines: broken, count: 5 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(check(b.view(), 'ledger').text, /started over/);
  assert.equal(events.filter((e) => /started over/.test(e)).length, 1, 'one feed line for the restart');
  assert.equal(events.filter((e) => /chain is broken/.test(e)).length, 0, 'the line fault waits');
  // still the started-over fault on the next look, never an ok in between
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 3_000_000, restartedAt: 1_500_000, lines: broken, count: 5 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(check(b.view(), 'ledger').text, /started over/);
  // accepting the restart brings the line fault forward, with its own feed line
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(check(b.view(), 'ledger').text, /chain is broken/);
  assert.equal(events.filter((e) => /chain is broken/.test(e)).length, 1);
  // and accepting the line fault clears it
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'ok');
  assert.ok(!check(b.view(), 'ledger').text.includes('0 lines checked'));
});

test('count and the hour counts are whole numbers: 40.7 lines is 40, never a fraction', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000, count: 40.7 }))]) as any, null);
  assert.equal(notes().p1.count, 40, 'the count is floored');
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: 40.7, rejectsDay: { 'not paired': 2.9 } }))]) as any, null);
  assert.equal(notes().p1.win.k, 2, 'the hour count is floored');
  assert.ok(!JSON.stringify(b.view()).includes('40.7'));
  assert.ok(!JSON.stringify(b.view()).includes('2.9'));
});

test('the numbers shown are capped: K at 9999, one answer counts at most 10000', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  // two reasons at the day's cap each: 20000 refusals in one answer, 10000 counted into the hour
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, rejectsDay: { 'not paired': 10000, odd: 10000 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, '9999 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  assert.doesNotMatch(JSON.stringify(b.view()), /e\+\d/, 'no exponent notation in the view');
});

test('the answer clock jumping backwards or far forward: no throw, no invented hours', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 1000, rejectsDay: { 'not paired': 1 } }))]) as any, null);
  assert.doesNotThrow(() => b.observe(snap([eyeDev(d, trustOf(d, { at: t0 - 5000, rejectsDay: { 'not paired': 2 } }))]) as any, null));
  assert.equal(notes().p1.win.k, 2, 'a backwards answer still lands in the running hour');
  assert.deepEqual(notes().p1.burst, freshBurst());
  // ten hours forward: a gap in the looks re-anchors the window, nothing is counted or invented
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 10 * H, rejectsDay: { 'not paired': 2 } }))]) as any, null);
  assert.deepEqual(notes().p1.burst, freshBurst());
  assert.equal(notes().p1.win.start, t0 + 10 * H);
  assert.equal(notes().p1.win.k, 0);
  // the hour after the jump closes normally again: one quiet hour learned
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 11 * H, rejectsDay: { 'not paired': 3 } }))]) as any, null);
  assert.deepEqual(notes().p1.burst, burstStep(freshBurst(), hod(t0 + 10 * H), 0).fit);
  assert.equal(notes().p1.burst.n, 1);
  assert.equal(notes().p1.win.k, 1);
});

test('a far-forward answer clock then normal answers: the window re-anchors, bursts are still judged, also after a restart', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  const far = t0 + 72 * H + 5 * 365 * 24 * H + 1000;   // five years ahead, still a sane time
  b.observe(snap([eyeDev(d, trustOf(d, { at: far, rejectsDay: { 'not paired': 1 } }))]) as any, null);
  // back on the normal clock: the running hour re-anchors
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 2000, rejectsDay: { 'not paired': 1 } }))]) as any, null);
  assert.equal(notes().p1.win.start, t0 + 72 * H + 2000);
  // six refusals in the re-anchored hour: judged as a burst on the learned quiet hours
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 3000, rejectsDay: { 'not paired': 7 }, rejectsLast: [{ t: 1, why: 'odd', peer: 'x' }] }))]) as any, null);
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  // and after a restart: the same re-anchor works from the saved notes
  const r2 = branch(notes());
  const far2 = t0 + 72 * H + 10 * 365 * 24 * H + 1000;
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: far2, rejectsDay: { 'not paired': 8 } }))]) as any, null);
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 4000, rejectsDay: { 'not paired': 9 } }))]) as any, null);
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 5000, rejectsDay: { 'not paired': 15 } }))]) as any, null);
  assert.equal(check(r2.b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
});

test('refusals spread over a night away are not a burst: the gap re-anchors and counts nothing', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 73);
  // the computer slept for 10 hours; five refusals spread over those hours arrive with the next answer
  const after = t0 + 73 * H + 10 * H;
  b.observe(snap([eyeDev(d, trustOf(d, { at: after, rejectsDay: { 'not paired': 5 }, rejectsLast: [1, 2, 3, 4, 5].map((n) => ({ t: t0 + 73 * H + n * H, why: 'not paired', peer: 'x' })) }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(events.filter((e) => /refusals in the last hour/.test(e)).length, 0, 'no feed line');
  assert.equal(notes().p1.win.k, 0, 'nothing counted into any hour');
  // a real burst in the hour right after is still caught
  b.observe(snap([eyeDev(d, trustOf(d, { at: after + 1000, rejectsDay: { 'not paired': 11 } }))]) as any, null);
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
});

test('a one-week absence with refusals spread over it is not a burst either', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  const after = t0 + 72 * H + 7 * 24 * H;
  const spread = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ t: t0 + 72 * H + n * 24 * H, why: 'not paired', peer: 'x' }));
  b.observe(snap([eyeDev(d, trustOf(d, { at: after, rejectsDay: { 'not paired': 9 }, rejectsLast: spread }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(events.filter((e) => /refusals in the last hour/.test(e)).length, 0);
  assert.equal(notes().p1.win.k, 0);
  b.observe(snap([eyeDev(d, trustOf(d, { at: after + 1000, rejectsDay: { 'not paired': 15 } }))]) as any, null);
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
});

test('a device that stops reporting its ledger length: a note, the remembered count stays', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.count, 40);
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: null }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').ok, null);
  assert.equal(check(b.view(), 'ledger').text, 'it stopped reporting its ledger length (40 lines before)');
  assert.equal(notes().p1.count, 40);
  // it reports again: the note clears, the count is still remembered
  b.observe(snap([eyeDev(d, trustOf(d, { at: 3_000_000, count: 40 }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').ok, true);
  assert.equal(notes().p1.count, 40);
});

test('a far-forward refusal time does not silence later refusals: rejAt re-anchors, 1e300 is ignored', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0, rejectsDay: { 'not paired': 1 }, rejectsLast: [{ t: 100, why: 'odd', peer: 'x' }] }))]) as any, null);
  // the device's refusal clock jumps years ahead
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 1000, rejectsDay: { 'not paired': 2 }, rejectsLast: [{ t: 1.6e11, why: 'odd', peer: 'x' }] }))]) as any, null);
  // back again: the newest watermark re-anchors and the new refusals still count
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 2000, rejectsDay: { 'not paired': 4 }, rejectsLast: [{ t: 5000, why: 'odd', peer: 'x' }, { t: 5001, why: 'odd', peer: 'x' }] }))]) as any, null);
  assert.equal(notes().p1.win.k, 3, 'the refusals after the jump are not silenced');
  assert.equal(notes().p1.rejAt, 5001, 'the watermark re-anchored');
  // an absurd refusal time is ignored, not a new watermark
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 3000, rejectsDay: { 'not paired': 4 }, rejectsLast: [{ t: 1e300, why: 'odd', peer: 'x' }] }))]) as any, null);
  assert.equal(notes().p1.rejAt, 5001);
  assert.equal(notes().p1.win.k, 3);
});

test('device ids that are not plain keys: __proto__, constructor and toString stay keys, bad ids are skipped', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const trust = trustOf(d, { at: 1_000_000 });
  assert.doesNotThrow(() => b.observe(snap([
    eyeDev(d, trust, { id: '__proto__' }),
    eyeDev(d, trust, { id: 'constructor' }),
    eyeDev(d, trust, { id: 'toString' }),
    eyeDev(d, trust, { id: '' }),
    eyeDev(d, trust, { id: 'x'.repeat(201) }),
    eyeDev(d, trust, { id: 42 as any }),
  ]) as any, null));
  assert.equal(({} as any).count, undefined, 'Object.prototype stays clean');
  assert.equal(({} as any).head, undefined);
  const saved = notes();
  assert.equal(Object.keys(saved).length, 3, 'the ids that are not keys are skipped');
  assert.ok(saved.__proto__ && saved.constructor && saved.toString, 'the tricky ids get their own notes');
  assert.ok(!('' in saved) && !('x'.repeat(201) in saved) && !(42 as any in saved));
  // and a restart reads them back as keys, not as a prototype
  const r2 = branch(saved);
  assert.equal(Object.keys(r2.notes()).length, 3);
  assert.ok(r2.notes().__proto__);
});

test('a hostile snapshot is coerced or ignored: the saved notes stay loadable and the history survives a restart', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  // a sane clock but junk fields: coerced, never stored as junk
  b.observe(snap([eyeDev(d, trustOf(d, {
    at: t0 + 72 * H + 1000,
    count: '40' as any,
    rejectsDay: { 'bad proof': -5, x: NaN, y: '7', odd: 1e300 } as any,
    rejectsLast: [null, { t: NaN, why: 'odd', peer: 'x' }, { t: -1, why: 'odd', peer: 'x' }, { t: 1e300, why: 'odd', peer: 'x' }] as any,
  }), { tls: 'yes' as any })]) as any, null);
  // an absurd clock: nothing taken in
  assert.doesNotThrow(() => b.observe(snap([eyeDev(d, trustOf(d, { at: 9e15 }))]) as any, null));
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object|e\+\d/);
  const r2 = branch(notes());
  assert.equal(r2.notes().p1.burst.n, 72, 'the learned hours survived');
  assert.equal(r2.notes().p1.count, 1, 'the absurd count was not remembered');
  // the capped junk day filled the hour at once: the burst is already red, and it stays judged
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 2000, rejectsDay: { 'not paired': 6 }, rejectsLast: [1, 2, 3, 4, 5, 6].map((n) => ({ t: t0 + 72 * H + 1500 + n, why: 'not paired', peer: 'x' })) }))]) as any, null);
  assert.equal(r2.b.view().report!.verdict, 'bad');
  assert.equal(check(r2.b.view(), 'refused').text, '9999 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
});

test('null containers and null entries are skipped without a throw, nothing odd reaches the view', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const base = { ...snap([]), devices: null, host: null, work: null, models: null, projects: null };
  assert.doesNotThrow(() => b.observe(base as any, null));
  assert.equal(b.view().stat, 'nothing to check');
  const devs: any[] = [null, 42, 'x', eyeDev(d, null), eyeDev(d, trustOf(d, { at: 1_000_000, rejectsDay: null, rejectsLast: null, lines: null }))];
  assert.doesNotThrow(() => b.observe({ ...snap(devs), host: null } as any, null));
  assert.ok(b.view().built);
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object|e\+\d/);
});

test('privacy: no refusal reason, peer or ledger line leaves the branch, not in notes, view or feed', () => {
  const d = device();
  d.add('connect', { note: 'topsecret123' });
  const { b, events, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 1000, rejectsDay: { 'bad proof': 1 }, rejectsLast: [{ t: 5, why: 'tampered hello', peer: '192.168.1.77' }] }))]) as any, null);
  // a replay turns the device red, so the feed has a line to check too
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 2000, rejectsDay: { 'bad proof': 1, replay: 1 } }))]) as any, null);
  assert.ok(events.length > 0);
  for (const s of [JSON.stringify(notes()), JSON.stringify(b.view()), JSON.stringify(events)]) {
    assert.ok(!s.includes('192.168.1.77'), s);
    assert.ok(!s.includes('tampered hello'), s);
    assert.ok(!s.includes('topsecret123'), s);
  }
});

test('notes written before the new checks load unchanged, and the first answer after them only remembers', () => {
  const old = { p1: { head: null, verified: 3, since: 5, at: 7, restartSeen: null, fault: null, faultAt: null, faultLine: null, gap: false } };
  const d = device();
  d.add(); d.add();
  const { b, notes } = branch(old);
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000, rejectsDay: { 'not paired': 6 }, rejectsLast: [1, 2, 3].map((t) => ({ t, why: 'not paired', peer: '192.168.1.77' })) }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(check(b.view(), 'refused').ok, true, 'the six refusals are only the baseline');
  const s = notes().p1;
  assert.equal(s.verified, 5, 'the old fields are kept and the new lines join');
  assert.equal(s.since, 5);
  assert.equal(s.count, 2);
  assert.equal(s.rejTotal, 6);
  assert.equal(s.win.k, 0);
  assert.equal(s.hist, undefined);
  assert.deepEqual(s.burst, freshBurst());
});

test('a notes file of the wrong shape gives fresh notes, never a throw', () => {
  for (const bad of [null, 42, 'x', [1], { p1: 'junk' }, { p1: { head: 5, verified: 'x', gap: 'yes' } }]) {
    const d = device();
    d.add();
    const { b } = branch(bad);
    assert.doesNotThrow(() => b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null), JSON.stringify(bad));
    assert.equal(b.view().report!.verdict, 'ok', JSON.stringify(bad));
  }
});

test('the notes are bounded: 168 finished hours per device, 40 devices beyond those in the snapshot', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  let total = 0;
  for (let i = 1; i <= 170; i++) {
    total += i % 3;
    b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + i * H, rejectsDay: { 'not paired': total } }))]) as any, null);
  }
  // the hours are folded into 24 numbers and 24 numbers per device, however many were taken in
  assert.equal(notes().p1.burst.a.length, 24);
  assert.equal(notes().p1.burst.b.length, 24);
  assert.equal(notes().p1.burst.n, 170, 'every finished hour was taken in, none kept one by one');
  assert.ok(!('hist' in notes().p1), 'no list of hours is kept');

  // devices: past 40, the vanished one goes; the live ones all stay. (P43, G10: this said "with 42
  // live devices the least recent live ones go"; a live device now never loses its notes.)
  const devs = [eyeDev(d, trustOf(d, { at: t0 + 171 * H }), { id: 'real' }), ...Array.from({ length: 41 }, (_, i) => mkDev(`q${i}`))];
  b.observe(snap(devs) as any, null);
  const ids = Object.keys(notes());
  assert.equal(ids.length, 42);
  assert.ok(!ids.includes('p1'), 'a vanished device goes before any live one');
  assert.ok(ids.includes('real') && ids.includes('q0') && ids.includes('q40'), 'every live device stays');
});

test('the 40-device cap never drops a device that is in the snapshot, whatever a vanished one says', () => {
  const d = device();
  d.add();
  const seen1 = (seen: number) => ({ head: null, verified: 0, since: 0, at: 0, restartSeen: null, fault: null, faultAt: null, faultLine: null, gap: false, seen, count: 0, shrunkTo: null, rejAt: -1, rejTotal: 0, win: { start: 0, k: 0 }, hist: [] });
  const initial: any = Object.assign(Object.create(null), { gone: seen1(9e15) });
  for (let i = 0; i < 40; i++) initial[`a${i}`] = seen1(1000);
  const { b, notes } = branch(initial);
  b.observe(snap([...Array.from({ length: 40 }, (_, i) => mkDev(`a${i}`)), eyeDev(d, trustOf(d, { at: 1_000_000 }), { id: 'new' })]) as any, null);
  const ids = Object.keys(notes());
  // (P43, G10: this was 40, one live device dropped; now all 41 live devices stay)
  assert.equal(ids.length, 41);
  assert.ok(!ids.includes('gone'), 'the vanished device goes first despite its far-forward seen');
  assert.ok(ids.includes('new') && ids.includes('a0'));
});

// ---- G10 (13.11.2026): no device in the snapshot is forgotten -----------------------------------

// a trust answer for device [i] of a large group, each with its own key and chain
function many(n: number) {
  return Array.from({ length: n }, () => { const d = device(); for (let i = 0; i < 3; i++) d.add(); return d; });
}
const devOf = (d: Dev, i: number, o: Record<string, unknown> = {}) => eyeDev(d, trustOf(d, o), { id: `p${i}`, name: `phone ${i}` });

test('G10: 60 paired devices whose ledgers all start over in one look are all flagged', () => {
  const ds = many(60);
  const { b, notes } = branch();
  for (let look = 0; look < 5; look++) b.observe(snap(ds.map((d, i) => devOf(d, i, { at: 1_000 + look }))) as any, null);
  assert.equal(Object.keys(notes()).length, 60, 'every device in the snapshot keeps its notes');
  // a new chain with the same key (its lines differ from the old ones: another kind)
  const fresh = ds.map((d) => { const f = device(d.key); for (let i = 0; i < 3; i++) f.add('pair'); return f; });
  b.observe(snap(fresh.map((d, i) => devOf(d, i, { at: 2_000, restartedAt: 2_000 }))) as any, null);
  const flagged = b.view().report!.devices.filter((x: any) => x.verdict === 'bad').length;
  assert.equal(flagged, 60);
});

test('G10: 45 in the snapshot and 10 absent: the 10 go and the 45 keep their heads; 30 and 20: the 10 longest unseen go', () => {
  const ds = many(55);
  const { b, notes } = branch();
  b.observe(snap(ds.map((d, i) => devOf(d, i, { at: 1_000 }))) as any, null);
  const heads = Object.fromEntries(ds.map((_, i) => [`p${i}`, notes()[`p${i}`].head]));
  b.observe(snap(ds.slice(0, 45).map((d, i) => devOf(d, i, { at: 2_000 }))) as any, null);
  let ids = Object.keys(notes());
  assert.equal(ids.length, 45);
  for (let i = 0; i < 45; i++) assert.equal(notes()[`p${i}`].head, heads[`p${i}`], `p${i} keeps its head`);
  for (let i = 45; i < 55; i++) assert.ok(!ids.includes(`p${i}`));

  // 50 known, last seen at different times; 30 are in the snapshot and 20 are not: the 10 of
  // those 20 unseen the longest go
  const known: any = Object.create(null);
  for (let i = 0; i < 50; i++) known[`p${i}`] = { head: null, verified: 0, seen: i < 30 ? 9_000 : i < 40 ? 8_000 : 7_000 };
  const r = branch(known);
  r.b.observe(snap(ds.slice(0, 30).map((d, i) => devOf(d, i, { at: 3_000 }))) as any, null);
  ids = Object.keys(r.notes());
  assert.equal(ids.length, 40, '30 present and the 10 absent seen most recently');
  for (let i = 0; i < 40; i++) assert.ok(ids.includes(`p${i}`), `p${i} stays`);
});

test('G10: the verdicts said do not grow with ids that come and go; a device back after being forgotten says no "all clear again"', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  // p1 turns red (a replay), then leaves
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000, rejectsDay: { replay: 1 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  // 100 looks of new ids that each come once and leave again
  const other = device();
  other.add();
  for (let i = 0; i < 100; i++) b.observe(snap([eyeDev(other, trustOf(other, { at: 2_000 + i }), { id: `x${i}`, name: `x${i}` })]) as any, null);
  assert.ok(!('p1' in notes()), 'p1 was forgotten past the cap');
  assert.ok(Object.keys(notes()).length <= 41);
  // it comes back fine: it was forgotten, so nothing was said about it any more, and no "all clear again"
  b.observe(snap([eyeDev(d, trustOf(d, { at: 9_000 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.ok(!events.some((e) => /all clear again/.test(e)), events.join('\n'));
});

test('a device appearing, vanishing and coming back keeps its place; an empty look is fine', () => {
  const d = device();
  d.add(); d.add();
  const { b, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.verified, 2);
  assert.equal(b.view().stat, 'all clear · 1 device');
  b.observe(snap([]) as any, null);
  assert.equal(b.view().stat, 'nothing to check');
  d.add();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000 }))]) as any, null);
  assert.equal(notes().p1.verified, 3, 'the same device keeps its notes');
  assert.equal(b.view().report!.verdict, 'ok');
});

test('the learned hours survive a restart: save, load, and the burst still fires', () => {
  const d = device();
  d.add();
  const t0 = 1_000_000_000;
  const r1 = branch();
  r1.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(r1.b, d, t0, 72);
  const r2 = branch(r1.notes());   // a new branch reads the notes r1 wrote
  assert.equal(r2.notes().p1.burst.n, 72);
  assert.equal(r2.notes().p1.count, 1);
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, rejectsDay: { 'not paired': 6 }, rejectsLast: [{ t: 1, why: 'not paired', peer: 'x' }] }))]) as any, null);
  assert.equal(r2.b.view().report!.verdict, 'bad');
  assert.equal(check(r2.b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
});

test('a restart whose new chain faults: accepting both faults never raises a third, shorter-ledger alarm', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  assert.equal(notes().p1.count, 40);
  // the ledger restarted with five lines whose middle one is missing: a restart and a line fault at once
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  const broken = [fresh.lines[0], fresh.lines[2]];
  const answer = (at: number, count: number | null) =>
    snap([eyeDev(fresh, trustOf(fresh, { at, restartedAt: 1_500_000, lines: broken, count }))]) as any;
  b.observe(answer(2_000_000, 5), null);
  assert.match(check(b.view(), 'ledger').text, /started over/);
  b.observe(answer(3_000_000, 5), null);
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.match(check(b.view(), 'ledger').text, /chain is broken/);
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'ok');
  // the next answer still reports five lines: the started-over fault already said the ledger restarted
  b.observe(answer(4_000_000, 5), null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(check(b.view(), 'ledger').ok, true);
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 0, 'no third alarm after both accepts');
  assert.equal(notes().p1.count, 5, 'the started-over fault set the new baseline');
});

test('a restart whose answer has no count: the next smaller count is the new baseline, not a third alarm', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  const broken = [fresh.lines[0], fresh.lines[2]];
  const answer = (at: number, count: number | null) =>
    snap([eyeDev(fresh, trustOf(fresh, { at, restartedAt: 1_500_000, lines: broken, count }))]) as any;
  // the restart answer carries no ledger length: the shorter fault is the one that says it
  b.observe(answer(2_000_000, null), null);
  assert.match(check(b.view(), 'ledger').text, /started over/);
  b.observe(answer(3_000_000, null), null);
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.act!('accept', 'p1'), 'noted');
  assert.equal(b.view().report!.verdict, 'ok');
  // the first count after the restart is taken as the new baseline, not held against the old 40
  b.observe(answer(4_000_000, 5), null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 0);
  assert.equal(notes().p1.count, 5);
});

test('a rate that stays raised past an hour edge stays red until a finished hour is quiet', () => {
  const d = device();
  d.add();
  const { b, events } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  // one refusal every ten minutes, six each hour, for three hours; the day total carries the count
  const start = t0 + 72 * H;
  const hourOf = (hourStart: number, total: number) => trustOf(d, {
    at: hourStart + H,
    rejectsDay: { 'not paired': total },
    rejectsLast: [5, 15, 25, 35, 45, 55].map((m) => ({ t: hourStart + m * 60_000, why: 'not paired', peer: 'x' })),
  });
  b.observe(snap([eyeDev(d, hourOf(start, 6))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, '6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  assert.deepEqual(events, ['pixel: 6 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused']);
  // the next two hours keep the same rate: each finished hour is a burst too, so the check never clears
  b.observe(snap([eyeDev(d, hourOf(start + H, 12))]) as any, null);
  b.observe(snap([eyeDev(d, hourOf(start + 2 * H, 18))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(events.filter((e) => /all clear again/.test(e)).length, 0, 'no all clear while the rate goes on');
  assert.equal(events.length, 1, 'one feed line at the start');
  // the first quiet hour: its previous finished hour was still a burst, so the check stays red
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + 4 * H, rejectsDay: { 'not paired': 18 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, 'refusals still above its usual: 6 in the last finished hour, at that hour of day usually about 0.1');
  assert.equal(events.length, 1, 'no new line while it stays red');
  // a finished quiet hour clears it, once
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + 5 * H, rejectsDay: { 'not paired': 18 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(events.length, 2);
  assert.equal(events[1], 'pixel: all clear again');
});

test('a finished burst hour is remembered across a restart and clears on a finished quiet hour', () => {
  const d = device();
  d.add();
  const t0 = 1_000_000_000;
  const r1 = branch();
  r1.b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(r1.b, d, t0, 72);
  const start = t0 + 72 * H;
  // one raised hour, then the answer that finishes it: red, and the burst is remembered
  r1.b.observe(snap([eyeDev(d, trustOf(d, { at: start + H, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  r1.b.observe(snap([eyeDev(d, trustOf(d, { at: start + 2 * H, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(check(r1.b.view(), 'refused').text, 'refusals still above its usual: 6 in the last finished hour, at that hour of day usually about 0.1');
  const r2 = branch(r1.notes());
  // a look inside the next hour: still red from the finished hour the notes remember
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: start + 2 * H + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(r2.b.view().report!.verdict, 'bad');
  assert.equal(check(r2.b.view(), 'refused').text, 'refusals still above its usual: 6 in the last finished hour, at that hour of day usually about 0.1');
  // a finished quiet hour clears it
  r2.b.observe(snap([eyeDev(d, trustOf(d, { at: start + 3 * H + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(r2.b.view().report!.verdict, 'ok');
});

test('a shorter ledger seen while the restart is unconsumed: the later started-over replaces it without a second line', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  // no usable key: the restart cannot be checked yet, so the smaller count raises the shorter fault
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 2_000_000, restartedAt: 1_500_000, pub: null, count: 5 }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 40 lines before, 5 now (lines were removed)');
  assert.deepEqual(events, ['pixel: its ledger got shorter: 40 lines before, 5 now (lines were removed)']);
  // the next answer can be checked: the started-over fault replaces the text, and the feed stays at one
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 3_000_000, restartedAt: 1_500_000, count: 5 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'ledger').text, `its ledger started over at ${hhmm(1_500_000)} (cleared on the device, or rewritten)`);
  assert.equal(events.length, 1, 'one line for the one event');
  assert.equal(notes().p1.count, 5);
});

test('the shorter fault raised with an unusable key survives a restart: the started-over still replaces it silently', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  const r1 = branch();
  r1.b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  r1.b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 2_000_000, restartedAt: 1_500_000, pub: null, count: 5 }))]) as any, null);
  assert.equal(r1.events.length, 1);
  const r2 = branch(r1.notes());
  r2.b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 3_000_000, restartedAt: 1_500_000, count: 5 }))]) as any, null);
  assert.equal(r2.b.view().report!.verdict, 'bad');
  assert.match(check(r2.b.view(), 'ledger').text, /started over/);
  assert.deepEqual(r2.events, [], 'the one event was already said before the restart');
});

test('a count of 12345 in a line: plain digits, floored, never an exponent', () => {
  const d = device();
  d.add();
  const { b, events, notes } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000, count: 20000 }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: 2_000_000, count: 12345.9 }))]) as any, null);
  assert.equal(check(b.view(), 'ledger').text, 'its ledger got shorter: 20000 lines before, 12345 now (lines were removed)');
  assert.equal(events[0], 'pixel: its ledger got shorter: 20000 lines before, 12345 now (lines were removed)');
  assert.equal(notes().p1.count, 20000, 'the remembered count is a high-water mark');
  assert.equal(notes().p1.shrunkTo, 12345, 'the count to adopt is whole');
  assert.doesNotMatch(JSON.stringify(b.view()), /e\+\d/);
});

test('two reasons each at the day cap: one answer counts 10000 into the hour, never 20000', () => {
  const d = device();
  d.add();
  const { b, notes } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 + 72 * H + 1000, rejectsDay: { 'not paired': 10000, odd: 10000 } }))]) as any, null);
  assert.equal(notes().p1.win.k, 10000, 'one answer adds at most 10000 to the hour');
  assert.equal(check(b.view(), 'refused').text, '9999 refusals in the last hour, at this hour of day it usually sees about 0.1: unusual. all were refused');
  assert.doesNotMatch(JSON.stringify(b.view()), /e\+\d/);
});

test('a gap in the looks clears a finished burst: one night away is not "still above its usual"', () => {
  const d = device();
  d.add();
  const { b, events } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  const start = t0 + 72 * H;
  // a burst hour, then the answer that finishes it: red, and the burst is remembered
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + H + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.equal(check(b.view(), 'refused').text, 'refusals still above its usual: 6 in the last finished hour, at that hour of day usually about 0.1');
  assert.equal(events.filter((e) => /refusals in the last hour/.test(e)).length, 1);
  // the computer slept ten hours: the finished hour is far too old to say the rate is still raised
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + H + 10 * H + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'ok');
  assert.equal(check(b.view(), 'refused').ok, true);
  assert.equal(events.filter((e) => /refusals|still above/.test(e)).length, 1, 'no refusal line after the gap');
  assert.equal(events.at(-1), 'pixel: all clear again');
});

test('a device that answers every two hours after a burst is not red at every look', () => {
  const d = device();
  d.add();
  const { b } = branch();
  const t0 = 1_000_000_000;
  b.observe(snap([eyeDev(d, trustOf(d, { at: t0 }))]) as any, null);
  hourByHour(b, d, t0, 72);
  const start = t0 + 72 * H;
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  b.observe(snap([eyeDev(d, trustOf(d, { at: start + H + 1000, rejectsDay: { 'not paired': 6 } }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  // every later look is two hours after the one before: each is a gap, and the burst is not carried
  for (let i = 1; i <= 3; i++) {
    b.observe(snap([eyeDev(d, trustOf(d, { at: start + H + 1000 + i * 2 * H, rejectsDay: { 'not paired': 6 } }))]) as any, null);
    assert.equal(b.view().report!.verdict, 'ok', `look ${i}`);
    assert.equal(check(b.view(), 'refused').ok, true, `look ${i}`);
  }
});

test('a line fault after a shorter fault clears its restart marker: the next started-over reaches the feed', () => {
  const d = device();
  for (let i = 0; i < 40; i++) d.add();
  const { b, events } = branch();
  b.observe(snap([eyeDev(d, trustOf(d, { at: 1_000_000 }))]) as any, null);
  const fresh = device(d.key);
  for (let i = 0; i < 5; i++) fresh.add();
  // no usable key and a smaller count: the shorter fault is raised while the restart is unconsumed
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 2_000_000, restartedAt: 1_500_000, pub: null, count: 5 }))]) as any, null);
  assert.equal(events.filter((e) => /got shorter/.test(e)).length, 1);
  // a checkable answer whose chain still holds the verified head but breaks after it: a line fault
  const extra = makeLine(d.key, 5_000, 'connect', '192.168.1.5', {}, GENESIS).line;
  b.observe(snap([eyeDev(d, trustOf(d, { at: 3_000_000, restartedAt: 1_500_000, count: 5, lines: [...d.lines, extra] }))]) as any, null);
  assert.match(check(b.view(), 'ledger').text, /chain is broken/);
  assert.equal(events.filter((e) => /chain is broken/.test(e)).length, 1);
  // a real restart after that: the started-over fault replaces the line fault and is said, not swallowed
  b.observe(snap([eyeDev(fresh, trustOf(fresh, { at: 4_000_000, restartedAt: 2_500_000, count: 5 }))]) as any, null);
  assert.equal(b.view().report!.verdict, 'bad');
  assert.match(check(b.view(), 'ledger').text, /started over/);
  assert.equal(events.filter((e) => /started over/.test(e)).length, 1, 'the marker did not linger');
});
