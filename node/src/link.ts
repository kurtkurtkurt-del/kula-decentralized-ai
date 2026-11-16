// How fast and how far a paired device is, measured from this computer: a few MB of
// GET /blob through its api channel (the tunnel the split and apart modes use, so the
// gate, tls and wi-fi are all in the number) and short GET /status requests on the
// already open connection for the delay, without the handshake. The planner then uses
// these instead of its fixed guess (planner.ts, 30 MB/s and 3 ms).
import { Tunnel, type Dialer, type TlsClient } from './gate.js';
import { tunnelSpeed } from './bench.js';
import type { SimNet } from './sim.js';

export interface Link {
  mbps: number | null;   // MB/s from that device to this computer
  rttMs: number | null;  // one request and its answer, connection already open (median)
  at: string;            // when (iso)
  error: string | null;
}

export const LINK_MB = 8;
const RTT_ROUNDS = 5;

// `dial`: the device's road (road.ts roadDialer: an address or through an anchor); without it
// host:port. Through an anchor the numbers are both legs together, which is what a split pays.
type LinkTarget = { host: string; port: number; secret: string; dial?: Dialer };
export async function measureLink(
  p: LinkTarget,
  tls: TlsClient | null,
  opts: { mb?: number; rounds?: number; timeoutMs?: number; open?: (p: LinkTarget, tls: TlsClient | null) => Promise<{ port: number; close(): Promise<void> }> } = {},
): Promise<Link> {
  const at = new Date().toISOString();
  const open = opts.open ?? (async (q, t) => { const tun = q.dial ? Tunnel.over(q.dial, q.secret, 'api', t) : new Tunnel(q.host, q.port, q.secret, 'api', t); return { port: await tun.listen(), close: () => tun.close() }; });
  let tunnel: { port: number; close(): Promise<void> } | null = null;
  // a device that does not answer must not hold up a load: the whole test gets 8 s
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${Math.max(1, Math.round((opts.timeoutMs ?? 8000) / 1000))} s`)), opts.timeoutMs ?? 8000); });
  try {
    tunnel = await Promise.race([open(p, tls), late]);
    const mbps = await Promise.race([tunnelSpeed(tunnel.port, opts.mb ?? LINK_MB), late]);
    const ms: number[] = [];
    for (let i = 0; i < (opts.rounds ?? RTT_ROUNDS); i++) {
      const t0 = performance.now();
      const r = await Promise.race([fetch(`http://127.0.0.1:${tunnel.port}/status`), late]);
      await Promise.race([r.arrayBuffer(), late]);
      if (!r.ok) throw new Error(`status: http ${r.status}`);
      ms.push(performance.now() - t0);
    }
    // the first request may still open the connection behind the tunnel: the median leaves it out
    ms.sort((a, b) => a - b);
    const rttMs = ms[Math.floor(ms.length / 2)];
    return { mbps: Math.round(mbps * 10) / 10, rttMs: Math.round(rttMs * 10) / 10, at, error: null };
  } catch (e) {
    return { mbps: null, rttMs: null, at, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    late.catch(() => {});
    await tunnel?.close().catch(() => {});
  }
}

// The worst of these links: the slowest and the longest delay; a device not measured yet counts
// as the old guess. A one-line summary only: the planner no longer plans a split with it (that
// charged every worker the worst link, wrong for a near and a far worker together); it gives each
// worker its own link (planner.ts workerNet, sim.ts SimDevice.net) and sums the round trips.
export function netOf(links: (Link | null | undefined)[], guess: SimNet = { mbps: 30, rttMs: 3 }): SimNet {
  if (!links.length) return guess;
  let mbps = Infinity, rttMs = 0;
  for (const l of links) {
    mbps = Math.min(mbps, l?.mbps ?? guess.mbps);
    rttMs = Math.max(rttMs, l?.rttMs ?? guess.rttMs);
  }
  return { mbps, rttMs };
}
