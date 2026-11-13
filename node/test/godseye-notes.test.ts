// god's eye notes on a computer (P29, E7): a notes write is fsynced before and after its rename, and a
// torn notes file is said once, kept as <id>.bad.json (mode 600), and the branch starts fresh.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-notes-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, fileNotes } = await import('../src/godseye/index.ts');

let n = 0;
const freshDir = () => path.join(HOME, `eye${++n}`);
const snap = () => ({
  at: 1_000_000, host: { name: 'mac', freeMb: 8000 }, devices: [], models: [], projects: [],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
});
const memoryStat = (eye: any) => eye.view().branches.find((b: any) => b.id === 'memory').stat;

test('one write: fsync(file), rename, fsync(dir)', () => {
  const dir = freshDir();
  const notes = fileNotes(dir);
  const order: string[] = [];
  const fsync0 = fs.fsyncSync, rename0 = fs.renameSync;
  (fs as any).fsyncSync = (fd: number) => { order.push(fs.fstatSync(fd).isDirectory() ? 'fsync(dir)' : 'fsync(file)'); return fsync0(fd); };
  (fs as any).renameSync = (a: fs.PathLike, b: fs.PathLike) => { order.push('rename'); return rename0(a, b); };
  try { notes.write('memory', '{"v":1}'); }
  finally { (fs as any).fsyncSync = fsync0; (fs as any).renameSync = rename0; }
  assert.deepEqual(order, ['fsync(file)', 'rename', 'fsync(dir)']);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'), '{"v":1}');
  assert.equal(fs.statSync(path.join(dir, 'memory.json')).mode & 0o777, 0o600);
});

// the fresh memory stat, from an eye with no notes at all
const freshStat = (() => {
  const eye = new GodsEye({ snapshot: snap as any, dir: freshDir() });
  eye.tick();
  const s = memoryStat(eye);
  eye.stop();
  return s;
})();

for (const [name, torn] of [['torn', '{"v":1,"dev'], ['empty', '']] as const) {
  test(`a ${name} memory.json: one log line, kept as memory.bad.json (600), the branch starts fresh`, () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.json'), torn);
    const log: string[] = [];
    const eye = new GodsEye({ snapshot: snap as any, dir, log: (s: string) => log.push(s) });
    eye.tick();
    const about = log.filter((l) => /memory/.test(l));
    assert.equal(about.length, 1, JSON.stringify(log));
    assert.equal(about[0], `god's eye memory: its notes could not be read (${torn.length} chars); starting fresh, the old text is kept as memory.bad`);
    if (torn) assert.ok(!about[0].includes(torn));
    const bad = path.join(dir, 'memory.bad.json');
    assert.equal(fs.readFileSync(bad, 'utf8'), torn);
    assert.equal(fs.statSync(bad).mode & 0o777, 0o600);
    assert.deepEqual(memoryStat(eye), freshStat);
    eye.stop();
  });
}

test('good notes: no log line, no .bad file; forget removes memory.bad.json', () => {
  const dir = freshDir();
  const log: string[] = [];
  const a = new GodsEye({ snapshot: snap as any, dir, log: (s: string) => log.push(s) });
  a.tick();
  a.stop();
  assert.ok(fs.existsSync(path.join(dir, 'memory.json')), 'memory saved its notes');
  const b = new GodsEye({ snapshot: snap as any, dir, log: (s: string) => log.push(s) });
  b.tick();
  assert.deepEqual(log.filter((l) => /notes could not be read/.test(l)), []);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.bad')), []);
  fs.writeFileSync(path.join(dir, 'memory.bad.json'), 'x', { mode: 0o600 });
  b.forget();
  assert.equal(fs.existsSync(path.join(dir, 'memory.bad.json')), false);
  b.stop();
});
