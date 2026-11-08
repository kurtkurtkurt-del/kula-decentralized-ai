// god's eye, branch 11 request review: personal data in a request, where a job would go, sanity of
// its times, request and model; a verdict per project, a feed line only when one appears or changes,
// and never the request text in its view, its feed or its notes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-review-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye } = await import('../src/godseye/index.ts');
const { create, personalKinds, masked } = await import('../src/godseye/branches/review.ts');

const NOW = Date.UTC(2026, 10, 8, 20, 0);
const H = 3600_000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const model = (o: Record<string, unknown> = {}) => ({ id: 'qwen-1.5b', name: 'qwen 1.5b', file: 'q.gguf', size: 1e9, quant: 'Q4', params_b: 1.5, catalog: true, here: true, needMb: 1500, ...o });
const project = (o: Record<string, unknown> = {}) => ({
  id: 'a1', title: 'market notes', request: 'write a short market overview of second-hand bikes in izmir', start: NOW + 2 * H, end: NOW + 6 * H,
  state: 'waiting', mode: 'phone', model: 'qwen-1.5b', peers: ['p1'], ...o,
});
const snap = (o: Record<string, unknown> = {}) => ({
  at: NOW, host: { name: 'mac', freeMb: 8000 }, devices: [dev()],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [model()], projects: [project()], ...o,
});

function fake() {
  const events: string[] = [];
  const saved: unknown[] = [];
  const ctx = { now: () => NOW, load: <T>(f: T) => f, save: (d: unknown) => saved.push(d), emit: (t: string) => events.push(t), peek: () => null };
  return { b: create(ctx as any), events, saved };
}

test('personal data: e-mail, phone, iban, card, passwords and keys are found; plain words and dates are not', () => {
  assert.deepEqual(personalKinds('summarise the history of istanbul trams from 1871 to 1966, 2000 words'), []);
  assert.deepEqual(personalKinds('mail the report to ayse.yilmaz@example.com.tr'), ['email']);
  assert.deepEqual(personalKinds('call me on +90 532 123 45 67 or 0532 123 45 67'), ['phone']);
  assert.deepEqual(personalKinds('send it to TR33 0006 1005 1978 6457 8413 26'), ['iban']);
  assert.deepEqual(personalKinds('GB82WEST12345698765432 is the account'), ['iban']);
  assert.deepEqual(personalKinds('pay with 4111 1111 1111 1111'), ['card']);
  assert.deepEqual(personalKinds('a 16 digit number that is not a card: 1234 5678 9012 3456'), []);
  assert.deepEqual(personalKinds('log in with password: hunter22'), ['secret']);
  assert.deepEqual(personalKinds('şifre=gizli123 ile gir'), ['secret']);
  assert.deepEqual(personalKinds('use the key sk-proj-AbCdEf0123456789xyzXYZ'), ['secret']);
  assert.deepEqual(personalKinds('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['secret']);
  assert.deepEqual(personalKinds('Authorization: Bearer abcdefghijklmnop1234567890'), ['secret']);
  assert.deepEqual(personalKinds('the hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), ['secret']);
  assert.deepEqual(personalKinds('a.b@c.io and 4111-1111-1111-1111 and api_key=abcd1234efgh'), ['email', 'card', 'secret']);
  assert.equal(masked('notes for ayse@example.com tonight'), 'notes for … tonight');
});

test('a plain waiting job on a pinned wi-fi phone with a model that fits: ok, one feed line, then quiet', () => {
  const { b, events } = fake();
  b.observe(snap() as any, null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, '1 waiting · all ok');
  assert.equal(v.gauge, 100);
  assert.equal(v.lines.length, 1);
  assert.match(v.lines[0], /“market notes” · waiting · .* · ok$/);
  assert.equal(events.length, 1);
  assert.match(events[0], /“market notes” \(waiting, \d\d:\d\d\): ok/);
  b.observe(snap({ at: NOW + 5000 }) as any, null);
  b.observe(snap({ at: NOW + 10000 }) as any, null);
  assert.equal(events.length, 1, 'no line every tick');
});

test('where it would go: a relay or an unpinned device is flagged; this computer and cable phones are fine', () => {
  const devices = [dev(), dev({ id: 'r1', name: 'far phone', via: 'relay' }), dev({ id: 'o1', name: 'old phone', tls: false }), dev({ id: 'c1', name: 'cable phone', via: 'cable', where: 'usb cable', plugged: true })];
  const { b } = fake();
  b.observe(snap({
    devices,
    projects: [
      project({ id: 'r', title: 'over relay', peers: ['r1'] }),
      project({ id: 'o', title: 'old pairing', peers: ['o1'] }),
      project({ id: 'c', title: 'by cable', peers: ['c1'] }),
      project({ id: 'h', title: 'here only', mode: 'here', peers: [] }),
      project({ id: 'g', title: 'gone phone', peers: ['nope'] }),
    ],
  }) as any, null);
  const v = b.view();
  const line = (t: string) => v.lines.find((l) => l.includes(`“${t}”`))!;
  assert.match(line('over relay'), /look again: it would go over a relay$/);
  assert.match(line('old pairing'), /look again: it would go to a device without a pinned certificate$/);
  assert.match(line('by cable'), /· ok$/);
  assert.match(line('here only'), /· ok$/);
  assert.match(line('gone phone'), /a chosen device is no longer paired/);
  assert.equal(v.stat, '5 waiting · 3 to look at again');
  assert.equal(v.gauge, 40);
});

test('apart with no device chosen counts every paired device', () => {
  const { b } = fake();
  b.observe(snap({ devices: [dev(), dev({ id: 'r1', via: 'relay' })], projects: [project({ mode: 'apart', peers: [] })] }) as any, null);
  assert.match(b.view().lines[0], /over a relay/);
});

test('sanity: a start already past, an end before the start, an empty or short request, an unknown or too big model', () => {
  const { b } = fake();
  b.observe(snap({
    devices: [dev({ ramMb: 1000 }), dev({ id: 'p2', name: 'pixel 2', ramMb: 900 })],
    models: [model(), model({ id: 'big', name: 'big', needMb: 6000 })],
    projects: [
      project({ id: '1', title: 'late', start: NOW - H, peers: ['p1'], model: 'qwen-1.5b' }),
      project({ id: '2', title: 'backwards', start: NOW + 3 * H, end: NOW + 2 * H }),
      project({ id: '3', title: 'empty', request: '   ' }),
      project({ id: '4', title: 'short', request: 'do it' }),
      project({ id: '5', title: 'what model', model: 'local:gone.gguf' }),
      project({ id: '6', title: 'too big', model: 'big' }),
      project({ id: '7', title: 'split fits', mode: 'split', peers: ['p1', 'p2'], model: 'big' }),
      project({ id: '8', title: 'split too big', mode: 'split', peers: ['p1', 'p2'], model: 'big', }),
    ],
    host: { name: 'mac', freeMb: 4200 },
  }) as any, null);
  const v = b.view();
  const line = (t: string) => v.lines.find((l) => l.includes(`“${t}”`))!;
  assert.match(line('late'), /its start has passed and it still waits/);
  assert.match(line('late'), /does not fit the chosen devices/);          // 1500 MB on a 1000 MB phone
  assert.match(line('backwards'), /it ends before it starts/);
  assert.match(line('empty'), /the request is empty/);
  assert.match(line('short'), /the request is very short/);
  assert.match(line('what model'), /this computer does not know its model/);
  assert.match(line('too big'), /does not fit the chosen devices/);
  assert.match(line('split fits'), /· ok$/);                              // 1000 + 900 + 4200 ≥ 6000
  // the same split with less free memory here no longer fits
  b.observe(snap({
    devices: [dev({ ramMb: 1000 }), dev({ id: 'p2', name: 'pixel 2', ramMb: 900 })],
    models: [model({ id: 'big', name: 'big', needMb: 6000 })],
    projects: [project({ id: '8', title: 'split too big', mode: 'split', peers: ['p1', 'p2'], model: 'big' })],
    host: { name: 'mac', freeMb: 2000 },
  }) as any, null);
  assert.match(b.view().lines[0], /does not fit the chosen devices/);
});

test('a verdict that changes is said once more; a finished project keeps its verdict without a new line', () => {
  const { b, events } = fake();
  b.observe(snap() as any, null);
  assert.equal(events.length, 1);
  b.observe(snap({ devices: [dev({ via: 'relay' })] }) as any, null);
  assert.equal(events.length, 2);
  assert.match(events[1], /look again: it would go over a relay/);
  b.observe(snap({ devices: [dev({ via: 'relay' })] }) as any, null);
  assert.equal(events.length, 2);
  b.observe(snap({ devices: [dev()], projects: [project({ state: 'done' })] }) as any, null);
  assert.equal(events.length, 2, 'finishing says nothing');
  const v = b.view();
  assert.match(v.lines[0], /· done · .*over a relay/);
  assert.equal(v.stat, 'nothing waiting');
  assert.equal(v.gauge, null);
  b.observe(snap({ projects: [] }) as any, null);
  assert.equal(b.view().lines.length, 0);
  assert.equal(b.view().stat, 'no night project');
});

test('the work loaded now is looked at too: a relay device in it is said once', () => {
  const { b, events } = fake();
  const loaded = { mode: 'apart', model: { id: 'qwen-1.5b', name: 'qwen 1.5b', file: 'q.gguf', size: 1e9 }, ctx: 4096, since: NOW, devices: [{ id: 'local', name: 'mac', local: true, busy: false, tps: null, done: 0 }, { id: 'p1', name: 'pixel', local: false, busy: false, tps: 9, done: 1 }] };
  const work = { loaded, loading: null, chatting: 0, plan: [], decisions: [], llama: true };
  b.observe(snap({ projects: [], devices: [dev({ via: 'relay' })], work }) as any, null);
  b.observe(snap({ projects: [], devices: [dev({ via: 'relay' })], work }) as any, null);
  assert.equal(events.length, 1);
  assert.match(events[0], /the work loaded now \(qwen 1\.5b\): look again: it would go over a relay/);
  assert.match(b.view().lines[0], /^loaded now · qwen 1\.5b \(apart\) · look again/);
});

test('in the eye: the review tile is lit, no request text reaches the view, the feed or a notes file', () => {
  const secret = 'ayse.yilmaz@example.com';
  const request = `collect every invoice sent to ${secret} and total them, card 4111 1111 1111 1111`;
  const dir = path.join(HOME, 'eye');
  const eye = new GodsEye({ snapshot: () => snap({ projects: [project({ title: `invoices ${secret}`, request })] }) as any, dir, now: () => NOW });
  eye.tick();
  eye.tick();
  const v = eye.view();
  const r = v.branches.find((x) => x.id === 'review')!;
  assert.equal(r.built, true);
  assert.equal(r.stat, '1 waiting · 1 to look at again');
  assert.equal(r.gauge, 0);
  assert.match(r.lines[0], /“invoices …”.*contains personal data \(an e-mail address, a card number\)/);
  const all = JSON.stringify(v);
  assert.ok(!all.includes(secret) && !all.includes('4111') && !all.includes('invoice sent'), 'no request text, no personal data');
  assert.equal(v.events.filter((e) => e.branch === 'review').length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'review.json')), 'no notes file');
});
