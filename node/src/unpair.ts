// "Remove a device's access" on `kula-node share` (docs/GATE.md): the devices that may use
// this computer without a code, and taking one away. Shared by `kula-node paired …`, the
// share dashboard and `share` itself. The phone's twin is Unpair.kt.
//
// Where a paired device's facts come from:
//   - its fingerprint, when it paired and a name if one was given: ~/.kula-node/paired (Paired)
//   - its address and when it was last here: ~/.kula-node/seen.json (Seen, share writes it on
//     connect), else the ledger's `pair` line for that fingerprint (address and time)
// Removing writes one signed ledger line: `health` with `unpaired` = the first 16 hex of the
// fingerprint (a kind every verifier already knows: a new kind would turn the checks of
// older kula-nodes and phones red).
import fs from 'node:fs';
import path from 'node:path';
import { Paired } from './tls.js';
import { home } from './paths.js';
import { Ledger, readLines, type Fields } from './audit/ledger.js';
import { loadOrCreate } from './audit/key.js';
import { ledgerFile } from './ledgercmd.js';

export interface PairedDevice { fp: string; name: string | null; pairedAt: number | null; lastSeen: number | null; address: string | null }

export function pairedFile(dir = home()): string { return path.join(dir, 'paired'); }
export function seenFile(dir = home()): string { return path.join(dir, 'seen.json'); }

// When each paired device was last here and from where: {fp: {t, peer}}. Written at most
// once a minute per device (a split run opens many pipes) unless the address changed.
export class Seen {
  static readonly MIN_GAP_MS = 60_000;
  private map: Record<string, { t: number; peer: string | null }> = {};
  constructor(private readonly file: string) { this.reload(); }

  reload(): void {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.map = o && typeof o === 'object' ? o : {};
    } catch { this.map = {}; }
  }

  get(fp: string): { t: number; peer: string | null } | null { return this.map[fp] ?? null; }

  saw(fp: string, peer: string | null, now = Date.now()): boolean {
    const old = this.map[fp];
    if (old && old.peer === peer && now - old.t < Seen.MIN_GAP_MS) return false;
    this.map[fp] = { t: now, peer };
    this.write();
    return true;
  }

  forget(fp: string): void {
    this.reload();
    if (!(fp in this.map)) return;
    delete this.map[fp];
    this.write();
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.map));
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}

// The newest `pair` line per wanted fingerprint in the live ledger file: address and time.
export function pairLines(ledgerFile: string | null, wanted: Set<string>): Map<string, { peer: string | null; t: number | null }> {
  const out = new Map<string, { peer: string | null; t: number | null }>();
  if (!ledgerFile) return out;
  for (const line of readLines(ledgerFile)) {
    if (!line.includes('"pair"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.kind !== 'pair' || typeof o.fp !== 'string') continue;
    const fp = o.fp.toLowerCase();
    if (wanted.has(fp)) out.set(fp, { peer: typeof o.peer === 'string' && o.peer ? o.peer : null, t: typeof o.t === 'number' ? o.t : null });
  }
  return out;
}

// Every paired device, the one seen last first.
export function pairedDevices(paired: Paired, seen: Seen | null, ledgerFile: string | null): PairedDevice[] {
  const all = paired.list();
  const fromLedger = pairLines(ledgerFile, new Set(all.map((e) => e.fp)));
  return all.map((e) => {
    const s = seen?.get(e.fp) ?? null;
    const l = fromLedger.get(e.fp) ?? null;
    return { fp: e.fp, name: e.name, pairedAt: e.at ?? l?.t ?? null, lastSeen: s?.t ?? null, address: s?.peer ?? l?.peer ?? null };
  }).sort((a, b) => (b.lastSeen ?? b.pairedAt ?? 0) - (a.lastSeen ?? a.pairedAt ?? 0));
}

// The ledger line's fields for a removed device.
export function unpairFields(fp: string, name: string | null): Fields {
  return name ? { unpaired: fp.slice(0, 16), name: name.slice(0, 60) } : { unpaired: fp.slice(0, 16) };
}

export type RemoveResult =
  | { ok: true; device: PairedDevice }
  | { ok: false; why: 'none' | 'ambiguous' | 'short'; matches: PairedDevice[] };

// Takes the device whose fingerprint starts with `prefix` off the paired list (the running
// gate refuses it at its next handshake), forgets when it was seen, and writes the signed
// ledger line. A prefix must be at least 6 hex characters and name exactly one device.
// Closing its open connections is the gate's part (GateServer.drop; share does it on its own
// when it notices the file changed).
export function removePaired(prefix: string, paired: Paired, seen: Seen | null, ledger: Ledger | null, ledgerFile: string | null = ledger?.file ?? null): RemoveResult {
  const p = prefix.trim().toLowerCase().replace(/\s+/g, '');
  const all = pairedDevices(paired, seen, ledgerFile);
  if (!/^[0-9a-f]{6,64}$/.test(p)) return { ok: false, why: 'short', matches: [] };
  const matches = all.filter((d) => d.fp.startsWith(p));
  if (matches.length !== 1) return { ok: false, why: matches.length ? 'ambiguous' : 'none', matches };
  const device = matches[0];
  if (!paired.remove(device.fp)) return { ok: false, why: 'none', matches: [] };
  seen?.forget(device.fp);
  ledger?.append('health', 'self', unpairFields(device.fp, device.name));
  return { ok: true, device };
}

// Watches the paired list from inside `share`: each call returns the fingerprints that left
// it since the last call (removed by `kula-node paired remove` in another process, or here).
export function removedSince(paired: Paired): () => string[] {
  let last = new Set(paired.list().map((e) => e.fp));
  return () => {
    const now = new Set(paired.list().map((e) => e.fp));
    const gone = [...last].filter((fp) => !now.has(fp));
    last = now;
    return gone;
  };
}

// `kula-node paired list [--json]` and `kula-node paired remove <fp prefix>`.
export function pairedCommand(sub: string | undefined, args: string[], flags: Record<string, string | boolean>, out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const paired = new Paired(pairedFile());
  const seen = new Seen(seenFile());
  const lf = ledgerFile();
  if (sub === undefined || sub === 'list' || sub === 'ls') {
    const list = pairedDevices(paired, seen, lf);
    if (flags.json === true) { out(JSON.stringify(list)); return 0; }
    if (!list.length) { out('no device can use this computer without a code (nothing paired)'); return 0; }
    out(`${list.length} device${list.length === 1 ? '' : 's'} can use this computer without a code:`);
    for (const d of list) out('  ' + pairedRow(d));
    out('take one away: kula-node paired remove <first characters of its fingerprint>');
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    const prefix = args[0];
    if (!prefix) { err('usage: kula-node paired remove <fingerprint prefix, 6+ hex characters>'); return 2; }
    const r = removePaired(prefix, paired, seen, new Ledger(lf, loadOrCreate()));
    if (!r.ok) {
      if (r.why === 'short') err('give at least the first 6 hex characters of the fingerprint (kula-node paired list shows them)');
      else if (r.why === 'none') err(`no paired device starts with ${prefix}`);
      else { err(`${prefix} fits ${r.matches.length} devices; give more characters:`); for (const d of r.matches) err('  ' + pairedRow(d)); }
      return 1;
    }
    out(`removed ${r.device.fp.slice(0, 16)}${r.device.name ? ` (${r.device.name})` : ''}: it can no longer use this computer; a running share refuses it now and closes what it has open within 2 s. to let it back, pair it again with a fresh code.`);
    return 0;
  }
  err(`unknown: kula-node paired ${sub}\nusage: kula-node paired list [--json] | kula-node paired remove <fp prefix>`);
  return 2;
}

const ago = (t: number | null, now: number): string => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

// One line per device for `kula-node paired list`.
export function pairedRow(d: PairedDevice, now = Date.now()): string {
  const when = d.pairedAt ? new Date(d.pairedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
  return `${d.fp.slice(0, 16)}  ${(d.name ?? '-').padEnd(18)} ${(d.address ?? '?').padEnd(15)}  paired ${when}  last seen ${ago(d.lastSeen, now)}`;
}
