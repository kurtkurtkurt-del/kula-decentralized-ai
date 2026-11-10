// 8 trust and verification (10.11.2026): the cluster's security report, one screen. For every
// device: is the link tls with the certificate pinned, does the certificate it shows match the pin
// and name the key that signs its ledger, would it still take the old plain-text protocol, what its
// gate refused today, and does its signed ledger hold together, line by line, with what was seen
// before. On top, one answer: all clear, or what to look at.
//
// It checks what it can check and believes nothing else: the certificate is hashed here, the key id
// is computed here, every ledger line's chain and signature is verified here. What a device says
// about itself without proof (its own "my ledger is ok", where its key lives, its refusal counts)
// is shown as the device's word. No prompts, no answers: only who connected and whether it was let in.
import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from 'node:crypto';
import type { Branch, BranchCtx, EyeDevice, EyeTrust, Snapshot, TrustCheck, TrustReport, Verdict } from '../types.js';
import { hhmm, pct } from './util.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const SIG_TAIL = /,"sig":"([A-Za-z0-9+/=]*)"\}$/;
// refusals that mean someone tried a code or a proof that was not theirs
const GUESSES = new Set(['wrong pin', 'wrong secret', 'bad proof']);
export const GUESS_LIMIT = 5;

/** What the branch keeps per device (its notes file): how far the ledger was verified. */
interface Seen {
  head: string | null;          // sha256 of the last ledger line verified
  verified: number;             // lines verified since first seen
  since: number;                // when the first line was verified
  at: number;                   // the trust answer last taken in (its `at`)
  restartSeen: number | null;   // the restartedAt already taken in
  fault: string | null;         // a ledger fault, kept until the person says they know
  faultAt: number | null;
  faultLine: string | null;     // sha256 of the line that failed, to step past it once accepted
  gap: boolean;                 // the new lines could not be joined to the ones seen before
}
type Notes = Record<string, Seen>;
const fresh = (): Seen => ({ head: null, verified: 0, since: 0, at: 0, restartSeen: null, fault: null, faultAt: null, faultLine: null, gap: false });

/** Why a ledger line does not hold, or null: json, its prev (when one is expected) and its signature. */
export function lineProblem(line: string, key: KeyObject, expectPrev: string | null): string | null {
  let obj: { prev?: unknown };
  try { obj = JSON.parse(line); } catch { return 'not a ledger line'; }
  if (expectPrev !== null && obj.prev !== expectPrev) return 'the chain is broken (a line was changed, dropped or put in)';
  const m = SIG_TAIL.exec(line);
  if (!m) return 'a line has no signature';
  const ed = key.asymmetricKeyType === 'ed25519';
  let ok = false;
  try { ok = verify(ed ? null : 'sha256', Buffer.from(line.slice(0, m.index), 'utf8'), key, Buffer.from(m[1], 'base64')); } catch {}
  return ok ? null : 'a signature does not match the device key';
}

/** The certificate the device shows: the one pinned (kula compared it with the pin, which stays
 *  out of the snapshot), and naming the key that signs its ledger, worked out here. */
export function identityCheck(t: EyeTrust): TrustCheck {
  const k = 'identity';
  if (!t.cert || !t.pub || !t.id) return { k, ok: null, text: 'it did not show its certificate' };
  const der = Buffer.from(t.cert, 'base64');
  if (t.certPinned === null) return { k, ok: null, text: 'nothing pinned here to compare its certificate with' };
  if (!t.certPinned) return { k, ok: false, text: 'the certificate it shows is not the one pinned from its qr' };
  let keyId = '';
  try { keyId = sha(Buffer.from(t.pub, 'base64')).slice(0, 32); } catch {}
  if (keyId !== t.id.toLowerCase()) return { k, ok: false, text: 'its ledger key is not the device it claims to be' };
  let cn: string | null = null;
  try { cn = /CN=([0-9a-fA-F]{32})/.exec(new X509Certificate(der).subject)?.[1]?.toLowerCase() ?? null; } catch {}
  if (cn !== keyId) return { k, ok: false, text: 'its certificate names another device than its ledger key' };
  return { k, ok: true, text: `certificate matches the pin and names its ledger key (${keyId.slice(0, 8)}…)` };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function create(ctx: BranchCtx): Branch {
  const notes: Notes = ctx.load<Notes>({});
  let snap: Snapshot | null = null;
  let report: TrustReport | null = null;
  const said = new Map<string, Verdict>();

  // the device's new ledger lines, joined to the last one verified and checked one by one
  function takeIn(d: EyeDevice, t: EyeTrust, s: Seen): boolean {
    if (t.at === s.at || t.error) return false;
    s.at = t.at;
    let key: KeyObject;
    try { key = createPublicKey({ key: Buffer.from(t.pub ?? '', 'base64'), format: 'der', type: 'spki' }); } catch { return true; }
    const hashes = t.lines.map((l) => sha(l));
    let start = 0;
    let expect: string | null = null;
    if (s.head) {
      const i = hashes.indexOf(s.head);
      if (i >= 0) { start = i + 1; expect = s.head; s.gap = false; }
      else if (t.restartedAt && t.restartedAt !== s.restartSeen) {
        s.fault = `its ledger started over at ${hhmm(t.restartedAt)} (cleared on the device, or rewritten)`;
        s.faultAt = t.restartedAt; s.faultLine = null;
        s.verified = 0; s.since = ctx.now();
        ctx.emit(`${d.name}: ${s.fault}`);
      } else if (t.lines.length) s.gap = true;
    }
    if (t.restartedAt) s.restartSeen = t.restartedAt;
    for (let i = start; i < t.lines.length; i++) {
      const why = lineProblem(t.lines[i], key, i === start ? expect : hashes[i - 1]);
      if (why) {
        if (s.faultLine !== hashes[i]) { s.fault = why; s.faultAt = ctx.now(); s.faultLine = hashes[i]; ctx.emit(`${d.name}: its ledger: ${why}`); }
        return true;
      }
      if (!s.since) s.since = ctx.now();
      s.head = hashes[i];
      s.verified++;
    }
    return true;
  }

  function deviceReport(d: EyeDevice): TrustReport['devices'][number] {
    const s = (notes[d.id] ??= fresh());
    const t = d.trust;
    const checks: TrustCheck[] = [];
    checks.push(d.tls
      ? { k: 'pinned', ok: true, text: 'certificate pinned from its qr' }
      : { k: 'pinned', ok: false, text: 'older pairing: a shared secret, no certificate. pair it again with its qr' });
    checks.push(!d.tls
      ? { k: 'encrypted', ok: false, text: 'prompts and answers cross the network in plain text' }
      : t?.v1 === true
        ? { k: 'encrypted', ok: false, text: 'tls on this link, but it still accepts the old plain-text protocol' }
        : { k: 'encrypted', ok: true, text: 'tls 1.3, both sides show a certificate' });
    const answered = !!t && !t.error;
    if (!answered) {
      checks.push({ k: 'identity', ok: null, text: t?.error ? `not checked: ${t.error}` : d.reachable === false ? `not checked: not reachable${d.reason ? ` (${d.reason})` : ''}` : 'not checked yet' });
    } else {
      checks.push(identityCheck(t!));
      const refused = Object.entries(t!.rejectsDay).sort((a, b) => b[1] - a[1]);
      const guesses = refused.filter(([w]) => GUESSES.has(w)).reduce((a, [, n]) => a + n, 0);
      const replays = t!.rejectsDay.replay ?? 0;
      const words = refused.map(([w, n]) => `${w} ×${n}`).join(', ');
      checks.push(replays > 0
        ? { k: 'refused', ok: false, text: `someone replayed a recorded handshake (${plural(replays, 'time')} today); it was refused` }
        : guesses >= GUESS_LIMIT
          ? { k: 'refused', ok: false, text: `${guesses} wrong codes today: someone may be guessing. all were refused` }
          : { k: 'refused', ok: true, text: refused.length ? `refused today: ${words}` : 'nothing refused today' });
      checks.push(s.fault
        ? { k: 'ledger', ok: false, text: s.fault }
        : t!.self === 'broken'
          ? { k: 'ledger', ok: false, text: 'the device says its own ledger is broken' }
          : s.head
            ? { k: 'ledger', ok: true, text: `${plural(s.verified, 'line')} checked here since ${day(s.since)}: the chain and every signature hold${s.gap ? ' (one stretch between two looks was too long to join)' : ''}` }
            : { k: 'ledger', ok: null, text: 'no ledger lines yet' });
      checks.push(t!.store === 'keystore'
        ? { k: 'key', ok: true, text: 'its key is in the phone’s keystore and cannot be copied out' }
        : { k: 'key', ok: null, text: t!.store === 'file' ? 'its key is in a file on the device' : 'it did not say where its key is' });
    }
    // the key's place is the device's word, not checked: it never turns a device red or green
    const counted = checks.filter((c) => c.k !== 'key');
    const verdict: Verdict = counted.some((c) => c.ok === false) ? 'bad' : !answered || counted.some((c) => c.ok === null && c.k !== 'ledger') ? 'unknown' : 'ok';
    const rd = answered ? Object.entries(t!.rejectsDay).reduce((a, [, n]) => a + n, 0) : 0;
    return { id: d.id, name: d.name, verdict, checks, refused: rd ? `${rd} refused today` : '', accept: !!s.fault };
  }

  function build(now: Snapshot): TrustReport {
    const hl = now.host.ledger;
    const host: TrustCheck[] = [hl == null
      ? { k: 'ledger', ok: null, text: 'this computer keeps no ledger yet (it has not shared itself)' }
      : hl.ok
        ? { k: 'ledger', ok: true, text: `its own ledger: ${plural(hl.count, 'line')}, the chain and every signature hold` }
        : { k: 'ledger', ok: false, text: `its own ledger is broken${hl.problem ? `: ${hl.problem}` : ''}` }];
    const devices = now.devices.map(deviceReport);
    const bad = devices.filter((d) => d.verdict === 'bad');
    const hostBad = host.some((c) => c.ok === false);
    const waiting = devices.filter((d) => d.verdict === 'unknown');
    let verdict: Verdict;
    let headline: string;
    if (bad.length || hostBad) {
      verdict = 'bad';
      const first = bad[0] ? `${bad[0].name}: ${bad[0].checks.find((c) => c.ok === false)!.text}` : `this computer: ${host.find((c) => c.ok === false)!.text}`;
      const n = bad.length + (hostBad ? 1 : 0);
      headline = n > 1 ? `${n} things to look at. first, ${first}` : first;
    } else if (!devices.length) {
      verdict = 'unknown'; headline = 'no devices to check yet';
    } else if (waiting.length) {
      verdict = 'unknown'; headline = `not checked yet: ${waiting.map((d) => d.name).join(', ')}`;
    } else {
      verdict = 'ok';
      headline = `${plural(devices.length, 'device')}: every link pinned and encrypted, every ledger holds`;
    }
    for (const d of devices) {
      const was = said.get(d.id);
      if (was && was !== d.verdict && d.verdict === 'bad') ctx.emit(`${d.name}: ${d.checks.find((c) => c.ok === false)!.text}`);
      if (was === 'bad' && d.verdict === 'ok') ctx.emit(`${d.name}: all clear again`);
      said.set(d.id, d.verdict);
    }
    return { verdict, headline, at: now.at, host: { name: now.host.name, checks: host }, devices };
  }

  return {
    id: 'trust',
    observe(now) {
      snap = now;
      let changed = false;
      for (const d of now.devices) if (d.trust) changed = takeIn(d, d.trust, (notes[d.id] ??= fresh())) || changed;
      report = build(now);
      if (changed) ctx.save(notes);
    },
    act(action, arg) {
      if (action !== 'accept') return null;
      const s = notes[arg];
      if (!s?.fault) return null;
      // the person knows (they cleared the ledger on the phone, say): carry on from here
      if (s.faultLine) s.head = s.faultLine;
      s.fault = null; s.faultAt = null; s.faultLine = null;
      ctx.save(notes);
      if (snap) report = build(snap);
      return 'noted';
    },
    view() {
      const devs = snap?.devices ?? [];
      if (!report || !devs.length) return { built: true, stat: 'nothing to check', gauge: null, rows: [], lines: [], report: report ?? undefined };
      const ok = report.devices.filter((d) => d.verdict === 'ok').length;
      const bad = report.devices.filter((d) => d.verdict === 'bad').length + (report.host.checks.some((c) => c.ok === false) ? 1 : 0);
      return {
        built: true,
        stat: report.verdict === 'ok' ? `all clear · ${plural(devs.length, 'device')}` : report.verdict === 'bad' ? `${plural(bad, 'thing')} to look at` : 'not checked yet',
        gauge: pct(ok, devs.length),
        rows: [],
        lines: report.devices.map((d) => `${d.name} · ${d.verdict === 'ok' ? 'all clear' : d.verdict === 'bad' ? d.checks.find((c) => c.ok === false)!.text : 'not checked yet'}`),
        note: 'nothing private goes into these checks: no prompts, no answers, only who connected and whether it was let in.',
        report,
      };
    },
  };
}
