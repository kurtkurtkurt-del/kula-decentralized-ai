// Roads (docs/ANCHOR.md, stage 3): a device reached by its lan address, an internet address or
// through an anchor of the circle, tried staggered in that order; apart mode, the network test
// and a split all follow the road. Three gates on 127.0.0.1, each with its own identity: A the
// anchor, W the worker (registered with A), M this computer (a member of A, paired with W).
// Nothing leaves loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startGateServer, connectRemote, type GateServer, type TlsServer, type Targets } from '../src/gate.ts';
import { createIdentity, Paired, type GateIdentity } from '../src/tls.ts';
import { AnchorHub, circleMembers, joinAnchor, type AnchorMembership } from '../src/anchor.ts';
import { pickRoute, roads, openRoad, roadDialer, ROAD_STAGGER_MS, type RoadContext, type Road } from '../src/road.ts';
import { probePeers, peerTls, whereIs, reachedBy, type Peer } from '../src/peers.ts';
import { openApart, openPeerDevice } from '../src/apart.ts';
import { measureLink } from '../src/link.ts';
import { prepareSplit } from '../src/split.ts';
import { explainPlan, simModel, MB } from '../src/planner.ts';
import { startApiServer } from '../src/api.ts';
import { serveModel } from '../src/modelserve.ts';
import { viaOf } from '../src/ui/devices.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-roads-'));

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// a "lan address" that takes the tcp connection and then says nothing at all (a wi-fi left behind)
function silentServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const held = new Set<net.Socket>();
    const s = net.createServer((c) => { c.on('error', () => {}); held.add(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => { for (const c of held) c.destroy(); s.close(); } }));
  });
}

// a tcp proxy that holds every chunk `delayMs` each way: a far leg
function delayProxy(targetPort: number, delayMs: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const open = new Set<net.Socket>();
    const s = net.createServer((c) => {
      const up = net.connect({ host: '127.0.0.1', port: targetPort });
      for (const x of [c, up]) { x.on('error', () => {}); open.add(x); x.once('close', () => { c.destroy(); up.destroy(); }); }
      c.on('data', (d) => setTimeout(() => { if (!up.destroyed) up.write(d); }, delayMs));
      up.on('data', (d) => setTimeout(() => { if (!c.destroyed) c.write(d); }, delayMs));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => { for (const x of open) x.destroy(); s.close(); } }));
  });
}

// a stand in for llama-server, as in apart.test.ts
function fakeLlamaServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const p of ['far ', 'and ', 'back']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

interface Home { identity: GateIdentity; paired: Paired; gate: GateServer; hub: AnchorHub | null }

async function home(name: string, targets: Targets, anchor = false, pin: string | null = null): Promise<Home> {
  const dir = tmp();
  const identity = createIdentity(name);
  const paired = new Paired(path.join(dir, 'paired'));
  const t: TlsServer = { identity, paired, pin };
  const hub = anchor ? new AnchorHub({ self: identity.fp, isMember: circleMembers(paired, path.join(dir, 'peers.json')) }) : null;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets, tls: t, anchor: hub ?? undefined });
  return { identity, paired, gate, hub };
}

// A (anchor), W (worker: api and rpc behind its gate, registered with A), M (this computer)
async function world(opts: { mHub?: boolean } = {}) {
  const echo = await echoServer();                 // W's rpc program (ggml-rpc-server's stand-in)
  const llama = await fakeLlamaServer();
  const models = tmp();
  const api = await startApiServer({ fromGate: () => true, models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const A = await home('anchor-berlin', () => null, true);
  const W = await home('worker', (ch) => (ch === 'api' ? api.port : ch === 'rpc' ? echo.port : null));
  const M = await home('master', () => null, opts.mHub ?? false);
  A.paired.add(W.identity.fp);
  A.paired.add(M.identity.fp);
  W.paired.add(M.identity.fp);
  if (M.hub) M.paired.add(W.identity.fp);
  const members: AnchorMembership[] = [];
  const join = async (at: Home) => {
    const m = await joinAnchor({ anchor: { host: '127.0.0.1', port: at.gate.port, fp: at.identity.fp }, identity: W.identity, name: 'worker', kind: 'pc', gatePort: W.gate.port });
    members.push(m);
    return m;
  };
  const silent = await silentServer();
  const silent2 = await silentServer();
  const peer = (o: Partial<Peer> = {}): Peer => ({
    id: 'w', name: 'worker', host: '127.0.0.1', port: silent.port, secret: '', fp: W.identity.fp, pin: null, paired_at: 't',
    kind: 'pc', ram: 8000, bw: 40, added_at: 't',
    anchors: [{ fp: A.identity.fp, host: '127.0.0.1', port: A.gate.port, name: 'berlin' }],
    ...o,
  });
  return {
    A, W, M, api, echo, silent, silent2, peer, join,
    close: async () => {
      for (const m of members) await m.close();
      for (const h of [A, W, M]) { h.hub?.close(); await h.gate.close(); }
      silent.close(); silent2.close();
      await api.close(); llama.close(); echo.close();
    },
  };
}

const roadText = (r: Road | null) => (r === null ? 'none' : r.via === 'anchor' ? `anchor ${r.anchor}` : `${r.via} ${r.port}`);

test('roads: a silent lan, then the router port, then the anchor; back home the lan again; each pick well under 1.5 s', async () => {
  const w = await world();
  const stranger = await home('stranger', () => null, false, '00'.repeat(8)); // a gate with an open code: shows another certificate
  try {
    await w.join(w.A);
    const ctx: RoadContext = { identity: w.M.identity };
    // the order of tries: host/port, the addrs, then the anchors
    const p0 = w.peer({ addrs: [{ host: '127.0.0.1', port: stranger.gate.port, via: 'ipv6' }, { host: '127.0.0.1', port: w.W.gate.port, via: 'mapped' }] });
    assert.deepEqual(roads(p0, ctx).map(roadText), [`lan ${w.silent.port}`, `ipv6 ${stranger.gate.port}`, `mapped ${w.W.gate.port}`, `anchor ${w.A.identity.fp}`]);

    // 1. the lan says nothing, the stranger shows another certificate, the router port answers
    let t0 = Date.now();
    assert.equal(roadText(await pickRoute(p0, ctx, 2000)), `mapped ${w.W.gate.port}`);
    const mappedMs = Date.now() - t0;
    assert.ok(mappedMs < 1500, `picked in ${mappedMs} ms`);

    // 2. the router port is silent too: the anchor carries it
    const p1 = w.peer({ addrs: [{ host: '127.0.0.1', port: stranger.gate.port, via: 'ipv6' }, { host: '127.0.0.1', port: w.silent2.port, via: 'mapped' }] });
    t0 = Date.now();
    assert.equal(roadText(await pickRoute(p1, ctx, 2000)), `anchor ${w.A.identity.fp}`);
    const anchorMs = Date.now() - t0;
    assert.ok(anchorMs < 1500, `picked in ${anchorMs} ms (the serial pick took 2 s per silent address)`);
    assert.ok(anchorMs >= ROAD_STAGGER_MS, 'the anchor is the last road: it starts after the others');

    // the probe keeps it, both channels go along it, the book row says so
    const [r] = await probePeers([p1], 2000, ['rpc', 'api'], undefined, ctx);
    assert.deepEqual(r.peer.route, { via: 'anchor', anchor: w.A.identity.fp });
    assert.equal(r.api.ok, true);
    assert.equal(r.rpc.ok, true, 'the rpc channel follows the anchor road: far split is allowed');
    assert.equal(viaOf(r.peer), 'anchor');
    assert.equal(reachedBy(r.peer), null);
    assert.equal(whereIs(r.peer), 'through anchor berlin');

    // 3. back home: the lan address answers first and the route clears
    const back = { ...r.peer, port: w.W.gate.port };
    t0 = Date.now();
    assert.equal(roadText(await pickRoute(back, ctx, 2000)), `lan ${w.W.gate.port}`);
    assert.ok(Date.now() - t0 < ROAD_STAGGER_MS, 'the lan wins before the next try even starts');
    const [again] = await probePeers([back], 2000, ['api'], undefined, ctx);
    assert.equal(again.peer.route, null);
    assert.equal(reachedBy(again.peer), 'lan');

    // 4. only a stranger answers: no road, never the stranger's gate
    const lone = w.peer({ anchors: [], addrs: [{ host: '127.0.0.1', port: stranger.gate.port, via: 'mapped' }] });
    assert.equal(await pickRoute(lone, ctx, 600), null);
  } finally {
    await stranger.gate.close();
    await w.close();
  }
});

test('roads: an anchor is reached at its own address, never through an anchor; a device is never its own anchor', async () => {
  const w = await world();
  try {
    await w.join(w.A);
    const calls: string[] = [];
    const ctx: RoadContext = { identity: w.M.identity, connect: (h, p, t) => { calls.push(`${h}:${p}`); return connectRemote(h, p, t); } };
    // the anchor's own record lists itself and another anchor: no road to it through itself
    const other = createIdentity('anchor-two');
    const anchorRec: Peer = { ...w.peer(), id: 'a', fp: w.A.identity.fp, anchors: [{ fp: w.A.identity.fp, host: '127.0.0.1', port: w.A.gate.port }, { fp: other.fp, host: '127.0.0.1', port: 9 }] };
    assert.deepEqual(roads(anchorRec, { ...ctx, anchors: [{ fp: w.M.identity.fp, host: '127.0.0.1', port: 1 }] }).filter((r) => r.via === 'anchor').map(roadText), [`anchor ${other.fp}`], 'not itself, not this computer');
    // a stream through the anchor: one tcp connection, to the anchor's address, and nothing else
    const s = await openRoad({ via: 'anchor', anchor: w.A.identity.fp }, w.peer(), ctx, 3000);
    s.destroy();
    assert.deepEqual(calls, [`127.0.0.1:${w.A.gate.port}`]);
    // an anchor road whose anchor is not known is refused, not guessed
    await assert.rejects(openRoad({ via: 'anchor', anchor: other.fp }, w.peer({ anchors: [] }), ctx), /anchor not known/);
    // without a pinned certificate there is no anchor road at all
    assert.deepEqual(roads({ ...w.peer(), fp: null }, ctx).map((r) => r.via), ['lan']);
  } finally { await w.close(); }
});

test('roads: this computer is the anchor of its own peers: one hop in-process (self)', async () => {
  const w = await world({ mHub: true });
  try {
    await w.join(w.M);   // the worker registered with this computer
    const ctx: RoadContext = { identity: w.M.identity, hub: w.M.hub };
    const p = w.peer({ anchors: [] });
    assert.deepEqual(roads(p, ctx).map(roadText), [`lan ${w.silent.port}`, 'anchor self']);
    assert.deepEqual(await pickRoute(p, ctx, 2000), { via: 'anchor', anchor: 'self' });
    const dev = await openPeerDevice({ ...p, route: { via: 'anchor', anchor: 'self' } }, ctx);
    try {
      const st = await fetch(`http://127.0.0.1:${dev.apiPort}/status`);
      assert.equal(st.status, 200);
    } finally { await dev.close(); }
  } finally { await w.close(); }
});

test('roads: apart mode and the network test through an anchor behind a 40 ms leg; a broken road is picked again', async () => {
  const w = await world();
  const proxy = await delayProxy(w.A.gate.port, 20);
  const dir = tmp();
  const modelFile = path.join(dir, 'tiny.gguf');
  const bytes = randomBytes(100_000);
  fs.writeFileSync(modelFile, bytes);
  const served = await serveModel(modelFile, '127.0.0.1', '127.0.0.1');
  try {
    await w.join(w.A);
    // this computer reaches the anchor over a far leg (20 ms each way); the anchor reaches the worker at once
    const ctx: RoadContext = { identity: w.M.identity, connect: (h, p, t) => connectRemote('127.0.0.1', p === w.A.gate.port ? proxy.port : p, t) };
    const p = w.peer({ route: { via: 'anchor', anchor: w.A.identity.fp } });
    const link = await measureLink({ ...p, dial: roadDialer(p, ctx) }, peerTls(p, w.M.identity), { mb: 1, rounds: 5 });
    assert.equal(link.error, null);
    assert.ok(link.mbps! > 0);
    assert.ok(link.rttMs! >= 36 && link.rttMs! < 400, `rtt through the road ${link.rttMs} ms: both legs, the far one 40 ms there and back`);

    // apart mode: probe, tunnel, load and a chat, all through the anchor
    const cluster = await openApart({
      model: { url: served.url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, name: 'tiny.gguf', ctx: 512 },
      localModelFile: null, peers: [p], probeMs: 2000, identity: w.M.identity, roads: ctx,
    });
    try {
      assert.deepEqual(cluster.devices.map((d) => d.name), ['worker']);
      assert.deepEqual(cluster.stamped[0].route, { via: 'anchor', anchor: w.A.identity.fp });
      const r = await cluster.chat([{ role: 'user', content: 'hi' }], () => {});
      assert.equal(r.text, 'far and back');
    } finally { await cluster.close(); }

    // the road it had (an address now silent) does not open: the dialer picks again and goes on
    const stale = w.peer({ route: { host: '127.0.0.1', port: 1, via: 'mapped' } });
    const moved: Road[] = [];
    const dial = roadDialer(stale, { identity: w.M.identity }, { timeoutMs: 1000, pickMs: 1500, onRoute: (r) => moved.push(r) });
    const s = await dial();
    s.destroy();
    assert.deepEqual(moved, [{ via: 'anchor', anchor: w.A.identity.fp }]);
    assert.deepEqual(dial.road(), { via: 'anchor', anchor: w.A.identity.fp });
  } finally {
    await served.close();
    proxy.close();
    await w.close();
  }
});

test('the engine\'s rows: via anchor, through the anchor\'s row, the anchor offers the role; engine.anchor() counts', async () => {
  const w = await world({ mHub: true });
  const dir = tmp();
  process.env.KULA_NODE_HOME = dir;
  const { Engine } = await import('../src/ui/engine.ts');
  try {
    await w.join(w.M);
    const peersFile = path.join(dir, 'peers.json');
    const anchorRec: Peer = { id: 'a', name: 'berlin mac', named: true, host: '127.0.0.1', port: w.A.gate.port, secret: '', fp: w.A.identity.fp, pin: null, paired_at: 't', kind: 'pc', ram: null, bw: null, added_at: 't' };
    fs.writeFileSync(peersFile, JSON.stringify([anchorRec, w.peer({ route: { via: 'anchor', anchor: w.A.identity.fp } })]));
    const e = new Engine({ peersFile, pairedFile: path.join(dir, 'paired'), identity: w.M.identity, llama: null, anchorHub: () => w.M.hub });
    const rows = e.peers();
    const wr = rows.find((r) => r.id === 'w')!;
    assert.equal(wr.via, 'anchor');
    assert.equal(wr.through, 'a');
    assert.equal(wr.throughName, 'berlin mac');
    assert.equal(wr.where, 'through anchor berlin mac');
    assert.equal(wr.reachedBy, null);
    assert.equal(rows.find((r) => r.id === 'a')!.anchor, true, 'a record names it as an anchor');
    assert.equal(rows.find((r) => r.id === 'a')!.where, `127.0.0.1:${w.A.gate.port}`, 'a device reached directly keeps its address');
    // this computer as the anchor: the worker registered here
    const v = e.anchor();
    assert.deepEqual({ ...v, bytesDay: 0, memberMaxDay: 0 }, { on: true, reachable: null, links: 1, bytesDay: 0, capDay: 5_000_000_000, memberMaxDay: 0 });
    // the most one dialing member passed today: never more than all of them together (anchor-join.test.ts counts it)
    assert.ok(v.memberMaxDay <= v.bytesDay);
    // through this computer's own anchor
    fs.writeFileSync(peersFile, JSON.stringify([w.peer({ anchors: [], route: { via: 'anchor', anchor: 'self' } })]));
    const self = e.peers()[0];
    assert.deepEqual([self.via, self.through, self.where], ['anchor', 'self', 'through this computer (its anchor)']);
    // no anchor here: off
    assert.deepEqual(new Engine({ peersFile, pairedFile: path.join(dir, 'paired'), identity: w.M.identity, llama: null }).anchor(), { on: false, reachable: null, links: 0, bytesDay: 0, capDay: null, memberMaxDay: 0 });
  } finally { await w.close(); }
});

test('roads: a split through an anchor reaches the worker\'s rpc program byte for byte; the plan names the road', async () => {
  const w = await world();
  try {
    await w.join(w.A);
    const ctx: RoadContext = { identity: w.M.identity };
    // 9 GB: does not fit in this computer's 4 GB, so the worker takes a part
    const model = simModel({ id: 'm9', size: 9 * 1024 * MB, layers: 28, hidden: 3584, vocab: 152064, quant: 'Q4_K_M', kv_mb_per_1k: 56 });
    const p = w.peer({ ram: 12000, link: { mbps: 12, rttMs: 45, at: 't', error: null } });
    const setup = await prepareSplit({ model, ctx: 2048, localFreeMb: 4000, localBw: 20, peers: [p], probeMs: 2000, identity: w.M.identity, roads: ctx });
    try {
      assert.deepEqual(setup.plan.skipped, []);
      assert.deepEqual(setup.plan.used.map((u) => u.name), ['worker']);
      assert.deepEqual(setup.plan.used[0].route, { via: 'anchor', anchor: w.A.identity.fp }, 'the probe picked the anchor road');
      // the far link's round trips are in the estimate: 1.1 × 45 ms plus the activations (2.4 ms at 12 MB/s)
      assert.ok(setup.plan.est.netMsPerToken >= 51.5 && setup.plan.est.netMsPerToken < 52.5,`net ${setup.plan.est.netMsPerToken} ms a token`);
      const payload = randomBytes(64 * 1024);
      const got = await new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        let n = 0;
        const c = net.connect({ host: '127.0.0.1', port: setup.tunnels[0].port }, () => c.write(payload));
        c.on('data', (d) => { parts.push(d); n += d.length; if (n >= payload.length) { c.destroy(); resolve(Buffer.concat(parts)); } });
        c.once('error', reject);
        setTimeout(() => reject(new Error(`only ${n} bytes back`)), 5000).unref();
      });
      assert.ok(got.equals(payload), 'the bytes went to the worker\'s rpc program through the anchor and back unchanged');
      const lines = explainPlan(setup.plan, 'Qwen 9B');
      assert.ok(lines.some((l) => /^worker \(computer\): \d+ layers .*; through anchor berlin, network 12 MB\/s, 45 ms; about 49\.5 ms of each token on the way\.$/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /^estimate: about /.test(l)));
    } finally { await setup.close(); }
  } finally { await w.close(); }
});
