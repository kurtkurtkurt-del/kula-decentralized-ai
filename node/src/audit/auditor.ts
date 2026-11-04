// The auditor: runs the checks and writes what happened to the ledger. The
// worker calls it from the gate (hello, connect, end, reject), from the api
// (load) and on its own clock (health, claim).
import { Ledger, type Entry, type Fields } from './ledger.js';
import { ReplayCheck, clockCheck, claimCheck, modelCheck, boundsCheck, healthWarnings, type Health, type Reason } from './checks.js';

export interface AuditorOptions {
  ledger: Ledger;
  now?: () => number;
  log?: (s: string) => void;
}

export class Auditor {
  readonly replay = new ReplayCheck();
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly opts: AuditorOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  private write(kind: Entry['kind'], peer: string, fields: Fields = {}): Entry {
    return this.opts.ledger.append(kind, peer, fields);
  }

  // The gate's hello: nonce and, when the client sends one, its clock. A
  // reason comes back when the connection should be refused; it is logged
  // as a reject here, so the gate only has to answer NO.
  hello(peer: string, nonce: string, unixMs: number | null): Reason | null {
    const reason = this.replay.check(peer, nonce) ?? (unixMs === null ? null : clockCheck(unixMs, this.now()));
    if (reason) this.reject(peer, reason, unixMs === null ? { nonce } : { nonce, claimedMs: unixMs });
    return reason;
  }

  pair(peer: string, fields: Fields = {}): Entry { return this.write('pair', peer, fields); }

  connect(peer: string, channel: string): Entry { return this.write('connect', peer, { channel }); }

  reject(peer: string, reason: string, fields: Fields = {}): Entry {
    this.log(`audit: rejected ${peer}: ${reason}`);
    return this.write('reject', peer, { reason, ...fields });
  }

  // A closed connection; the byte counts are held to the bounds check.
  end(peer: string, channel: string, ms: number, bytesIn: number, bytesOut: number): Entry {
    const reason = boundsCheck(bytesIn, ms) ?? boundsCheck(bytesOut, ms);
    if (reason) this.log(`audit: ${peer} ${channel}: ${reason} (${bytesIn} in, ${bytesOut} out over ${ms} ms)`);
    return this.write('end', peer, { channel, ms, bytesIn, bytesOut, ...(reason ? { reason } : {}) });
  }

  // A model asked for by sha256 against the sha256 of what is on disk.
  load(peer: string, name: string, wantSha256: string, gotSha256: string | null): Entry {
    const reason = gotSha256 === null ? 'model' : modelCheck(wantSha256, gotSha256);
    if (reason) this.log(`audit: ${name}: sha256 mismatch`);
    return this.write('load', peer, { name, sha256: wantSha256, got: gotSha256, ok: reason === null, ...(reason ? { reason } : {}) });
  }

  // Something advertised (ram, bandwidth) against what was measured.
  claim(peer: string, what: string, claimed: number, measured: number): Entry & { level: 'ok' | 'warn' | 'reject' } {
    const r = claimCheck(claimed, measured);
    if (r.level !== 'ok') this.log(`audit: ${what} claimed ${claimed}, measured ${measured} (${r.ratio.toFixed(1)}x): ${r.level}`);
    const e = this.write('claim', peer, { what, claimed, measured, level: r.level, ...(r.reason ? { reason: r.reason } : {}) });
    return Object.assign(e, { level: r.level });
  }

  health(peer: string, h: Health & Fields): Entry {
    const warn = healthWarnings(h);
    if (warn.length) this.log(`audit: health: ${warn.join(', ')}`);
    return this.write('health', peer, { ...h, ...(warn.length ? { warn: warn.join(',') } : {}) });
  }
}
