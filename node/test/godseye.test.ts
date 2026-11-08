// god's eye (src/godseye): the twelve branches over a snapshot, a broken branch kept apart, the
// notes file, the adapter from kula's engine, and the rule that the eye imports nothing of kula.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, BRANCH_IDS, dark } = await import('../src/godseye/index.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { kulaSnapshot } = await import('../src/ui/godseye-feed.ts');
const { writePeers } = await import('../src/peers.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const snap = (devices: any[], at = 1000) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [{ at: 900, text: 'added pixel' }], llama: true },
  models: [], projects: [],
});

test('the twelve branches in the map\'s order; seven lit, five dark; senses says who answers and when that changes', () => {
  let s: any = snap([dev()]);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye1') });
  eye.tick();
  const v = eye.view();
  assert.deepEqual(v.branches.map((b) => b.id), BRANCH_IDS);
  assert.deepEqual(v.branches.map((b) => b.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(v.branches.filter((b) => b.built).map((b) => b.id), ['senses', 'memory', 'connections', 'planner', 'executor', 'trust', 'models']);
  const senses = v.branches.find((b) => b.id === 'senses')!;
  assert.equal(senses.stat, '1 of 1 devices active');
  assert.equal(senses.gauge, 100);
  assert.ok(v.branches.every((b) => b.what.length > 10));
  s = snap([dev({ reachable: false, reason: 'connect timeout' })], 2000);
  eye.tick();
  assert.match(eye.view().events[0].text, /pixel stopped answering: connect timeout/);
  assert.equal(eye.view().events[0].branch, 'senses');
});

test('a branch that throws is stopped and shown broken; the others and the next looks carry on; a failing snapshot is skipped', () => {
  let fail = false;
  const eye = new GodsEye({
    snapshot: () => { if (fail) throw new Error('no engine'); return snap([dev()]); },
    dir: path.join(HOME, 'eye2'),
    makers: { forecast: () => ({ id: 'forecast', observe() { throw new Error('bad maths'); }, view: () => dark() }) },
  });
  eye.tick();
  eye.tick();
  const v = eye.view();
  const f = v.branches.find((b) => b.id === 'forecast')!;
  assert.equal(f.stat, 'broken');
  assert.equal(f.error, 'bad maths');
  assert.equal(v.branches.find((b) => b.id === 'senses')!.built, true);
  fail = true;
  assert.doesNotThrow(() => eye.tick());
  assert.equal(eye.view().at, 1000);
});

test('a branch keeps its notes in its own file, mode 600, and reads them back', () => {
  const dir = path.join(HOME, 'eye3');
  let seen: any = null;
  const maker = (ctx: any) => ({ id: 'learning' as const, observe() { const n = ctx.load({ looks: 0 }); ctx.save({ looks: n.looks + 1 }); seen = ctx.load(null); }, view: () => dark() });
  const eye = new GodsEye({ snapshot: () => snap([]), dir, makers: { learning: maker } });
  eye.tick();
  eye.tick();
  assert.deepEqual(seen, { looks: 2 });
  assert.equal(fs.statSync(path.join(dir, 'learning.json')).mode & 0o777, 0o600);
});

test('the snapshot the eye gets is a copy: changing it inside a branch does not reach the source', () => {
  const source = snap([dev()]);
  const eye = new GodsEye({ snapshot: () => source, dir: path.join(HOME, 'eye4'), makers: { review: () => ({ id: 'review', observe(s: any) { s.devices[0].name = 'changed'; }, view: () => dark() }) } });
  eye.tick();
  assert.equal(source.devices[0].name, 'pixel');
});

test('kula\'s engine turned into the eye\'s snapshot: devices, work, models, projects; no secret', () => {
  const file = path.join(HOME, 'peers.json');
  writePeers([{ id: 'cable:R3C', name: 'SM S936B', host: '127.0.0.1', port: 6000, secret: 'deadbeef'.repeat(4), fp: 'ab'.repeat(32), pin: null, relay: null, kind: 'phone', ram: 3421, bw: 65.9, cable: { serial: 'R3C' }, added_at: new Date().toISOString() } as any], file);
  const engine = new Engine({ peersFile: file, modelDirs: [path.join(HOME, 'models')], llama: null });
  const s = kulaSnapshot(engine, { list: () => [] } as any, 5000);
  assert.equal(s.at, 5000);
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].via, 'cable');
  assert.equal(s.devices[0].ramMb, 3421);
  assert.equal(s.devices[0].tls, true);
  assert.ok(s.models.length > 0);
  assert.equal(s.work.loaded, null);
  assert.ok(!/deadbeef|abab/.test(JSON.stringify(s)));
});

test('god\'s eye imports nothing of kula: it can leave as a program of its own', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'godseye');
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/from '([^']+)'/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec === '../types.js', `${f} imports ${spec}`);
    }
  }
});
