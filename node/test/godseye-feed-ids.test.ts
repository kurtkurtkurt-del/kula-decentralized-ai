// the feed hands god's eye one id per device (G1, 12 Nov): status().loaded names a device by the
// record of the route it was loaded over, the snapshot's devices by the group's first record. A
// phone with a cable and a wi-fi record, loaded over wi-fi, must still be the same device to the
// forecast, limits, planner and trust branches.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-feed-ids-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { kulaSnapshot } = await import('../src/ui/godseye-feed.ts');

const row = {
  id: 'c1', name: 'pixel', kind: 'phone', where: 'usb R3C', far: false, tls: true, waitingPair: false,
  ram: 3400, bw: 60, gpu: null, last_ok: null, reach: { ok: true, ms: 9 }, probedAt: 1,
  cable: { serial: 'R3C', plugged: true }, holds: null, via: 'wifi',
  ways: { cable: null, wifi: null, relay: null }, routes: ['c1', 'w1'], heardAt: null,
  usesThisComputer: false, reachedBy: 'lan', ring: 'home',
};

const stubEngine = () => {
  let peersCalls = 0;
  const engine = {
    status: () => ({
      loaded: {
        mode: 'split', model: { id: 'm', name: 'm', file: 'm.gguf', size: 1 }, ctx: 4096, since: 1,
        devices: [
          { id: 'w1', name: 'pixel', local: false, busy: false, tps: null, done: 0 },
          { id: 'local', name: 'mac', local: true, busy: false, tps: null, done: 0 },
          { id: 'gone', name: 'old', local: false, busy: false, tps: null, done: 0 },
        ],
        parts: [
          { id: 'w1', name: 'pixel', local: false, mb: 900, layers: 10 },
          { id: 'local', name: 'mac', local: true, mb: 1800, layers: 20 },
        ],
      },
      loading: null, chatting: 0, plan: [], decisions: [], llama: true,
    }),
    peers: () => { peersCalls++; return [structuredClone(row)]; },
    trustOf: () => null,
    models: () => [],
    photos: () => ({ n: 0, unseen: 0, at: null }),
  };
  return { engine, calls: () => peersCalls };
};

const projects = {
  list: () => [{ id: 'p', title: 't', request: 'r', start: 's', end: 'e', state: 'waiting', mode: 'split', model: 'm', peers: ['w1', 'gone'], parts: 0, done: 0, line: '', error: null }],
};

test('a device loaded over its second route carries its row id in the snapshot', () => {
  const { engine, calls } = stubEngine();
  const s = kulaSnapshot(engine as any, projects as any, 5000);
  assert.equal(s.devices[0].id, 'c1');
  assert.equal(s.work.loaded!.devices[0].id, s.devices[0].id, 'loaded device id is the row id');
  assert.equal(s.work.loaded!.parts![0].id, s.devices[0].id, 'loaded part id is the row id');
  assert.equal(s.projects[0].peers[0], s.devices[0].id, 'project peer id is the row id');
  assert.equal(calls(), 1, 'peers() is asked once per snapshot');
});

test('local stays local and an unknown id passes through', () => {
  const { engine } = stubEngine();
  const s = kulaSnapshot(engine as any, projects as any, 5000);
  assert.equal(s.work.loaded!.devices[1].id, 'local');
  assert.equal(s.work.loaded!.parts![1].id, 'local');
  assert.equal(s.work.loaded!.devices[2].id, 'gone');
  assert.equal(s.projects[0].peers[1], 'gone');
});
