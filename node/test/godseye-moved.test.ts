// god's eye, branch 5 connections, a moved address (16.11.2026, P5): a device that answers with its
// pinned certificate from a public address block (ipv4 /16, ipv6 /32) it was not seen on before
// gets one feed line a day, and a card only when it was settled; a roaming phone never gets one;
// the same block, a lan address, an unparsable where, an anchor route or an unpinned answer give
// nothing; the notes keep hashes and times only, and an old notes file still loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, blockOf, NB_MAX } = await import('../src/godseye/branches/connections.ts');
const { cleanCard } = await import('../src/godseye/index.ts');

const T = new Date(2026, 10, 16, 21, 0, 0).getTime();   // Monday 16 November 2026, 21:00 local
const H = 3600_000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'den', kind: 'pc', via: 'internet', where: '203.0.113.7:50551', reachable: true, reachMs: 40, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 16000, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null,
  trust: null, ...o,
});
const snap = (devices: any[], t: number): any => ({
  at: t, host: { name: 'mac', freeMb: 4000 }, devices,
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
  /** one look at time t holding the device with these fields; a look at a new t is a new probe */
  const step = (t: number, o: Record<string, unknown> = {}) => {
    c.t = t;
    const s = snap([dev({ checkedAt: t, ...o })], t);
    b.observe(s, before);
    before = s;
    return b.view();
  };
  return { c, step };
}
const moved = (v: any, id = 'c1') => (v.suggestions ?? []).find((s: any) => s.id === `connections:moved:${id}`);
const movedLines = (feed: string[]) => feed.filter((s) => s.includes('was not seen on before'));

/** 25 answers over 4 days from one where: a settled computer; returns the last look's time */
function settle(step: (t: number, o?: Record<string, unknown>) => any, where = '203.0.113.7:50551', from = T): number {
  let t = from;
  for (let i = 0; i < 25; i++) { t = from + i * 4 * H; step(t, { where }); }
  return t;
}

test('blockOf: ipv4 /16 and global ipv6 /32 from the forms where takes; lan, private and unparsable give null', () => {
  assert.equal(blockOf('203.0.113.7:50551'), '203.0');
  assert.equal(blockOf('203.0.113.7'), '203.0');
  assert.equal(blockOf('203.0.113.7:50551 (router port, over the internet)'), '203.0');
  assert.equal(blockOf('[2001:db8:1::5]:50551'), '2001:db8');
  assert.equal(blockOf('[2001:0DB8:1::5]:50551 (ipv6, over the internet)'), '2001:db8');
  assert.equal(blockOf('2001:db8::1'), '2001:db8');
  assert.equal(blockOf('2a02::1'), '2a02:0');
  assert.equal(blockOf('[::ffff:198.51.100.9]:1'), '198.51');
  for (const lan of ['192.168.1.33:50551', '10.0.0.4:1', '172.20.1.1:1', '100.64.3.2:1', '127.0.0.1:5', '169.254.1.1:1',
    '[fe80::1%en0]:50551', '[fd00::1]:1', '::1', '[::ffff:192.168.1.2]:1', '224.0.0.1', '0.1.2.3']) {
    assert.equal(blockOf(lan), null, lan);
  }
  for (const bad of ['', 'usb cable', 'through den', 'relay 123 via relay.example', 'den.local:50551', '203.0.113.7:port',
    '[2001:db8::1', '[2001:db8::1]x', '1.2.3.4.5', '256.1.1.1', '2001:db8::1::2', 'a:b:c', null, 42, {}]) {
    assert.equal(blockOf(bad), null, String(bad));
  }
});

test('a settled computer on a new /16 gets the card: weight 2, 24 h, opens trust; one feed line a day', () => {
  const { c, step } = branch();
  let t = settle(step);
  assert.equal(movedLines(c.feed).length, 0, 'the first block says nothing');
  t += H;
  let v = step(t, { where: '198.51.100.9:50551' });
  const card = moved(v);
  assert.ok(card, JSON.stringify(v.suggestions));
  assert.equal(card.kind, 'warn');
  assert.equal(card.weight, 2);
  assert.equal(card.title, 'den answered from a network it was not seen on before (its pinned certificate matched)');
  assert.equal(card.why, 'its certificate is the one pinned from its qr, so it holds the same key: normal after a move or a new provider, or its provider gave it a new address. '
    + 'if nobody moved it, its key may have been copied: ask its owner, or pair again. the brain compares address blocks; it cannot say where.');
  assert.deepEqual(card.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.ok(cleanCard(card), 'the eye keeps the card as the branch wrote it');
  assert.deepEqual(movedLines(c.feed), ['den answered from a network it was not seen on before (its pinned certificate matched)']);
  for (const s of [card.title, card.why, ...c.feed]) assert.doesNotMatch(s, /\d+\.\d+\.\d+|198\.51|203\.0|2001:/, s);
  // still there 23 h later, gone after 24 h
  v = step(t + 23 * H, { where: '198.51.100.9:50551' });
  assert.ok(moved(v));
  v = step(t + 24 * H, { where: '198.51.100.9:50551' });
  assert.equal(moved(v), undefined);
  assert.equal(movedLines(c.feed).length, 1, 'answering again from the now-seen block says nothing');
});

test('one feed line a day at most: a second unseen block the same day is silent', () => {
  const { c, step } = branch();
  let t = settle(step);
  // settle ends at 21:00 + 96 h = Friday 21:00; the next two moves are the same evening
  step(t + H / 2, { where: '198.51.100.9:50551' });
  step(t + H, { where: '192.0.2.4:50551' });
  assert.equal(movedLines(c.feed).length, 1);
  t += 24 * H;
  step(t, { where: '[2001:db8::7]:50551' });
  assert.equal(movedLines(c.feed).length, 2, 'the next day may say it again');
});

test('a roaming phone never gets a card', () => {
  const { c, step } = branch();
  const nets = ['203.0.113.7', '198.51.100.9', '192.0.2.4', '[2a02:1:2::9]', '[2001:db8::7]', '81.2.69.1', '62.5.1.1', '88.1.2.3'];
  let v: any;
  for (let i = 0; i < 120; i++) {
    v = step(T + i * 2 * H, { id: 'p1', name: 'pixel', kind: 'phone', where: `${nets[(i * 3 + (i >> 2)) % nets.length]}:50551` });
    assert.equal(moved(v, 'p1'), undefined, `look ${i}`);
  }
  // lines, but at most one a day
  const lines = movedLines(c.feed);
  assert.ok(lines.length >= 1 && lines.length <= 11, String(lines.length));
  const nb = (c.stored as any).dev.find((d: any) => d[0] === 'p1')[1].nb;
  assert.ok(nb.length <= NB_MAX && nb.length === NB_MAX, `at most ${NB_MAX} blocks kept: ${nb.length}`);
});

test('the same /16, or the same ipv6 /32, gives nothing', () => {
  for (const [home, near] of [['203.0.113.7:50551', '203.0.200.1:50551'], ['[2001:db8:1::5]:50551', '[2001:db8:ffff::9]:50551']]) {
    const { c, step } = branch();
    const t = settle(step, home);
    const v = step(t + H, { where: near });
    assert.equal(moved(v), undefined, near);
    assert.equal(movedLines(c.feed).length, 0, near);
    const nb = (c.stored as any).dev[0][1].nb;
    assert.equal(nb.length, 1);
    assert.equal(nb[0][3], 26, 'counted as the same block');
  }
});

test('an unparsable where, a lan address, an anchor route or an unpinned answer gives nothing', () => {
  const cases: Record<string, unknown>[] = [
    { where: 'somehost.example:50551' }, { where: 'garbage' }, { where: '' }, { where: null }, { where: 'usb cable', via: 'cable' },
    { where: '192.168.1.40:50551', via: 'wifi' }, { where: '10.1.2.3:50551', via: 'wifi' },
    { where: 'through den', via: 'anchor', through: 'a1' }, { where: '198.51.100.9:50551', via: 'anchor', through: 'a1' },
    { where: '198.51.100.9:50551', tls: false },
    { where: '198.51.100.9:50551', trust: { certPinned: false } },
    { where: '198.51.100.9:50551', reachable: false },
  ];
  for (const o of cases) {
    const { c, step } = branch();
    const t = settle(step);
    const before = JSON.stringify((c.stored as any).dev[0][1].nb);
    const v = step(t + H, o);
    assert.equal(moved(v), undefined, JSON.stringify(o));
    assert.equal(movedLines(c.feed).length, 0, JSON.stringify(o));
    step(t + 2 * H, { where: '203.0.113.7:50551' });   // a change to save
    assert.equal(JSON.stringify((c.stored as any).dev[0][1].nb.map((r: any) => r[0])), JSON.stringify(JSON.parse(before).map((r: any) => r[0])), JSON.stringify(o));
  }
  // certPinned true, or absent trust, counts as pinned
  const { step } = branch();
  const t = settle(step);
  assert.ok(moved(step(t + H, { where: '198.51.100.9:50551', trust: { certPinned: true } })));
});

test('the notes JSON matches no ip regexp, and keeps 12-hex hashes', () => {
  const { c, step } = branch();
  let t = settle(step, '203.0.113.7:50551');
  for (const w of ['198.51.100.9:50551', '[2001:db8:1::5]:50551', '[2a02:1:2::9]:1 (ipv6, over the internet)', '81.2.69.1']) {
    t += 3 * H;
    step(t, { where: w });
  }
  t += 3 * H;
  step(t, { where: '192.168.1.33:50551', via: 'wifi' });
  const json = JSON.stringify(c.stored);
  assert.doesNotMatch(json, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  assert.doesNotMatch(json, /\b\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(json, /[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}/i);
  assert.doesNotMatch(json, /2001|db8|2a02|203\.0|198\.51|192\.168/);
  const nb = (c.stored as any).dev[0][1].nb;
  assert.equal(nb.length, 5);
  for (const r of nb) {
    assert.match(r[0], /^[0-9a-f]{12}$/);
    assert.equal(r.length, 4);
  }
});

test('an old notes file without the block list loads; a reload keeps the blocks; a bad entry gives fresh notes', () => {
  const old = { v: 1, dev: [['c1', { name: 'den', seen: T, kind: 'internet', at: T, k: [['internet', { ring: '1', ms: [40], last: T }]], sw: [] }]] };
  const a = branch(old);
  a.step(T + H, { where: '203.0.113.7:50551' });
  const stored = a.c.stored as any;
  assert.equal(stored.dev[0][1].nb.length, 1, 'the old file loaded and the first block was noted');
  assert.equal(stored.dev[0][1].k[0][1].ring, '11', 'its readings were kept');
  assert.equal(movedLines(a.c.feed).length, 0);
  // a reload: the block is known, a new one is a line
  const b = branch(structuredClone(stored));
  b.step(T + 2 * H, { where: '203.0.9.9:50551' });
  assert.equal(movedLines(b.c.feed).length, 0, 'same /16 after a reload');
  b.step(T + 3 * H, { where: '198.51.100.9:50551' });
  assert.equal(movedLines(b.c.feed).length, 1);
  // a block entry of the wrong shape: the file is not trusted
  const bad = structuredClone(stored);
  bad.dev[0][1].nb = [['203.0', T, T, 1]];
  const z = branch(bad);
  z.step(T + 4 * H, { where: '203.0.113.7:50551' });
  assert.equal((z.c.stored as any).dev[0][1].k[0][1].ring, '1', 'fresh notes');
});
