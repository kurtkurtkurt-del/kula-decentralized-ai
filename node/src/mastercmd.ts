// `kula-node peers …` and `kula-node chat …`: this computer runs the cluster.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { discover, findPeer, maskSecret, parsePeerText, peerCode, peersFile, probePeers, readPeers, removePeer, upsertPeer, writePeers, whereIs, type Peer } from './peers.js';
import { loadOrCreateIdentity } from './tls.js';
import { loadOrCreate as loadDeviceKey } from './audit/key.js';
import { home } from './paths.js';
import { openApart, batchReport, type Cluster, type Message, type Reply } from './apart.js';
import { prepareSplit, startSplitServer } from './split.js';
import { TooBig } from './planner.js';
import { findLlama, sha256File } from './llama.js';
import { serveModel } from './modelserve.js';
import { freeRamMB, lanIPv4, measureBandwidth } from './sysinfo.js';
import { expandHome } from './paths.js';
import { DashboardState, type DeviceView } from './dashboard/state.js';
import { startDashboard, BATCH_PROMPTS, type Dashboard } from './dashboard/server.js';
import { selfView, peerActions, ledgerActions, hostName, DASHBOARD_PORT } from './dashboard/wire.js';
import { deviceId } from './share.js';

type Flags = Record<string, string | boolean>;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.error(`${stamp()}  ${s}`);

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: string | boolean | undefined, d: number): number => { if (v === undefined || v === true) return d; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`); return n; };

function row(p: Peer, extra = ''): string {
  const ram = p.ram != null ? `${p.ram} MB` : '?';
  const bw = p.bw != null ? `${p.bw} GB/s` : '?';
  const trust = p.fp ? `cert ${p.fp.slice(0, 8)}${p.pin ? ' +pin' : ''}` : p.relay ? (p.pin ? 'pin, cert to learn' : 'no pin, no cert') : `secret ${maskSecret(p.secret)}`;
  return `${p.id.slice(0, 8)}  ${p.name.padEnd(18)} ${p.kind.padEnd(6)} ${whereIs(p)}  ${trust}  ram ${ram}  bw ${bw}${p.last_ok ? `  ok ${p.last_ok.slice(0, 16)}` : ''}${extra}`;
}

// This computer's certificate (protocol v2): made on first use, kept in ~/.kula-node.
const identity = () => loadOrCreateIdentity(home(), loadDeviceKey());

// the relay for a code typed without one: --relay, else $KULA_RELAY
const relayOf = (flags: Flags): string | undefined => str(flags.relay) ?? process.env.KULA_RELAY ?? undefined;

export async function peersCommand(sub: string | undefined, rest: string[], flags: Flags): Promise<number> {
  const file = str(flags.file) ?? peersFile();
  if (sub === 'add') {
    let text = rest.join(' ');
    if (!text || text === '-') text = fs.readFileSync(0, 'utf8');
    let peer: Peer;
    try { peer = parsePeerText(text, relayOf(flags)); } catch (e) { console.error(`peers add: ${(e as Error).message}`); return 2; }
    if (peer.relay && !peer.fp && !peer.pin) console.error('note: a relay code alone cannot pair; add the worker\'s pairing code after it (123456 <pin>) or scan its full code');
    if (str(flags.name)) peer.name = str(flags.name)!;
    const { list, added } = upsertPeer(readPeers(file), peer);
    writePeersSafe(list, file);
    console.log(`${added ? 'added' : 'updated'}: ${row(peer)}`);
    return 0;
  }
  if (sub === 'list' || sub === 'ls' || sub === undefined) {
    const list = readPeers(file);
    if (!list.length) { console.log(`no peers yet (${file}); add one with: kula-node peers add '<qr json>'`); return 0; }
    for (const p of list) console.log(flags.code ? `${row(p)}\n  code: ${peerCode(p)}` : row(p));
    return 0;
  }
  if (sub === 'rm' || sub === 'remove') {
    const ref = rest[0];
    if (!ref) { console.error('usage: kula-node peers rm <id | id prefix | name>'); return 2; }
    const { list, removed } = removePeer(readPeers(file), ref);
    if (!removed) { console.error(`no such peer: ${ref}`); return 1; }
    writePeersSafe(list, file);
    console.log(`removed: ${row(removed)}`);
    return 0;
  }
  if (sub === 'probe') {
    const all = readPeers(file);
    const wanted = rest.length ? rest.map((r) => findPeer(all, r)).filter((p): p is Peer => !!p) : all;
    if (!wanted.length) { console.error(rest.length ? `no such peer: ${rest.join(' ')}` : 'no peers to probe'); return 1; }
    const results = await probePeers(wanted, num(flags.timeout, 2000), undefined, undefined, identity());
    let bad = 0;
    for (const r of results) {
      const fmt = (x: typeof r.rpc) => (x.ok ? `OK ${x.ms} ms` : `NO ${x.reason}`);
      console.log(`${r.peer.name.padEnd(18)} ${whereIs(r.peer)}  rpc ${fmt(r.rpc)}  api ${fmt(r.api)}${r.peer.fp && !wanted.find((p) => p.id === r.peer.id)?.fp ? `  (certificate learned: ${r.peer.fp.slice(0, 16)}…)` : ''}`);
      if (!r.rpc.ok && !r.api.ok) bad++;
    }
    // stamp last_ok
    const stamped = all.map((p) => results.find((r) => r.peer.id === p.id)?.peer ?? p);
    writePeersSafe(stamped, file);
    return bad ? 1 : 0;
  }
  if (sub === 'scan' || sub === 'discover') {
    const ms = num(flags.timeout, 3000);
    console.error(`listening for _kula._tcp for ${ms} ms`);
    const found = await discover(ms);
    if (!found.length) { console.log('nothing announced itself'); return 1; }
    const known = readPeers(file);
    for (const f of found) {
      const have = known.find((p) => (f.id && p.id === f.id) || (p.host === f.host && p.port === f.port));
      console.log(`${(f.id ?? '?').slice(0, 8).padEnd(8)}  ${f.name.padEnd(18)} ${(f.kind ?? '?').padEnd(6)} ${f.host}:${f.port}  ram ${f.ram ?? '?'}  bw ${f.bw ?? '?'}  ${f.v ?? ''}  ${have ? 'known' : 'new: needs its qr or code (peers add)'}`);
    }
    return 0;
  }
  console.error('usage: kula-node peers add <qr json | code | host:port:secret | 6-digit relay code [pin] --relay wss://…> | list [--code] | rm <id> | probe [id…] | scan');
  return 2;
}

const writePeersSafe = writePeers;


export async function chatCommand(flags: Flags): Promise<number> {
  const modelArg = str(flags.model);
  if (!modelArg) { console.error('usage: kula-node chat --model <file.gguf> --mode apart|split [--peer id…] [--batch [file]] [--prompt "…"]'); return 2; }
  const modelFile = path.resolve(expandHome(modelArg));
  if (!fs.existsSync(modelFile)) { console.error(`no such model file: ${modelFile}`); return 2; }
  const mode = str(flags.mode) ?? 'apart';
  if (mode !== 'apart' && mode !== 'split') { console.error('--mode must be apart or split'); return 2; }
  const all = readPeers(str(flags.file) ?? peersFile());
  const wantedRefs = typeof flags.peer === 'string' ? flags.peer.split(',').filter(Boolean) : [];
  const peers = wantedRefs.length ? wantedRefs.map((r) => { const p = findPeer(all, r); if (!p) throw new Error(`no such peer: ${r}`); return p; }) : all;
  const llama = findLlama();
  const me = identity();
  const peersFileUsed = str(flags.file) ?? peersFile();
  const remote = peers.filter((p) => p.relay);
  if (mode === 'split' && remote.length) log(`${remote.map((p) => p.name).join(', ')}: far away (relay); split mode needs the lan, apart mode would use ${remote.length === 1 ? 'it' : 'them'}`);
  const ctx = num(flags.ctx, 4096);
  const maxTokens = num(flags['max-tokens'], 256);
  const size = fs.statSync(modelFile).size;
  const bw = flags.bw !== undefined ? num(flags.bw, 4) : await measureBandwidth().catch(() => 4);
  const probeMs = num(flags['probe-ms'], 2000);

  let cluster: Cluster;
  let extraClose: (() => Promise<void>)[] = [];
  if (mode === 'split') {
    if (!llama) { console.error('split mode needs llama.cpp on this computer: run kula-node setup'); return 1; }
    let setup;
    try {
      setup = await prepareSplit({ modelBytes: size, localFreeMb: freeRamMB(), localBw: bw, peers, share: flags['keep-local'] !== true, probeMs, log, identity: me });
    } catch (e) {
      if (e instanceof TooBig) { console.error(e.message); return 1; }
      throw e;
    }
    extraClose.push(setup.close);
    if (!setup.plan.used.length) log('no worker answered: running the model here alone');
    cluster = await openApart({
      model: { url: 'file://' + modelFile, sha256: await sha256File(modelFile), size, name: path.basename(modelFile), ctx },
      localModelFile: modelFile, localBw: bw, llama, peers: [], probeMs, log, identity: me,
      startBackend: (file, c) => startSplitServer(llama, file, c, setup, log),
    });
  } else {
    if (!peers.length && flags['no-local'] === true) { console.error('apart mode with --no-local needs at least one peer'); return 1; }
    log('hashing the model (once, for the peers)');
    const sha256 = await sha256File(modelFile);
    let url = str(flags['model-url']);
    if (!url && remote.length) { console.error(`${remote.map((p) => p.name).join(', ')}: far away; a model served from this lan does not reach it. pass --model-url with an address it can fetch (https), or let it use a model it already has (the worker api keeps what it downloaded)`); }
    if (!url && peers.length) {
      const host = lanIPv4();
      if (!host) { console.error('no lan ipv4 address: the peers cannot fetch the model from here; pass --model-url'); return 1; }
      const srv = await serveModel(modelFile, host, '0.0.0.0', num(flags['serve-port'], 0));
      extraClose.push(srv.close);
      url = srv.url;
      log(`serving the model to the peers at ${url.replace(/\/m\/[0-9a-f]+\//, '/m/…/')}`);
    }
    cluster = await openApart({
      model: { url: url ?? 'file://' + modelFile, sha256, size, name: path.basename(modelFile), ctx },
      localModelFile: flags['no-local'] === true ? null : modelFile, localBw: bw, llama, peers, probeMs, log, identity: me,
    });
  }
  // what the probe learned (a far peer's certificate, a spent pin, last_ok) goes back to the book
  if (cluster.stamped.length) writePeersSafe(readPeers(peersFileUsed).map((p) => cluster.stamped.find((s) => s.id === p.id) ?? p), peersFileUsed);
  log(`devices: ${cluster.devices.map((d) => d.name).join(', ')}${cluster.skipped.length ? `; skipped: ${cluster.skipped.map((s) => `${s.peer.name} (${s.why})`).join(', ')}` : ''}`);

  // the local dashboard: the devices, a chat box and the batch button on this very cluster
  let dashboard: Dashboard | null = null;
  let ledgerUi: ReturnType<typeof ledgerActions> | null = null;
  if (flags['no-dashboard'] !== true) {
    const state = new DashboardState('chat', selfView({ name: hostName(), id: deviceId(), host: lanIPv4(), ram: freeRamMB(), bw, gpu: null, vram: 0 }));
    const devices = (): DeviceView[] => cluster.devices.map((d) => ({ id: d.id, name: d.name, local: d.local, busy: d.busy, tps: d.tps, done: d.done, bw: d.bw }));
    state.devices(devices());
    state.api({ loaded: true, model: path.basename(modelFile), ctx, heldMB: Math.round(size / (1024 * 1024)), running: true });
    const peersUi = peerActions(state, str(flags.file), probeMs);
    ledgerUi = ledgerActions(state);
    const watched = {
      chat: async (m: Message[], onToken: (t: string) => void, o: { maxTokens?: number; device?: string }) => { state.devices(devices()); try { return await cluster.chat(m, onToken, { ...o, maxTokens: o.maxTokens ?? maxTokens }); } finally { state.devices(devices()); } },
      batch: async (p: string[], o: { maxTokens?: number; onReply?: (i: number, r: Reply) => void }) => cluster.batch(p, { maxTokens: o.maxTokens ?? maxTokens, onReply: (i, r) => { state.devices(devices()); o.onReply?.(i, r); } }),
    };
    try {
      dashboard = await startDashboard({ port: flags.dashboard !== undefined ? num(flags.dashboard, DASHBOARD_PORT) : DASHBOARD_PORT, state, chat: watched, actions: { probe: peersUi.probe, verify: ledgerUi.verify }, log, batchPrompts: BATCH_PROMPTS });
      ledgerUi.watch();
      peersUi.probe().catch(() => {});
    } catch (e) { log(`dashboard did not start: ${(e as Error).message} (--dashboard <port> or --no-dashboard)`); }
  }

  const shutdown = async () => { if (dashboard) await dashboard.close(); ledgerUi?.stop(); await cluster.close(); for (const c of extraClose) await c().catch(() => {}); };
  try {
    if (flags.batch !== undefined) {
      const prompts = typeof flags.batch === 'string' ? fs.readFileSync(expandHome(flags.batch), 'utf8').split('\n').filter((l) => l.trim()) : BATCH_PROMPTS;
      const t0 = Date.now();
      const replies = await cluster.batch(prompts, { maxTokens, onReply: (i, r) => log(`#${i + 1} ${r.device}: ${r.tokens} tok in ${r.ms} ms (${r.tps} tok/s)`) });
      console.log(`\n${prompts.length} prompts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const r of batchReport(replies)) console.log(`  ${r.device.padEnd(18)} ${String(r.prompts).padStart(2)} prompts  ${String(r.tokens).padStart(5)} tok  ${r.tps} tok/s`);
      if (flags.verbose) for (const [i, r] of replies.entries()) console.log(`\n--- #${i + 1} (${r.device})\n${prompts[i]}\n${r.text}`);
      return 0;
    }
    const history: Message[] = [];
    const ask = async (text: string) => {
      history.push({ role: 'user', content: text });
      const r = await cluster.chat(history, (t) => process.stdout.write(t), { maxTokens, device: str(flags.device) });
      history.push({ role: 'assistant', content: r.text });
      process.stdout.write(`\n`);
      log(`${r.device}: ${r.tokens} tok, ${r.tps} tok/s, first token ${r.firstMs} ms`);
    };
    if (str(flags.prompt)) { await ask(str(flags.prompt)!); return 0; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log('chat. empty line or ctrl-d to quit; "/reset" clears the history.');
    for (;;) {
      const line: string | null = await new Promise((res) => { rl.question('> ', res); rl.once('close', () => res(null)); });
      if (line === null || !line.trim()) break;
      if (line.trim() === '/reset') { history.length = 0; continue; }
      await ask(line);
    }
    rl.close();
    return 0;
  } finally {
    await shutdown();
  }
}
