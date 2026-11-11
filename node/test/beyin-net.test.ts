// beyin-net (docs/BEYIN-NET.md): the pieces one by one. The 20-home simulation is beyin-net-sim.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

const net = await import('../src/godseye/net/index.ts');
type Task = import('../src/godseye/net/index.ts').Task;
type Offer = import('../src/godseye/net/index.ts').Offer;

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 11, 1, 0, 0);

test('the module imports nothing but itself', () => {
  const dir = path.join(import.meta.dirname, '../src/godseye/net');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^\.\/[a-z]+\.js$/, `${f} imports ${m[1]}`);
  }
});

const piece = (id: string, ring: 'home' | 'circle' | 'world', home = 'A', units = 8, modelB = 8) =>
  ({ id, job: 'j', home, ring, modelB, model: 'sha', units, deadline: NOW + 24 * HOUR });
const task = (p: ReturnType<typeof piece>, copy = 0): Task => ({ piece: p, copy, exclude: [], avoid: [] });
const offer = (home: string, ring: 'home' | 'circle' | 'world', units = 100, gift = 0): Offer => ({
  v: 1, type: 'offer', id: `${home}-o`, home, at: NOW, from: NOW, to: NOW + HOUR, ring, gift,
  devices: [{ id: `${home}1`, maxB: 8, rate: 50, units }],
});
const view = (rel: Record<string, any>, back: Record<string, any>, room: Record<string, number> = {}) =>
  ({ rel, back, room: Object.fromEntries(Object.entries(room).map(([k, u]) => [k, { units: u, path: ['B', k] }])) });

test('rings: a home piece never leaves, a circle piece goes only to a home the asker trusts', () => {
  const tasks = [task(piece('h', 'home')), task(piece('c', 'circle')), task(piece('w', 'world'))];
  // B is A's friend (A trusts B): circle and world pieces may go
  const friend = net.match(offer('B', 'world', 100, 1), tasks, view({ A: 'circle' }, { A: 'circle' }), NOW);
  assert.deepEqual(friend.map((g) => g.piece).sort(), ['c', 'w']);
  // C is a stranger: only the world piece
  const stranger = net.match(offer('C', 'world', 100, 1), tasks, view({ A: 'world' }, { A: 'world' }), NOW);
  assert.deepEqual(stranger.map((g) => g.piece), ['w']);
  // a giver that offers to its circle only takes nothing from a stranger
  assert.equal(net.match(offer('C', 'circle', 100, 1), tasks, view({ A: 'world' }, { A: 'world' }), NOW).length, 0);
  // A's own devices take everything, without credit
  const own = net.match(offer('A', 'home'), tasks, view({ A: 'home' }, { A: 'home' }), NOW);
  assert.deepEqual(own.map((g) => g.piece).sort(), ['c', 'h', 'w']);
  assert.ok(own.every((g) => g.path.length === 0 && !g.gift));
});

test('the matcher serves the asker with most room first, then strangers from the gift share only', () => {
  const tasks = ['A', 'D', 'E'].flatMap((h) => [1, 2, 3].map((n) => task(piece(`${h}${n}`, 'world', h))));
  const v = view({ A: 'world', D: 'world', E: 'world' }, { A: 'world', D: 'world', E: 'world' }, { D: 16, A: 0, E: 0 });
  const g = net.match(offer('B', 'world', 40, 0.2), tasks, v, NOW);
  // D has room for two pieces on credit, then 8 units of gift go to one stranger piece
  assert.deepEqual(g.filter((x) => !x.gift).map((x) => x.piece), ['D1', 'D2']);
  assert.equal(g.filter((x) => x.gift).length, 1);
  assert.equal(g.reduce((s, x) => s + x.units, 0), 24);
  // and it is the same answer again
  assert.deepEqual(net.match(offer('B', 'world', 40, 0.2), tasks, v, NOW), g);
});

test('the matcher keeps two copies of a piece in two homes and respects avoided devices and model size', () => {
  const p = piece('x', 'world');
  const both = [task(p, 0), task(p, 1)];
  assert.equal(net.match(offer('B', 'world', 100, 1), both, view({ A: 'world' }, { A: 'world' }), NOW).length, 1);
  assert.equal(net.match(offer('B', 'world', 100, 1), [{ ...task(p, 1), exclude: ['B'] }], view({ A: 'world' }, { A: 'world' }), NOW).length, 0);
  assert.equal(net.match(offer('B', 'world', 100, 1), [{ ...task(p), avoid: ['B1'] }], view({ A: 'world' }, { A: 'world' }), NOW).length, 0);
  assert.equal(net.match(offer('B', 'world', 100, 1), [task(piece('big', 'world', 'A', 70, 70))], view({ A: 'world' }, { A: 'world' }), NOW).length, 0);
});

test('credit: a friend of a friend is served along the chain, halved, and the chain carries the balance', () => {
  const trust = [{ from: 'C', to: 'B', limit: 100 }, { from: 'B', to: 'A', limit: 60 }];
  assert.equal(net.room(trust, {}, 'C', 'A').units, 30);          // min(100, 60) / 2
  assert.deepEqual(net.room(trust, {}, 'C', 'A').path, ['C', 'B', 'A']);
  assert.equal(net.room(trust, {}, 'A', 'C').units, 0);            // trust is one-way
  let g = net.carry({}, ['C', 'B', 'A'], 20);
  assert.equal(net.owed(g, 'C', 'B'), 20);                        // B stood for A: C did 20 for B
  assert.equal(net.owed(g, 'B', 'A'), 20);                        // and B for A
  assert.equal(net.standing(g, 'B').net, 0);                      // B itself neither gave nor got
  assert.equal(net.room(trust, g, 'C', 'A').units, 20);            // min(80, 40) / 2
  // A pays back directly: now C owes A, and a debt is always honoured, even without trust
  g = net.carry(g, ['A', 'C'], 50);
  assert.equal(net.room([], g, 'C', 'A').units, 50);
  // too many hops: nobody knows anybody
  const long = [{ from: 'E', to: 'D', limit: 100 }, { from: 'D', to: 'C', limit: 100 }, ...trust];
  assert.equal(net.room(long, {}, 'E', 'A').units, 0);
  assert.equal(net.room(long, {}, 'D', 'A').units, 15);
});

test('reputation: a proven wrong answer bans at once, one outvote cuts the score, two ban; lateness only lowers it', () => {
  let r = net.fresh(NOW);
  for (let i = 0; i < 10; i++) r = net.observe(r, 'good', NOW);
  assert.ok(net.usable(r, NOW) && net.score(r, NOW) > 0.9);
  assert.ok(net.banned(net.observe(r, 'wrong', NOW), NOW));
  const once = net.observe(net.observe(undefined, 'good', NOW), 'outvoted', NOW);
  assert.ok(!net.banned(once, NOW) && !net.usable(once, NOW));
  assert.ok(net.banned(net.observe(net.observe(r, 'outvoted', NOW), 'outvoted', NOW), NOW));
  let lazy = r;
  for (let i = 0; i < 5; i++) lazy = net.observe(lazy, 'late', NOW);
  assert.ok(!net.banned(lazy, NOW) && net.score(lazy, NOW) < net.score(r, NOW));
  // the past fades: a month on, half of it
  assert.ok(Math.abs(net.decay(r, NOW + net.HALF_LIFE_MS).good - 5) < 1e-9);
  // a ban ends
  assert.ok(!net.banned(net.observe(r, 'warned', NOW), NOW + net.WARNED_BAN_MS + 1));
});

test('verification: new devices are checked every time, trusted ones by sample, the coin is the same everywhere', () => {
  assert.deepEqual(net.rates(undefined, NOW), { check: 1, canary: 0.25 });
  let r = net.fresh(NOW);
  for (let i = 0; i < 100; i++) r = net.observe(r, 'good', NOW);
  const p = net.rates(r, NOW);
  assert.ok(p.check >= net.CHECK_FLOOR && p.check < 0.15 && p.canary >= net.CANARY_FLOOR && p.canary < 0.06);
  assert.equal(net.coin('a', 1), net.coin('a', 1));
  assert.notEqual(net.coin('a', 1), net.coin('a', 2));
  let canaries = 0, checks = 0;
  for (let i = 0; i < 2000; i++) { const x = net.plan(`p${i}`, 'd', r, NOW, 7); if (x.canary) canaries++; if (x.check) checks++; }
  assert.ok(canaries > 60 && canaries < 160, `canaries ${canaries}`);
  assert.ok(checks > 160 && checks < 320, `checks ${checks}`);
});

test('judge: agreement accepts, disagreement asks for a tiebreak, a known answer decides', () => {
  const a = (device: string, digest: string) => ({ device, home: device, digest });
  assert.deepEqual(net.judge([a('x', '1')], 2), { state: 'wait' });
  assert.deepEqual(net.judge([a('x', '1')], 1), { state: 'accept', digest: '1', checked: false, outcomes: [] });
  const ok = net.judge([a('x', '1'), a('y', '1')], 2);
  assert.equal(ok.state, 'accept');
  assert.equal(net.judge([a('x', '1'), a('y', '2')], 2).state, 'tiebreak');
  const three = net.judge([a('x', '1'), a('y', '2'), a('z', '1')], 3);
  assert.deepEqual(three.state === 'accept' && three.outcomes, [{ device: 'x', outcome: 'good' }, { device: 'y', outcome: 'outvoted' }, { device: 'z', outcome: 'good' }]);
  const canary = net.judge([a('x', '2')], 1, '1');
  assert.deepEqual(canary.state === 'accept' && canary.outcomes, [{ device: 'x', outcome: 'wrong' }]);
  const acc = [{ device: 'x', checked: false, at: 5 }, { device: 'x', checked: true, at: 6 }, { device: 'y', checked: false, at: 7 }];
  assert.deepEqual(net.recall(acc, 'x'), [acc[0]]);
});

function keys(id: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id, pub: publicKey, signer: { id, sign: (t: string) => sign(null, Buffer.from(t), privateKey).toString('base64') } };
}
const verifier = (pubs: Record<string, KeyObject>) => (id: string, text: string, sig: string) =>
  !!pubs[id] && verify(null, Buffer.from(text), pubs[id], Buffer.from(sig, 'base64'));

test('receipts: the device signs, the asking home countersigns, any change breaks it, and the balance is the receipts', () => {
  const dev = keys('dev1'), home = keys('A'), friend = keys('B');
  const v = verifier({ dev1: dev.pub, A: home.pub, B: friend.pub });
  const body = {
    v: 1 as const, kind: 'receipt' as const, t: NOW, job: 'j', piece: 'p1', copy: 0, units: 16, model: 'sha', ring: 'world' as const,
    result: 'abc', device: 'dev1', giver: 'C', taker: 'A', via: ['B'], gift: false, checked: true,
  };
  const line = net.countersign(net.signGiver(body, dev.signer), home.signer);
  assert.match(line, /^\{"v":1,"kind":"receipt","t":\d+,.*,"gsig":"[^"]+","tsig":"[^"]+"\}$/);
  const c = net.checkReceipt(line, v);
  assert.ok(c.ok, c.problems.join());
  assert.deepEqual(c.body, body);
  assert.deepEqual(net.checkReceipt(line.replace('"units":16', '"units":61'), v).problems, ['gsig', 'tsig']);
  // a field slipped in, even with the signatures intact, is not the receipt it says it is
  assert.deepEqual(net.checkReceipt(line.replace('"checked":true', '"checked":true,"bonus":1'), v).problems, ['fields', 'gsig', 'tsig']);
  assert.ok(!net.checkReceipt(line.replace(/"tsig":"[^"]+"/, '"tsig":"AAAA"'), v).ok);
  assert.throws(() => net.signGiver(body, home.signer));
  assert.throws(() => net.countersign(net.signGiver(body, dev.signer), friend.signer));
  const hash = createHash('sha256').update(line).digest('hex');
  const g = net.tally([{ body, hash }]);
  assert.deepEqual(g, { C: { B: 16 }, B: { A: 16 } });
  assert.deepEqual(net.tally([{ body, hash }], new Set([hash])), {});
  const vouch = net.seal(net.vouchText({ v: 1, kind: 'vouch', t: NOW, by: 'B', for: 'A', to: 'C', units: 30, until: NOW + HOUR }), 'sig', friend.signer);
  assert.ok(net.checkVouch(vouch, v).ok);
  assert.ok(!net.checkVouch(vouch.replace('"units":30', '"units":300'), v).ok);
  const revoke = net.seal(net.revokeText({ v: 1, kind: 'revoke', t: NOW, taker: 'A', receipt: hash, why: 'wrong' }), 'sig', home.signer);
  assert.ok(net.checkRevoke(revoke, v).ok);
});

test('messages: only the exact shapes are kept; the world sees no title and only world pieces', () => {
  const ask = { v: 1, type: 'ask', id: 'j', home: 'A', at: NOW, title: 'my thesis', pieces: [piece('h', 'home'), piece('c', 'circle'), piece('w', 'world')] };
  assert.ok(net.parseMessage(ask));
  assert.equal(net.parseMessage({ ...ask, pieces: [{ ...piece('x', 'world'), home: 'B' }] }), null);
  assert.equal(net.parseMessage({ ...ask, v: 2 }), null);
  assert.ok(net.parseMessage(offer('B', 'circle')));
  assert.equal(net.parseMessage({ ...offer('B', 'circle'), ring: 'galaxy' }), null);
  assert.equal(net.parseMessage({ ...offer('B', 'circle'), gift: 2 }), null);
  assert.equal(net.parseMessage({ v: 1, type: 'pay', amount: 5 }), null);
  const w = net.askFor(ask as any, 'world');
  assert.equal(w.title, '');
  assert.deepEqual(w.pieces.map((p: any) => p.id), ['w']);
  assert.deepEqual(net.askFor(ask as any, 'circle').pieces.map((p: any) => p.id), ['c', 'w']);
});

test('cards: the brain suggests, the person picks; a caught liar comes first', () => {
  const cards = net.netCards({
    now: NOW,
    idle: { from: NOW, to: NOW + 5 * HOUR, devices: 3, maxB: 8, ring: 'circle' },
    asks: [{ job: 'j', title: 'thesis', pieces: 200, world: 180, circle: 0, home: 20 }],
    caught: [{ device: 'd', name: 'Ali’s phone', home: 'H', why: 'wrong', recalled: 4 }],
    owe: [{ home: 'B', name: 'Ayşe', units: 340 }],
    takers: [],
  });
  assert.deepEqual(cards.map((c) => c.id), ['net:caught:d', 'net:ask:j', 'net:offer', 'net:owe:B']);
  assert.equal(cards[2].title, '3 devices idle 01:00–06:00: lend them?');
  assert.ok(cards.every((c) => c.choices.length >= 1));
});
