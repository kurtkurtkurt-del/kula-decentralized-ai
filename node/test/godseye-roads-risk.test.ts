// god's eye, branch 5 connections, roads risk (17.11.2026, P1): a far device with one road while two
// or more anchors are known gets connections:one-road:<X>, its why saying how often that road (Y)
// missed in 7 days with an 80% interval over 4-hour blocks (warn 2 when it missed at least once and
// the upper end is 20% or more); this computer as
// an anchor that nothing confirmed from outside for 6 hours gets connections:anchor-unconfirmed. The
// notes keep each kept device's probes by the hour, counts only; an old file loads, a bad one is
// fresh notes. A snapshot without the new fields gives none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, missByHour, missByBlock, missByProbe, missOneRoad, ONE_ROAD_WAY, HR_MAX } = await import('../src/godseye/branches/connections.ts');
const { cleanCard } = await import('../src/godseye/index.ts');

const H = 3_600_000;
const T = Date.UTC(2026, 10, 17, 0, 0, 0);               // a whole UTC hour
const at = (s: number) => T + s * 1000;
const hr = (i: number) => T + i * H + 60_000;            // one minute into hour i

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
/** the anchor computer 'den', reached straight over the internet, offering the role */
const den = (o: Record<string, unknown> = {}) =>
  dev({ id: 'a1', name: 'den', kind: 'pc', via: 'internet', where: '203.0.113.7:50551', anchor: true, ...o });
/** a second anchor, 'office' */
const office = (o: Record<string, unknown> = {}) =>
  dev({ id: 'a2', name: 'office', kind: 'pc', via: 'internet', where: '198.51.100.9:50551', anchor: true, ...o });
/** a phone reached through den, with one road: den */
const far = (o: Record<string, unknown> = {}) =>
  dev({ via: 'anchor', through: 'a1', where: 'through den', reachMs: 300, roads: { lan: 1, direct: 0, anchors: 1 }, ...o });
const snap = (devices: any[], t: number, host: Record<string, unknown> = {}): any => ({
  at: t, host: { name: 'mac', freeMb: 4000, ...host }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});

function branch(stored: unknown = undefined) {
  const c = { t: T, stored, feed: [] as string[] };
  const ctx = {
    now: () => c.t,
    load: <X>(fallback: X): X => (c.stored === undefined ? fallback : structuredClone(c.stored) as X),
    save: (d: unknown) => { c.stored = structuredClone(d); },
    emit: (s: string) => { c.feed.push(s); },
    peek: () => null,
  };
  const b = create(ctx);
  let before: any = null;
  const step = (s: any) => { c.t = s.at + 120_000; b.observe(s, before); before = s; return b.view(); };
  return { b, c, step };
}
const ids = (v: any) => (v.suggestions ?? []).map((s: any) => s.id);
const card = (v: any, id: string) => (v.suggestions ?? []).find((s: any) => s.id === id);
const oneRoadIds = (v: any) => ids(v).filter((x: string) => x.startsWith('connections:one-road'));

/** 20 hours (or `hours`), one look each: den misses in the hours of `down`, pixel through den, office known */
function twenty(down: number[], o: { pixel?: Record<string, unknown>; extra?: any[]; hours?: number } = {}) {
  const k = branch();
  let v: any;
  for (let i = 0; i < (o.hours ?? 20); i++) {
    v = k.step(snap([
      den({ checkedAt: i + 1, reachable: !down.includes(i) }), office({ checkedAt: i + 1 }),
      far({ checkedAt: i + 1, ...o.pixel }), ...(o.extra ?? []).map((d) => ({ ...d, checkedAt: i + 1 })),
    ], hr(i)));
  }
  return { ...k, v };
}

const pcts = (s: { lo: number; hi: number }) => [Math.round(s.lo * 100), Math.round(s.hi * 100)];

test('the three ways: 2 of 20 probes over 20 hours; the hour way counts hours, the block way 4-hour blocks, the probe way probes', () => {
  const hs = Array.from({ length: 20 }, (_, i) => ({ h: i, n: 1, m: i < 2 ? 1 : 0 }));
  const h = missByHour(hs)!;
  assert.deepEqual([h.a, h.n, h.hours], [2, 20, 20]);
  assert.deepEqual(pcts(h), [4, 22]);
  // 5 blocks of 4 hours; the two misses are both in block 0, its share 2/4: 0.5 over 5 blocks
  const b = missByBlock(hs, 4)!;
  assert.deepEqual([b.a, b.n, b.hours], [2, 20, 20]);
  assert.deepEqual(pcts(b), [2, 38]);
  // a burst of 200 probes in one clean hour: the probe way narrows, the hour and block ways do not
  const burst = [...hs, { h: 20, n: 200, m: 0 }];
  assert.ok(missByProbe(burst)!.hi < 0.03, String(missByProbe(burst)!.hi));
  assert.ok(missByHour(burst)!.hi > 0.2, String(missByHour(burst)!.hi));
  assert.deepEqual(pcts(missByBlock(burst, 4)!), [2, 33], 'one more block, share 0');
  assert.equal(missByHour([]), null);
  assert.equal(missByHour([{ h: 0, n: 0, m: 0 }]), null);
  assert.equal(missByBlock([], 4), null);
  assert.equal(missByBlock([{ h: 0, n: 0, m: 0 }], 4), null, 'a block without a probe is no block');
  assert.equal(ONE_ROAD_WAY, 'block4');
  assert.deepEqual(missOneRoad(burst), missByBlock(burst, 4));
});

test('the block way: a block is floor(h/4) of the UTC hour number; its share is its misses over its probes', () => {
  const w = (hs: { h: number; n: number; m: number }[]) => { const s = missByBlock(hs, 4)!; return [s.lo, s.hi]; };
  // summed over summed: 1 of 1 and 0 of 3 in one block is 1/4, not the hours' mean 1/2
  assert.deepEqual(w([{ h: 0, n: 1, m: 1 }, { h: 1, n: 3, m: 0 }]), w([{ h: 2, n: 4, m: 1 }]));
  // hours 4 and 7 are one block, 3 and 4 two
  assert.deepEqual(w([{ h: 4, n: 1, m: 1 }, { h: 7, n: 1, m: 0 }]), w([{ h: 5, n: 2, m: 1 }]));
  assert.deepEqual(w([{ h: 3, n: 1, m: 1 }, { h: 4, n: 1, m: 0 }]), w([{ h: 3, n: 1, m: 1 }, { h: 8, n: 1, m: 0 }]));
  assert.notDeepEqual(w([{ h: 3, n: 1, m: 1 }, { h: 4, n: 1, m: 0 }]), w([{ h: 5, n: 2, m: 1 }]));
  // the hour number counts from 1970: hours of a whole UTC day start a block
  const h0 = Math.floor(T / H);
  assert.equal(h0 % 4, 0);
  assert.deepEqual(w([{ h: h0, n: 1, m: 1 }, { h: h0 + 3, n: 1, m: 0 }]), w([{ h: 0, n: 2, m: 1 }]));
});

test('one-road: one road through den while office is known too; den missed 2 of 20: warn 2 with the interval', () => {
  const { v } = twenty([3, 11]);
  const r = card(v, 'connections:one-road:p1');
  assert.ok(r, ids(v).join(','));
  assert.equal(r.kind, 'warn');
  assert.equal(r.weight, 2);
  assert.equal(r.title, 'pixel has one road from here: anchor den');
  assert.equal(r.why, 'if den goes, pixel cannot be reached from this computer. den missed 2 of 20 probes in 7 days, '
    + '80% interval 2–38%, seen from this computer only. another anchor it is paired with gives it a second road.');
  assert.deepEqual(r.action, { do: 'open', panel: 'devices' });
  assert.ok(cleanCard(r), 'the eye keeps the card as the branch wrote it');
  assert.equal(card(v, 'connections:one-anchor'), undefined, 'two anchors: no one-anchor card');
});

test('one-road: den never missed over 5 blocks: suggest 1, though the interval\'s upper end is 25%', () => {
  // zero misses over fewer than 7 blocks gives an upper end of 19-62%: no evidence of a miss, no warn
  const { v } = twenty([]);
  const r = card(v, 'connections:one-road:p1');
  assert.equal(r.kind, 'suggest');
  assert.equal(r.weight, 1);
  assert.match(r.why, /den missed 0 of 20 probes in 7 days, 80% interval 0–25%, seen from this computer only\./);
  // one hour seen, never missed: still suggest
  const one = card(twenty([], { hours: 1 }).v, 'connections:one-road:p1');
  assert.equal(one.kind, 'suggest');
  assert.match(one.why, /den missed 0 of 1 probes in 7 days, 80% interval 0–62%/);
});

test('one-road: one miss in 160 hours (40 blocks): the upper end is under 20%, suggest 1', () => {
  const { v } = twenty([50], { hours: 160 });
  const r = card(v, 'connections:one-road:p1');
  assert.equal(r.kind, 'suggest');
  assert.equal(r.weight, 1);
  assert.match(r.why, /den missed 1 of 160 probes in 7 days, 80% interval 0–\d%/);
});

test('one-road: one miss in 1 hour seen: warn 2', () => {
  const r = card(twenty([0], { hours: 1 }).v, 'connections:one-road:p1');
  assert.equal(r.kind, 'warn');
  assert.equal(r.weight, 2);
  assert.match(r.why, /den missed 1 of 1 probes in 7 days/);
});

test('one-road: the direct road is the device itself', () => {
  const { v } = twenty([5], { extra: [dev({ id: 'p2', name: 'tab', via: 'internet', reachedBy: 'mapped', where: '192.0.2.4:5', roads: { lan: 0, direct: 1, anchors: 0 } })] });
  const r = card(v, 'connections:one-road:p2');
  assert.ok(r, ids(v).join(','));
  assert.equal(r.title, 'tab has one road from here: its one internet address');
  assert.match(r.why, /^if that address goes, tab cannot be reached from this computer\. that address missed 0 of 20 probes in 7 days/);
});

test('one-road: none with one anchor known, two roads, no roads, a road through this computer or a null id, or not reachable', () => {
  // one anchor known: one-anchor says it
  const one = branch();
  let v: any;
  for (let i = 0; i < 4; i++) v = one.step(snap([den({ checkedAt: i + 1 }), far({ checkedAt: i + 1 })], hr(i)));
  assert.deepEqual(oneRoadIds(v), []);
  assert.ok(card(v, 'connections:one-anchor'));
  // two roads (an anchor and a direct address, or two anchors)
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { roads: { lan: 0, direct: 1, anchors: 1 } } }).v), []);
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { roads: { lan: 0, direct: 0, anchors: 2 } } }).v), []);
  // no roads said (an older look), or roads null
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { roads: undefined } }).v), []);
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { roads: null } }).v), []);
  // through this computer, or through a null id: nothing to count from here
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { through: 'self', throughName: 'this computer' } }).v), []);
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { through: null, throughName: 'cabin' } }).v), []);
  // not reachable now: anchor-down speaks then
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { reachable: false } }).v), []);
  // on the lan: not far
  assert.deepEqual(oneRoadIds(twenty([], { pixel: { via: 'wifi', through: undefined } }).v), []);
});

test('one-road: an anchor not probed in the last 7 days says so; the hours older than 7 days are dropped', () => {
  const k = branch();
  for (let i = 0; i < 5; i++) k.step(snap([den({ checkedAt: i + 1, reachable: i !== 2 }), office({ checkedAt: i + 1 }), far({ checkedAt: i + 1 })], hr(i)));
  // 8 days later: den's row still there, same reading (no new probe of it), pixel through it
  const later = hr(5 + 8 * 24);
  const v = k.step(snap([den({ checkedAt: 5 }), office({ checkedAt: 99 }), far({ checkedAt: 99 })], later));
  const r = card(v, 'connections:one-road:p1');
  assert.ok(r, ids(v).join(','));
  assert.equal(r.kind, 'suggest');
  assert.equal(r.why, 'if den goes, pixel cannot be reached from this computer. den was not probed from this computer in 7 days, '
    + 'so how often it is away is not known. another anchor it is paired with gives it a second road.');
  // a new probe of den: its old hours leave the notes
  k.step(snap([den({ checkedAt: 100 }), office({ checkedAt: 100 }), far({ checkedAt: 100 })], later + H));
  const a1 = (k.c.stored as any).dev.find((x: any) => x[0] === 'a1')[1];
  assert.deepEqual(a1.hr, [[Math.floor((later + H) / H), 1, 0]]);
});

test('the notes: probes by the hour, counts only; two looks in one hour are one entry; an old file loads, a bad one is fresh', () => {
  const k = branch();
  k.step(snap([den({ checkedAt: 1 }), office({ checkedAt: 1 }), far({ checkedAt: 1 })], hr(0)));
  k.step(snap([den({ checkedAt: 2, reachable: false }), office({ checkedAt: 2 }), far({ checkedAt: 2 })], hr(0) + 600_000));
  k.step(snap([den({ checkedAt: 2, reachable: false }), office({ checkedAt: 2 }), far({ checkedAt: 2 })], hr(0) + 900_000));   // the same reading: not counted
  k.step(snap([den({ checkedAt: 3 }), office({ checkedAt: 3 }), far({ checkedAt: 3 })], hr(1)));
  const file = k.c.stored as any;
  const of = (id: string) => file.dev.find((x: any) => x[0] === id)[1];
  const h0 = Math.floor(hr(0) / H);
  assert.deepEqual(of('a1').hr, [[h0, 2, 1], [h0 + 1, 1, 0]]);
  assert.deepEqual(of('p1').hr, [[h0, 2, 0], [h0 + 1, 1, 0]], 'a far row that says its roads');
  assert.doesNotMatch(JSON.stringify(file), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|through den/, 'no address in the notes');
  // a restart keeps them
  const two = branch(file);
  two.step(snap([den({ checkedAt: 4, reachable: false }), office({ checkedAt: 4 }), far({ checkedAt: 4 })], hr(1) + 60_000));
  assert.deepEqual((two.c.stored as any).dev.find((x: any) => x[0] === 'a1')[1].hr, [[h0, 2, 1], [h0 + 1, 2, 1]]);
  // an old file: no hr key
  const old = { v: 1, dev: [['a1', { name: 'den', seen: hr(0), kind: 'internet', at: 1, k: [['internet', { ring: '1', ms: [20], last: hr(0) }]], sw: [] }]] };
  const three = branch(old);
  three.step(snap([den({ checkedAt: 2 })], hr(0) + 60_000));
  const a = (three.c.stored as any).dev[0][1];
  assert.equal(a.k[0][1].ring, '11', 'the history was kept');
  assert.deepEqual(a.hr, [[h0, 1, 0]]);
  // bad hr shapes: fresh notes, never a throw
  for (const bad of [42, [[h0, 1]], [[h0, 1, 2]], [[h0, 0, 0]], [[h0 + 1, 1, 0], [h0, 1, 0]], [[-1, 1, 0]], [[h0, 1.5, 0]], [['x', 1, 0]]]) {
    const f = branch({ v: 1, dev: [['a1', { ...old.dev[0][1] as any, hr: bad }]] });
    f.step(snap([den({ checkedAt: 2 })], hr(0) + 60_000));
    assert.equal((f.c.stored as any).dev[0][1].k[0][1].ring, '1', JSON.stringify(bad));
  }
  // at most HR_MAX (7 days of) hours: 200 hourly looks keep the last 168
  assert.equal(HR_MAX, 168);
  const many = branch();
  for (let i = 0; i < 200; i++) many.step(snap([den({ checkedAt: i + 1 })], hr(i)));
  const kept = (many.c.stored as any).dev[0][1].hr;
  assert.equal(kept.length, 168);
  assert.equal(kept[0][0], h0 + 32);
});

test('a lan device without the new fields keeps no hours', () => {
  const k = branch();
  for (let i = 0; i < 3; i++) k.step(snap([dev({ checkedAt: i + 1 }), dev({ id: 'p2', name: 'tab', via: 'internet', reachedBy: 'ipv6', where: '2001:db8::7', checkedAt: i + 1 })], hr(i)));
  assert.ok(!JSON.stringify(k.c.stored).includes('"hr"'), JSON.stringify(k.c.stored));
});

const HOST = (o: Record<string, unknown> = {}) => ({ anchor: { on: true, reachable: null, links: 0, bytesDay: 0, capDay: null, since: at(0), ...o } });

test('anchor-unconfirmed: offered for 6 hours and not reached from outside', () => {
  const look = (s: number, host: Record<string, unknown>) => branch().step(snap([], at(s), host));
  const v = look(6 * 3600, HOST());
  const u = card(v, 'connections:anchor-unconfirmed');
  assert.ok(u, ids(v).join(','));
  assert.equal(u.kind, 'suggest');
  assert.equal(u.weight, 1);
  assert.equal(u.title, 'this computer\'s anchor is not confirmed from outside');
  assert.equal(u.why, 'it has offered the anchor role for 6 hours. nothing reached it from another network yet; not confirmed is not closed. '
    + 'a device in another home that joins through it confirms it.');
  assert.deepEqual(u.action, { do: 'open', panel: 'devices' });
  assert.ok(cleanCard(u));
  assert.ok(card(look(30 * 3600, HOST({ reachable: false })), 'connections:anchor-unconfirmed'), 'reachable false: not confirmed either');
  // none: under 6 hours, reached from outside, not on, no since, a since after the look
  assert.equal(card(look(6 * 3600 - 1, HOST()), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, HOST({ reachable: true })), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, HOST({ on: false })), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, HOST({ since: undefined })), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, HOST({ since: null })), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, HOST({ since: at(40 * 3600) })), 'connections:anchor-unconfirmed'), undefined);
  assert.equal(card(look(30 * 3600, { anchor: null }), 'connections:anchor-unconfirmed'), undefined);
});
