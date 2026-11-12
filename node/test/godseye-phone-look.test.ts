// god's eye, P12 cross-test (B14): a look shaped the way the phone builds it (app/src/eye/snapshot.ts
// after c9bbb99) sent through the planner, executor, learning and forecast branches in the eye's
// order, with peek between them as the eye gives it. The phone is the host: its own device is 'me'
// with local: true in work.loaded only; a paired peer is in devices with checkedAt = the engine's
// heardAt (older than the look), so a look with nothing new heard is not a new probe. The phone
// sends tps only once done > 0: first done 0 / tps null, then done 3 / tps 14.2.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-phone-look-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { create: forecastCreate } = await import('../src/godseye/branches/forecast.ts');
const { create: learningCreate } = await import('../src/godseye/branches/learning.ts');
const { create: plannerCreate } = await import('../src/godseye/branches/planner.ts');
const { create: executorCreate } = await import('../src/godseye/branches/executor.ts');
const { cleanAction, sameAction } = await import('../src/godseye/eye.ts');
const { GodsEye } = await import('../src/godseye/index.ts');

const T0 = Date.UTC(2026, 10, 12, 19, 0, 0);
const SINCE = T0 - 60_000;                     // the load, a minute before the first look
const FILE = 'qwen3-1.7b-q4.gguf';
const MODEL = { id: 'qwen3-1.7b', name: 'Qwen3 1.7B', file: FILE, size: 1_100_000_000 };
const PEER_HEARD = SINCE;                      // the engine last heard the peer at the load

/** the local phone's row in work.loaded, as workOf maps it: tps only once done > 0 */
const me = (done: number, tps: number) => ({ id: 'me', name: 'my phone', local: true, busy: false, tps: done > 0 && tps > 0 ? tps : null, done });
const peerRow = { id: 'peer-a', name: 'tablet', local: false, busy: false, tps: null, done: 0 };

/** one look as phoneSnapshot builds it */
function look(at: number, mine: { done: number; tps: number }) {
  return {
    at,
    host: { name: 'my phone', freeMb: 5200, ledger: { ok: true, count: 12, problem: null }, power: { battery: 80, charging: false, hot: false } },
    devices: [{
      id: 'peer-a', name: 'tablet', kind: 'tablet', via: 'wifi', where: '192.168.1.40:50551',
      reachable: true, reachMs: null, reason: null, checkedAt: PEER_HEARD,   // heardAt, older than at
      lastOk: null, ramMb: 6000, bwGBs: 30, gpu: null, tls: true, waitingPair: false, plugged: null,
      holds: FILE, trust: null,
    }],
    work: {
      loaded: { mode: 'apart', model: { ...MODEL }, ctx: 4096, since: SINCE, devices: [me(mine.done, mine.tps), { ...peerRow }] },
      loading: null, chatting: 0, plan: [], decisions: [], llama: true,
    },
    models: [{ ...MODEL, quant: 'Q4_K_M', params_b: 1.7, catalog: true, here: true, needMb: 1700 }],
    projects: [],
  };
}

/** the four branches with one ctx each, run as the eye runs them: the map's order (forecast 3,
 *  learning 4, planner 6, executor 7), each view kept for the others' peek */
function rig() {
  let t = T0;
  const views = new Map<string, any>();
  const stored = new Map<string, any>();
  const events: string[] = [];
  const ctxOf = (id: string) => ({
    now: () => t,
    load: <T>(fb: T): T => (stored.has(id) ? stored.get(id) : fb),
    save: (d: unknown) => { stored.set(id, JSON.parse(JSON.stringify(d))); },
    emit: (s: string) => { events.push(`${id}: ${s}`); },
    peek: (other: string) => views.get(other) ?? null,
  });
  const branches = [
    forecastCreate(ctxOf('forecast') as any),
    learningCreate(ctxOf('learning') as any),
    plannerCreate(ctxOf('planner') as any),
    executorCreate(ctxOf('executor') as any),
  ];
  let before: any = null;
  return {
    views, stored, events,
    /** one look; saves are paced at a minute, so the clock steps 61 s and every look is saved */
    step(mine: { done: number; tps: number }) {
      t += 61_000;
      const s = look(t, mine);
      for (const b of branches) {
        assert.doesNotThrow(() => b.observe(s as any, before), `${b.id} observe`);
        let v: any;
        assert.doesNotThrow(() => { v = b.view(); }, `${b.id} view`);
        views.set(b.id, v);
      }
      before = s;
    },
  };
}

/** every card a view holds: its action is null or exactly what cleanAction lets through */
function checkCards(views: Map<string, any>) {
  for (const [id, v] of views) {
    for (const c of v.suggestions ?? []) {
      if (c.action == null) continue;
      const clean = cleanAction(c.action);
      assert.notEqual(clean, null, `${id} card ${c.id}: action ${JSON.stringify(c.action)} does not pass cleanAction`);
      assert.ok(sameAction(clean, c.action), `${id} card ${c.id}: cleanAction changed ${JSON.stringify(c.action)}`);
    }
  }
}

const speedOfMe = (r: ReturnType<typeof rig>) => ({
  learning: r.stored.get('learning')?.devices?.me?.speed ?? null,
  forecast: r.stored.get('forecast')?.dev?.me?.tps?.[FILE] ?? null,
  planner: r.stored.get('planner')?.speeds?.local?.[FILE] ?? null,
  plannerHint: (r.views.get('planner')?.hints ?? []).find((h: any) => h.id === 'local' || h.id === 'me') ?? null,
});

test('phone look, done 0 and tps null: no branch records or shows a measured speed for me', () => {
  const r = rig();
  r.step({ done: 0, tps: 0 });
  r.step({ done: 0, tps: 0 });
  const s = speedOfMe(r);
  assert.equal(s.learning, null, 'learning records no speed for me');
  assert.equal(r.stored.get('learning')?.devices?.me, undefined, 'learning has no device me at all');
  assert.equal(s.forecast, null, 'forecast records no speed for me');
  assert.equal(s.planner, null, 'planner records no speed for this phone');
  assert.equal(s.plannerHint, null, 'planner hands the others no speed for this phone');
  // nothing on any page quotes a tok/s for this phone
  const exec = r.views.get('executor');
  const mine = exec.lines.find((l: string) => l.startsWith('my phone ·'));
  assert.match(mine, /speed not measured yet · 0 answers/);
  // the planner's own seat row for this phone has no speed of its own (no bandwidth, nothing measured)
  const seat = r.views.get('planner').rows.find((x: [string, string]) => x[0] === 'my phone');
  assert.ok(seat, 'the planner seats this phone');
  assert.match(seat[1], /speed not measured yet/);
  for (const [id, v] of r.views) {
    for (const l of [...v.lines, ...v.rows.map((x: [string, string]) => x.join(' '))]) {
      if (!/my phone/.test(l)) continue;
      // a planner place line ("apart: tablet and my phone · ~17 tok/s") is the fastest seat's speed,
      // here the tablet's bandwidth estimate, not one of this phone's
      if (id === 'planner' && /^(alone|apart|split): /.test(l)) continue;
      assert.doesNotMatch(l, /\d tok\/s/, `${id} shows a speed for my phone: ${l}`);
    }
  }
  assert.doesNotMatch(r.views.get('learning').lines.join('\n'), /^my phone/m, 'learning learns nothing about me yet');
  checkCards(r.views);
});

test('phone look, done 3 with tps 14.2: each branch takes it in once; the same look again changes nothing', () => {
  const r = rig();
  r.step({ done: 0, tps: 0 });
  r.step({ done: 3, tps: 14.2 });
  const first = speedOfMe(r);
  // learning: the first measured answer starts the guess at 14.2 (unscored by design: there was no guess before)
  assert.ok(first.learning, 'learning keeps a speed for me');
  assert.equal(first.learning.est, 14.2);
  assert.equal(first.learning.done, 3);
  assert.equal(first.learning.key, `${FILE}|${SINCE}`);
  assert.deepEqual(first.learning.errs, []);
  assert.match(r.views.get('learning').lines.join('\n'), /^my phone · speed: first answer · guess 14\.2 tok\/s/m);
  // forecast and planner book it once, with n 1
  assert.deepEqual([first.forecast?.avg, first.forecast?.n], [14.2, 1]);
  assert.deepEqual([first.planner?.tps, first.planner?.n], [14.2, 1]);
  assert.match(r.views.get('executor').lines.join('\n'), /^my phone · free · 14\.2 tok\/s · 3 answers/m);

  // a second look with the same done: nothing scored, nothing booked again
  r.step({ done: 3, tps: 14.2 });
  r.step({ done: 3, tps: 14.2 });
  const again = speedOfMe(r);
  assert.deepEqual(again.learning, first.learning, 'learning: the same done is no new answer');
  assert.equal(again.forecast?.n, 1, 'forecast: booked once');
  assert.equal(again.planner?.n, 1, 'planner: booked once');
  assert.deepEqual(r.views.get('learning').rows[0], ['guesses scored', '0']);
  checkCards(r.views);
});

test('phone look, the next answer is scored exactly once and never again on a repeated look', () => {
  const r = rig();
  r.step({ done: 0, tps: 0 });
  r.step({ done: 3, tps: 14.2 });
  r.step({ done: 5, tps: 16 });                // a new answer: |16 - 14.2| / 16 = 11% off
  const one = speedOfMe(r).learning;
  assert.equal(one.errs.length, 1);
  assert.equal(one.n, 1);
  assert.equal(one.done, 5);
  assert.deepEqual(r.views.get('learning').rows[0], ['guesses scored', '1']);
  r.step({ done: 5, tps: 16 });
  r.step({ done: 5, tps: 16 });
  const still = speedOfMe(r).learning;
  assert.deepEqual(still, one, 'a look with the same done scores nothing');
  assert.deepEqual(r.views.get('learning').rows[0], ['guesses scored', '1']);
  assert.equal(speedOfMe(r).forecast?.n, 2);
  assert.equal(speedOfMe(r).planner?.n, 2);
  checkCards(r.views);
});

test('phone look: the peer\'s checkedAt is its heardAt, so its reach is one probe, not one per look', () => {
  const r = rig();
  for (let i = 0; i < 4; i++) r.step({ done: i ? 3 : 0, tps: 14.2 });
  const reach = r.stored.get('learning')?.devices?.['peer-a']?.reach;
  assert.ok(reach, 'learning saw the peer');
  assert.equal(reach.at, PEER_HEARD);
  assert.equal(reach.hits, '', 'the same heardAt is never rescored');
  assert.equal(reach.n, 0);
  const exec = r.views.get('executor').lines.find((l: string) => l.startsWith('tablet ·'));
  assert.doesNotMatch(exec, /checks failed/);
});

test('phone look through the whole eye: no branch breaks, every card action passes cleanAction', () => {
  let s: any = look(T0, { done: 0, tps: 0 });
  let t = T0;
  const logs: string[] = [];
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye'), now: () => t, log: (x: string) => logs.push(x) });
  const steps = [{ done: 0, tps: 0 }, { done: 0, tps: 0 }, { done: 3, tps: 14.2 }, { done: 3, tps: 14.2 }, { done: 5, tps: 16 }];
  for (const m of steps) {
    t += 5_000;
    s = look(t, m);
    eye.tick();
    const v = eye.view();
    for (const b of v.branches) assert.equal(b.error, undefined, `${b.id} broke: ${b.error}`);
    for (const c of v.cards) {
      if (c.action == null) continue;
      const clean = cleanAction(c.action);
      assert.notEqual(clean, null, `card ${c.id}: ${JSON.stringify(c.action)}`);
      assert.ok(sameAction(clean, c.action), `card ${c.id}: cleanAction changed ${JSON.stringify(c.action)}`);
    }
  }
  assert.equal(logs.filter((l) => /stopped|not usable|no look/.test(l)).length, 0, logs.join('\n'));
  eye.stop?.();
});
