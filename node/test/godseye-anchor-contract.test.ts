// the brain's side of the anchor network contract (16.11.2026): a device's via 'anchor', through
// (an id, or 'self' when this computer is the anchor), throughName and anchor, the host's anchor
// counters (memberMaxDay included, P1b) and its gate's refusals, as guard.ts cleans them. Each
// field valid, absent and garbage; a healthy look with all of them comes out deep-equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clean } from '../src/godseye/branches/guard.ts';
import { BRANCHES } from '../src/godseye/types.ts';

const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);
const stand = (id: string) => `~${hash(id)}~${id.slice(0, 40).replace(/[^A-Za-z0-9._:-]/g, '_')}`;

const dev = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true,
  reachMs: 12, reason: null, checkedAt: 900, lastOk: '2026-11-10T08:00:00Z', ramMb: 3400, bwGBs: 60,
  gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null, ...extra,
});

const H = 3_600_000;
const T0 = 1_794_000_000_000 - (1_794_000_000_000 % H);
const gate = () => ({
  hours: Array.from({ length: 26 }, (_, i) => ({ start: T0 + i * H, by: i === 25 ? { 'no hello': 3, 'rpc guard': 1 } : {}, far: i === 25 ? 2 : 0 })),
  nets: 2,
  guard: [{ t: T0 + 25 * H + 5, why: 'rpc guard: op 7' }],
});

/** every new field set and valid, beside the fields every look has */
const healthy = (): Record<string, unknown> => ({
  at: T0 + 25 * H + 10,
  host: {
    name: 'mac', freeMb: 4000, ledger: { ok: true, count: 12, problem: null },
    anchor: { on: true, reachable: null, links: 3, bytesDay: 5e9, capDay: 2e10, memberMaxDay: 3e9 },
    gate: gate(),
  },
  devices: [
    dev({ id: 'far1', via: 'anchor', through: 'anc1', throughName: 'home mac', where: 'through anchor home mac' }),
    dev({ id: 'anc1', via: 'internet', reachedBy: 'mapped', anchor: true, through: null }),
    dev({ id: 'p2', anchor: false }),
    dev({ id: 'far2', via: 'anchor', through: 'self', throughName: 'this computer', where: 'through this computer (its anchor)' }),
    dev({ id: 'far3', via: 'anchor', through: null, throughName: '3fa9c1d2…', where: 'through anchor 3fa9c1d2…' }),
  ],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false },
  models: [],
  projects: [],
});

test('a healthy look with every anchor field comes out deep-equal, and is not changed on the way', () => {
  const s = structuredClone(healthy());
  assert.deepStrictEqual(clean(s), s);
  assert.deepStrictEqual(s, structuredClone(healthy()));
});

test('a look without any of the new fields stays without them', () => {
  const s = clean({ at: 1, host: { name: 'mac', freeMb: 1 }, devices: [dev()] })!;
  assert.equal('anchor' in s.host, false);
  assert.equal('gate' in s.host, false);
  assert.equal('through' in s.devices[0], false);
  assert.equal('throughName' in s.devices[0], false);
  assert.equal('anchor' in s.devices[0], false);
  assert.deepStrictEqual(clean(structuredClone(s)), s);
  // a host anchor from an engine that does not count members leaves memberMaxDay out
  const h = clean({ at: 1, host: { name: 'mac', freeMb: 1, anchor: { on: true, reachable: null, links: 1, bytesDay: 2, capDay: 3 } } })!;
  assert.equal('memberMaxDay' in h.host.anchor!, false);
});

test('through: \'self\' (this computer is the anchor) passes as \'self\'', () => {
  assert.equal(clean({ at: 1, devices: [dev({ via: 'anchor', through: 'self' })] })!.devices[0].through, 'self');
});

test('throughName: a name cleaned and cut to 80, anything else or empty null', () => {
  const n = (x: unknown) => clean({ at: 1, devices: [dev({ via: 'anchor', throughName: x })] })!.devices[0].throughName;
  assert.equal(n('home mac'), 'home mac');
  assert.equal(n('this computer'), 'this computer');
  assert.equal(n('y'.repeat(300)), 'y'.repeat(80));
  assert.equal(n('evil‮\ncard'), 'evil card');
  assert.equal(n(''), null);
  assert.equal(n('  ​ '), null);
  assert.equal(n(null), null);
  assert.equal(n(42), null);
  assert.equal(n({ name: 'x' }), null);
});

test('host.anchor.memberMaxDay: kept, clamped 0..1e15, null when not a number', () => {
  const m = (x: unknown) => clean({ at: 1, host: { name: 'mac', freeMb: 1, anchor: { on: true, reachable: null, links: 2, bytesDay: 9, capDay: 8, memberMaxDay: x } } })!.host.anchor!.memberMaxDay;
  assert.equal(m(4e9), 4e9);
  assert.equal(m(0), 0);
  assert.equal(m(-5), 0);
  assert.equal(m(1e20), 1e15);
  assert.equal(m(null), null);
  assert.equal(m('3 GB'), null);
  assert.equal(m(NaN), null);
  assert.equal(m(Infinity), null);
});

test('via: anchor passes as a word, as every via does', () => {
  assert.equal(clean({ at: 1, devices: [dev({ via: 'anchor' })] })!.devices[0].via, 'anchor');
});

test('through: a usable id kept, this machine\'s ids and unsafe ids under their stand-in, anything else null', () => {
  const t = (x: unknown) => clean({ at: 1, devices: [dev({ through: x })] })!.devices[0].through;
  assert.equal(t('anc1'), 'anc1');
  assert.equal(t(null), null);
  assert.equal(t(''), null);
  assert.equal(t(42), null);
  assert.equal(t({ id: 'x' }), null);
  assert.equal(t('local'), stand('local'));
  assert.equal(t('__proto__'), stand('__proto__'));
  assert.equal(t('x'.repeat(250)), stand('x'.repeat(250)));
  // the same stand-in as the device it names
  const s = clean({ at: 1, devices: [dev({ id: 'x'.repeat(250) }), dev({ id: 'f', through: 'x'.repeat(250) })] })!;
  assert.equal(s.devices[1].through, s.devices[0].id);
});

test('a device\'s anchor: true and false kept, anything else false', () => {
  const a = (x: unknown) => clean({ at: 1, devices: [dev({ anchor: x })] })!.devices[0].anchor;
  assert.equal(a(true), true);
  assert.equal(a(false), false);
  assert.equal(a('yes'), false);
  assert.equal(a(1), false);
  assert.equal(a(null), false);
});

test('host.anchor: counts clamped, flags as their kind, capDay null when not a number, garbage null', () => {
  const a = (x: unknown) => clean({ at: 1, host: { name: 'mac', freeMb: 1, anchor: x } })!.host.anchor;
  assert.equal(a(null), null);
  assert.equal(a('on'), null);
  assert.equal(a(7), null);
  assert.deepStrictEqual(a({}), { on: false, reachable: null, links: 0, bytesDay: 0, capDay: null });
  assert.deepStrictEqual(
    a({ on: 'yes', reachable: 1, links: 5e9, bytesDay: 1e20, capDay: '5 GB' }),
    { on: false, reachable: null, links: 1e6, bytesDay: 1e15, capDay: null },
  );
  assert.deepStrictEqual(
    a({ on: true, reachable: false, links: -3, bytesDay: NaN, capDay: 2e16 }),
    { on: true, reachable: false, links: 0, bytesDay: 0, capDay: 1e15 },
  );
  assert.deepStrictEqual(a({ on: true, reachable: true, links: 2, bytesDay: 10, capDay: -1 })!.capDay, 0);
});

test('host.gate: garbage null; hours need a usable start, the last 26 kept; by cleaned; guard the last 5', () => {
  const g = (x: unknown) => clean({ at: 1, host: { name: 'mac', freeMb: 1, gate: x } })!.host.gate;
  assert.equal(g(null), null);
  assert.equal(g('gate'), null);
  assert.deepStrictEqual(g({}), { hours: [], nets: 0, guard: [] });
  assert.deepStrictEqual(g({ hours: 'x', nets: 'many', guard: 3 }), { hours: [], nets: 0, guard: [] });

  const hours = [
    null, 'x', { start: -1, by: {}, far: 1 }, { start: 'now', by: {}, far: 1 }, { by: {}, far: 1 },
    ...Array.from({ length: 30 }, (_, i) => ({ start: T0 + i * H, by: { 'no hello': i }, far: i })),
  ];
  const out = g({ hours, nets: 1, guard: [] })!;
  assert.equal(out.hours.length, 26);
  assert.equal(out.hours[0].start, T0 + 4 * H);
  assert.equal(out.hours[25].start, T0 + 29 * H);

  const by: Record<string, unknown> = { 'no hello': 2, tls: 'two', ['x'.repeat(201)]: 1, constructor: 5, 'rpc guard': 1e12, 'not paired': -4 };
  for (let i = 0; i < 50; i++) by[`r${i}`] = 1;
  const one = g({ hours: [{ start: T0, by, far: 1e12 }] })!.hours[0];
  assert.deepStrictEqual(Object.getPrototypeOf(one.by), Object.prototype);
  assert.equal(one.by['no hello'], 2);
  assert.equal('tls' in one.by, false);
  assert.equal(Object.keys(one.by).some((k) => k.length > 200), false);
  assert.equal(Object.hasOwn(one.by, 'constructor'), false);
  assert.equal(one.by['rpc guard'], 1e9);
  assert.equal(one.by['not paired'], 0);
  assert.ok(Object.keys(one.by).length <= 40, 'only the first 40 keys are looked at');
  assert.equal(one.far, 1e9);
  assert.equal(g({ hours: [{ start: T0, by: null, far: 'x' }] })!.hours[0].far, 0);
  assert.deepStrictEqual(g({ hours: [{ start: T0, by: null, far: 'x' }] })!.hours[0].by, {});

  assert.equal(g({ nets: 5e6 })!.nets, 1e6);
  assert.equal(g({ nets: -2 })!.nets, 0);

  const guard = [null, { t: 'x', why: 'a' }, ...Array.from({ length: 8 }, (_, i) => ({ t: T0 + i, why: i === 7 ? 'w'.repeat(500) : i === 6 ? 42 : `rpc guard: ${i}` }))];
  const gg = g({ guard })!.guard;
  assert.equal(gg.length, 5);
  assert.deepStrictEqual(gg.map((x) => x.t), [T0 + 3, T0 + 4, T0 + 5, T0 + 6, T0 + 7]);
  assert.equal(gg[3].why, '');
  assert.equal(gg[4].why.length, 200);
});

test('the connections branch says how a device is reached, anchors included, with no server outside', () => {
  const c = BRANCHES.find((b) => b.id === 'connections')!;
  assert.equal(c.what, 'how each device is reached: a usb cable, the wi-fi, straight over the internet or through an anchor of your own circle. no server outside.');
});
