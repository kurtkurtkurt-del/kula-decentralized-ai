import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { exited } from '../src/children.ts';

test('a child killed by a signal has ended too (exitCode stays null then)', async () => {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  assert.equal(exited(p), false);
  await new Promise<void>((r) => { p.once('exit', () => r()); p.kill('SIGKILL'); });
  assert.equal(p.exitCode, null, 'the case that hung stop() and the split recovery');
  assert.equal(p.signalCode, 'SIGKILL');
  assert.equal(exited(p), true);
});
