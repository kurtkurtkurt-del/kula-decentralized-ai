// god's eye, branch 5 connections, the anchor network (16.11.2026): a device reached through an
// anchor of the circle gets one card per anchor, an anchor that stops answering while a device
// behind it is cut off gets a weight-3 card with one feed line in and one out, a single anchor with
// far devices gets a suggestion through the hysteresis, remote devices hand the deciding branches
// their loss, the notes remember the last anchor id (an id only) and an old notes file still
// loads, and a snapshot without the new fields gives none of it. P1b: a device through 'self' (this
// computer is the anchor) reads "through this computer (its anchor)", never gives anchor-down and
// counts once for one-anchor; a throughName names an anchor that is not a row of the look, or one
// with a null id (its card keyed by the name, no anchor-down); the notes keep ids only. VERDICT 1
// DO 4: an anchor absent from the look gives no anchor-down card and is forgotten as a device's
// last anchor; a reachable row via anchor through a null id clears the old one. P1 (17.11.2026): an
// anchor's probes are kept by the hour, counts only (godseye-roads-risk.test.ts has the rest).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, ASSUMED } = await import('../src/godseye/branches/connections.ts');
const { cleanCard } = await import('../src/godseye/index.ts');
const { cardId: cardIdOf } = await import('../src/godseye/branches/decide.ts');

const T = new Date(2026, 10, 16, 21, 0, 0).getTime();   // Monday 16 November 2026, 21:00 local
const at = (s: number) => T + s * 1000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
/** the anchor computer 'den', reached straight over the internet, offering the role */
const den = (o: Record<string, unknown> = {}) =>
  dev({ id: 'a1', name: 'den', kind: 'pc', via: 'internet', where: '203.0.113.7:50551', anchor: true, ...o });
/** a phone reached through den */
const far = (o: Record<string, unknown> = {}) =>
  dev({ via: 'anchor', through: 'a1', where: 'through den', reachMs: 300, ...o });
const snap = (devices: any[], t: number, host: Record<string, unknown> = {}): any => ({
  at: t, host: { name: 'mac', freeMb: 4000, ...host }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});

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

/** a branch with a step(snapshot) that feeds one look; the wall clock follows the snapshot */
function branch(stored: unknown = undefined) {
  const { c, ctx } = fakeCtx(stored);
  const b = create(ctx);
  let before: any = null;
  const step = (s: any) => { c.t = s.at; b.observe(s, before); before = s; return b.view(); };
  return { b, c, step };
}
const ids = (v: any) => (v.suggestions ?? []).map((s: any) => s.id);
const card = (v: any, id: string) => (v.suggestions ?? []).find((s: any) => s.id === id);

test('the assumed table knows the anchor', () => {
  assert.deepEqual(ASSUMED.find((a: any) => a.kind === 'anchor'), { kind: 'anchor', ms: 300, drops: 'sometimes' });
});

test('through: one card per anchor while a device is reached through it; it goes when the device is back on the wi-fi', () => {
  const { c, step } = branch();
  step(snap([den({ checkedAt: 1 }), dev({ checkedAt: 1 })], at(0)));
  let v = step(snap([den({ checkedAt: 2 }), far({ checkedAt: 2 })], at(10)));
  assert.equal(v.stat, '0 cable · 0 wi-fi · 1 internet · 1 anchor');
  assert.ok(c.feed.includes('pixel is now reached through anchor den (was wifi)'), c.feed.join('|'));
  const t = card(v, 'connections:through:a1');
  assert.ok(t, ids(v).join(','));
  assert.equal(t.kind, 'warn');
  assert.equal(t.weight, 1);
  assert.equal(t.title, 'pixel is reached through anchor den');
  assert.equal(t.why, 'neither their wi-fi nor a direct internet address answered. den passes the bytes on and cannot read them. '
    + 'not enough looks yet. apart and split both work; the planner says what a split would cost.');
  assert.deepEqual(t.action, { do: 'probe', devices: ['p1'] });
  assert.equal(t.label, 'look again');
  assert.ok(cleanCard(t), 'the eye keeps the card as the branch wrote it');
  // no internet card for a device reached through the anchor
  assert.equal(card(v, 'connections:internet:p1'), undefined);
  // ten anchor readings: the usual time and how many probes it is from
  for (let i = 3; i <= 11; i++) v = step(snap([den({ checkedAt: i }), far({ checkedAt: i })], at(10 * i)));
  assert.match(card(v, 'connections:through:a1').why, /usually ~300 ms \(from 10 probes\)\./);
  // the line says the remote words of the anchor kind
  assert.match(v.lines[1], /^pixel · anchor · through den · reachable · 300 ms · answers 100% over anchor · usually 300 ms · 8 in 10 answers within 300 ms/);
  // back on the wi-fi: the card goes, one switch line
  v = step(snap([den({ checkedAt: 20 }), dev({ checkedAt: 20 })], at(200)));
  assert.equal(card(v, 'connections:through:a1'), undefined);
  assert.ok(c.feed.includes('pixel is now reached over wifi (was anchor)'));
});

test('through: several devices behind one anchor share its card; two anchors give two', () => {
  const v = branch().step(snap([
    den(), dev({ id: 'a2', name: 'office', kind: 'pc', via: 'internet', anchor: true }),
    far({ id: 'p1', name: 'pixel' }), far({ id: 'p2', name: 'tab' }), far({ id: 'p3', name: 'watch' }),
    far({ id: 'p4', name: 'mum', through: 'a2' }),
    far({ id: 'p5', name: 'off', reachable: false, reason: 'connect timeout' }),   // not reachable: not on this card
  ], at(0)));
  const a1 = card(v, 'connections:through:a1');
  assert.equal(a1.title, 'pixel, tab (+1 more) are reached through anchor den');
  assert.deepEqual(a1.action, { do: 'probe', devices: ['p1', 'p2', 'p3'] });
  assert.equal(card(v, 'connections:through:a2').title, 'mum is reached through anchor office');
});

test('through: an anchor this computer cannot name reads "an anchor"', () => {
  const v = branch().step(snap([far({ through: 'zz9' })], at(0)));
  const t = card(v, 'connections:through:zz9');
  assert.equal(t.title, 'pixel is reached through an anchor');
  assert.match(t.why, /the anchor passes the bytes on/);
  const { c, step } = branch();
  step(snap([dev({ checkedAt: 1 })], at(0)));
  step(snap([far({ through: 'zz9', checkedAt: 2 })], at(10)));
  assert.deepEqual(c.feed, ['pixel is now reached through an anchor (was wifi)']);
});

test('anchor-down: shows on the third missed reading of the anchor while a device behind it is cut off; goes when the anchor answers', () => {
  const { c, step } = branch();
  step(snap([den({ checkedAt: 1 }), far({ checkedAt: 1 })], at(0)));            // p1 routed through den
  const downLook = (i: number) => snap([
    den({ checkedAt: 100 + i, reachable: false, reason: 'connect timeout' }),
    dev({ checkedAt: 100 + i, reachable: false, reason: 'connect timeout' }),   // its row fell back to wifi: still last through den
  ], at(10 * i));
  let v = step(downLook(1));
  assert.equal(card(v, 'connections:anchor-down:a1'), undefined, 'one miss is not down');
  v = step(downLook(2));
  assert.equal(card(v, 'connections:anchor-down:a1'), undefined, 'two misses are not down');
  v = step(downLook(2));                                                          // the same readings again: not a new miss
  assert.equal(card(v, 'connections:anchor-down:a1'), undefined);
  v = step(downLook(3));
  const d = card(v, 'connections:anchor-down:a1');
  assert.ok(d, ids(v).join(','));
  assert.equal(d.kind, 'warn');
  assert.equal(d.weight, 3);
  assert.equal(d.title, 'anchor den is not answering: pixel cannot be reached');
  assert.equal(d.why, 'they were last reached through anchor den. they return when den answers or on this wi-fi. seen from this computer only.');
  assert.deepEqual(d.action, { do: 'probe', devices: ['a1', 'p1'] });
  assert.ok(cleanCard(d));
  v = step(downLook(4));
  assert.ok(card(v, 'connections:anchor-down:a1'), 'it stays');
  assert.equal(c.feed.filter((l) => l === d.title).length, 1, 'one feed line when it shows');
  // den answers once: the card goes, one line
  v = step(snap([den({ checkedAt: 200 }), dev({ checkedAt: 200, reachable: false, reason: 'connect timeout' })], at(100)));
  assert.equal(card(v, 'connections:anchor-down:a1'), undefined);
  assert.deepEqual(c.feed.slice(-1), ['anchor den answers again']);
});

test('anchor-down: an anchor that left the look is not "not answering": no card, and the devices through it forget it', () => {
  const { c, step } = branch();
  step(snap([den({ checkedAt: 1 }), far({ id: 'p1', checkedAt: 1 }), far({ id: 'p2', name: 'tab', checkedAt: 1 })], at(0)));
  const thruOf = (id: string) => (c.stored as any).dev.find((x: any) => x[0] === id)[1].thru;
  assert.equal(thruOf('p1'), 'a1');
  let v: any;
  for (let i = 2; i <= 6; i++) {
    v = step(snap([
      far({ id: 'p1', checkedAt: i, reachable: false, reason: 'no route' }),
      far({ id: 'p2', name: 'tab', checkedAt: i, reachable: false, reason: 'no route' }),
    ], at(70 * i)));
    assert.ok(!ids(v).some((x: string) => x.startsWith('connections:anchor-down')), ids(v).join(','));
  }
  assert.equal(thruOf('p1'), undefined, 'den left the look: p1 forgets it');
  assert.equal(thruOf('p2'), undefined);
  // den comes back and misses three readings, p1 cut off through its row's wifi fallback: still no
  // card, p1 no longer counts as last routed through den
  for (let i = 7; i <= 10; i++) {
    v = step(snap([
      den({ checkedAt: i, reachable: false, reason: 'connect timeout' }),
      dev({ id: 'p1', checkedAt: i, reachable: false, reason: 'connect timeout' }),
    ], at(70 * i)));
  }
  assert.equal(card(v, 'connections:anchor-down:a1'), undefined, ids(v).join(','));
  assert.ok(!c.feed.some((l) => /not answering|cut off now/.test(l)), c.feed.join('|'));
});

test('anchor-down: a reachable row via anchor through a null id clears the old anchor; a later outage names no wrong anchor', () => {
  const { c, step } = branch();
  step(snap([den({ checkedAt: 1 }), far({ checkedAt: 1 })], at(0)));             // p1 through den: thru a1
  const thruOf = () => (c.stored as any).dev.find((x: any) => x[0] === 'p1')[1].thru;
  assert.equal(thruOf(), 'a1');
  step(snap([den({ checkedAt: 2 }), far({ through: null, checkedAt: 2 })], at(70)));   // still via anchor, which one unknown
  assert.equal(thruOf(), undefined, 'the old thru is cleared');
  let v: any;
  for (let i = 3; i <= 6; i++) {
    v = step(snap([
      den({ checkedAt: i, reachable: false, reason: 'connect timeout' }),
      far({ through: null, checkedAt: i, reachable: false }),
    ], at(70 * i)));
  }
  assert.ok(!ids(v).some((x: string) => x.startsWith('connections:anchor-down')), ids(v).join(','));
  // an unreachable row through a null id keeps what it had (it says nothing new)
  const k = branch();
  k.step(snap([den({ checkedAt: 1 }), far({ checkedAt: 1 })], at(0)));
  k.step(snap([den({ checkedAt: 2 }), far({ through: null, checkedAt: 2, reachable: false })], at(70)));
  assert.equal((k.c.stored as any).dev.find((x: any) => x[0] === 'p1')[1].thru, 'a1');
});

test('anchor-down: an anchor of the look this computer cannot name reads "an anchor"', () => {
  const { step } = branch();
  step(snap([den({ id: 'zz9', name: '', checkedAt: 1 }), far({ through: 'zz9', checkedAt: 1 })], at(0)));
  let v: any;
  for (let i = 2; i <= 4; i++) {
    v = step(snap([den({ id: 'zz9', name: '', checkedAt: i, reachable: false }), far({ through: 'zz9', checkedAt: i, reachable: false })], at(10 * i)));
  }
  assert.equal(card(v, 'connections:anchor-down:zz9').title, 'an anchor is not answering: pixel cannot be reached');
  assert.match(card(v, 'connections:anchor-down:zz9').why, /^they were last reached through an anchor\. they return when it answers/);
});

test('one-anchor: one anchor and a far device show after 3 looks and go 4 looks after; two anchors give nothing', () => {
  const { step } = branch();
  const look = (i: number) => snap([den({ checkedAt: i }), far({ checkedAt: i })], at(10 * i));
  assert.equal(card(step(look(1)), 'connections:one-anchor'), undefined);
  assert.equal(card(step(look(2)), 'connections:one-anchor'), undefined);
  const v = step(look(3));
  const o = card(v, 'connections:one-anchor');
  assert.ok(o, ids(v).join(','));
  assert.equal(o.kind, 'suggest');
  assert.equal(o.weight, 1);
  assert.equal(o.title, 'only one anchor (den): if it goes, far devices lose each other');
  assert.equal(o.why, 'a second always-on computer in another home, made an anchor, keeps the circle up. this computer knows only the anchors it is paired with.');
  assert.deepEqual(o.action, { do: 'open', panel: 'devices' });
  assert.ok(cleanCard(o));
  // no far device any more (all on the lan): it stays 3 looks, goes on the 4th
  const lan = (i: number) => snap([den({ via: 'wifi', checkedAt: i }), dev({ checkedAt: i })], at(10 * i));
  for (let i = 4; i <= 6; i++) assert.ok(card(step(lan(i)), 'connections:one-anchor'), `look ${i}`);
  assert.equal(card(step(lan(7)), 'connections:one-anchor'), undefined);

  // a second anchor: this computer offers the role too
  const two = branch();
  for (let i = 1; i <= 5; i++) {
    assert.equal(card(two.step(snap([den({ checkedAt: i }), far({ checkedAt: i })], at(10 * i),
      { anchor: { on: true, reachable: true, links: 1, bytesDay: 0, capDay: null } })), 'connections:one-anchor'), undefined);
  }
  // this computer as the only anchor
  const host = branch();
  let v2: any;
  for (let i = 1; i <= 3; i++) {
    v2 = host.step(snap([dev({ via: 'internet', checkedAt: i })], at(10 * i),
      { anchor: { on: true, reachable: true, links: 1, bytesDay: 0, capDay: null } }));
  }
  assert.equal(card(v2, 'connections:one-anchor').title, 'only one anchor (this computer): if it goes, far devices lose each other');
  // an anchor and no far device: nothing
  const near = branch();
  for (let i = 1; i <= 5; i++) assert.equal(card(near.step(snap([den({ via: 'wifi', checkedAt: i })], at(10 * i))), 'connections:one-anchor'), undefined);
});

test('E2: one-anchor proposes turning this computer\'s anchor on only when its role is off and the one anchor is far', () => {
  const HOST_OFF = { anchor: { on: false, reachable: null, links: 0, bytesDay: 0, capDay: null } };
  const run = (devices: (i: number) => any[], host: Record<string, unknown>) => {
    const b = branch();
    let v: any;
    for (let i = 1; i <= 3; i++) v = b.step(snap(devices(i), at(10 * i), host));
    return card(v, 'connections:one-anchor');
  };
  const o = run((i) => [den({ checkedAt: i }), far({ checkedAt: i })], HOST_OFF);
  assert.deepEqual(o.action, { do: 'anchor', on: true });
  assert.equal(o.label, 'make this an anchor');
  assert.ok(cleanCard(o));
  // the one anchor on the wi-fi (a near row), a far device elsewhere: only the devices panel
  const nearAnchor = run((i) => [den({ via: 'wifi', where: '192.168.1.40:50551', checkedAt: i }), dev({ id: 'p2', via: 'internet', where: '203.0.113.9:50551', checkedAt: i })], HOST_OFF);
  assert.deepEqual(nearAnchor.action, { do: 'open', panel: 'devices' });
  // no host.anchor in the look (an older engine): as before
  assert.deepEqual(run((i) => [den({ checkedAt: i }), far({ checkedAt: i })], {}).action, { do: 'open', panel: 'devices' });
});

test('the loss hint: a remote device with 10 probes, never a lan one or one with fewer', () => {
  const { step } = branch();
  let v: any;
  for (let i = 1; i <= 10; i++) {
    v = step(snap([
      far({ id: 'p1', checkedAt: i, reachable: i !== 3 }),        // 1 of 10 missed
      dev({ id: 'p2', name: 'lan', checkedAt: i }),               // the lan: no hint
      dev({ id: 'p3', name: 'new', via: 'internet', checkedAt: i < 10 ? i : 9 }),   // 9 probes only
    ], at(10 * i)));
  }
  assert.equal(v.hints.length, 1);
  assert.equal(v.hints[0].id, 'p1');
  // Wilson 80% of 1 in 10, upper end: (0.1 + 0.082125 + 1.2816 * sqrt(0.009 + 0.0041063)) / 1.16425 = 0.2825
  assert.equal(Math.round(v.hints[0].loss.hi * 1e4), 2825);
  assert.deepEqual(Object.keys(v.hints[0]), ['id', 'loss']);
});

test('the notes: thru is an id only, survives a restart, and an old notes file (no thru) loads', () => {
  const one = branch();
  one.step(snap([den({ checkedAt: 1 }), far({ checkedAt: 1 })], at(0)));
  const file = one.c.stored as any;
  const p1 = file.dev.find((x: any) => x[0] === 'p1')[1];
  assert.equal(p1.thru, 'a1');
  assert.deepEqual(Object.keys(p1), ['name', 'seen', 'kind', 'at', 'k', 'sw', 'thru']);
  assert.ok(!('thru' in file.dev.find((x: any) => x[0] === 'a1')[1]), 'no thru: today\'s shape');
  // P1 (17.11.2026): the anchor's probes by the hour, counts only; p1 says no roads, so none of its own
  assert.deepEqual(file.dev.find((x: any) => x[0] === 'a1')[1].hr, [[Math.floor(at(0) / 3_600_000), 1, 0]]);
  assert.doesNotMatch(JSON.stringify(file), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|through den/, 'no address in the notes');
  // a restart: the anchor misses three readings, the device is cut off: the remembered thru names the anchor
  const two = branch(file);
  let v: any;
  for (let i = 5; i <= 7; i++) {
    v = two.step(snap([den({ checkedAt: i, reachable: false }), dev({ checkedAt: i, reachable: false })], at(100 * i)));
  }
  assert.equal(card(v, 'connections:anchor-down:a1').title, 'anchor den is not answering: pixel cannot be reached');
  // an old file: today's shape before 16 Nov, no thru key
  const old = { v: 1, dev: [['p1', { name: 'pixel', seen: at(0), kind: 'wifi', at: 1, k: [['wifi', { ring: '1111', ms: [12, 12, 12, 12], last: at(0) }]], sw: [] }]] };
  const three = branch(old);
  three.step(snap([dev({ checkedAt: 2 })], at(70)));
  const p = (three.c.stored as any).dev[0][1];
  assert.equal(p.k[0][1].ring, '11111', 'the history was kept');
  assert.ok(!('thru' in p));
  // a thru that is not an id is not this file's shape: fresh notes, never a throw
  const bad = { v: 1, dev: [['p1', { ...old.dev[0][1] as any, thru: 42 }]] };
  const four = branch(bad);
  four.step(snap([dev({ checkedAt: 2 })], at(70)));
  assert.equal((four.c.stored as any).dev[0][1].k[0][1].ring, '1');
});

test('a snapshot without the new fields gives none of it', () => {
  const { b, c, step } = branch();
  let v: any;
  for (let i = 1; i <= 12; i++) {
    v = step(snap([
      dev({ id: 'p1', checkedAt: i }),
      dev({ id: 'p2', name: 'tab', via: 'internet', reachedBy: 'ipv6', where: '2001:db8::7', checkedAt: i }),
      dev({ id: 'p3', name: 'old', via: 'relay', where: 'relay pc', checkedAt: i, reachable: i % 2 === 0 }),
    ], at(10 * i)));
  }
  assert.ok(!/anchor/.test(v.stat), v.stat);
  assert.deepEqual(ids(v), ['connections:internet:p2']);
  assert.ok(!c.feed.some((l) => /anchor/.test(l)), c.feed.join('|'));
  assert.ok(!JSON.stringify(c.stored).includes('thru'));
  assert.ok(!JSON.stringify(b.view().suggestions).includes('anchor'));
});

// P1b: through 'self' (this computer is the anchor) and throughName (the anchor's name the engine knows)
const HOST_ON = { anchor: { on: true, reachable: true, links: 1, bytesDay: 0, capDay: null } };

test('through self: "reached through this computer (its anchor)", no thru, never an anchor-down card', () => {
  const { c, step } = branch();
  step(snap([den({ checkedAt: 1 }), far({ checkedAt: 1 })], at(0)));             // first through den: thru a1
  assert.equal((c.stored as any).dev.find((x: any) => x[0] === 'p1')[1].thru, 'a1');
  let v = step(snap([den({ checkedAt: 2 }), far({ through: 'self', throughName: 'this computer', checkedAt: 2 })], at(100), HOST_ON));
  const t = card(v, 'connections:through:self');
  assert.ok(t, ids(v).join(','));
  assert.equal(t.title, 'pixel is reached through this computer (its anchor)');
  assert.match(t.why, /this computer passes the bytes on and cannot read them/);
  assert.equal(card(v, 'connections:through:a1'), undefined);
  assert.ok(cleanCard(t));
  // through self clears the last other anchor: the notes keep no thru
  assert.ok(!('thru' in (c.stored as any).dev.find((x: any) => x[0] === 'p1')[1]));
  assert.doesNotMatch(JSON.stringify(c.stored), /this computer/, 'no name of an anchor in the notes');
  // cut off, den gone, for many looks: no anchor-down of any kind
  for (let i = 3; i <= 8; i++) {
    v = step(snap([far({ through: 'self', throughName: 'this computer', checkedAt: i, reachable: false })], at(100 * i), HOST_ON));
    assert.ok(!ids(v).some((x: string) => x.startsWith('connections:anchor-down')), ids(v).join(','));
  }
  assert.ok(!c.feed.some((l) => /not answering/.test(l)), c.feed.join('|'));
  // the switch line from the wi-fi
  const w = branch();
  w.step(snap([dev({ checkedAt: 1 })], at(0)));
  w.step(snap([far({ through: 'self', throughName: 'this computer', checkedAt: 2 })], at(10), HOST_ON));
  assert.deepEqual(w.c.feed, ['pixel is now reached through this computer (its anchor, was wifi)']);
  // a 'self' left in older notes gives no anchor-down either
  const old = { v: 1, dev: [['p1', { name: 'pixel', seen: at(0), kind: 'anchor', at: 1, k: [['anchor', { ring: '1', ms: [300], last: at(0) }]], sw: [], thru: 'self' }]] };
  const o = branch(old);
  const ov = o.step(snap([dev({ checkedAt: 2, reachable: false })], at(10)));
  assert.ok(!ids(ov).some((x: string) => x.startsWith('connections:anchor-down')), ids(ov).join(','));
});

test('one-anchor: a device through self counts this computer once, beside host.anchor.on or without it', () => {
  const run = (host: Record<string, unknown>, extra: any[] = []) => {
    const b = branch();
    let v: any;
    for (let i = 1; i <= 3; i++) v = b.step(snap([...extra.map((d) => ({ ...d, checkedAt: i })), far({ through: 'self', throughName: 'this computer', checkedAt: i })], at(10 * i), host));
    return card(v, 'connections:one-anchor');
  };
  assert.equal(run(HOST_ON).title, 'only one anchor (this computer): if it goes, far devices lose each other', 'no double count');
  assert.equal(run({}).title, 'only one anchor (this computer): if it goes, far devices lose each other', 'no host.anchor: the row says it');
  assert.equal(run(HOST_ON, [den()]), undefined, 'den and this computer: two anchors');
});

test('throughName with a null id: the name in the title, a card keyed by the name, no anchor-down, no name in the notes', () => {
  const { c, step } = branch();
  step(snap([dev({ checkedAt: 1 })], at(0)));
  let v = step(snap([far({ through: null, throughName: '3fa9c1d2…', checkedAt: 2 })], at(100)));
  const id = cardIdOf('connections', 'through', 'name:3fa9c1d2…');
  const t = card(v, id);
  assert.ok(t, ids(v).join(','));
  assert.equal(t.title, 'pixel is reached through anchor 3fa9c1d2…');
  assert.match(t.why, /3fa9c1d2… passes the bytes on/);
  assert.ok(cleanCard(t));
  assert.deepEqual(c.feed, ['pixel is now reached through anchor 3fa9c1d2… (was wifi)']);
  for (let i = 3; i <= 8; i++) {
    v = step(snap([far({ through: null, throughName: '3fa9c1d2…', checkedAt: i, reachable: false })], at(100 * i)));
    assert.ok(!ids(v).some((x: string) => x.startsWith('connections:anchor-down')), ids(v).join(','));
  }
  assert.ok(!JSON.stringify(c.stored).includes('thru'));
  assert.ok(!JSON.stringify(c.stored).includes('3fa9c1d2'));
  // a null id with no name says nothing (as before)
  const n = branch().step(snap([far({ through: null, checkedAt: 1 })], at(0)));
  assert.ok(!ids(n).some((x: string) => x.startsWith('connections:through')), ids(n).join(','));
});

test('throughName for an id not in the look: the name in the through card and the switch line; no anchor-down, no thru', () => {
  const { c, step } = branch();
  step(snap([dev({ checkedAt: 1 })], at(0)));
  let v = step(snap([far({ through: 'zz9', throughName: 'cabin', checkedAt: 2 })], at(100)));
  const t = card(v, 'connections:through:zz9');
  assert.equal(t.title, 'pixel is reached through anchor cabin');
  assert.match(t.why, /cabin passes the bytes on/);
  assert.deepEqual(c.feed, ['pixel is now reached through anchor cabin (was wifi)']);
  for (let i = 3; i <= 6; i++) {
    v = step(snap([far({ through: 'zz9', throughName: 'cabin', checkedAt: i, reachable: false })], at(100 * i)));
    assert.ok(!ids(v).some((x: string) => x.startsWith('connections:anchor-down')), ids(v).join(','));
  }
  const p1 = (c.stored as any).dev.find((x: any) => x[0] === 'p1')[1];
  assert.ok(!('thru' in p1), 'zz9 is not a row of the look: not kept as the anchor it went through');
  assert.ok(!JSON.stringify(c.stored).includes('cabin'), 'ids only, never a name of an anchor');
  // a row of the look names the anchor: its own name wins over a throughName
  const r = branch().step(snap([den({ checkedAt: 1 }), far({ throughName: 'old name', checkedAt: 1 })], at(0)));
  assert.equal(card(r, 'connections:through:a1').title, 'pixel is reached through anchor den');
});
