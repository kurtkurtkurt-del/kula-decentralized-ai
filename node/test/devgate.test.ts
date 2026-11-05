// The Mac's dev gate (app/modules/kula-llama/tools/dev-gate.mjs --tls) against this
// package's client: the same v1 hello (3 or 4 fields) and the same v2 pairing dance as
// node/src/gate.ts and Gate.kt. The gate has no llama binaries here, so every accepted
// handshake ends in "NO channel closed": that reason means the proof was taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectRemote, handshake, GateRefused, type TlsClient } from '../src/gate.ts';
import { createIdentity } from '../src/tls.ts';

const script = new URL('../../app/modules/kula-llama/tools/dev-gate.mjs', import.meta.url).pathname;
const secret = 'abababababababababababababababababababababababababababababababab';
const pin = '0123456789abcdef';
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

async function startDevGate(): Promise<{ port: number; fp: string; dir: string; log: () => string; stop: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-devgate-'));
  const port = 50000 + Math.floor(Math.random() * 10000);
  const p = spawn(process.execPath, [script, '--secret', secret, '--port', String(port), '--tls', '--pin', pin, '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const fp = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`dev-gate did not start:\n${out}`)), 15000);
    p.stdout.on('data', () => { const m = out.match(/"fp":"([0-9a-f]{64})"/); if (m) { clearTimeout(t); resolve(m[1]); } });
    p.once('exit', () => { clearTimeout(t); reject(new Error(`dev-gate exited:\n${out}`)); });
  });
  return { port, fp, dir, log: () => out, stop: () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// the gate's answer to one handshake: 'accepted' (reached the target step) or its NO reason
async function tryGate(port: number, tls: TlsClient | null, clockMs?: number): Promise<string> {
  const s = await connectRemote('127.0.0.1', port);
  try {
    await handshake(s, secret, 'api', 3000, clockMs, tls);
    return 'accepted';
  } catch (e) {
    if (e instanceof GateRefused) return e.reason === 'channel closed' ? 'accepted' : e.reason;
    return (e as Error).message;
  } finally {
    s.destroy();
  }
}

test('dev-gate --tls speaks v1 and v2 the way node/src/gate.ts does', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const g = await startDevGate();
  try {
    assert.equal(await tryGate(g.port, null), 'accepted', 'v1, 3 fields');
    assert.equal(await tryGate(g.port, null, Date.now()), 'accepted', 'v1 with the clock');
    const me = createIdentity('devgate-test');
    assert.equal(await tryGate(g.port, { identity: me, fp: g.fp, pin: 'ffffffffffffffff' }), 'wrong pin');
    assert.equal(await tryGate(g.port, { identity: me, fp: g.fp, pin: null }), 'not paired');
    assert.equal(await tryGate(g.port, { identity: me, fp: g.fp, pin }), 'accepted', 'pairing with the code');
    assert.equal(await tryGate(g.port, { identity: me, fp: g.fp, pin: null }), 'accepted', 'paired: no code needed');
    assert.equal(await tryGate(g.port, { identity: me, fp: g.fp, pin }), 'accepted', 'a paired phone offering the spent code is still paired');
    assert.equal(await tryGate(g.port, { identity: createIdentity('stranger'), fp: g.fp, pin: null }), 'not paired');
    assert.equal(await tryGate(g.port, { identity: createIdentity('stranger'), fp: g.fp, pin }), 'wrong pin', 'the code was spent by the pairing');
    assert.match(await tryGate(g.port, { identity: me, fp: 'a'.repeat(64), pin: null }), /fingerprint mismatch/);
    assert.match(g.log(), /paired 127\.0\.0\.1/);
    assert.equal(fs.readFileSync(path.join(g.dir, 'paired'), 'utf8').split('\n').filter(Boolean).length, 1);
  } finally {
    g.stop();
  }
});
