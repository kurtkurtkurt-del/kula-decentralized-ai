// How fast and how far a paired device is, measured from this computer: a few MB of
// GET /blob through its api channel (the tunnel the split and apart modes use, so the
// gate, tls and wi-fi are all in the number) and short GET /status requests on the
// already open connection for the delay, without the handshake. The planner then uses
// these instead of its fixed guess (planner.ts, 30 MB/s and 3 ms).
import { Tunnel, type TlsClient } from './gate.js';
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

export async function measureLink(
  p: { host: string; port: number; secret: string },
  tls: TlsClient | null,
  opts: { mb?: number; rounds?: number; open?: (p: { host: string; port: number; secret: string }, tls: TlsClient | null) => Promise<{ port: number; close(): Promise<void> }> } = {},
): Promise<Link> {
  const at = new Date().toISOString();
  const open = opts.open ?? (async (q, t) => { const tun = new Tunnel(q.host, q.port, q.secret, 'api', t); return { port: await tun.listen(), close: () => tun.close() }; });
  let tunnel: { port: number; close(): Promise<void> } | null = null;
  try {
    tunnel = await open(p, tls);
    const mbps = await tunnelSpeed(tunnel.port, opts.mb ?? LINK_MB);
    const ms: number[] = [];
    for (let i = 0; i < (opts.rounds ?? RTT_ROUNDS); i++) {
      const t0 = performance.now();
      const r = await fetch(`http://127.0.0.1:${tunnel.port}/status`);
      await r.arrayBuffer();
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
    await tunnel?.close().catch(() => {});
  }
}

// The network a split over these devices meets: its slowest link and its longest delay, since
// every token waits for each of them; a device not measured yet counts as the old guess.
export function netOf(links: (Link | null | undefined)[], guess: SimNet = { mbps: 30, rttMs: 3 }): SimNet {
  if (!links.length) return guess;
  let mbps = Infinity, rttMs = 0;
  for (const l of links) {
    mbps = Math.min(mbps, l?.mbps ?? guess.mbps);
    rttMs = Math.max(rttMs, l?.rttMs ?? guess.rttMs);
  }
  return { mbps, rttMs };
}
