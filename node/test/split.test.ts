// Split mode without llama.cpp: the plan, the rpc tunnels and the llama-server
// arguments are checked against fake workers; the server itself is a fake
// process (a node script) and, when there is no binary at all, a clear error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startGateServer } from '../src/gate.ts';
import { prepareSplit, splitServerArgs, startSplitServer } from '../src/split.ts';
import { TooBig, MB, tensorSplit } from '../src/planner.ts';
import type { Peer } from '../src/peers.ts';

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

async function rpcWorker(name: string, secret: string, ram: number, bw: number) {
  const rpc = await echoServer(); // stands in for ggml-rpc-server
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'rpc' ? rpc.port : null) });
  const peer: Peer = { id: `id-${name}`, name, host: '127.0.0.1', port: gate.port, secret, kind: 'pc', ram, bw, added_at: 't' };
  return { peer, close: async () => { await gate.close(); rpc.close(); } };
}

test('split: probe, plan, tunnels; a dead peer and a wrong secret drop out before llama.cpp sees them', async () => {
  const a = await rpcWorker('a', 'sa', 8000, 40);
  const b = await rpcWorker('b', 'sb', 8000, 10);
  const dead: Peer = { ...a.peer, id: 'dead', name: 'dead', port: 1 };
  const liar: Peer = { ...b.peer, id: 'liar', name: 'liar', secret: 'zz' };
  const logs: string[] = [];
  const t0 = Date.now();
  const setup = await prepareSplit({ modelBytes: 9000 * MB, localFreeMb: 4000, localBw: 20, peers: [dead, a.peer, liar, b.peer], probeMs: 800, log: (s) => logs.push(s) });
  try {
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual(setup.plan.skipped.map((s) => `${s.peer.name}:${s.why}`).sort(), ['dead:connect ECONNREFUSED 127.0.0.1:1', 'liar:wrong secret']);
    // ~9.9 GB needed, 2.8 GB here: a (40 GB/s) fills first, b (10) takes what is left
    assert.equal(setup.plan.fitsAlone, false);
    assert.deepEqual(setup.plan.used.map((u) => u.name), ['a', 'b']);
    assert.equal(setup.plan.used[0].assignedMb, 6000);
    assert.ok(setup.plan.localMb <= 2800 && setup.plan.localMb > 300);
    assert.equal(setup.tunnels.length, 2);
    assert.match(setup.rpcArg, /^127\.0\.0\.1:\d+,127\.0\.0\.1:\d+$/);
    assert.equal(setup.tensorSplitArg, tensorSplit(setup.plan).join(','));
    const args = splitServerArgs('/m/x.gguf', 8080, 2048, setup);
    assert.deepEqual(args.slice(0, 10), ['--host', '127.0.0.1', '--port', '8080', '-m', '/m/x.gguf', '-c', '2048', '-ngl', '99']);
    assert.deepEqual(args.slice(-4), ['--rpc', setup.rpcArg, '--tensor-split', setup.tensorSplitArg]);
    // the tunnels really reach the workers' rpc ports (echo here)
    for (const t of setup.tunnels) {
      const echoed = await new Promise<string>((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port: t.port }, () => c.write('ping'));
        c.once('data', (d) => { resolve(d.toString()); c.destroy(); });
        c.once('error', reject);
      });
      assert.equal(echoed, 'ping');
    }
    assert.ok(logs.some((l) => l.startsWith('dead: skipped')));
  } finally {
    await setup.close();
    await a.close();
    await b.close();
  }
});

test('split: too big even together is TooBig; with no worker the arguments carry no --rpc', async () => {
  await assert.rejects(prepareSplit({ modelBytes: 50000 * MB, localFreeMb: 4000, localBw: 20, peers: [] }), TooBig);
  const alone = await prepareSplit({ modelBytes: 1000 * MB, localFreeMb: 4000, localBw: 20, peers: [] });
  assert.equal(alone.rpcArg, '');
  assert.ok(!splitServerArgs('/m/x.gguf', 1, 1, alone).includes('--rpc'));
});

test('split: without llama.cpp the start fails with the setup hint; with a fake llama-server it waits for /health', async () => {
  const setup = { plan: null as any, tunnels: [], rpcArg: '', tensorSplitArg: '', close: async () => {} };
  await assert.rejects(startSplitServer(null, '/m/x.gguf', 512, setup, () => {}), /kula-node setup/);

  // a fake llama-server: a node script that listens on --port and answers /health after a moment
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-fakellama-'));
  const script = path.join(dir, 'llama-server.js');
  fs.writeFileSync(script, `
    const http = require('http');
    const args = process.argv.slice(2);
    const port = Number(args[args.indexOf('--port') + 1]);
    require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(args));
    let ready = false; setTimeout(() => { ready = true; }, 400);
    http.createServer((req, res) => { if (req.url === '/health' && ready) res.end('{"status":"ok"}'); else { res.writeHead(503); res.end(); } }).listen(port, '127.0.0.1');
  `);
  const bin = path.join(dir, process.platform === 'win32' ? 'llama-server.cmd' : 'llama-server');
  if (process.platform === 'win32') fs.writeFileSync(bin, `@node "${script}" %*\r\n`);
  else { fs.writeFileSync(bin, `#!/bin/sh\nexec node "${script}" "$@"\n`); fs.chmodSync(bin, 0o755); }
  const logs: string[] = [];
  const child = await startSplitServer({ rpcServer: bin, llamaServer: bin, where: dir }, '/m/x.gguf', 512, { ...setup, rpcArg: '127.0.0.1:1,127.0.0.1:2', tensorSplitArg: '1,2,3' }, (s) => logs.push(s));
  try {
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
    assert.deepEqual(args.slice(-4), ['--rpc', '127.0.0.1:1,127.0.0.1:2', '--tensor-split', '1,2,3']);
    assert.equal((await fetch(`http://127.0.0.1:${child.port}/health`)).status, 200);
    assert.ok(logs.some((l) => l.includes('llama-server listening')));
  } finally {
    await child.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
