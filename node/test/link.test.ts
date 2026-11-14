import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureLink, netOf } from '../src/link.ts';
import { startApiServer } from '../src/api.ts';

test('measureLink pulls the blob and times /status on the open connection', async () => {
  const api = await startApiServer({ models: fs.mkdtempSync(path.join(os.tmpdir(), 'kula-link-')), llama: null });
  let closed = 0;
  try {
    const l = await measureLink({ host: 'x', port: 1, secret: '' }, null, {
      mb: 2, rounds: 3,
      open: async () => ({ port: api.port, close: async () => { closed++; } }),
    });
    assert.equal(l.error, null);
    assert.ok(l.mbps! > 0, `mbps ${l.mbps}`);
    assert.ok(l.rttMs! >= 0 && l.rttMs! < 1000, `rtt ${l.rttMs}`);
    assert.equal(closed, 1, 'the tunnel is closed after');
  } finally {
    await api.close();
  }
});

test('measureLink: a device that does not answer gives an error, not a number', async () => {
  let closed = 0;
  const l = await measureLink({ host: 'x', port: 1, secret: '' }, null, {
    open: async () => ({ port: 9, close: async () => { closed++; } }),
  });
  assert.equal(l.mbps, null);
  assert.equal(l.rttMs, null);
  assert.ok(l.error);
  assert.equal(closed, 1);
});

test('netOf: the slowest link and the longest delay; unmeasured devices count as the guess', () => {
  const at = '2026-11-14T00:00:00Z';
  assert.deepEqual(netOf([]), { mbps: 30, rttMs: 3 });
  assert.deepEqual(netOf([{ mbps: 80, rttMs: 2, at, error: null }, { mbps: 40, rttMs: 9, at, error: null }]), { mbps: 40, rttMs: 9 });
  assert.deepEqual(netOf([{ mbps: 80, rttMs: 2, at, error: null }, null]), { mbps: 30, rttMs: 3 });
  assert.deepEqual(netOf([{ mbps: null, rttMs: null, at, error: 'x' }]), { mbps: 30, rttMs: 3 });
});
