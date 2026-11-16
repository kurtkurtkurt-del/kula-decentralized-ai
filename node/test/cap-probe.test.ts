// An anchor's dial cap ("too many dials", anchor.ts) at the network test and the split's probe
// (D3 T1b, step 4): a network test during which the tunnel waited for the anchor is not a reading
// (the wait would be counted as transfer time: 2.1 MB/s in T1b) and the device keeps its old link;
// the probe waits for the bucket for up to 5 s, and a device still refused is left out with a
// plain reason instead of silently. Three gates on 127.0.0.1: A the anchor with a dial burst of 3,
// W the worker (api and rpc behind its gate, registered with A), M this computer (a friend member
// of A, paired with W). Nothing leaves loopback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cap-probe-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { startGateServer } = await import('../src/gate.ts');
type GateServer = import('../src/gate.ts').GateServer;
type TlsServer = import('../src/gate.ts').TlsServer;
type Targets = import('../src/gate.ts').Targets;
const { createIdentity, Paired } = await import('../src/tls.ts');
type GateIdentity = import('../src/tls.ts').GateIdentity;
const { AnchorHub, circleMembers, dialAnchor, joinAnchor } = await import('../src/anchor.ts');
type AnchorCaps = import('../src/anchor.ts').AnchorCaps;
type AnchorMembership = import('../src/anchor.ts').AnchorMembership;
type AnchorRef = import('../src/anchor.ts').AnchorRef;
const { roadDialer } = await import('../src/road.ts');
const { peerTls, writePeers, readPeers } = await import('../src/peers.ts');
type Peer = import('../src/peers.ts').Peer;
const { measureLink, LINK_HELD_BACK, heldBack } = await import('../src/link.ts');
const { planWithProbe, explainPlan, simModel, ANCHOR_LIMITING, PROBE_WAIT_MS, MB } = await import('../src/planner.ts');
const { startApiServer } = await import('../src/api.ts');
const { Engine } = await import('../src/ui/engine.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cap-probe-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

interface Home { identity: GateIdentity; paired: Paired; gate: GateServer; hub: InstanceType<typeof AnchorHub> | null }

async function home(name: string, targets: Targets, caps?: Partial<AnchorCaps>): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin: null };
  const hub = caps ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')), caps }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets, tls: t, anchor: hub ?? undefined });
  return { identity, paired, gate, hub };
}

// a dial burst of 3, refilled at `perMinute`
async function world(perMinute: number) {
  const echo = await echoServer();   // W's rpc program
  const api = await startApiServer({ fromGate: () => true, models: tmp(), llama: null });
  const A = await home('anchor-berlin', () => null, { dialBurst: 3, dialsPerMinute: perMinute });
  const W = await home('worker', (ch) => (ch === 'api' ? api.port : ch === 'rpc' ? echo.port : null));
  const M = await home('master', () => null);
  A.paired.add(W.identity.fp);
  A.paired.add(M.identity.fp);
  W.paired.add(M.identity.fp);
  const ref: AnchorRef = { host: '127.0.0.1', port: A.gate.port, fp: A.identity.fp };
  const member: AnchorMembership = await joinAnchor({ anchor: ref, identity: W.identity, name: 'worker', kind: 'pc', gatePort: W.gate.port });
  const peer: Peer = {
    id: 'w', name: 'worker', host: '127.0.0.1', port: 9, secret: '', fp: W.identity.fp, pin: null, paired_at: 't',
    kind: 'pc', ram: 8000, bw: 40, added_at: 't',
    anchors: [{ fp: A.identity.fp, host: '127.0.0.1', port: A.gate.port, name: 'berlin' }],
    route: { via: 'anchor', anchor: A.identity.fp },
  };
  // M spends its whole burst of 3 dials
  const spend = async () => { for (let i = 0; i < 3; i++) (await dialAnchor(ref, M.identity, W.identity.fp)).destroy(); };
  return {
    A, W, M, ref, peer, spend,
    close: async () => {
      await member.close();
      for (const h of [A, W, M]) { h.hub?.close(); await h.gate.close(); }
      await api.close();
      echo.close();
    },
  };
}

test('measureLink: a test during which the tunnel waited for the anchor gives an error, not the wait as MB/s', async () => {
  // one dial every 500 ms after the burst
  const w = await world(120);
  try {
    await w.spend();
    const held = await measureLink({ ...w.peer, dial: roadDialer(w.peer, { identity: w.M.identity }) }, peerTls(w.peer, w.M.identity), { mb: 1, rounds: 3 });
    assert.equal(held.error, LINK_HELD_BACK);
    assert.ok(heldBack(held));
    assert.equal(held.mbps, null, 'no number made of the wait');
    assert.equal(held.rttMs, null);
    // the bucket full again (3 dials in 1.5 s): the same test without a wait is a reading
    await sleep(1600);
    const ok = await measureLink({ ...w.peer, dial: roadDialer(w.peer, { identity: w.M.identity }) }, peerTls(w.peer, w.M.identity), { mb: 1, rounds: 3 });
    assert.equal(ok.error, null);
    assert.ok(ok.mbps! > 0 && ok.rttMs! >= 0, `${ok.mbps} MB/s, ${ok.rttMs} ms`);
  } finally { await w.close(); }
});

test('the network test through the engine: a reading the anchor held back is not stored, the old link stays', async () => {
  const w = await world(120);
  const dir = tmp();
  const peersFile = path.join(dir, 'peers.json');
  const old = { mbps: 40, rttMs: 12, at: '2026-11-16T10:00:00.000Z', error: null };
  writePeers([{ ...w.peer, link: old }], peersFile);
  const lines: string[] = [];
  const engine = new Engine({ peersFile, modelDirs: [], identity: w.M.identity, llama: null, probeMs: 1500, anchors: () => [], joinedFile: path.join(dir, 'anchors.json'), log: (s: string) => lines.push(s) });
  try {
    await w.spend();
    await engine.measure('w');
    assert.deepEqual(readPeers(peersFile).find((p) => p.id === 'w')!.link, old, 'the old link is kept');
    assert.ok(lines.some((l) => l === `worker: the network was not measured: ${LINK_HELD_BACK}`), lines.join(' | '));
    // with the bucket full again the new reading replaces it
    await sleep(1600);
    await engine.measure('w');
    const now = readPeers(peersFile).find((p) => p.id === 'w')!.link!;
    assert.equal(now.error, null);
    assert.notEqual(now.at, old.at);
    assert.ok(now.mbps! > 0);
  } finally {
    await engine.close();
    await w.close();
  }
});

const tiny = simModel({ id: 'tiny', size: 50 * MB, layers: 8, hidden: 512, vocab: 32000, quant: 'Q8_0', kv_mb_per_1k: 8 });
const plan = (w: Awaited<ReturnType<typeof world>>) => planWithProbe({
  model: tiny, ctx: 512, localFreeMb: 8000, localBw: 60, share: true, all: true,
  wanted: [w.peer], timeoutMs: 2000, identity: w.M.identity, roads: { identity: w.M.identity },
});

test('the split probe waits for the anchor\'s bucket and takes the worker when a dial comes back within 5 s', async () => {
  const w = await world(120);
  try {
    await w.spend();
    const t0 = Date.now();
    const pl = await plan(w);
    const ms = Date.now() - t0;
    assert.deepEqual(pl.skipped, [], `skipped: ${pl.skipped.map((s) => s.why).join(', ')}`);
    assert.deepEqual(pl.used.map((u) => u.id), ['w']);
    assert.ok(ms >= 250 && ms < PROBE_WAIT_MS, `it waited ${ms} ms`);
  } finally { await w.close(); }
});

test('the split probe: an anchor still refusing after 5 s leaves the worker out in plain words', async () => {
  // no dial back within the test
  const w = await world(0.001);
  try {
    await w.spend();
    const t0 = Date.now();
    const pl = await plan(w);
    const ms = Date.now() - t0;
    assert.deepEqual(pl.used, []);
    assert.deepEqual(pl.skipped.map((s) => s.why), [ANCHOR_LIMITING]);
    assert.ok(ms >= PROBE_WAIT_MS - 50 && ms < PROBE_WAIT_MS + 3000, `gave up after ${ms} ms`);
    assert.ok(explainPlan(pl, 'Tiny').includes("worker left out: the anchor is limiting this device's connections right now."), explainPlan(pl, 'Tiny').join(' | '));
  } finally { await w.close(); }
});
