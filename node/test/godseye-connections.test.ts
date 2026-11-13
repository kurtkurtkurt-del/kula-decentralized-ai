// god's eye, branch 5 connections: the link kind as a dimension, per-kind probe readings, one
// feed line per switch, the assumed kinds, the steadier link, and the rules that a bad clock, a
// skipped look, an odd snapshot field or a corrupt notes file cannot stop it, and that nothing
// sensitive reaches the notes or the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, kindOf, reachRate, usualMs, steadier, MAX_DEVICES, MAX_KINDS, MS_MAX, SW_MAX, RING_MAX, ASSUMED } =
  await import('../src/godseye/branches/connections.ts');

const T = new Date(2026, 10, 8, 23, 0, 0).getTime();   // Sunday 8 November 2026, 23:00 local
const at = (s: number) => T + s * 1000;
const DAY = 24 * 3600_000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const snap = (devices: any[], t: number): any => ({
  at: t, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});

/** a fake ctx: its own clock, a notes "file" in memory, the feed in an array */
function fakeCtx(stored: unknown = undefined) {
  const c = { t: T, stored, saves: 0, feed: [] as string[] };
  const ctx = {
    now: () => c.t,
    load: <X>(fallback: X): X => (c.stored === undefined ? fallback : structuredClone(c.stored) as X),
    save: (d: unknown) => { c.stored = structuredClone(d); c.saves++; },
    emit: (s: string) => { c.feed.push(s); },
    peek: () => null,
  };
  return { c, ctx };
}

/** looks driven straight through the branch: the wall clock follows the snapshot's at */
function drive(snaps: any[], stored: unknown = undefined) {
  const { c, ctx } = fakeCtx(stored);
  const b = create(ctx);
  let before: any = null;
  for (const s of snaps) { c.t = s.at; b.observe(s, before); before = s; }
  return { b, c, ctx };
}

/** everything the branch lets out of itself: the notes, the view and the feed */
function leaked(b: any, c: any): string {
  return JSON.stringify({ notes: c.stored, view: b.view(), feed: c.feed });
}

/** the assumed table as the view says it, one line */
const ASSUMED_LINE = 'cable: 20 ms, rare drops · wifi: 80 ms, sometimes drops · relay: 300 ms, sometimes drops · internet: 150 ms, often drops · other: none';

// ---- the pure parts

test('kindOf: a dimension, not a fixed list', () => {
  assert.equal(kindOf('cable'), 'cable');
  assert.equal(kindOf('wifi'), 'wifi');
  assert.equal(kindOf('relay'), 'relay');
  assert.equal(kindOf('internet'), 'internet');        // works today, with no code change
  assert.equal(kindOf('bluetooth'), 'bluetooth');
  assert.equal(kindOf('CABLE'), 'cable');              // lower case
  assert.equal(kindOf('Wi-Fi'), 'wi-fi');              // letters, digits and dashes stay
  assert.equal(kindOf('wifi 6'), 'other');             // a space does not
  assert.equal(kindOf('192.168.1.33'), 'other');       // dots do not
  assert.equal(kindOf('café'), 'other');
  assert.equal(kindOf(''), 'other');
  assert.equal(kindOf(null), 'other');
  assert.equal(kindOf(undefined), 'other');
  assert.equal(kindOf(42), 'other');
  assert.equal(kindOf({}), 'other');
  assert.equal(kindOf('x'.repeat(25)), 'x'.repeat(20));   // cut to 20 chars
});

test('reachRate: answered of probed, by hand', () => {
  assert.equal(reachRate(100, 98), 0.98);
  assert.equal(reachRate(10, 10), 1);
  assert.equal(reachRate(8, 4), 0.5);
  assert.equal(reachRate(0, 0), null);
  assert.equal(reachRate(-1, 0), null);
  assert.equal(reachRate(Number.NaN, 1), null);
  assert.equal(reachRate(3, Number.POSITIVE_INFINITY), null);
});

test('usualMs: the rounded median, needs 5, never changes its input', () => {
  assert.equal(usualMs([1, 2, 3, 4, 5]), 3);           // odd count: the middle one
  assert.equal(usualMs([5, 1, 4, 2, 3]), 3);           // the order does not matter
  assert.equal(usualMs([1, 2, 3, 4, 5, 6]), 4);        // even: (3 + 4) / 2 = 3.5, rounded
  assert.equal(usualMs([14, 14, 14, 14, 14]), 14);
  assert.equal(usualMs([1, 2, 3, 4]), null);           // fewer than 5: no usual latency
  assert.equal(usualMs([]), null);
  assert.equal(usualMs([1.5, 2.5, 3.5, 4.5, 5.5]), 4);   // a decayed median rounds to a whole ms
  const input = [5, 4, 3, 2, 1];
  usualMs(input);
  assert.deepEqual(input, [5, 4, 3, 2, 1]);            // the input is not changed
});

test('steadier: the higher rate; a tie goes to the lower usual latency', () => {
  assert.equal(steadier({ rate: 0.98, ms: 20 }, { rate: 0.81, ms: 80 }), -1);
  assert.equal(steadier({ rate: 0.81, ms: 80 }, { rate: 0.98, ms: 20 }), 1);
  assert.equal(steadier({ rate: 0.8, ms: 14 }, { rate: 0.8, ms: 30 }), -1);
  assert.equal(steadier({ rate: 0.8, ms: 30 }, { rate: 0.8, ms: 14 }), 1);
  assert.equal(steadier({ rate: 0.8, ms: 14 }, { rate: 0.8, ms: 14 }), 0);
  assert.equal(steadier({ rate: 0.8, ms: null }, { rate: 0.8, ms: 14 }), 1);   // no usual latency cannot win a tie
  assert.equal(steadier({ rate: 0.8, ms: null }, { rate: 0.8, ms: null }), 0);
});

// ---- the branch

test('the stat and the lines keep today\'s beginning; the new parts are appended', () => {
  const devices = [
    dev({ id: 'p1', name: 'one', via: 'cable', plugged: true }),
    dev({ id: 'p2', name: 'two', via: 'cable', plugged: false }),
    dev({ id: 'p3', name: 'three' }),
    dev({ id: 'p4', name: 'four', via: 'relay', where: 'relay pc' }),
    dev({ id: 'p5', name: 'five', reachable: false, reason: 'connect timeout' }),
    dev({ id: 'p6', name: 'six', reachable: null }),
  ];
  const { b } = drive([snap(devices, at(0))]);
  const v = b.view();

  // the stat as it always was: one plugged cable, three wi-fi, one relay
  assert.equal(v.stat, '1 cable · 3 wi-fi · 1 relay');
  assert.equal(v.gauge, null);
  // each line keeps its old beginning exactly, then says there are not enough looks yet (1 each)
  assert.equal(v.lines[0], 'one · cable · reachable · 12 ms · not enough looks yet');
  assert.equal(v.lines[1], 'two · cable (unplugged) · reachable · 12 ms · not enough looks yet');
  assert.equal(v.lines[2], 'three · wifi · 192.168.1.33:50551 · reachable · 12 ms · not enough looks yet');
  assert.equal(v.lines[3], 'four · relay · relay pc · reachable · 12 ms · not enough looks yet');
  assert.equal(v.lines[4], 'five · wifi · 192.168.1.33:50551 · not reachable: connect timeout · not enough looks yet');
  assert.equal(v.lines[5], 'six · wifi · 192.168.1.33:50551 · not checked yet · not enough looks yet');
  assert.equal(v.note, undefined);
  assert.deepEqual(v.rows, [
    ['kinds', 'cable 2 · wifi 3 · relay 1'],
    ['switches today', '0'],
    ['assumed', ASSUMED_LINE],
  ]);
});

test('the same checkedAt seen three times counts once; the line then says the rate and the usual latency', () => {
  const snaps = [snap([dev({ checkedAt: 1000 })], at(0))];
  snaps.push(snap([dev({ checkedAt: 1000 })], at(61)));   // the same probe again
  snaps.push(snap([dev({ checkedAt: 1000 })], at(122)));  // and a third time
  for (let i = 1; i <= 9; i++) snaps.push(snap([dev({ checkedAt: 1000 * (i + 1) })], at((i + 2) * 61)));   // 9 more probes
  const { b, c } = drive(snaps);

  assert.equal(c.saves, 10, 'the two unchanged looks saved nothing; the 9 new probes saved each');
  const k = (c.stored as any).dev[0][1].k;
  assert.deepEqual(k, [['wifi', { ring: '1111111111', ms: [12, 12, 12, 12, 12, 12, 12, 12, 12, 12], last: at(671) }]]);
  assert.equal((c.stored as any).dev[0][1].at, 10000);
  assert.deepEqual((c.stored as any).dev[0][1].sw, []);

  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  assert.deepEqual(b.view().rows[1], ['switches today', '0']);
});

test('a cable phone unplugged and found on wi-fi is one switch, one feed line, no line on the first reading', () => {
  const cable = dev({ via: 'cable', plugged: true, checkedAt: 1000 });
  const wifi = dev({ via: 'wifi', plugged: false, checkedAt: 2000 });
  const { b, c } = drive([
    snap([cable], at(0)),                        // first reading: no switch line
    snap([wifi], at(5)),                         // the switch
    snap([wifi], at(10)),                        // the same probe: nothing new
    snap([dev({ via: 'wifi', plugged: false, checkedAt: 3000 })], at(70)),   // flush the save
  ]);

  assert.deepEqual(c.feed, ['pixel is now reached over wifi (was cable)']);
  assert.deepEqual((c.stored as any).dev[0][1].sw, [{ at: at(5), from: 'cable', to: 'wifi' }]);
  assert.equal(b.view().stat, '0 cable · 1 wi-fi');
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · not enough looks yet');
  assert.deepEqual(b.view().rows[1], ['switches today', '1']);
});

test('a kind called internet works today, with no code change', () => {
  const snaps = [];
  for (let i = 1; i <= 10; i++) snaps.push(snap([dev({ via: 'internet', where: '203.0.113.7:50551', checkedAt: 1000 * i })], at(i)));
  const { b } = drive(snaps);
  const v = b.view();

  assert.equal(v.stat, '0 cable · 0 wi-fi · 1 internet');
  assert.deepEqual(v.rows[0], ['kinds', 'internet 1']);
  assert.equal(v.lines[0], 'pixel · internet · 203.0.113.7:50551 · reachable · 12 ms · answers 100% over internet · usually 12 ms');
});

test('slower than the kind usually is, exactly at the 3x boundary of the assumption', () => {
  const looks = (n: number, o: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => snap([dev({ checkedAt: 1000 * (i + 1), ...o })], at(i)));

  const wifiSlow = drive(looks(10, { reachMs: 300 }));                       // 300 > 3 * 80
  assert.equal(wifiSlow.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 300 ms · answers 100% over wifi · usually 300 ms · slower than a wifi link usually is');

  const cableAt = drive(looks(10, { via: 'cable', reachMs: 60 }));           // 60 is exactly 3 * 20: not slower
  assert.equal(cableAt.b.view().lines[0], 'pixel · cable · reachable · 60 ms · answers 100% over cable · usually 60 ms');

  const cableOver = drive(looks(10, { via: 'cable', reachMs: 61 }));         // 61 is more: slower
  assert.equal(cableOver.b.view().lines[0],
    'pixel · cable · reachable · 61 ms · answers 100% over cable · usually 61 ms · slower than a cable link usually is');
});

test('the steadier link: by rate, then by usual latency on a tie; it only says it', () => {
  // 100 cable probes all answered in 10 ms; 100 wi-fi probes, 81 answered in 30 ms
  const rateLooks = [];
  for (let i = 1; i <= 100; i++) rateLooks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: 10 })], at(i)));
  for (let i = 101; i <= 200; i++) {
    const reachable = i >= 120;                     // 81 of the 100 wi-fi probes answer
    rateLooks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 30, reachable })], at(i)));
  }
  const { b, c } = drive(rateLooks);
  assert.equal(b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 81% over wifi · usually 30 ms · cable has been the steadier link (100% vs 81%)');
  assert.deepEqual(c.feed, ['pixel is now reached over wifi (was cable)'], 'the branch says, it never switches');

  // both kinds answer 8 of 10; cable is quicker, so cable is the steadier
  const tieLooks = [];
  for (let i = 1; i <= 10; i++) tieLooks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: 14, reachable: i <= 8 })], at(i)));
  for (let i = 11; i <= 20; i++) tieLooks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 30, reachable: i >= 13 })], at(i)));
  const tie = drive(tieLooks);
  assert.equal(tie.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 80% over wifi · usually 30 ms · cable has been the steadier link (14 ms vs 30 ms)');

  // wifi has 9 probes, 5 answered, a different rate and latency: fewer than 10, so nothing is said
  const fewLooks = [];
  for (let i = 1; i <= 10; i++) fewLooks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: 10 })], at(i)));
  for (let i = 11; i <= 19; i++) fewLooks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 100, reachable: i >= 15 })], at(i)));
  const few = drive(fewLooks);
  assert.equal(few.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 100 ms · not enough looks yet');
});

test('an exact tie says nothing; an equal rate with one kind short of 5 ms values says nothing either', () => {
  // both kinds: 10 of 10 answered at 12 ms — nothing is the steadier
  const tieLooks = [];
  for (let i = 1; i <= 10; i++) tieLooks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: 12 })], at(i)));
  for (let i = 11; i <= 20; i++) tieLooks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 12 })], at(i)));
  const tie = drive(tieLooks);
  assert.equal(tie.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');

  // equal rates, but cable has only 3 usable answer times: the tie-break cannot be said
  const fewMsLooks = [];
  for (let i = 1; i <= 10; i++) fewMsLooks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: i <= 3 ? 12 : 'fast' })], at(i)));
  for (let i = 11; i <= 20; i++) fewMsLooks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 30 })], at(i)));
  const fewMs = drive(fewMsLooks);
  assert.equal(fewMs.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 100% over wifi · usually 30 ms');
});

test('an old cable era is not compared with this week\'s wi-fi, not even while the device is on a third kind', () => {
  const WEEK = 7 * DAY;
  const looks = [];
  for (let i = 1; i <= 12; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 + i, reachMs: 10 })], at(i)));
  for (let i = 13; i <= 24; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 2000 + i, reachMs: 30, reachable: i !== 20 })], WEEK + at(i)));
  looks.push(snap([dev({ via: 'relay', where: 'relay pc', checkedAt: 9000 })], WEEK + at(100)));   // a third kind now
  const { b } = drive(looks);
  // cable was last probed a week before the look: its ring is another era, so nothing is compared
  assert.equal(b.view().lines[0], 'pixel · relay · relay pc · reachable · 12 ms · not enough looks yet');
});

test('two kinds both probed within the day are compared as today', () => {
  const looks = [];
  for (let i = 1; i <= 12; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 + i, reachMs: 10 })], at(i)));
  for (let i = 13; i <= 24; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 2000 + i, reachMs: 30, reachable: i !== 20 })], at(i + 3600)));   // an hour later, same day
  const { b } = drive(looks);
  assert.equal(b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 92% over wifi · usually 30 ms · cable has been the steadier link (100% vs 92%)');
});

test('a kind whose last probe is stamped in the future is not compared once the clock is right', () => {
  const far = T + 400 * DAY;
  const looks = [];
  for (let i = 1; i <= 10; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 + i, reachMs: 10 })], at(i)));
  for (let i = 11; i <= 20; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 2000 + i, reachMs: 30, reachable: i !== 20 })], at(i)));
  looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: far })], far));      // a bad clock on cable
  looks.push(snap([dev({ via: 'wifi', checkedAt: far + 1000 })], far + 1000));        // and on wi-fi
  looks.push(snap([dev({ via: 'wifi', checkedAt: T + 30000, reachMs: 30 })], at(30)));   // the clock is right: a new wi-fi probe
  const { b } = drive(looks);
  // cable's last probe is still ahead of this look: its ring is a bad-clock era and is not compared
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 92% over wifi · usually 30 ms');
});

test('a kind whose last probe time is unknown (an old notes file) is not compared', () => {
  const oldRing = (ok: number) => Array.from({ length: 10 }, (_, i) => i < ok);
  const file = { v: 1, dev: [['p1', { name: 'pixel', seen: at(0), kind: 'cable', at: 500,
    k: [['cable', { ring: oldRing(10), ms: [10, 10, 10, 10, 10] }],
      ['wifi', { ring: oldRing(9), ms: [30, 30, 30, 30, 30] }]],
    sw: [] }]] };
  const { c, ctx } = fakeCtx(file);
  const b = create(ctx);
  c.t = at(0);
  b.observe(snap([dev({ via: 'wifi', checkedAt: 600, reachMs: 30 })], at(0)), null);   // one new wi-fi probe
  // cable's last probe time is unknown (the file predates the field), so its old ring is not compared
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 91% over wifi · usually 30 ms');
});

test('a far-forward look does not silence the steadier sentence for good, live and after a restart', () => {
  const far = T + 400 * DAY;
  const looks = [];
  for (let i = 1; i <= 12; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 + i, reachMs: 10 })], at(i)));
  for (let i = 13; i <= 24; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 2000 + i, reachMs: 30, reachable: i !== 20 })], at(i)));
  looks.push(snap([dev({ via: 'wifi', checkedAt: far })], far));                      // a bad clock on the current kind
  looks.push(snap([dev({ via: 'wifi', checkedAt: T + 30000 })], at(30)));             // the clock is right: a new probe
  looks.push(snap([dev({ via: 'wifi', checkedAt: T + 40000 })], at(90)));             // and the minute's save
  const { b, c, ctx } = drive(looks);
  const line = 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 93% over wifi · usually 30 ms · cable has been the steadier link (100% vs 93%)';
  assert.equal(b.view().lines[0], line);

  const again = create(ctx);
  c.t = at(95);
  again.observe(snap([dev({ via: 'wifi', checkedAt: T + 40000 })], at(95)), null);   // the same probe: no new reading
  assert.equal(again.view().lines[0], line, 'after the restart the sentence still stands, and the bad era was not compared');
});

test('an empty snapshot is a normal look: built, bounded and empty', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const before = b.view();
  assert.equal(before.built, true);
  assert.equal(before.stat, '0 cable · 0 wi-fi');
  assert.deepEqual(before.rows, [
    ['kinds', 'none yet'],
    ['switches today', '0'],
    ['assumed', ASSUMED_LINE],
  ]);
  assert.deepEqual(before.lines, []);
  assert.equal(before.note, 'no device yet.');

  const { b: b2 } = drive([snap([], at(0)), snap([], at(5))]);
  assert.equal(b2.view().stat, '0 cable · 0 wi-fi');
  assert.deepEqual(b2.view().lines, []);
  assert.equal(b2.view().note, 'no device yet.');
});

test('a device appears and vanishes: its line comes and goes, the notes keep it', () => {
  const { b, c } = drive([snap([dev()], at(0)), snap([], at(5))]);
  assert.deepEqual(b.view().lines, []);
  assert.equal(b.view().note, 'no device yet.');
  assert.equal(b.view().stat, '0 cable · 0 wi-fi');
  assert.equal((c.stored as any).dev[0][0], 'p1', 'the notes still remember the vanished device');
  assert.equal((c.stored as any).dev[0][1].k[0][1].ring.length, 1);
});

test('notes of the wrong shape or with a bad time give fresh notes, never a throw', () => {
  const goodDev = { name: 'pixel', seen: T, kind: 'wifi', at: 500, k: [['wifi', { ring: [true, true, true, true, true, true, true, true, true, false], ms: [1, 2, 3, 4, 5] }]], sw: [] };
  const bads: unknown[] = [
    null,
    'x',
    42,
    { v: 2, dev: [] },
    { v: 1, dev: 'x' },
    { v: 1, dev: null },
    { v: 1, dev: [null] },
    { v: 1, dev: ['p1'] },
    { v: 1, dev: [['p1', null]] },
    { v: 1, dev: [['p1', { ...goodDev, name: 42 }]] },
    { v: 1, dev: [['p1', { ...goodDev, seen: -1 }]] },
    { v: 1, dev: [['p1', { ...goodDev, seen: Number.NaN }]] },
    { v: 1, dev: [['p1', { ...goodDev, seen: 8.64e15 + 1 }]] },
    { v: 1, dev: [['p1', { ...goodDev, at: -5 }]] },
    { v: 1, dev: [['p1', { ...goodDev, kind: 'Wi-Fi' }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: 'x' }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { n: 10, ok: 9, ms: [] }]] }]] },   // a shape from before the ring: no ring
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: 'x', ms: [] }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: [true, 1], ms: [] }]] }]] },   // an outcome that is not a boolean
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: [true], ms: [Number.NaN] }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: [true], ms: [], last: -1 }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: [true], ms: [], last: Number.NaN }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['wifi', { ring: [true], ms: [-1] }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, k: [['WIFI', { ring: [true], ms: [] }]] }]] },
    { v: 1, dev: [['p1', { ...goodDev, sw: 'x' }]] },
    { v: 1, dev: [['p1', { ...goodDev, sw: [{ at: -1, from: 'cable', to: 'wifi' }] }]] },
    { v: 1, dev: [['p1', { ...goodDev, sw: [{ at: T, from: 'wifi', to: 'wifi' }] }]] },   // from and to are the same
    { v: 1, dev: [['p1', { ...goodDev, sw: [{ at: T, from: 'nope?', to: 'wifi' }] }]] },
    {},
    { v: 1 },
  ];
  for (const bad of bads) {
    const { c, ctx } = fakeCtx(bad);
    const b = create(ctx);
    const s0 = snap([dev()], at(0));
    c.t = s0.at;
    assert.doesNotThrow(() => b.observe(s0, null));
    assert.doesNotThrow(() => b.view(), 'the eye calls view() right after every look');
    const s1 = snap([dev({ checkedAt: 2000 })], at(70));
    c.t = s1.at;
    b.observe(s1, s0);
    assert.equal(b.view().built, true);
    assert.deepEqual((c.stored as any).dev[0][1].k, [['wifi', { ring: '11', ms: [12, 12], last: at(70) }]], 'fresh notes: two looks counted');
  }
});

test('a small backwards clock step still records', () => {
  const { b, c } = drive([
    snap([dev({ checkedAt: at(5) })], at(5)),
    snap([dev({ via: 'cable', plugged: true, checkedAt: at(5) - 60_000 })], at(5) - 60_000),   // one minute back
    snap([dev({ via: 'cable', plugged: true, checkedAt: at(10) })], at(10)),                    // flush the save
  ]);
  assert.deepEqual(c.feed, ['pixel is now reached over cable (was wifi)']);
  assert.deepEqual((c.stored as any).dev[0][1].sw, [{ at: at(5) - 60_000, from: 'wifi', to: 'cable' }]);
  assert.equal(b.view().lines[0], 'pixel · cable · reachable · 12 ms · not enough looks yet');
});

test('one bad far-future look does not silence the branch, live', () => {
  const far = T + 400 * DAY;
  const looks = [
    snap([dev({ checkedAt: T })], T),                                // one real probe
    snap([dev({ via: 'cable', checkedAt: far })], far),              // a bad clock: a switch to cable
    ...Array.from({ length: 10 }, (_, i) => snap([dev({ checkedAt: T + (i + 5) * 1000 })], T + (i + 5) * 1000)),   // the clock is right again
  ];
  const { b, c } = drive(looks);
  const v = b.view();

  assert.deepEqual(c.feed, ['pixel is now reached over cable (was wifi)'], 'the bad look\'s switch, and no spurious one back');
  assert.equal(v.lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  assert.deepEqual(v.rows[1], ['switches today', '0'], 'the far-future switch is not today');

  c.t = T + 120_000;
  b.observe(snap([dev({ checkedAt: T + 120_000 })], T + 120_000), looks[looks.length - 1]);   // flush the save
  assert.deepEqual((c.stored as any).dev[0][1].sw, [{ at: far, from: 'wifi', to: 'cable' }], 'the remembered kind was forgotten, so no switch back');
  assert.equal((c.stored as any).dev[0][1].k[0][1].ring.length, 12, '1 + 10 + the flush: still counting after the bad look');
});

test('one bad far-future look does not silence the branch after a restart either', () => {
  const far = T + 400 * DAY;
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  c.t = T;
  first.observe(snap([dev({ checkedAt: T })], T), null);
  c.t = far;
  first.observe(snap([dev({ via: 'cable', checkedAt: far })], far), snap([dev({ checkedAt: T })], T));   // saved with the bad clock

  const again = create(ctx);
  let before: any = null;
  for (let i = 5; i <= 14; i++) {
    c.t = T + i * 1000;
    const s = snap([dev({ checkedAt: T + i * 1000 })], T + i * 1000);
    again.observe(s, before);
    before = s;
  }

  assert.deepEqual(c.feed, ['pixel is now reached over cable (was wifi)'], 'the bad look\'s switch from before the restart, nothing new');
  assert.equal(again.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  assert.deepEqual(again.view().rows[1], ['switches today', '0']);
});

test('a far-future seen is re-anchored, so the cap evicts the vanished device it belongs to, live', () => {
  const far = T + 400 * DAY;
  const D = dev({ id: 'd', name: 'dee', checkedAt: T + 1000 });
  const E = dev({ id: 'e', name: 'eee', checkedAt: T + 10000 });
  const fleet = (n: number) => Array.from({ length: n }, (_, i) => dev({ id: `n${i}`, name: `new ${i}`, checkedAt: T + 15000 + i }));

  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const steps: any[] = [
    snap([D], T),
    snap([dev({ id: 'd', name: 'dee', checkedAt: far })], far),          // D seen at the bad clock
    snap([dev({ id: 'd', name: 'dee', checkedAt: T + 5000 })], T + 5000),   // the clock is right: D's seen re-anchors
    snap([E], T + 10000),                                                // D is gone; E appears
    snap(fleet(39), T + 15000),                                          // 39 new devices: one vanished device must go
    snap([...Array.from({ length: 38 }, (_, i) => dev({ id: `n${i + 1}`, name: `new ${i + 1}`, checkedAt: T + 15000 + i + 1 })),
      dev({ id: 'n0', name: 'new 0', checkedAt: T + 75000 })], T + 75000),   // flush the save
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    b.observe(s, before);
    before = s;
  }

  const ids = (c.stored as any).dev.map((p: any) => p[0]);
  assert.equal(ids.length, MAX_DEVICES);
  assert.ok(!ids.includes('d'), 'the re-anchored (oldest) vanished device went');
  assert.ok(ids.includes('e'), 'the other vanished device stayed');
  for (let i = 0; i < 39; i++) assert.ok(ids.includes(`n${i}`), `n${i} is in the snapshot and stayed`);
});

test('a far-future seen is re-anchored after a restart too', () => {
  const far = T + 400 * DAY;
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  c.t = T;
  const s0 = snap([dev({ id: 'd', name: 'dee', checkedAt: T + 1000 })], T);
  first.observe(s0, null);
  c.t = far;
  const s1 = snap([dev({ id: 'd', name: 'dee', checkedAt: far })], far);
  first.observe(s1, s0);                                                 // saved with the bad clock

  const again = create(ctx);
  const steps: any[] = [
    snap([dev({ id: 'd', name: 'dee', checkedAt: T + 5000 })], T + 5000),
    snap([dev({ id: 'e', name: 'eee', checkedAt: T + 10000 })], T + 10000),
    snap(Array.from({ length: 39 }, (_, i) => dev({ id: `n${i}`, name: `new ${i}`, checkedAt: T + 15000 + i })), T + 15000),
    snap([...Array.from({ length: 38 }, (_, i) => dev({ id: `n${i}`, name: `new ${i}`, checkedAt: T + 15000 + i })),
      dev({ id: 'n38', name: 'new 38', checkedAt: T + 75000 })], T + 75000),
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    again.observe(s, before);
    before = s;
  }

  const ids = (c.stored as any).dev.map((p: any) => p[0]);
  assert.equal(ids.length, MAX_DEVICES);
  assert.ok(!ids.includes('d'));
  assert.ok(ids.includes('e'));
  for (let i = 0; i < 39; i++) assert.ok(ids.includes(`n${i}`), `n${i} is in the snapshot and stayed`);
});

test('the caps: 40 devices, 6 kinds, 20 ms values, 10 switches', () => {
  const fleet = (n: number, o: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 1000 + i, ...o }));

  // 45 devices: only the first 40 count, the rest are ignored even when they change
  const { c: c1 } = drive([
    snap(fleet(45), at(0)),
    snap(fleet(45, { checkedAt: 2000 }), at(65)),
    snap(fleet(44).concat([dev({ id: 'd44', name: 'dev 44', via: 'cable', checkedAt: 3000 })]), at(70)),
  ]);
  assert.equal((c1.stored as any).dev.length, MAX_DEVICES);
  assert.deepEqual((c1.stored as any).dev.map((p: any) => p[0]), Array.from({ length: 40 }, (_, i) => `d${i}`));
  assert.deepEqual(c1.feed, [], 'the device past the cap switched kinds and no line was said');

  // 7 kinds on one device: the oldest kind goes, never the new one
  const kindsLooks = 'abcdefg'.split('').map((v, i) => snap([dev({ via: v, checkedAt: 1000 + i })], at(i)));
  kindsLooks.push(snap([dev({ via: 'g', checkedAt: 2000 })], at(70)));
  const { c: c2 } = drive(kindsLooks);
  assert.deepEqual((c2.stored as any).dev[0][1].k.map((p: any) => p[0]), ['b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal((c2.stored as any).dev[0][1].k.length, MAX_KINDS);

  // 25 answered probes: the last 20 ms values stay
  const msLooks = Array.from({ length: 25 }, (_, i) => snap([dev({ checkedAt: 1000 + i, reachMs: i + 1 })], at(i)));
  msLooks.push(snap([dev({ checkedAt: 2000, reachMs: 26 })], at(70)));
  const { c: c3 } = drive(msLooks);
  const ms = (c3.stored as any).dev[0][1].k[0][1].ms;
  assert.equal(ms.length, MS_MAX);
  assert.deepEqual(ms, Array.from({ length: 20 }, (_, i) => i + 7));   // 26 pushes keep 7..26

  // 12 switches: the last 10 stay
  const swLooks = [];
  for (let i = 1; i <= 13; i++) swLooks.push(snap([dev({ via: i % 2 === 1 ? 'cable' : 'wifi', plugged: true, checkedAt: 1000 + i })], at(i)));
  swLooks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 2000 })], at(75)));
  const { c: c4 } = drive(swLooks);
  const sw = (c4.stored as any).dev[0][1].sw;
  assert.equal(sw.length, SW_MAX);
  assert.deepEqual(sw[0], { at: at(4), from: 'cable', to: 'wifi' });    // switch 3 of 12
  assert.deepEqual(sw[9], { at: at(13), from: 'wifi', to: 'cable' });   // switch 12 of 12
});

test('the cap never drops a device the current look holds, even against vanished ones with a far-forward seen', () => {
  const far = T + 400 * DAY;
  const vanished = (n: number, checkedAt: number) =>
    Array.from({ length: n }, (_, i) => dev({ id: `v${i}`, name: `old ${i}`, checkedAt: checkedAt + i }));
  const current = (n: number) =>
    Array.from({ length: n }, (_, i) => dev({ id: `c${i}`, name: `new ${i}`, checkedAt: T + 5000 + i }));
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  c.t = T;
  b.observe(snap(vanished(40, T + 1000), T), null);                    // 40 vanished devices, seen at T
  c.t = far;
  b.observe(snap(vanished(40, far + 1000), far), snap(vanished(40, T + 1000), T));   // their seen goes far forward, saved
  c.t = T + 5000;
  b.observe(snap(current(40), T + 5000), snap(vanished(40, far + 1000), far));       // 40 new devices: the vanished must go, not these
  c.t = T + 75000;
  b.observe(snap([...current(40).slice(0, 39), dev({ id: 'c0', name: 'new 0', checkedAt: T + 75000 })], T + 75000),
    snap(current(40), T + 5000));                                      // flush the save

  const ids = (c.stored as any).dev.map((p: any) => p[0]);
  assert.equal(ids.length, MAX_DEVICES);
  for (let i = 0; i < 40; i++) assert.ok(ids.includes(`c${i}`), `c${i} is in the snapshot and stayed`);
  for (let i = 0; i < 40; i++) assert.ok(!ids.includes(`v${i}`), `v${i} vanished and went`);
});

test('a look with an unusable at is skipped: view() works, nothing is saved, the history survives a restart', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  c.t = at(0);
  b.observe(snap([dev({ checkedAt: 1000 })], at(0)), null);            // n = 1, save 1
  const bads = [Number.NaN, -5, 1e300];
  for (let i = 0; i < bads.length; i++) {
    const s = snap([dev({ checkedAt: 2000 }), dev({ id: 'p2', name: 'second', checkedAt: 2500 })], bads[i]);
    c.t = at(70 + i);                                                  // the wall clock is fine: a save would write
    assert.doesNotThrow(() => b.observe(s, snap([dev()], at(0))));
    assert.doesNotThrow(() => b.view(), 'the eye calls view() right after every look');
    assert.equal(b.view().built, true);
    assert.deepEqual(c.feed, []);
  }
  c.t = at(80);
  b.observe(snap([dev({ checkedAt: 3000 })], at(80)), snap([dev()], at(0)));   // a real change: save 2

  const again = create(ctx);
  assert.deepEqual((c.stored as any).dev.map((p: any) => p[0]), ['p1'], 'the new device never entered the notes');
  assert.deepEqual((c.stored as any).dev[0][1].k, [['wifi', { ring: '11', ms: [12, 12], last: at(80) }]], 'the earlier history survived');
  c.t = at(85);
  again.observe(snap([dev({ checkedAt: 4000 })], at(85)), null);       // and the branch still records
  assert.equal(again.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · not enough looks yet');
});

test('the rate comes from the last 200 probes: an old era of failures stops counting', () => {
  const fails = Array.from({ length: 300 }, (_, i) => snap([dev({ checkedAt: 1000 * (i + 1), reachable: false })], at(i + 1)));
  const answers = Array.from({ length: 300 }, (_, i) => snap([dev({ checkedAt: 1000 * (301 + i), reachable: true })], at(301 + i)));

  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let before: any = null;
  for (const s of [...fails, ...answers.slice(0, 100)]) {
    c.t = s.at;
    b.observe(s, before);
    before = s;
  }
  // the ring holds the last 200: 100 failures and 100 answers
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 50% over wifi · usually 12 ms');
  for (const s of answers.slice(100)) {
    c.t = s.at;
    b.observe(s, before);
    before = s;
  }
  // now the ring is all answers: 100%
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  assert.equal((c.stored as any).dev[0][1].k[0][1].ring.length, RING_MAX, 'the ring never grows past 200');
});

test('no answer in the last 200 probes leaves out the usual ms: the remembered times are older than the ring', () => {
  const looks = [];
  for (let i = 1; i <= 10; i++) looks.push(snap([dev({ checkedAt: 1000 * i, reachable: true, reachMs: 12 })], at(i)));
  for (let i = 1; i <= 200; i++) looks.push(snap([dev({ checkedAt: 100000 + 1000 * i, reachable: false })], at(10 + i)));
  const { b } = drive(looks);
  // the ring is 200 failures, so the 10 remembered answer times are not this window's
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · not reachable: no answer · answers 0% over wifi');
});

test('usually ms comes only from the answers inside the ring', () => {
  // 10 old answers at 12 ms, then 199 failures and one answer at 99 ms: the ring holds only that answer
  const one = [];
  for (let i = 1; i <= 10; i++) one.push(snap([dev({ checkedAt: 1000 * i, reachMs: 12 })], at(i)));
  for (let i = 11; i <= 209; i++) one.push(snap([dev({ checkedAt: 1000 * i, reachable: false })], at(i)));
  one.push(snap([dev({ checkedAt: 210000, reachMs: 99 })], at(210)));
  const a = drive(one);
  assert.equal(a.b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 99 ms · answers 1% over wifi');

  // 10 old answers at 12 ms, then 195 failures and 5 answers at 50 ms: the usual is the 5 in the ring
  const many = [];
  for (let i = 1; i <= 10; i++) many.push(snap([dev({ checkedAt: 1000 * i, reachMs: 12 })], at(i)));
  for (let i = 11; i <= 205; i++) many.push(snap([dev({ checkedAt: 1000 * i, reachable: false })], at(i)));
  for (let i = 206; i <= 210; i++) many.push(snap([dev({ checkedAt: 1000 * i, reachMs: 50 })], at(i)));
  const m = drive(many);
  assert.equal(m.b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 50 ms · answers 3% over wifi · usually 50 ms');
});

test('the steadier sentence needs an answer in the ring: two all-failure rings say nothing', () => {
  const looks = [];
  for (let i = 1; i <= 10; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 * i, reachMs: 10 })], at(i)));
  for (let i = 11; i <= 20; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 1000 * i, reachMs: 30 })], at(i)));
  for (let i = 21; i <= 220; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 1000 * i, reachable: false })], at(i)));
  for (let i = 221; i <= 420; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 * i, reachable: false })], at(i)));
  const { b } = drive(looks);
  // both rings are all failures: the old answer times cannot set one kind against the other
  assert.equal(b.view().lines[0], 'pixel · cable · not reachable: no answer · answers 0% over cable');
});

test('the steadier percents show one decimal when the whole percents collide; 199 of 200 shows 99%', () => {
  const looks = [];
  for (let i = 1; i <= 125; i++) looks.push(snap([dev({ via: 'cable', checkedAt: 10000 + i, reachMs: 10, reachable: i > 2 })], at(i)));   // 123 of 125
  for (let i = 126; i <= 325; i++) looks.push(snap([dev({ via: 'wifi', checkedAt: 10000 + i, reachMs: 30, reachable: i > 130 })], at(i)));  // 195 of 200
  const { b } = drive(looks);
  // 123 / 125 = 0.984 and 195 / 200 = 0.975: both round to 98%, so one decimal tells them apart
  assert.equal(b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 30 ms · answers 98% over wifi · usually 30 ms · cable has been the steadier link (98.4% vs 97.5%)');

  const near = [];
  for (let i = 1; i <= 200; i++) near.push(snap([dev({ checkedAt: 1000 * i, reachable: i !== 5 })], at(i)));
  const n = drive(near);
  assert.equal(n.b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 99% over wifi · usually 12 ms');
});

test('the kinds cap evicts the kind with the fewest probes: six stray kinds do not wipe 50 cable probes', () => {
  const looks = [];
  for (let i = 1; i <= 50; i++) looks.push(snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 + i })], at(i)));
  for (let i = 0; i < 7; i++) looks.push(snap([dev({ via: 'abcdefg'[i], checkedAt: 10000 + i })], at(51 + i)));
  looks.push(snap([dev({ via: 'g', checkedAt: 20000 })], at(120)));   // flush the save, on the same kind
  const { c } = drive(looks);
  const k = (c.stored as any).dev[0][1].k;
  assert.deepEqual(k.map((p: any) => p[0]), ['cable', 'c', 'd', 'e', 'f', 'g'], 'the first two strays went, cable stayed');
  assert.equal(k[0][1].ring.length, 50, 'the 50 cable probes survived');
});

test('the kinds cap never evicts the kind the device just switched from', () => {
  const looks = [];
  let n = 1;
  for (const via of ['a', 'b', 'c', 'd', 'e']) {
    for (let j = 0; j < 3; j++) looks.push(snap([dev({ via, checkedAt: 1000 * n })], at(n++)));
  }
  looks.push(snap([dev({ via: 'f', checkedAt: 1000 * n })], at(n++)));   // the sixth kind: one probe only
  looks.push(snap([dev({ via: 'g', checkedAt: 1000 * n })], at(n++)));   // a seventh: the cap is full
  looks.push(snap([dev({ via: 'g', checkedAt: 1000 * n })], at(120)));   // flush the save
  const { c } = drive(looks);
  const kinds = (c.stored as any).dev[0][1].k.map((p: any) => p[0]);
  // f (one probe each) is the fewest, but it is the kind just switched from: the earliest of the rest goes
  assert.deepEqual(kinds, ['b', 'c', 'd', 'e', 'f', 'g'], 'f, just switched from, stayed; a went instead');
  assert.equal(c.feed[c.feed.length - 1], 'pixel is now reached over g (was f)');
});

test('a reason is a string cut to 120 chars; a non-string reason is left out', () => {
  const long = 'r'.repeat(200);
  const a = drive([snap([dev({ reachable: false, reason: long, checkedAt: 1000 })], at(0))]);
  assert.equal(a.b.view().lines[0],
    `pixel · wifi · 192.168.1.33:50551 · not reachable: ${long.slice(0, 120)} · not enough looks yet`);
  const num = drive([snap([dev({ reachable: false, reason: 42, checkedAt: 1000 })], at(0))]);
  assert.equal(num.b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · not reachable: no answer · not enough looks yet');
});

test('a duplicated device id keeps its first entry: one reading, no switch, the first name', () => {
  const { b, c } = drive([
    snap([dev({ id: 'p1', name: 'first', checkedAt: 1000 }),
      dev({ id: 'p1', name: 'second', via: 'cable', plugged: true, checkedAt: 2000 })], at(0)),
    snap([dev({ id: 'p1', name: 'first', checkedAt: 3000 }),
      dev({ id: 'p1', name: 'second', via: 'cable', plugged: true, checkedAt: 4000 })], at(70)),
  ]);
  assert.deepEqual(c.feed, [], 'the second entry is not seen: no switch');
  assert.deepEqual((c.stored as any).dev.map((p: any) => p[0]), ['p1']);
  assert.equal((c.stored as any).dev[0][1].name, 'first');
  assert.deepEqual((c.stored as any).dev[0][1].k.map((p: any) => p[0]), ['wifi'], 'only the first entry\'s kind was counted');
  assert.equal((c.stored as any).dev[0][1].k[0][1].ring.length, 2);
  assert.equal(b.view().lines[1], 'second · cable · reachable · 12 ms · not enough looks yet');
});

test('after a far-future look a null reachable does not dirty the notes on every look', () => {
  const far = T + 400 * DAY;
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  c.t = T;
  b.observe(snap([dev({ checkedAt: T })], T), null);                    // save 1
  c.t = far;
  b.observe(snap([dev({ via: 'cable', checkedAt: far })], far), snap([dev({ checkedAt: T })], T));   // save 2
  let before: any = null;
  for (let i = 1; i <= 10; i++) {
    c.t = T + 5000 + i * 61_000;                                       // a minute passes each time
    const s = snap([dev({ via: 'cable', checkedAt: T + 5000, reachable: null })], T + 5000 + i * 61_000);
    b.observe(s, before);
    before = s;
  }
  assert.equal(c.saves, 3, 'the one re-anchor is saved once; the later minute-spaced looks change nothing and save nothing');
  assert.equal(b.view().built, true);
});

test('when via changed but no new probe has come, the line speaks of the beginning kind, not the last one', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let before: any = null;
  for (let i = 1; i <= 10; i++) {
    const s = snap([dev({ checkedAt: 1000 * i })], at(i));
    c.t = s.at;
    b.observe(s, before);
    before = s;
  }
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  c.t = at(70);
  const s2 = snap([dev({ via: 'cable', plugged: true, checkedAt: 10000 })], at(70));   // the same probe: no cable reading yet
  b.observe(s2, before);
  assert.equal(b.view().lines[0], 'pixel · cable · reachable · 12 ms · not enough looks yet');
});

test('after a restart the counts carry on: the same probe is not counted twice, a new one is', () => {
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  c.t = at(0);
  first.observe(snap([dev({ checkedAt: 1000 })], at(0)), null);
  c.t = at(5);
  first.observe(snap([dev({ checkedAt: 2000 })], at(5)), snap([dev({ checkedAt: 1000 })], at(0)));
  c.t = at(70);
  first.observe(snap([dev({ checkedAt: 3000 })], at(70)), snap([dev({ checkedAt: 2000 })], at(5)));   // saved

  const again = create(ctx);
  c.t = at(75);
  again.observe(snap([dev({ checkedAt: 3000 })], at(75)), null);    // the same probe as before the restart
  c.t = at(80);
  again.observe(snap([dev({ checkedAt: 4000 })], at(80)), snap([dev({ checkedAt: 3000 })], at(75)));
  c.t = at(150);
  again.observe(snap([dev({ checkedAt: 5000 })], at(150)), snap([dev({ checkedAt: 4000 })], at(80)));   // saved

  assert.deepEqual(c.feed, [], 'the kind never changed: no feed line');
  assert.deepEqual((c.stored as any).dev[0][1].k, [['wifi', { ring: '11111', ms: [12, 12, 12, 12, 12], last: at(150) }]]);
  assert.equal((c.stored as any).dev[0][1].at, 5000);
});

test('the notes are saved at most once a minute and only when something changed', () => {
  const { c } = drive([
    snap([dev({ checkedAt: 1000 })], at(0)),      // first look: save 1
    snap([dev({ checkedAt: 2000 })], at(5)),      // a change, but the minute is not up
    snap([dev({ checkedAt: 3000 })], at(59)),     // still not up
    snap([dev({ checkedAt: 3000 })], at(61)),     // a minute since the save, but nothing changed
    snap([dev({ checkedAt: 4000 })], at(120)),    // a change and the minute is up: save 2
  ]);
  assert.equal(c.saves, 2);
});

test('a probe ring is packed as a string of 0/1 in the notes, with the look time of its last probe', () => {
  const looks = [];
  for (let i = 1; i <= 10; i++) looks.push(snap([dev({ checkedAt: 1000 * i, reachable: i !== 5 })], at(i)));
  looks.push(snap([dev({ name: 'pixel 2', checkedAt: 10000 })], at(70)));   // the same probe, renamed: the minute's save happens
  const { c } = drive(looks);
  assert.deepEqual((c.stored as any).dev[0][1].k,
    [['wifi', { ring: '1111011111', ms: [12, 12, 12, 12, 12, 12, 12, 12, 12], last: at(10) }]]);
});

test('a notes file as the merged version wrote it (boolean rings, no last) loads with its history', () => {
  const oldRing = Array.from({ length: 12 }, (_, i) => i !== 2);   // 11 of 12 answered
  const file = { v: 1, dev: [['p1', { name: 'pixel', seen: at(0), kind: 'wifi', at: 500,
    k: [['wifi', { ring: oldRing, ms: [12, 12, 12, 12, 12] }]], sw: [] }]] };
  const { c, ctx } = fakeCtx(file);
  const b = create(ctx);
  c.t = at(0);
  b.observe(snap([dev({ name: 'pixel 2', checkedAt: 500 })], at(0)), null);   // the same probe: the rename is the only change, so it saves
  assert.deepEqual((c.stored as any).dev[0][1].k,
    [['wifi', { ring: '110111111111', ms: [12, 12, 12, 12, 12], last: null }]],
    'the old ring is packed on the next save; when its last probe was is unknown');

  const again = create(ctx);                                                   // the file this version writes loads too
  c.t = at(70);
  again.observe(snap([dev({ name: 'pixel 2', checkedAt: 600 })], at(70)), null);
  c.t = at(130);
  again.observe(snap([dev({ name: 'pixel 2', checkedAt: 700 })], at(130)), null);   // saved
  assert.deepEqual((c.stored as any).dev[0][1].k,
    [['wifi', { ring: '11011111111111', ms: [12, 12, 12, 12, 12, 12, 12], last: at(130) }]],
    'the old history is still there; the two new answers are on its end');
  assert.equal(again.view().lines[0], 'pixel 2 · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 93% over wifi · usually 12 ms');
});

test('an old file at the ring and ms caps loads every entry, none dropped', () => {
  const ring = Array.from({ length: RING_MAX }, (_, i) => i !== 0);        // the old writer's largest ring: 199 of 200 answered
  const ms = Array.from({ length: MS_MAX }, (_, i) => 12 + (i % 2));       // and its largest ms list: 20 values
  const file = { v: 1, dev: [['p1', { name: 'pixel', seen: at(0), kind: 'wifi', at: 500,
    k: [['wifi', { ring, ms }]], sw: [] }]] };
  const { c, ctx } = fakeCtx(file);
  const b = create(ctx);
  c.t = at(0);
  b.observe(snap([dev({ name: 'pixel 2', checkedAt: 500 })], at(0)), null);   // the same probe: the rename makes it save
  const k = (c.stored as any).dev[0][1].k[0][1];
  assert.equal(k.ring, `0${'1'.repeat(RING_MAX - 1)}`, 'the old ring kept all 200 outcomes');
  assert.equal(k.ms.length, MS_MAX, 'the old 20 answer times are all kept');
  assert.deepEqual(k.ms, ms.slice(-MS_MAX));
});

test('bad snapshot values are skipped, and the saved notes still pass their own read-back', () => {
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  const steps: any[] = [
    snap([dev({ checkedAt: 1000 })], at(0)),                                     // n = 1
    snap([dev({ checkedAt: -5 })], at(5)),                                        // a negative time: no reading
    snap([dev({ checkedAt: Number.NaN })], at(10)),                               // NaN: no reading
    snap([dev({ checkedAt: 1e300 })], at(15)),                                    // past the last Date: no reading
    snap([dev({ checkedAt: 'x' })], at(20)),                                      // a string: no reading
    snap([dev({ checkedAt: 25000, reachable: 'yes' })], at(25)),                  // a string where a boolean goes: no reading
    snap([dev({ checkedAt: 30000, reachable: true, reachMs: 'fast' })], at(30)),  // n = 2, the unusable ms is not kept
    snap([dev({ checkedAt: 70000, reachable: true, reachMs: 12 })], at(70)),      // n = 3, saved
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    assert.doesNotThrow(() => first.observe(s, before));
    before = s;
    assert.doesNotThrow(() => first.view(), 'the eye calls view() right after every look');
    assert.equal(first.view().built, true);
    assert.deepEqual(c.feed, [], 'these looks change no kind');
  }

  const again = create(ctx);                                                     // the saved notes load: the history is there
  c.t = at(75);
  again.observe(snap([dev({ checkedAt: 75000, reachMs: 12 })], at(75)), null);
  c.t = at(140);
  again.observe(snap([dev({ checkedAt: 80000, reachMs: 12 })], at(140)), snap([dev({ checkedAt: 75000 })], at(75)));   // saved

  assert.deepEqual((c.stored as any).dev[0][1].k, [['wifi', { ring: '11111', ms: [12, 12, 12, 12], last: at(140) }]]);
  assert.equal(again.view().built, true);
});

test('null containers and null entries are skipped, never a throw', () => {
  const raw = (o: any) => ({ at: o.at, host: o.host, devices: o.devices, work: o.work, models: o.models, projects: o.projects });
  const good = { name: 'mac', freeMb: 4000 };
  const work = { loaded: null, loading: null, chatting: 0, plan: [], decisions: [null], llama: true };
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const steps = [
    raw({ at: at(0), host: good, devices: [dev()], work, models: [], projects: [] }),
    raw({ at: at(1), host: null, devices: null, work: null, models: null, projects: null }),
    raw({ at: at(2), host: null, devices: 'x', work: null, models: null, projects: null }),
    raw({ at: at(3), host: null, devices: [null], work: null, models: null, projects: null }),
    raw({ at: at(4), host: null, devices: [null, dev({ checkedAt: 2000, trust: null })], work: null, models: [null], projects: [null] }),
    raw({ at: at(5), host: null, devices: [{ id: 7, name: 'x', trust: null }], work: { loaded: null, decisions: [null] }, models: [null], projects: [null] }),
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    assert.doesNotThrow(() => b.observe(s, before));
    before = s;
    assert.doesNotThrow(() => b.view(), 'the eye calls view() right after every look');
    assert.equal(b.view().built, true);
    assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object/);
    assert.deepEqual(c.feed, [], 'these looks change no kind');
  }
  assert.equal(b.view().lines[0], 'x · other · not checked yet · not enough looks yet');
  assert.doesNotMatch(JSON.stringify(c.stored), /NaN|undefined|\[object/);
});

test('the ids __proto__ and constructor are ordinary ids, with no pollution', () => {
  const { c, ctx } = drive([
    snap([dev({ id: '__proto__', name: 'proto', via: 'wifi', checkedAt: 1000 }),
      dev({ id: 'constructor', name: 'ctor', via: 'wifi', checkedAt: 2000 })], at(0)),
    snap([dev({ id: '__proto__', name: 'proto', via: 'cable', plugged: true, checkedAt: 3000 }),
      dev({ id: 'constructor', name: 'ctor', via: 'cable', plugged: true, checkedAt: 4000 })], at(5)),
    snap([dev({ id: '__proto__', name: 'proto', via: 'cable', plugged: true, checkedAt: 5000 }),
      dev({ id: 'constructor', name: 'ctor', via: 'cable', plugged: true, checkedAt: 6000 })], at(70)),   // flush the save
  ]);
  assert.deepEqual((c.stored as any).dev.map((p: any) => p[0]), ['__proto__', 'constructor']);
  assert.deepEqual(c.feed, ['proto is now reached over cable (was wifi)', 'ctor is now reached over cable (was wifi)']);
  assert.equal(({} as any).name, undefined);
  assert.equal(({} as any).polluted, undefined);

  const again = create(ctx);
  again.observe(snap([dev({ id: '__proto__', name: 'proto', via: 'wifi', checkedAt: 7000 }),
    dev({ id: 'constructor', name: 'ctor', via: 'wifi', checkedAt: 8000 })], at(75)), null);
  assert.deepEqual(c.feed, ['proto is now reached over cable (was wifi)', 'ctor is now reached over cable (was wifi)',
    'proto is now reached over wifi (was cable)', 'ctor is now reached over wifi (was cable)'],
  'after the restart the remembered kind still stood, so the way back is a switch too');
  assert.equal(({} as any).name, undefined);
});

test('an id over 200 chars is skipped, so a cut id is never compared with a full one', () => {
  const long = 'x'.repeat(201);
  const { c, ctx } = drive([
    snap([dev({ id: long, name: 'long' }), dev({ id: 'p1' })], at(0)),
    snap([dev({ id: long, name: 'long' }), dev({ id: 'p1' })], at(70)),
  ]);
  assert.deepEqual((c.stored as any).dev.map((p: any) => p[0]), ['p1']);
  const again = create(ctx);
  again.observe(snap([dev({ id: long, name: 'long' }), dev({ id: 'p1' })], at(75)), null);
  assert.equal(again.view().lines[0], 'long · wifi · 192.168.1.33:50551 · reachable · 12 ms · not enough looks yet');
  assert.deepEqual((c.stored as any).dev.map((p: any) => p[0]), ['p1'], 'no entry for the long id, also after a restart');
});

test('no address, reason or trust data reaches the notes; the feed says only the name and the kinds', () => {
  const trust = {
    at: 1, error: null, id: 'ab'.repeat(16), alg: 'ed25519', pub: 'SECRET PUB', store: 'keystore', cert: 'SECRET CERT',
    certPinned: true, v1: false, paired: 1, self: 'ok', count: 3, head: 'SECRET HEAD', lines: ['SECRET LEDGER LINE'],
    restartedAt: null, rejectsDay: {}, rejectsLast: [],
  };
  const secret = { where: '192.168.1.33:50551', reason: 'SECRET REASON', trust };
  const { b, c } = drive([
    snap([dev({ via: 'cable', plugged: true, checkedAt: 1000, ...secret })], at(0)),
    snap([dev({ via: 'wifi', checkedAt: 2000, ...secret })], at(5)),
    snap([dev({ via: 'wifi', checkedAt: 3000, ...secret })], at(70)),   // flush the save
  ]);
  const out = leaked(b, c);
  assert.ok(!out.includes('SECRET'), 'no reason, pub key, certificate, head or ledger line in the notes, the view or the feed');
  assert.ok(!JSON.stringify(c.stored).includes('192.168'), 'no address in the notes');
  assert.deepEqual(c.feed, ['pixel is now reached over wifi (was cable)']);
  assert.equal((c.stored as any).dev[0][1].sw.length, 1);
});

test('no NaN, undefined, [object Object] or exponent notation reaches the view', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const steps = [
    snap([dev({ reachMs: 1e300, checkedAt: 1000 })], at(0)),              // an absurd answer time: not shown, not kept
    snap([dev({ name: { bad: true }, checkedAt: 2000, reachMs: 12 })], at(5)),
    snap([dev({ name: { bad: true }, via: { bad: true }, checkedAt: 3000, reachMs: 12 })], at(10)),
    snap([dev({ name: { bad: true }, via: { bad: true }, checkedAt: 4000 })], at(70)),   // flush the save
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    assert.doesNotThrow(() => b.observe(s, before));
    before = s;
    assert.doesNotThrow(() => b.view(), 'the eye calls view() right after every look');
    const view = JSON.stringify(b.view());
    assert.doesNotMatch(view, /NaN|undefined|\[object/);
    assert.ok(!/e\+\d/.test(view), 'no exponent notation in the view');
  }
  assert.doesNotMatch(JSON.stringify(c.stored), /NaN|undefined|\[object/);
  assert.ok(!/e\+\d/.test(JSON.stringify(c.stored)));
  assert.deepEqual(c.feed, ['p1 is now reached over other (was wifi)']);
});

test('every number in a line is whole: a decayed rate and a decayed ms never show a tail', () => {
  const looks = [];
  for (let i = 1; i <= 40; i++) looks.push(snap([dev({ checkedAt: 1000 * i, reachMs: 12.5, reachable: i !== 20 })], at(i)));
  const { b } = drive(looks);
  // 39 of 40 answered: 39 / 40 = 0.975 -> 98%; 12.5 ms rounded -> 13 ms everywhere
  assert.equal(b.view().lines[0],
    'pixel · wifi · 192.168.1.33:50551 · reachable · 13 ms · answers 98% over wifi · usually 13 ms');
});

test('where is a string cut to 60 chars; a non-string where is left out; it never reaches the notes or the feed', () => {
  const long = `192.168.1.${'x'.repeat(80)}:50551`;      // 100 chars

  const cutDrive = drive([snap([dev({ where: long, checkedAt: 1000 })], at(0))]);
  assert.equal(cutDrive.b.view().lines[0], `pixel · wifi · ${long.slice(0, 60)} · reachable · 12 ms · not enough looks yet`);

  const numDrive = drive([snap([dev({ where: 42, checkedAt: 1000 })], at(0))]);
  assert.equal(numDrive.b.view().lines[0], 'pixel · wifi · reachable · 12 ms · not enough looks yet');

  const objDrive = drive([snap([dev({ where: { bad: true }, checkedAt: 1000 })], at(0))]);
  assert.equal(objDrive.b.view().lines[0], 'pixel · wifi · reachable · 12 ms · not enough looks yet');

  // the notes and the feed never hold an address, cut or not
  assert.deepEqual(cutDrive.c.feed, [], 'no switch, and the feed never holds an address');
  assert.ok(!JSON.stringify(cutDrive.c.stored).includes('192.168'), 'no address in the notes');
  assert.ok(!JSON.stringify(cutDrive.c.stored).includes('xxx'), 'no cut address in the notes either');
});

test('switches today counts only switches proven to be today; a one-night gap does not leak in', () => {
  const { b, c } = drive([
    snap([dev({ via: 'cable', plugged: true, checkedAt: 1000 })], T - 25 * 3600_000),         // yesterday evening
    snap([dev({ via: 'wifi', checkedAt: 2000 })], T - 25 * 3600_000 + 5000),                   // a switch yesterday
    snap([dev({ via: 'cable', plugged: true, checkedAt: 3000 })], T),                          // a switch today
  ]);
  assert.deepEqual(b.view().rows[1], ['switches today', '1']);
  assert.deepEqual((c.stored as any).dev[0][1].sw.map((s: any) => s.to), ['wifi', 'cable']);
  assert.equal((c.stored as any).dev[0][1].sw.length, 2);
});

test('nine looks say not enough; the tenth says the rate', () => {
  const nine = drive(Array.from({ length: 9 }, (_, i) => snap([dev({ checkedAt: 1000 * (i + 1) })], at(i))));
  assert.equal(nine.b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · not enough looks yet');
  const ten = drive(Array.from({ length: 10 }, (_, i) => snap([dev({ checkedAt: 1000 * (i + 1) })], at(i))));
  assert.equal(ten.b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
});

test('a non-finite ctx.now() keeps the branch working and the caps in memory, and saves nothing', () => {
  const { c, ctx } = fakeCtx();
  ctx.now = () => Number.NaN;
  const b = create(ctx);
  let before: any = null;
  for (let i = 1; i <= 25; i++) {
    const s = snap([dev({ checkedAt: 1000 * i })], at(i));
    b.observe(s, before);
    before = s;
  }
  assert.equal(c.saves, 0, 'no usable clock: nothing written');
  assert.equal(b.view().lines[0], 'pixel · wifi · 192.168.1.33:50551 · reachable · 12 ms · answers 100% over wifi · usually 12 ms');
  assert.deepEqual(b.view().rows[1], ['switches today', '0']);
});

test('the assumed table is exactly the starting assumptions', () => {
  assert.deepEqual(ASSUMED, [
    { kind: 'cable', ms: 20, drops: 'rare' },
    { kind: 'wifi', ms: 80, drops: 'sometimes' },
    { kind: 'relay', ms: 300, drops: 'sometimes' },
    { kind: 'internet', ms: 150, drops: 'often' },
  ]);
  const { b } = drive([snap([], at(0))]);
  assert.deepEqual(b.view().rows[2], ['assumed', ASSUMED_LINE]);
});

test('a device that answers only at its router\'s port or ipv6 gets one card; the lan, a miss or a cable get none', async () => {
  const { cleanCard } = await import('../src/godseye/index.ts');
  const look = (devices: any[]) => drive([snap(devices, at(1))]).b.view();
  const v = look([
    dev({ id: 'p1', name: 'pixel', via: 'wifi', reachedBy: 'mapped', where: '203.0.113.7:50551 (router port, over the internet)' }),
    dev({ id: 'p2', name: 'tab', via: 'internet', reachedBy: 'ipv6' }),
    dev({ id: 'p3', name: 'home', via: 'wifi', reachedBy: 'lan' }),
    dev({ id: 'p4', name: 'gone', via: 'internet', reachedBy: 'mapped', reachable: false, reason: 'connect timeout' }),
    dev({ id: 'p5', name: 'cab', via: 'cable', reachedBy: null }),
  ]);
  const cards = v.suggestions ?? [];
  assert.deepEqual(cards.map((c: any) => c.id), ['connections:internet:p1', 'connections:internet:p2']);
  assert.equal(cards[0].title, 'pixel is reached over the internet');
  assert.match(cards[0].why, /the port its router opened.*apart mode/);
  assert.match(cards[1].why, /its ipv6 address/);
  assert.deepEqual(cards[0].action, { do: 'probe', devices: ['p1'] });
  for (const c of cards) assert.ok(cleanCard(c), 'the eye keeps the card as the branch wrote it');
  // a device id with a space still gets its card (E2); the probe asks for the device by its own id
  const odd = look([dev({ id: 'tab 2', name: 'tab', via: 'internet', reachedBy: 'ipv6' })]).suggestions ?? [];
  assert.equal(odd.length, 1);
  assert.ok(odd[0].id.startsWith('connections:internet:'), odd[0].id);
  assert.ok(cleanCard(odd[0]), 'the eye keeps the card for an id with a space');
  assert.equal((odd[0].action as any).devices[0], 'tab 2');
  // an older snapshot without reachedBy and a lan device: no card at all
  assert.equal(look([dev()]).suggestions, undefined);
  // the address never reaches a card
  assert.ok(!JSON.stringify(cards).includes('203.0.113.7'));
});
