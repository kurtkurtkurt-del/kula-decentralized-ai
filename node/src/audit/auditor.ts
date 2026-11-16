// The auditor: runs the checks and writes what happened to the ledger. The
// worker calls it from the gate (hello, connect, end, reject), from the api
// (load) and on its own clock (health, claim).
import net from 'node:net';
import { Ledger, type Entry, type Fields } from './ledger.js';
import { ReplayCheck, clockCheck, claimCheck, modelCheck, boundsCheck, healthWarnings, type Health, type Reason } from './checks.js';

// Refusals are rate-limited (security review D4 #1, 17 Nov): a stranger that opens connections
// in a loop would otherwise cost one synchronous signed append and a log line per refusal, and
// fill the disk. One line per address prefix (ipv4 /24, ipv6 /56) and reason per window; the
// refusals in between are held and written as one line when the window ends, its `n` saying how
// many refusals it stands for (a line without `n` stands for one, as every line before this). At
// most `linesPerWindow` reject lines in all per window; what is over waits for the next one. At
// most `keys` prefixes are held; refusals past them are added to one line marked `mixed`.
export interface RejectLimits { windowMs: number; linesPerWindow: number; keys: number }
export const REJECT_LIMITS: RejectLimits = { windowMs: 10_000, linesPerWindow: 32, keys: 1024 };

export interface AuditorOptions {
  ledger: Ledger;
  now?: () => number;
  log?: (s: string) => void;
  // the refusal limiter: `true` for REJECT_LIMITS, an object for other limits; off when left out
  // (a test that wants every refusal as its own line). share turns it on.
  limit?: boolean | Partial<RejectLimits>;
}

// the address block a refusal is held under: ipv4 /24, ipv6 /56; anything else as it is
export function rejectPrefix(peer: string): string {
  let ip = peer.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const fam = net.isIP(ip);
  if (fam === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (fam !== 6) return peer;
  // eight groups (an embedded ipv4 tail as its two); the first 56 bits name the block
  let s = ip.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const g = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].map((x) => parseInt(x, 16) || 0);
  return `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}:${(g[3] & 0xff00).toString(16)}::/56`;
}

type Held = { peer: string; reason: string; fields: Fields; since: number; n: number };

export class Auditor {
  readonly replay = new ReplayCheck();
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly limits: RejectLimits | null;
  private readonly held = new Map<string, Held>();
  private over: Held | null = null;         // refusals past `keys` prefixes, on one line
  private windowStart = -Infinity;
  private linesInWindow = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AuditorOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.limits = opts.limit ? { ...REJECT_LIMITS, ...(opts.limit === true ? {} : opts.limit) } : null;
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

  // A refusal. With the limiter on, null when it was held for a later line (see REJECT_LIMITS).
  reject(peer: string, reason: string, fields: Fields = {}): Entry | null {
    const lim = this.limits;
    if (!lim) return this.rejectLine(peer, reason, fields, 1);
    const now = this.now();
    this.roll(now);
    const key = `${rejectPrefix(peer)}|${reason}`;
    let h = this.held.get(key);
    if (h && now - h.since < lim.windowMs) return this.hold(h, peer, fields);
    if (this.linesInWindow < lim.linesPerWindow) {
      // a new window for this prefix and reason: this refusal, and any still held, on one line now
      const n = 1 + (h?.n ?? 0);
      if (h) { h.since = now; h.n = 0; h.peer = peer; h.fields = fields; }
      else if (this.held.size < lim.keys) this.held.set(key, { peer, reason, fields, since: now, n: 0 });
      this.arm();
      return this.rejectLine(peer, reason, fields, n);
    }
    // over the ceiling: held until a window has room
    if (!h) {
      if (this.held.size >= lim.keys) {
        this.over ??= { peer, reason, fields, since: now, n: 0 };
        return this.hold(this.over, peer, fields);
      }
      this.held.set(key, (h = { peer, reason, fields, since: now, n: 0 }));
    }
    return this.hold(h, peer, fields);
  }

  // Writes every held refusal now (on stop, and in tests), and stops the clock.
  flush(): void {
    for (const h of this.held.values()) if (h.n > 0) this.writeHeld(h);
    this.held.clear();
    if (this.over && this.over.n > 0) this.writeHeld(this.over, true);
    this.over = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private hold(h: Held, peer: string, fields: Fields): null {
    h.n++; h.peer = peer; h.fields = fields;
    this.arm();
    return null;
  }

  private rejectLine(peer: string, reason: string, fields: Fields, n: number, mixed = false): Entry {
    this.log(`audit: rejected ${peer}: ${reason}${n > 1 ? ` (${n} times${mixed ? ', several addresses' : ''})` : ''}`);
    this.linesInWindow++;
    return this.write('reject', peer, { reason, ...fields, ...(n > 1 ? { n } : {}), ...(mixed ? { mixed: true } : {}) });
  }

  private writeHeld(h: Held, mixed = false) {
    const n = h.n;
    h.n = 0;
    this.rejectLine(h.peer, h.reason, h.fields, n, mixed);
  }

  // a new global window when the last one ran out
  private roll(now: number) {
    if (now - this.windowStart >= this.limits!.windowMs) { this.windowStart = now; this.linesInWindow = 0; }
  }

  // held refusals whose window ended are written (as far as the ceiling lets), quiet prefixes forgotten
  private sweep() {
    const lim = this.limits!;
    const now = this.now();
    this.roll(now);
    for (const [key, h] of this.held) {
      if (now - h.since < lim.windowMs) continue;
      if (h.n === 0) { this.held.delete(key); continue; }
      if (this.linesInWindow >= lim.linesPerWindow) continue;
      h.since = now;
      this.writeHeld(h);
    }
    if (this.over && this.over.n > 0 && now - this.over.since >= lim.windowMs && this.linesInWindow < lim.linesPerWindow) { this.writeHeld(this.over, true); this.over = null; }
    else if (this.over && this.over.n === 0) this.over = null;
  }

  private arm() {
    if (this.timer || !this.limits) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // a ledger that cannot be written (a disk full, a home gone) must not take the worker down
      try { this.sweep(); } catch (e) { this.log(`audit: held refusals not written: ${(e as Error).message}`); }
      if (this.held.size || this.over) this.arm();
    }, this.limits.windowMs);
    this.timer.unref?.();
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
