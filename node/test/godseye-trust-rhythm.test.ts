// god's eye, branch 8 (L10 P55, G9): a device's refusals held against the same hour of day. An honest
// device whose refusals come by day (its owner's other devices, a busy wi-fi: 4 an hour from 09:00 to
// 17:00, 0.1 an hour at night) must not turn red every week, as the median of all hours made it; a
// handful in a quiet night hour still turns red. g9's loop and seed (mulberry32(7)), a look every
// five minutes on the answer's own clock, UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create } = await import('../src/godseye/branches/trust.ts');
const { burstStep, freshBurst } = await import('../src/godseye/branches/burst.ts');

const H = 3_600_000;
const DAY = 24 * H;
const STEP = 300_000;                      // a look every five minutes
const T0 = Date.UTC(2026, 10, 1);          // midnight UTC: hour i of the run is hour of day i % 24
const PER_ANSWER = 10_000;                 // trust.ts: one answer counts at most this into the hour

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** the honest device, looked at every five minutes; `look(extra)` adds refusals on top of the rhythm */
function rig(initial: unknown = {}, seed = 7) {
  const rnd = mulberry32(seed);
  const poisson = (l: number) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };
  let notes: unknown = structuredClone(initial);
  let now = T0;
  const b = create({ now: () => now, load: <T>(f: T) => (structuredClone(notes) as T) ?? f, save: (x: unknown) => { notes = structuredClone(x); }, emit: () => {}, peek: () => null, keys: null });
  let day = -1, total = 0, sent = -1;
  // what the test fed into each hour of the run, counted as trust.ts counts it: the rise of the day's
  // total since the last answer (a new day's first refusals fall against yesterday's larger total)
  const fed: number[] = [];
  const look = (extra = 0) => {
    const d = Math.floor((now - T0) / DAY);
    if (d !== day) { day = d; total = 0; }
    const h = new Date(now).getUTCHours();
    total += poisson((h >= 9 && h < 17 ? 4 : 0.1) / 12) + extra;
    const i = Math.floor((now - T0) / H);
    fed[i] = (fed[i] ?? 0) + (sent < 0 ? 0 : Math.min(Math.max(0, total - sent), PER_ANSWER));
    sent = total;
    const trust = { at: now, error: null, id: 'a'.repeat(32), alg: 'ed25519', pub: null, store: 'keystore', cert: null, certPinned: true, v1: false, paired: 1, self: 'ok', count: 0, head: null, lines: [], restartedAt: null, rejectsDay: total ? { 'not paired': total } : {}, rejectsLast: [] };
    const dev = { id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '', reachable: true, reachMs: 10, reason: null, checkedAt: now, lastOk: null, ramMb: 6000, bwGBs: 20, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust };
    b.observe({ at: now, host: { name: 'mac', freeMb: 1, ledger: null }, devices: [dev], work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [] } as any, null);
  };
  const refused = () => b.view().report!.devices[0].checks.find((c: any) => c.k === 'refused')!;
  return {
    b, look, refused, fed,
    notes: () => (notes as any).p1,
    get now() { return now; },
    /** look every five minutes until `until` (not included) */
    until(until: number, each?: () => void) { while (now < until) { look(); each?.(); now += STEP; } },
    step() { now += STEP; },
    jump(ms: number) { now += ms; },
  };
}

test('14 honest days with a daily rhythm: the refused check is red on at most one day', () => {
  const r = rig();
  const redHours = new Set<number>();
  r.until(T0 + 14 * DAY, () => { if (r.refused().ok === false) redHours.add(Math.floor((r.now - T0) / H)); });
  const days = new Set([...redHours].map((h) => Math.floor(h / 24)));
  assert.ok(days.size <= 1, `honest traffic turned red in ${redHours.size} hours on ${days.size} of 14 days: hours ${[...redHours].join(', ')}`);
});

test('after 5 honest days, 8 refusals inside a 03:00 hour are red in that hour, told against that hour of day', () => {
  const r = rig();
  const at = T0 + 5 * DAY + 3 * H + 5 * 60_000;   // 03:05 on day 6
  r.until(at);
  r.look(8); r.step();
  const texts: string[] = [];
  r.until(at + 55 * 60_000, () => {
    assert.equal(r.refused().ok, false, new Date(r.now).toISOString());
    texts.push(r.refused().text);
  });
  assert.ok(texts.length > 0);
  for (const t of texts) assert.match(t, /at this hour of day it usually sees about 0\.\d/);
});

test('the same 8 refusals inside a 12:00 hour are not red: by day the device sees about that many', () => {
  const r = rig();
  const at = T0 + 5 * DAY + 12 * H + 5 * 60_000;  // 12:05 on day 6
  r.until(at);
  r.look(8);
  assert.notEqual(r.refused().ok, false, r.refused().text);
  r.step();
  r.until(at + 55 * 60_000, () => assert.notEqual(r.refused().ok, false, `${new Date(r.now).toISOString()}: ${r.refused().text}`));
});

test('the saved fit is the fold of burstStep over the hours the test fed', () => {
  const r = rig();
  r.until(T0 + 6 * DAY + 7 * H + 30 * 60_000);
  // the windows run on whole hours from the first answer at midnight: every hour before the running
  // one is finished and was taken in, in order
  const running = Math.floor((r.now - STEP - T0) / H);
  let fold = freshBurst();
  for (let i = 0; i < running; i++) fold = burstStep(fold, i % 24, Math.min(r.fed[i] ?? 0, PER_ANSWER)).fit;
  assert.equal(r.notes().burst.n, running);
  assert.deepEqual(r.notes().burst, fold);
});

test('a gap of 10 hours: the CUSUM starts again, nothing is rising, not red', () => {
  const r = rig();
  r.until(T0 + 5 * DAY + 2 * H);
  // four night hours each a little high (3 an hour against about 0.1): the CUSUM climbs
  for (let i = 0; i < 4 * 12; i++) { r.look(i % 4 === 0 ? 1 : 0); r.step(); }
  assert.ok(r.notes().burst.s > 0, 'the CUSUM climbed before the gap');
  // the computer was away for ten hours
  r.jump(10 * H);
  r.look(); r.step();
  assert.equal(r.notes().burst.s, 0);
  assert.equal(r.notes().rising, false);
  assert.equal(r.notes().lastBurst, 0);
  assert.equal(r.refused().ok, true, r.refused().text);
});

test('notes with an old hist and no burst load, the hist goes and the fit starts fresh; a broken fit starts fresh too', () => {
  for (const p1 of [
    { head: null, verified: 0, since: 0, at: 0, rejAt: -1, rejTotal: 0, win: { start: 0, k: 0 }, hist: Array.from({ length: 168 }, (_, i) => i % 5), lastBurst: 0 },
    { head: null, verified: 0, since: 0, at: 0, rejAt: -1, rejTotal: 0, win: { start: 0, k: 0 }, burst: { a: [1] }, lastBurst: 0 },
  ]) {
    const r = rig({ p1 });
    r.look();
    assert.ok(!('hist' in r.notes()), 'the old hist is gone');
    assert.deepEqual(r.notes().burst, freshBurst());
    assert.equal(r.notes().rising, false);
    assert.equal(r.notes().lastUsual, 0);
    assert.equal(r.refused().ok, true);
  }
});

test('a restart keeps the fit: the hours taken in are the same after create again', () => {
  const r = rig();
  r.until(T0 + 4 * DAY + 30 * 60_000);
  const n = r.notes().burst.n;
  assert.ok(n > 24);
  const r2 = rig({ p1: r.notes() });
  r2.jump(r.now - T0);
  r2.look();   // inside the running hour: nothing closes, the notes are saved again
  assert.equal(r2.notes().burst.n, n);
  assert.deepEqual(r2.notes().burst, r.notes().burst);
});

test('one answer of +5000 in a 10:00 hour does not blind it: 40 in the next day\u{2019}s 10:00 hour is red', () => {
  const r = rig();
  r.until(T0 + 5 * DAY + 10 * H + 5 * 60_000);
  r.look(5000); r.step();
  const next = T0 + 6 * DAY + 10 * H + 5 * 60_000;
  r.until(next);
  r.look(40);
  assert.equal(r.refused().ok, false, r.refused().text);
  assert.match(r.refused().text, /at this hour of day it usually sees about/);
});
