import type { AutoStatus, HomeNet, WorkerStatus } from '@/llm/native';

// "let my computers use this phone" (8.11.2026): the computer's QR and the words for the state.
// The computer's chat page shows a QR, the phone scans it once:
//   {"k":"kula-host","v":1,"id":"<host id>","name":"<computer name>","fp":"<sha256 hex of its gate certificate>",
//    "pin":"<16-char one-time code>","exp":<ms epoch>}
// The phone keeps the computer as allowed (Hosts in Auto.kt) and opens that code on its gate
// for that certificate only; the computer finds the phone over mDNS (the record carries
// "pair" = the host id while the code is open) and pairs with the v3 handshake (docs/GATE.md).
// Everything that decides is native (Keeper.kt): this file only reads and words it.
export type HostQr = { k: 'kula-host'; v: 1; id: string; name: string; fp: string; pin: string; exp: number };

const FP = /^[0-9a-f]{64}$/i;
const PIN = /^[0-9A-Za-z]{16}$/;

/** Does this text look like a computer's QR (whatever its state)? */
export function isHostQr(text: string): boolean {
  try {
    const o = JSON.parse(text.trim());
    return !!o && o.k === 'kula-host';
  } catch {
    return false;
  }
}

/** Reads a computer's QR. Throws 'notHost' (not one, or a field is wrong) | 'expired'. The phone also refuses 'used'. */
export function parseHostQr(text: string, now = Date.now()): HostQr {
  let o: Partial<HostQr> & Record<string, unknown>;
  try {
    o = JSON.parse(text.trim());
  } catch {
    throw new Error('notHost');
  }
  if (!o || o.k !== 'kula-host' || o.v !== 1) throw new Error('notHost');
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const fp = typeof o.fp === 'string' ? o.fp : '';
  const pin = typeof o.pin === 'string' ? o.pin : '';
  const exp = typeof o.exp === 'number' ? o.exp : NaN;
  if (!id || id.length > 128 || !FP.test(fp) || !PIN.test(pin) || !(exp > 0)) throw new Error('notHost');
  if (now > exp) throw new Error('expired');
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'computer';
  return { k: 'kula-host', v: 1, id, name, fp: fp.toLowerCase(), pin, exp };
}

/** The error codes the computer flow can end in, each with its own sentence (comp.err.*). */
export const HOST_ERRORS = ['notHost', 'expired', 'used', 'nowifi', 'off', 'nonative'] as const;
export const hostErr = (e: unknown): (typeof HOST_ERRORS)[number] | null => {
  const m = String((e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? e);
  return HOST_ERRORS.find((k) => m === k || m.endsWith(`: ${k}`) || m.includes(`[${k}]`) || m === `ERR_${k}`) ?? null;
};

/** The home wi-fi in words: its name when it could be read, else its subnet. */
export const netLabel = (n: HomeNet | null): string => (n ? (n.ssid ?? `wi-fi ${n.subnet}`) : '');

/**
 * The one line the setup screen shows: a dictionary key (comp.state.*) and its values.
 * `w` is the worker's own status (who it works for, a code open for a computer).
 */
export function autoLine(a: AutoStatus, w: WorkerStatus | null): { key: string; vars?: Record<string, string> } {
  const running = a.running && (w?.state === 'running' || w?.state === 'starting' || w == null);
  if (running && a.mode === 'manual') return { key: 'comp.state.manual' };
  if (!a.on) return { key: 'comp.state.off' };
  if (running) {
    if (w?.peer) return { key: 'comp.state.working', vars: { peer: w.peer } };
    if (w?.pairFor) return { key: 'comp.state.pairing', vars: { name: w.pairFor } };
    return { key: 'comp.state.ready' };
  }
  switch (a.decision) {
    case 'paused': return { key: 'comp.state.paused' };
    case 'away': return { key: 'comp.state.away', vars: { home: netLabel(a.home) } };
    case 'unplugged': return { key: 'comp.state.unplugged' };
    case 'nohome': return { key: 'comp.state.nohome' };
    default:
      // it should run and does not: android 12+ refuses a background start without the battery exemption
      return { key: !a.batteryUnrestricted && a.sdk >= 31 ? 'comp.state.blocked' : 'comp.state.starting' };
  }
}

/** What the one-time setup still lacks, in the order the screen asks for it. */
export function setupMissing(a: AutoStatus): ('battery' | 'notifications' | 'home')[] {
  const out: ('battery' | 'notifications' | 'home')[] = [];
  if (!a.batteryUnrestricted) out.push('battery');
  if (!a.notifications && a.sdk >= 33) out.push('notifications');
  if (!a.home) out.push('home');
  return out;
}
