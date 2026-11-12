// Glue between the commands and the dashboard: the pieces both `share` and
// `chat` hand over (this computer, the peer book, the ledger) and the probe /
// verify actions. Secrets stay in the peer book; only `peerView`s go out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardState, peerView, readPassport, type LedgerView, type SelfView } from './state.js';
import { readPeers, probePeers, writePeers, type Peer } from '../peers.js';
import { ledgerFile } from '../ledgercmd.js';
import { loadOrCreate } from '../audit/key.js';
import { chainFiles, readLines, settleLegacy, verifyChain } from '../audit/ledger.js';
import { totalRamMB } from '../sysinfo.js';

export const DASHBOARD_PORT = 50580;

export function selfView(x: { name: string; id: string; host: string | null; ram: number; bw: number; gpu: string | null; vram: number }): SelfView {
  const p = readPassport();
  return { ...x, totalRam: totalRamMB(), passport: p?.passport ?? null, passportFile: p?.file ?? null };
}

export function ledgerView(verify = false, tail = 12): LedgerView {
  const file = ledgerFile();
  if (verify) { try { settleLegacy(file, loadOrCreate()); } catch {} }
  const lines = readLines(file);
  const view: LedgerView = { file, lines: lines.slice(-tail), total: chainFiles(file).reduce((n, f) => n + readLines(f).length, 0), verify: null };
  if (verify) {
    const key = loadOrCreate();
    const r = verifyChain(file, key.publicKey);
    view.verify = { ok: r.ok, count: r.count, keyId: key.id, at: Date.now(), problems: r.files.flatMap((f) => f.problems.map((p) => ({ file: path.basename(f.file), n: p.n, reason: p.reason }))) };
  }
  return view;
}

export function modelsIn(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.gguf')).sort(); } catch { return []; }
}

// Peers for the state, and a probe that stamps last_ok like `kula-node peers probe`.
export function peerActions(state: DashboardState, file?: string, probeMs = 2000) {
  const list = (): Peer[] => readPeers(file);
  state.peers(list().map((p) => peerView(p)));
  const probe = async () => {
    const all = list();
    if (!all.length) { state.peers([]); return; }
    const results = await probePeers(all, probeMs);
    const at = Date.now();
    state.peers(results.map((r) => peerView(r.peer, r, at)));
    try { writePeers(all.map((p) => results.find((r) => r.peer.id === p.id)?.peer ?? p), file); } catch {}
  };
  return { probe, refresh: () => state.peers(list().map((p) => peerView(p))) };
}

export function ledgerActions(state: DashboardState) {
  state.ledger(ledgerView(false));
  let timer: NodeJS.Timeout | null = null;
  const refresh = () => { const cur = state.snapshot().ledger; const next = ledgerView(false); next.verify = cur.verify; state.ledger(next); };
  const verify = () => { state.ledger(ledgerView(true)); };
  const watch = () => {
    timer = setInterval(refresh, 5000);
    timer.unref();
  };
  const stop = () => { if (timer) clearInterval(timer); };
  return { refresh, verify, watch, stop };
}

export function hostName(): string {
  return os.hostname().replace(/\.local$/, '');
}
